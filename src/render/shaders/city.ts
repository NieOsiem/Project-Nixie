import { BANK_SIZE, DISTRICT_SLOT, PALETTE_SIZE } from "../../core/palette.js";

/**
 * Fake-3D extrusion.
 *
 * Pinhole-style projection from a fixed camera `uCamHeight` above the stage pivot. Dolly
 * changes only a dimensionless lean strength, so calibration cannot move the camera
 * through a roof. Ground vertices have h = 0 and do not move.
 *
 * Fixed mode uses strength 1. Dolly supplies either its zoom curve or a live calibration
 * override.
 */
export const CITY_VERT = `
precision highp float;

attribute vec2 aPos;
attribute float aHeight;
attribute float aMaterial;
attribute float aShade;
attribute float aKind;
attribute float aU;
attribute float aTop;
attribute float aSeed;
attribute vec2 aRoofCentre;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec2 uPivot;
uniform float uPixelsPerMetre;
uniform float uScreenPxPerMetre;
uniform float uCamHeight;
uniform float uLeanStrength;
uniform float uDepthFar;
uniform float uEmissiveMax;
uniform sampler2D uPalette;

varying vec3 vBase;
varying vec3 vEmissive;
varying vec3 vAccent;
varying float vShade;
varying float vKind;
varying float vHeight;
varying float vU;
varying float vTop;
varying float vSeed;
varying vec2 vWorldM;
varying vec2 vRoofCentreM;
varying float vUpPxPerMetre;

void main() {
  float hpx = aHeight * uPixelsPerMetre;
  vec2 fromPivot = aPos - uPivot;
  float eye = max(uCamHeight - hpx, 1.0);
  vec2 leaned = aPos + fromPivot * (hpx / eye) * uLeanStrength;

  // texture2DLod, not texture2D: GLSL ES 1.00 only guarantees the explicit-LOD
  // sampling functions inside a vertex shader.
  float u = (aMaterial + 0.5) / ${PALETTE_SIZE}.0;
  vec4 base = texture2DLod(uPalette, vec2(u, 0.25), 0.0);
  vec4 emissive = texture2DLod(uPalette, vec2(u, 0.75), 0.0);
  float bank = floor(aMaterial / ${BANK_SIZE}.0) * ${BANK_SIZE}.0;
  float accentSlot = mix(
    ${DISTRICT_SLOT.NEON_A}.0,
    ${DISTRICT_SLOT.NEON_B}.0,
    step(0.5, fract(aSeed * 17.0 + 0.13)));
  float accentU = (bank + accentSlot + 0.5) / ${PALETTE_SIZE}.0;
  vec4 accent = texture2DLod(uPalette, vec2(accentU, 0.75), 0.0);

  // Exposure on the material bodies only. The reference is a mid-key image lit by a large soft
  // sky, not a black frame with lights in it; the palette bases alone land ~5x under that once
  // shade and canyon have multiplied them down. Emissives are deliberately not gained — that
  // would just move the bloom threshold, and this must not change what glows.
  vBase = base.rgb * 1.7;
  vEmissive = emissive.rgb * (emissive.a * uEmissiveMax);
  vAccent = accent.rgb * (accent.a * uEmissiveMax) * 0.36;
  vShade = aShade;
  vKind = aKind;
  vHeight = aHeight;
  vU = aU;
  vTop = aTop;
  vSeed = aSeed;
  vWorldM = aPos / uPixelsPerMetre;
  vRoofCentreM = aRoofCentre / uPixelsPerMetre;

  // d(lean)/dh: screen pixels a metre of *height* covers. Falls to zero at the pivot, so
  // the facade must antialias against this, not against uScreenPxPerMetre.
  vUpPxPerMetre =
    length(fromPivot) * uCamHeight / (eye * eye) * uScreenPxPerMetre * uLeanStrength;

  float dist = length(vec3(fromPivot, uCamHeight - hpx));
  float z = clamp(dist / uDepthFar, 0.0, 1.0) * 2.0 - 1.0;

  // WHY: unit w interpolates facade coordinates per triangle. Homogeneous w keeps the quad seamless.
  float perspectiveW = eye / (eye + hpx * uLeanStrength);
  vec2 projected = (projectionMatrix * translationMatrix * vec3(leaned, 1.0)).xy;
  gl_Position = vec4(projected * perspectiveW, z * perspectiveW, perspectiveW);
}
`;

