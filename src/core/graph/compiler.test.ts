import { describe, expect, it } from "vitest";
import { compileRouteNetwork } from "./compiler.js";
import type { RoadSource } from "../gen/city.js";

const source: RoadSource = {
  nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }, { id: "c", x: 10, y: 10 }],
  routes: [{ id: "route", curvePreset: "standard" }],
  edges: [
    { id: "ab", a: "a", b: "b", routeId: "route", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "bc", a: "b", b: "c", routeId: "route", classId: "street", name: null, locked: false, origin: "authored" }
  ]
};

describe("compiled route network", () => {
  it("rounds compatible degree-two corners while preserving endpoints", () => {
    const network = compileRouteNetwork(source);
    const route = network.routes[0]!;
    expect(route.points[0]).toEqual({ x: 0, y: 0 });
    expect(route.points.at(-1)).toEqual({ x: 10, y: 10 });
    expect(route.points.length).toBeGreaterThan(3);
    expect(network.spans.every((span) => span.endArcM > span.startArcM)).toBe(true);
    expect(network.spans.find((span) => span.edgeId === "bc")?.classId).toBe("street");
  });

  it("is independent of source-array order", () => {
    const permuted: RoadSource = { nodes: [...source.nodes].reverse(), routes: [...source.routes], edges: [...source.edges].reverse() };
    expect(compileRouteNetwork(permuted)).toEqual(compileRouteNetwork(source));
  });
});

