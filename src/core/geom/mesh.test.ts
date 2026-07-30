import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_OFFSETS,
  MeshBuilder,
  VERTEX_FLOATS,
  emptyMesh,
  mergeMeshes,
  type MeshBuffers
} from "./mesh.js";

const triangleMesh = (offset = 0, material = 1): MeshBuffers => {
  const b = new MeshBuilder(3, 1);
  b.vertex(offset, 0, 0, material, 1);
  b.vertex(offset + 10, 0, 0, material, 1);
  b.vertex(offset, 10, 5, material, 0.5);
  b.triangle(0, 1, 2);
  return b.build();
};

const vertexAt = (m: MeshBuffers, i: number) => ({
  x: m.vertices[i * VERTEX_FLOATS]!,
  y: m.vertices[i * VERTEX_FLOATS + 1]!,
  height: m.vertices[i * VERTEX_FLOATS + 2]!,
  material: m.vertices[i * VERTEX_FLOATS + 3]!,
  shade: m.vertices[i * VERTEX_FLOATS + 4]!
});

describe("layout constants", () => {
  it("keeps byte offsets consistent with the float layout", () => {
    expect(VERTEX_FLOATS).toBe(5);
    expect(ATTRIBUTE_OFFSETS.pos).toBe(0);
    expect(ATTRIBUTE_OFFSETS.height).toBe(2 * 4);
    expect(ATTRIBUTE_OFFSETS.material).toBe(3 * 4);
    expect(ATTRIBUTE_OFFSETS.shade).toBe(4 * 4);
  });
});

describe("MeshBuilder", () => {
  it("returns sequential vertex indices", () => {
    const b = new MeshBuilder(3, 1);
    expect(b.vertex(0, 0, 0, 0, 1)).toBe(0);
    expect(b.vertex(1, 0, 0, 0, 1)).toBe(1);
    expect(b.vertexCount).toBe(2);
  });

  it("writes every attribute", () => {
    const m = triangleMesh();
    expect(vertexAt(m, 2)).toEqual({ x: 0, y: 10, height: 5, material: 1, shade: 0.5 });
  });

  it("trims unused capacity", () => {
    const b = new MeshBuilder(100, 50);
    b.vertex(0, 0, 0, 0, 1);
    b.vertex(1, 0, 0, 0, 1);
    b.vertex(0, 1, 0, 0, 1);
    b.triangle(0, 1, 2);
    const m = b.build();
    expect(m.vertexCount).toBe(3);
    expect(m.vertices.length).toBe(3 * VERTEX_FLOATS);
    expect(m.indices.length).toBe(3);
  });

  it("detaches from the builder's backing store", () => {
    const b = new MeshBuilder(4, 1);
    b.vertex(7, 7, 0, 0, 1);
    const m = b.build();
    b.vertex(99, 99, 0, 0, 1);
    expect(vertexAt(m, 0).x).toBe(7);
  });
});

describe("emptyMesh", () => {
  it("has nothing in it", () => {
    const m = emptyMesh();
    expect(m.vertexCount).toBe(0);
    expect(m.triangleCount).toBe(0);
    expect(m.vertices.length).toBe(0);
  });
});

describe("mergeMeshes", () => {
  it("concatenates and rebases indices", () => {
    const a = triangleMesh(0, 1);
    const b = triangleMesh(100, 2);
    const merged = mergeMeshes([a, b]);

    expect(merged.vertexCount).toBe(6);
    expect(merged.triangleCount).toBe(2);
    expect([...merged.indices]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("preserves attributes across the seam", () => {
    const merged = mergeMeshes([triangleMesh(0, 1), triangleMesh(100, 2)]);
    expect(vertexAt(merged, 3).x).toBe(100);
    expect(vertexAt(merged, 3).material).toBe(2);
  });

  it("keeps every index inside the merged range", () => {
    const merged = mergeMeshes([triangleMesh(), triangleMesh(50), triangleMesh(90)]);
    for (const i of merged.indices) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(merged.vertexCount);
    }
  });

  it("handles the empty case", () => {
    const merged = mergeMeshes([]);
    expect(merged.vertexCount).toBe(0);
    expect(merged.indices.length).toBe(0);
  });

  it("skips over empty parts", () => {
    const merged = mergeMeshes([emptyMesh(), triangleMesh(), emptyMesh()]);
    expect(merged.vertexCount).toBe(3);
    expect(merged.triangleCount).toBe(1);
  });
});
