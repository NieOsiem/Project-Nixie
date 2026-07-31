import { PALETTE_SIZE } from "../../core/palette.js";

/**
 * Bounded additive glow quads.
 *
 * Same pinhole projection as `city.ts`, so a sign leans with the building it is mounted
 * on. The only difference is a depth bias: a facade panel is exactly coplanar with its
 * wall and a pool with the road, and the default `depthFunc` is LESS, so without the bias
 * the surface behind wins every fragment.
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

varying vec2 vLocal;
varying vec2 vPanelM;
varying vec3 vGlow;
varying float vRadial;
varying float vGlyphPxPerM;
varying float vSeed;

// WHY: a pool sits 0.03 m over the road and has to clear the 0.05 m markings too, so it
// needs metres of bias. A facade panel does not: at 1.5 m it punched through the roof of
// the building in front of the wall it was mounted on. 0.25 m is still ~5x the marking
// lift, which the depth buffer resolves by three orders of magnitude at 500 m.
const float SIGN_BIAS_M = 0.25;
const float POOL_BIAS_M = 1.5;

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
  vPanelM = aRoofCentre;
  vGlow = emissive.rgb * (emissive.a * uEmissiveMax) * aSeed;
  vRadial = aShade;
  vSeed = aSeed;

  // d(lean)/dh, as in city.ts: a banner's glyphs run up the facade, where a metre of
  // height covers this many screen pixels rather than uScreenPxPerMetre.
  float upPxPerMetre =
    length(fromPivot) * uCamHeight / (eye * eye) * uScreenPxPerMetre * uLeanStrength;
  vGlyphPxPerM = aRoofCentre.x >= aRoofCentre.y ? uScreenPxPerMetre : upPxPerMetre;

  float bias = mix(SIGN_BIAS_M, POOL_BIAS_M, step(0.5, aShade));
  float dist = length(vec3(fromPivot, uCamHeight - hpx)) - bias * uPixelsPerMetre;
  float z = clamp(dist / uDepthFar, 0.0, 1.0) * 2.0 - 1.0;

  // WHY: unit w interpolates local coordinates per triangle. Homogeneous w keeps the quad seamless.
  float perspectiveW = eye / (eye + hpx * uLeanStrength);
  vec2 projected = (projectionMatrix * translationMatrix * vec3(leaned, 1.0)).xy;
  gl_Position = vec4(projected * perspectiveW, z * perspectiveW, perspectiveW);
}
`;

export const NEON_FRAG = `
precision highp float;

varying vec2 vLocal;
varying vec2 vPanelM;
varying vec3 vGlow;
varying float vRadial;
varying float vGlyphPxPerM;
varying float vSeed;

uniform float uGlowMarginM;

const float GLYPH_PERIOD_M = 1.1;
const float GLYPH_FILL = 0.62;
const float GLYPH_DIM = 0.42;

float hash11(float x) {
  return fract(sin(x * 78.233) * 43758.5453);
}

void main() {
  float g;

  // Coherent per-quad branch: pools are the largest fill in the frame and the panel maths
  // below would be discarded for every one of their fragments.
  if (vRadial > 0.5) {
    // Quadratic, not cubic: the quad is sized for the glow's full reach and a cubic put
    // 88% of the falloff in the inner half, so the street outside it stayed unlit.
    g = pow(max(0.0, 1.0 - length(vLocal)), 2.0);
  } else {
    vec2 d = abs(vLocal);

    // Local coords span the padded quad, so the panel's own edge sits at this fraction of
    // them — per axis, because uGlowMarginM is an absolute metre pad. With one shared
    // threshold a 3 x 1.5 m sign lit a near-square blob instead of a bar.
    vec2 panel = vPanelM / max(vPanelM + uGlowMarginM, vec2(1e-4));
    float box = max(d.x / max(panel.x, 1e-4), d.y / max(panel.y, 1e-4));

    float face = 1.0 - smoothstep(0.86, 1.0, box);
    float frame = smoothstep(0.70, 0.86, box) * (1.0 - smoothstep(1.0, 1.14, box));

    // Blocks along the panel's long axis: reads as writing at a glance without being
    // writing, and keeps a 20 m banner from being one long smear.
    float alongM = vPanelM.x >= vPanelM.y
      ? vLocal.x * (vPanelM.x + uGlowMarginM)
      : vLocal.y * (vPanelM.y + uGlowMarginM);
    float cell = alongM / GLYPH_PERIOD_M;
    // halfFill, not half: 'half' is a reserved word in GLSL ES 1.00.
    float halfFill = GLYPH_FILL * (0.45 + 0.55 * hash11(floor(cell) + vSeed * 37.0)) * 0.5;
    float aa = 0.5 / max(GLYPH_PERIOD_M * vGlyphPxPerM, 1.0);
    float block = 1.0 - smoothstep(halfFill - aa, halfFill + aa, abs(fract(cell) - 0.5));
    // Sub-pixel glyphs would alias into noise, and there are no derivatives here, so the
    // pattern LODs to flat against the vertex shader's px/metre instead.
    float glyphs = mix(1.0, mix(GLYPH_DIM, 1.0, block),
                       smoothstep(1.5, 4.0, GLYPH_PERIOD_M * vGlyphPxPerM));

    // Zero on the whole |vLocal| = 1 boundary, so abutting quads cannot show a seam.
    float halo = 1.0 - smoothstep(0.0, 1.0, max(d.x, d.y));
    g = halo * 0.45 + face * glyphs * 0.55 + frame * 0.5;
  }

  // Alpha 0, not g: BLEND_MODES.ADD is blendFunc(ONE, ONE), so alpha accumulates too and
  // glow landing outside the city would make the offscreen target opaque there.
  gl_FragColor = vec4(vGlow * g, 0.0);
}
`;
