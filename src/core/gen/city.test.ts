import { describe, expect, it } from "vitest";
import {
  ROUTE_CLASSES,
  validateCityStateV3,
  validateRoadSource,
  type CityStateV3
} from "./city.js";
import { DISTRICT_TYPE_IDS } from "./district-registry.js";
import { rectangleLand } from "./terrain.js";

function state(generatorVersion: number, revision = 1): CityStateV3 {
  return {
    kind: "city-generator-2",
    schemaVersion: 3,
    generatorVersion: generatorVersion as CityStateV3["generatorVersion"],
    revision,
    source: {
      origin: { x: 12, y: 34 },
      citySeed: "model-fixture",
      generation: {
        terrainMode: "rectangle",
        coastEdge: null,
        roadLayout: "european",
        hubMode: "single-centre",
        districtPool: [...DISTRICT_TYPE_IDS],
        openSpaceProfile: "medium"
      },
      terrain: { land: rectangleLand({ x: 0, y: 0, width: 100, height: 80 }), urbanFootprint: null },
      roads: { nodes: [], routes: [], edges: [] },
      districts: []
    }
  };
}

describe("City Generator 2.0 generator-11 model", () => {
  it("keeps schema 3 with generator 11 as the current literal state", () => {
    const current = state(11);
    expect(current.schemaVersion).toBe(3);
    expect(current.generatorVersion).toBe(11);
    expect(validateCityStateV3(current)).toEqual([]);
  });

  it("rejects obsolete generator-10 and future generator-12 states", () => {
    expect(validateCityStateV3(state(10))).toEqual(["Unsupported city generator version."]);
    expect(validateCityStateV3(state(12))).toEqual(["Unsupported city generator version."]);
  });

  it("has the complete stable route-class registry", () => {
    expect(ROUTE_CLASSES.map((routeClass) => routeClass.id)).toEqual([
      "highway", "arterial", "street", "narrow", "lane", "alley", "pedestrian-path", "park-path", "plaza-route", "public-passage", "waterfront-promenade", "cycleway"
    ]);
  });

  it("rejects broken references and malformed fields", () => {
    expect(validateRoadSource({ nodes: [{ id: "a", x: 0, y: 0 }], routes: [{ id: "r", curvePreset: "standard" }], edges: [{ id: "e", a: "a", b: "b", routeId: "r", classId: "street", name: 1, locked: false, origin: "authored" }] })).toEqual(expect.arrayContaining([expect.stringContaining("unknown node"), expect.stringContaining("name")]));
  });
});
