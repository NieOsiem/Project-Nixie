import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/** CPU port of the shader's stationary road, wet material, matte occlusion and reflection path. */
const OUTPUT_DIR = "/tmp/project-nixie-wet-cpu";
const CROP_M = 8;
const PUDDLE_SCALE_M = 4;
const PUDDLE_COVERAGE = 0.45;
const WET_STRENGTH = 0.7;
const WET_DARKEN = 0.78;
const WET_GLOSS = 0.6;
const PUDDLE_REFLECTION_STRENGTH = 1.6;
const PUDDLE_EDGE_WET = 0.18;
const PUDDLE_EDGE_DRY = 0.04;
const PUDDLE_RIM_DARKEN = 0.65;
const ROAD_SAMPLE_M = 2;
const TINY_PUDDLE_SCALE = 0.24;
const HUGE_PUDDLE_SCALE = 4.5;
const HUGE_ASPECT_MIN = 2.8;
const HUGE_ASPECT_SPAN = 2.7;
const GLOSS_LIFT = 0.5;
const WET_DARKEN_TINT_R = 0.9;
const WET_DARKEN_TINT_G = 0.97;
const WET_DARKEN_TINT_B = 1.06;
const SMEAR_STRENGTH = 1;
const SMEAR_HEIGHT_M = 50;
const CAM_HEIGHT_M = 500;
const SMEAR_TAPS = 12;
const SMEAR_PROFILE_STEPS = 4;
const SMEAR_DECAY = 0.65;
const EDGE_WIDE_TEXEL = 1 / 64;
const WIDE_STRENGTH = 0.55;
const LIGHT_SPILL_RADIUS_M = 17;
const SELECT_LUMA_LOW = 0.020;
const SELECT_LUMA_HIGH = 0.120;
const SELECT_CHROMA_LOW = 0.010;
const SELECT_CHROMA_HIGH = 0.080;
const LOCAL_LIGHT_GAIN = 1.8;
const REFLECTION_LIFT_CAP = 0.60;
const SHADOW_STRENGTH = 0.30;
const AO_STRENGTH = 0.42;
const CONTACT_AO_STRENGTH = 0.62;
const EDGE_SOURCE_X = 1.03;
const EDGE_SOURCE_RADIUS = 0.06;

const f = (value: number): number => Math.fround(value);
const add = (a: number, b: number): number => f(f(a) + f(b));
const mul = (a: number, b: number): number => f(f(a) * f(b));
const sub = (a: number, b: number): number => f(f(a) - f(b));
const div = (a: number, b: number): number => f(f(a) / f(b));
const mixScalar = (a: number, b: number, t: number): number => add(a, mul(sub(b, a), t));
const RADIAL_SMEAR = div(SMEAR_HEIGHT_M, sub(CAM_HEIGHT_M, SMEAR_HEIGHT_M));
const clamp = (value: number, lo: number, hi: number): number => Math.min(Math.max(f(value), lo), hi);
const smoothstep = (lo: number, hi: number, value: number): number => {
  const t = clamp(div(sub(value, lo), sub(hi, lo)), 0, 1);
  return mul(mul(t, t), sub(3, mul(2, t)));
};

function fract(value: number): number {
  return f(value - Math.floor(value));
}

function hash21(x: number, y: number): number {
  const dot = add(mul(x, 127.1), mul(y, 311.7));
  return fract(mul(Math.sin(dot), 43758.5453));
}

function valueNoise(x: number, y: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fx = f(x - cellX);
  const fy = f(y - cellY);
  const wx = mul(mul(fx, fx), sub(3, mul(2, fx)));
  const wy = mul(mul(fy, fy), sub(3, mul(2, fy)));
  const a = hash21(cellX, cellY);
  const b = hash21(cellX + 1, cellY);
  const c = hash21(cellX, cellY + 1);
  const d = hash21(cellX + 1, cellY + 1);
  return add(mul(add(a, mul(sub(b, a), wx)), sub(1, wy)), mul(add(c, mul(sub(d, c), wx)), wy));
}

function puddleField(coverage: number, noise: number): [number, number] {
  if (coverage <= 0) return [0, 0];
  const threshold = sub(1, clamp(coverage, 0, 1));
  const wetIn = sub(threshold, PUDDLE_EDGE_WET);
  // Mirrors the shader's asymmetric waterline. The coverage guard above IS the shader's
  // step(0.0001, uPuddleCoverage) gate, so zero coverage stays exactly dry.
  const puddle = smoothstep(wetIn, add(threshold, PUDDLE_EDGE_DRY), noise);
  const rim = mul(smoothstep(wetIn, threshold, noise), sub(1, puddle));
  return [puddle, rim];
}
type Colour = [number, number, number];
type WideBloomSampler = (uvX: number, uvY: number) => Colour;

