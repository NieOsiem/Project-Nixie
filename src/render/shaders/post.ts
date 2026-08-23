/**
 * Post chain shaders. GLSL ES 1.00, one screen quad per pass.
 *
 * The scene and bloom targets are half-float, preserving emissive radiance above 1.0.
 * The threshold sits above the base surface colours (0.03–0.2) and below the emissive
 * materials, which is what makes lit windows and neon the only things that glow. The
 * composite tone maps once into its RGBA8 output.
 */
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";
import { glslFloat } from "./weather.js";

/** Half-width of the quadratic knee below the threshold. Softens the cut-in. */
const KNEE = 0.20;

const LUMA = "vec3(0.299, 0.587, 0.114)";

/** Chroma kept where the image is dark, and where it is bright. See the grade in COMPOSITE_FRAG.
 * BODY_CHROMA adds a mild global vibrance at 1.05 over the district albedo undertones;
 * bright signage gets the stronger 1.25 boost. */
const BODY_CHROMA = 1.05;
const NEON_CHROMA = 1.25;
/** Darkening at the far edge of the depth falloff. */
const DEPTH_FALLOFF = 0.10;
/** WHY: saturation must not lift black surfaces into purple fog. */
const BLACK_FLOOR = 0.004;

/** Ground height shared with the weather splash mask. */
const WET_GROUND_HEIGHT_M = 2.5;
/**
 * Puddle waterline half-widths in normalized field units (CRITIQUE.md #5). The wet-in side is
 * deliberately wide so island silhouettes rise smoothly instead of reading as camouflage
 * blotches; the dry-out side is narrow so the waterline still reads as an edge.
 */
const PUDDLE_EDGE_WET = 0.18;
const PUDDLE_EDGE_DRY = 0.04;
/** Peak strength of the damp-rim darkening between dry ground and standing water. */
const PUDDLE_RIM_DARKEN = 0.65;
/**
 * Anisotropy of the puddle noise domain: islands run ~35% longer along world Y so they read as
 * drainage-aligned standing water rather than round blobs. Same hash field, same determinism.
 */
const PUDDLE_STRETCH_Y = 1.35;
/**
 * Wet-darkening channel balance (CRITIQUE.md #14): reds and greens sink harder than blue, so a
 * darkened surface cools and saturates instead of merely scaling down.
 */
const WET_DARKEN_TINT_R = 0.9;
const WET_DARKEN_TINT_G = 0.97;
const WET_DARKEN_TINT_B = 1.06;
/** Bounded multiplicative gloss lift on lit wet surfaces (was an unguarded +35%). */
const GLOSS_LIFT = 0.5;
/** Constant-bound radial taps keep the smear a cheap composite term. */
const SMEAR_TAPS = 12;
/** Keep the old 0.65^4 endpoint while sampling the same profile at a denser spatial cadence. */
const SMEAR_PROFILE_STEPS = 4;
const SMEAR_DECAY = 0.65;

const ALPHA_FLOOR = SCENE_ALPHA_FLOOR.toFixed(6);
/** Half the floor: anything below it is cleared background, not geometry. */
const ALPHA_BACKGROUND = (SCENE_ALPHA_FLOOR * 0.5).toFixed(7);
const HEIGHT_NORM = SCENE_HEIGHT_NORM_M.toFixed(1);

/**
 * Unit quad. The mesh transform scales it to the target, so `aCorner` is also the UV.
 *
 * Both source and destination are render textures, which PIXI projects with the same
 * y direction, so no flip is needed anywhere in the chain.
 */
export const POST_VERT = `
precision highp float;

attribute vec2 aCorner;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;

varying vec2 vUv;

void main() {
  vUv = aCorner;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aCorner, 1.0)).xy, 0.0, 1.0);
}
`;

/**
 * Threshold and downsample in one pass.
 *
 * The four taps sit on source texel corners, so bilinear filtering makes each one a 2×2
 * average and the four together cover the full 4×4 block a destination texel stands for.
 * A single tap would miss fifteen of those sixteen texels and flicker as the camera moves.
 * The cut-in luma rides the live `uBloomThreshold` dial instead of a baked constant.
 */
