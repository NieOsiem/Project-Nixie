import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, type MultiPolygon, type Rect } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import { buildCityChunks, citySurfaces } from "./city-chunk.js";
import { type CitySourceV2, type RoadSource } from "./city.js";
import { generateInitialRoadNetwork } from "./road-generator.js";
import { rectangleLand } from "./terrain.js";

const SCENE: Rect = { x: -128, y: -64, width: 256, height: 128 };
const KEYS = [{ cx: -1, cy: -1 }, { cx: 0, cy: -1 }, { cx: -1, cy: 0 }, { cx: 0, cy: 0 }];
const SOURCE: CitySourceV2 = {
  origin: { x: 0, y: 0 },
  citySeed: "phase2-chunk-seam-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
  terrain: { land: rectRing(SCENE), urbanFootprint: null },
  roads: {
    nodes: [
      { id: "west", x: -128, y: 0 },
      { id: "east", x: 128, y: 0 }
    ],
    routes: [{ id: "route", curvePreset: "standard" }],
    edges: [{ id: "edge", a: "west", b: "east", routeId: "route", classId: "street", name: null, locked: false, origin: "authored" }]
  }
};

const JUNCTION_SOURCE: CitySourceV2 = {
  ...SOURCE,
  citySeed: "phase2-marking-material-fixture",
  roads: {
    nodes: [
      { id: "centre", x: 0, y: 0 },
      { id: "north", x: 0, y: 64 },
      { id: "east", x: 64, y: 0 },
      { id: "south", x: 0, y: -64 },
      { id: "west", x: -64, y: 0 }
    ],
    routes: [{ id: "junction-route", curvePreset: "standard" }],
    edges: [
      { id: "north-arm", a: "centre", b: "north", routeId: "junction-route", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "east-arm", a: "centre", b: "east", routeId: "junction-route", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "south-arm", a: "centre", b: "south", routeId: "junction-route", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "west-arm", a: "centre", b: "west", routeId: "junction-route", classId: "street", name: null, locked: false, origin: "authored" }
    ]
  }
};

function area(multi: MultiPolygon): number {
  return multi.reduce((sum, polygon) => sum + polygon.reduce((part, ring, index) => part + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0), 0);
}

describe("Phase 2 city chunk determinism", () => {
  it("rebuilds a generated source after a serialized delete/undo round trip", () => {
    const scene = { x: -128, y: -128, width: 256, height: 256 };
    const land = rectangleLand(scene);
    const roads = generateInitialRoadNetwork({
      citySeed: "seed-0",
      mask: land,
      land,
      layout: "european",
      hubMode: "multiple-hubs",
      sceneBounds: scene
    }).roads;
    const restoredRoads = JSON.parse(JSON.stringify(roads)) as RoadSource;
    const source: CitySourceV2 = {
      origin: { x: 0, y: 0 },
      citySeed: "seed-0",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "multiple-hubs" },
      terrain: { land, urbanFootprint: null },
      roads: restoredRoads
    };
    expect(() => buildCityChunks(source, [{ cx: 0, cy: 0 }], scene, 1)).not.toThrow();
  });

  it("keeps lane, crossing, and kerb materials separate above a junction", () => {
    const build = buildCityChunks(JUNCTION_SOURCE, [{ cx: -1, cy: -1 }, { cx: 0, cy: 0 }], SCENE, 1).chunks[1]!;
    const materials = new Set<number>();
    for (let i = 0; i < build.mesh.vertexCount; i++) materials.add(build.mesh.vertices[i * 11 + 3]!);
    expect(materials.has(MATERIAL.LANE_MARK)).toBe(true);
    expect(materials.has(MATERIAL.CROSSING)).toBe(true);
    expect(materials.has(MATERIAL.KERB)).toBe(true);
    expect(build.surfaces.crossings.length).toBeGreaterThan(0);
    expect(build.surfaces.kerbs.length).toBeGreaterThan(0);
  });

  it("keeps route dash geometry continuous at every 128 m seam", () => {
    const whole = citySurfaces(SOURCE, SCENE).markings;
    const builds = buildCityChunks(SOURCE, KEYS, SCENE, 1).chunks;
    for (const build of builds) {
      const expected = intersection(whole, ringAsMulti(rectRing(build.boundsM)));
      expect(area(build.surfaces.markings)).toBeCloseTo(area(expected), 5);
    }
    expect(builds.reduce((sum, build) => sum + area(build.surfaces.markings), 0)).toBeCloseTo(area(whole), 5);
  });

  it("matches a batched full build with equivalent per-chunk rebuilds after an edit", () => {
    const edited: CitySourceV2 = {
      ...SOURCE,
      roads: {
        ...SOURCE.roads,
        nodes: SOURCE.roads.nodes.map((node) => node.id === "east" ? { ...node, y: 20 } : { ...node })
      }
    };
    const batch = buildCityChunks(edited, KEYS, SCENE, 1).chunks;
    const perChunk = KEYS.map((key) => buildCityChunks(edited, [key], SCENE, 1).chunks[0]!);
    expect(batch.map((chunk) => chunk.id)).toEqual(perChunk.map((chunk) => chunk.id));
    for (let i = 0; i < batch.length; i++) {
      expect(batch[i]!.surfaces).toEqual(perChunk[i]!.surfaces);
      expect(batch[i]!.mesh.vertices).toEqual(perChunk[i]!.mesh.vertices);
      expect(batch[i]!.mesh.indices).toEqual(perChunk[i]!.mesh.indices);
    }
  });
});
