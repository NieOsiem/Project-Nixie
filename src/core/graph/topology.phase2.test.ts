import { describe, expect, it } from "vitest";
import {
  analyzeRouteConflicts,
  appendRoute,
  applyBuildingRouteSurgery,
  connectRoadPoints,
  deleteEdges,
  deleteJunction,
  moveNode,
  RouteSurgeryError,
  splitEdgeAtPoint,
  validateRouteTopology,
  weldNodes
} from "./topology.js";
import { ROUTE_CLASS_REGISTRY } from "../gen/city.js";
import type { RoadSource } from "../gen/city.js";
import type { MultiPolygon } from "../geom/types.js";

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

const box = (minX: number, minY: number, maxX: number, maxY: number): MultiPolygon => [
  [[{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]]
];

const bend = (): RoadSource => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 50, y: 0 },
    { id: "c", x: 50, y: 50 }
  ],
  routes: [{ id: "route-bend", curvePreset: "standard" }],
  edges: [
    { id: "e1", a: "a", b: "b", routeId: "route-bend", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "e2", a: "b", b: "c", routeId: "route-bend", classId: "street", name: null, locked: false, origin: "authored" }
  ]
});

const chain = (lockedFirst: boolean): RoadSource => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 50, y: 0 },
    { id: "c", x: 100, y: 0 }
  ],
  routes: [{ id: "route-chain", curvePreset: "standard" }],
  edges: [
    { id: "e1", a: "a", b: "b", routeId: "route-chain", classId: "street", name: null, locked: lockedFirst, origin: "authored" },
    { id: "e2", a: "b", b: "c", routeId: "route-chain", classId: "street", name: null, locked: false, origin: "authored" }
  ]
});

const tripleChain = (): RoadSource => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 40, y: 0 },
    { id: "c", x: 80, y: 0 },
    { id: "d", x: 120, y: 0 }
  ],
  routes: [{ id: "route-triple", curvePreset: "standard" }],
  edges: [
    { id: "e1", a: "a", b: "b", routeId: "route-triple", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "e2", a: "b", b: "c", routeId: "route-triple", classId: "street", name: null, locked: false, origin: "authored" },
    { id: "e3", a: "c", b: "d", routeId: "route-triple", classId: "street", name: null, locked: false, origin: "authored" }
  ]
});

const blockersOf = (run: () => unknown): { id: string; kind: string; reason: string }[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof RouteSurgeryError) return error.blockers;
    throw error;
  }
  throw new Error("Expected route surgery to reject the edit.");
};

