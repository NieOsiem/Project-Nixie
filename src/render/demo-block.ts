import type { Rect } from "../core/camera.js";

const VERT = `
precision highp float;
attribute vec2 aVertexPosition;
attribute vec2 aLocal;
uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
varying vec2 vLocal;
void main() {
  vLocal = aLocal;
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 vLocal;
uniform vec2 uSize;

float roundedBox(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = (vLocal - 0.5) * uSize;
  float d = roundedBox(p, uSize * 0.5 - 14.0, 28.0);

  vec3 base = vec3(0.055, 0.043, 0.086);
  vec3 warm = vec3(1.00, 0.44, 0.63);
  vec3 cool = vec3(0.32, 0.86, 1.00);

  float body = smoothstep(2.0, -2.0, d);
  float rim = exp(-abs(d) * 0.055);
  float halo = exp(-abs(d) * 0.011);

  vec3 col = base * body;
  col += warm * rim * 0.95;
  col += cool * halo * 0.16;

  gl_FragColor = vec4(col, max(body, max(rim, halo * 0.5)));
}
`;

/** A single hard-coded neon panel in world coordinates. Placeholder payload for S0. */
export function createDemoBlock(rect: Rect): any {
  const { x, y, width: w, height: h } = rect;
  const geometry = new PIXI.Geometry()
    .addAttribute("aVertexPosition", [x, y, x + w, y, x + w, y + h, x, y + h], 2)
    .addAttribute("aLocal", [0, 0, 1, 0, 1, 1, 0, 1], 2)
    .addIndex([0, 1, 2, 0, 2, 3]);

  const shader = PIXI.Shader.from(VERT, FRAG, { uSize: [w, h] });
  return new PIXI.Mesh(geometry, shader);
}
