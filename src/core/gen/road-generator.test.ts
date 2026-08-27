import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, type MultiPolygon, type Ring, type Vec2 } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY } from "./city.js";
import { rectangleLand } from "./terrain.js";
import { generateInitialRoadNetwork, type GeneratedRoadNetwork } from "./road-generator.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { validateRouteTopology } from "../graph/topology.js";
import { compiledRouteOccupancy } from "./district-plan.js";

const multiArea = (multi: MultiPolygon): number =>
  multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);

const occupancyOverlap = (roads: GeneratedRoadNetwork["roads"], site: Ring): number =>
  multiArea(intersection(ringAsMulti(site), compiledRouteOccupancy(compileRouteNetwork(roads)).all));

function pointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.x, yi = ring[i]!.y, xj = ring[j]!.x, yj = ring[j]!.y;
    if (yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentCrossesRing(a: Vec2, b: Vec2, ring: Ring): boolean {
  for (let index = 0; index < ring.length; index++) {
    const c = ring[index]!;
    const d = ring[(index + 1) % ring.length]!;
    const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
  }
  return false;
}

/** Mirrors the generator's stub predicate: does the terminal edge's axis enter the site. */
function rayEntersRing(from: Vec2, tip: Vec2, ring: Ring): boolean {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y);
  if (length === 0) return false;
  const far = { x: tip.x + ((tip.x - from.x) / length) * 30, y: tip.y + ((tip.y - from.y) / length) * 30 };
  return pointInRing(tip, ring) || pointInRing(far, ring) || segmentCrossesRing(tip, far, ring);
}

function distToRing(point: Vec2, ring: Ring): number {
  let nearest = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const c = ring[index]!;
    const d = ring[(index + 1) % ring.length]!;
    const t = Math.max(0, Math.min(1, ((point.x - c.x) * (d.x - c.x) + (point.y - c.y) * (d.y - c.y)) / ((d.x - c.x) * (d.x - c.x) + (d.y - c.y) * (d.y - c.y) || 1)));
    nearest = Math.min(nearest, Math.hypot(point.x - (c.x + (d.x - c.x) * t), point.y - (c.y + (d.y - c.y) * t)));
  }
  return nearest;
}

describe("initial road generation", () => {
  const mask = rectangleLand({ x: 0, y: 0, width: 400, height: 300 });
  it("is deterministic and planar for every layout", () => {
    for (const layout of ["european", "grid", "mixed"] as const) {
      const first = generateInitialRoadNetwork({ citySeed: "fixture", mask, layout, hubMode: "multiple-hubs" });
      const second = generateInitialRoadNetwork({ citySeed: "fixture", mask, layout, hubMode: "multiple-hubs" });
      expect(first).toEqual(second);
      expect(first.roads.edges.length).toBeGreaterThan(0);
      expect(validateRouteTopology(first.roads, compileRouteNetwork(first.roads)).ok).toBe(true);
    }
  });

  it("keeps every reserved landmark site road-free", () => {
    const sites = [
      rectRing({ x: 40, y: 40, width: 60, height: 50 }),
      rectRing({ x: 260, y: 180, width: 80, height: 60 })
    ];
    for (const layout of ["european", "grid", "mixed"] as const) {
      const generated = generateInitialRoadNetwork({
        citySeed: "reserved-fixture",
        mask,
        layout,
        hubMode: "single-centre",
        reservedSites: sites
      });
      expect(generated.roads.edges.length).toBeGreaterThan(0);
      for (const site of sites) expect(occupancyOverlap(generated.roads, site)).toBeLessThanOrEqual(1e-6);
      expect(validateRouteTopology(generated.roads, compileRouteNetwork(generated.roads)).ok).toBe(true);
      const nodeById = new Map(generated.roads.nodes.map((node) => [node.id, node]));
      const degree = new Map<string, number>();
      for (const edge of generated.roads.edges) {
        degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
        degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
      }
      for (const edge of generated.roads.edges) {
        const routeClass = ROUTE_CLASS_REGISTRY.get(edge.classId)!;
        // Clip landing band: corridor fitting samples every 2 m behind a 1 m clip margin, so
        // a site-clipped terminal node lands within clearance + 3 of the boundary. Every
        // loose end inside the band must face away from the site — a terminal edge pointing
        // into it is exactly the wall-slam stub the pruner removes.
        const landingBand = routeClass.widthM / 2 + routeClass.sidewalkM + 3;
        for (const looseId of [edge.a, edge.b] as const) {
          if (degree.get(looseId) !== 1) continue;
          const loose = nodeById.get(looseId)!;
          for (const site of sites) {
            if (distToRing(loose, site) > landingBand) continue;
            const inner = nodeById.get(edge.a === looseId ? edge.b : edge.a)!;
            expect(rayEntersRing(inner, loose, site)).toBe(false);
          }
        }
      }
    }
  });

  it("is deterministic with reserved sites", () => {
    const sites = [rectRing({ x: 40, y: 40, width: 60, height: 50 })];
    const first = generateInitialRoadNetwork({ citySeed: "reserved-fixture", mask, reservedSites: sites });
    const second = generateInitialRoadNetwork({ citySeed: "reserved-fixture", mask, reservedSites: sites });
    expect(first).toEqual(second);
  });

  it("matches the no-reservation output when reservedSites is omitted", () => {
    const baseline = generateInitialRoadNetwork({ citySeed: "fixture", mask, layout: "european" });
    const withEmpty = generateInitialRoadNetwork({ citySeed: "fixture", mask, layout: "european", reservedSites: [] });
    expect(withEmpty).toEqual(baseline);
  });
});