function worldFromView(
  originX: number,
  originY: number,
  widthM: number,
  heightM: number,
  uvX: number,
  uvY: number
): [number, number] {
  return [add(originX, mul(uvX, widthM)), add(originY, mul(uvY, heightM))];
}
type PuddleSample = {
  puddle: number;
  rim: number;
  roadMask: number;
  tinyField: number;
  mediumField: number;
  hugeField: number;
};

function luma(colour: Colour): number {
  return add(add(mul(colour[0], 0.299), mul(colour[1], 0.587)), mul(colour[2], 0.114));
}

function sceneColour(worldX: number, worldY: number): Colour {
  const grain = mul(0.018, valueNoise(div(worldX, 5), div(worldY, 5)));
  if (Math.abs(worldY) < 2.25) {
    const base = add(0.095, grain);
    return [mul(base, 0.88), mul(base, 0.82), mul(base, 1.18)];
  }
  const base = add(0.25, grain);
  return [mul(base, 1.02), base, mul(base, 1.01)];
}

type MatteOcclusion = {
  castShadow: number;
  ao: number;
  contactAo: number;
};

/**
 * Representative stationary shadow/AO target values for the CPU evidence crop. The sampled
 * values are synthetic, but their three multipliers and their order are the composite shader's.
 */
function matteOcclusion(worldX: number, worldY: number): MatteOcclusion {
  const roadBand = sub(1, smoothstep(1.8, 2.3, Math.abs(worldY)));
  const castShadow = mul(
    mul(smoothstep(-3, -1, worldX), sub(1, smoothstep(1, 3, worldX))),
    roadBand
  );
  const ao = mul(0.38, smoothstep(1.2, 2.25, Math.abs(worldY)));
  const contactAo = mul(
    smoothstep(1.65, 2, Math.abs(worldY)),
    sub(1, smoothstep(2, 2.25, Math.abs(worldY)))
  );
  return { castShadow, ao, contactAo };
}

function roadCue(colour: Colour): number {
  const lowLuma = sub(1, smoothstep(0.12, 0.34, luma(colour)));
  const blueViolet = smoothstep(
    -0.025,
    0.1,
    sub(colour[2], Math.max(colour[0], colour[1]))
  );
  return mul(lowLuma, mixScalar(0.55, 1, blueViolet));
}

