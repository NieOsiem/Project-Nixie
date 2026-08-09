import type { Vec2 } from "../core/geom/types.js";

export interface DistrictOverlayLineMeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  segmentCount: number;
}

const FLOATS_PER_VERTEX = 6;
const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const COLOR_SCALE = 1 / 255;

export const DISTRICT_OVERLAY_LINE_VERT = `
precision highp float;

attribute vec2 aPosition;
attribute vec3 aColor;
attribute float aAlpha;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;

varying vec4 vColor;

void main() {
  vColor = vec4(aColor, aAlpha);
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

export const DISTRICT_OVERLAY_LINE_FRAG = `
precision mediump float;

varying vec4 vColor;

void main() {
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`;

export class DistrictOverlayLineMeshBuilder {
  #vertices: number[] = [];
  #indices: number[] = [];
  #segmentCount = 0;

  get segmentCount(): number {
    return this.#segmentCount;
  }

  add(start: Vec2, end: Vec2, width: number, color: number, alpha: number): void {
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) return;
    if (!Number.isFinite(width) || width <= 0 || !Number.isInteger(color) || color < 0 || color > 0xffffff) return;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length === 0) return;
    const halfWidth = width * 0.5;
    const nx = (-dy / length) * halfWidth;
    const ny = (dx / length) * halfWidth;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    if (!Number.isFinite(start.x + nx) || !Number.isFinite(start.y + ny)
      || !Number.isFinite(end.x + nx) || !Number.isFinite(end.y + ny)
      || !Number.isFinite(end.x - nx) || !Number.isFinite(end.y - ny)
      || !Number.isFinite(start.x - nx) || !Number.isFinite(start.y - ny)) return;
    const base = this.#segmentCount * 4;
    const red = ((color >>> 16) & 0xff) * COLOR_SCALE;
    const green = ((color >>> 8) & 0xff) * COLOR_SCALE;
    const blue = (color & 0xff) * COLOR_SCALE;
    this.#vertex(start.x + nx, start.y + ny, red, green, blue, alpha);
    this.#vertex(end.x + nx, end.y + ny, red, green, blue, alpha);
    this.#vertex(end.x - nx, end.y - ny, red, green, blue, alpha);
    this.#vertex(start.x - nx, start.y - ny, red, green, blue, alpha);
    this.#indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.#segmentCount++;
  }

  #vertex(x: number, y: number, red: number, green: number, blue: number, alpha: number): void {
    this.#vertices.push(x, y, red, green, blue, alpha);
  }

  build(): DistrictOverlayLineMeshData {
    return {
      vertices: Float32Array.from(this.#vertices),
      indices: Uint32Array.from(this.#indices),
      segmentCount: this.#segmentCount
    };
  }
}

export class DistrictOverlayLineMesh {
  readonly display: any;

  #geometry: any;

  constructor(data: DistrictOverlayLineMeshData) {
    const vertexBuffer = new PIXI.Buffer(data.vertices);
    const F = PIXI.TYPES.FLOAT;
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aPosition", vertexBuffer, 2, false, F, VERTEX_STRIDE_BYTES, 0)
      .addAttribute("aColor", vertexBuffer, 3, false, F, VERTEX_STRIDE_BYTES, 2 * Float32Array.BYTES_PER_ELEMENT)
      .addAttribute("aAlpha", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, 5 * Float32Array.BYTES_PER_ELEMENT)
      .addIndex(data.indices);
    const shader = PIXI.Shader.from(DISTRICT_OVERLAY_LINE_VERT, DISTRICT_OVERLAY_LINE_FRAG);
    this.display = new PIXI.Mesh(this.#geometry, shader);
    this.display.state.blend = true;
  }

  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
  }
}
