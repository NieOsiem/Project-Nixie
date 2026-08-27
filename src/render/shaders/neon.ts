import { PANEL_IMPORTANCE_STRIDE } from "../../core/gen/neon.js";
import { PALETTE_SIZE } from "../../core/palette.js";
import { SEED_STEPS } from "./city.js";

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
varying float vImportance;

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
  // aSeed keeps old minor strengths verbatim. Major panels pack an integer importance tier
  // above the complete base-strength range; decode before palette gain and glyph hashing.
  float importance = floor(aSeed / ${PANEL_IMPORTANCE_STRIDE}.0);
  float panelSeed = aSeed - importance * ${PANEL_IMPORTANCE_STRIDE}.0;
  vGlow = emissive.rgb * (emissive.a * uEmissiveMax) * panelSeed;
  vRadial = aShade;
  vSeed = panelSeed;
  vImportance = importance * (1.0 - step(0.5, aShade));

  // d(lean)/dh, as in city.ts: a banner's glyphs run up the facade, where a metre of
  // height covers this many screen pixels rather than uScreenPxPerMetre.
  float upPxPerMetre =
    length(fromPivot) * uCamHeight / (eye * eye) * uScreenPxPerMetre * uLeanStrength;
  vGlyphPxPerM = aRoofCentre.x >= aRoofCentre.y ? uScreenPxPerMetre : upPxPerMetre;

  // WHY: dist is convex in position but the rasterizer interpolates it linearly across a
  // triangle, so a large quad reads FURTHER than the truth by ~span^2 * ppm / camHeight
  // metres. Measured 1.8 m for a 60 m pool at the default 500 m camera and 5.9 m at 150 m,
  // against a 1.5 m bias — the pool lost the depth test over part of itself and the ground
  // showed sharp triangular bites along the quad's own diagonal. Panels are small enough
  // that their term is noise, and adding it there would undo SIGN_BIAS_M.
  float span = max(aRoofCentre.x, aRoofCentre.y);
  float curvature = span * span * uPixelsPerMetre / max(uCamHeight, 1.0);
  float bias = mix(SIGN_BIAS_M, POOL_BIAS_M + curvature, step(0.5, aShade));
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
varying float vImportance;

uniform float uGlowMarginM;
// CRITIQUE C1 live dials: uNeonGain scales every additive quad; uPoolGain scales the ground
// pools only, so environmental bounce tunes apart from the signage itself.
uniform float uNeonGain;
uniform float uPoolGain;

// Coarse enough that the ¼-res bloom blur cannot smear the blocks across the gaps.
const float GLYPH_PERIOD_M = 1.6;
const float GLYPH_FILL = 0.62;

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
    g = pow(max(0.0, 1.0 - length(vLocal)), 2.0) * uNeonGain * uPoolGain;
  } else {
    vec2 d = abs(vLocal);

    // Local coords span the padded quad, so the panel's own edge sits at this fraction of
    // them — per axis, because uGlowMarginM is an absolute metre pad. With one shared
    // threshold a 3 x 1.5 m sign lit a near-square blob instead of a bar.
    vec2 panel = vPanelM / max(vPanelM + uGlowMarginM, vec2(1e-4));
    float box = max(d.x / max(panel.x, 1e-4), d.y / max(panel.y, 1e-4));

    // Blocks along the panel's long axis: reads as writing at a glance without being
    // writing, and keeps a 20 m banner from being one long smear.
    float alongM = vPanelM.x >= vPanelM.y
      ? vLocal.x * (vPanelM.x + uGlowMarginM)
      : vLocal.y * (vPanelM.y + uGlowMarginM);
    float cell = alongM / GLYPH_PERIOD_M;
    // halfFill, not half: 'half' is a reserved word in GLSL ES 1.00.
    // Snapped like city.ts: a banner spans the facade, so its varying w interpolates the
    // per-sign vSeed ~1 ULP off and hash11 turns that into a different glyph run per band.
    float seed = floor(vSeed * ${SEED_STEPS}.0 + 0.5) / ${SEED_STEPS}.0;
    float halfFill = GLYPH_FILL * (0.45 + 0.55 * hash11(floor(cell) + seed * 37.0)) * 0.5;
    float aa = 0.5 / max(GLYPH_PERIOD_M * vGlyphPxPerM, 1.0);
    float block = 1.0 - smoothstep(halfFill - aa, halfFill + aa, abs(fract(cell) - 0.5));

    // Sub-pixel detail would alias into noise and there are no derivatives here, so glyphs
    // and frame both LOD out against the vertex shader's px/metre: a distant panel is a
    // plain lit rectangle, which is what it should be.
    float detail = smoothstep(1.5, 4.0, GLYPH_PERIOD_M * vGlyphPxPerM);

    float inside = 1.0 - smoothstep(0.94, 1.02, box);
    float frame = smoothstep(0.78, 0.90, box) * inside * detail;
    float lit = max(frame, inside * mix(1.0, block, detail));

    // WHY the shape is carved out of unlit gaps rather than piled on in highlights: the
    // composite ends in c *= 1/(1 + max(m-1, 0)), which for m >= 1 is an exact clamp to 1.0,
    // not a shoulder. Panels run at 1.65x strength, so a frame at g=1.35, a lit glyph at
    // g=1.00 and a gap at g=0.68 all resolved to the identical pixel and the panel read as a
    // featureless blob. Only what stays under the clamp can carry structure, so the gaps do.
    // Keep spill * gap below ~0.47 or the gaps clip too and the blob comes back.
    float spill = 1.0 - smoothstep(0.0, 1.0, max(d.x, d.y));
    // Importance changes the emissive core only: minor spill/gaps remain byte-identical, while
    // large billboards/banners and crowns cross bloom threshold without inflating every panel.
    float coreGain = 1.0 + vImportance * 0.16;
    g = (spill * 0.24 + lit * 0.85 * coreGain) * uNeonGain;
  }

  // Alpha 0, not g: BLEND_MODES.ADD is blendFunc(ONE, ONE), so alpha accumulates too and
  // glow landing outside the city would make the offscreen target opaque there.
  gl_FragColor = vec4(vGlow * g, 0.0);
}
`;
