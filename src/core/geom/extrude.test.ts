import { describe, expect, it } from "vitest";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "./mesh.js";
import {
  DETAILED_MASSING_MIN_HEIGHT_M,
  ROOF_SHADE,
  SHADE_MAX,
  SHADE_MIN,
  describeBuildingMassing,
  extrudeBuilding,
  wallShade,
  withPositiveArea,
  type BuildingSpec
} from "./extrude.js";
import { rectRing, ringArea, ringCentroid, type Ring } from "./types.js";

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
    seed: m.vertices[at + 8]!,
    roofCentreX: m.vertices[at + 9]!,
    roofCentreY: m.vertices[at + 10]!
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

  it("keeps every wall darker than a roof", () => {
    expect(SHADE_MAX).toBeLessThan(ROOF_SHADE);
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

  it("puts the roof cap at full height with the roof material and positive extents", () => {
    const m = extrudeBuilding(spec(), PPM);
    for (let i = 0; i < 4; i++) {
      const v = vertexAt(m, i);
      expect(v.height).toBe(40);
      expect(v.material).toBe(1);
      expect(v.shade).toBe(2.5);
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
      expect(v.u).toBe(2.5);
      expect(v.top).toBe(0);
      expect(v.seed).toBe(0.25);
      expect(v.roofCentreX).toBe(5);
      expect(v.roofCentreY).toBe(5);
    }
  });

  it("aligns roof detail to the longest footprint edge", () => {
    const m = extrudeBuilding(
      spec({ footprint: rectRing({ x: 0, y: 0, width: 10, height: 30 }) }),
      PPM
    );
    for (let i = 0; i < 4; i++) {
      const v = vertexAt(m, i);
      expect(v.top).toBeCloseTo(Math.PI / 2, 6);
      expect(v.u).toBe(7.5);
      expect(v.shade).toBe(2.5);
    }
  });

  it("disables rectangular roof structures on irregular footprints", () => {
    const footprint: Ring = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 8 },
      { x: 8, y: 8 },
      { x: 8, y: 20 },
      { x: 0, y: 20 }
    ];
    const m = extrudeBuilding(spec({ footprint }), PPM);
    for (let i = 0; i < footprint.length; i++) expect(vertexAt(m, i).shade).toBeLessThan(0);
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

  it("keeps unmarked high-rise specs as one simple volume", () => {
    const building = spec({
      height: DETAILED_MASSING_MIN_HEIGHT_M * 2,
      footprint: rectRing({ x: 0, y: 0, width: 30 * PPM, height: 24 * PPM })
    });
    expect(describeBuildingMassing(building, PPM).volumes).toHaveLength(1);
    expect(extrudeBuilding(building, PPM)).toMatchObject({ vertexCount: 20, triangleCount: 10 });
  });

  it("describes deterministic contained two-tier massing for marked orthogonal towers", () => {
    const building = spec({
      detailedMassing: true,
      height: 80,
      seed: 0.5,
      footprint: rectRing({ x: 100, y: 200, width: 30 * PPM, height: 24 * PPM })
    });
    const a = describeBuildingMassing(building, PPM);
    const b = describeBuildingMassing(building, PPM);
    expect(b).toEqual(a);
    expect(a.volumes).toHaveLength(2);

    const lower = a.volumes[0]!;
    const upper = a.volumes[1]!;
    expect(lower.baseHeight).toBe(0);
    expect(lower.topHeight).toBeGreaterThan(0);
    expect(lower.topHeight).toBeLessThan(building.height);
    expect(upper.baseHeight).toBe(lower.topHeight);
    expect(upper.topHeight).toBe(building.height);
    const lowerCentre = ringCentroid(lower.footprint);
    const upperCentre = ringCentroid(upper.footprint);
    expect(Math.hypot(upperCentre.x - lowerCentre.x, upperCentre.y - lowerCentre.y)).toBeGreaterThan(1);

    const outer = rectRing({ x: 100, y: 200, width: 30 * PPM, height: 24 * PPM });
    const bounds = {
      minX: Math.min(...outer.map((p) => p.x)),
      minY: Math.min(...outer.map((p) => p.y)),
      maxX: Math.max(...outer.map((p) => p.x)),
      maxY: Math.max(...outer.map((p) => p.y))
    };
    for (const p of upper.footprint) {
      expect(p.x).toBeGreaterThan(bounds.minX);
      expect(p.x).toBeLessThan(bounds.maxX);
      expect(p.y).toBeGreaterThan(bounds.minY);
      expect(p.y).toBeLessThan(bounds.maxY);
    }
  });

  it("extrudes marked towers from each tier's base without exceeding the configured height", () => {
    const building = spec({
      detailedMassing: true,
      height: 80,
      footprint: rectRing({ x: 0, y: 0, width: 30 * PPM, height: 24 * PPM })
    });
    const massing = describeBuildingMassing(building, PPM);
    const mesh = extrudeBuilding(building, PPM);
    expect(mesh).toMatchObject({ vertexCount: 40, triangleCount: 20 });

    const join = massing.volumes[0]!.topHeight;
    expect(vertexAt(mesh, 0).height).toBeCloseTo(join, 5);
    expect(vertexAt(mesh, 20).height).toBe(building.height);
    expect(vertexAt(mesh, 24).height).toBeCloseTo(join, 5);
    expect(vertexAt(mesh, 20).seed).not.toBe(vertexAt(mesh, 0).seed);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const vertex = vertexAt(mesh, i);
      expect(vertex.height).toBeGreaterThanOrEqual(0);
      expect(vertex.height).toBeLessThanOrEqual(building.height);
      expect(vertex.material).toBe(vertex.kind === KIND.ROOF ? 1 : 2);
    }
  });

  it("falls back to one volume below the height gate or on an irregular footprint", () => {
    const low = spec({ detailedMassing: true, height: DETAILED_MASSING_MIN_HEIGHT_M - 0.01 });
    const irregular = spec({
      detailedMassing: true,
      height: 80,
      footprint: [
        { x: 0, y: 0 },
        { x: 20 * PPM, y: 0 },
        { x: 12 * PPM, y: 8 * PPM },
        { x: 0, y: 8 * PPM }
      ]
    });
    expect(describeBuildingMassing(low, PPM).volumes).toHaveLength(1);
    expect(describeBuildingMassing(irregular, PPM).volumes).toHaveLength(1);
  });

  it("keeps detailed massing fixed in metres across a scene regrid", () => {
    const atScale = (ppm: number) =>
      describeBuildingMassing(
        spec({
          detailedMassing: true,
          height: 80,
          seed: 0.5,
          footprint: rectRing({ x: 0, y: 0, width: 30 * ppm, height: 24 * ppm })
        }),
        ppm
      );
    const coarse = atScale(PPM);
    const fine = atScale(PPM * 2);
    expect(fine.volumes.map((volume) => [volume.baseHeight, volume.topHeight])).toEqual(
      coarse.volumes.map((volume) => [volume.baseHeight, volume.topHeight])
    );
    for (let i = 0; i < coarse.volumes[1]!.footprint.length; i++) {
      const a = coarse.volumes[1]!.footprint[i]!;
      const b = fine.volumes[1]!.footprint[i]!;
      expect(b.x / (PPM * 2)).toBeCloseTo(a.x / PPM, 6);
      expect(b.y / (PPM * 2)).toBeCloseTo(a.y / PPM, 6);
    }
  });
});
