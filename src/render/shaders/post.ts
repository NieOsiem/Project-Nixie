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
uniform float uContactAoStrength;
uniform float uLightSpillStrength;
uniform float uLightSpillRadius;
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
uniform float uPuddleReflectionStrength;
uniform float uRadialSmear;
uniform float uSmearStrength;
uniform float uBlackLift;
uniform float uDebugGrayscale;
uniform vec2 uPivotUv;
uniform vec2 uWorldOriginM;
uniform vec2 uWorldSizeM;
uniform vec2 uWideTexel;
uniform vec2 uAoTexel;
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
const float ROAD_SAMPLE_M = ${glslFloat(2.0)};
const float TINY_PUDDLE_SCALE = ${glslFloat(0.24)};
const float HUGE_PUDDLE_SCALE = ${glslFloat(4.5)};
const float HUGE_ASPECT_MIN = ${glslFloat(2.8)};
const float HUGE_ASPECT_SPAN = ${glslFloat(2.7)};
const float TAU = ${glslFloat(Math.PI * 2)};

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

float roadCue(vec3 colour) {
  float luma = dot(colour, ${LUMA});
  float lowLuma = 1.0 - smoothstep(0.12, 0.34, luma);
  float blueViolet = smoothstep(-0.025, 0.10, colour.b - max(colour.r, colour.g));
  return lowLuma * mix(0.55, 1.0, blueViolet);
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

  float ground = (1.0 - smoothstep(0.0, WET_GROUND_HEIGHT_M, heightM)) * covered;
  vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;

  // Four pre-grade scene neighbours do double duty: their metre-space gradients find curbs and
  // their road cues provide a broad cross-section probe for junctions and long carriageways.
  vec2 roadUv = vec2(ROAD_SAMPLE_M) / max(uWorldSizeM, vec2(0.001));
  vec4 sceneLeft = texture2D(uScene, clamp(vUv - vec2(roadUv.x, 0.0), vec2(0.0), vec2(1.0)) * uSceneUvScale);
  vec4 sceneRight = texture2D(uScene, clamp(vUv + vec2(roadUv.x, 0.0), vec2(0.0), vec2(1.0)) * uSceneUvScale);
  vec4 sceneUp = texture2D(uScene, clamp(vUv - vec2(0.0, roadUv.y), vec2(0.0), vec2(1.0)) * uSceneUvScale);
  vec4 sceneDown = texture2D(uScene, clamp(vUv + vec2(0.0, roadUv.y), vec2(0.0), vec2(1.0)) * uSceneUvScale);
  float sceneLuma = dot(sceneSample.rgb, ${LUMA});
  float leftLuma = dot(sceneLeft.rgb, ${LUMA});
  float rightLuma = dot(sceneRight.rgb, ${LUMA});
  float upLuma = dot(sceneUp.rgb, ${LUMA});
  float downLuma = dot(sceneDown.rgb, ${LUMA});
  float roadEdge = smoothstep(0.025, 0.12, max(
    max(abs(sceneLuma - leftLuma), abs(sceneLuma - rightLuma)),
    max(abs(sceneLuma - upLuma), abs(sceneLuma - downLuma))));
  float surfaceHeightEdge = max(
    max(abs(sceneSample.a - sceneLeft.a), abs(sceneSample.a - sceneRight.a)),
    max(abs(sceneSample.a - sceneUp.a), abs(sceneSample.a - sceneDown.a)));
  float centreRoad = roadCue(sceneSample.rgb);
  float leftRoad = roadCue(sceneLeft.rgb);
  float rightRoad = roadCue(sceneRight.rgb);
  float upRoad = roadCue(sceneUp.rgb);
  float downRoad = roadCue(sceneDown.rgb);
  float broadRoad = (leftRoad + rightRoad + upRoad + downRoad) * 0.25;
  float longRoad = max(min(leftRoad, rightRoad), min(upRoad, downRoad));
  float junction = smoothstep(0.52, 0.82, broadRoad)
    * smoothstep(0.30, 0.65, min(max(leftRoad, rightRoad), max(upRoad, downRoad)));
  float roadLikelihood = clamp(
    centreRoad * 0.65 + broadRoad * 0.25 + roadEdge * 0.35 + longRoad * 0.15,
    0.0, 1.0);
  float roadMask = smoothstep(0.18, 0.62, roadLikelihood) * ground;

  // A stationary drainage band breaks up otherwise even road odds. It is world-anchored, and the
  // broad probe raises odds at junctions and along long sections without knowing road topology.
  float drainageBand = 1.0 - smoothstep(
    0.34, 0.50, abs(fract(dot(worldM, vec2(0.035, 0.012))) - 0.5));
  float placementBias = roadMask
    * (roadEdge * 0.12 + junction * 0.10 + longRoad * 0.06 + drainageBand * 0.08);

  // Deterministic multi-scale union. Tiny pockets use a broken high-frequency pair, medium
  // puddles merge two offset lobes, and the huge tier stretches along a seeded local direction.
  float puddleScale = max(uPuddleScaleM, 0.001);
  vec2 orientationCell = floor(worldM / (puddleScale * HUGE_PUDDLE_SCALE));
  float angle = hash21(orientationCell + vec2(71.0, 19.0)) * TAU;
  vec2 axis = vec2(cos(angle), sin(angle));
  vec2 across = vec2(-axis.y, axis.x);
  vec2 orientedM = vec2(dot(worldM, axis), dot(worldM, across));
  float tinyA = valueNoise((worldM + vec2(13.7, -9.2)) / (puddleScale * TINY_PUDDLE_SCALE));
  float tinyB = valueNoise((worldM + vec2(-4.1, 21.3)) / (puddleScale * TINY_PUDDLE_SCALE * 0.63));
  float tinyField = min(max(tinyA, tinyB * 0.96), min(tinyA, tinyB) + 0.34);
  float mediumA = valueNoise(orientedM / puddleScale);
  float mediumB = valueNoise((orientedM + vec2(puddleScale * 0.46, -puddleScale * 0.24)) / puddleScale);
  float mediumField = max(mediumA, mediumB * 0.98);
  float hugeAspect = HUGE_ASPECT_MIN
    + HUGE_ASPECT_SPAN * hash21(orientationCell + vec2(29.0, 83.0));
  float hugeField = valueNoise(vec2(
    orientedM.x / (puddleScale * HUGE_PUDDLE_SCALE * hugeAspect),
    orientedM.y / (puddleScale * HUGE_PUDDLE_SCALE)));
  float puddleNoise = max(tinyField - 0.08, max(mediumField, hugeField - 0.04))
    + placementBias;
  float puddleThreshold = 1.0 - clamp(uPuddleCoverage, 0.0, 1.0);
  float wetIn = puddleThreshold - PUDDLE_EDGE_WET;
  float coverageGate = step(0.0001, uPuddleCoverage);
  float puddle = smoothstep(
    wetIn, puddleThreshold + PUDDLE_EDGE_DRY, puddleNoise)
    * roadMask * coverageGate;
  float rim = smoothstep(wetIn, puddleThreshold, puddleNoise)
    * (1.0 - puddle) * roadMask * coverageGate;
  float roadWet = clamp(uWetStrength, 0.0, 1.0) * roadMask * coverageGate;
  float wet = roadWet * puddle;

  // Material tiers: damp carriageway stays broad and subdued; deep water makes more headroom for
  // a sharper coloured reflection. The explicit coverage gate keeps the dry preset byte-identical.
  float darkMask = clamp(roadWet * 0.18 + wet * 0.82 + PUDDLE_RIM_DARKEN * rim, 0.0, 1.0);
  vec3 darkTarget = clamp(uWetDarken, 0.0, 1.0) * WET_DARKEN_TINT
    * mix(1.0, 0.42, puddle);
  c *= mix(vec3(1.0), darkTarget, darkMask);
  float light = clamp(dot(c, ${LUMA}), 0.0, 1.0);
  float broadGloss = roadWet * (1.0 - puddle * 0.70)
    * clamp(uWetGloss, 0.0, 1.0) * smoothstep(0.02, 0.60, light) * 0.28;
  c = mix(c, min(c * (1.0 + GLOSS_LIFT), vec3(1.0)), broadGloss);

  // A four-tap wide-bloom fan remains exclusively for low-frequency diffuse spill. Sharp water
  // reflection uses the already-blurred bloom at this puddle pixel, never a remote directional max.
  vec2 fanMetres = vec2(max(uLightSpillRadius, 0.001)) / max(uWorldSizeM, vec2(0.001));
  vec2 radialDir = normalize(vUv - uPivotUv + vec2(0.0001));
  vec2 fanDir = normalize(vec2(0.82, -0.37) + radialDir * uRadialSmear * 4.0);
  vec2 fanAcross = vec2(-fanDir.y, fanDir.x);
  vec3 fanForward = texture2D(uBloomWide,
    clamp(vUv + fanDir * fanMetres, vec2(0.0), vec2(1.0)) * uWideUvScale).rgb;
  vec3 fanBack = texture2D(uBloomWide,
    clamp(vUv - fanDir * fanMetres, vec2(0.0), vec2(1.0)) * uWideUvScale).rgb;
  vec3 fanLeft = texture2D(uBloomWide,
    clamp(vUv + fanAcross * fanMetres * 0.42, vec2(0.0), vec2(1.0)) * uWideUvScale).rgb;
  vec3 fanRight = texture2D(uBloomWide,
    clamp(vUv - fanAcross * fanMetres * 0.42, vec2(0.0), vec2(1.0)) * uWideUvScale).rgb;
  vec3 fanBloom = (wideBloom + fanForward + fanBack + fanLeft + fanRight) * 0.2;
  vec3 reflectionBloom = wideBloom;
  float reflectionLuma = dot(reflectionBloom, ${LUMA});
  float reflectionChroma = max(max(reflectionBloom.r, reflectionBloom.g), reflectionBloom.b)
    - min(min(reflectionBloom.r, reflectionBloom.g), reflectionBloom.b);
  float reflectionSelect = smoothstep(0.020, 0.120, reflectionLuma)
    * smoothstep(0.010, 0.080, reflectionChroma);
  vec3 reflectionHue = reflectionBloom / max(reflectionLuma, 0.001);
  vec3 reflectionLift = reflectionHue
    * min(reflectionLuma * uWideStrength * 1.8, 0.60);
  float reflectionAmount = wet * smoothstep(0.48, 0.90, puddle)
    * clamp(uPuddleReflectionStrength, 0.0, 2.0) * reflectionSelect;

  // Preserve the original radial wet smear as a longer, softer tier behind the sharp local reflection.
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
    smearWeight += w;
  }
  smearSample /= max(smearWeight, 0.001);
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
  vec2 aoUv = vUv * uAoUvScale;
  float aoLeft = texture2D(uAo, clamp(aoUv - vec2(uAoTexel.x, 0.0), vec2(0.0), uAoUvScale)).r;
  float aoRight = texture2D(uAo, clamp(aoUv + vec2(uAoTexel.x, 0.0), vec2(0.0), uAoUvScale)).r;
  float aoUp = texture2D(uAo, clamp(aoUv - vec2(0.0, uAoTexel.y), vec2(0.0), uAoUvScale)).r;
  float aoDown = texture2D(uAo, clamp(aoUv + vec2(0.0, uAoTexel.y), vec2(0.0), uAoUvScale)).r;
  float aoEdge = max(
    max(abs(ao - aoLeft), abs(ao - aoRight)),
    max(abs(ao - aoUp), abs(ao - aoDown)));
  float lowness = 1.0 - smoothstep(0.0, uAoHeightM, heightM);
  float lowSurface = lowness * covered;
  float contactBand = smoothstep(0.42, 0.72, ao) * (1.0 - smoothstep(0.84, 0.98, ao));
  float contactAo = max(smoothstep(0.035, 0.16, aoEdge), contactBand)
    * (1.0 - buildingCoverage);
  c *= 1.0 - uAoStrength * ao * lowSurface;
  c *= 1.0 - clamp(uContactAoStrength, 0.0, 1.0) * contactAo * lowSurface;

  // Water receives the sharp local source colour after every matte occlusion term, so a puddle
  // catches nearby light on top of the cast shadow instead of having its reflection multiplied away.
  vec3 reflectionTarget = min(c + reflectionLift, vec3(1.0));
  c = mix(c, reflectionTarget, clamp(reflectionAmount, 0.0, 1.0));

  // Selected chromatic bloom paints only ground and low walls. White markings fail the chroma
  // gate; roofs fail the height gate; AO and the tight contact ring stop light leaking through feet.
  float spillLuma = dot(fanBloom, ${LUMA});
  float spillChroma = max(max(fanBloom.r, fanBloom.g), fanBloom.b)
    - min(min(fanBloom.r, fanBloom.g), fanBloom.b);
  float spillSelect = smoothstep(0.020, 0.120, spillLuma)
    * smoothstep(0.010, 0.080, spillChroma);
  float spillHeight = 1.0 - smoothstep(2.0, 16.0, heightM);
  float lowWall = smoothstep(0.0015, 0.020, surfaceHeightEdge)
    * spillHeight * (1.0 - ground);
  float spillSurface = max(ground, lowWall) * covered;
  float spillOcclusion = 1.0 - clamp(ao * 0.72 + contactAo * 0.90, 0.0, 1.0);
  float spillAmount = clamp(uLightSpillStrength, 0.0, 2.0)
    * spillSelect * spillSurface * spillOcclusion;
  vec3 spillHue = fanBloom / max(spillLuma, 0.001);
  vec3 spillTarget = min(
    c + spillHue * min(spillLuma * uWideStrength * 1.8, 0.54),
    vec3(1.0));
  c = mix(c, spillTarget, clamp(spillAmount, 0.0, 1.0));

  // Global grade constants are intentionally unchanged.
  c = c * vec3(0.94, 0.91, 1.10) + vec3(0.008, 0.005, 0.022) * uBlackLift;
  c *= 1.0 - ${DEPTH_FALLOFF} * smoothstep(0.20, 0.72, length(vUv - uPivotUv));

  float radial = length(vUv - uPivotUv);
  float density = exp(-heightM / max(uFogHeightM, 0.001));
  float fog = (1.0 - exp(-uFogDensity * radial)) * density * covered * uFogStrength;
  vec3 haze = vec3(uFogTintR, uFogTintG, uFogTintB) + wideBloom * uFogInscatter;
  c = mix(c, haze, clamp(fog, 0.0, 1.0));

  float l = dot(c, ${LUMA});
  float chroma = mix(${glslFloat(BODY_CHROMA)}, ${glslFloat(NEON_CHROMA)}, smoothstep(0.18, 0.62, l));
  c = max(mix(vec3(l), c, chroma) - vec3(${BLACK_FLOOR}), vec3(0.0));

  float m = max(max(c.r, c.g), c.b);
  c *= 1.0 / (1.0 + max(m - 1.0, 0.0));
  c = mix(c, vec3(dot(c, ${LUMA})), clamp(uDebugGrayscale, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}
`;