function puddleAt(worldX: number, worldY: number, coverage = PUDDLE_COVERAGE): PuddleSample {
  const centre = sceneColour(worldX, worldY);
  const left = sceneColour(worldX - ROAD_SAMPLE_M, worldY);
  const right = sceneColour(worldX + ROAD_SAMPLE_M, worldY);
  const up = sceneColour(worldX, worldY - ROAD_SAMPLE_M);
  const down = sceneColour(worldX, worldY + ROAD_SAMPLE_M);
  const centreLuma = luma(centre);
  const roadEdge = smoothstep(
    0.025,
    0.12,
    Math.max(
      Math.abs(centreLuma - luma(left)),
      Math.abs(centreLuma - luma(right)),
      Math.abs(centreLuma - luma(up)),
      Math.abs(centreLuma - luma(down))
    )
  );
  const leftRoad = roadCue(left);
  const rightRoad = roadCue(right);
  const upRoad = roadCue(up);
  const downRoad = roadCue(down);
  const broadRoad = mul(add(add(leftRoad, rightRoad), add(upRoad, downRoad)), 0.25);
  const longRoad = Math.max(Math.min(leftRoad, rightRoad), Math.min(upRoad, downRoad));
  const junction = mul(
    smoothstep(0.52, 0.82, broadRoad),
    smoothstep(
      0.3,
      0.65,
      Math.min(Math.max(leftRoad, rightRoad), Math.max(upRoad, downRoad))
    )
  );
  const roadLikelihood = clamp(
    add(
      add(mul(roadCue(centre), 0.65), mul(broadRoad, 0.25)),
      add(mul(roadEdge, 0.35), mul(longRoad, 0.15))
    ),
    0,
    1
  );
  const roadMask = smoothstep(0.18, 0.62, roadLikelihood);
  const drainageBand = sub(
    1,
    smoothstep(0.34, 0.5, Math.abs(fract(add(mul(worldX, 0.035), mul(worldY, 0.012))) - 0.5))
  );
  const placementBias = mul(
    roadMask,
    add(
      add(mul(roadEdge, 0.12), mul(junction, 0.1)),
      add(mul(longRoad, 0.06), mul(drainageBand, 0.08))
    )
  );

  const puddleScale = Math.max(PUDDLE_SCALE_M, 0.001);
  const orientationX = Math.floor(worldX / (puddleScale * HUGE_PUDDLE_SCALE));
  const orientationY = Math.floor(worldY / (puddleScale * HUGE_PUDDLE_SCALE));
  const angle = hash21(orientationX + 71, orientationY + 19) * Math.PI * 2;
  const axisX = Math.cos(angle);
  const axisY = Math.sin(angle);
  const orientedX = add(mul(worldX, axisX), mul(worldY, axisY));
  const orientedY = add(mul(worldX, -axisY), mul(worldY, axisX));
  const tinyA = valueNoise(
    (worldX + 13.7) / (puddleScale * TINY_PUDDLE_SCALE),
    (worldY - 9.2) / (puddleScale * TINY_PUDDLE_SCALE)
  );
  const tinyB = valueNoise(
    (worldX - 4.1) / (puddleScale * TINY_PUDDLE_SCALE * 0.63),
    (worldY + 21.3) / (puddleScale * TINY_PUDDLE_SCALE * 0.63)
  );
  const tinyField = Math.min(Math.max(tinyA, tinyB * 0.96), Math.min(tinyA, tinyB) + 0.34);
  const mediumA = valueNoise(orientedX / puddleScale, orientedY / puddleScale);
  const mediumB = valueNoise(
    (orientedX + puddleScale * 0.46) / puddleScale,
    (orientedY - puddleScale * 0.24) / puddleScale
  );
  const mediumField = Math.max(mediumA, mediumB * 0.98);
  const hugeAspect =
    HUGE_ASPECT_MIN +
    HUGE_ASPECT_SPAN * hash21(orientationX + 29, orientationY + 83);
  const hugeField = valueNoise(
    orientedX / (puddleScale * HUGE_PUDDLE_SCALE * hugeAspect),
    orientedY / (puddleScale * HUGE_PUDDLE_SCALE)
  );
  const puddleNoise =
    Math.max(tinyField - 0.08, mediumField, hugeField - 0.04) + placementBias;
  const [rawPuddle, rawRim] = puddleField(coverage, puddleNoise);
  return {
    puddle: mul(rawPuddle, roadMask),
    rim: mul(rawRim, roadMask),
    roadMask,
    tinyField,
    mediumField,
    hugeField
  };
}

function radialReach(uvX: number, uvY: number, smear = RADIAL_SMEAR): [number, number] {
  return [mul(sub(uvX, 0.5), smear), mul(sub(uvY, 0.5), smear)];
}

function wideBloom(uvX: number, uvY: number): Colour {
  const x = clamp(uvX, 0, 1);
  const y = clamp(uvY, 0, 1);
  const magentaX = sub(mul(x, CROP_M), 0.68 * CROP_M);
  const magentaY = sub(mul(y, CROP_M), 0.42 * CROP_M);
  const cyanX = sub(mul(x, CROP_M), 0.34 * CROP_M);
  const cyanY = sub(mul(y, CROP_M), 0.56 * CROP_M);
  const magentaRadius = add(mul(magentaX, magentaX), mul(magentaY, magentaY));
  const cyanRadius = add(mul(cyanX, cyanX), mul(cyanY, cyanY));
  const magenta = mul(0.8, Math.exp(-magentaRadius / 1.4));
  const cyan = mul(0.78, Math.exp(-cyanRadius / 1.4));
  return [
    add(magenta, mul(cyan, 0.08)),
    add(mul(magenta, 0.1), cyan),
    add(mul(magenta, 0.92), mul(cyan, 0.96))
  ];
}
function reflectionBloomAt(
  uvX: number,
  uvY: number,
  sampleWideBloom: WideBloomSampler = wideBloom
): Colour {
  return sampleWideBloom(uvX, uvY);
}

function edgeCyan(uvX: number): number {
  return clamp(1 - Math.abs(uvX - EDGE_SOURCE_X) / EDGE_SOURCE_RADIUS, 0, 1);
}

function edgeSmear(uvX: number, clampOutOfBounds: boolean): number {
  const [reachX, reachY] = radialReach(uvX, 0.5);
  let sample = 0;
  let weight = 0;
  for (let i = 1; i <= SMEAR_TAPS; i += 1) {
    const t = div(i, SMEAR_TAPS);
    const w = f(Math.pow(SMEAR_DECAY, t * SMEAR_PROFILE_STEPS));
    const rawX = add(uvX, mul(reachX, t));
    const rawY = add(0.5, mul(reachY, t));
    const valid = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
    if (clampOutOfBounds) {
      sample = add(sample, mul(edgeCyan(clamp(rawX, 0, 1)), w));
    } else if (valid) {
      const fade = smoothstep(0, EDGE_WIDE_TEXEL, rawX)
        * (1 - smoothstep(1 - EDGE_WIDE_TEXEL, 1, rawX));
      sample = add(sample, mul(edgeCyan(clamp(rawX, 0, 1)), mul(w, fade)));
    }
    // WHY: renormalising valid taps would cancel the fade and recreate the hard edge plateau.
    weight = add(weight, w);
  }
  return div(sample, Math.max(weight, 0.001));
}

