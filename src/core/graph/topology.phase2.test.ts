import { describe, expect, it } from "vitest";
import {
  appendRoute,
  connectRoadPoints,
  deleteEdges,
  deleteJunction,
  moveNode,
  splitEdgeAtPoint,
  validateRouteTopology,
  weldNodes
} from "./topology.js";
import { ROUTE_CLASS_REGISTRY } from "../gen/city.js";
import type { RoadSource } from "../gen/city.js";

const empty = (): RoadSource => ({ nodes: [], routes: [], edges: [] });

const horizontal = (): RoadSource => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 100, y: 0 }
  ],
  routes: [{ id: "route-horizontal", curvePreset: "standard" }],
  edges: [{ id: "edge-horizontal", a: "a", b: "b", routeId: "route-horizontal", classId: "street", name: null, locked: false, origin: "authored" }]
});

const star = (): RoadSource => ({
  nodes: [
    { id: "junction", x: 0, y: 0 },
    { id: "north", x: 0, y: 30 },
    { id: "east", x: 30, y: 0 },
    { id: "south", x: 0, y: -30 },
    { id: "west", x: -30, y: 0 }
  ],
  routes: [{ id: "route-star", curvePreset: "standard" }],
  edges: [
    { id: "edge-north", a: "junction", b: "north", routeId: "route-star", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "edge-east", a: "junction", b: "east", routeId: "route-star", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "edge-south", a: "junction", b: "south", routeId: "route-star", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "edge-west", a: "junction", b: "west", routeId: "route-star", classId: "street", name: null, locked: false, origin: "authored" }
  ]
});

const incident = (source: RoadSource, nodeId: string): number => source.edges.filter((edge) => edge.a === nodeId || edge.b === nodeId).length;

