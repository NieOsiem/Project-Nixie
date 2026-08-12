import { BANK_SIZE, DISTRICT_SLOT, PALETTE_SIZE } from "../../core/palette.js";
import { CAR_SURFACE } from "../../core/geom/mesh.js";
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";

/** Seed buckets a facade hash may resolve to. Far above the ~1e-7 interpolation jitter. */
export const SEED_STEPS = 4096;

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
  // WHY: wall vertices carry the district's NEON_A weight in their otherwise-unused roof centre.
  float neonWeightA = 0.5;
  if (aKind > 0.5 && aKind < 1.5) neonWeightA = clamp(aRoofCentre.x, 0.0, 1.0);
  float accentSlot = mix(
    ${DISTRICT_SLOT.NEON_A}.0,
    ${DISTRICT_SLOT.NEON_B}.0,
    step(neonWeightA, fract(aSeed * 17.0 + 0.13)));
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
  // WHY: anchor to the leaned surface so roof patterns ride the fake-3D shift instead of sliding off it.
  vWorldM = leaned / uPixelsPerMetre;
  // WHY: the roof surface leans about uPivot, so the pattern frame must lean with it.
  // An un-leaned centroid leaves a uPivot term in (vWorldM - vRoofCentreM), and the
  // whole roof texture slides across the surface while panning.
  vRoofCentreM = (aRoofCentre + (aRoofCentre - uPivot) * (hpx / eye) * uLeanStrength) / uPixelsPerMetre;

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

const float FLOOR_M = 3.4;
const float GROUND_BAND_M = 4.2;
const float BAY_M = 2.4;
const float RIB_M = 4.6;
const float CORRUG_M = 0.5;
const float ARCHITECTURE_MIN_M = 5.0;
const float TILE_M = 2.6;
const float PANEL_M = 6.8;
const float EDGE_GRIME_M = 1.6;
const float SKY_M = 3.2;
const float WEAR_M = 9.0;
const float SOLAR_M = 2.2;
const float GROUND_COARSE_M = 34.0;
const float GROUND_FINE_M = 8.5;
const float GROUND_COARSE_AMP = 0.107;
const float GROUND_FINE_AMP = 0.053;
const float SCENE_HEIGHT_NORM_M = ${SCENE_HEIGHT_NORM_M}.0;
const float SCENE_ALPHA_FLOOR = ${SCENE_ALPHA_FLOOR};

float hash11(float x) {
  return fract(sin(x * 78.233) * 43758.5453);
}

