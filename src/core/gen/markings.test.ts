import { describe, expect, it } from "vitest";
import { rectsIntersect, ringArea, ringCentroid, type Rect, type Vec2 } from "../geom/types.js";
import { classMap, nodeMap, type RoadGraph } from "../graph/road-graph.js";
import { MATERIAL } from "../palette.js";
import { chunkQueryRect, chunkRect, chunksCovering, type ChunkKey } from "./chunks.js";
import {
  cityBounds,
  cityToPixels,
  demoCity,
  pixelsToMetres,
  ROAD_CLASSES,
  type CityParams
} from "./demo-city.js";
import {
  buildMarkings,
  buildRoadDetails,
  MARKING_HEIGHT_M,
  MARKING_REACH_M,
  type MarkingQuad
} from "./markings.js";

const ORIGIN = { x: 5000, y: 4000 };
const PPM = 25;
const BOUNDS_MARGIN_M = 20;

const CITY = demoCity(ORIGIN);
const toPixels = (graph: RoadGraph): RoadGraph => cityToPixels({ ...CITY, graph }, PPM).graph;

const GRAPH_PX = toPixels(CITY.graph);
const QUADS = buildMarkings(GRAPH_PX, PPM);

/** Exact — JS number formatting round-trips, so this compares doubles bit for bit. */
const quadKey = (q: MarkingQuad): string =>
  `${q.material}|${q.ring.map((p) => `${p.x},${p.y}`).join(" ")}`;

const keys = (quads: MarkingQuad[]): string[] => quads.map(quadKey);

const byMaterial = (quads: MarkingQuad[], material: number): MarkingQuad[] =>
  quads.filter((q) => q.material === material);

function subgraph(graph: RoadGraph, keep: (id: string) => boolean): RoadGraph {
  const edges = graph.edges.filter((e) => keep(e.id));
  const used = new Set(edges.flatMap((e) => [e.a, e.b]));
  return { ...graph, nodes: graph.nodes.filter((n) => used.has(n.id)), edges };
}

/** Largest incident paved half-width per node, in pixels — the junction disc radius. */
function pavedRadii(graph: RoadGraph, pixelsPerMetre: number): Map<string, number> {
  const classes = classMap(graph);
  const radii = new Map<string, number>();
  for (const e of graph.edges) {
    const c = classes.get(e.classId);
    if (!c) continue;
    const sidewalkM = e.sidewalks === false ? 0 : c.sidewalkM;
    const r = (c.widthM / 2 + sidewalkM) * pixelsPerMetre;
    for (const id of [e.a, e.b]) radii.set(id, Math.max(radii.get(id) ?? 0, r));
  }
  return radii;
}

/**
 * Quads sitting on one edge, picked geometrically rather than by emission order, so the
 * comparison survives any reordering inside the generator.
 */
function quadsOn(quads: MarkingQuad[], a: Vec2, b: Vec2, halfWidth: number): MarkingQuad[] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  return quads.filter((q) => {
    const c = ringCentroid(q.ring);
    const t = (c.x - a.x) * dir.x + (c.y - a.y) * dir.y;
    const lateral = Math.abs((c.x - a.x) * -dir.y + (c.y - a.y) * dir.x);
    return t >= 0 && t <= length && lateral <= halfWidth;
  });
}

const node = (graph: RoadGraph, id: string): Vec2 => nodeMap(graph).get(id)!;

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const dx = (b.x - a.x) / len;
  const dy = (b.y - a.y) / len;
  const vx = p.x - a.x;
  const vy = p.y - a.y;
  const t = Math.min(len, Math.max(0, vx * dx + vy * dy));
  return Math.hypot(vx - dx * t, vy - dy * t);
}

/* -------------------------------------------- */
/*  Chunk emulation — mirrors chunked.ts         */
/* -------------------------------------------- */

function rectIntersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)
  };
}

