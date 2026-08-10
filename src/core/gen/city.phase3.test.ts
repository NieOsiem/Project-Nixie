import { describe, expect, it } from "vitest";
import { DISTRICT_TYPE_IDS } from "./district-registry.js";
import {
  migrateSchema1ToSchema3,
  migrateSchema2ToSchema3,
  normalizeDistrictOpenSpaceOverride,
  validateCitySourceV3,
  validateCityStateV3,
  type CitySourceV2,
  type LegacyCityStateV1
} from "./city.js";
import { rectangleLand } from "./terrain.js";

const terrain = { land: rectangleLand({ x: -100, y: -80, width: 200, height: 160 }), urbanFootprint: null };
const roads: CitySourceV2["roads"] = {
  nodes: [
    { id: "n-a", x: -40, y: 0 },
    { id: "n-b", x: 40, y: 0 }
  ],
  routes: [{ id: "r-a", curvePreset: "standard" }],
  edges: [{ id: "e-a", a: "n-a", b: "n-b", routeId: "r-a", classId: "street", name: null, locked: false, origin: "authored" }]
};

const schema2 = (): CitySourceV2 => ({
  origin: { x: 5000, y: 4000 },
  citySeed: "phase3-model-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "mixed", hubMode: "multiple-hubs" },
  terrain,
  roads
});

describe("City Generator 2.0 Phase 3 model", () => {
  it("migrates schema 2 directly to schema 3 without changing terrain, roads, IDs, or revision", () => {
    const migrated = migrateSchema2ToSchema3(schema2(), 12);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.generatorVersion).toBe(10);
    expect(migrated.revision).toBe(12);
    expect(migrated.source.origin).toEqual(schema2().origin);
    expect(migrated.source.citySeed).toBe(schema2().citySeed);
    expect(migrated.source.generation).toMatchObject({
      terrainMode: "rectangle",
      coastEdge: null,
      roadLayout: "mixed",
      hubMode: "multiple-hubs",
      openSpaceProfile: "medium"
    });
    expect(migrated.source.generation.districtPool).toEqual(DISTRICT_TYPE_IDS);
    expect(migrated.source.terrain).toEqual(schema2().terrain);
    expect(migrated.source.roads).toEqual(schema2().roads);
    expect(migrated.source.districts).toEqual([]);
    expect(validateCityStateV3(migrated)).toEqual([]);
  });

  it("migrates schema 1 directly with accepted road and Phase 3 defaults", () => {
    const legacy: LegacyCityStateV1 = {
      kind: "city-generator-2",
      schemaVersion: 1,
      generatorVersion: 8,
      revision: 4,
      source: {
        origin: { x: 1, y: 2 },
        citySeed: "legacy-fixture",
        generation: { terrainMode: "rectangle", coastEdge: null },
        terrain
      }
    };
    const migrated = migrateSchema1ToSchema3(legacy);
    expect(migrated.revision).toBe(4);
    expect(migrated.source.roads).toEqual({ nodes: [], routes: [], edges: [] });
    expect(migrated.source.generation.districtPool).toEqual(DISTRICT_TYPE_IDS);
    expect(migrated.source.generation.openSpaceProfile).toBe("medium");
    expect(validateCityStateV3(migrated)).toEqual([]);
  });

  it("normalizes explicit open-space weights while rejecting all-zero tables", () => {
    const normalized = normalizeDistrictOpenSpaceOverride({
      rate: 0.35,
      categoryWeights: { park: 2, plaza: 1, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
      sizeWeights: { pocket: 3, small: 0, large: 0, "whole-block": 0 }
    });
    expect(Object.values(normalized.categoryWeights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(Object.values(normalized.sizeWeights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(() => normalizeDistrictOpenSpaceOverride({
      rate: 0.2,
      categoryWeights: { park: 0, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
      sizeWeights: { pocket: 1, small: 0, large: 0, "whole-block": 0 }
    })).toThrow(/all zero/i);
  });

  it("rejects overlapping persisted district polygons atomically", () => {
    const source = migrateSchema2ToSchema3(schema2(), 1).source;
    source.districts = [
      { id: "d-a", polygon: [{ x: -80, y: -40 }, { x: 10, y: -40 }, { x: 10, y: 40 }, { x: -80, y: 40 }], seed: "a", typeId: "corporate-core", paletteId: "corporate", origin: "authored", locked: false, openSpaceOverride: null },
      { id: "d-b", polygon: [{ x: -10, y: -40 }, { x: 80, y: -40 }, { x: 80, y: 40 }, { x: -10, y: 40 }], seed: "b", typeId: "night-market", paletteId: "market", origin: "authored", locked: false, openSpaceOverride: null }
    ];
    expect(validateCitySourceV3(source).some((problem) => /overlap/i.test(problem))).toBe(true);
  });

  it("accepts sub-snap slivers between adjacent persisted districts", () => {
    const source = migrateSchema2ToSchema3(schema2(), 1).source;
    source.districts = [
      { id: "d-a", polygon: [{ x: -80, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -80, y: 40 }], seed: "a", typeId: "corporate-core", paletteId: "corporate", origin: "authored", locked: false, openSpaceOverride: null },
      { id: "d-b", polygon: [{ x: 40.0001, y: -40 }, { x: 120, y: -40 }, { x: 120, y: 40 }, { x: 40.0001, y: 40 }], seed: "b", typeId: "night-market", paletteId: "night-market", origin: "authored", locked: false, openSpaceOverride: null }
    ];
    expect(validateCitySourceV3(source)).toEqual([]);
  });
});
