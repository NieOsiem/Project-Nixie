import { PALETTE_SIZE } from "../../core/palette.js";

/**
 * Fake-3D extrusion.
 *
 * Exact pinhole projection from a camera `uCamHeight` above the stage pivot, so a
 * vertex at height h slides away from the pivot by h / (camHeight - h). Ground
 * vertices have h = 0 and do not move.
 *
 * Because the lean is proportional to the pivot-relative distance in world units and
 * the stage scales both alike, the on-screen lean is zoom-invariant.
 */
export const CITY_VERT = `
precision highp float;

attribute vec2 aPos;
attribute float aHeight;
attribute float aMaterial;
attribute float aShade;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec2 uPivot;
uniform float uPixelsPerMetre;
uniform float uCamHeight;
uniform float uDepthFar;
uniform float uEmissiveMax;
uniform sampler2D uPalette;

varying vec3 vBase;
varying vec3 vEmissive;
varying float vShade;

void main() {
  float hpx = aHeight * uPixelsPerMetre;
  vec2 fromPivot = aPos - uPivot;
  float eye = max(uCamHeight - hpx, 1.0);
  vec2 leaned = aPos + fromPivot * (hpx / eye);

  // texture2DLod, not texture2D: GLSL ES 1.00 only guarantees the explicit-LOD
  // sampling functions inside a vertex shader.
  float u = (aMaterial + 0.5) / ${PALETTE_SIZE}.0;
  vec4 base = texture2DLod(uPalette, vec2(u, 0.25), 0.0);
  vec4 emissive = texture2DLod(uPalette, vec2(u, 0.75), 0.0);

  vBase = base.rgb;
  vEmissive = emissive.rgb * (emissive.a * uEmissiveMax);
  vShade = aShade;

  float dist = length(vec3(fromPivot, uCamHeight - hpx));
  float z = clamp(dist / uDepthFar, 0.0, 1.0) * 2.0 - 1.0;

  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(leaned, 1.0)).xy, z, 1.0);
}
`;

export const CITY_FRAG = `
precision highp float;

varying vec3 vBase;
varying vec3 vEmissive;
varying float vShade;

void main() {
  gl_FragColor = vec4(vBase * vShade + vEmissive, 1.0);
}
`;
