import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/** Keep this port deliberately small: it mirrors the static 4a field and 4b smear terms. */
const OUTPUT_DIR = "/tmp/project-nixie-wet-cpu";
const CROP_M = 8;
const PUDDLE_SCALE_M = 4;
const PUDDLE_COVERAGE = 0.45;
const WET_STRENGTH = 0.7;
const WET_DARKEN = 0.78;
const WET_GLOSS = 0.6;
const PUDDLE_EDGE_WET = 0.18;
const PUDDLE_EDGE_DRY = 0.04;
const PUDDLE_RIM_DARKEN = 0.65;
const PUDDLE_STRETCH_Y = 1.35;
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

function radialReach(uvX: number, uvY: number, smear = RADIAL_SMEAR): [number, number] {
  return [mul(sub(uvX, 0.5), smear), mul(sub(uvY, 0.5), smear)];
}

function wideBloom(uvX: number, uvY: number): [number, number, number] {
  const x = clamp(uvX, 0, 1);
  const y = clamp(uvY, 0, 1);
  // Keep the synthetic neon off the pivot so the radial offset has a visible source to reach.
  const worldX = sub(mul(x, CROP_M), 0.66 * CROP_M);
  const worldY = sub(mul(y, CROP_M), 0.46 * CROP_M);
  const radius = add(mul(worldX, worldX), mul(worldY, worldY));
  const source = mul(0.8, Math.exp(-radius / 2));
  return [source, mul(source, 0.7), mul(source, 0.9)];
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
  smearStrength = SMEAR_STRENGTH
): [number, number, number] {
  const size = CROP_M * pxPerMetre;
  const wideTexel = 16 / size;
  const uvX = div(add(x, 0.5), size);
  const uvY = div(add(y, 0.5), size);
  const worldX = f(-CROP_M / 2 + (x + 0.5) / pxPerMetre);
  const worldY = f(-CROP_M / 2 + (y + 0.5) / pxPerMetre);
  const base = add(0.12, mul(0.06, valueNoise(div(worldX, 5), div(worldY, 5))));
  const radius = add(mul(worldX, worldX), mul(worldY, worldY));
  const light = mul(0.9, Math.exp(-radius / 5));
  let cR = add(base, light);
  let cG = add(mul(base, 0.76), mul(light, 0.65));
  let cB = add(mul(base, 1.12), mul(light, 0.96));
  const puddleNoise = valueNoise(
    div(worldX, PUDDLE_SCALE_M),
    div(mul(worldY, PUDDLE_STRETCH_Y), PUDDLE_SCALE_M)
  );
  const [puddle, rim] = puddleField(PUDDLE_COVERAGE, puddleNoise);
  const wet = mul(WET_STRENGTH, puddle);
  // Saturated cool darkening: per-channel mix toward WET_DARKEN x tint. The damp rim joins the
  // mask at partial strength and the mask clamps at 1.
  const wetMask = clamp(add(wet, mul(PUDDLE_RIM_DARKEN, rim)), 0, 1);
  const darkenR = add(1, mul(sub(mul(WET_DARKEN, WET_DARKEN_TINT_R), 1), wetMask));
  const darkenG = add(1, mul(sub(mul(WET_DARKEN, WET_DARKEN_TINT_G), 1), wetMask));
  const darkenB = add(1, mul(sub(mul(WET_DARKEN, WET_DARKEN_TINT_B), 1), wetMask));
  cR = mul(cR, darkenR);
  cG = mul(cG, darkenG);
  cB = mul(cB, darkenB);
  const lit = clamp(add(add(mul(cR, 0.299), mul(cG, 0.587)), mul(cB, 0.114)), 0, 1);
  const gloss = mul(mul(wet, WET_GLOSS), smoothstep(0.02, 0.6, lit));
  // Bounded lift: mirrors min(c * (1 + GLOSS_LIFT), vec3(1.0)) in the shader.
  const liftR = Math.min(mul(cR, add(1, GLOSS_LIFT)), 1);
  const liftG = Math.min(mul(cG, add(1, GLOSS_LIFT)), 1);
  const liftB = Math.min(mul(cB, add(1, GLOSS_LIFT)), 1);
  cR = mixScalar(cR, liftR, gloss);
  cG = mixScalar(cG, liftG, gloss);
  cB = mixScalar(cB, liftB, gloss);

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
      const sample = wideBloom(rawX, rawY);
      const tapWeight = mul(w, mul(fadeX, fadeY));
      smearR = add(smearR, mul(sample[0], tapWeight));
      smearG = add(smearG, mul(sample[1], tapWeight));
      smearB = add(smearB, mul(sample[2], tapWeight));
    }
    smearWeight = add(smearWeight, w);
  }
  smearR = div(smearR, Math.max(smearWeight, 0.001));
  smearG = div(smearG, Math.max(smearWeight, 0.001));
  smearB = div(smearB, Math.max(smearWeight, 0.001));
  const smearAmount = mul(wet, smearStrength);
  const smearLuma = add(
    add(mul(smearR, 0.299), mul(smearG, 0.587)),
    mul(smearB, 0.114)
  );
  const smearLight = clamp(mul(smearLuma, WIDE_STRENGTH), 0, 1);
  const smearDenom = Math.max(smearLuma, 0.001);
  const smearHueR = div(smearR, smearDenom);
  const smearHueG = div(smearG, smearDenom);
  const smearHueB = div(smearB, smearDenom);
  const smearLiftR = mixScalar(smearLight, mul(smearHueR, smearLight), WET_GLOSS);
  const smearLiftG = mixScalar(smearLight, mul(smearHueG, smearLight), WET_GLOSS);
  const smearLiftB = mixScalar(smearLight, mul(smearHueB, smearLight), WET_GLOSS);
  const targetR = f(Math.min(add(cR, mul(smearLiftR, 0.35)), 1));
  const targetG = f(Math.min(add(cG, mul(smearLiftG, 0.35)), 1));
  const targetB = f(Math.min(add(cB, mul(smearLiftB, 0.35)), 1));
  cR = mixScalar(cR, targetR, smearAmount);
  cG = mixScalar(cG, targetG, smearAmount);
  cB = mixScalar(cB, targetB, smearAmount);
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
        const wet = puddleField(
          PUDDLE_COVERAGE,
          valueNoise(worldX / PUDDLE_SCALE_M, (worldY * PUDDLE_STRETCH_Y) / PUDDLE_SCALE_M)
        )[0];
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

  it("renders deterministic 1:1 PNG crops at the four verification scales", () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    for (const pxPerMetre of [3, 12, 50, 150]) {
      const path = `${OUTPUT_DIR}/wet-${pxPerMetre}pxm.png`;
      writeFileSync(path, renderPng(pxPerMetre));
      expect(statSync(path).size).toBeGreaterThan(64);
    }
    expect(renderPng(12).equals(renderPng(12))).toBe(true);
  }, 15_000);

  it("makes a zero coverage field exactly dry", () => {
    const [puddle, rim] = puddleField(0, 0.99);
    expect(puddle).toBe(0);
    expect(rim).toBe(0);
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

  it("elongates the field along world Y via the anisotropic sample domain", () => {
    let differs = 0;
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const wx = ((x + 0.5) / 32) * CROP_M;
        const wy = ((y + 0.5) / 32) * CROP_M;
        const stretched = puddleField(
          PUDDLE_COVERAGE,
          valueNoise(wx / PUDDLE_SCALE_M, (wy * PUDDLE_STRETCH_Y) / PUDDLE_SCALE_M)
        )[0];
        const square = puddleField(
          PUDDLE_COVERAGE,
          valueNoise(wx / PUDDLE_SCALE_M, wy / PUDDLE_SCALE_M)
        )[0];
        if (stretched !== square) differs += 1;
      }
    }
    expect(differs).toBeGreaterThan(0);
  });
});
