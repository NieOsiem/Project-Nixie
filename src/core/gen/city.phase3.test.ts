import { describe, expect, it } from "vitest";
import { DISTRICT_TYPE_IDS } from "./district-registry.js";
import {
  normalizeDistrictOpenSpaceOverride,
  validateCitySourceV3,
  validateCityStateV3,
  type CityStateV3,
  type RoadSource
} from "./city.js";
import { rectangleLand } from "./terrain.js";

const terrain = { land: rectangleLand({ x: -100, y: -80, width: 200, height: 160 }), urbanFootprint: null };
const roads: RoadSource = {
  nodes: [
    { id: "n-a", x: -40, y: 0 },
    { id: "n-b", x: 40, y: 0 }
  ],
  routes: [{ id: "r-a", curvePreset: "standard" }],
  edges: [{ id: "e-a", a: "n-a", b: "n-b", routeId: "r-a", classId: "street", name: null, locked: false, origin: "authored" }]
};

const schema3 = (): CityStateV3 => ({
  kind: "city-generator-2",
  schemaVersion: 3,
  generatorVersion: 11,
  revision: 1,
  source: {
    origin: { x: 5000, y: 4000 },
    citySeed: "phase3-model-fixture",
    generation: {
      terrainMode: "rectangle",
      coastEdge: null,
      roadLayout: "mixed",
      hubMode: "multiple-hubs",
      districtPool: [...DISTRICT_TYPE_IDS],
      openSpaceProfile: "medium"
    },
    terrain,
    roads,
    districts: []
  }
});

describe("City Generator 2.0 Phase 3 model", () => {
  it("validates a generator-11 state carrying district defaults", () => {
    const state = schema3();
    expect(state.generatorVersion).toBe(11);
    expect(validateCityStateV3(state)).toEqual([]);
    expect(state.source.generation.districtPool).toEqual(DISTRICT_TYPE_IDS);
    expect(state.source.generation.openSpaceProfile).toBe("medium");
    expect(state.source.districts).toEqual([]);
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
    const source = schema3().source;
    source.districts = [
      { id: "d-a", polygon: [{ x: -80, y: -40 }, { x: 10, y: -40 }, { x: 10, y: 40 }, { x: -80, y: 40 }], seed: "a", typeId: "corporate-core", paletteId: "corporate", origin: "authored", locked: false, openSpaceOverride: null },
      { id: "d-b", polygon: [{ x: -10, y: -40 }, { x: 80, y: -40 }, { x: 80, y: 40 }, { x: -10, y: 40 }], seed: "b", typeId: "night-market", paletteId: "market", origin: "authored", locked: false, openSpaceOverride: null }
    ];
    expect(validateCitySourceV3(source).some((problem) => /overlap/i.test(problem))).toBe(true);
  });

  it("accepts sub-snap slivers between adjacent persisted districts", () => {
    const source = schema3().source;
    source.districts = [
      { id: "d-a", polygon: [{ x: -80, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -80, y: 40 }], seed: "a", typeId: "corporate-core", paletteId: "corporate", origin: "authored", locked: false, openSpaceOverride: null },
      { id: "d-b", polygon: [{ x: 40.0001, y: -40 }, { x: 120, y: -40 }, { x: 120, y: 40 }, { x: 40.0001, y: 40 }], seed: "b", typeId: "night-market", paletteId: "night-market", origin: "authored", locked: false, openSpaceOverride: null }
    ];
    expect(validateCitySourceV3(source)).toEqual([]);
  });
});