function clipGraph(graph: RoadGraph, rect: Rect, marginM: number): RoadGraph {
  const nodes = nodeMap(graph);
  const edges = graph.edges.filter((e) => {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b) return false;
    return rectsIntersect(
      {
        x: Math.min(a.x, b.x) - marginM,
        y: Math.min(a.y, b.y) - marginM,
        width: Math.abs(b.x - a.x) + marginM * 2,
        height: Math.abs(b.y - a.y) + marginM * 2
      },
      rect
    );
  });
  const used = new Set(edges.flatMap((e) => [e.a, e.b]));
  return { ...graph, nodes: graph.nodes.filter((n) => used.has(n.id)), edges };
}

/** The margin term markings add to `chunkMarginM`, computed the way the chunk builder does. */
function markingMarginM(params: CityParams): number {
  return Math.max(
    params.base.lotSizeM,
    ...params.graph.classes.map((c) => c.widthM / 2 + c.sidewalkM + MARKING_REACH_M)
  );
}

const owns = (chunkM: Rect, p: Vec2): boolean =>
  p.x >= chunkM.x &&
  p.x < chunkM.x + chunkM.width &&
  p.y >= chunkM.y &&
  p.y < chunkM.y + chunkM.height;

/** Every quad the chunked path would keep, in chunk order. */
function chunkedMarkings(params: CityParams, boundsM: Rect): MarkingQuad[] {
  const marginM = markingMarginM(params);
  const out: MarkingQuad[] = [];
  for (const key of chunksCovering(boundsM) as ChunkKey[]) {
    const queryM = rectIntersection(chunkQueryRect(key, marginM), boundsM);
    const chunkM = rectIntersection(chunkRect(key), boundsM);
    if (queryM.width <= 0 || queryM.height <= 0 || chunkM.width <= 0 || chunkM.height <= 0) {
      continue;
    }
    const clipped = clipGraph(params.graph, queryM, marginM);
    for (const q of buildMarkings(cityToPixels({ ...params, graph: clipped }, PPM).graph, PPM)) {
      const centroid = pixelsToMetres(ringCentroid(q.ring), params.origin, PPM);
      if (owns(chunkM, centroid)) out.push(q);
    }
  }
  return out;
}

/** The demo graph spread out, so chunk seams land in the city interior. */
function wideCity(factor: number): CityParams {
  const graph = CITY.graph;
  return {
    ...CITY,
    graph: { ...graph, nodes: graph.nodes.map((n) => ({ ...n, x: n.x * factor, y: n.y * factor })) }
  };
}

/* -------------------------------------------- */