function shade(
  pxPerMetre: number,
  x: number,
  y: number,
  smearStrength = SMEAR_STRENGTH,
  reflectionStrength = PUDDLE_REFLECTION_STRENGTH,
  coverage = PUDDLE_COVERAGE,
  sampleWideBloom: WideBloomSampler = wideBloom
): Colour {
  const size = CROP_M * pxPerMetre;
  const wideTexel = 16 / size;
  const uvX = div(add(x, 0.5), size);
  const uvY = div(add(y, 0.5), size);
  const worldX = f(-CROP_M / 2 + (x + 0.5) / pxPerMetre);
  const worldY = f(-CROP_M / 2 + (y + 0.5) / pxPerMetre);
  const base = sceneColour(worldX, worldY);
  const radius = add(mul(worldX, worldX), mul(worldY, worldY));
  const light = mul(0.24, Math.exp(-radius / 5));
  let cR = add(base[0], light);
  let cG = add(base[1], mul(light, 0.72));
  let cB = add(base[2], mul(light, 0.96));
  const sample = puddleAt(worldX, worldY, coverage);
  const coverageGate = coverage > 0 ? 1 : 0;
  const roadWet = mul(mul(WET_STRENGTH, sample.roadMask), coverageGate);
  const wet = mul(roadWet, sample.puddle);
  const darkMask = clamp(
    add(add(mul(roadWet, 0.18), mul(wet, 0.82)), mul(PUDDLE_RIM_DARKEN, sample.rim)),
    0,
    1
  );
  const puddleDarkTier = mixScalar(1, 0.42, sample.puddle);
  const darkenR = mul(mul(WET_DARKEN, WET_DARKEN_TINT_R), puddleDarkTier);
  const darkenG = mul(mul(WET_DARKEN, WET_DARKEN_TINT_G), puddleDarkTier);
  const darkenB = mul(mul(WET_DARKEN, WET_DARKEN_TINT_B), puddleDarkTier);
  cR = mul(cR, mixScalar(1, darkenR, darkMask));
  cG = mul(cG, mixScalar(1, darkenG, darkMask));
  cB = mul(cB, mixScalar(1, darkenB, darkMask));
  const lit = clamp(luma([cR, cG, cB]), 0, 1);
  const broadGloss = mul(
    mul(mul(roadWet, sub(1, mul(sample.puddle, 0.7))), WET_GLOSS),
    mul(smoothstep(0.02, 0.6, lit), 0.28)
  );
  const liftR = Math.min(mul(cR, add(1, GLOSS_LIFT)), 1);
  const liftG = Math.min(mul(cG, add(1, GLOSS_LIFT)), 1);
  const liftB = Math.min(mul(cB, add(1, GLOSS_LIFT)), 1);
  cR = mixScalar(cR, liftR, broadGloss);
  cG = mixScalar(cG, liftG, broadGloss);
  cB = mixScalar(cB, liftB, broadGloss);

  // The sharp source is the wide bloom already present at this puddle pixel. The shader's four
  // remote fan taps remain diffuse-spill inputs only and cannot be selected for reflection.
  const reflection = reflectionBloomAt(uvX, uvY, sampleWideBloom);
  const reflectionLuma = luma(reflection);
  const reflectionChroma =
    Math.max(...reflection) - Math.min(...reflection);
  const reflectionSelect = mul(
    smoothstep(SELECT_LUMA_LOW, SELECT_LUMA_HIGH, reflectionLuma),
    smoothstep(SELECT_CHROMA_LOW, SELECT_CHROMA_HIGH, reflectionChroma)
  );
  const reflectionAmount = mul(
    mul(
      mul(wet, smoothstep(0.48, 0.9, sample.puddle)),
      clamp(reflectionStrength, 0, 2)
    ),
    reflectionSelect
  );
  const reflectionLight = Math.min(
    mul(mul(reflectionLuma, WIDE_STRENGTH), LOCAL_LIGHT_GAIN),
    REFLECTION_LIFT_CAP
  );
  const reflectionDenom = Math.max(reflectionLuma, 0.001);

  const [reachX, reachY] = radialReach(uvX, uvY);
  let smearR = 0;
  let smearG = 0;
  let smearB = 0;
  let smearWeight = 0;
  for (let i = 1; i <= SMEAR_TAPS; i += 1) {
    const t = div(i, SMEAR_TAPS);
    const w = f(Math.pow(SMEAR_DECAY, t * SMEAR_PROFILE_STEPS));
    const rawX = add(uvX, mul(reachX, t));
    const rawY = add(uvY, mul(reachY, t));
    const valid = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
    if (valid) {
      const fadeX = smoothstep(0, wideTexel, rawX)
        * (1 - smoothstep(1 - wideTexel, 1, rawX));
      const fadeY = smoothstep(0, wideTexel, rawY)
        * (1 - smoothstep(1 - wideTexel, 1, rawY));
      const bloom = sampleWideBloom(rawX, rawY);
      const tapWeight = mul(w, mul(fadeX, fadeY));
      smearR = add(smearR, mul(bloom[0], tapWeight));
      smearG = add(smearG, mul(bloom[1], tapWeight));
      smearB = add(smearB, mul(bloom[2], tapWeight));
    }
    smearWeight = add(smearWeight, w);
  }
  smearR = div(smearR, Math.max(smearWeight, 0.001));
  smearG = div(smearG, Math.max(smearWeight, 0.001));
  smearB = div(smearB, Math.max(smearWeight, 0.001));
  const smearAmount = mul(wet, smearStrength);
  const smearLuma = luma([smearR, smearG, smearB]);
  const smearLight = clamp(mul(smearLuma, WIDE_STRENGTH), 0, 1);
  const smearDenom = Math.max(smearLuma, 0.001);
  const smearLiftR = mixScalar(smearLight, mul(div(smearR, smearDenom), smearLight), WET_GLOSS);
  const smearLiftG = mixScalar(smearLight, mul(div(smearG, smearDenom), smearLight), WET_GLOSS);
  const smearLiftB = mixScalar(smearLight, mul(div(smearB, smearDenom), smearLight), WET_GLOSS);
  cR = mixScalar(cR, Math.min(add(cR, mul(smearLiftR, 0.35)), 1), smearAmount);
  cG = mixScalar(cG, Math.min(add(cG, mul(smearLiftG, 0.35)), 1), smearAmount);
  cB = mixScalar(cB, Math.min(add(cB, mul(smearLiftB, 0.35)), 1), smearAmount);

  const matte = matteOcclusion(worldX, worldY);
  const castTransmission = sub(1, mul(SHADOW_STRENGTH, matte.castShadow));
  cR = mul(cR, castTransmission);
  cG = mul(cG, castTransmission);
  cB = mul(cB, castTransmission);
  const aoTransmission = sub(1, mul(AO_STRENGTH, matte.ao));
  cR = mul(cR, aoTransmission);
  cG = mul(cG, aoTransmission);
  cB = mul(cB, aoTransmission);
  const contactTransmission = sub(1, mul(CONTACT_AO_STRENGTH, matte.contactAo));
  cR = mul(cR, contactTransmission);
  cG = mul(cG, contactTransmission);
  cB = mul(cB, contactTransmission);

  // Sharp water colour is applied after cast shadow, general AO and contact AO, as in the shader.
  const reflectionMix = clamp(reflectionAmount, 0, 1);
  cR = mixScalar(
    cR,
    Math.min(cR + (reflection[0] / reflectionDenom) * reflectionLight, 1),
    reflectionMix
  );
  cG = mixScalar(
    cG,
    Math.min(cG + (reflection[1] / reflectionDenom) * reflectionLight, 1),
    reflectionMix
  );
  cB = mixScalar(
    cB,
    Math.min(cB + (reflection[2] / reflectionDenom) * reflectionLight, 1),
    reflectionMix
  );
  return [clamp(cR, 0, 1), clamp(cG, 0, 1), clamp(cB, 0, 1)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.byteLength);
  return out;
}

