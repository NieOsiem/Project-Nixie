import { describe, expect, it } from "vitest";
import { VERTEX_FLOATS } from "./mesh.js";
import { flatMesh, triangulate } from "./tessellate.js";
import { rectRing, ringArea, type Polygon, type Ring } from "./types.js";

const square = (size = 10): Ring => rectRing({ x: 0, y: 0, width: size, height: size });

const triangleArea = (positions: { x: number; y: number }[], indices: Uint32Array): number => {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = positions[indices[i]!]!;
    const b = positions[indices[i + 1]!]!;
    const c = positions[indices[i + 2]!]!;
    total += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }
  return total;
};

describe("triangulate", () => {
  it("gives n-2 triangles for a convex ring", () => {
    for (const n of [3, 4, 5, 8]) {
      const ring: Ring = Array.from({ length: n }, (_, i) => ({
        x: 50 * Math.cos((i / n) * Math.PI * 2),
        y: 50 * Math.sin((i / n) * Math.PI * 2)
      }));
      const t = triangulate([ring]);
      expect(t.indices.length / 3).toBe(n - 2);
    }
  });

  it("covers the full area of a square", () => {
    const t = triangulate([square()]);
    expect(triangleArea(t.positions, t.indices)).toBeCloseTo(100, 6);
  });

  it("handles a concave ring", () => {
    const l: Ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 }
    ];
    const t = triangulate([l]);
    expect(triangleArea(t.positions, t.indices)).toBeCloseTo(Math.abs(ringArea(l)), 6);
  });

  it("subtracts holes", () => {
    const withHole: Polygon = [
      square(30),
      [
        { x: 10, y: 10 },
        { x: 10, y: 20 },
        { x: 20, y: 20 },
        { x: 20, y: 10 }
      ]
    ];
    const t = triangulate(withHole);
    expect(triangleArea(t.positions, t.indices)).toBeCloseTo(900 - 100, 6);
  });

  it("emits nothing for a degenerate ring", () => {
    expect(triangulate([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]).indices.length).toBe(0);
    expect(triangulate([[]]).indices.length).toBe(0);
  });

  it("indexes only existing positions", () => {
    const t = triangulate([square()]);
    for (const i of t.indices) expect(i).toBeLessThan(t.positions.length);
  });
});

describe("flatMesh", () => {
  it("puts every vertex at the requested height with one material", () => {
    const m = flatMesh([[square()]], 0, 7, 0.8);
    expect(m.vertexCount).toBe(4);
    expect(m.triangleCount).toBe(2);
    for (let i = 0; i < m.vertexCount; i++) {
      expect(m.vertices[i * VERTEX_FLOATS + 2]).toBe(0);
      expect(m.vertices[i * VERTEX_FLOATS + 3]).toBe(7);
      expect(m.vertices[i * VERTEX_FLOATS + 4]).toBeCloseTo(0.8, 6);
    }
  });

  it("rebases indices across multiple polygons", () => {
    const a: Polygon = [square()];
    const b: Polygon = [rectRing({ x: 100, y: 100, width: 10, height: 10 })];
    const m = flatMesh([a, b], 0, 7, 1);
    expect(m.vertexCount).toBe(8);
    expect(m.triangleCount).toBe(4);
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
    // The second polygon's triangles must reference its own vertices.
    expect(Math.max(...Array.from(m.indices.slice(6)))).toBeGreaterThanOrEqual(4);
  });

  it("produces an empty mesh for empty input", () => {
    const m = flatMesh([], 0, 1, 1);
    expect(m.vertexCount).toBe(0);
    expect(m.triangleCount).toBe(0);
  });
});
