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
 * no derivatives (`fwidth` availability under PIXI 7's ES 1.00 shaders is unverified).
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
varying float vUpPxPerMetre;

uniform float uScreenPxPerMetre;

const float FLOOR_M = 3.4;
const float WINDOW_M = 2.0;
const float SHOPFRONT_M = 4.0;
const float BAY_M = 5.0;
const float BAND_M = 0.35;
const float PARAPET_M = 0.8;
const float ROOF_CELL_M = 7.5;

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
  float style = step(0.5, hash11(vSeed + 0.37));

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
  // are fractions of it: 0.9 clears the ~0.55 bloom threshold, 0.14 stays well under.
  float light = 0.14 + max(max(0.9 * lit, 0.7 * parapet), shop);
  return vBase * vShade * (1.0 - 0.45 * recess) + vEmissive * light;
}

vec3 roof() {
  float w = 0.6 / max(uScreenPxPerMetre, 0.0001) / ROOF_CELL_M;
  vec2 cell = vWorldM / ROOF_CELL_M;
  vec2 f = fract(cell);
  // Wrapped before hashing: sin() of a city-sized coordinate is where drivers disagree.
  float here = step(0.72, hash21(mod(floor(cell), 128.0) + vSeed * 53.0));
  float outer = slab(f.x, 0.16, 0.84, w) * slab(f.y, 0.16, 0.84, w);
  float inner = slab(f.x, 0.26, 0.74, w) * slab(f.y, 0.26, 0.74, w);

  float fade = here * lod(ROOF_CELL_M, uScreenPxPerMetre);
  float deck = inner * fade;
  float rim = (outer - inner) * fade;
  // Roofs are the largest visible area zoomed out, so the lift stays small: pushing one
  // over the ~0.55 bloom threshold would bloom the whole city as one blob.
  return vBase * vShade * (1.0 + 0.12 * deck - 0.16 * rim) + vEmissive * (1.0 + 0.45 * deck);
}

void main() {
  vec3 colour = vBase * vShade + vEmissive;
  if (vKind > 0.5 && vKind < 1.5) colour = facade();
  else if (vKind > 1.5 && vKind < 2.5) colour = roof();
  gl_FragColor = vec4(colour, 1.0);
}
`;