describe("Phase 6 building route surgery", () => {
  it("enumerates edge-level conflicts with exact blocked arc ranges", () => {
    const conflicts = analyzeRouteConflicts(horizontal(), box(40, -4, 60, 4));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ edgeId: "edge-horizontal", kind: "road", processable: true });
    expect(conflicts[0]!.blockedArcM).toHaveLength(1);
    expect(conflicts[0]!.blockedArcM[0]!.startM).toBeCloseTo(39.99, 1);
    expect(conflicts[0]!.blockedArcM[0]!.endM).toBeCloseTo(60.01, 1);
  });

  it("trims a straight edge at deterministic occupancy bounds and keeps outside fragments", () => {
    const source = horizontal();
    const result = applyBuildingRouteSurgery(source, box(40, -4, 60, 4));
    expect(result.trimmedEdgeIds).toEqual(["edge-horizontal"]);
    expect(result.removedEdgeIds).toEqual([]);
    expect(result.source.edges).toHaveLength(2);
    const west = result.source.edges.find((edge) => edge.a === "a")!;
    const east = result.source.edges.find((edge) => edge.b === "b")!;
    expect(west).toBeDefined();
    expect(east).toBeDefined();
    const westEnd = result.source.nodes.find((node) => node.id === west.b)!;
    const eastStart = result.source.nodes.find((node) => node.id === east.a)!;
    // WHY: The end-cap disc retreats past the occupied wall at x=40/60 by its own radius (6m).
    expect(westEnd.x).toBeCloseTo(34, 1);
    expect(eastStart.x).toBeCloseTo(66, 1);
    expect(result.source.edges.every((edge) => edge.classId === "street")).toBe(true);
    // The gap severs the street into two vehicle components — a warning, not a rejection.
    expect(result.disconnectedVehicleNetwork).toBe(true);
    expect(JSON.stringify(source)).toBe(JSON.stringify(horizontal()));
  });

  it("removes a curved edge whole when its fragment is not source-representable", () => {
    const source = bend();
    const result = applyBuildingRouteSurgery(source, box(46, 26, 54, 34));
    expect(result.removedEdgeIds).toEqual(["e2"]);
    expect(result.trimmedEdgeIds).toEqual([]);
    expect(result.source.edges.map((edge) => edge.id)).toEqual(["e1"]);
    expect(result.source.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
    expect(result.disconnectedVehicleNetwork).toBe(false);
    expect(JSON.stringify(source)).toBe(JSON.stringify(bend()));
  });

  it("rejects surgery on a locked edge with a blocker and leaves the source untouched", () => {
    const source = horizontal();
    source.edges[0]!.locked = true;
    const before = JSON.stringify(source);
    const blockers = blockersOf(() => applyBuildingRouteSurgery(source, box(40, -4, 60, 4)));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ id: "edge-horizontal", kind: "road" });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("rejects surgery that would bend a locked adjacent edge through a neighbour trim", () => {
    const source = chain(true);
    const blockers = blockersOf(() => applyBuildingRouteSurgery(source, box(70, -4, 80, 4)));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ id: "e1", kind: "road" });
    expect(JSON.stringify(source)).toBe(JSON.stringify(chain(true)));
  });

  it("prunes the orphaned junction after the star centre is occupied", () => {
    const source = star();
    const result = applyBuildingRouteSurgery(source, box(-5, -5, 5, 5));
    expect(result.source.nodes.map((node) => node.id)).not.toContain("junction");
    expect(result.source.nodes).toHaveLength(8);
    expect(result.source.edges).toHaveLength(4);
    const north = result.source.edges.find((edge) => edge.b === "north")!;
    const cut = result.source.nodes.find((node) => node.id === north.a)!;
    expect(cut.y).toBeCloseTo(11, 1);
    expect(result.trimmedEdgeIds).toEqual(["edge-east", "edge-north", "edge-south", "edge-west"]);
    expect(result.removedEdgeIds).toEqual([]);
    expect(result.disconnectedVehicleNetwork).toBe(true);
    expect(JSON.stringify(source)).toBe(JSON.stringify(star()));
  });

  it("removes a fully occupied bridge edge and warns about the severed vehicle network", () => {
    const source = tripleChain();
    const result = applyBuildingRouteSurgery(source, box(30, -4, 90, 4));
    expect(result.removedEdgeIds).toEqual(["e2"]);
    expect(result.trimmedEdgeIds).toEqual(["e1", "e3"]);
    expect(result.source.edges).toHaveLength(2);
    const nodeIds = result.source.nodes.map((node) => node.id);
    const edgeNodeIds = new Set(result.source.edges.flatMap((edge) => [edge.a, edge.b]));
    // The fully occupied bridge edge goes whole while e1/e3 are trimmed in place: their
    // outer anchors survive and each gains a cut endpoint, and the old interior junctions
    // b/c become orphaned and are pruned.
    expect(nodeIds).toContain("a");
    expect(nodeIds).toContain("d");
    expect(nodeIds).not.toContain("b");
    expect(nodeIds).not.toContain("c");
    // Every surviving edge endpoint resolves to a real node, and no node is left orphaned.
    expect([...edgeNodeIds].every((id) => nodeIds.includes(id))).toBe(true);
    expect(nodeIds.every((id) => edgeNodeIds.has(id))).toBe(true);
    // The two trim endpoints land on the surviving fragments, outside the occupied region.
    const trimEndpoints = result.source.nodes.filter((node) => node.id !== "a" && node.id !== "d");
    expect(trimEndpoints).toHaveLength(2);
    const trimXs = trimEndpoints.map((node) => node.x).sort((x, y) => x - y);
    expect(trimXs[0]).toBeCloseTo(24, 1);
    expect(trimXs[1]).toBeCloseTo(96, 1);
    expect(trimEndpoints.every((node) => node.x < 30 || node.x > 90)).toBe(true);
    expect(result.disconnectedVehicleNetwork).toBe(true);
    expect(JSON.stringify(source)).toBe(JSON.stringify(tripleChain()));
  });

  it("replays deterministically for identical input", () => {
    const first = applyBuildingRouteSurgery(star(), box(-5, -5, 5, 5));
    const second = applyBuildingRouteSurgery(star(), box(-5, -5, 5, 5));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("treats empty and distant occupied areas as no-ops", () => {
    const emptyResult = applyBuildingRouteSurgery(horizontal(), []);
    expect(emptyResult.source).toEqual(horizontal());
    expect(emptyResult.conflicts).toEqual([]);
    expect(emptyResult.trimmedEdgeIds).toEqual([]);
    expect(emptyResult.removedEdgeIds).toEqual([]);
    expect(emptyResult.disconnectedVehicleNetwork).toBe(false);
    const distantResult = applyBuildingRouteSurgery(horizontal(), box(200, -5, 210, 5));
    expect(distantResult.source).toEqual(horizontal());
    expect(distantResult.conflicts).toEqual([]);
    expect(distantResult.trimmedEdgeIds).toEqual([]);
    expect(distantResult.removedEdgeIds).toEqual([]);
    expect(distantResult.disconnectedVehicleNetwork).toBe(false);
    expect(analyzeRouteConflicts(horizontal(), [])).toEqual([]);
  });
});
