import { describe, expect, it } from "vitest";
import { compileRouteNetwork } from "../graph/compiler.js";
import { validateRouteTopology } from "../graph/topology.js";
import { rectRing, type Ring, type Vec2 } from "../geom/types.js";
import { coastalLand, rectangleLand } from "./terrain.js";
import { ROUTE_CLASS_REGISTRY, type RoadLayout, type RoadSource } from "./city.js";
import { generateInitialRoadNetwork } from "./road-generator.js";

const SCENE = { x: -100, y: -80, width: 200, height: 160 };
const RECT = rectangleLand(SCENE);
const COASTAL = coastalLand(SCENE, "phase2-coastal-fixture", "north");
const CONCAVE: Ring = [
  { x: -100, y: -80 },
  { x: 100, y: -80 },
  { x: 100, y: 80 },
  { x: 20, y: 80 },
  { x: 20, y: 0 },
  { x: -100, y: 0 }
];
const FOOTPRINT = rectRing({ x: -60, y: -50, width: 120, height: 90 });

const pointInRing = (point: Vec2, ring: Ring): boolean => {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (Math.abs((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) <= 1e-3 && point.x >= Math.min(a.x, b.x) - 1e-3 && point.x <= Math.max(a.x, b.x) + 1e-3 && point.y >= Math.min(a.y, b.y) - 1e-3 && point.y <= Math.max(a.y, b.y) + 1e-3) return true;
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
};

const pointInOrOnRing = (point: Vec2, ring: Ring): boolean => {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) <= 1e-3 && point.x >= Math.min(a.x, b.x) - 1e-3 && point.x <= Math.max(a.x, b.x) + 1e-3 && point.y >= Math.min(a.y, b.y) - 1e-3 && point.y <= Math.max(a.y, b.y) + 1e-3) return true;
  }
  return pointInRing(point, ring);
};

const insideVisibleScene = (point: Vec2): boolean => point.x >= SCENE.x - 1e-6 && point.x <= SCENE.x + SCENE.width + 1e-6 && point.y >= SCENE.y - 1e-6 && point.y <= SCENE.y + SCENE.height + 1e-6;

function allCorridorSamples(source: RoadSource): Vec2[] {
  const samples: Vec2[] = [];
  const network = compileRouteNetwork(source);
  for (const span of network.segments) {
    const cls = ROUTE_CLASS_REGISTRY.get(span.classId as Parameters<typeof ROUTE_CLASS_REGISTRY.get>[0])!;
    const length = Math.hypot(span.b.x - span.a.x, span.b.y - span.a.y);
    const nx = (-(span.b.y - span.a.y) / length) * (cls.widthM / 2 + cls.sidewalkM);
    const ny = ((span.b.x - span.a.x) / length) * (cls.widthM / 2 + cls.sidewalkM);
    for (const t of [0, 0.5, 1]) {
      const centre = { x: span.a.x + (span.b.x - span.a.x) * t, y: span.a.y + (span.b.y - span.a.y) * t };
      samples.push(centre, { x: centre.x + nx, y: centre.y + ny }, { x: centre.x - nx, y: centre.y - ny });
    }
    expect(cls.widthM).toBeGreaterThan(0);
  }
  return samples;
}

function input(seed: string, layout: RoadLayout, mask: Ring, land: Ring = mask, hubMode: "single-centre" | "multiple-hubs" = "single-centre") {
  return { citySeed: seed, mask, land, layout, hubMode, sceneBounds: SCENE } as const;
}

function hasMultiAnchorRoute(source: RoadSource): boolean {
  return source.routes.some((route) => source.edges.filter((edge) => edge.routeId === route.id).length >= 2);
}

