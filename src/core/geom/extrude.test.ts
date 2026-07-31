import { describe, expect, it } from "vitest";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "./mesh.js";
import {
  ROOF_SHADE,
  SHADE_MAX,
  SHADE_MIN,
  extrudeBuilding,
  wallShade,
  withPositiveArea,
  type BuildingSpec
} from "./extrude.js";
import { rectRing, ringArea, type Ring } from "./types.js";

const square = (size = 10): Ring => rectRing({ x: 0, y: 0, width: size, height: size });

const PPM = 2;

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  footprint: square(),
  height: 40,
  roofMaterial: 1,
  wallMaterial: 2,
  seed: 0.25,
  ...over
});

const vertexAt = (m: MeshBuffers, i: number) => {
  const at = i * VERTEX_FLOATS;
  return {
    x: m.vertices[at]!,
    y: m.vertices[at + 1]!,
    height: m.vertices[at + 2]!,
    material: m.vertices[at + 3]!,
    shade: m.vertices[at + 4]!,
    kind: m.vertices[at + 5]!,
    u: m.vertices[at + 6]!,
    top: m.vertices[at + 7]!,
    seed: m.vertices[at + 8]!
  };
};

describe("withPositiveArea", () => {
  it("leaves an already-positive ring alone", () => {
    const p = square();
    expect(withPositiveArea(p)).toBe(p);
  });

  it("reverses a negative ring", () => {
    expect(ringArea(withPositiveArea([...square()].reverse()))).toBe(100);
  });
});

describe("wallShade", () => {
  const p = square();
  const shades = p.map((a, i) => wallShade(a, p[(i + 1) % p.length]!));

  it("stays within the shading range", () => {
    for (const s of shades) {
      expect(s).toBeGreaterThanOrEqual(SHADE_MIN);
      expect(s).toBeLessThanOrEqual(SHADE_MAX);
    }
  });

  it("lights opposing walls differently", () => {
    expect(shades[0]).not.toBeCloseTo(shades[2]!, 3);
    expect(shades[1]).not.toBeCloseTo(shades[3]!, 3);
  });

  it("is symmetric about the light direction", () => {
    // Opposite faces have opposing normals, so their shades sum to the range midpoint
    // doubled regardless of which way the light points.
    expect(shades[0]! + shades[2]!).toBeCloseTo(SHADE_MIN + SHADE_MAX, 6);
    expect(shades[1]! + shades[3]!).toBeCloseTo(SHADE_MIN + SHADE_MAX, 6);
  });

  it("degrades to the minimum for a zero-length edge", () => {
    expect(wallShade({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(SHADE_MIN);
  });
});

describe("extrudeBuilding", () => {
  it("produces 5n vertices and 3n-2 triangles for a convex footprint", () => {
    for (const n of [3, 4, 6, 12]) {
      const footprint: Ring = Array.from({ length: n }, (_, i) => ({
        x: 50 * Math.cos((i / n) * Math.PI * 2),
        y: 50 * Math.sin((i / n) * Math.PI * 2)
      }));
      const m = extrudeBuilding(spec({ footprint }), PPM);
      expect(m.vertexCount).toBe(n * 5);
      expect(m.triangleCount).toBe(n * 3 - 2);
    }
  });

  it("handles a concave footprint", () => {
    const l: Ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 }
    ];
    const m = extrudeBuilding(spec({ footprint: l }), PPM);
    expect(m.vertexCount).toBe(6 * 5);
    expect(m.triangleCount).toBe(6 * 3 - 2);
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
  });

  it("rejects degenerate footprints", () => {
    const bad = spec({ footprint: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(() => extrudeBuilding(bad, PPM)).toThrow();
  });

  it("puts the roof cap at full height with the roof material", () => {
    const m = extrudeBuilding(spec(), PPM);
    for (let i = 0; i < 4; i++) {
      const v = vertexAt(m, i);
      expect(v.height).toBe(40);
      expect(v.material).toBe(1);
      expect(v.shade).toBe(ROOF_SHADE);
    }
  });

  it("anchors every wall to the ground and the roofline", () => {
    const m = extrudeBuilding(spec(), PPM);
    const heights = new Set<number>();
    for (let i = 4; i < m.vertexCount; i++) {
      const v = vertexAt(m, i);
      expect(v.material).toBe(2);
      heights.add(v.height);
    }
    expect([...heights].sort((a, b) => a - b)).toEqual([0, 40]);
  });

  it("emits only in-range indices", () => {
    const m = extrudeBuilding(spec(), PPM);
    for (const i of m.indices) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(m.vertexCount);
    }
  });

  it("tags the roof cap for the facade shader", () => {
    const m = extrudeBuilding(spec(), PPM);
    for (let i = 0; i < 4; i++) {
      const v = vertexAt(m, i);
      expect(v.kind).toBe(KIND.ROOF);
      expect(v.top).toBe(40);
      expect(v.seed).toBe(0.25);
    }
  });

  it("measures wall u in metres along that wall from its own start", () => {
    const footprint = rectRing({ x: 0, y: 0, width: 10, height: 30 });
    const m = extrudeBuilding(spec({ footprint }), PPM);
    // Ground a, ground b, top b, top a — so u repeats per corner, never accumulates.
    const expected = [
      [0, 5, 5, 0],
      [0, 15, 15, 0],
      [0, 5, 5, 0],
      [0, 15, 15, 0]
    ];
    for (let edge = 0; edge < 4; edge++) {
      for (let corner = 0; corner < 4; corner++) {
        const v = vertexAt(m, 4 + edge * 4 + corner);
        expect(v.kind).toBe(KIND.WALL);
        expect(v.u).toBeCloseTo(expected[edge]![corner]!, 9);
        expect(v.top).toBe(40);
        expect(v.seed).toBe(0.25);
      }
    }
  });

  it("scales wall u with pixels per metre", () => {
    const coarse = extrudeBuilding(spec(), PPM);
    const fine = extrudeBuilding(spec(), PPM * 4);
    expect(vertexAt(coarse, 5).u).toBeCloseTo(vertexAt(fine, 5).u * 4, 9);
  });

  it("is winding-independent", () => {
    const a = extrudeBuilding(spec(), PPM);
    const b = extrudeBuilding(spec({ footprint: [...square()].reverse() }), PPM);
    const shadesOf = (m: MeshBuffers) =>
      Array.from({ length: m.vertexCount }, (_, i) => vertexAt(m, i).shade).sort();
    expect(shadesOf(b)).toEqual(shadesOf(a));
  });
});
