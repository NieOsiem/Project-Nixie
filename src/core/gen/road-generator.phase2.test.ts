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


function geometrySignature(source: RoadSource): string[] {
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const point = (id: string): string => {
    const node = nodes.get(id)!;
    return `${Math.round(node.x * 1000) / 1000},${Math.round(node.y * 1000) / 1000}`;
  };
  return source.edges.map((edge) => {
    const ends = [point(edge.a), point(edge.b)].sort();
    return `${edge.classId}:${ends[0]}:${ends[1]}`;
  }).sort();
}


function angleBins(source: RoadSource, binSizeDeg = 10): Set<number> {
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const bins = new Set<number>();
  for (const edge of source.edges) {
    if (!(edge.classId === "arterial" || edge.classId === "street" || edge.classId === "narrow")) continue;
    const a = nodes.get(edge.a)!;
    const b = nodes.get(edge.b)!;
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    while (angle < 0) angle += Math.PI;
    while (angle >= Math.PI) angle -= Math.PI;
    bins.add(Math.round((angle * 180 / Math.PI) / binSizeDeg));
  }
  return bins;
}


function bentRouteCount(source: RoadSource): number {
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const angles = new Map<string, number[]>();
  for (const edge of source.edges) {
    const a = nodes.get(edge.a)!;
    const b = nodes.get(edge.b)!;
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    while (angle < 0) angle += Math.PI;
    while (angle >= Math.PI) angle -= Math.PI;
    if (!angles.has(edge.routeId)) angles.set(edge.routeId, []);
    angles.get(edge.routeId)!.push(angle);
  }
  let count = 0;
  for (const routeAngles of angles.values()) {
    if (routeAngles.length < 2) continue;
    const base = routeAngles[0]!;
    if (routeAngles.some((angle) => {
      const delta = Math.abs(angle - base);
      return Math.min(delta, Math.PI - delta) > 5 * Math.PI / 180;
    })) count++;
  }
  return count;
}

function axisAlignedFraction(source: RoadSource): number {
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  let aligned = 0;
  let total = 0;
  for (const edge of source.edges) {
    if (!ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) continue;
    const a = nodes.get(edge.a)!;
    const b = nodes.get(edge.b)!;
    const angle = Math.abs(Math.atan2(b.y - a.y, b.x - a.x));
    const quarter = Math.PI / 2;
    const fromAxis = Math.min(angle % quarter, quarter - (angle % quarter));
    if (fromAxis <= 2 * Math.PI / 180) aligned++;
    total++;
  }
  return total === 0 ? 1 : aligned / total;
}

function vehicleEdges(source: RoadSource): RoadSource["edges"] {
  return source.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle);
}

function totalVehicleLength(source: RoadSource): number {
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  return vehicleEdges(source).reduce((total, edge) => {
    const a = nodes.get(edge.a)!;
    const b = nodes.get(edge.b)!;
    return total + Math.hypot(b.x - a.x, b.y - a.y);
  }, 0);
}

function largestVehicleComponentEdges(source: RoadSource): number {
  const edges = vehicleEdges(source);
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);
    adjacency.get(edge.a)!.push(edge.b);
    adjacency.get(edge.b)!.push(edge.a);
  }
  const component = new Map<string, number>();
  let next = 0;
  for (const start of adjacency.keys()) {
    if (component.has(start)) continue;
    const queue = [start];
    component.set(start, next);
    for (let i = 0; i < queue.length; i++) {
      for (const neighbour of adjacency.get(queue[i]!) ?? []) {
        if (component.has(neighbour)) continue;
        component.set(neighbour, next);
        queue.push(neighbour);
      }
    }
    next++;
  }
  const counts = new Map<number, number>();
  for (const edge of edges) {
    const id = component.get(edge.a);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function vehicleDegrees(source: RoadSource): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of vehicleEdges(source)) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  return degree;
}

/** Sum the degrees of all real junctions in a neighbourhood-sized radius.
 * A normal crossing scores four; a roundabout or compact market centre can score more,
 * but several unrelated junctions piled into one block produce the large values this guards. */