function renderPng(pxPerMetre: number): Buffer {
  const size = Math.max(1, Math.round(CROP_M * pxPerMetre));
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = shade(pxPerMetre, x, y);
      raw[row + 1 + x * 3] = Math.round(r * 255);
      raw[row + 2 + x * 3] = Math.round(g * 255);
      raw[row + 3 + x * 3] = Math.round(b * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array())
  ]);
}

describe("wet-look CPU evidence", () => {
  it("keeps puddle screen size monotonic as world scale widens", () => {
    const scales = [3, 12, 50, 150];
    const table = scales.map((pxPerMetre) => ({
      pxPerMetre,
      puddlePixels: PUDDLE_SCALE_M * pxPerMetre,
      smearPixels: CROP_M * 0.5 * pxPerMetre * RADIAL_SMEAR
    }));
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(`${OUTPUT_DIR}/monotonicity.json`, `${JSON.stringify(table)}\n`);
    for (let i = 1; i < table.length; i += 1) {
      expect(table[i]!.puddlePixels).toBeGreaterThan(table[i - 1]!.puddlePixels);
      expect(table[i]!.smearPixels).toBeGreaterThan(table[i - 1]!.smearPixels);
    }
  });

  it("densifies the smear without changing its old normalized falloff", () => {
    const oldSteps = [1, 2, 3, 4];
    const denseSteps = [3, 6, 9, 12];
    for (let i = 0; i < oldSteps.length; i += 1) {
      const denseWeight = Math.pow(
        SMEAR_DECAY,
        (denseSteps[i]! / SMEAR_TAPS) * SMEAR_PROFILE_STEPS
      );
      expect(denseWeight).toBeCloseTo(Math.pow(SMEAR_DECAY, oldSteps[i]!), 6);
    }
    expect(Math.pow(SMEAR_DECAY, SMEAR_PROFILE_STEPS)).toBeCloseTo(Math.pow(0.65, 4), 6);
  });

  it("points smear away from every corner and vanishes at the pivot", () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ];
    for (const [x, y] of corners) {
      const [rx, ry] = radialReach(x, y);
      const dx = x - 0.5;
      const dy = y - 0.5;
      expect(dx * rx + dy * ry).toBeGreaterThan(0);
    }
    expect(radialReach(0.5, 0.5)).toEqual([0, 0]);
  });

  it("tapers right-edge taps instead of pinning a partially off-frame cyan source", () => {
    // WHY: the old clamp path repeated the visible edge of this off-frame source into a plateau.
    const rightEdgeCyan: [number, number, number] = [0, edgeCyan(1), edgeCyan(1)];
    expect(rightEdgeCyan[0]).toBe(0);
    expect(rightEdgeCyan[1]).toBe(rightEdgeCyan[2]);
    expect(rightEdgeCyan[1]).toBeGreaterThan(0);
    const oldPlateauA = edgeSmear(0.999, true);
    const oldPlateauB = edgeSmear(0.998, true);
    expect(oldPlateauA).toBeCloseTo(oldPlateauB, 6);
    expect(oldPlateauA).toBeGreaterThan(0);

    const validInterior = edgeSmear(0.98, false);
    const validOutside = edgeSmear(0.999, false);
    expect(validInterior).toBeGreaterThan(0);
    expect(validOutside).toBe(0);
    expect(validInterior).not.toBeCloseTo(oldPlateauA, 6);
    const taper = [0.985, 0.99, 0.995, 0.997].map((x) => edgeSmear(x, false));
    for (let i = 1; i < taper.length; i += 1) {
      expect(taper[i]!).toBeLessThan(taper[i - 1]!);
    }
  });

  it("ignores a bright source 17m away when local wide bloom is zero", () => {
    const pxPerMetre = 24;
    const size = CROP_M * pxPerMetre;
    let point: [number, number] | undefined;
    for (let y = 0; y < size && !point; y += 1) {
      for (let x = 0; x < size * 0.65; x += 1) {
        const worldX = -CROP_M / 2 + (x + 0.5) / pxPerMetre;
        const worldY = -CROP_M / 2 + (y + 0.5) / pxPerMetre;
        if (puddleAt(worldX, worldY).puddle > 0.55) {
          point = [x, y];
          break;
        }
      }
    }
    expect(point).toBeDefined();
    const [x, y] = point!;
    const localUvX = (x + 0.5) / size;
    const localUvY = (y + 0.5) / size;
    const remoteUvX = localUvX + LIGHT_SPILL_RADIUS_M / 64;
    const remoteOnly: WideBloomSampler = (uvX, uvY) =>
      Math.hypot(uvX - remoteUvX, uvY - localUvY) < 1e-6 ? [0, 0.8, 0.8] : [0, 0, 0];

    expect(remoteOnly(remoteUvX, localUvY)).toEqual([0, 0.8, 0.8]);
    expect(reflectionBloomAt(localUvX, localUvY, remoteOnly)).toEqual([0, 0, 0]);
    const reflected = shade(
      pxPerMetre,
      x,
      y,
      0,
      PUDDLE_REFLECTION_STRENGTH,
      PUDDLE_COVERAGE,
      remoteOnly
    );
    const matte = shade(pxPerMetre, x, y, 0, 0, PUDDLE_COVERAGE, remoteOnly);
    expect(reflected).toEqual(matte);
  });

  it("classifies the same world point identically after pan and zoom", () => {
    const pannedOut = worldFromView(0, -8, 32, 16, 0.375, 0.375);
    const pannedIn = worldFromView(8, -4, 16, 8, 0.25, 0.25);
    expect(pannedOut).toEqual([12, -2]);
    expect(pannedIn).toEqual(pannedOut);
    expect(puddleAt(...pannedIn)).toEqual(puddleAt(...pannedOut));
  });

  it("changes a wet ground point toward the off-center bloom source", () => {
    const pxPerMetre = 50;
    const size = CROP_M * pxPerMetre;
    let point: [number, number] | undefined;
    for (let y = 0; y < size && !point; y += 1) {
      for (let x = Math.round(size * 0.5); x < Math.round(size * 0.66); x += 1) {
        const uvX = (x + 0.5) / size;
        const uvY = (y + 0.5) / size;
        const worldX = -CROP_M / 2 + uvX * CROP_M;
        const worldY = -CROP_M / 2 + uvY * CROP_M;
        const wet = puddleAt(worldX, worldY).puddle;
        if (wet > 0) {
          const smeared = shade(pxPerMetre, x, y);
          const unsmeared = shade(pxPerMetre, x, y, 0);
          const difference =
            Math.abs(smeared[0] - unsmeared[0]) +
            Math.abs(smeared[1] - unsmeared[1]) +
            Math.abs(smeared[2] - unsmeared[2]);
          if (difference > 1e-5) point = [x, y];
        }
      }
    }
    expect(point).toBeDefined();
    const [x, y] = point!;
    const smeared = shade(pxPerMetre, x, y);
    const unsmeared = shade(pxPerMetre, x, y, 0);
    const difference =
      Math.abs(smeared[0] - unsmeared[0]) +
      Math.abs(smeared[1] - unsmeared[1]) +
      Math.abs(smeared[2] - unsmeared[2]);
    expect(difference).toBeGreaterThan(1e-5);
  });

  it("keeps locally aligned cyan and magenta reflection colors distinct from the matte wet base", () => {
    const pxPerMetre = 24;
    const size = CROP_M * pxPerMetre;
    let cyanDelta = 0;
    let magentaDelta = 0;
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const worldX = -CROP_M / 2 + (x + 0.5) / pxPerMetre;
        const worldY = -CROP_M / 2 + (y + 0.5) / pxPerMetre;
        if (puddleAt(worldX, worldY).puddle < 0.55) continue;
        const reflected = shade(pxPerMetre, x, y, 0, PUDDLE_REFLECTION_STRENGTH);
        const matte = shade(pxPerMetre, x, y, 0, 0);
        const deltaR = reflected[0] - matte[0];
        const deltaG = reflected[1] - matte[1];
        if (deltaG > deltaR) cyanDelta = Math.max(cyanDelta, deltaG);
        if (deltaR > deltaG) magentaDelta = Math.max(magentaDelta, deltaR);
      }
    }
    expect(cyanDelta).toBeGreaterThan(1e-4);
    expect(magentaDelta).toBeGreaterThan(1e-4);
  });

  it("lays the calibrated sharp highlight on top of matte cast shadow and AO", () => {
    expect(LIGHT_SPILL_RADIUS_M).toBe(17);
    expect(PUDDLE_REFLECTION_STRENGTH).toBe(1.6);
    expect([SELECT_LUMA_LOW, SELECT_LUMA_HIGH]).toEqual([0.020, 0.120]);
    expect([SELECT_CHROMA_LOW, SELECT_CHROMA_HIGH]).toEqual([0.010, 0.080]);
    expect([LOCAL_LIGHT_GAIN, REFLECTION_LIFT_CAP]).toEqual([1.8, 0.60]);

    const pxPerMetre = 24;
    const size = CROP_M * pxPerMetre;
    let shadowHighlight = 0;
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const worldX = -CROP_M / 2 + (x + 0.5) / pxPerMetre;
        const worldY = -CROP_M / 2 + (y + 0.5) / pxPerMetre;
        if (puddleAt(worldX, worldY).puddle < 0.55) continue;
        if (matteOcclusion(worldX, worldY).castShadow < 0.5) continue;
        const reflected = shade(pxPerMetre, x, y, 0, PUDDLE_REFLECTION_STRENGTH);
        const matte = shade(pxPerMetre, x, y, 0, 0);
        shadowHighlight = Math.max(
          shadowHighlight,
          reflected[0] - matte[0],
          reflected[1] - matte[1],
          reflected[2] - matte[2]
        );
      }
    }
    expect(shadowHighlight).toBeGreaterThan(1e-4);
  });

  it("renders deterministic 1:1 PNG crops at the four verification scales", () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const pxPerMetre of [3, 12, 50, 150]) {
      const path = `${OUTPUT_DIR}/wet-${pxPerMetre}pxm.png`;
      writeFileSync(path, renderPng(pxPerMetre));
      expect(statSync(path).size).toBeGreaterThan(64);
    }
    expect(renderPng(12).equals(renderPng(12))).toBe(true);
  }, 30_000);

  it("makes zero coverage exactly dry, including every reflection strength", () => {
    const [puddle, rim] = puddleField(0, 0.99);
    expect(puddle).toBe(0);
    expect(rim).toBe(0);
    const dryA = shade(12, 31, 47, SMEAR_STRENGTH, 0, 0);
    const dryB = shade(12, 31, 47, SMEAR_STRENGTH, 2, 0);
    expect(dryA).toEqual(dryB);
  });

  it("draws a sharp waterline with a damp collar just outside it", () => {
    const threshold = 1 - PUDDLE_COVERAGE;
    const [dryStart, rimDryStart] = puddleField(PUDDLE_COVERAGE, threshold - PUDDLE_EDGE_WET);
    expect(dryStart).toBe(0);
    expect(rimDryStart).toBe(0);

    const [, rimMid] = puddleField(PUDDLE_COVERAGE, threshold - PUDDLE_EDGE_WET / 2);
    expect(rimMid).toBeGreaterThan(0);

    const [water, rimWater] = puddleField(PUDDLE_COVERAGE, threshold + PUDDLE_EDGE_DRY);
    expect(water).toBeCloseTo(1, 6);
    expect(rimWater).toBe(0);
  });

  it("keeps the waterline asymmetric: saturated sooner on the dry-out side", () => {
    const threshold = 1 - PUDDLE_COVERAGE;
    // The old symmetric edge only completed at threshold + 0.08; the new one completes at
    // threshold + PUDDLE_EDGE_DRY...
    const [pastEdge] = puddleField(PUDDLE_COVERAGE, threshold + PUDDLE_EDGE_DRY);
    expect(pastEdge).toBe(1);
    // ...while the wet-in side rises across a wider band, smoothing island shapes.
    const [halfWetIn] = puddleField(PUDDLE_COVERAGE, threshold - PUDDLE_EDGE_WET / 2);
    expect(halfWetIn).toBeGreaterThan(0);
    expect(halfWetIn).toBeLessThan(1);
  });

  it("biases coverage toward blue-violet carriageway and curb gradients", () => {
    let roadWet = 0;
    let roadSamples = 0;
    let sidewalkWet = 0;
    let sidewalkSamples = 0;
    let curbWet = 0;
    let curbSamples = 0;
    for (let yi = 0; yi < 80; yi += 1) {
      const worldY = -4 + (yi + 0.5) * 0.1;
      for (let xi = 0; xi < 160; xi += 1) {
        const worldX = -8 + (xi + 0.5) * 0.1;
        const sample = puddleAt(worldX, worldY);
        if (Math.abs(worldY) < 1.7) {
          roadWet += sample.puddle;
          roadSamples += 1;
        } else if (Math.abs(worldY) > 3) {
          sidewalkWet += sample.puddle;
          sidewalkSamples += 1;
        } else if (Math.abs(Math.abs(worldY) - 2.25) < 0.3) {
          curbWet += sample.puddle;
          curbSamples += 1;
        }
      }
    }
    expect(roadWet / roadSamples).toBeGreaterThan(sidewalkWet / sidewalkSamples);
    expect(curbWet / curbSamples).toBeGreaterThan(sidewalkWet / sidewalkSamples);
  });

  it("contains visible tiny, merged-medium, and huge elongated contributors", () => {
    const winners = { tiny: 0, medium: 0, huge: 0 };
    for (let xi = 0; xi < 2048; xi += 1) {
      const worldX = -128 + (xi + 0.5) * 0.125;
      for (const worldY of [-1.75, -1.25, -0.75, 0.25, 0.75, 1.25, 1.75]) {
        const sample = puddleAt(worldX, worldY);
        if (sample.puddle < 0.2) continue;
        const tiny = sample.tinyField - 0.08;
        const medium = sample.mediumField;
        const huge = sample.hugeField - 0.04;
        if (tiny >= medium && tiny >= huge) winners.tiny += 1;
        else if (medium >= huge) winners.medium += 1;
        else winners.huge += 1;
      }
    }
    expect(winners.tiny).toBeGreaterThan(0);
    expect(winners.medium).toBeGreaterThan(0);
    expect(winners.huge).toBeGreaterThan(0);
  });
});
