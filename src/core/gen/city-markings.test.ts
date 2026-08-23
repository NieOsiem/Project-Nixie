import { describe, expect, it } from "vitest";
import { compileRouteNetwork } from "../graph/compiler.js";
import { ringArea, ringCentroid, type MultiPolygon, type Rect, type Ring } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV2, type RoadSource } from "./city.js";
import { buildCityChunks, citySurfaces } from "./city-chunk.js";
import { buildCityMarkings, type CityMarkingParts } from "./city-markings.js";
import { rectangleLand } from "./terrain.js";

const area = (multi: MultiPolygon): number =>
  multi.reduce(
    (sum, polygon) =>
      sum + polygon.reduce((part, ring, index) => part + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0),
    0
  );

const dressingKeys: readonly (keyof CityMarkingParts)[] = [
  "gutters",
  "curbHighlights",
  "drains",
  "repairs",
  "repairHighlights"
];

function parallelRoads(count = 12): RoadSource {
  const nodes = [];
  const routes = [];
  const edges = [];
  for (let index = 0; index < count; index++) {
    nodes.push(
      { id: `a-${index}`, x: -240, y: index * 20 },
      { id: `b-${index}`, x: 240, y: index * 20 }
    );
    routes.push({ id: `route-${index}`, curvePreset: "standard" as const });
    edges.push({
      id: `edge-${index}`,
      a: `a-${index}`,
      b: `b-${index}`,
      routeId: `route-${index}`,
      classId: "street" as const,
      name: null,
      locked: false,
      origin: "authored" as const
    });
  }
  return { nodes, routes, edges };
}

const JUNCTION_ROADS: RoadSource = {
  nodes: [
    { id: "centre", x: 0, y: 0 },
    { id: "west", x: -120, y: 0 },
    { id: "east", x: 120, y: 0 },
    { id: "north", x: 0, y: -120 },
    { id: "south", x: 0, y: 120 }
  ],
  routes: [
    { id: "west-east", curvePreset: "standard" },
    { id: "north-south", curvePreset: "standard" }
  ],
  edges: [
    { id: "west", a: "west", b: "centre", routeId: "west-east", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "east", a: "centre", b: "east", routeId: "west-east", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "north", a: "north", b: "centre", routeId: "north-south", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "south", a: "centre", b: "south", routeId: "north-south", classId: "street", name: null, locked: false, origin: "authored" }
  ]
};

function rings(multi: MultiPolygon): Ring[] {
  return multi.flatMap((polygon) => polygon);
}


describe("topology-free city street dressing", () => {
  it("is deterministic, leaves the compiled network untouched, and emits every sparse tier", () => {
    const network = compileRouteNetwork(parallelRoads(), ROUTE_CLASS_REGISTRY);
    const before = structuredClone(network);
    const first = buildCityMarkings(network);
    const second = buildCityMarkings(network);

    expect(second).toEqual(first);
    expect(network).toEqual(before);
    expect(area(first.gutters)).toBeGreaterThan(0);
    expect(area(first.curbHighlights)).toBeGreaterThan(0);
    expect(area(first.drains)).toBeGreaterThan(0);
    expect(area(first.repairs)).toBeGreaterThan(0);
    expect(area(first.repairHighlights)).toBeGreaterThan(0);
  });

  it("keeps gutters, curb lines, drains, and repairs clear of the junction fan", () => {
    const markings = buildCityMarkings(compileRouteNetwork(JUNCTION_ROADS, ROUTE_CLASS_REGISTRY));
    for (const key of dressingKeys) {
      for (const point of rings(markings[key]).flat()) {
        expect(Math.hypot(point.x, point.y), `${key} point at ${point.x},${point.y}`).toBeGreaterThan(7);
      }
    }
    expect(area(markings.drains)).toBeGreaterThan(0);
    const drainRings = rings(markings.drains);
    const approachDrains = drainRings.filter((ring) => {
      const centre = ringCentroid(ring);
      return Math.hypot(centre.x, centre.y) < 30;
    });
    expect(approachDrains.length).toBeGreaterThan(drainRings.length * 0.3);
  });

  it("keeps dressing widths and simple patch dimensions in their metre-space bands", () => {
    const markings = buildCityMarkings(compileRouteNetwork(parallelRoads(1), ROUTE_CLASS_REGISTRY));
    const gutter = rings(markings.gutters)[0]!;
    const curb = rings(markings.curbHighlights)[0]!;
    expect(Math.max(...gutter.map((point) => point.y)) - Math.min(...gutter.map((point) => point.y))).toBeCloseTo(0.4, 6);
    expect(Math.max(...curb.map((point) => point.y)) - Math.min(...curb.map((point) => point.y))).toBeCloseTo(0.1, 6);

    for (const ring of [...rings(markings.repairs), ...rings(markings.repairHighlights)]) {
      const width = Math.max(...ring.map((point) => point.y)) - Math.min(...ring.map((point) => point.y));
      const length = Math.max(...ring.map((point) => point.x)) - Math.min(...ring.map((point) => point.x));
      expect(length).toBeGreaterThanOrEqual(3);
      expect(length).toBeLessThanOrEqual(10.7);
      expect(width).toBeGreaterThanOrEqual(1.2);
      expect(width).toBeLessThanOrEqual(4.5);
    }
  });

  it("clips every dressing tier with exact aggregate ownership at chunk seams", () => {
    const scene: Rect = { x: -256, y: -64, width: 512, height: 128 };
    const source: CitySourceV2 = {
      origin: { x: 0, y: 0 },
      citySeed: "street-dressing-seams",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre" },
      terrain: { land: rectangleLand(scene), urbanFootprint: null },
      roads: parallelRoads(1)
    };
    const keys = [-2, -1, 0, 1].flatMap((cx) => [-1, 0].map((cy) => ({ cx, cy })));
    const chunks = buildCityChunks(source, keys, scene, 1).chunks.map((chunk) => chunk.surfaces);
    const whole = citySurfaces(source, scene);

    for (const key of dressingKeys) {
      const combined = chunks.flatMap((chunk) => chunk[key]);
      expect(area(combined), key).toBeCloseTo(area(whole[key]), 5);
    }
  });
});
