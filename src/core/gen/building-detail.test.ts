import { describe, expect, it } from "vitest";
import type { BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, type Ring } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT } from "../palette.js";
import {
  BUILDING_DETAIL_MIN_HEIGHT_M,
  buildingDetailMesh,
  prismMesh
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
    shade: mesh.vertices[at + 4]!,
    kind: mesh.vertices[at + 5]!,
    u: mesh.vertices[at + 6]!,
    top: mesh.vertices[at + 7]!
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

  it("encodes rotated prism caps in the prism's local frame", () => {
    const centre = { x: 180, y: -75 };
    const angle = 0.73;
    const along = { x: Math.cos(angle), y: Math.sin(angle) };
    const across = { x: -along.y, y: along.x };
    const halfU = 64;
    const halfV = 21;
    const corner = (u: number, v: number) => ({
      x: centre.x + along.x * u * halfU + across.x * v * halfV,
      y: centre.y + along.y * u * halfU + across.y * v * halfV
    });
    const mesh = prismMesh({
      footprint: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
      baseHeight: 50,
      topHeight: 53,
      material: 4,
      seed: 0.4
    });

    const cap = Array.from({ length: 4 }, (_, index) => vertexAt(mesh, index));
    expect(cap.every((vertex) => Math.abs(vertex.u) === 1)).toBe(true);
    expect(cap.every((vertex) => Math.abs(vertex.top) === 1)).toBe(true);
    expect(new Set(cap.map((vertex) => `${vertex.u},${vertex.top}`)).size).toBe(4);
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

  it("adds bounded rooftop utility prisms only when the rate is set", () => {
    const plain = buildingDetailMesh([spec()], PPM);
    const withUtilities = buildingDetailMesh([spec({ rooftopUtilityRate: 1 })], PPM);
    const delta = withUtilities.triangleCount - plain.triangleCount;
    // Each 10-triangle utility box adds 20 vertices: at least one box, capped at three.
    expect(delta).toBeGreaterThanOrEqual(10);
    expect(delta).toBeLessThanOrEqual(30);
    expect(withUtilities.vertexCount - plain.vertexCount).toBe(delta * 2);
  });

  it("keeps the added utility boxes on the roof, inside the building's horizontal bounds", () => {
    const building = spec({ rooftopUtilityRate: 1 });
    const plain = buildingDetailMesh([spec()], PPM);
    const withUtilities = buildingDetailMesh([building], PPM);
    const bounds = {
      minX: Math.min(...building.footprint.map((p) => p.x)),
      maxX: Math.max(...building.footprint.map((p) => p.x)),
      minY: Math.min(...building.footprint.map((p) => p.y)),
      maxY: Math.max(...building.footprint.map((p) => p.y))
    };
    // Utility prisms append last, so the tail of the buffer is exactly the new boxes.
    const utilityStart = plain.vertexCount * VERTEX_FLOATS;
    for (let i = utilityStart; i < withUtilities.vertices.length; i += VERTEX_FLOATS) {
      const v = vertexAt(withUtilities, i / VERTEX_FLOATS);
      expect(v.height).toBeGreaterThan(building.height);
      expect(v.height).toBeLessThanOrEqual(building.height + 5);
      expect(v.x).toBeGreaterThanOrEqual(bounds.minX - 1e-3);
      expect(v.x).toBeLessThanOrEqual(bounds.maxX + 1e-3);
      expect(v.y).toBeGreaterThanOrEqual(bounds.minY - 1e-3);
      expect(v.y).toBeLessThanOrEqual(bounds.maxY + 1e-3);
    }
  });

  it("leaves the detail tier unchanged when the rate is zero or absent", () => {
    const absent = buildingDetailMesh([spec()], PPM);
    const zero = buildingDetailMesh([spec({ rooftopUtilityRate: 0 })], PPM);
    expect([...zero.vertices]).toEqual([...absent.vertices]);
    expect(zero.triangleCount).toBe(absent.triangleCount);
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
