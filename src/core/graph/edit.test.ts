import { describe, expect, it } from "vitest";
import {
  insertRoad,
  mergeNodes,
  moveNode,
  nearestEdge,
  nearestNode,
  projectOnSegment,
  pruneOrphanNodes,
  removeRoad,
  snapToGraph,
  toggleSidewalks
} from "./edit.js";
import { validateGraph, type RoadGraph } from "./road-graph.js";

const CLASSES = [
  { id: "street", widthM: 9, sidewalkM: 2.5 },
  { id: "arterial", widthM: 16, sidewalkM: 3 }
];

const empty = (): RoadGraph => ({ nodes: [], edges: [], classes: CLASSES });

const horizontal = (): RoadGraph => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 100, y: 0 }
  ],
  edges: [{ id: "ab", a: "a", b: "b", classId: "street" }],
  classes: CLASSES
});

const draw = (g: RoadGraph, from: [number, number], to: [number, number], snapPx = 1): RoadGraph =>
  insertRoad(g, { x: from[0], y: from[1] }, { x: to[0], y: to[1] }, "street", { snapPx });

describe("projectOnSegment", () => {
  it("clamps to the segment", () => {
    expect(projectOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -5, y: 3 })).toEqual({
      u: 0,
      point: { x: 0, y: 0 }
    });
    expect(projectOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 50, y: 3 }).u).toBe(1);
  });

  it("finds the foot of the perpendicular", () => {
    const p = projectOnSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 7 });
    expect(p.point).toEqual({ x: 4, y: 0 });
  });

  it("survives a degenerate segment", () => {
    expect(projectOnSegment({ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 9, y: 9 }).point).toEqual({ x: 3, y: 3 });
  });
});

describe("snapToGraph", () => {
  it("prefers a node over the road it sits on", () => {
    expect(snapToGraph(horizontal(), { x: 4, y: 3 }, 10)).toEqual({ x: 0, y: 0 });
  });

  it("falls back to the nearest point on a road", () => {
    expect(snapToGraph(horizontal(), { x: 50, y: 4 }, 10)).toEqual({ x: 50, y: 0 });
  });

  it("leaves a point alone when nothing is in range", () => {
    expect(snapToGraph(horizontal(), { x: 50, y: 400 }, 10)).toEqual({ x: 50, y: 400 });
  });
});

describe("insertRoad", () => {
  it("creates both endpoints on an empty graph", () => {
    const g = draw(empty(), [0, 0], [100, 0]);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(validateGraph(g)).toEqual([]);
  });

  it("fuses an endpoint into a nearby node instead of doubling it up", () => {
    const g = draw(horizontal(), [3, 3], [0, 200], 10);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
    expect(g.edges.some((e) => e.a === "a" || e.b === "a")).toBe(true);
  });

  it("splits both roads where they cross", () => {
    const g = draw(horizontal(), [50, -50], [50, 50]);
    expect(g.nodes).toHaveLength(5);
    expect(g.edges).toHaveLength(4);
    expect(validateGraph(g)).toEqual([]);
    // The crossing became a real junction rather than two roads passing through.
    const junction = g.nodes.find((n) => n.x === 50 && n.y === 0);
    expect(junction).toBeDefined();
    expect(g.edges.filter((e) => e.a === junction!.id || e.b === junction!.id)).toHaveLength(4);
  });

  it("splits the road a T-junction lands on", () => {
    const g = draw(horizontal(), [50, 50], [50, 4], 10);
    expect(g.edges).toHaveLength(3);
    expect(g.nodes).toHaveLength(4);
    expect(validateGraph(g)).toEqual([]);
  });

  it("splits one road twice when crossed twice", () => {
    const start: RoadGraph = {
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 0, y: 100 },
        { id: "c", x: 200, y: 0 },
        { id: "d", x: 200, y: 100 }
      ],
      edges: [
        { id: "ab", a: "a", b: "b", classId: "street" },
        { id: "cd", a: "c", b: "d", classId: "street" }
      ],
      classes: CLASSES
    };
    const g = draw(start, [-50, 50], [250, 50]);
    // Both verticals split in two, and the new road arrives in three pieces.
    expect(g.edges).toHaveLength(4 + 3);
    expect(g.nodes).toHaveLength(4 + 2 + 2);
    expect(validateGraph(g)).toEqual([]);
  });

  it("does not duplicate a road that already exists", () => {
    const g = draw(horizontal(), [0, 0], [100, 0], 5);
    expect(g.edges).toHaveLength(1);
    expect(g.nodes).toHaveLength(2);
  });

  it("ignores a drag that never left its start", () => {
    const start = horizontal();
    expect(draw(start, [50, 50], [52, 50], 10)).toBe(start);
  });

  it("keeps ids unique across many strokes", () => {
    let g = empty();
    for (let i = 0; i < 6; i++) {
      g = draw(g, [i * 100, 0], [i * 100, 400]);
      g = draw(g, [0, i * 80], [500, i * 80]);
    }
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    expect(validateGraph(g)).toEqual([]);
  });
});

