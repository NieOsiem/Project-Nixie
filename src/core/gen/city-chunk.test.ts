import { describe, expect, it } from "vitest";
import { intersection } from "../geom/boolean.js";
import { ringArea, type MultiPolygon, type Rect } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import {
  buildCityChunks,
  citySurfaces,
  setCityChunkCompileObserver,
  type CitySurfacePartitions
} from "./city-chunk.js";
import type { CitySourceV2 } from "./city.js";
import { rectangleLand } from "./terrain.js";

const SCENE: Rect = { x: -128, y: -128, width: 256, height: 256 };
const SOURCE: CitySourceV2 = {
  origin: { x: 1000, y: 800 },
  citySeed: "city-chunk-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
  terrain: { land: rectangleLand(SCENE), urbanFootprint: null },
  roads: {
    nodes: [
      { id: "west", x: -128, y: 0 },
      { id: "east", x: 128, y: 0 },
      { id: "path-west", x: -128, y: 20 },
      { id: "path-east", x: 128, y: 20 }
    ],
    routes: [
      { id: "road-route", curvePreset: "standard" },
      { id: "path-route", curvePreset: "standard" }
    ],
    edges: [
      { id: "road", a: "west", b: "east", routeId: "road-route", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "path", a: "path-west", b: "path-east", routeId: "path-route", classId: "cycleway", name: null, locked: false, origin: "authored" }
    ]
  }
};

function area(multi: MultiPolygon): number {
  return multi.reduce((sum, polygon) => sum + polygon.reduce((part, ring, index) => part + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0), 0);
}

function combine(chunks: CitySurfacePartitions[]): CitySurfacePartitions {
  return {
    water: chunks.flatMap((chunk) => chunk.water),
    exposedLand: chunks.flatMap((chunk) => chunk.exposedLand),
    vehicleCarriageway: chunks.flatMap((chunk) => chunk.vehicleCarriageway),
    vehicleSidewalk: chunks.flatMap((chunk) => chunk.vehicleSidewalk),
    nonVehicleRoute: chunks.flatMap((chunk) => chunk.nonVehicleRoute),
    markings: chunks.flatMap((chunk) => chunk.markings),
    laneMarkings: chunks.flatMap((chunk) => chunk.laneMarkings),
    crossings: chunks.flatMap((chunk) => chunk.crossings),
    kerbs: chunks.flatMap((chunk) => chunk.kerbs)
  };
}

describe("city chunk batch", () => {
  it("returns disjoint water, land, carriageway, sidewalk, and route surfaces", () => {
    const whole = citySurfaces(SOURCE, SCENE);
    const occupied = [whole.vehicleCarriageway, whole.vehicleSidewalk, whole.nonVehicleRoute];
    expect(area(whole.water)).toBe(0);
    expect(area(whole.exposedLand) + occupied.reduce((sum, part) => sum + area(part), 0)).toBeCloseTo(area(whole.exposedLand) + area(whole.vehicleCarriageway) + area(whole.vehicleSidewalk) + area(whole.nonVehicleRoute), 6);
    for (let i = 0; i < occupied.length; i++) {
      for (let j = i + 1; j < occupied.length; j++) expect(area(intersection(occupied[i]!, occupied[j]!))).toBeCloseTo(0, 3);
      expect(area(intersection(whole.exposedLand, occupied[i]!))).toBeCloseTo(0, 3);
    }
  });

  it("clips a complete route and its arc-anchored markings at chunk seams", () => {
    const keys = [{ cx: -1, cy: -1 }, { cx: 0, cy: -1 }, { cx: -1, cy: 0 }, { cx: 0, cy: 0 }];
    const builds = buildCityChunks(SOURCE, keys, SCENE, 1).chunks;
    const combined = combine(builds.map((build) => build.surfaces));
    const whole = citySurfaces(SOURCE, SCENE);
    expect(area(combined.markings)).toBeCloseTo(area(whole.markings), 4);
    expect(area(combined.vehicleCarriageway)).toBeCloseTo(area(whole.vehicleCarriageway), 4);
    expect(builds.every((build) => build.mesh.vertices.some(Number.isFinite))).toBe(true);
  });

  it("compiles once for a multi-chunk batch and echoes every requested key", () => {
    let calls = 0;
    setCityChunkCompileObserver(() => calls++);
    try {
      const built = buildCityChunks(SOURCE, [{ cx: -1, cy: 0 }, { cx: 0, cy: 0 }], SCENE, 1);
      expect(calls).toBe(1);
      expect(built.chunks.map((chunk) => chunk.id)).toEqual(["-1,0", "0,0"]);
      expect(built.compiledRoutes).toBe(2);
      expect(built.compiledSegments).toBe(2);
      expect(built.markingTriangleCount).toBe(
        built.chunks.reduce((sum, chunk) => sum + chunk.markingTriangleCount, 0)
      );
    } finally {
      setCityChunkCompileObserver(null);
    }
  });

  it("uses the final shared palette slot for non-vehicle routes", () => {
    const build = buildCityChunks(SOURCE, [{ cx: 0, cy: 0 }], SCENE, 1).chunks[0]!;
    const materials = new Set<number>();
    for (let i = 0; i < build.mesh.vertexCount; i++) materials.add(build.mesh.vertices[i * 11 + 3]!);
    expect(materials.has(MATERIAL.NON_VEHICLE_ROUTE)).toBe(true);
  });
});
