/** Interleaved layout: aPos(2) aHeight(1) aMaterial(1) aShade(1). */
export const VERTEX_FLOATS = 5;
export const VERTEX_STRIDE_BYTES = VERTEX_FLOATS * 4;
export const ATTRIBUTE_OFFSETS = { pos: 0, height: 8, material: 12, shade: 16 } as const;

export interface MeshBuffers {
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export function emptyMesh(): MeshBuffers {
  return {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    vertexCount: 0,
    triangleCount: 0
  };
}

/** Fills pre-sized buffers. Callers know their vertex and triangle counts upfront. */
export class MeshBuilder {
  #vertices: Float32Array;
  #indices: Uint32Array;
  #vertexCount = 0;
  #triangleCount = 0;

  constructor(maxVertices: number, maxTriangles: number) {
    this.#vertices = new Float32Array(maxVertices * VERTEX_FLOATS);
    this.#indices = new Uint32Array(maxTriangles * 3);
  }

  get vertexCount(): number {
    return this.#vertexCount;
  }

  vertex(x: number, y: number, height: number, material: number, shade: number): number {
    const at = this.#vertexCount * VERTEX_FLOATS;
    this.#vertices[at] = x;
    this.#vertices[at + 1] = y;
    this.#vertices[at + 2] = height;
    this.#vertices[at + 3] = material;
    this.#vertices[at + 4] = shade;
    return this.#vertexCount++;
  }

  triangle(a: number, b: number, c: number): void {
    const at = this.#triangleCount * 3;
    this.#indices[at] = a;
    this.#indices[at + 1] = b;
    this.#indices[at + 2] = c;
    this.#triangleCount++;
  }

  build(): MeshBuffers {
    return {
      vertices: this.#vertices.slice(0, this.#vertexCount * VERTEX_FLOATS),
      indices: this.#indices.slice(0, this.#triangleCount * 3),
      vertexCount: this.#vertexCount,
      triangleCount: this.#triangleCount
    };
  }
}

export function mergeMeshes(parts: MeshBuffers[]): MeshBuffers {
  const vertexCount = parts.reduce((sum, p) => sum + p.vertexCount, 0);
  const triangleCount = parts.reduce((sum, p) => sum + p.triangleCount, 0);
  const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);
  const indices = new Uint32Array(triangleCount * 3);

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    vertices.set(part.vertices, vertexOffset * VERTEX_FLOATS);
    for (let i = 0; i < part.indices.length; i++) {
      indices[indexOffset + i] = part.indices[i]! + vertexOffset;
    }
    vertexOffset += part.vertexCount;
    indexOffset += part.indices.length;
  }

  return { vertices, indices, vertexCount, triangleCount };
}
