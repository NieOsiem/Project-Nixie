import { describe, expect, it } from "vitest";
import type { BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, type Ring } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT } from "../palette.js";
import {
  BUILDING_DETAIL_MIN_HEIGHT_M,
  buildingDetailMesh,
  facadeEntryPrisms,
  prismMesh,
  resolveArchitecturalTypology,
  type DetailPrism
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

const frontedSpec = (over: Partial<BuildingSpec> = {}): BuildingSpec =>
  spec({
    detailedMassing: false,
    frontage: { angleRad: 0, outward: { x: 0, y: -1 } },
    primaryFrontage: true,
    facadeEntryOnly: true,
    neonEnabled: true,
    ...over
  });

const prismBounds = (prisms: DetailPrism[]) => ({
  minX: Math.min(...prisms.flatMap((prism) => prism.footprint.map((point) => point.x))),
  maxX: Math.max(...prisms.flatMap((prism) => prism.footprint.map((point) => point.x))),
  minY: Math.min(...prisms.flatMap((prism) => prism.footprint.map((point) => point.y))),
  maxY: Math.max(...prisms.flatMap((prism) => prism.footprint.map((point) => point.y))),
  minHeight: Math.min(...prisms.map((prism) => prism.baseHeight)),
  maxHeight: Math.max(...prisms.map((prism) => prism.topHeight))
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
    expect(a.triangleCount).toBeGreaterThan(150);
    expect(a.vertexCount).toBeGreaterThan(300);
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
    // Neon accents only exist on market/entertainment roofs with neon enabled;
    // opt in explicitly so the semantic accent path, not a generic default, drives it.
    const building = spec({ facadeProfile: "shopfront", neonEnabled: true });
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
    const mesh = buildingDetailMesh(
      [spec({ facadeProfile: "shopfront", neonEnabled: true, neonWeights: [1, 0] })],
      PPM
    );
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

    expect(mesh.triangleCount).toBeGreaterThan(100);
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

  it("classifies architectural typology from facadeProfile, roofline, and wear", () => {
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "office-grid" }))).toBe("corporate");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "glass-curtain", roofline: "crown" }))).toBe("corporate");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "residential-balcony" }))).toBe("residential");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "industrial-panel" }))).toBe("industrial");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "warehouse-ribs", roofline: "sawtooth" }))).toBe("industrial");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "shopfront" }))).toBe("market");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "entertainment-arcade" }))).toBe("market");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "civic-columns" }))).toBe("civic");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "civic-columns", roofline: "domed" }))).toBe("civic");
    expect(resolveArchitecturalTypology(spec({ wear: 0.8 }))).toBe("derelict");
    expect(resolveArchitecturalTypology(spec({ facadeProfile: "derelict-shack" }))).toBe("derelict");
  });

  it("generates distinct physical architecture across different facade profiles", () => {
    const corporate = buildingDetailMesh([spec({ facadeProfile: "office-grid", roofline: "crown" })], PPM);
    const residential = buildingDetailMesh([spec({ facadeProfile: "residential-balcony", roofline: "terrace" })], PPM);
    const industrial = buildingDetailMesh([spec({ facadeProfile: "industrial-panel", roofline: "sawtooth" })], PPM);
    const market = buildingDetailMesh([spec({ facadeProfile: "shopfront", roofline: "flat" })], PPM);
    const civic = buildingDetailMesh([spec({ facadeProfile: "civic-columns", roofline: "crown" })], PPM);
    const derelict = buildingDetailMesh([spec({ wear: 0.85 })], PPM);

    const vertexCounts = [
      corporate.vertexCount,
      residential.vertexCount,
      industrial.vertexCount,
      market.vertexCount,
      civic.vertexCount,
      derelict.vertexCount
    ];

    // Every profile generates substantial geometry
    for (const count of vertexCounts) {
      expect(count).toBeGreaterThan(100);
    }

    // Profiles differ materially in geometry
    expect(corporate.vertices).not.toEqual(residential.vertices);
    expect(residential.vertices).not.toEqual(industrial.vertices);
    expect(industrial.vertices).not.toEqual(market.vertices);
    expect(market.vertices).not.toEqual(civic.vertices);
    expect(civic.vertices).not.toEqual(derelict.vertices);
  });

  it("suppresses neon accent materials when neonEnabled is false", () => {
    const neonA = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_A;
    const neonB = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_B;

    const noNeon = buildingDetailMesh([spec({ facadeProfile: "shopfront", neonEnabled: false })], PPM);

    const noNeonMaterials = Array.from({ length: noNeon.vertexCount }, (_, i) => vertexAt(noNeon, i).material);
    expect(noNeonMaterials.some((m) => m === neonA || m === neonB)).toBe(false);
  });

  it("keeps all rooftop structures contained inside building horizontal bounds", () => {
    const profiles = [
      { facadeProfile: "office-grid", roofline: "crown" },
      { facadeProfile: "residential-balcony", roofline: "terrace" },
      { facadeProfile: "industrial-panel", roofline: "sawtooth" },
      { facadeProfile: "shopfront", roofline: "flat" },
      { facadeProfile: "civic-columns", roofline: "crown" },
      { wear: 0.9 }
    ];

    for (const profile of profiles) {
      const b = spec(profile);
      const mesh = buildingDetailMesh([b], PPM);
      const bounds = {
        minX: Math.min(...b.footprint.map((p) => p.x)),
        maxX: Math.max(...b.footprint.map((p) => p.x)),
        minY: Math.min(...b.footprint.map((p) => p.y)),
        maxY: Math.max(...b.footprint.map((p) => p.y))
      };

      for (let i = 0; i < mesh.vertexCount; i++) {
        const v = vertexAt(mesh, i);
        if (v.height > b.height) {
          expect(v.x).toBeGreaterThanOrEqual(bounds.minX - 1e-2);
          expect(v.x).toBeLessThanOrEqual(bounds.maxX + 1e-2);
          expect(v.y).toBeGreaterThanOrEqual(bounds.minY - 1e-2);
          expect(v.y).toBeLessThanOrEqual(bounds.maxY + 1e-2);
        }
      }
    }
  });

  it("selects the furthest aligned road wall and builds only on its outward side", () => {
    const building = frontedSpec({
      facadeProfile: "office-grid",
      frontage: { angleRad: 0, outward: { x: 0, y: 1 } }
    });
    const prisms = facadeEntryPrisms(building, PPM);
    const bounds = prismBounds(prisms);

    expect(prisms.length).toBeGreaterThanOrEqual(5);
    expect(bounds.minY).toBeGreaterThanOrEqual(18 * PPM);
    expect(bounds.maxY).toBeLessThanOrEqual((18 + 1.8) * PPM + 1e-3);
    expect(bounds.minX).toBeGreaterThanOrEqual(0.5 * PPM - 1e-3);
    expect(bounds.maxX).toBeLessThanOrEqual(23.5 * PPM + 1e-3);
    expect(bounds.minHeight).toBeGreaterThanOrEqual(0);
    expect(bounds.maxHeight).toBeLessThan(building.height);
  });

  it("keeps facade entries deterministic and metre-scaled across scene regrids", () => {
    const building = frontedSpec({ facadeProfile: "residential-balcony" });
    const first = facadeEntryPrisms(building, PPM);
    const second = facadeEntryPrisms(building, PPM);
    expect(second).toEqual(first);

    const finePpm = PPM * 2;
    const fine = facadeEntryPrisms(
      frontedSpec({
        facadeProfile: "residential-balcony",
        footprint: rectRing({ x: 0, y: 0, width: 24 * finePpm, height: 18 * finePpm })
      }),
      finePpm
    );
    expect(fine.length).toBe(first.length);
    for (let prismIndex = 0; prismIndex < first.length; prismIndex++) {
      const coarsePrism = first[prismIndex]!;
      const finePrism = fine[prismIndex]!;
      expect(finePrism.baseHeight).toBeCloseTo(coarsePrism.baseHeight, 6);
      expect(finePrism.topHeight).toBeCloseTo(coarsePrism.topHeight, 6);
      for (let pointIndex = 0; pointIndex < coarsePrism.footprint.length; pointIndex++) {
        expect(finePrism.footprint[pointIndex]!.x / finePpm)
          .toBeCloseTo(coarsePrism.footprint[pointIndex]!.x / PPM, 6);
        expect(finePrism.footprint[pointIndex]!.y / finePpm)
          .toBeCloseTo(coarsePrism.footprint[pointIndex]!.y / PPM, 6);
      }
    }
  });

  it("uses typology-specific entry dimensions, materials, and geometry families", () => {
    const corporate = facadeEntryPrisms(frontedSpec({ facadeProfile: "office-grid" }), PPM);
    const residential = facadeEntryPrisms(frontedSpec({ facadeProfile: "residential-balcony" }), PPM);
    const industrial = facadeEntryPrisms(frontedSpec({ facadeProfile: "industrial-panel" }), PPM);
    const market = facadeEntryPrisms(frontedSpec({ facadeProfile: "shopfront" }), PPM);
    const derelict = facadeEntryPrisms(frontedSpec({ facadeProfile: "derelict-shack" }), PPM);
    const signature = (prisms: DetailPrism[]): string =>
      prisms.map((prism) => {
        const widthM =
          (Math.max(...prism.footprint.map((point) => point.x)) -
            Math.min(...prism.footprint.map((point) => point.x))) /
          PPM;
        return `${widthM.toFixed(3)}:${prism.baseHeight.toFixed(3)}:${prism.topHeight.toFixed(3)}:${prism.material}`;
      }).join("|");

    expect(new Set([corporate, residential, industrial, market, derelict].map(signature)).size).toBe(5);
    const industrialMaxWidthM =
      (prismBounds(industrial).maxX - prismBounds(industrial).minX) / PPM;
    const residentialMaxWidthM =
      (prismBounds(residential).maxX - prismBounds(residential).minX) / PPM;
    expect(industrialMaxWidthM).toBeGreaterThanOrEqual(5.9);
    expect(residentialMaxWidthM).toBeLessThan(3.2);
    const dark = BANK_SIZE * 2 + DISTRICT_SLOT.WALL_C;
    const widthsForDarkPanels = (prisms: DetailPrism[]): number[] =>
      prisms
        .filter((prism) => prism.material === dark)
        .map((prism) =>
          (Math.max(...prism.footprint.map((point) => point.x)) -
            Math.min(...prism.footprint.map((point) => point.x))) /
          PPM
        );
    const industrialDoorWidthM = Math.max(...widthsForDarkPanels(industrial));
    const residentialDoorWidthM = Math.max(...widthsForDarkPanels(residential));
    expect(industrialDoorWidthM).toBeGreaterThanOrEqual(4);
    expect(industrialDoorWidthM).toBeLessThanOrEqual(7);
    expect(residentialDoorWidthM).toBeGreaterThanOrEqual(1.5);
    expect(residentialDoorWidthM).toBeLessThanOrEqual(2.5);
    expect(widthsForDarkPanels(market).length).toBeGreaterThanOrEqual(2);
    expect(widthsForDarkPanels(market).length).toBeLessThanOrEqual(4);

    const neonA = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_A;
    const neonB = BANK_SIZE * 2 + DISTRICT_SLOT.NEON_B;
    expect(market.some((prism) => prism.material === neonA || prism.material === neonB)).toBe(true);
    for (const family of [corporate, residential, industrial, market, derelict]) {
      const bounds = prismBounds(family);
      expect(bounds.minY).toBeGreaterThanOrEqual(-1.8 * PPM - 1e-3);
      expect(bounds.maxY).toBeLessThanOrEqual(0);
      expect(bounds.minHeight).toBeGreaterThanOrEqual(0);
      expect(bounds.maxHeight).toBeLessThan(52);
    }
    expect(derelict.some((prism) => prism.material === neonA || prism.material === neonB)).toBe(false);
  });

  it("suppresses null, elevated, unaligned, short-edge, and non-primary entries", () => {
    expect(facadeEntryPrisms(frontedSpec({ frontage: null }), PPM)).toEqual([]);
    expect(facadeEntryPrisms(frontedSpec({ baseHeight: 0.51 }), PPM)).toEqual([]);
    expect(facadeEntryPrisms(frontedSpec({ primaryFrontage: false }), PPM)).toEqual([]);
    expect(
      facadeEntryPrisms(
        frontedSpec({ frontage: { angleRad: Math.PI / 4, outward: { x: 0, y: -1 } } }),
        PPM
      )
    ).toEqual([]);
    expect(
      facadeEntryPrisms(
        frontedSpec({
          facadeProfile: "office-grid",
          footprint: rectRing({ x: 0, y: 0, width: 3.8 * PPM, height: 12 * PPM })
        }),
        PPM
      )
    ).toEqual([]);
  });

  it("emits one primary entry when several masses share a building frontage", () => {
    const primary = frontedSpec({ height: 8, seed: 0.31 });
    const secondary = frontedSpec({ height: 8, seed: 0.73, primaryFrontage: false });
    const one = buildingDetailMesh([primary], PPM);
    const stacked = buildingDetailMesh([primary, secondary], PPM);

    expect(stacked.vertices).toEqual(one.vertices);
    expect(stacked.indices).toEqual(one.indices);
    expect(one.vertexCount).toBeGreaterThan(0);
    for (let vertexIndex = 0; vertexIndex < one.vertexCount; vertexIndex++) {
      expect(vertexAt(one, vertexIndex).kind).toBe(KIND.DETAIL);
    }
  });
});
