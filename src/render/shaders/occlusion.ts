/**
 * Building silhouette, for drawing the city back over the tokens it should hide.
 *
 * No depth buffer and no ordering: the colour pass has already resolved which surface wins
 * each pixel, and a token standing on the ground is behind *any* wall or roof drawn over
 * it — the camera is above the pivot, so geometry only ever leans between the ground and
 * the lens, never the other way. So the union of wall and roof coverage is the answer.
 */
export const BUILDING_MASK_VERT = `
precision highp float;

attribute vec2 aPos;
attribute float aHeight;
attribute float aKind;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec2 uPivot;
uniform float uPixelsPerMetre;
uniform float uCamHeight;
uniform float uLeanStrength;

varying float vKind;

void main() {
  float hpx = aHeight * uPixelsPerMetre;
  vec2 fromPivot = aPos - uPivot;
  float eye = max(uCamHeight - hpx, 1.0);
  vec2 leaned = aPos + fromPivot * (hpx / eye) * uLeanStrength;

  vKind = aKind;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(leaned, 1.0)).xy, 0.0, 1.0);
}
`;

export const BUILDING_MASK_FRAG = `
precision highp float;

varying float vKind;

void main() {
  // Ground is level with the tokens standing on it and must not mask them.
  if (vKind < 0.5 || vKind > 2.5) discard;
  gl_FragColor = vec4(1.0);
}
`;

/**
 * Re-presents the composited city, clipped to the building silhouette, above the tokens.
 *
 * Sampling the same texture the layer below already presents keeps the two copies pixel
 * identical, so the seam is invisible wherever no token sits between them.
 */
export const CITY_OVERLAY_FRAG = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uCity;
uniform sampler2D uMask;

void main() {
  float coverage = texture2D(uMask, vUv).a;
  if (coverage <= 0.0) discard;
  gl_FragColor = texture2D(uCity, vUv) * coverage;
}
`;

/**
 * One point per token, sampling the building mask at the ground the token stands on.
 *
 * A token sprite is a billboard: only its feet are really on the ground, so the mask —
 * which answers for ground points — may only be asked about that one pixel. Reading it
 * back a point at a time would stall on every token, so the whole set lands in one row.
 */
export const FOOT_PROBE_VERT = `
precision highp float;

attribute vec2 aSlot;
attribute vec2 aFootUv;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;

varying vec2 vFootUv;

void main() {
  vFootUv = aFootUv;
  gl_PointSize = 1.0;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aSlot, 1.0)).xy, 0.0, 1.0);
}
`;

export const FOOT_PROBE_FRAG = `
precision highp float;

varying vec2 vFootUv;

uniform sampler2D uMask;

void main() {
  bool offScreen = vFootUv.x < 0.0 || vFootUv.x > 1.0 || vFootUv.y < 0.0 || vFootUv.y > 1.0;
  gl_FragColor = vec4(offScreen ? 0.0 : texture2D(uMask, vFootUv).a);
}
`;
