/**
 * Interleaved layout: aPos(2) aHeight(1) aMaterial(1) aShade(1) aKind(1) aU(1) aTop(1)
 * aSeed(1) aRoofCentre(2).
 *
 * The facade attributes carry different meanings per kind; `aRoofCentre` is roof-only:
 *
 * | kind   | aU                      | aTop            | aSeed          |
 * |--------|-------------------------|-----------------|----------------|
 * | FLAT   | unused                  | unused          | unused         |
 * | WALL   | metres along the wall   | building height | building hash  |
 * | ROOF   | half-width, metres      | longest-edge angle | building hash |
 * | NEON   | local quad u, -1..1     | local quad v    | glow strength  |
 * | CLUTTER| cap local u, -1..1      | cap local v     | unused         |
 * | DETAIL | cap local u, -1..1      | cap local v     | detail hash    |
 * | CAR    | unused                  | unused          | car hash       |
 *
 * `aShade` is surface shade except on ROOF (signed half-height; negative disables structures)
 * and NEON (0 selects sign falloff, 1 radial). CLUTTER uses negative shade for its cap.
 */
export const VERTEX_FLOATS = 11;
export const VERTEX_STRIDE_BYTES = VERTEX_FLOATS * 4;
export const ATTRIBUTE_OFFSETS = {
  pos: 0,
  height: 8,
  material: 12,
  shade: 16,
  kind: 20,
  u: 24,
  top: 28,
  seed: 32,
  roofCentre: 36
} as const;

/** What the fragment shader should draw on a vertex. Values are read in `city.ts`. */
export const KIND = {
  FLAT: 0,
  WALL: 1,
  ROOF: 2,
  NEON: 3,
  CLUTTER: 4,
  DETAIL: 5,
  CAR: 6
} as const;

export const CAR_SURFACE = {
  CAP: -1,
  GLASS: -2,
  FRONT_LIGHT: -3,
  REAR_LIGHT: -4,
  TIRE: -5,
  TRIM: -6,
  BED: -7
} as const;

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

  vertex(
    x: number,
    y: number,
    height: number,
    material: number,
    shade: number,
    kind: number = KIND.FLAT,
    u = 0,
    top = 0,
    seed = 0,
    roofCentreX = 0,
    roofCentreY = 0
  ): number {
    const at = this.#vertexCount * VERTEX_FLOATS;
    this.#vertices[at] = x;
    this.#vertices[at + 1] = y;
    this.#vertices[at + 2] = height;
    this.#vertices[at + 3] = material;
    this.#vertices[at + 4] = shade;
    this.#vertices[at + 5] = kind;
    this.#vertices[at + 6] = u;
    this.#vertices[at + 7] = top;
    this.#vertices[at + 8] = seed;
    this.#vertices[at + 9] = roofCentreX;
    this.#vertices[at + 10] = roofCentreY;
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
