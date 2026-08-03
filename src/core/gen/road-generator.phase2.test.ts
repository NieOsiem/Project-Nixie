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
    if ((a.y > point.y) !== (b.y > point.y)) {
      const atX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < atX) inside = !inside;
    }
  }
  return inside;
};

const pointInOrOnRing = (point: Vec2, ring: Ring): boolean => {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) <= 1e-6 && point.x >= Math.min(a.x, b.x) - 1e-6 && point.x <= Math.max(a.x, b.x) + 1e-6 && point.y >= Math.min(a.y, b.y) - 1e-6 && point.y <= Math.max(a.y, b.y) + 1e-6) return true;
  }
  return pointInRing(point, ring);
};

const insideVisibleScene = (point: Vec2): boolean => point.x >= SCENE.x - 1e-6 && point.x <= SCENE.x + SCENE.width + 1e-6 && point.y >= SCENE.y - 1e-6 && point.y <= SCENE.y + SCENE.height + 1e-6;

function allCorridorSamples(source: RoadSource): Vec2[] {
  const network = compileRouteNetwork(source);
  const samples: Vec2[] = [];
  for (const span of network.segments) {
    const cls = ROUTE_CLASS_REGISTRY.get(span.classId as never)!;
    const dx = span.b.x - span.a.x;
    const dy = span.b.y - span.a.y;
    const length = Math.hypot(dx, dy);
    const nx = length > 0 ? (-dy / length) * span.clearanceM : 0;
    const ny = length > 0 ? (dx / length) * span.clearanceM : 0;
    for (const t of [0, 0.5, 1]) {
      const centre = { x: span.a.x + dx * t, y: span.a.y + dy * t };
      samples.push(centre, { x: centre.x + nx, y: centre.y + ny }, { x: centre.x - nx, y: centre.y - ny });
    }
    expect(cls.widthM).toBeGreaterThan(0);
  }
  return samples;
}

function input(seed: string, layout: RoadLayout, mask: Ring, land: Ring = mask, hubMode: "single-centre" | "multiple-hubs" = "single-centre") {
  return { citySeed: seed, mask, land, layout, hubMode, sceneBounds: SCENE } as const;
}

function hasCompiledTurn(source: RoadSource): boolean {
  return compileRouteNetwork(source).routes.some((route) => route.spans.some((span, index) => {
    const previous = route.spans[index - 1];
    if (!previous) return false;
    const left = { x: previous.b.x - previous.a.x, y: previous.b.y - previous.a.y };
    const right = { x: span.b.x - span.a.x, y: span.b.y - span.a.y };
    const denominator = Math.hypot(left.x, left.y) * Math.hypot(right.x, right.y);
    return denominator > 0 && Math.abs(left.x * right.y - left.y * right.x) / denominator > 0.05;
  }));
}

function hasMultiAnchorRoute(source: RoadSource): boolean {
  return source.routes.some((route) => source.edges.filter((edge) => edge.routeId === route.id).length >= 2);
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

  it("keeps European roads winding, hierarchical, and capable of dead ends", () => {
    const generated = generateInitialRoadNetwork(input("phase2-european-fixture", "european", RECT)).roads;
    const network = compileRouteNetwork(generated);
    expect(network.segments.some((span) => Math.abs(span.b.x - span.a.x) > 0.001 && Math.abs(span.b.y - span.a.y) > 0.001)).toBe(true);
    const classes = new Set(generated.edges.map((edge) => edge.classId));
    expect(classes.size).toBeGreaterThanOrEqual(3);
    expect(classes.has("highway")).toBe(true);
    expect(classes.has("narrow")).toBe(true);
    const degree = new Map<string, number>();
    for (const edge of generated.edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    expect([...degree.values()].some((value) => value === 1)).toBe(true);
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

  it("creates a bounded irregular hierarchy for the default rectangle fixture", () => {
    const generated = generateInitialRoadNetwork(input("nixie-2", "european", RECT)).roads;
    const network = compileRouteNetwork(generated);
    const classes = new Set(generated.edges.map((edge) => edge.classId));
    expect(generated.edges.length).toBeGreaterThan(12);
    expect(generated.edges.length).toBeLessThan(160);
    expect(network.junctions.filter((junction) => junction.arms.length >= 3).length).toBeGreaterThanOrEqual(2);
    expect(hasMultiAnchorRoute(generated)).toBe(true);
    expect(hasCompiledTurn(generated)).toBe(true);
    expect(classes.has("arterial")).toBe(true);
    expect(classes.has("street")).toBe(true);
    expect((["narrow", "lane", "alley"] as const).some((classId) => classes.has(classId))).toBe(true);
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
    expect(hasCompiledTurn(first)).toBe(true);
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

  it("supports multiple deterministic hubs", () => {
    const generated = generateInitialRoadNetwork(input("phase2-hubs-fixture", "european", RECT, RECT, "multiple-hubs"));
    expect(new Set(generated.diagnostics.hubs).size).toBeGreaterThan(1);
    expect(generated.diagnostics.hubs.every((id) => generated.roads.nodes.some((node) => node.id === id))).toBe(true);
    expect(validateRouteTopology(generated.roads)).toMatchObject({ ok: true });
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

  it("retains a connected hub after grid overlap cleanup removes the original hub anchor", () => {
    const generated = generateInitialRoadNetwork(input("24", "grid", RECT, RECT, "multiple-hubs"));
    const vehicleNodes = new Set(generated.roads.edges
      .filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle)
      .flatMap((edge) => [edge.a, edge.b]));
    expect(generated.diagnostics.hubs.length).toBeGreaterThan(0);
    expect(generated.diagnostics.hubs.every((id) => vehicleNodes.has(id))).toBe(true);
    expect(validateRouteTopology(generated.roads)).toMatchObject({ ok: true });
  });
});