export const THRESHOLD_FRAG = `
precision highp float;

uniform sampler2D uScene;
uniform vec2 uSrcTexel;
uniform vec2 uSceneUvScale;
uniform float uBloomThreshold;

varying vec2 vUv;

void main() {
  vec2 uv = vUv * uSceneUvScale;
  vec2 edge = 0.5 * uSrcTexel;
  vec2 limit = uSceneUvScale - edge;
  vec3 c = 0.25 * (
    texture2D(uScene, clamp(uv + uSrcTexel * vec2(-1.0, -1.0), edge, limit)).rgb +
    texture2D(uScene, clamp(uv + uSrcTexel * vec2( 1.0, -1.0), edge, limit)).rgb +
    texture2D(uScene, clamp(uv + uSrcTexel * vec2(-1.0,  1.0), edge, limit)).rgb +
    texture2D(uScene, clamp(uv + uSrcTexel * vec2( 1.0,  1.0), edge, limit)).rgb);

  float l = dot(c, ${LUMA});
  float soft = clamp(l - uBloomThreshold + ${KNEE.toFixed(3)}, 0.0, ${(2 * KNEE).toFixed(3)});
  soft = soft * soft / ${(4 * KNEE).toFixed(3)};
  float w = max(soft, l - uBloomThreshold) / max(l, 0.0001);

  gl_FragColor = vec4(c * w, 1.0);
}
`;

export const DOWNSAMPLE_FRAG = `
precision highp float;

uniform sampler2D uTex;
uniform vec2 uSrcTexel;
uniform vec2 uTexUvScale;

varying vec2 vUv;

void main() {
  vec2 uv = vUv * uTexUvScale;
  vec2 edge = 0.5 * uSrcTexel;
  vec2 limit = uTexUvScale - edge;
  vec3 c = 0.25 * (
    texture2D(uTex, clamp(uv + uSrcTexel * vec2(-1.0, -1.0), edge, limit)).rgb +
    texture2D(uTex, clamp(uv + uSrcTexel * vec2( 1.0, -1.0), edge, limit)).rgb +
    texture2D(uTex, clamp(uv + uSrcTexel * vec2(-1.0,  1.0), edge, limit)).rgb +
    texture2D(uTex, clamp(uv + uSrcTexel * vec2( 1.0,  1.0), edge, limit)).rgb);

  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * Separable gaussian, `uDir` picking the axis.
 *
 * Five taps, not nine: the offsets are the linear-sampling ones, so each off-centre tap
 * is a bilinear blend of two texels. Requires LINEAR filtering on the source.
 */
export const BLUR_FRAG = `
precision highp float;

uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uTexUvScale;
uniform vec2 uDir;

varying vec2 vUv;

void main() {
  vec2 uv = vUv * uTexUvScale;
  vec2 edge = 0.5 * uTexel;
  vec2 limit = uTexUvScale - edge;
  vec2 o1 = uDir * uTexel * 1.3846153846;
  vec2 o2 = uDir * uTexel * 3.2307692308;

  vec3 s = texture2D(uTex, clamp(uv, edge, limit)).rgb * 0.2270270270;
  s += (
    texture2D(uTex, clamp(uv + o1, edge, limit)).rgb
    + texture2D(uTex, clamp(uv - o1, edge, limit)).rgb) * 0.3162162162;
  s += (
    texture2D(uTex, clamp(uv + o2, edge, limit)).rgb
    + texture2D(uTex, clamp(uv - o2, edge, limit)).rgb) * 0.0702702703;

  gl_FragColor = vec4(s, 1.0);
}
`;

/** Taps per side of one streak pass. Also the stride multiplier between passes — see below. */
export const STREAK_TAPS = 8;
/** Per-texel falloff of the streak. 0.94^64 ≈ 0.02, so the tail dies just as the reach runs out. */
const STREAK_ATTENUATION = 0.94;

/**
 * One directional streak pass: uniformly spaced taps with geometric falloff.
 *
 * Contiguity here is structural: taps are one `uStep` apart, so a pass covers `STREAK_TAPS`
 * strides with no gaps, and the next pass uses a stride of exactly `STREAK_TAPS` texels — each
 * of its taps carries the previous pass's full contiguous smear. Two passes therefore cover
 * `STREAK_TAPS²` texels at single-texel resolution.
 *
 * Geometric weights compose exactly across passes: `a^t1 · a^t2 = a^(t1+t2)`, so the two-pass
 * kernel is `a^t` over the whole reach, not an approximation of one.
 */
export const STREAK_FRAG = `
precision highp float;

uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uTexUvScale;
uniform vec2 uStep;
uniform float uSpan;

varying vec2 vUv;

void main() {
  vec2 uv = vUv * uTexUvScale;
  vec2 edge = 0.5 * uTexel;
  vec2 limit = uTexUvScale - edge;

  vec3 sum = texture2D(uTex, clamp(uv, edge, limit)).rgb;
  float weight = 1.0;

  for (int i = 1; i <= ${STREAK_TAPS}; i++) {
    float t = float(i);
    float w = pow(${STREAK_ATTENUATION}, t * uSpan);
    vec2 o = uStep * t;
    sum += (
      texture2D(uTex, clamp(uv + o, edge, limit)).rgb
      + texture2D(uTex, clamp(uv - o, edge, limit)).rgb) * w;
    weight += 2.0 * w;
  }

  // Normalised: a streak may spread a highlight but never invent energy, so a long bright line
  // stays bright while a point spreads faint. That asymmetry is the physics, and uStreakStrength
  // is the dial for it.
  gl_FragColor = vec4(sum / weight, 1.0);
}
`;

export const COMPOSITE_FRAG = `
precision highp float;

uniform sampler2D uScene;
uniform sampler2D uBloomNarrow;
uniform sampler2D uBloomWide;
uniform sampler2D uStreak;
uniform sampler2D uShadow;
uniform sampler2D uBuildingMask;
uniform sampler2D uAo;
uniform float uNarrowStrength;
uniform float uWideStrength;
uniform float uStreakStrength;
uniform float uShadowStrength;
uniform float uAoStrength;
uniform float uAoHeightM;
uniform float uFogStrength;
uniform float uFogDensity;
uniform float uFogHeightM;
uniform float uFogInscatter;
uniform float uFogTintR;
uniform float uFogTintG;
uniform float uFogTintB;
uniform float uWetStrength;
uniform float uPuddleCoverage;
uniform float uPuddleScaleM;
uniform float uWetDarken;
uniform float uWetGloss;
uniform float uRadialSmear;
uniform float uSmearStrength;
uniform float uBlackLift;
uniform float uDebugGrayscale;
uniform vec2 uPivotUv;
uniform vec2 uWorldOriginM;
uniform vec2 uWorldSizeM;
uniform vec2 uWideTexel;
uniform vec2 uSceneUvScale;
uniform vec2 uBloomUvScale;
uniform vec2 uWideUvScale;
uniform vec2 uStreakUvScale;
uniform vec2 uShadowUvScale;
uniform vec2 uMaskUvScale;
uniform vec2 uAoUvScale;

varying vec2 vUv;

const float WET_GROUND_HEIGHT_M = ${glslFloat(WET_GROUND_HEIGHT_M)};
const float PUDDLE_EDGE_WET = ${glslFloat(PUDDLE_EDGE_WET)};
const float PUDDLE_EDGE_DRY = ${glslFloat(PUDDLE_EDGE_DRY)};
const float PUDDLE_RIM_DARKEN = ${glslFloat(PUDDLE_RIM_DARKEN)};
const vec3 WET_DARKEN_TINT = vec3(${glslFloat(WET_DARKEN_TINT_R)}, ${glslFloat(WET_DARKEN_TINT_G)}, ${glslFloat(WET_DARKEN_TINT_B)});
const float GLOSS_LIFT = ${glslFloat(GLOSS_LIFT)};
const float PUDDLE_STRETCH_Y = ${glslFloat(PUDDLE_STRETCH_Y)};

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

