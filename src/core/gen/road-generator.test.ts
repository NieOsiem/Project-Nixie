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

function distToRing(point: Vec2, ring: Ring): number {
  let nearest = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const c = ring[index]!;
    const d = ring[(index + 1) % ring.length]!;
    const abx = d.x - c.x;
    const aby = d.y - c.y;
    const t = Math.max(0, Math.min(1, ((point.x - c.x) * abx + (point.y - c.y) * aby) / (abx * abx + aby * aby || 1)));
    nearest = Math.min(nearest, Math.hypot(point.x - (c.x + abx * t), point.y - (c.y + aby * t)));
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
        const clearance = routeClass.widthM / 2 + routeClass.sidewalkM + 2;
        for (const looseId of [edge.a, edge.b] as const) {
          if (degree.get(looseId) !== 1) continue;
          const loose = nodeById.get(looseId)!;
          expect(Math.min(...sites.map((site) => distToRing(loose, site)))).toBeGreaterThan(clearance);
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

