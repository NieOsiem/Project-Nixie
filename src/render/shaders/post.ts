/**
 * Post chain shaders. GLSL ES 1.00, one screen quad per pass.
 *
 * The scene target is RGBA8, so anything emissive above 1.0 has already clamped. The
 * threshold sits above the base surface colours (0.03–0.2) and below the emissive
 * materials, which is what makes lit windows and neon the only things that glow.
 */
const THRESHOLD = 0.55;
/** Half-width of the quadratic knee below the threshold. Softens the cut-in. */
const KNEE = 0.25;

const LUMA = "vec3(0.299, 0.587, 0.114)";

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
uniform sampler2D uBloom;
uniform float uStrength;

varying vec2 vUv;

void main() {
  vec3 c = texture2D(uScene, vUv).rgb + texture2D(uBloom, vUv).rgb * uStrength;
  gl_FragColor = vec4(c, 1.0);
}
`;
