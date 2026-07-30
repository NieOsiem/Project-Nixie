import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds, type MultiPolygon, type Rect } from "../geom/types.js";
import type { RoadGraph } from "../graph/road-graph.js";
import { buildRoadSurfaces, edgeQuad, nodeDisc } from "./roads.js";

const area = (mp: MultiPolygon): number =>
  mp.reduce(
    (sum, polygon) =>
      sum + polygon.reduce((s, ring, i) => s + (i === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0),
    0
  );

const STREET = { id: "street", widthM: 10, sidewalkM: 2 };

const crossGraph = (): RoadGraph => ({
  nodes: [
    { id: "w", x: -100, y: 0 },
    { id: "e", x: 100, y: 0 },
    { id: "n", x: 0, y: -100 },
    { id: "s", x: 0, y: 100 },
    { id: "c", x: 0, y: 0 }
  ],
  edges: [
    { id: "wc", a: "w", b: "c", classId: "street" },
    { id: "ce", a: "c", b: "e", classId: "street" },
    { id: "nc", a: "n", b: "c", classId: "street" },
    { id: "cs", a: "c", b: "s", classId: "street" }
  ],
  classes: [STREET]
});

// Roads run to +-100 and the bounds stop at +-80, so every road crosses the boundary.
// A cross that stops short of the edge leaves one polygon with a hole, not four blocks.
const bounds: Rect = { x: -80, y: -80, width: 160, height: 160 };

describe("edgeQuad", () => {
  it("spans twice the half-width across the segment", () => {
    const q = edgeQuad({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
    expect(q).toHaveLength(4);
    expect(ringBounds(q)).toEqual({ x: 0, y: -5, width: 100, height: 10 });
    expect(Math.abs(ringArea(q))).toBeCloseTo(1000, 6);
  });

  it("works on a diagonal", () => {
    const q = edgeQuad({ x: 0, y: 0 }, { x: 30, y: 40 }, 5);
    expect(Math.abs(ringArea(q))).toBeCloseTo(50 * 10, 6);
  });

  it("rejects a zero-length edge", () => {
    expect(() => edgeQuad({ x: 1, y: 1 }, { x: 1, y: 1 }, 5)).toThrow();
  });
});

describe("nodeDisc", () => {
  it("matches the inscribed-polygon area for its segment count", () => {
    for (const segments of [8, 16, 64]) {
      const d = nodeDisc({ x: 0, y: 0 }, 10, segments);
      const inscribed = 0.5 * segments * 100 * Math.sin((2 * Math.PI) / segments);
      expect(Math.abs(ringArea(d))).toBeCloseTo(inscribed, 6);
      // Inscribed, so always a little under the true circle and never over.
      expect(Math.abs(ringArea(d))).toBeLessThan(Math.PI * 100);
    }
    expect(ringBounds(nodeDisc({ x: 0, y: 0 }, 10, 64)).width).toBeCloseTo(20, 1);
  });

  it("is centred on the node", () => {
    const b = ringBounds(nodeDisc({ x: 50, y: -20 }, 8, 32));
    expect(b.x + b.width / 2).toBeCloseTo(50, 6);
    expect(b.y + b.height / 2).toBeCloseTo(-20, 6);
  });

  it("honours the segment count", () => {
    expect(nodeDisc({ x: 0, y: 0 }, 5, 12)).toHaveLength(12);
  });
});

describe("buildRoadSurfaces", () => {
  const ppm = 1;

  it("unions a four-way crossing into a single connected surface", () => {
    const s = buildRoadSurfaces(crossGraph(), bounds, ppm);
    expect(s.road).toHaveLength(1);
  });

  it("splits the remaining land into four blocks", () => {
    const s = buildRoadSurfaces(crossGraph(), bounds, ppm);
    expect(s.blocks).toHaveLength(4);
  });

  it("keeps pavement and carriageway disjoint", () => {
    const s = buildRoadSurfaces(crossGraph(), bounds, ppm);
    expect(area(intersection(s.road, s.sidewalk))).toBeCloseTo(0, 3);
  });

  it("keeps blocks clear of all paved surface", () => {
    const s = buildRoadSurfaces(crossGraph(), bounds, ppm);
    expect(area(intersection(s.blocks, s.road))).toBeCloseTo(0, 3);
    expect(area(intersection(s.blocks, s.sidewalk))).toBeCloseTo(0, 3);
  });

  it("tiles the bounding area exactly", () => {
    const s = buildRoadSurfaces(crossGraph(), bounds, ppm);
    // Roads overshoot the bounds by design, so clip before summing.
    const box = ringAsMulti(rectRing(bounds));
    const covered =
      area(intersection(s.road, box)) +
      area(intersection(s.sidewalk, box)) +
      area(intersection(s.blocks, box));
    expect(covered).toBeCloseTo(bounds.width * bounds.height, 0);
  });

  it("converts metre widths to pixels at the given scale", () => {
    const straight: RoadGraph = {
      nodes: [
        { id: "a", x: -100, y: 0 },
        { id: "b", x: 100, y: 0 }
      ],
      edges: [{ id: "ab", a: "a", b: "b", classId: "street" }],
      classes: [STREET]
    };
    for (const scale of [1, 2, 7.5]) {
      const s = buildRoadSurfaces(straight, bounds, scale);
      // Carriageway spans widthM across; the junction discs cap the ends at the same
      // half-width, so the cross-section is exactly widthM * scale.
      expect(ringBounds(s.road[0]![0]!).height).toBeCloseTo(STREET.widthM * scale, 3);
    }
  });

  it("handles a T-junction", () => {
    const g = crossGraph();
    g.edges = g.edges.filter((e) => e.id !== "cs");
    const s = buildRoadSurfaces(g, bounds, ppm);
    expect(s.road).toHaveLength(1);
    // The through road halves the bounds; the stub splits only the northern half.
    expect(s.blocks).toHaveLength(3);
  });

  it("handles an oblique bend without leaving a notch", () => {
    const g: RoadGraph = {
      nodes: [
        { id: "a", x: -100, y: -60 },
        { id: "b", x: 0, y: 0 },
        { id: "c", x: 100, y: -60 }
      ],
      edges: [
        { id: "ab", a: "a", b: "b", classId: "street" },
        { id: "bc", a: "b", b: "c", classId: "street" }
      ],
      classes: [STREET]
    };
    const s = buildRoadSurfaces(g, bounds, ppm);
    // The junction disc has to bridge the two quads; without it the union splits.
    expect(s.road).toHaveLength(1);
  });

  it("ignores edges with unresolvable nodes or classes", () => {
    const g = crossGraph();
    g.edges.push({ id: "bad", a: "w", b: "ghost", classId: "street" });
    g.edges.push({ id: "bad2", a: "w", b: "e", classId: "ghostclass" });
    expect(() => buildRoadSurfaces(g, bounds, ppm)).not.toThrow();
  });

  it("returns empty surfaces for a graph with no edges", () => {
    const s = buildRoadSurfaces({ nodes: [], edges: [], classes: [STREET] }, bounds, ppm);
    expect(s.road).toEqual([]);
    expect(s.sidewalk).toEqual([]);
    expect(area(s.blocks)).toBeCloseTo(bounds.width * bounds.height, 3);
  });
});

describe("per-road walkways", () => {
  const straight = (sidewalks?: boolean): RoadGraph => ({
    nodes: [
      { id: "w", x: -100, y: 0 },
      { id: "e", x: 100, y: 0 }
    ],
    edges: [{ id: "we", a: "w", b: "e", classId: "street", ...(sidewalks === undefined ? {} : { sidewalks }) }],
    classes: [STREET]
  });

  it("uses the class pavement by default", () => {
    expect(area(buildRoadSurfaces(straight(), bounds, 1).sidewalk)).toBeGreaterThan(0);
  });

  it("drops the pavement when the road turns it off", () => {
    const off = buildRoadSurfaces(straight(false), bounds, 1);
    expect(area(off.sidewalk)).toBeCloseTo(0, 6);
    // The carriageway is untouched — only the pavement either side goes away.
    expect(area(off.road)).toBeCloseTo(area(buildRoadSurfaces(straight(), bounds, 1).road), 6);
  });

  it("gives the land back to the blocks", () => {
    const on = buildRoadSurfaces(straight(true), bounds, 1);
    const off = buildRoadSurfaces(straight(false), bounds, 1);
    expect(area(off.blocks)).toBeGreaterThan(area(on.blocks));
  });
});