function maxJunctionClusterLoad(source: RoadSource, radius = 35): number {
  const degree = vehicleDegrees(source);
  const junctions = source.nodes.filter((node) => (degree.get(node.id) ?? 0) >= 3);
  let maximum = 0;
  for (const centre of junctions) {
    let load = 0;
    for (const junction of junctions) {
      if (Math.hypot(junction.x - centre.x, junction.y - centre.y) <= radius) load += degree.get(junction.id) ?? 0;
    }
    maximum = Math.max(maximum, load);
  }
  return maximum;
}


function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 <= 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function centralRoundaboutNodeIds(source: RoadSource, centre: Vec2, minRadius = 16, maxRadius = 20): Set<string> {
  const candidates = new Set(source.nodes
    .filter((node) => {
      const radius = Math.hypot(node.x - centre.x, node.y - centre.y);
      return radius >= minRadius && radius <= maxRadius;
    })
    .map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const edge of source.edges) {
    if (!candidates.has(edge.a) || !candidates.has(edge.b) || !ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) continue;
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);
    adjacency.get(edge.a)!.push(edge.b);
    adjacency.get(edge.b)!.push(edge.a);
  }
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const component = new Set([start]);
    const queue = [start];
    visited.add(start);
    for (let i = 0; i < queue.length; i++) {
      for (const next of adjacency.get(queue[i]!) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        component.add(next);
        queue.push(next);
      }
    }
    if (component.size >= 12 && [...component].every((id) => (adjacency.get(id)?.length ?? 0) === 2)) return component;
  }
  return new Set();
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
      expect(geometrySignature(different.roads), layout).not.toEqual(geometrySignature(first.roads));
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

  it("gives a full-size European city curved arterials, rotated local fabrics, and one irregular market centre", () => {
    const scene = { x: 0, y: 0, width: 1200, height: 800 };
    const mask = rectangleLand(scene);
    const generated = generateInitialRoadNetwork({ citySeed: "phase2-organic-european", mask, land: mask, layout: "european", hubMode: "multiple-hubs", sceneBounds: scene });
    const roads = generated.roads;
    const network = compileRouteNetwork(roads);
    const plazaRoutes = new Set(roads.edges.filter((edge) => edge.classId === "plaza-route").map((edge) => edge.routeId));
    const vehicles = vehicleEdges(roads);
    expect(plazaRoutes.size).toBeLessThanOrEqual(1);
    expect(vehicles.length).toBeGreaterThan(80);
    expect(totalVehicleLength(roads)).toBeGreaterThan(5000);
    expect(largestVehicleComponentEdges(roads)).toBeGreaterThan(vehicles.length * 0.6);
    expect(bentRouteCount(roads)).toBeGreaterThanOrEqual(3);
    expect(angleBins(roads).size).toBeGreaterThanOrEqual(7);
    expect(axisAlignedFraction(roads)).toBeLessThan(0.45);
    expect(network.junctions.some((junction) => junction.arms.length === 3 || junction.arms.length === 5)).toBe(true);
    expect(validateRouteTopology(roads)).toMatchObject({ ok: true });
  }, 120_000);

  it("generates deterministic valid European networks on maps at least 1600 m across", () => {
    const scene = { x: -800, y: -520, width: 1600, height: 1040 };
    const mask = rectangleLand(scene);
    for (const seed of ["large-european-0", "large-european-1", "large-european-2", "large-european-3"]) {
      const request = { citySeed: seed, mask, land: mask, layout: "european" as const, hubMode: "multiple-hubs" as const, sceneBounds: scene };
      const first = generateInitialRoadNetwork(request);
      const second = generateInitialRoadNetwork(request);
      expect(second).toEqual(first);
      expect(first.roads.edges.length, seed).toBeGreaterThan(150);
      expect(first.diagnostics.hubs.length, seed).toBeGreaterThanOrEqual(2);
      expect(vehicleConnectivity(first.roads, first.diagnostics.hubs), seed).toBe(true);
      expect(validateRouteTopology(first.roads), seed).toMatchObject({ ok: true });
    }
  }, 120_000);

  it("does not collapse European or Mixed full-size maps during topology fallback", () => {
    const scene = { x: -600, y: -400, width: 1200, height: 800 };
    const mask = rectangleLand(scene);
    for (const layout of ["european", "mixed"] as const) {
      for (const seed of ["density-floor-0", "density-floor-1", "density-floor-2"]) {
        const generated = generateInitialRoadNetwork({ citySeed: seed, mask, land: mask, layout, hubMode: "multiple-hubs", sceneBounds: scene });
        const vehicles = vehicleEdges(generated.roads);
        expect(vehicles.length, `${layout}/${seed}`).toBeGreaterThan(70);
        expect(totalVehicleLength(generated.roads), `${layout}/${seed}`).toBeGreaterThan(4500);
        expect(largestVehicleComponentEdges(generated.roads), `${layout}/${seed}`).toBeGreaterThan(vehicles.length * 0.55);
        expect(validateRouteTopology(generated.roads), `${layout}/${seed}`).toMatchObject({ ok: true });
      }
    }
  }, 120_000);

  it("keeps organic junctions legible instead of piling a neighbourhood into one knot", () => {
    const scene = { x: -600, y: -400, width: 1200, height: 800 };
    const mask = rectangleLand(scene);
    for (const layout of ["european", "mixed"] as const) {
      for (const seed of ["junction-spacing-1", "junction-spacing-6", "junction-spacing-10", "junction-spacing-17"]) {
        const generated = generateInitialRoadNetwork({ citySeed: seed, mask, land: mask, layout, hubMode: "multiple-hubs", sceneBounds: scene }).roads;
        const degree = vehicleDegrees(generated);
        expect(vehicleEdges(generated).length, `${layout}/${seed}`).toBeGreaterThan(70);
        expect(vehicleEdges(generated).length, `${layout}/${seed}`).toBeLessThan(540);
        expect(Math.max(0, ...degree.values()), `${layout}/${seed}`).toBeLessThanOrEqual(6);
        expect(maxJunctionClusterLoad(generated), `${layout}/${seed}`).toBeLessThanOrEqual(40);
        expect(validateRouteTopology(generated), `${layout}/${seed}`).toMatchObject({ ok: true });
      }
    }
  }, 120_000);

  it("generates a recognisable grid with explicit junction nodes", () => {
    const scene = { x: -300, y: -240, width: 600, height: 480 };
    const mask = rectangleLand(scene);
    const generated = generateInitialRoadNetwork({ citySeed: "phase2-grid-fixture", mask, land: mask, layout: "grid", hubMode: "single-centre", sceneBounds: scene }).roads;
    const network = compileRouteNetwork(generated);
    const axisAligned = network.segments.filter((span) => Math.abs(span.a.x - span.b.x) < 1e-9 || Math.abs(span.a.y - span.b.y) < 1e-9);
    expect(axisAligned.length).toBeGreaterThan(20);
    expect([...new Set(generated.nodes.map((node) => node.id))].some((id) => generated.edges.filter((edge) => edge.a === id || edge.b === id).length >= 4)).toBe(true);
    expect(network.junctions.some((junction) => junction.arms.length >= 4)).toBe(true);
  });

  it("replaces the central Grid crossing with a complete connected roundabout", () => {
    const generated = generateInitialRoadNetwork(input("phase2-grid-roundabout", "grid", RECT)).roads;
    const centre = { x: 0, y: 0 };
    const ring = centralRoundaboutNodeIds(generated, centre);
    const ringEdges = generated.edges.filter((edge) => ring.has(edge.a) && ring.has(edge.b));
    const approaches = generated.edges.filter((edge) => ring.has(edge.a) !== ring.has(edge.b));
    expect(ring.size).toBeGreaterThanOrEqual(24);
    expect(ringEdges.length).toBe(ring.size);
    expect(approaches.length).toBeGreaterThanOrEqual(4);
    const nodes = new Map(generated.nodes.map((node) => [node.id, node]));
    for (const edge of generated.edges.filter((candidate) => ROUTE_CLASS_REGISTRY.get(candidate.classId)?.vehicle)) {
      expect(distanceToSegment(centre, nodes.get(edge.a)!, nodes.get(edge.b)!)).toBeGreaterThan(8);
    }
    expect(validateRouteTopology(generated)).toMatchObject({ ok: true });
  });

  it("combines an irregular skeleton with a connected roundabout and orthogonal core in Mixed layout", () => {
    const generated = generateInitialRoadNetwork(input("phase2-mixed-fixture", "mixed", RECT)).roads;
    const network = compileRouteNetwork(generated);
    const centre = { x: 0, y: 0 };
    const ring = centralRoundaboutNodeIds(generated, centre);
    const approaches = generated.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle && ring.has(edge.a) !== ring.has(edge.b));
    expect(generated.edges.some((edge) => edge.classId === "plaza-route")).toBe(false);
    expect(ring.size).toBeGreaterThanOrEqual(24);
    expect(approaches.length).toBeGreaterThanOrEqual(2);
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

  it("offsets disconnected coastline runs independently", () => {
    const scene = { x: -250, y: -150, width: 500, height: 300 };
    const land: Ring = [
      { x: -250, y: -150 },
      { x: 250, y: -150 },
      { x: 250, y: 150 },
      { x: 170, y: 150 },
      { x: 170, y: 60 },
      { x: 120, y: 60 },
      { x: 120, y: 150 },
      { x: -120, y: 150 },
      { x: -120, y: 60 },
      { x: -170, y: 60 },
      { x: -170, y: 150 },
      { x: -250, y: 150 }
    ];
    for (const layout of ["european", "grid", "mixed"] as const) {
      const generated = generateInitialRoadNetwork({ citySeed: "promenade-runs", mask: land, land, layout, hubMode: "single-centre", sceneBounds: scene }).roads;
      const nodes = new Map(generated.nodes.map((node) => [node.id, node]));
      const midpoints = generated.edges
        .filter((edge) => edge.classId === "waterfront-promenade")
        .map((edge) => {
          const a = nodes.get(edge.a)!;
          const b = nodes.get(edge.b)!;
          return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        });
      expect(midpoints.some((point) => point.x > 100), `${layout} east coast run`).toBe(true);
      expect(midpoints.some((point) => point.x < -100), `${layout} west coast run`).toBe(true);
      expect(validateRouteTopology(generated), layout).toMatchObject({ ok: true });
    }
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
  }, 120_000);

  it("keeps every layout inside rectangular, coastal, concave, and footprint masks", () => {
    const fixtures: Array<[string, Ring, Ring]> = [
      ["rectangular", RECT, RECT],
      ["coastal", COASTAL, COASTAL],
      ["concave", CONCAVE, RECT],
      ["footprint", FOOTPRINT, RECT]
    ];
    for (const layout of ["european", "grid", "mixed"] as const) {
      for (const [name, mask, land] of fixtures) {
        const generated = generateInitialRoadNetwork(input(`phase2-mask-${layout}-${name}`, layout, mask, land)).roads;
        expect(generated.edges.length, `${layout}/${name}`).toBeGreaterThan(0);
        expect(validateRouteTopology(generated), `${layout}/${name}`).toMatchObject({ ok: true });
        for (const point of allCorridorSamples(generated)) {
          if (!insideVisibleScene(point)) continue;
          expect(pointInOrOnRing(point, mask), `${layout}/${name} mask at ${point.x},${point.y}`).toBe(true);
          expect(pointInOrOnRing(point, land), `${layout}/${name} land at ${point.x},${point.y}`).toBe(true);
        }
      }
    }
  });

  it("checks the independent land ring during final compiled-corridor validation", () => {
    const land = rectRing({ x: -70, y: -55, width: 140, height: 105 });
    const generated = generateInitialRoadNetwork(input("phase2-restricted-land", "european", RECT, land)).roads;
    expect(generated.edges.length).toBeGreaterThan(0);
    for (const point of allCorridorSamples(generated)) {
      if (!insideVisibleScene(point)) continue;
      expect(pointInOrOnRing(point, RECT), `mask at ${point.x},${point.y}`).toBe(true);
      expect(pointInOrOnRing(point, land), `land at ${point.x},${point.y}`).toBe(true);
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