/**
 * Facade detail is fragment maths on the wall quads that already exist — no extra
 * geometry, no `discard` (it would cost early-Z on the biggest draw in the frame), and
 * no derivatives (`fwidth` is unavailable under PIXI 7's ES 1.00 shaders).
 * Every pattern width comes from `uScreenPxPerMetre`, so patterns fade to flat colour
 * as they go sub-pixel instead of aliasing into noise.
 */
export const CITY_FRAG = `
precision highp float;

varying vec3 vBase;
varying vec3 vEmissive;
varying vec3 vAccent;
varying float vShade;
varying float vKind;
varying float vHeight;
varying float vU;
varying float vTop;
varying float vSeed;
varying vec2 vWorldM;
varying vec2 vRoofCentreM;
varying float vUpPxPerMetre;

uniform float uScreenPxPerMetre;
uniform float uDetailQuality;

const float FLOOR_M = 3.6;
const float GRID_M = 4.6;
const float RIBBON_M = 1.35;
const float FIN_M = 3.8;
const float FEATURE_M = 18.0;
const float SHOPFRONT_M = 4.0;
const float BAY_M = 5.0;
const float PARAPET_M = 0.8;
const float ARCHITECTURE_MIN_M = 6.0;

float hash11(float x) {
  return fract(sin(x * 78.233) * 43758.5453);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 1 inside [lo, hi], ramped over half-width w. Collapses toward 0 once w swallows the
// slab, which is what makes a thinning feature dim instead of flicker.
float slab(float t, float lo, float hi, float w) {
  return smoothstep(lo - w, lo + w, t) * (1.0 - smoothstep(hi - w, hi + w, t));
}

// A pattern of this period, seen at this many px/metre: full at 4 px, gone under 1.5.
float lod(float metres, float pxPerMetre) {
  return smoothstep(1.5, 4.0, metres * pxPerMetre);
}

vec3 facade() {
  float upPx = max(vUpPxPerMetre, 0.0001);
  float alongPx = max(uScreenPxPerMetre, 0.0001);
  float wUp = 0.6 / upPx;
  float wAlong = 0.6 / alongPx;
  float architecture = step(ARCHITECTURE_MIN_M, vTop);
  if (architecture < 0.5) return vBase * vShade + vEmissive;

  float aboveRaw = vHeight - SHOPFRONT_M;
  float above = max(aboveRaw, 0.0);
  float upper = smoothstep(-wUp, wUp, aboveRaw);
  float floorId = floor(above / FLOOR_M);
  float sectionFloors = floor(mix(4.0, 9.0, hash11(vSeed + 1.73)));
  float section = floor(floorId / sectionFloors);
  float sectionTone = mix(0.82, 1.0, hash11(vSeed + section * 13.37 + 2.19));
  float fy = fract(above / FLOOR_M);
  float parapet = smoothstep(vTop - PARAPET_M - wUp, vTop - PARAPET_M + wUp, vHeight);
  float canyon = mix(0.68, 1.0, smoothstep(0.0, 12.0, vHeight));

  // WHY: parapet emission is ~1.0 against a 0.55 bloom threshold, so ungated it lit every roof
  // edge in the city and the skyline read as wireframe. Lit coping is a minority style; the rest
  // get a value-only cap. Decided before the quality branch so a building cannot change style
  // between a moving and a settled frame.
  float parapetGlow = step(0.62, hash11(vSeed + 3.41));
  float coping = parapet * (1.0 - parapetGlow);

  // WHY: moving frames skip cell work; one section-coherent ribbon avoids shimmer.
  if (uDetailQuality < 0.5) {
    float movingRibbon = slab(
      fy,
      0.18,
      0.18 + RIBBON_M / FLOOR_M,
      wUp / FLOOR_M);
    float movingOn = step(0.24, hash11(vSeed + section * 7.91 + 4.07));
    float movingLight = movingRibbon * movingOn * upper * lod(FLOOR_M, upPx);
    vec3 body = vBase * vShade * canyon * sectionTone * (1.0 + 0.30 * coping);
    return body
      + vEmissive * (0.08 + 0.68 * parapet * parapetGlow)
      + vAccent * (0.68 * movingLight);
  }

  float family = hash11(vSeed + 0.37);
  float gridStyle = 1.0 - step(0.35, family);
  float ribbonStyle = step(0.35, family) * (1.0 - step(0.65, family));
  float finStyle = step(0.65, family) * (1.0 - step(0.85, family));
  float featureStyle = step(0.85, family);

  float gx = fract(vU / GRID_M);
  float gridPane = slab(gx, 0.12, 0.88, wAlong / GRID_M)
    * slab(fy, 0.14, 0.86, wUp / FLOOR_M);
  float gridLod = min(lod(FLOOR_M, upPx), lod(GRID_M, alongPx));
  float litThreshold = mix(0.20, 0.40, hash11(vSeed + section * 5.23 + 6.11));
  float gridOn = step(
    litThreshold,
    hash21(vec2(floor(vU / (GRID_M * 2.0)), floor(floorId / 2.0)) + vSeed * 91.0));

  float ribbon = slab(
    fy,
    0.18,
    0.18 + RIBBON_M / FLOOR_M,
    wUp / FLOOR_M) * lod(FLOOR_M, upPx);
  float ribbonOn = step(0.24, hash11(vSeed + section * 7.91 + 8.03));

  float finX = fract(vU / FIN_M);
  float fin = slab(finX, 0.08, 0.56, wAlong / FIN_M) * lod(FIN_M, alongPx);
  float finOn = step(0.28, hash11(vSeed + section * 9.17 + 9.13));

  float featureX = fract((vU + vSeed * FEATURE_M) / FEATURE_M);
  float wallN = vHeight / max(vTop, 0.0001);
  float feature = slab(featureX, 0.24, 0.76, wAlong / FEATURE_M)
    * slab(wallN, 0.20, 0.78, wUp / max(vTop, 0.0001))
    * lod(FEATURE_M, alongPx);
  float featureOn = step(0.32, hash11(vSeed + section * 11.71 + 10.31));

  float lit = upper * (
    gridStyle * gridPane * gridOn * gridLod
    + ribbonStyle * ribbon * ribbonOn
    + finStyle * fin * finOn
    + featureStyle * feature * featureOn);
  float glass = upper * (
    gridStyle * gridPane * gridLod
    + ribbonStyle * ribbon
    + finStyle * fin
    + featureStyle * feature);
  float recess = glass * (1.0 - min(lit, 1.0));

  float bay = fract(vU / BAY_M);
  float shop = slab(bay, 0.08, 0.92, wAlong / BAY_M)
    * slab(vHeight, 0.45, SHOPFRONT_M - 0.45, wUp)
    * lod(BAY_M, alongPx);

  float articulation = sectionTone
    * (1.0 - 0.16 * finStyle * (1.0 - fin) * upper);
  vec3 body = vBase * vShade * canyon * articulation * (1.0 - 0.58 * recess)
    * (1.0 + 0.30 * coping);
  return body
    + vEmissive * (0.08 + 0.72 * parapet * parapetGlow)
    + vAccent * max(0.96 * lit, 0.88 * shop);
}

vec3 roof() {
  vec2 extentM = max(vec2(vU, abs(vShade)), vec2(0.0001));
  float architecture = step(ARCHITECTURE_MIN_M, vHeight);
  float structured = step(0.0, vShade) * architecture;
  float angle = vTop;
  float ca = cos(angle);
  float sa = sin(angle);
  vec2 fromCentre = vWorldM - vRoofCentreM;
  vec2 local = mat2(ca, -sa, sa, ca) * fromCentre / extentM;
  float aa = 0.75 / max(min(extentM.x, extentM.y) * uScreenPxPerMetre, 1.0);
  float detailLod = lod(min(extentM.x, extentM.y), uScreenPxPerMetre) * structured;
  float slope = clamp(
    0.5 + 0.5 * dot(fromCentre / max(length(extentM), 0.0001), vec2(0.5547, 0.8321)),
    0.0,
    1.0);
  float plane = mix(1.08, 0.82, slope);

  float frameOuter = slab(local.x, -0.96, 0.96, aa) * slab(local.y, -0.96, 0.96, aa);
  float frameInner = slab(local.x, -0.78, 0.78, aa) * slab(local.y, -0.78, 0.78, aa);
  float frame = max(frameOuter - frameInner, 0.0) * detailLod;
  float directionalBevel = clamp(0.5 + dot(local, vec2(0.2774, 0.4160)), 0.0, 1.0);

  if (architecture < 0.5) return vBase * plane + vEmissive;
  if (uDetailQuality < 0.5) {
    float movingFrame = frame * mix(0.08, 0.24, directionalBevel);
    return vBase * plane * (1.0 + movingFrame)
      + vEmissive * 0.10
      + vAccent * (0.34 * frame);
  }

  float insetOuter = slab(local.x, -0.70, 0.70, aa) * slab(local.y, -0.62, 0.62, aa);
  float insetInner = slab(local.x, -0.57, 0.57, aa) * slab(local.y, -0.47, 0.47, aa);
  float insetDeck = insetInner * detailLod;
  float insetRim = max(insetOuter - insetInner, 0.0) * detailLod;

  float skylightArea = slab(local.x, -0.68, 0.68, aa)
    * slab(local.y, -0.58, 0.58, aa)
    * detailLod;
  float stripe = fract((local.y + 0.58) / 0.28);
  float skylightBars = slab(stripe, 0.14, 0.66, aa / 0.28) * skylightArea;

  float style = hash11(vSeed + 12.59);
  float insetStyle = 1.0 - step(0.48, style);
  float skylightStyle = step(0.48, style) * (1.0 - step(0.82, style));
  float structure = 1.0
    + frame * mix(0.12, 0.34, directionalBevel)
    + insetStyle * (
      -0.30 * insetDeck
      + insetRim * mix(0.14, 0.42, directionalBevel))
    + skylightStyle * (-0.18 * skylightArea + 0.10 * skylightBars);

  return vBase * plane * structure
    + vEmissive * 0.10
    + vAccent * (
      0.42 * frame
      + 0.52 * insetStyle * insetRim
      + 0.92 * skylightStyle * skylightBars);
}

vec3 clutter() {
  float cap = 1.0 - step(-0.5, vShade);
  float edge = smoothstep(0.68, 0.84, max(abs(vU), abs(vTop))) * cap;
  vec3 sideColour = vBase * vShade + vEmissive;
  // Cap lighter than the roof it sits on and the lip darker, not the reverse: a raised box
  // catches more sky than the deck. Inverted, and with emissive on the rim, every box read as
  // a dark hole in a lit frame — dozens of neon picture frames scattered over the skyline.
  vec3 capColour = vBase * 1.12 + vEmissive * 0.10;
  vec3 rimColour = vBase * 0.72 + vEmissive * 0.05;
  return mix(sideColour, mix(capColour, rimColour, edge), cap);
}

vec3 architectureDetail() {
  float cap = 1.0 - step(-0.5, vShade);
  float edge = smoothstep(0.70, 0.90, max(abs(vU), abs(vTop))) * cap;
  vec3 sideColour = vBase * vShade + vEmissive;
  vec3 capColour = vBase * 1.08 + vEmissive;
  vec3 rimColour = vBase * 0.78 + vEmissive * 0.82;
  return mix(sideColour, mix(capColour, rimColour, edge), cap);
}

void main() {
  vec3 colour = vBase * vShade + vEmissive;
  if (vKind > 0.5 && vKind < 1.5) colour = facade();
  else if (vKind > 1.5 && vKind < 2.5) colour = roof();
  else if (vKind > 3.5 && vKind < 4.5) colour = clutter();
  else if (vKind > 4.5 && vKind < 5.5) colour = architectureDetail();
  gl_FragColor = vec4(colour + vec3(0.020, 0.014, 0.035), 1.0);
}
`;
