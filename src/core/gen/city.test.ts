import { describe, expect, it } from "vitest";
import { migrateSchema1ToSchema2, ROUTE_CLASSES, validateCitySourceV2, validateRoadSource, type LegacyCityStateV1 } from "./city.js";
import { rectangleLand } from "./terrain.js";

describe("schema-2 city road source", () => {
  it("keeps the schema-1 source exact while adding empty roads", () => {
    const old: LegacyCityStateV1 = {
      kind: "city-generator-2",
      schemaVersion: 1,
      generatorVersion: 8,
      revision: 7,
      source: {
        origin: { x: 12, y: 34 },
        citySeed: "  alpha ",
        generation: { terrainMode: "rectangle", coastEdge: null },
        terrain: { land: rectangleLand({ x: 0, y: 0, width: 100, height: 80 }), urbanFootprint: null }
      }
    };
    const migrated = migrateSchema1ToSchema2(old);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.generatorVersion).toBe(9);
    expect(migrated.revision).toBe(7);
    expect(migrated.source.origin).toEqual(old.source.origin);
    expect(migrated.source.terrain).toEqual(old.source.terrain);
    expect(migrated.source.roads).toEqual({ nodes: [], routes: [], edges: [] });
    expect(validateCitySourceV2(migrated.source)).toEqual([]);
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

