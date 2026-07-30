import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_OFFSETS,
  VERTEX_FLOATS,
  extrudeBuilding,
  mergeMeshes,
  signedArea,
  wallShade,
  withPositiveArea,
  type BuildingSpec,
  type Vec2
} from "./extrude.js";

const square = (size = 10): Vec2[] => [
  { x: 0, y: 0 },
  { x: size, y: 0 },
  { x: size, y: size },
  { x: 0, y: size }
];

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  footprint: square(),
  height: 40,
  roofMaterial: 1,
  wallMaterial: 2,
  ...over
});

const vertexAt = (m: { vertices: Float32Array }, i: number) => {
  const at = i * VERTEX_FLOATS;
  return {
    x: m.vertices[at]!,
    y: m.vertices[at + 1]!,
    height: m.vertices[at + 2]!,
    material: m.vertices[at + 3]!,
    shade: m.vertices[at + 4]!
  };
};

describe("signedArea", () => {
  it("is positive for the canonical winding", () => {
    expect(signedArea(square())).toBe(100);
  });

  it("flips sign with winding", () => {
    expect(signedArea([...square()].reverse())).toBe(-100);
  });
});

describe("withPositiveArea", () => {
  it("leaves an already-positive polygon alone", () => {
    const p = square();
    expect(withPositiveArea(p)).toBe(p);
  });

  it("reverses a negative polygon", () => {
    expect(signedArea(withPositiveArea([...square()].reverse()))).toBe(100);
  });
});

describe("wallShade", () => {
  // Outward normal of an edge is (dy, -dx) once the polygon has positive area.
  const p = square();
  const shades = p.map((a, i) => wallShade(a, p[(i + 1) % p.length]!));

  it("stays within the shading range", () => {
    for (const s of shades) {
      expect(s).toBeGreaterThanOrEqual(0.32);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("lights opposing walls differently", () => {
    expect(shades[0]).not.toBeCloseTo(shades[2]!, 3);
    expect(shades[1]).not.toBeCloseTo(shades[3]!, 3);
  });

  it("is symmetric about the light direction", () => {
    // Edges 0 and 2 face -y and +y; 1 and 3 face +x and -x. Opposite pairs sum to
    // twice the midpoint of the range regardless of the light vector.
    expect(shades[0]! + shades[2]!).toBeCloseTo(0.32 + 1, 6);
    expect(shades[1]! + shades[3]!).toBeCloseTo(0.32 + 1, 6);
  });

  it("degrades to the minimum for a zero-length edge", () => {
    expect(wallShade({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0.32);
  });
});

describe("extrudeBuilding", () => {
  it("produces 5n vertices and 3n-2 triangles", () => {
    for (const n of [3, 4, 6, 12]) {
      const footprint = Array.from({ length: n }, (_, i) => ({
        x: 50 * Math.cos((i / n) * Math.PI * 2),
        y: 50 * Math.sin((i / n) * Math.PI * 2)
      }));
      const m = extrudeBuilding(spec({ footprint }));
      expect(m.vertexCount).toBe(n * 5);
      expect(m.triangleCount).toBe(n * 3 - 2);
      expect(m.vertices.length).toBe(n * 5 * VERTEX_FLOATS);
      expect(m.indices.length).toBe((n * 3 - 2) * 3);
    }
  });

  it("rejects degenerate footprints", () => {
    expect(() => extrudeBuilding(spec({ footprint: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }))).toThrow();
  });

  it("puts the roof cap at full height with the roof material", () => {
    const m = extrudeBuilding(spec());
    for (let i = 0; i < 4; i++) {
      const v = vertexAt(m, i);
      expect(v.height).toBe(40);
      expect(v.material).toBe(1);
      expect(v.shade).toBe(1);
    }
  });

  it("anchors every wall to the ground and the roofline", () => {
    const m = extrudeBuilding(spec());
    const heights = new Set<number>();
    for (let i = 4; i < m.vertexCount; i++) {
      const v = vertexAt(m, i);
      expect(v.material).toBe(2);
      heights.add(v.height);
    }
    expect([...heights].sort((a, b) => a - b)).toEqual([0, 40]);
  });

  it("emits only in-range indices", () => {
    const m = extrudeBuilding(spec());
    for (const i of m.indices) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(m.vertexCount);
    }
  });

  it("is winding-independent", () => {
    const a = extrudeBuilding(spec());
    const b = extrudeBuilding(spec({ footprint: [...square()].reverse() }));
    expect(b.vertexCount).toBe(a.vertexCount);
    expect(b.triangleCount).toBe(a.triangleCount);
    // Same set of wall shades regardless of the order points were supplied in.
    const shadesOf = (m: typeof a) =>
      Array.from({ length: m.vertexCount }, (_, i) => vertexAt(m, i).shade).sort();
    expect(shadesOf(b)).toEqual(shadesOf(a));
  });

  it("keeps the footprint at ground level", () => {
    const m = extrudeBuilding(spec());
    const ground = Array.from({ length: m.vertexCount }, (_, i) => vertexAt(m, i)).filter(
      (v) => v.height === 0
    );
    for (const v of ground) {
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.x).toBeLessThanOrEqual(10);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeLessThanOrEqual(10);
    }
  });
});

describe("mergeMeshes", () => {
  it("concatenates and rebases indices", () => {
    const a = extrudeBuilding(spec());
    const b = extrudeBuilding(spec({ footprint: square(20), height: 90 }));
    const merged = mergeMeshes([a, b]);

    expect(merged.vertexCount).toBe(a.vertexCount + b.vertexCount);
    expect(merged.triangleCount).toBe(a.triangleCount + b.triangleCount);

    for (const i of merged.indices) expect(i).toBeLessThan(merged.vertexCount);

    // The second part's indices must all land in its own vertex range.
    const tail = merged.indices.slice(a.indices.length);
    for (const i of tail) expect(i).toBeGreaterThanOrEqual(a.vertexCount);
  });

  it("preserves attribute values across the seam", () => {
    const a = extrudeBuilding(spec());
    const b = extrudeBuilding(spec({ height: 90, roofMaterial: 5 }));
    const merged = mergeMeshes([a, b]);
    expect(vertexAt(merged, a.vertexCount).height).toBe(90);
    expect(vertexAt(merged, a.vertexCount).material).toBe(5);
  });

  it("handles the empty case", () => {
    const merged = mergeMeshes([]);
    expect(merged.vertexCount).toBe(0);
    expect(merged.indices.length).toBe(0);
  });
});

describe("layout constants", () => {
  it("keeps byte offsets consistent with the float layout", () => {
    expect(ATTRIBUTE_OFFSETS.pos).toBe(0);
    expect(ATTRIBUTE_OFFSETS.height).toBe(2 * 4);
    expect(ATTRIBUTE_OFFSETS.material).toBe(3 * 4);
    expect(ATTRIBUTE_OFFSETS.shade).toBe(4 * 4);
    expect(VERTEX_FLOATS).toBe(5);
  });
});