describe("Phase 2 explicit road topology", () => {
  it("connects to an existing segment by splitting it at the clicked metre point", () => {
    const connected = connectRoadPoints(horizontal(), [{ x: 50, y: 0 }, { x: 50, y: 50 }], {
      classId: "street",
      revision: 4,
      sequence: 2
    });
    const splitNode = connected.nodes.find((node) => node.x === 50 && node.y === 0);
    expect(splitNode).toBeDefined();
    expect(incident(connected, splitNode!.id)).toBe(3);
    expect(connected.edges.some((edge) => edge.id === "edge-horizontal")).toBe(true);
    expect(validateRouteTopology(connected).ok).toBe(true);
  });

  it("turns a proper road crossing into one shared at-grade junction", () => {
    const connected = connectRoadPoints(horizontal(), [{ x: 50, y: -50 }, { x: 50, y: 50 }], {
      classId: "arterial",
      revision: 4,
      sequence: 10
    });
    const crossing = connected.nodes.find((node) => Math.abs(node.x - 50) < 1e-9 && Math.abs(node.y) < 1e-9);
    expect(crossing).toBeDefined();
    expect(incident(connected, crossing!.id)).toBe(4);
    expect(connected.edges).toHaveLength(4);
    expect(validateRouteTopology(connected)).toMatchObject({ ok: true });
  });

  it("splits a proper self-crossing into an explicit shared junction", () => {
    const route = appendRoute(empty(), [{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }, { x: 40, y: 0 }], {
      classId: "street",
      revision: 3,
      sequence: 0
    });
    const crossing = route.nodes.find((node) => Math.abs(node.x - 20) < 1e-9 && Math.abs(node.y - 20) < 1e-9);
    expect(crossing).toBeDefined();
    expect(incident(route, crossing!.id)).toBe(4);
    expect(route.edges).toHaveLength(5);
    expect(validateRouteTopology(route)).toMatchObject({ ok: true });
  });

  it("permits an explicit non-orthogonal junction and dead-end geometry", () => {
    const source: RoadSource = {
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "j", x: 20, y: 15 },
        { id: "b", x: 50, y: 15 },
        { id: "c", x: 35, y: 40 }
      ],
      routes: [
        { id: "r1", curvePreset: "standard" },
        { id: "r2", curvePreset: "tight" }
      ],
      edges: [
        { id: "e1", a: "a", b: "j", routeId: "r1", classId: "arterial", name: null, locked: false, origin: "authored" },
        { id: "e2", a: "j", b: "b", routeId: "r1", classId: "arterial", name: null, locked: false, origin: "authored" },
        { id: "e3", a: "j", b: "c", routeId: "r2", classId: "cycleway", name: null, locked: false, origin: "authored" }
      ]
    };
    expect(validateRouteTopology(source)).toMatchObject({ ok: true });
  });

  it("rejects centreline coincidence, self-overlap, and extended corridor overlap", () => {
    const coincident: RoadSource = {
      nodes: [
        { id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 },
        { id: "c", x: 10, y: 0 }, { id: "d", x: 90, y: 0 }
      ],
      routes: [{ id: "r1", curvePreset: "standard" }, { id: "r2", curvePreset: "standard" }],
      edges: [
        { id: "e1", a: "a", b: "b", routeId: "r1", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e2", a: "c", b: "d", routeId: "r2", classId: "street", name: null, locked: false, origin: "authored" }
      ]
    };
    expect(validateRouteTopology(coincident).ok).toBe(false);

    const extendedCorridor: RoadSource = {
      nodes: [
        { id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 },
        { id: "c", x: 0, y: 10 }, { id: "d", x: 100, y: 10 }
      ],
      routes: [{ id: "r1", curvePreset: "standard" }, { id: "r2", curvePreset: "standard" }],
      edges: [
        { id: "e1", a: "a", b: "b", routeId: "r1", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e2", a: "c", b: "d", routeId: "r2", classId: "street", name: null, locked: false, origin: "authored" }
      ]
    };
    expect(validateRouteTopology(extendedCorridor).ok).toBe(false);
  });

  it("keeps IDs stable through a split and move", () => {
    const first = splitEdgeAtPoint(horizontal(), "edge-horizontal", { x: 25, y: 0 }, { revision: 9, sequence: 4 });
    const second = splitEdgeAtPoint(horizontal(), "edge-horizontal", { x: 25, y: 0 }, { revision: 9, sequence: 4 });
    expect(first).toEqual(second);
    expect(first.source.edges.find((edge) => edge.id === "edge-horizontal")?.a).toBe("a");
    expect(first.source.edges.find((edge) => edge.id === "edge-horizontal")?.b).toBe(first.nodeId);
    const moved = moveNode(first.source, first.nodeId, { x: 30, y: 1 }, { toleranceM: 0 });
    expect(moved.edges.map((edge) => edge.id).sort()).toEqual(first.source.edges.map((edge) => edge.id).sort());
    expect(moved.nodes.some((node) => node.id === first.nodeId && node.x === 30 && node.y === 1)).toBe(true);
  });

  it("welds two junctions without changing unrelated edge identity", () => {
    const source: RoadSource = {
      nodes: [
        { id: "left", x: -30, y: 0 }, { id: "j1", x: 0, y: 0 }, { id: "right", x: 30, y: 0 },
        { id: "j2", x: 0, y: 20 }, { id: "north", x: 0, y: 50 }
      ],
      routes: [{ id: "r", curvePreset: "standard" }],
      edges: [
        { id: "e-left", a: "left", b: "j1", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e-right", a: "j1", b: "right", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e-north", a: "j2", b: "north", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" }
      ]
    };
    const welded = weldNodes(source, "j2", "j1");
    expect(welded.nodes.some((node) => node.id === "j2")).toBe(false);
    expect(welded.edges.map((edge) => edge.id).sort()).toEqual(source.edges.map((edge) => edge.id).sort());
    expect(welded.edges.find((edge) => edge.id === "e-north")).toMatchObject({ a: "j1" });
    expect(validateRouteTopology(welded)).toMatchObject({ ok: true });
  });

  it("deletes a junction into separated stubs and prunes only the deleted node", () => {
    const deleted = deleteJunction(star(), "junction", { revision: 8, sequence: 0 });
    expect(deleted.nodes.some((node) => node.id === "junction")).toBe(false);
    expect(deleted.edges).toHaveLength(4);
    const stubs = deleted.edges.map((edge) => edge.a === "north" || edge.a === "east" || edge.a === "south" || edge.a === "west" ? edge.b : edge.a);
    expect(new Set(stubs).size).toBe(4);
    expect(stubs.every((id) => id !== "junction")).toBe(true);
    // Every incident edge is a street, so each stub must clear the street corridor radius plus the
    // source's 0.25 m safety gap from the removed junction.
    const street = ROUTE_CLASS_REGISTRY.get("street")!;
    const stubClearance = street.widthM / 2 + street.sidewalkM + 0.25;
    for (const id of stubs) {
      const point = deleted.nodes.find((node) => node.id === id)!;
      expect(Math.hypot(point.x, point.y)).toBeGreaterThanOrEqual(stubClearance - 1e-9);
    }
    expect(validateRouteTopology(deleted)).toMatchObject({ ok: true });
  });

  it("reports a disconnected vehicle network after deleting a bridge edge", () => {
    const source: RoadSource = {
      nodes: [
        { id: "a", x: 0, y: 0 }, { id: "j", x: 30, y: 0 }, { id: "b", x: 60, y: 0 },
        { id: "k", x: 90, y: 0 }, { id: "c", x: 120, y: 0 }
      ],
      routes: [{ id: "r", curvePreset: "standard" }],
      edges: [
        { id: "e-aj", a: "a", b: "j", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e-jb", a: "j", b: "b", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e-jk", a: "j", b: "k", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "e-kc", a: "k", b: "c", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" }
      ]
    };
    const result = deleteEdges(source, ["e-jk"]);
    expect(result.disconnectedVehicleNetwork).toBe(true);
    expect(result.source.edges.map((edge) => edge.id).sort()).toEqual(["e-aj", "e-jb", "e-kc"]);
    expect(validateRouteTopology(result.source)).toMatchObject({ ok: true });
  });
});
