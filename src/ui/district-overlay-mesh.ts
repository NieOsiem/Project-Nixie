import type { Vec2 } from "../core/geom/types.js";

export interface DistrictOverlayLineMeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  segmentCount: number;
}

const FLOATS_PER_VERTEX = 9;
const VERTEX_STRIDE_BYTES = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT;
const COLOR_SCALE = 1 / 255;

export const DISTRICT_OVERLAY_LINE_VERT = `
precision highp float;

attribute vec2 aBase;
attribute vec2 aNormal;
attribute float aSignedHalfWidth;
attribute vec3 aColor;
attribute float aAlpha;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform float uInvZoom;

varying vec4 vColor;

void main() {
  vColor = vec4(aColor, aAlpha);
  // WHY: width is stored in screen pixels and scaled by 1/zoom in the shader, so
  // the geometry is zoom-independent and never needs rebuilding when the canvas zooms.
  vec2 offset = aNormal * (aSignedHalfWidth * uInvZoom);
  gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aBase + offset, 1.0)).xy, 0.0, 1.0);
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

  /** `width` is a screen-pixel width; the vertex shader applies the inverse zoom. */
  add(start: Vec2, end: Vec2, width: number, color: number, alpha: number): void {
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) return;
    if (!Number.isFinite(width) || width <= 0 || !Number.isInteger(color) || color < 0 || color > 0xffffff) return;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length === 0) return;
    const halfWidth = width * 0.5;
    const nx = -dy / length;
    const ny = dx / length;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    const base = this.#segmentCount * 4;
    const red = ((color >>> 16) & 0xff) * COLOR_SCALE;
    const green = ((color >>> 8) & 0xff) * COLOR_SCALE;
    const blue = (color & 0xff) * COLOR_SCALE;
    this.#vertex(start.x, start.y, nx, ny, halfWidth, red, green, blue, alpha);
    this.#vertex(end.x, end.y, nx, ny, halfWidth, red, green, blue, alpha);
    this.#vertex(end.x, end.y, nx, ny, -halfWidth, red, green, blue, alpha);
    this.#vertex(start.x, start.y, nx, ny, -halfWidth, red, green, blue, alpha);
    this.#indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.#segmentCount++;
  }

  #vertex(x: number, y: number, nx: number, ny: number, signedHalfWidth: number, red: number, green: number, blue: number, alpha: number): void {
    this.#vertices.push(x, y, nx, ny, signedHalfWidth, red, green, blue, alpha);
  }

  build(): DistrictOverlayLineMeshData {
    return {
      vertices: Float32Array.from(this.#vertices),
      indices: Uint32Array.from(this.#indices),
      segmentCount: this.#segmentCount
    };
  }
}

/**
 * Merge per-frame chunk buffers into one indexed mesh, re-basing each chunk's
 * indices onto the accumulated vertex count. Returns null when there is nothing
 * to draw. WHY: the incremental pipeline emits one mesh per frame chunk to bound
 * per-frame work; coalescing after the build collapses those draw calls to one.
 */
export function coalesceDistrictOverlayData(chunks: readonly DistrictOverlayLineMeshData[]): DistrictOverlayLineMeshData | null {
  const totalSegments = chunks.reduce((sum, chunk) => sum + chunk.segmentCount, 0);
  if (totalSegments === 0) return null;
  const vertices = new Float32Array(totalSegments * 4 * FLOATS_PER_VERTEX);
  const indices = new Uint32Array(totalSegments * 6);
  let vertexCursor = 0;
  let indexCursor = 0;
  let segmentOffset = 0;
  for (const chunk of chunks) {
    vertices.set(chunk.vertices, vertexCursor);
    vertexCursor += chunk.vertices.length;
    const indexBase = segmentOffset * 4;
    for (let index = 0; index < chunk.indices.length; index++) indices[indexCursor++] = chunk.indices[index]! + indexBase;
    segmentOffset += chunk.segmentCount;
  }
  return { vertices, indices, segmentCount: totalSegments };
}

export class DistrictOverlayLineMesh {
  readonly display: any;

  #geometry: any;
  #shader: any;

  constructor(data: DistrictOverlayLineMeshData) {
    const vertexBuffer = new PIXI.Buffer(data.vertices);
    const F = PIXI.TYPES.FLOAT;
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aBase", vertexBuffer, 2, false, F, VERTEX_STRIDE_BYTES, 0)
      .addAttribute("aNormal", vertexBuffer, 2, false, F, VERTEX_STRIDE_BYTES, 2 * Float32Array.BYTES_PER_ELEMENT)
      .addAttribute("aSignedHalfWidth", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, 4 * Float32Array.BYTES_PER_ELEMENT)
      .addAttribute("aColor", vertexBuffer, 3, false, F, VERTEX_STRIDE_BYTES, 5 * Float32Array.BYTES_PER_ELEMENT)
      .addAttribute("aAlpha", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, 8 * Float32Array.BYTES_PER_ELEMENT)
      .addIndex(data.indices);
    this.#shader = PIXI.Shader.from(DISTRICT_OVERLAY_LINE_VERT, DISTRICT_OVERLAY_LINE_FRAG);
    this.display = new PIXI.Mesh(this.#geometry, this.#shader);
    this.display.state.blend = true;
  }

  setInvZoom(invZoom: number): void {
    this.#shader.uniforms.uInvZoom = invZoom;
  }

  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
  }
}
