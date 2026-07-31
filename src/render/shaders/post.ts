/**
 * Post chain shaders. GLSL ES 1.00, one screen quad per pass.
 *
 * The scene and bloom targets are half-float, preserving emissive radiance above 1.0.
 * The threshold sits above the base surface colours (0.03–0.2) and below the emissive
 * materials, which is what makes lit windows and neon the only things that glow. The
 * composite tone maps once into its RGBA8 output.
 */
const THRESHOLD = 0.55;
/** Half-width of the quadratic knee below the threshold. Softens the cut-in. */
const KNEE = 0.25;

const LUMA = "vec3(0.299, 0.587, 0.114)";

/** Chroma kept where the image is dark, and where it is bright. See the grade in COMPOSITE_FRAG. */
const BODY_CHROMA = 0.55;
const NEON_CHROMA = 1.15;
/** Darkening at the far edge of the depth falloff. */
const DEPTH_FALLOFF = 0.25;

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
 */
export const THRESHOLD_FRAG = `
precision highp float;

uniform sampler2D uScene;
uniform vec2 uSrcTexel;

varying vec2 vUv;

void main() {
  vec3 c = 0.25 * (
    texture2D(uScene, vUv + uSrcTexel * vec2(-1.0, -1.0)).rgb +
    texture2D(uScene, vUv + uSrcTexel * vec2( 1.0, -1.0)).rgb +
    texture2D(uScene, vUv + uSrcTexel * vec2(-1.0,  1.0)).rgb +
    texture2D(uScene, vUv + uSrcTexel * vec2( 1.0,  1.0)).rgb);

  float l = dot(c, ${LUMA});
  float soft = clamp(l - ${THRESHOLD.toFixed(3)} + ${KNEE.toFixed(3)}, 0.0, ${(2 * KNEE).toFixed(3)});
  soft = soft * soft / ${(4 * KNEE).toFixed(3)};
  float w = max(soft, l - ${THRESHOLD.toFixed(3)}) / max(l, 0.0001);

  gl_FragColor = vec4(c * w, 1.0);
}
`;

export const DOWNSAMPLE_FRAG = `
precision highp float;

uniform sampler2D uTex;
uniform vec2 uSrcTexel;

varying vec2 vUv;

void main() {
  vec3 c = 0.25 * (
    texture2D(uTex, vUv + uSrcTexel * vec2(-1.0, -1.0)).rgb +
    texture2D(uTex, vUv + uSrcTexel * vec2( 1.0, -1.0)).rgb +
    texture2D(uTex, vUv + uSrcTexel * vec2(-1.0,  1.0)).rgb +
    texture2D(uTex, vUv + uSrcTexel * vec2( 1.0,  1.0)).rgb);

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
uniform vec2 uDir;

varying vec2 vUv;

void main() {
  vec2 o1 = uDir * uTexel * 1.3846153846;
  vec2 o2 = uDir * uTexel * 3.2307692308;

  vec3 s = texture2D(uTex, vUv).rgb * 0.2270270270;
  s += (texture2D(uTex, vUv + o1).rgb + texture2D(uTex, vUv - o1).rgb) * 0.3162162162;
  s += (texture2D(uTex, vUv + o2).rgb + texture2D(uTex, vUv - o2).rgb) * 0.0702702703;

  gl_FragColor = vec4(s, 1.0);
}
`;

export const COMPOSITE_FRAG = `
precision highp float;

uniform sampler2D uScene;
uniform sampler2D uBloomNarrow;
uniform sampler2D uBloomWide;
uniform sampler2D uShadow;
uniform sampler2D uBuildingMask;
uniform float uNarrowStrength;
uniform float uWideStrength;
uniform vec2 uPivotUv;

varying vec2 vUv;

void main() {
  vec3 c = texture2D(uScene, vUv).rgb
    + texture2D(uBloomNarrow, vUv).rgb * uNarrowStrength
    + texture2D(uBloomWide, vUv).rgb * uWideStrength;
  float castShadow = texture2D(uShadow, vUv).r * (1.0 - texture2D(uBuildingMask, vUv).a);
  c *= 1.0 - 0.38 * castShadow;

  // Geometry leans away from uPivot, so screen distance from it IS depth here — this is the
  // projection's own falloff, not a photographic vignette, which is why it keys off the pivot
  // rather than the frame centre. Deliberately not aspect-corrected: on a 2.39:1 panel a
  // screen-circular falloff reaches the top and bottom edges and never the left and right.
  c *= 1.0 - ${DEPTH_FALLOFF} * smoothstep(0.20, 0.72, length(vUv - uPivotUv));

  // Chroma as a function of luma: dark masses go near-neutral, bright things keep and gain
  // saturation. Full chroma on the bases is what makes every roof compete with the signage.
  float l = dot(c, ${LUMA});
  float chroma = mix(${BODY_CHROMA}, ${NEON_CHROMA}, smoothstep(0.18, 0.62, l));
  c = max(mix(vec3(l), c, chroma), vec3(0.0));

  float m = max(max(c.r, c.g), c.b);
  c *= 1.0 / (1.0 + max(m - 1.0, 0.0));
  gl_FragColor = vec4(c, 1.0);
}
`;
