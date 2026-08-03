import { describe, expect, it } from "vitest";
import {
  CURVE_CHORD_TOLERANCE_M,
  compileRouteNetwork,
  type CompiledRoute
} from "./compiler.js";
import type { RoadSource } from "../gen/city.js";

const curvedSource: RoadSource = {
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 30, y: 0 },
    { id: "c", x: 30, y: 30 },
    { id: "d", x: 70, y: 30 }
  ],
  routes: [{ id: "route-main", curvePreset: "standard" }],
  edges: [
    { id: "edge-ab", a: "a", b: "b", routeId: "route-main", classId: "street", name: "Main", locked: false, origin: "authored" },
    { id: "edge-bc", a: "b", b: "c", routeId: "route-main", classId: "street", name: "Main", locked: false, origin: "authored" },
    { id: "edge-cd", a: "c", b: "d", routeId: "route-main", classId: "street", name: "Main", locked: false, origin: "authored" }
  ]
};

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

function route(source: RoadSource, preset: "tight" | "standard" | "broad"): CompiledRoute {
  return compileRouteNetwork({ ...source, routes: [{ id: "route-main", curvePreset: preset }] }).routes[0]!;
}

function pointLineDistance(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator));
  return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

describe("Phase 2 canonical route compiler", () => {
  it("keeps explicit endpoints and junction anchors exact", () => {
    const compiled = route(curvedSource, "standard");
    expect(compiled.points[0]).toEqual({ x: 0, y: 0 });
    expect(compiled.points.at(-1)).toEqual({ x: 70, y: 30 });
    expect(compiled.pointNodeIds[0]).toBe("a");
    expect(compiled.pointNodeIds.at(-1)).toBe("d");
    expect(compiled.points.some((point) => point.x === 30 && point.y === 30)).toBe(false);
    expect(compiled.pointNodeIds).toContain("a");
    expect(compiled.pointNodeIds).toContain("d");
  });

  it("uses the same curve engine while presets change only corner radius", () => {
    const tight = route(curvedSource, "tight");
    const standard = route(curvedSource, "standard");
    const broad = route(curvedSource, "broad");
    expect(tight.points[0]).toEqual(standard.points[0]);
    expect(standard.points.at(-1)).toEqual(broad.points.at(-1));
    expect(tight.points).not.toEqual(standard.points);
    expect(standard.points).not.toEqual(broad.points);
    const firstCornerPoint = (compiled: CompiledRoute): { x: number; y: number } => compiled.points.find((point) => point.y > 0)!;
    expect(distance(firstCornerPoint(tight), { x: 30, y: 0 })).toBeLessThan(distance(firstCornerPoint(standard), { x: 30, y: 0 }));
    expect(distance(firstCornerPoint(standard), { x: 30, y: 0 })).toBeLessThan(distance(firstCornerPoint(broad), { x: 30, y: 0 }));
  });

  it("bounds every rounded-corner chord by the documented tolerance", () => {
    const compiled = route(curvedSource, "standard");
    const entryIndex = compiled.points.findIndex((point) => point.x > 0 && point.x < 30 && Math.abs(point.y) < 1e-9);
    const exitIndex = compiled.points.findIndex((point, index) => index > entryIndex && Math.abs(point.x - 30) < 1e-9 && point.y > 0 && point.y < 30);
    expect(entryIndex).toBeGreaterThan(0);
    expect(exitIndex).toBeGreaterThan(entryIndex);
    const entry = compiled.points[entryIndex]!;
    const exit = compiled.points[exitIndex]!;
    const control = { x: 30, y: 0 };
    const count = exitIndex - entryIndex;
    let maxChordError = 0;
    for (let i = 0; i < count; i++) {
      const t0 = i / count;
      const t1 = (i + 1) / count;
      const tm = (t0 + t1) / 2;
      const mt = 1 - tm;
      const curveMid = {
        x: mt * mt * entry.x + 2 * mt * tm * control.x + tm * tm * exit.x,
        y: mt * mt * entry.y + 2 * mt * tm * control.y + tm * tm * exit.y
      };
      maxChordError = Math.max(maxChordError, pointLineDistance(curveMid, compiled.points[entryIndex + i]!, compiled.points[entryIndex + i + 1]!));
    }
    expect(maxChordError).toBeLessThanOrEqual(CURVE_CHORD_TOLERANCE_M + 1e-9);
  });

  it("is independent of source-array order and preserves source lineage", () => {
    const reordered: RoadSource = {
      nodes: [...curvedSource.nodes].reverse(),
      routes: [...curvedSource.routes].reverse(),
      edges: [...curvedSource.edges].reverse()
    };
    const first = compileRouteNetwork(curvedSource);
    const second = compileRouteNetwork(reordered);
    expect(second).toEqual(first);
    const edgeIds = new Set(curvedSource.edges.map((edge) => edge.id));
    const nodeIds = new Set(curvedSource.nodes.map((node) => node.id));
    for (const compiledRoute of first.routes) {
      expect(compiledRoute.id).toBe("route-main");
      expect(compiledRoute.spans.every((span) => span.routeId === "route-main" && edgeIds.has(span.edgeId))).toBe(true);
      expect(compiledRoute.spans.every((span) => nodeIds.has(span.aNodeId) && nodeIds.has(span.bNodeId))).toBe(true);
    }
  });

  it("keeps arc-length offsets continuous across all derived spans", () => {
    const compiled = route(curvedSource, "standard");
    expect(compiled.spans[0]!.startArcM).toBe(0);
    for (let i = 1; i < compiled.spans.length; i++) {
      expect(compiled.spans[i]!.startArcM).toBeCloseTo(compiled.spans[i - 1]!.endArcM, 10);
      expect(compiled.spans[i]!.endArcM).toBeGreaterThan(compiled.spans[i]!.startArcM);
    }
    expect(compiled.spans.at(-1)!.endArcM).toBeCloseTo(compiled.points.slice(1).reduce((sum, point, index) => sum + distance(compiled.points[index]!, point), 0), 10);
    expect(new Set(compiled.spans.map((span) => span.id)).size).toBe(compiled.spans.length);
  });
});
