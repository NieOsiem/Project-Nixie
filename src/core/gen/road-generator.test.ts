import { describe, expect, it } from "vitest";
import { rectangleLand } from "./terrain.js";
import { generateInitialRoadNetwork } from "./road-generator.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { validateRouteTopology } from "../graph/topology.js";

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
});