function vehicleConnectivity(source: RoadSource, hubs: string[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of source.edges) {
    if (!ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) continue;
    for (const node of [edge.a, edge.b]) {
      if (!adjacency.has(node)) adjacency.set(node, []);
      adjacency.get(node)!.push(edge.a === node ? edge.b : edge.a);
    }
  }
  if (hubs.length === 0) return false;
  const seen = new Set([hubs[0]!]);
  const queue = [hubs[0]!];
  for (let i = 0; i < queue.length; i++) {
    for (const neighbour of adjacency.get(queue[i]!) ?? []) {
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
  }
  return hubs.every((hub) => seen.has(hub));
}

describe("Phase 2 deterministic initial road generation", () => {
  it("is deterministic for every layout and changes topology for a different seed", () => {
    for (const layout of ["european", "grid", "mixed"] as const) {
      const first = generateInitialRoadNetwork(input("phase2-generator-fixture", layout, RECT));
      const second = generateInitialRoadNetwork(input("phase2-generator-fixture", layout, RECT));
      expect(second).toEqual(first);
      expect(first.roads.edges.length).toBeGreaterThan(0);
      const allIds = [...first.roads.nodes, ...first.roads.routes, ...first.roads.edges].map((item) => item.id);
      expect(new Set(allIds).size).toBe(allIds.length);
      expect(validateRouteTopology(first.roads)).toMatchObject({ ok: true });
      const different = generateInitialRoadNetwork(input("phase2-generator-other-seed", layout, RECT));
      expect(different.roads).not.toEqual(first.roads);
    }
  });

  it("keeps European roads hierarchical, multi-anchored, and capable of dead ends", () => {
    const generated = generateInitialRoadNetwork(input("phase2-european-fixture", "european", RECT)).roads;
    const network = compileRouteNetwork(generated);
    expect(network.segments.some((span) => Math.abs(span.b.x - span.a.x) > 0.001 && Math.abs(span.b.y - span.a.y) > 0.001)).toBe(true);
    const classes = new Set(generated.edges.map((edge) => edge.classId));
    expect(classes.size).toBeGreaterThanOrEqual(3);
    expect(classes.has("narrow")).toBe(true);
    const degree = new Map<string, number>();
    for (const edge of generated.edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    expect([...degree.values()].some((value) => value === 1)).toBe(true);
    expect(hasMultiAnchorRoute(generated)).toBe(true);
    expect(validateRouteTopology(generated)).toMatchObject({ ok: true });
  });

  it("generates a recognisable grid with explicit junction nodes", () => {
    const generated = generateInitialRoadNetwork(input("phase2-grid-fixture", "grid", RECT)).roads;
    const network = compileRouteNetwork(generated);
    const axisAligned = network.segments.filter((span) => Math.abs(span.a.x - span.b.x) < 1e-9 || Math.abs(span.a.y - span.b.y) < 1e-9);
    expect(axisAligned.length).toBeGreaterThan(4);
    expect([...new Set(generated.nodes.map((node) => node.id))].some((id) => generated.edges.filter((edge) => edge.a === id || edge.b === id).length >= 4)).toBe(true);
    expect(network.junctions.some((junction) => junction.arms.length >= 4)).toBe(true);
  });

  it("combines an irregular skeleton and a local grid in Mixed layout", () => {
    const generated = generateInitialRoadNetwork(input("phase2-mixed-fixture", "mixed", RECT)).roads;
    const network = compileRouteNetwork(generated);
    expect(network.segments.some((span) => Math.abs(span.a.x - span.b.x) < 1e-9 || Math.abs(span.a.y - span.b.y) < 1e-9)).toBe(true);
    expect(network.segments.some((span) => Math.abs(span.a.x - span.b.x) > 0.001 && Math.abs(span.a.y - span.b.y) > 0.001)).toBe(true);
    expect(validateRouteTopology(generated)).toMatchObject({ ok: true });
  });

  it("creates a bounded hierarchy for the default rectangle fixture", () => {
    const generated = generateInitialRoadNetwork(input("nixie-2", "european", RECT)).roads;
    const network = compileRouteNetwork(generated);
    const classes = new Set(generated.edges.map((edge) => edge.classId));
    expect(generated.edges.length).toBeGreaterThan(12);
    expect(generated.edges.length).toBeLessThan(160);
    expect(network.junctions.filter((junction) => junction.arms.length >= 3).length).toBeGreaterThanOrEqual(2);
    expect(hasMultiAnchorRoute(generated)).toBe(true);
    expect(classes.has("arterial")).toBe(true);
    expect(classes.has("street")).toBe(true);
    expect(validateRouteTopology(generated)).toMatchObject({ ok: true });
  });

  it("keeps the default coastal fixture populated, deterministic, and bounded", () => {
    const mask = coastalLand(SCENE, "nixie-2", "north");
    const first = generateInitialRoadNetwork(input("nixie-2", "european", mask)).roads;
    const second = generateInitialRoadNetwork(input("nixie-2", "european", mask)).roads;
    const network = compileRouteNetwork(first);
    const classes = new Set(first.edges.map((edge) => edge.classId));
    expect(second).toEqual(first);
    expect(first.edges.length).toBeGreaterThan(8);
    expect(first.edges.length).toBeLessThan(160);
    expect(network.junctions.filter((junction) => junction.arms.length >= 3).length).toBeGreaterThanOrEqual(2);
    expect((["street", "narrow", "lane", "alley"] as const).some((classId) => classes.has(classId))).toBe(true);
    expect(hasMultiAnchorRoute(first)).toBe(true);
    expect(validateRouteTopology(first)).toMatchObject({ ok: true });
  });

  it("keeps Mixed structurally distinct from Grid while retaining irregular roads", () => {
    const mixed = generateInitialRoadNetwork(input("nixie-2", "mixed", RECT)).roads;
    const grid = generateInitialRoadNetwork(input("nixie-2", "grid", RECT)).roads;
    const mixedNetwork = compileRouteNetwork(mixed);
    const classes = new Set(mixed.edges.map((edge) => edge.classId));
    expect(mixed.edges.length).not.toBe(grid.edges.length);
    expect(mixedNetwork.segments.some((span) => Math.abs(span.a.x - span.b.x) > 0.001 && Math.abs(span.a.y - span.b.y) > 0.001)).toBe(true);
    expect(classes.has("arterial")).toBe(true);
    expect(mixedNetwork.junctions.length).toBeGreaterThanOrEqual(2);
    expect(validateRouteTopology(mixed)).toMatchObject({ ok: true });
  });

  it("supports deterministic hubs that stay on the vehicle network", () => {
    const generated = generateInitialRoadNetwork(input("phase2-hubs-fixture", "european", RECT, RECT, "multiple-hubs"));
    expect(generated.diagnostics.hubs.length).toBeGreaterThan(0);
    expect(generated.diagnostics.hubs.every((id) => generated.roads.nodes.some((node) => node.id === id))).toBe(true);
    expect(vehicleConnectivity(generated.roads, generated.diagnostics.hubs)).toBe(true);
    expect(validateRouteTopology(generated.roads)).toMatchObject({ ok: true });
    const again = generateInitialRoadNetwork(input("phase2-hubs-fixture", "european", RECT, RECT, "multiple-hubs"));
    expect(again).toEqual(generated);
  });

  it("produces a dense connected big-city network", () => {
    const big = rectRing({ x: 0, y: 0, width: 1200, height: 800 });
    for (const layout of ["european", "grid", "mixed"] as const) {
      const generated = generateInitialRoadNetwork({ citySeed: `phase2-big-${layout}`, mask: big, land: big, layout, hubMode: "single-centre", sceneBounds: { x: 0, y: 0, width: 1200, height: 800 } });
      const roads = generated.roads;
      const E = roads.edges.length;
      const N = roads.nodes.length;
      const blocks = Math.max(0, E - N + 1);
      const degrees = new Map<string, number>();
      const classes = new Set(roads.edges.map((edge) => edge.classId));
      for (const edge of roads.edges) {
        degrees.set(edge.a, (degrees.get(edge.a) ?? 0) + 1);
        degrees.set(edge.b, (degrees.get(edge.b) ?? 0) + 1);
      }
      const deadEnds = [...degrees.values()].filter((d) => d === 1).length;
      expect(classes.has("arterial"), layout).toBe(true);
      expect(classes.has("street"), layout).toBe(true);
      if (layout === "grid") {
        expect(classes.has("lane") || classes.has("alley"), layout).toBe(true);
      } else {
        expect(classes.has("narrow"), layout).toBe(true);
      }
      expect(E, layout).toBeGreaterThanOrEqual(150);
      expect(blocks, layout).toBeGreaterThanOrEqual(20);
      expect(deadEnds / E, layout).toBeLessThanOrEqual(0.25);
      expect(vehicleConnectivity(roads, generated.diagnostics.hubs), layout).toBe(true);
      expect(validateRouteTopology(roads), layout).toMatchObject({ ok: true });
    }
  });

  it("stays inside rectangular, coastal, concave, and footprint masks with full clear corridors", () => {
    const fixtures: Array<[string, Ring, Ring]> = [
      ["rectangular", RECT, RECT],
      ["coastal", COASTAL, COASTAL],
      ["concave", CONCAVE, RECT],
      ["footprint", FOOTPRINT, RECT]
    ];
    for (const [name, mask, land] of fixtures) {
      const generated = generateInitialRoadNetwork(input(`phase2-mask-${name}`, "european", mask, land)).roads;
      expect(generated.edges.length, name).toBeGreaterThan(0);
      expect(validateRouteTopology(generated), name).toMatchObject({ ok: true });
      for (const point of allCorridorSamples(generated)) {
        if (!insideVisibleScene(point)) continue;
        expect(pointInOrOnRing(point, mask), `${name} mask at ${point.x},${point.y}`).toBe(true);
        expect(pointInOrOnRing(point, land), `${name} land at ${point.x},${point.y}`).toBe(true);
      }
    }
  });

  it("regenerates the coastal multiple-hub seed inside the active mask", () => {
    const mask = coastalLand(SCENE, "seed-0", "north");
    const input = { citySeed: "4", mask, land: mask, layout: "european" as const, hubMode: "multiple-hubs" as const, sceneBounds: SCENE };
    const first = generateInitialRoadNetwork(input);
    expect(first.roads.edges.length).toBeGreaterThan(0);
    expect(validateRouteTopology(first.roads)).toMatchObject({ ok: true });
    expect(generateInitialRoadNetwork(input)).toEqual(first);
  });

  it("retains a connected hub for grid multiple-hubs", () => {
    const generated = generateInitialRoadNetwork(input("24", "grid", RECT, RECT, "multiple-hubs"));
    const vehicleNodes = new Set(generated.roads.edges
      .filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle)
      .flatMap((edge) => [edge.a, edge.b]));
    expect(generated.diagnostics.hubs.length).toBeGreaterThan(0);
    expect(generated.diagnostics.hubs.every((id) => vehicleNodes.has(id))).toBe(true);
    expect(validateRouteTopology(generated.roads)).toMatchObject({ ok: true });
  });
});