// WHY: a wall quad's varying w interpolates the per-building vSeed ~1 ULP off its vertex
// value, and hash11 amplifies that by 78233 into a different facade style per band.
float buildingSeed(float raw) {
  return floor(raw * ${SEED_STEPS}.0 + 0.5) / ${SEED_STEPS}.0;
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
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

// Roads, pavements and ground blocks are ~40% of the screen and share a handful of flat
// palette entries, so untouched they read as one poured violet sheet.
//
// WHY: modulates vBase only. CITY_SURFACES hold to max(emissive) * strength * EMISSIVE_MAX
// < 0.55 so broad ground never clears the bloom threshold; a noise term on vEmissive would
// push part of that area over it and bloom the whole city into mush.
vec3 flatGround() {
  float coarse = (valueNoise(vWorldM / GROUND_COARSE_M) - 0.5)
    * lod(GROUND_COARSE_M, uScreenPxPerMetre);
  float fine = (valueNoise(vWorldM / GROUND_FINE_M) - 0.5)
    * lod(GROUND_FINE_M, uScreenPxPerMetre);
  float mottle = 1.0 + GROUND_COARSE_AMP * coarse + GROUND_FINE_AMP * fine;
  return vBase * vShade * mottle + vEmissive;
}


vec3 facade() {
  float seed = buildingSeed(vSeed);
  float upPx = max(vUpPxPerMetre, 0.0001);
  float alongPx = max(uScreenPxPerMetre, 0.0001);
  float wUp = 0.6 / upPx;
  float wAlong = 0.6 / alongPx;
  float h = vHeight;
  float architecture = step(ARCHITECTURE_MIN_M, vTop);

  float aboveRaw = h - GROUND_BAND_M;
  float above = max(aboveRaw, 0.0);
  float upper = smoothstep(-wUp, wUp, aboveRaw);
  float floorId = floor(above / FLOOR_M);
  float sectionFloors = 3.0 + floor(hash11(seed + 1.73) * 4.0);
  float section = floor(floorId / sectionFloors);
  float sectionTone = mix(0.88, 1.05, hash11(seed + section * 13.37 + 2.19));
  float fy = fract(above / FLOOR_M);
  float canyon = mix(0.70, 1.0, smoothstep(0.0, 14.0, vHeight));
  float grime = 1.0 - 0.45 * (1.0 - smoothstep(0.0, 9.0, h))
    - 0.14 * (valueNoise(vec2(vU / 3.0, h / 3.0)) - 0.5);

  float coping = smoothstep(vTop - 0.8 - wUp, vTop - 0.8 + wUp, h);
  float parapetShadow = slab(h, vTop - 2.1, vTop - 0.9, wUp);
  float parapetGlow = step(0.62, hash11(seed + 3.41));

  // Low-rise shed: corrugated panels, a dark door, a thin window slit.
  if (architecture < 0.5) {
    float corr = slab(fract(h / CORRUG_M), 0.7, 0.92, wUp / CORRUG_M);
    float slit = slab(fract(vU / 3.0), 0.25, 0.75, wAlong / 3.0) * slab(h, 1.8, 3.2, wUp) * 0.7;
    float door = slab(fract(vU / 6.0), 0.1, 0.9, wAlong / 6.0) * slab(h, 0.1, 2.2, wUp);
    float doorOn = step(0.5, hash21(vec2(floor(vU / 6.0) + seed * 17.0, 1.0)));
    vec3 wallC = vBase * (vShade * mix(0.92, 1.08, corr) * grime);
    wallC = mix(wallC, vBase * 0.28 + vEmissive * 0.10, door * doorOn);
    wallC = mix(wallC, vBase * 0.5 + vAccent * 0.25, slit);
    return wallC;
  }

  // Moving frames skip per-window cell work: one section-coherent band.
  if (uDetailQuality < 0.5) {
    float band = slab(fy, 0.16, 0.84, wUp / FLOOR_M) * upper;
    float on = step(0.3, hash21(vec2(floor(vU / BAY_M) + seed * 21.0, floorId + seed * 7.0)));
    float litBand = band * on * mix(0.4, 0.7, hash21(vec2(floor(vU / BAY_M) + seed * 5.0, floorId)));
    vec3 body = vBase * (vShade * canyon * sectionTone * grime);
    body = body * (1.0 + 0.55 * coping - 0.42 * parapetShadow);
    return body
      + vEmissive * (0.10 + 0.8 * coping * parapetGlow)
      + vAccent * (0.7 * litBand);
  }

  float family = hash11(seed + 0.37);
  float curtain = 1.0 - step(0.32, family);
  float punched = step(0.32, family) * (1.0 - step(0.58, family));
  float ribbon = step(0.58, family) * (1.0 - step(0.78, family));
  float industrial = step(0.78, family) * (1.0 - step(0.92, family));
  float feature = step(0.92, family);

  float bay = fract(vU / BAY_M);
  float cellX = floor(vU / BAY_M);
  float cellY = floorId;
  float cellJit = hash21(vec2(cellX + seed * 81.3, cellY + seed * 17.9));
  float jw = 0.13 + 0.07 * cellJit;
  float jh = 0.10 + 0.06 * hash21(vec2(cellX + seed * 3.7, cellY + seed * 61.3));

  float mechEvery = 5.0 + floor(hash11(seed + 44.1) * 4.0);
  float mechFloor = step(0.85, fract((floorId + 0.5) / mechEvery));
  float louver = slab(fy, 0.12, 0.88, wUp / FLOOR_M) * mechFloor
    * (0.7 + 0.3 * slab(fract(vU / 1.1), 0.4, 0.6, wAlong / 1.1));
  float mechTone = 1.0 - 0.42 * mechFloor + 0.10 * mechFloor;
  float mechWindows = 1.0 - mechFloor;

  float winH = slab(bay, jw, 1.0 - jw, wAlong / BAY_M);
  float winV = slab(fy, jh, 1.0 - jh, wUp / FLOOR_M);
  float glassH = slab(bay, jw + 0.08, 1.0 - jw - 0.08, wAlong / BAY_M);
  float glassV = slab(fy, jh + 0.07, 1.0 - jh - 0.07, wUp / FLOOR_M);
  if (punched > 0.5) {
    winH = slab(bay, 0.28, 0.72, wAlong / BAY_M);
    winV = slab(fy, 0.16, 0.78, wUp / FLOOR_M);
    glassH = slab(bay, 0.34, 0.66, wAlong / BAY_M);
    glassV = slab(fy, 0.22, 0.72, wUp / FLOOR_M);
  } else if (ribbon > 0.5) {
    winV = slab(fy, 0.04, 0.9, wUp / FLOOR_M);
    glassV = slab(fy, 0.10, 0.84, wUp / FLOOR_M);
  }

  float litThreshold = mix(0.35, 0.68, hash11(seed + section * 5.23 + 6.11));
  float lit = step(litThreshold, hash21(vec2(cellX + seed * 53.7, cellY + seed * 91.3)));
  float glassTone = mix(0.4, 0.8, hash21(vec2(cellX + seed * 12.1, cellY + seed * 33.7)));
  float neonWin = step(0.85, hash21(vec2(cellX + seed * 61.1, cellY + seed * 73.9)));

  float win = winH * winV * upper * mechWindows;
  float glass = glassH * glassV * upper * mechWindows;
  float frame = win * (1.0 - glass);
  float recessShadow = (1.0 - smoothstep(0.0, 0.3, fy)) * 0.45;
  float sheen = smoothstep(0.3, 0.7, fract((vU - above * 0.4) / 34.0));
  vec3 glassC = vec3(0.07, 0.11, 0.18) * (vShade * (0.7 + 0.3 * glassTone)
    * (0.7 + 0.3 * (1.0 - fract(above / FLOOR_M)) + 0.5 * sheen) * (1.0 - recessShadow));
  vec3 warmC = vec3(1.0, 0.86, 0.68) * (vShade * 0.55);
  vec3 litC = mix(warmC, warmC + vAccent * 0.8, neonWin * 0.6);
  vec3 frameC = vBase * (vShade * 0.5);

  // Ground-floor storefront: darker base, glass bays, a sign strip.
  float bay2 = fract(vU / (BAY_M * 1.7));
  float shop = slab(bay2, 0.06, 0.94, wAlong / (BAY_M * 1.7)) * slab(h, 0.2, GROUND_BAND_M - 0.4, wUp) * (1.0 - upper);
  float signOn = step(0.4, hash21(vec2(floor(vU / (BAY_M * 1.7)) + seed * 29.0, 2.0)));
  float shopTone = mix(0.45, 1.0, hash21(vec2(floor(vU / (BAY_M * 1.7)) + seed * 41.0, 3.0)));
  float signStrip = slab(h, GROUND_BAND_M - 1.1, GROUND_BAND_M - 0.3, wUp) * (1.0 - upper) * 0.8;
  vec3 baseC = vBase * (vShade * mix(0.55, 0.75, signOn) * grime);
  vec3 shopGlass = mix(baseC, glassC, shop * 0.85);

  float joint = slab(fract(vU / 7.0), 0.965, 1.0, wAlong / 7.0) * 0.2;
  float recess = glass * (1.0 - lit) * 0.65;
  float spandrel = slab(fy, 0.0, 0.1, wUp / FLOOR_M) + slab(fy, 0.9, 1.0, wUp / FLOOR_M);
  float articulation = sectionTone * grime * (1.0 - 0.12 * spandrel) * (1.0 - joint);
  vec3 bodyC = vBase * (vShade * canyon * articulation * mechTone * (1.0 - 0.3 * recess));
  vec3 windowC = mix(frameC, mix(glassC, litC, lit * 0.8), glass);
  vec3 upperC = mix(bodyC, windowC, win);
  vec3 parapetC = bodyC * (1.0 + 0.55 * coping - 0.42 * parapetShadow);

  // Industrial: vertical ribs, small lit vents, no window grid.
  if (industrial > 0.5) {
    float rib = slab(fract(vU / RIB_M), 0.0, 0.3, wAlong / RIB_M);
    float vent = slab(bay, 0.2, 0.8, wAlong / BAY_M) * slab(fy, 0.2, 0.8, wUp / FLOOR_M) * lit;
    vec3 ribC = vBase * (vShade * canyon * sectionTone * grime * (1.0 - 0.28 * rib) * mechTone);
    ribC = mix(ribC, parapetC, coping + parapetShadow);
    return ribC + vAccent * (0.9 * vent * upper) + vEmissive * (0.10 + 0.8 * coping * parapetGlow);
  }

  vec3 col = mix(upperC, parapetC, coping + parapetShadow);
  col = mix(col, shopGlass, 1.0 - upper);
  col = mix(col, vBase * (vShade * 0.55), louver);
  col += vEmissive * (0.10 + 0.8 * coping * parapetGlow);
  col += vAccent * (0.95 * lit * glass * 0.6 + 0.85 * shop * signOn * shopTone + 0.9 * signStrip * signOn * shopTone);
  if (feature > 0.5) {
    float band = slab(fract(above / (FLOOR_M * 2.0)), 0.3, 0.7, wUp / (FLOOR_M * 2.0)) * upper * 0.5;
    col += vAccent * band;
  }
  return col;
}

vec3 roof() {
  float seed = buildingSeed(vSeed);
  vec2 fromCentre = vWorldM - vRoofCentreM;
  float ca = cos(-vTop);
  float sa = sin(-vTop);
  vec2 local = mat2(ca, -sa, sa, ca) * fromCentre;
  float halfW = max(vU, 0.0001);
  float halfH = max(abs(vShade), 0.0001);
  // WHY: the structured gate used to send non-rect footprints (trapezoids, L-shapes) to a
  // flat fallback with no parapet or edge. The patterns are world-anchored now, so every
  // polygon gets the full treatment.
  float extent = max(min(halfW, halfH), 0.0001);
  float aa = 0.75 / max(extent * uScreenPxPerMetre, 1.0);
  float detailLod = lod(extent, uScreenPxPerMetre);
  float rad = max(length(local), 0.0001);

  // Metres from the nearest roof edge (exact for rect footprints; the bbox distance
  // for others, which the soft treatments hide).
  float edge = max(min(halfW - abs(local.x), halfH - abs(local.y)), 0.0);
  float slope = clamp(0.5 + 0.5 * dot(local / rad, vec2(0.5, 0.866)), 0.0, 1.0);
  float plane = mix(1.04, 0.78, slope);

  // Parapet: bright lip on the lit side, shadow on the far side.
  // Parapet width scales with the roof so tiny roofs do not become all rim.
  float rimW = min(0.7, extent * 0.25);
  float lipW = min(0.28, extent * 0.12);
  float rim = 1.0 - smoothstep(0.0, rimW, edge);
  float lip = 1.0 - smoothstep(0.0, lipW, edge);
  float parapetLight = clamp(0.5 + 0.5 * dot(local / rad, vec2(0.5, 0.866)), 0.0, 1.0);
  float parapet = rim * mix(0.55, 1.3, parapetLight) * detailLod + lip * 0.25;
  float edgeGrime = 1.0 - 0.32 * (1.0 - smoothstep(0.0, EDGE_GRIME_M, edge));
  float wear = (valueNoise(vec2(vWorldM.x / WEAR_M, vWorldM.y / WEAR_M)) - 0.5) * 0.24;

  // Tile pitch adapts to the roof so narrow roofs get a coherent grid instead of slivers.
  float tileM = clamp(extent * 0.85, 1.1, TILE_M);
  float tx = fract(local.x / tileM);
  float ty = fract(local.y / tileM);
  float tileLine = slab(tx, 0.985, 1.0, aa / tileM) + slab(ty, 0.985, 1.0, aa / tileM);
  float tileTone = hash21(vec2(floor(local.x / tileM) + seed * 7.3, floor(local.y / tileM) + seed * 11.7)) * 0.08 - 0.04;

  float px = fract(local.x / PANEL_M);
  float py = fract(local.y / PANEL_M);
  float panelRim = (slab(px, 0.04, 0.96, aa / PANEL_M) + slab(py, 0.04, 0.96, aa / PANEL_M)) * 0.5;
  float panelTone = hash21(vec2(floor(local.x / PANEL_M) + seed * 3.1, floor(local.y / PANEL_M) + seed * 5.7));

  float skyOff = seed * 20.0;
  float skyRow = slab(fract((local.y + skyOff) / SKY_M), 0.18, 0.62, aa / SKY_M);
  float skyOn = step(0.5, hash21(vec2(floor((local.y + skyOff) / SKY_M) + seed * 9.1, 1.0)));
  float skylight = skyRow * skyOn;

  float sx = fract((local.x + seed * 40.0) / SOLAR_M);
  float sy = fract((local.y + seed * 17.0) / SOLAR_M);
  float solar = slab(sx, 0.08, 0.92, aa / SOLAR_M) * slab(sy, 0.08, 0.92, aa / SOLAR_M);

  // Style features need a roof at least ~4.4 m across; tiny roofs keep base tiling.
  float styleGate = step(2.2, extent);
  float style = hash11(seed + 12.59);
  float tileStyle = 1.0 - step(0.35, style);
  float panelStyle = step(0.35, style) * (1.0 - step(0.6, style)) * styleGate;
  float skyStyle = step(0.6, style) * (1.0 - step(0.82, style)) * styleGate;
  float solarStyle = step(0.82, style) * (1.0 - step(0.95, style)) * styleGate;
  float accentStyle = step(0.95, style) * styleGate;

  float structure = 1.0
    + tileLine * 0.16
    + tileTone * 2.0
    + panelStyle * (panelRim * 0.42 + panelTone * 0.18 - 0.09)
    + skyStyle * (skylight * 0.9)
    + solarStyle * (solar * 0.85)
    + wear;

  if (uDetailQuality < 0.5) {
    return vBase * (plane * (1.0 + tileLine * 0.10) * edgeGrime * (1.0 + parapet * 0.35))
      + vEmissive * 0.06
      + vAccent * (0.12 * parapet * (1.0 - parapetLight));
  }

  vec3 col = vBase * (plane * structure * edgeGrime * (1.0 + parapet * 0.45));
  col += vEmissive * 0.06;
  float accentBand = accentStyle * (1.0 - smoothstep(0.4, 2.6, edge)) * 0.4;
  col += vAccent * (0.15 * parapet * (1.0 - parapetLight) + accentBand * detailLod);
  if (skyStyle > 0.5) col = mix(col, vec3(0.03, 0.05, 0.09), skylight * 0.75 * detailLod);
  if (solarStyle > 0.5) col = mix(col, vec3(0.02, 0.05, 0.09), solar * 0.55 * detailLod);
  return col;
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

vec3 car() {
  if (vShade > -0.5) return vBase * vShade * 0.92;
  if (vShade > ${CAR_SURFACE.CAP - 0.5}) return vBase * 1.08;
  if (vShade > ${CAR_SURFACE.GLASS - 0.5}) {
    return mix(vec3(0.018, 0.026, 0.055), vBase * 0.22, 0.35);
  }
  if (vShade > ${CAR_SURFACE.FRONT_LIGHT - 0.5}) return vec3(0.30, 0.24, 0.12);
  if (vShade > ${CAR_SURFACE.REAR_LIGHT - 0.5}) return vec3(0.25, 0.018, 0.035);
  if (vShade > ${CAR_SURFACE.TIRE - 0.5}) return vec3(0.012, 0.011, 0.020);
  if (vShade > ${CAR_SURFACE.TRIM - 0.5}) return vBase * 0.20 + vec3(0.025);
  return vec3(0.018, 0.016, 0.028);
}

void main() {
  vec3 colour = vBase * vShade + vEmissive;
  if (vKind < 0.5) colour = flatGround();
  else if (vKind > 0.5 && vKind < 1.5) colour = facade();
  else if (vKind > 1.5 && vKind < 2.5) colour = roof();
  else if (vKind > 3.5 && vKind < 4.5) colour = clutter();
  else if (vKind > 4.5 && vKind < 5.5) colour = architectureDetail();
  else if (vKind > 5.5 && vKind < 6.5) colour = car();
  float sceneAlpha = SCENE_ALPHA_FLOOR
    + (1.0 - SCENE_ALPHA_FLOOR) * clamp(vHeight / SCENE_HEIGHT_NORM_M, 0.0, 1.0);
  gl_FragColor = vec4(colour + vec3(0.020, 0.014, 0.035), sceneAlpha);
}
`;