void main() {
  vec4 sceneSample = texture2D(uScene, vUv * uSceneUvScale);
  float covered = step(${ALPHA_BACKGROUND}, sceneSample.a);
  float heightM = max(sceneSample.a - ${ALPHA_FLOOR}, 0.0)
    / (1.0 - ${ALPHA_FLOOR}) * ${HEIGHT_NORM};

  vec3 wideBloom = texture2D(uBloomWide, vUv * uWideUvScale).rgb;
  vec3 c = sceneSample.rgb
    + texture2D(uBloomNarrow, vUv * uBloomUvScale).rgb * uNarrowStrength
    + wideBloom * uWideStrength
    + texture2D(uStreak, vUv * uStreakUvScale).rgb * uStreakStrength;

  // The composite has no material channel. A world-anchored field is deliberately surface-blind,
  // while the decoded height keeps the wet look on flat roads and low caps only.
  float ground = (1.0 - smoothstep(0.0, WET_GROUND_HEIGHT_M, heightM)) * covered;
  vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;
  // Anisotropic sample domain: islands elongate along world Y so they read as drainage-aligned
  // standing water rather than round blobs. Same hash field, so determinism is untouched.
  float puddleNoise = valueNoise(
    vec2(worldM.x, worldM.y * PUDDLE_STRETCH_Y) / max(uPuddleScaleM, 0.001));
  float puddleThreshold = 1.0 - clamp(uPuddleCoverage, 0.0, 1.0);
  // Asymmetric waterline: wide smooth wet-in, narrow crisp dry-out. Coverage zero stays exactly
  // dry through the explicit step gate, whatever the smoothstep tails do as noise approaches 1.
  float wetIn = puddleThreshold - PUDDLE_EDGE_WET;
  float puddle = smoothstep(wetIn, puddleThreshold + PUDDLE_EDGE_DRY, puddleNoise)
    * step(0.0001, uPuddleCoverage);
  // Damp collar hugging the outside of the waterline: fully risen before the water saturates,
  // gone inside it. Ground-gated so walls never grow rim halos.
  float rim = smoothstep(wetIn, puddleThreshold, puddleNoise)
    * (1.0 - puddle) * step(0.0001, uPuddleCoverage) * ground;
  float wet = clamp(uWetStrength, 0.0, 1.0) * ground * puddle;

  // Darken first to make headroom, then lift only lit puddles. Wet darkening is saturated and
  // slightly cool (WET_DARKEN_TINT) rather than a flat scale-down; the rim shares it at partial
  // strength and the mask clamps to 1 so the two stack without over-darkening. The mix stays
  // bounded so highlights near the tone-map ceiling cannot become an additive spike.
  c *= mix(vec3(1.0), clamp(uWetDarken, 0.0, 1.0) * WET_DARKEN_TINT,
    clamp(wet + PUDDLE_RIM_DARKEN * rim, 0.0, 1.0));
  float light = clamp(dot(c, ${LUMA}), 0.0, 1.0);
  float gloss = wet * clamp(uWetGloss, 0.0, 1.0) * smoothstep(0.02, 0.60, light);
  c = mix(c, min(c * (1.0 + GLOSS_LIFT), vec3(1.0)), gloss);

  // The projection leans geometry away from the pivot. A mirror image therefore samples away
  // from the pivot too; the reach is exactly zero at the pivot and grows radially with uRadialSmear.
  // Wide bloom is already blurred, so geometrically weighted taps are enough for a smooth broken tail.
  float smearAmount = wet * clamp(uSmearStrength, 0.0, 1.0);
  vec2 smearReach = (vUv - uPivotUv) * uRadialSmear;
  vec3 smearSample = vec3(0.0);
  float smearWeight = 0.0;
  for (int i = 1; i <= ${SMEAR_TAPS}; i++) {
    float t = float(i) / ${glslFloat(SMEAR_TAPS)};
    float w = pow(${glslFloat(SMEAR_DECAY)}, t * ${glslFloat(SMEAR_PROFILE_STEPS)});
    vec2 rawUv = (vUv + smearReach * t) * uWideUvScale;
    vec2 inFrame = step(vec2(0.0), rawUv) * step(rawUv, uWideUvScale);
    float valid = inFrame.x * inFrame.y;
    vec2 edgeFade = smoothstep(
      vec2(0.0), uWideTexel, rawUv)
      * (1.0 - smoothstep(
        uWideUvScale - uWideTexel,
        uWideUvScale,
        rawUv));
    float tapWeight = valid * edgeFade.x * edgeFade.y;
    vec2 sampleUv = clamp(rawUv, vec2(0.0), uWideUvScale);
    smearSample += texture2D(uBloomWide, sampleUv).rgb * (w * tapWeight);
    // WHY: renormalising valid taps would cancel the fade and recreate the hard edge plateau.
    smearWeight += w;
  }
  smearSample /= max(smearWeight, 0.001);
  // Tint a bounded dark lift toward the sampled neon hue. The explicit cap keeps wet highlights
  // from turning into a raw additive spike before the composite tone map.
  float smearLuma = dot(smearSample, ${LUMA});
  float smearLight = clamp(smearLuma * uWideStrength, 0.0, 1.0);
  vec3 smearHue = smearSample / max(smearLuma, 0.001);
  vec3 smearLift = mix(vec3(smearLight), smearHue * smearLight, clamp(uWetGloss, 0.0, 1.0));
  vec3 smearTarget = min(c + smearLift * ${glslFloat(0.35)}, vec3(1.0));
  c = mix(c, smearTarget, smearAmount);

  float buildingCoverage = texture2D(uBuildingMask, vUv * uMaskUvScale).a;
  float castShadow = texture2D(uShadow, vUv * uShadowUvScale).r
    * (1.0 - buildingCoverage);
  c *= 1.0 - uShadowStrength * castShadow;

  float ao = texture2D(uAo, vUv * uAoUvScale).r;
  float lowness = 1.0 - smoothstep(0.0, uAoHeightM, heightM);
  float lowSurface = lowness * covered;
  // The broad AO remains gentle, while its dense core becomes a tight contact term. The
  // full-resolution silhouette removes roofs and walls from that core: only the exposed side
  // of footprint edges and enclosed gaps receive the extra darkening. This reuses the one
  // blurred quarter-resolution AO sample; no target, pass, derivative or time term is added.
  float contactAo = smoothstep(0.30, 0.70, ao) * (1.0 - buildingCoverage);
  c *= 1.0 - uAoStrength * ao * lowSurface;
  c *= 1.0 - uAoStrength * 0.35 * contactAo * lowSurface;
  // Cool neon-night grade: the reference city sits on an indigo base — red damped, blue
  // lifted, a whisper of violet in the floor. Neon hues pass through the chroma stage after.
  // The floor term scales with the uBlackLift dial — below 1 deepens blacks toward true black.
  c = c * vec3(0.94, 0.91, 1.10) + vec3(0.008, 0.005, 0.022) * uBlackLift;

  // Geometry leans away from uPivot, so screen distance from it IS depth here — this is the
  // projection's own falloff, not a photographic vignette, which is why it keys off the pivot
  // rather than the frame centre.
  c *= 1.0 - ${DEPTH_FALLOFF} * smoothstep(0.20, 0.72, length(vUv - uPivotUv));

  // Fog keys off the same radial term the depth falloff darkens with, so the two stack
  // at the frame edge. Tune them together, never one alone.
  float radial = length(vUv - uPivotUv);
  float density = exp(-heightM / max(uFogHeightM, 0.001));
  float fog = (1.0 - exp(-uFogDensity * radial)) * density * covered * uFogStrength;
  vec3 haze = vec3(uFogTintR, uFogTintG, uFogTintB) + wideBloom * uFogInscatter;
  c = mix(c, haze, clamp(fog, 0.0, 1.0));

  // Grade: body chroma adds a mild global vibrance; neon chroma boosts bright signage harder.
  float l = dot(c, ${LUMA});
  float chroma = mix(${glslFloat(BODY_CHROMA)}, ${glslFloat(NEON_CHROMA)}, smoothstep(0.18, 0.62, l));
  c = max(mix(vec3(l), c, chroma) - vec3(${BLACK_FLOOR}), vec3(0.0));

  float m = max(max(c.r, c.g), c.b);
  c *= 1.0 / (1.0 + max(m - 1.0, 0.0));
  // Form-readability probe: presenting the graded frame as pure luma checks that architecture
  // keeps its form without emissives (CRITIQUE.md #4/#14).
  c = mix(c, vec3(dot(c, ${LUMA})), clamp(uDebugGrayscale, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}
`;
