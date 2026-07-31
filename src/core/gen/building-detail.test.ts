import { describe, expect, it } from "vitest";
import type { BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, type Ring } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT } from "../palette.js";
import {
  BUILDING_DETAIL_MIN_HEIGHT_M,
  buildingDetailMesh
} from "./building-detail.js";

const PPM = 25;

const spec = (over: Partial<BuildingSpec> = {}): BuildingSpec => ({
  footprint: rectRing({ x: 0, y: 0, width: 24 * PPM, height: 18 * PPM }),
  height: 52,
  roofMaterial: BANK_SIZE * 2 + 3,
  wallMaterial: BANK_SIZE * 2,
  seed: 0.42,
  detailedMassing: true,
  ...over
});

const vertexAt = (mesh: MeshBuffers, index: number) => {
  const at = index * VERTEX_FLOATS;
  return {
    x: mesh.vertices[at]!,
    y: mesh.vertices[at + 1]!,
    height: mesh.vertices[at + 2]!,
    material: mesh.vertices[at + 3]!,
    kind: mesh.vertices[at + 5]!
  };
};

describe("buildingDetailMesh", () => {
  it("is deterministic and emits substantial physical architecture", () => {
    const building = spec();
    const a = buildingDetailMesh([building], PPM);
    const b = buildingDetailMesh([building], PPM);

    expect(b.vertices).toEqual(a.vertices);
    expect(b.indices).toEqual(a.indices);
    expect(a.triangleCount).toBeGreaterThan(200);
    expect(a.vertexCount).toBeGreaterThan(400);
    for (const index of a.indices) expect(index).toBeLessThan(a.vertexCount);
    for (let i = 0; i < a.vertexCount; i++) {
      const vertex = vertexAt(a, i);
      expect(vertex.kind).toBe(KIND.DETAIL);
      expect(Number.isFinite(vertex.x)).toBe(true);
      expect(Number.isFinite(vertex.y)).toBe(true);
      expect(Number.isFinite(vertex.height)).toBe(true);
    }
  });

  it("adds projections, rooftop height, and neon structure", () => {
    const building = spec();
    const mesh = buildingDetailMesh([building], PPM);
    const vertices = Array.from({ length: mesh.vertexCount }, (_, i) => vertexAt(mesh, i));
    const neonA = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_A;
    const neonB = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_B;

    expect(vertices.some((v) => v.x < 0 || v.x > 24 * PPM || v.y < 0 || v.y > 18 * PPM)).toBe(
      true
    );
    expect(vertices.some((v) => v.height > building.height)).toBe(true);
    expect(vertices.some((v) => v.material === neonA || v.material === neonB)).toBe(true);
  });

  it("uses the district neon weights for rooftop accents", () => {
    const neonA = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_A;
    const neonB = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_B;
    const mesh = buildingDetailMesh([spec({ neonWeights: [1, 0] })], PPM);
    const neonMaterials = Array.from({ length: mesh.vertexCount }, (_, i) => vertexAt(mesh, i).material)
      .filter((material) => material === neonA || material === neonB);

    expect(neonMaterials.length).toBeGreaterThan(0);
    expect(new Set(neonMaterials)).toEqual(new Set([neonA]));
  });

  it("covers irregular and concave footprints", () => {
    const footprint: Ring = [
      { x: 0, y: 0 },
      { x: 24 * PPM, y: 0 },
      { x: 24 * PPM, y: 7 * PPM },
      { x: 13 * PPM, y: 7 * PPM },
      { x: 13 * PPM, y: 18 * PPM },
      { x: 0, y: 18 * PPM }
    ];
    const mesh = buildingDetailMesh([spec({ footprint })], PPM);

    expect(mesh.triangleCount).toBeGreaterThan(200);
    for (const index of mesh.indices) expect(index).toBeLessThan(mesh.vertexCount);
  });

  it("skips short buildings", () => {
    expect(
      buildingDetailMesh(
        [spec({ height: BUILDING_DETAIL_MIN_HEIGHT_M - 0.01 })],
        PPM
      ).vertexCount
    ).toBe(0);
  });

  it("keeps metre dimensions fixed across a scene regrid", () => {
    const coarse = buildingDetailMesh([spec()], PPM);
    const finePpm = PPM * 2;
    const fine = buildingDetailMesh(
      [
        spec({
          footprint: rectRing({ x: 0, y: 0, width: 24 * finePpm, height: 18 * finePpm })
        })
      ],
      finePpm
    );

    expect(fine.indices).toEqual(coarse.indices);
    expect(fine.vertexCount).toBe(coarse.vertexCount);
    for (let i = 0; i < coarse.vertexCount; i++) {
      const a = vertexAt(coarse, i);
      const b = vertexAt(fine, i);
      expect(b.x / finePpm).toBeCloseTo(a.x / PPM, 5);
      expect(b.y / finePpm).toBeCloseTo(a.y / PPM, 5);
      expect(b.height).toBeCloseTo(a.height, 6);
    }
  });
});
