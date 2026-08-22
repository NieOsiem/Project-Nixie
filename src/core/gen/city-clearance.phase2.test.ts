import { describe, expect, it } from "vitest";
import { intersection } from "../geom/boolean.js";
import { rectRing, ringArea, type MultiPolygon, type Rect } from "../geom/types.js";
import { citySurfaces } from "./city-chunk.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV2 } from "./city.js";

const SCENE: Rect = { x: 0, y: 0, width: 100, height: 100 };
const SOURCE: CitySourceV2 = {
  origin: { x: 0, y: 0 },
  citySeed: "phase2-clearance-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
  terrain: { land: rectRing(SCENE), urbanFootprint: null },
  roads: {
    nodes: [
      { id: "road-a", x: 20, y: 50 },
      { id: "road-b", x: 80, y: 50 },
      { id: "path-a", x: 20, y: 25 },
      { id: "path-b", x: 80, y: 25 }
    ],
    routes: [
      { id: "road-route", curvePreset: "standard" },
      { id: "path-route", curvePreset: "standard" }
    ],
    edges: [
      { id: "road", a: "road-a", b: "road-b", routeId: "road-route", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "path", a: "path-a", b: "path-b", routeId: "path-route", classId: "cycleway", name: null, locked: false, origin: "authored" }
    ]
  }
};

function area(multi: MultiPolygon): number {
  return multi.reduce((sum, polygon) => sum + polygon.reduce((part, ring, index) => part + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0), 0);
}

describe("Phase 2 route clearance partition", () => {
  it("subtracts the complete paved corridor, including both sidewalks, from exposed land", () => {
    const surfaces = citySurfaces(SOURCE, SCENE);
    const carriageway = area(surfaces.vehicleCarriageway);
    const sidewalk = area(surfaces.vehicleSidewalk);
    const street = ROUTE_CLASS_REGISTRY.get("street")!;
    const length = 80 - 20;
    // The corridor core is a widthM-wide carriageway quad flanked by sidewalkM strips, so both
    // surfaces must cover at least their rectangular cores; each terminal node contributes a disc
    // cap, at most a half-disc beyond the quad, so the surfaces stay under core + full-disc caps.
    expect(carriageway).toBeGreaterThan(length * street.widthM);
    expect(carriageway).toBeLessThan(length * street.widthM + Math.PI * (street.widthM / 2) ** 2);
    expect(sidewalk).toBeGreaterThan(length * 2 * street.sidewalkM);
    expect(sidewalk).toBeLessThan(length * 2 * street.sidewalkM + Math.PI * (street.widthM / 2 + street.sidewalkM) ** 2);
    expect(area(intersection(surfaces.exposedLand, surfaces.vehicleCarriageway))).toBeCloseTo(0, 4);
    expect(area(intersection(surfaces.exposedLand, surfaces.vehicleSidewalk))).toBeCloseTo(0, 4);
    expect(area(intersection(surfaces.exposedLand, surfaces.nonVehicleRoute))).toBeCloseTo(0, 4);
  });

  it("keeps non-vehicle route occupancy in the shared partition and clear of vehicle pavement", () => {
    const surfaces = citySurfaces(SOURCE, SCENE);
    const cycleway = ROUTE_CLASS_REGISTRY.get("cycleway")!;
    expect(area(surfaces.nonVehicleRoute)).toBeGreaterThan((80 - 20) * cycleway.widthM);
    expect(area(intersection(surfaces.nonVehicleRoute, surfaces.vehicleCarriageway))).toBeCloseTo(0, 4);
    expect(area(intersection(surfaces.nonVehicleRoute, surfaces.vehicleSidewalk))).toBeCloseTo(0, 4);
  });
});
