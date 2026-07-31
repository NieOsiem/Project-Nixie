import { PALETTE_SIZE } from "../../core/palette.js";

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

  vBase = base.rgb;
  vEmissive = emissive.rgb * (emissive.a * uEmissiveMax);
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

  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(leaned, 1.0)).xy, z, 1.0);
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

const float FLOOR_M = 3.4;
const float WINDOW_M = 3.0;
const float SHOPFRONT_M = 4.0;
const float BAY_M = 5.0;
const float BAND_M = 0.35;
const float PARAPET_M = 0.8;

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

  float above = vHeight - SHOPFRONT_M;
  float upper = smoothstep(-wUp, wUp, above);
  float style = step(0.35, hash11(vSeed + 0.37));

  float fx = fract(vU / WINDOW_M);
  float fy = fract(above / FLOOR_M);
  float pane = slab(fx, 0.20, 0.80, wAlong / WINDOW_M) * slab(fy, 0.22, 0.78, wUp / FLOOR_M);
  float on = step(0.58, hash21(vec2(floor(vU / WINDOW_M), floor(above / FLOOR_M)) + vSeed * 91.0));
  float grid = min(lod(FLOOR_M, upPx), lod(WINDOW_M, alongPx));

  float band = slab(fy, 0.08, 0.08 + BAND_M / FLOOR_M, wUp / FLOOR_M) * lod(FLOOR_M, upPx);

  float lit = mix(pane * on * grid, band, style) * upper;
  float recess = pane * (1.0 - on) * grid * upper * (1.0 - style);

  float bay = fract(vU / BAY_M);
  float shop = slab(bay, 0.10, 0.90, wAlong / BAY_M)
    * slab(vHeight, 0.5, SHOPFRONT_M - 0.6, wUp)
    * lod(BAY_M, alongPx);

  float parapet = smoothstep(vTop - PARAPET_M - wUp, vTop - PARAPET_M + wUp, vHeight);

  // vEmissive already carries strength * EMISSIVE_MAX (~1.1 peak for a wall), so these
  // are fractions of it: 1.15 clears the ~0.55 bloom threshold, 0.14 stays well under.
  float light = 0.14 + max(max(1.15 * lit, 0.7 * parapet), shop);
  float canyon = mix(0.45, 1.0, smoothstep(0.0, 12.0, vHeight));
  return vBase * vShade * canyon * (1.0 - 0.60 * recess) + vEmissive * light;
}

vec3 roof() {
  vec2 extentM = max(vec2(vU, abs(vShade)), vec2(0.0001));
  float structured = step(0.0, vShade);
  float angle = vTop;
  float ca = cos(angle);
  float sa = sin(angle);
  vec2 fromCentre = vWorldM - vRoofCentreM;
  vec2 local = mat2(ca, -sa, sa, ca) * fromCentre / extentM;
  float aa = 0.75 / max(min(extentM.x, extentM.y) * uScreenPxPerMetre, 1.0);
  float detailLod = lod(min(extentM.x, extentM.y), uScreenPxPerMetre) * structured;
  float slope = clamp(0.5 + 0.5 * dot(fromCentre / max(length(extentM), 0.0001), vec2(0.5547, 0.8321)), 0.0, 1.0);
  float plane = mix(1.06, 0.90, slope);
  float inside = slab(local.x, -0.72, 0.72, aa) * slab(local.y, -0.72, 0.72, aa);

  float padX = (hash11(vSeed + 5.31) - 0.5) * 0.24;
  float padY = (hash11(vSeed + 6.17) - 0.5) * 0.24;
  float padW = mix(0.26, 0.46, hash11(vSeed + 7.03));
  float padH = mix(0.18, 0.34, hash11(vSeed + 8.11));
  float padOuter = slab(local.x, padX - padW, padX + padW, aa)
    * slab(local.y, padY - padH, padY + padH, aa);
  float padInner = slab(local.x, padX - padW + 0.06, padX + padW - 0.06, aa)
    * slab(local.y, padY - padH + 0.06, padY + padH - 0.06, aa);

  float barW = mix(0.045, 0.08, hash11(vSeed + 9.23));
  float barL = mix(0.30, 0.52, hash11(vSeed + 10.37));
  float barGap = mix(0.10, 0.20, hash11(vSeed + 11.41));
  float barsOuter = max(
    slab(local.x, -barL, barL, aa) * slab(local.y, -barGap - barW - 0.04, -barGap + barW + 0.04, aa),
    slab(local.x, -barL, barL, aa) * slab(local.y, barGap - barW - 0.04, barGap + barW + 0.04, aa));
  float barsInner = max(
    slab(local.x, -barL + 0.04, barL - 0.04, aa) * slab(local.y, -barGap - barW, -barGap + barW, aa),
    slab(local.x, -barL + 0.04, barL - 0.04, aa) * slab(local.y, barGap - barW, barGap + barW, aa));

  float style = hash11(vSeed + 12.59);
  float padStyle = 1.0 - step(0.42, style);
  float barsStyle = step(0.42, style) * (1.0 - step(0.78, style));
  float pad = padInner * padStyle * inside * detailLod;
  float padRim = (padOuter - padInner) * padStyle * inside * detailLod;
  float skylight = barsInner * barsStyle * inside * detailLod;
  float skylightRim = (barsOuter - barsInner) * barsStyle * inside * detailLod;
  float frameOuter = slab(local.x, -0.92, 0.92, aa) * slab(local.y, -0.92, 0.92, aa);
  float frameInner = slab(local.x, -0.78, 0.78, aa) * slab(local.y, -0.78, 0.78, aa);
  float frame = (frameOuter - frameInner) * detailLod;

  float structure = 1.0 + 0.16 * frame
    - 0.10 * pad + 0.20 * padRim + 0.24 * skylight - 0.18 * skylightRim;
  return vBase * plane * structure
    + vEmissive * (1.0 + 0.25 * frame + 0.85 * skylight);
}

vec3 clutter() {
  float cap = 1.0 - step(-0.5, vShade);
  float edge = smoothstep(0.68, 0.84, max(abs(vU), abs(vTop))) * cap;
  vec3 sideColour = vBase * vShade + vEmissive;
  vec3 capColour = vBase * 0.55 + vEmissive * 0.12;
  vec3 rimColour = vBase * 1.35 + vEmissive * 0.75 + vec3(0.025, 0.02, 0.06);
  return mix(sideColour, mix(capColour, rimColour, edge), cap);
}

void main() {
  vec3 colour = vBase * vShade + vEmissive;
  if (vKind > 0.5 && vKind < 1.5) colour = facade();
  else if (vKind > 1.5 && vKind < 2.5) colour = roof();
  else if (vKind > 3.5 && vKind < 4.5) colour = clutter();
  gl_FragColor = vec4(colour + vec3(0.02, 0.015, 0.05), 1.0);
}
`;
