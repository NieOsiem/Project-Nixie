export const SHADOW_VERT = `
precision highp float;

attribute vec2 aPos;
attribute float aHeight;
attribute float aKind;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform float uPixelsPerMetre;
uniform vec2 uSunDir;
uniform float uSunLength;

void main() {
  vec2 shadowed = aPos + uSunDir * aHeight * uPixelsPerMetre * uSunLength;
  vec2 clip = (projectionMatrix * translationMatrix * vec3(shadowed, 1.0)).xy;
  float building = step(0.5, aKind) * (1.0 - step(2.5, aKind))
    + step(3.5, aKind) * (1.0 - step(4.5, aKind));
  building = min(building, 1.0);
  gl_Position = mix(vec4(2.0, 2.0, 0.0, 1.0), vec4(clip, 0.0, 1.0), building);
}
`;

export const SHADOW_FRAG = `
precision highp float;

void main() {
  gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}
`;
