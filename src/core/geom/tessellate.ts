import earcut from "earcut";
import { MeshBuilder, type MeshBuffers } from "./mesh.js";
import type { MultiPolygon, Polygon, Vec2 } from "./types.js";

export interface Triangulation {
  /** Outer ring points followed by each hole's points, in order. */
  positions: Vec2[];
  indices: Uint32Array;
}

/** Ear-clips a polygon with holes into triangles. */
export function triangulate(polygon: Polygon): Triangulation {
  const positions: Vec2[] = [];
  const coords: number[] = [];
  const holeIndices: number[] = [];

  polygon.forEach((ring, ringIndex) => {
    if (ringIndex > 0) holeIndices.push(positions.length);
    for (const p of ring) {
      positions.push(p);
      coords.push(p.x, p.y);
    }
  });

  if (positions.length < 3) return { positions, indices: new Uint32Array(0) };

  const indices = earcut(coords, holeIndices.length > 0 ? holeIndices : undefined, 2);
  return { positions, indices: Uint32Array.from(indices) };
}

/** Flat horizontal surface — roads, pavements, block ground. */
export function flatMesh(
  surface: MultiPolygon,
  height: number,
  material: number,
  shade: number
): MeshBuffers {
  const parts = surface.map(triangulate);
  const vertexCount = parts.reduce((sum, p) => sum + p.positions.length, 0);
  const triangleCount = parts.reduce((sum, p) => sum + p.indices.length / 3, 0);

  const builder = new MeshBuilder(vertexCount, triangleCount);
  for (const part of parts) {
    const base = builder.vertexCount;
    for (const p of part.positions) builder.vertex(p.x, p.y, height, material, shade);
    for (let i = 0; i < part.indices.length; i += 3) {
      builder.triangle(base + part.indices[i]!, base + part.indices[i + 1]!, base + part.indices[i + 2]!);
    }
  }
  return builder.build();
}
