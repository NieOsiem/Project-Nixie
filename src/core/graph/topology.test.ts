import { describe, expect, it } from "vitest";
import { compileRouteNetwork } from "./compiler.js";
import { connectRoadPoints, deleteJunction, validateRouteTopology } from "./topology.js";
import type { RoadSource } from "../gen/city.js";

const empty: RoadSource = { nodes: [], routes: [], edges: [] };

describe("road topology edits", () => {
  it("connects a chain and splits an existing segment", () => {
    const first = connectRoadPoints(empty, [{ x: 0, y: 0 }, { x: 20, y: 0 }], { classId: "street", revision: 1 });
    const second = connectRoadPoints(first, [{ x: 10, y: -10 }, { x: 10, y: 10 }], { classId: "street", revision: 2 });
    expect(second.nodes).toHaveLength(5);
    expect(second.edges.length).toBe(4);
    expect(validateRouteTopology(second, compileRouteNetwork(second)).ok).toBe(true);
  });

  it("deletes a junction into separated stubs", () => {
    const connected = connectRoadPoints(empty, [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], { classId: "street", revision: 1 });
    const junction = connected.nodes.find((node) => Math.abs(node.x) < 0.01)!;
    const deleted = deleteJunction(connected, junction.id);
    expect(deleted.nodes.some((node) => Math.abs(node.x) < 0.01)).toBe(false);
    expect(validateRouteTopology(deleted).ok).toBe(true);
  });
});