describe("removeRoad", () => {
  it("drops the road and the nodes it left behind", () => {
    const g = removeRoad(horizontal(), "ab");
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(0);
  });

  it("keeps nodes another road still uses", () => {
    const crossed = draw(horizontal(), [50, -50], [50, 50]);
    const removed = removeRoad(crossed, crossed.edges[0]!.id);
    expect(removed.edges).toHaveLength(crossed.edges.length - 1);
    expect(validateGraph(removed)).toEqual([]);
  });

  it("returns the same graph for an unknown id", () => {
    const start = horizontal();
    expect(removeRoad(start, "nope")).toBe(start);
  });
});

describe("pruneOrphanNodes", () => {
  it("leaves a fully connected graph untouched", () => {
    const start = horizontal();
    expect(pruneOrphanNodes(start)).toBe(start);
  });
});

describe("moveNode", () => {
  it("drags a junction and takes its roads with it", () => {
    const g = moveNode(horizontal(), "a", { x: -40, y: -30 }, { snapPx: 10 });
    expect(g.nodes.find((n) => n.id === "a")).toEqual({ id: "a", x: -40, y: -30 });
    expect(g.edges).toHaveLength(1);
  });

  it("welds onto the junction it is dropped on", () => {
    const crossed = draw(horizontal(), [50, -50], [50, 50]);
    const junction = crossed.nodes.find((n) => n.x === 50 && n.y === 0)!;
    const g = moveNode(crossed, "a", { x: 50, y: 2 }, { snapPx: 10 });

    expect(g.nodes.some((n) => n.id === "a")).toBe(false);
    expect(g.edges.some((e) => e.a === "a" || e.b === "a")).toBe(false);
    expect(validateGraph(g)).toEqual([]);
    // The road from "a" collapsed onto the junction rather than becoming a self-loop.
    expect(g.edges.every((e) => e.a !== e.b)).toBe(true);
    expect(g.nodes.some((n) => n.id === junction.id)).toBe(true);
  });

  it("is a no-op for an unknown node or an unmoved one", () => {
    const start = horizontal();
    expect(moveNode(start, "nope", { x: 5, y: 5 }, { snapPx: 1 })).toBe(start);
    expect(moveNode(start, "a", { x: 0, y: 0 }, { snapPx: 0 })).toBe(start);
  });
});

describe("mergeNodes", () => {
  it("collapses duplicates left by the weld", () => {
    const g: RoadGraph = {
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 100, y: 0 },
        { id: "c", x: 100, y: 100 }
      ],
      edges: [
        { id: "ab", a: "a", b: "b", classId: "street" },
        { id: "ac", a: "a", b: "c", classId: "street" },
        { id: "bc", a: "b", b: "c", classId: "street" }
      ],
      classes: CLASSES
    };
    // Welding b into c turns "ab" and "ac" into the same road, and "bc" into a self-loop.
    const merged = mergeNodes(g, "b", "c");
    expect(merged.edges).toHaveLength(1);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "c"]);
    expect(validateGraph(merged)).toEqual([]);
  });
});

describe("toggleSidewalks", () => {
  it("flips the class default off and back on", () => {
    const off = toggleSidewalks(horizontal(), "ab");
    expect(off.edges[0]!.sidewalks).toBe(false);
    expect(toggleSidewalks(off, "ab").edges[0]!.sidewalks).toBe(true);
  });

  it("returns the same graph for an unknown road", () => {
    const start = horizontal();
    expect(toggleSidewalks(start, "nope")).toBe(start);
  });
});

describe("nearestNode", () => {
  it("finds the junction under the cursor", () => {
    expect(nearestNode(horizontal(), { x: 6, y: 6 }, 10)?.id).toBe("a");
    expect(nearestNode(horizontal(), { x: 50, y: 0 }, 10)).toBeNull();
  });
});

describe("nearestEdge", () => {
  it("finds the road under the cursor", () => {
    expect(nearestEdge(horizontal(), { x: 50, y: 6 }, 10)?.id).toBe("ab");
  });

  it("returns nothing when the cursor is clear of every road", () => {
    expect(nearestEdge(horizontal(), { x: 50, y: 60 }, 10)).toBeNull();
  });
});
