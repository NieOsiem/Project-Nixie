import { PALETTE_SIZE } from "../../core/palette.js";

/**
 * Bounded additive glow quads.
 *
 * Same pinhole projection as `city.ts`, so a sign leans with the building it is mounted
 * on. The only difference is a constant depth bias: a facade sign is exactly coplanar
 * with its wall and a beacon with its roof cap, and the default `depthFunc` is LESS, so
 * without the bias the surface behind wins every fragment.
 */
export const NEON_VERT = `
precision highp float;

attribute vec2 aPos;
attribute float aHeight;
attribute float aMaterial;
attribute float aShade;
attribute float aU;
attribute float aTop;
attribute float aSeed;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec2 uPivot;
uniform float uPixelsPerMetre;
uniform float uCamHeight;
uniform float uLeanStrength;
uniform float uDepthFar;
uniform float uEmissiveMax;
uniform sampler2D uPalette;

varying vec2 vLocal;
varying vec3 vGlow;
varying float vRadial;

void main() {
  float hpx = aHeight * uPixelsPerMetre;
  vec2 fromPivot = aPos - uPivot;
  float eye = max(uCamHeight - hpx, 1.0);
  vec2 leaned = aPos + fromPivot * (hpx / eye) * uLeanStrength;

  // texture2DLod, not texture2D: GLSL ES 1.00 only guarantees the explicit-LOD
  // sampling functions inside a vertex shader.
  float u = (aMaterial + 0.5) / ${PALETTE_SIZE}.0;
  vec4 emissive = texture2DLod(uPalette, vec2(u, 0.75), 0.0);

  vLocal = vec2(aU, aTop);
  vGlow = emissive.rgb * (emissive.a * uEmissiveMax) * aSeed;
  vRadial = aShade;

  // 1.5 m of bias: enough to clear the coplanar surface, far short of the nearest
  // occluder that should still hide the sign.
  float dist = length(vec3(fromPivot, uCamHeight - hpx)) - 1.5 * uPixelsPerMetre;
  float z = clamp(dist / uDepthFar, 0.0, 1.0) * 2.0 - 1.0;

  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(leaned, 1.0)).xy, z, 1.0);
}
`;

export const NEON_FRAG = `
precision highp float;

varying vec2 vLocal;
varying vec3 vGlow;
varying float vRadial;

void main() {
  vec2 d = abs(vLocal);

  // Separable and zero at |d| = 1, so abutting quads cannot show a seam. No discard and
  // no fwidth: the latter is unavailable under PIXI 7's GLSL ES 1.00.
  float core = (1.0 - smoothstep(0.30, 0.55, d.x)) * (1.0 - smoothstep(0.30, 0.55, d.y));
  float halo = (1.0 - smoothstep(0.0, 1.0, d.x)) * (1.0 - smoothstep(0.0, 1.0, d.y));
  float signGlow = halo * 0.55 + core * 0.45;
  // Cubic, not smoothstep: the pool quad is sized for the glow's full reach, and a linear-ish
  // falloff over that radius reads as a painted disc rather than light. Still zero at |v| = 1.
  float poolGlow = pow(max(0.0, 1.0 - length(vLocal)), 3.0);
  float g = mix(signGlow, poolGlow, step(0.5, vRadial));

  // Alpha 0, not g: BLEND_MODES.ADD is blendFunc(ONE, ONE), so alpha accumulates too and
  // glow landing outside the city would make the offscreen target opaque there.
  gl_FragColor = vec4(vGlow * g, 0.0);
}
`;