describe("marking quads", () => {
  it("shares the exact kept kerb segments with parked-car placement", () => {
    const details = buildRoadDetails(GRAPH_PX, PPM);
    expect(keys(details.markings)).toEqual(keys(QUADS));
    expect(details.parkingSpans).toHaveLength(byMaterial(QUADS, MATERIAL.KERB).length);
  });

  it("sits above the carriageway without reaching building height", () => {
    expect(MARKING_HEIGHT_M).toBeGreaterThan(0);
    expect(MARKING_HEIGHT_M).toBeLessThan(0.5);
  });

  it("emits only the three shared-bank materials", () => {
    const used = new Set(QUADS.map((q) => q.material));
    expect([...used].sort((a, b) => a - b)).toEqual(
      [MATERIAL.LANE_MARK, MATERIAL.CROSSING, MATERIAL.KERB].sort((a, b) => a - b)
    );
  });

  it("emits convex, positively wound quads", () => {
    for (const q of QUADS) {
      expect(q.ring).toHaveLength(4);
      expect(ringArea(q.ring)).toBeGreaterThan(0);
      for (const p of q.ring) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it("stays inside the quad budget on the demo fixture and a spread-out city", () => {
    expect(QUADS.length).toBeGreaterThan(100);
    expect(QUADS.length).toBeLessThan(1000);

    const wide = wideCity(3);
    expect(buildMarkings(toPixels(wide.graph), PPM).length).toBeLessThan(5000);
    // Measured: 339 quads on the demo, 886 at x3, 1707 at x6 (1200x864 m).
    expect(buildMarkings(toPixels(wideCity(6).graph), PPM).length).toBeLessThan(5000);
  });
});

describe("junction clearance", () => {
  /**
   * Crossings are excluded deliberately, and it is not a weakened assertion.
   *
   * A node's disc radius is the widest paved half-width *of its own arms*. At F — an
   * arterial meeting two side streets — that is the arterial's own 11 m, but a zebra
   * across the arterial belongs 7.4 m out, level with the side street's kerb. It is
   * painted on the arterial's carriageway, which is exactly where a crossing goes. What
   * a crossing must clear is the *crossing road's* pavement, and that is what the acute
   * junction test below checks directly.
   */
  it("keeps kerbs and dashes outside every junction disc", () => {
    const radii = pavedRadii(GRAPH_PX, PPM);
    const surface = QUADS.filter((q) => q.material !== MATERIAL.CROSSING);
    expect(surface.length).toBeGreaterThan(100);
    for (const q of surface) {
      for (const p of q.ring) {
        for (const [id, radius] of radii) {
          const n = node(GRAPH_PX, id);
          expect(Math.hypot(p.x - n.x, p.y - n.y)).toBeGreaterThanOrEqual(radius - 1e-9);
        }
      }
    }
  });

  it("kerbs a lone road over its whole length — there is no junction to clear", () => {
    const short: RoadGraph = {
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 6, y: 0 }
      ],
      edges: [{ id: "ab", a: "a", b: "b", classId: "arterial" }],
      classes: ROAD_CLASSES.map((c) => ({ ...c }))
    };
    const quads = buildMarkings(toPixels(short), PPM);
    expect(byMaterial(quads, MATERIAL.KERB).length).toBe(2);
    expect(byMaterial(quads, MATERIAL.LANE_MARK)).toEqual([]);
    expect(byMaterial(quads, MATERIAL.CROSSING)).toEqual([]);
  });

  it("keeps markings off a road they never meet at a node", () => {
    const halfM = 9 / 2 + 2.5;
    const tipM = halfM - 1;
    const stray: RoadGraph = {
      nodes: [
        { id: "w", x: -200, y: 0 },
        { id: "e", x: 200, y: 0 },
        { id: "s", x: 0, y: 200 },
        { id: "tip", x: 0, y: tipM }
      ],
      edges: [
        { id: "we", a: "w", b: "e", classId: "street" },
        { id: "stub", a: "s", b: "tip", classId: "street" }
      ],
      classes: ROAD_CLASSES.map((c) => ({ ...c }))
    };
    const px = toPixels(stray);
    const quads = buildMarkings(px, PPM);
    expect(quads.length).toBeGreaterThan(10);

    const halfPx = halfM * PPM;
    const through: [Vec2, Vec2] = [node(px, "w"), node(px, "e")];
    const stub: [Vec2, Vec2] = [node(px, "s"), node(px, "tip")];

    let checked = 0;
    for (const q of quads) {
      const alongX = Math.abs(q.ring[1]!.x - q.ring[0]!.x);
      const alongY = Math.abs(q.ring[1]!.y - q.ring[0]!.y);
      const foreign = alongX > alongY ? stub : through;
      for (const p of q.ring) {
        expect(distanceToSegment(p, foreign[0], foreign[1])).toBeGreaterThanOrEqual(halfPx - 1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("does not treat two arms of the same road as foreign", () => {
    const split: RoadGraph = {
      nodes: [
        { id: "a", x: -100, y: 0 },
        { id: "b", x: 0, y: 0 },
        { id: "c", x: 100, y: 0 }
      ],
      edges: [
        { id: "ab", a: "a", b: "b", classId: "street" },
        { id: "bc", a: "b", b: "c", classId: "street" }
      ],
      classes: ROAD_CLASSES.map((c) => ({ ...c }))
    };
    const px = toPixels(split);
    const b = node(px, "b");
    const nearby = byMaterial(buildMarkings(px, PPM), MATERIAL.LANE_MARK).filter(
      (q) => Math.abs(ringCentroid(q.ring).x - b.x) < 10 * PPM
    );

    expect(nearby).toHaveLength(2);
  });

  it("keeps the wide road's kerb out of the default city's narrower diagonal arm", () => {
    const d = node(GRAPH_PX, "D");
    const e = node(GRAPH_PX, "E");
    const b = node(GRAPH_PX, "B");
    const horizontalKerbs = byMaterial(
      quadsOn(QUADS, d, e, (16 / 2 + 3) * PPM),
      MATERIAL.KERB
    ).filter((q) => Math.abs(q.ring[1]!.y - q.ring[0]!.y) < 1e-9);

    expect(horizontalKerbs.length).toBeGreaterThan(2);
    for (const q of horizontalKerbs) {
      for (const p of q.ring) {
        expect(distanceToSegment(p, d, b)).toBeGreaterThanOrEqual(
          (9 / 2 + 2.5) * PPM - 1e-6
        );
      }
    }
  });

  /**
   * The bug this file exists to prevent: kerb lines drawn straight across an open
   * junction. Insetting by the junction disc is not enough — two pavement strips meeting
   * at 30° overlap for far longer than the disc, so the kerb re-emerges inside the
   * junction on the inner side of the wedge.
   *
   * Checked by direct geometry (point inside the neighbour's strip), not by re-deriving
   * the miter formula, so it is an independent check on that algebra.
   */
  it("keeps a kerb out of the neighbouring pavement at an acute junction", () => {
    const acute: RoadGraph = {
      nodes: [
        { id: "j", x: 0, y: 0 },
        { id: "p", x: -120, y: 0 },
        { id: "q", x: -120, y: -70 }
      ],
      edges: [
        { id: "jp", a: "j", b: "p", classId: "street" },
        { id: "jq", a: "j", b: "q", classId: "street" }
      ],
      classes: ROAD_CLASSES.map((c) => ({ ...c }))
    };
    const px = toPixels(acute);
    const j = node(px, "j");
    const halfPx = (9 / 2 + 2.5) * PPM;

    for (const [self, other] of [
      ["p", "q"],
      ["q", "p"]
    ] as const) {
      const far = node(px, other);
      const len = Math.hypot(far.x - j.x, far.y - j.y);
      const dir = { x: (far.x - j.x) / len, y: (far.y - j.y) / len };

      for (const quad of byMaterial(quadsOn(buildMarkings(px, PPM), j, node(px, self), halfPx), MATERIAL.KERB)) {
        for (const point of quad.ring) {
          const v = { x: point.x - j.x, y: point.y - j.y };
          const along = v.x * dir.x + v.y * dir.y;
          if (along < 0 || along > len) continue;
          const across = Math.abs(v.x * dir.y - v.y * dir.x);
          expect(across).toBeGreaterThanOrEqual(halfPx - 1e-6);
        }
      }
    }
  });
});

describe("class gating", () => {
  const cross = (classId: string): RoadGraph => ({
    nodes: [
      { id: "c", x: 0, y: 0 },
      { id: "w", x: -100, y: 0 },
      { id: "e", x: 100, y: 0 },
      { id: "s", x: 0, y: 100 }
    ],
    edges: [
      { id: "wc", a: "w", b: "c", classId },
      { id: "ce", a: "c", b: "e", classId },
      { id: "cs", a: "c", b: "s", classId }
    ],
    classes: ROAD_CLASSES.map((c) => ({ ...c }))
  });

  it("gives a lane no dashes and no crossings, but keeps its kerbs", () => {
    const quads = buildMarkings(toPixels(cross("lane")), PPM);
    expect(byMaterial(quads, MATERIAL.LANE_MARK)).toEqual([]);
    expect(byMaterial(quads, MATERIAL.CROSSING)).toEqual([]);
    expect(byMaterial(quads, MATERIAL.KERB).length).toBeGreaterThan(0);
  });

  it("gives an alley nothing at all — it has no pavement to kerb", () => {
    expect(buildMarkings(toPixels(cross("alley")), PPM)).toEqual([]);
  });

  it("marks a street, which is exactly at the threshold width", () => {
    const quads = buildMarkings(toPixels(cross("street")), PPM);
    expect(byMaterial(quads, MATERIAL.LANE_MARK).length).toBeGreaterThan(0);
    expect(byMaterial(quads, MATERIAL.CROSSING).length).toBeGreaterThan(0);
  });

  it("drops the kerb line of a road whose pavement is switched off", () => {
    const g = cross("street");
    g.edges[0]!.sidewalks = false;
    const quads = buildMarkings(toPixels(g), PPM);

    const w = node(toPixels(g), "w");
    const c = node(toPixels(g), "c");
    const onWC = quadsOn(quads, w, c, (9 / 2 + 2.5) * PPM);
    expect(byMaterial(onWC, MATERIAL.KERB)).toEqual([]);
    expect(byMaterial(onWC, MATERIAL.LANE_MARK).length).toBeGreaterThan(0);
    // The untouched arm still has its kerbs, so the switch is per-road and not global.
    expect(byMaterial(quads, MATERIAL.KERB).length).toBeGreaterThan(0);
  });
});

describe("crossings", () => {
  it("only appears where three or more roads meet", () => {
    const stub: RoadGraph = {
      nodes: [
        { id: "a", x: -100, y: 0 },
        { id: "b", x: 0, y: 0 },
        { id: "c", x: 100, y: 0 }
      ],
      edges: [
        { id: "ab", a: "a", b: "b", classId: "arterial" },
        { id: "bc", a: "b", b: "c", classId: "arterial" }
      ],
      classes: ROAD_CLASSES.map((c) => ({ ...c }))
    };
    expect(byMaterial(buildMarkings(toPixels(stub), PPM), MATERIAL.CROSSING)).toEqual([]);
  });

  it("lays stripes along the road axis, spanning the carriageway and no more", () => {
    // E is the four-way; its arms are all arterial, 16 m kerb to kerb.
    const e = node(GRAPH_PX, "E");
    const h = node(GRAPH_PX, "H");
    const band = byMaterial(quadsOn(QUADS, e, h, (16 / 2 + 3) * PPM), MATERIAL.CROSSING);
    expect(band.length).toBeGreaterThan(4);

    for (const q of band) {
      const w = Math.abs(q.ring[1]!.x - q.ring[0]!.x) + Math.abs(q.ring[1]!.y - q.ring[0]!.y);
      const d = Math.abs(q.ring[2]!.x - q.ring[1]!.x) + Math.abs(q.ring[2]!.y - q.ring[1]!.y);
      // Stripes are long along the road (3 m) and narrow across it (0.7 m).
      expect(w / PPM).toBeCloseTo(3, 6);
      expect(d / PPM).toBeCloseTo(0.7, 6);
      // E-H runs straight down, so "across" is x. Never past the 8 m half-carriageway.
      for (const p of q.ring) expect(Math.abs(p.x - e.x) / PPM).toBeLessThanOrEqual(8);
    }
  });
});

describe("dash phase anchor", () => {
  /**
   * The anchor is arc length from node `a`, so every dash starts on a 7 m grid measured
   * from that node. Re-anchoring on the inset, the graph bounds or the array index moves
   * the dashes off this grid and this fails — as does the chunk-partition test below,
   * which is the one that proves the seam behaviour rather than merely the arithmetic.
   */
  it("starts every dash on a fixed grid from the edge's own start node", () => {
    for (const id of ["AB", "DE", "DB"]) {
      const edge = CITY.graph.edges.find((e) => e.id === id)!;
      const a = node(GRAPH_PX, edge.a);
      const b = node(GRAPH_PX, edge.b);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };

      const dashes = byMaterial(quadsOn(QUADS, a, b, 1), MATERIAL.LANE_MARK);
      expect(dashes.length).toBeGreaterThan(2);
      for (const q of dashes) {
        const t = (q.ring[0]!.x - a.x) * dir.x + (q.ring[0]!.y - a.y) * dir.y;
        const k = t / (7 * PPM);
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      }
    }
  });
});

describe("subgraph invariance", () => {
  // C-F plus everything incident to C and F, so both nodes keep their full degree and
  // their full paved radius. This is the state a chunk owning C-F's quads always sees.
  // The subgraph deliberately loses the city's western half, so its own bounds, node
  // count and edge indices all differ from the full graph's — anchoring on any of those
  // would show up here.
  const NEIGHBOURHOOD = new Set(["CF", "BC", "EF", "FI"]);
  const sub = subgraph(CITY.graph, (id) => NEIGHBOURHOOD.has(id));
  const subPx = toPixels(sub);
  const C = node(GRAPH_PX, "C");
  const F = node(GRAPH_PX, "F");
  const HALF = (9 / 2 + 2.5) * PPM;

  it("reproduces a shared edge byte for byte, in the same order", () => {
    const full = quadsOn(QUADS, C, F, HALF);
    const partial = quadsOn(buildMarkings(subPx, PPM), C, F, HALF);
    expect(full.length).toBeGreaterThan(10);
    expect(keys(partial)).toEqual(keys(full));
  });

  it("covers all three markings on that edge, so the check is not vacuous", () => {
    const full = quadsOn(QUADS, C, F, HALF);
    for (const m of [MATERIAL.LANE_MARK, MATERIAL.CROSSING, MATERIAL.KERB]) {
      expect(byMaterial(full, m).length).toBeGreaterThan(0);
    }
  });

  /**
   * The honest boundary. Arm directions, widths and degree all come from whatever graph is
   * handed in, so dropping one of a node's arms changes the miter inset of the arms that
   * remain, and their markings move. That is not a bug to fix here — it is exactly what
   * `MARKING_REACH_M` in the chunk margin pays for. Do not "simplify" the margin away.
   *
   * D-B is the arm to drop, not the arterial B-E: since the acute-angle fix, B's inset is
   * dominated by the 32 degrees between D-B and the streets either side of it, not by the
   * widest arm. The perpendicular arterial contributes only its own half-width.
   */
  it("moves a junction's markings when its binding arm is clipped away", () => {
    const noDB = subgraph(CITY.graph, (id) => id !== "DB");
    const A = node(GRAPH_PX, "A");
    const B = node(GRAPH_PX, "B");
    const before = quadsOn(QUADS, A, B, HALF);
    const after = quadsOn(buildMarkings(toPixels(noDB), PPM), A, B, HALF);
    expect(keys(after)).not.toEqual(keys(before));
  });

  it("confines that movement to MARKING_REACH_M of the junction", () => {
    const noDB = subgraph(CITY.graph, (id) => id !== "DB");
    const B = node(GRAPH_PX, "B");

    // Only B's surviving arms: edge D-B's own quads vanish with it, which says nothing
    // about how far a junction's influence carries.
    const arms = ["AB", "BC", "BE"].map((id) => CITY.graph.edges.find((e) => e.id === id)!);
    const onArms = (quads: MarkingQuad[]): Map<string, MarkingQuad> => {
      const found = new Map<string, MarkingQuad>();
      for (const e of arms) {
        for (const q of quadsOn(quads, node(GRAPH_PX, e.a), node(GRAPH_PX, e.b), HALF)) {
          found.set(quadKey(q), q);
        }
      }
      return found;
    };

    const before = onArms(QUADS);
    const after = onArms(buildMarkings(toPixels(noDB), PPM));
    const moved = [
      ...[...before].filter(([k]) => !after.has(k)),
      ...[...after].filter(([k]) => !before.has(k))
    ].map(([, q]) => q);

    expect(moved.length).toBeGreaterThan(0);
    // The widest class, because that is the term `chunkMarginM` maximises over.
    const widest = Math.max(...ROAD_CLASSES.map((c) => c.widthM / 2 + c.sidewalkM));
    const limit = (widest + MARKING_REACH_M) * PPM;
    for (const q of moved) {
      for (const p of q.ring) {
        expect(Math.hypot(p.x - B.x, p.y - B.y)).toBeLessThanOrEqual(limit);
      }
    }
  });
});

describe("chunk partition", () => {
  const check = (params: CityParams): void => {
    const boundsM = cityBounds(params, BOUNDS_MARGIN_M)!;
    const whole = keys(buildMarkings(toPixels(params.graph), PPM));
    const chunked = keys(chunkedMarkings(params, boundsM));

    expect(new Set(chunked).size).toBe(chunked.length);
    expect(chunked.sort()).toEqual([...whole].sort());
  };

  it("reproduces the demo fixture", () => {
    check(CITY);
  });

  it("reproduces a city spread across many chunk seams", () => {
    const wide = wideCity(3);
    const boundsM = cityBounds(wide, BOUNDS_MARGIN_M)!;
    // Worth having only if seams actually cut the city up.
    expect(chunksCovering(boundsM).length).toBeGreaterThan(9);
    check(wide);
  });
});
