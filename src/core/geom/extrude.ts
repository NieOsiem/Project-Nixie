export interface Vec2 {
  x: number;
  y: number;
}

/** Interleaved layout: aPos(2) aHeight(1) aMaterial(1) aShade(1). */
export const VERTEX_FLOATS = 5;
export const VERTEX_STRIDE_BYTES = VERTEX_FLOATS * 4;
export const ATTRIBUTE_OFFSETS = { pos: 0, height: 8, material: 12, shade: 16 } as const;

export interface BuildingSpec {
  /** Convex footprint in world pixels. Winding is normalised internally. */
  footprint: Vec2[];
  /** Height in metres. Stays in metres so geometry survives a grid-size change. */
  height: number;
  roofMaterial: number;
  wallMaterial: number;
}

export interface MeshBuffers {
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/** Direction the key light arrives from, in world space (y grows downward). */
const LIGHT_DIRECTION: Vec2 = { x: -0.5547, y: -0.8321 };
const SHADE_MIN = 0.32;
const SHADE_MAX = 1;
const ROOF_SHADE = 1;

export function signedArea(poly: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Normalise winding so `signedArea` is positive, which makes (dy, -dx) the outward
 * edge normal. Avoids reasoning about clockwise-ness in a y-down coordinate system,
 * where the visual and mathematical senses are opposite.
 */
export function withPositiveArea(poly: Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

/** Lambert-ish shade for a wall, from the outward normal of one footprint edge. */
export function wallShade(edgeStart: Vec2, edgeEnd: Vec2): number {
  const dx = edgeEnd.x - edgeStart.x;
  const dy = edgeEnd.y - edgeStart.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return SHADE_MIN;

  const nx = dy / len;
  const ny = -dx / len;
  const facing = 0.5 + 0.5 * (nx * LIGHT_DIRECTION.x + ny * LIGHT_DIRECTION.y);
  return SHADE_MIN + (SHADE_MAX - SHADE_MIN) * facing;
}

export function extrudeBuilding(spec: BuildingSpec): MeshBuffers {
  const poly = withPositiveArea(spec.footprint);
  const n = poly.length;
  if (n < 3) throw new Error(`Footprint needs at least 3 points, got ${n}.`);

  const vertexCount = n * 5;
  const triangleCount = n * 3 - 2;
  const vertices = new Float32Array(vertexCount * VERTEX_FLOATS);
  const indices = new Uint32Array(triangleCount * 3);

  let v = 0;
  const push = (p: Vec2, height: number, material: number, shade: number): number => {
    const at = v * VERTEX_FLOATS;
    vertices[at] = p.x;
    vertices[at + 1] = p.y;
    vertices[at + 2] = height;
    vertices[at + 3] = material;
    vertices[at + 4] = shade;
    return v++;
  };

  // Roof cap, fan-triangulated. Convex only — S2 swaps in a general triangulator.
  const roofStart = v;
  for (let i = 0; i < n; i++) push(poly[i]!, spec.height, spec.roofMaterial, ROOF_SHADE);

  let t = 0;
  for (let i = 1; i < n - 1; i++) {
    indices[t++] = roofStart;
    indices[t++] = roofStart + i;
    indices[t++] = roofStart + i + 1;
  }

  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const shade = wallShade(a, b);

    const base = push(a, 0, spec.wallMaterial, shade);
    push(b, 0, spec.wallMaterial, shade);
    push(b, spec.height, spec.wallMaterial, shade);
    push(a, spec.height, spec.wallMaterial, shade);

    indices[t++] = base;
    indices[t++] = base + 1;
    indices[t++] = base + 2;
    indices[t++] = base;
    indices[t++] = base + 2;
    indices[t++] = base + 3;
  }

  return { vertices, indices, vertexCount, triangleCount };
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
