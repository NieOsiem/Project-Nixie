import type { Ring, Vec2 } from "../geom/types.js";
import { classMap, edgeLength, nodeMap, type RoadGraph } from "../graph/road-graph.js";
import { MATERIAL } from "../palette.js";

/** Markings sit a hair above the carriageway so depth sorts them over it. */
export const MARKING_HEIGHT_M = 0.05;

/**
 * Furthest any emitted quad vertex can sit beyond a road's paved edge, in metres.
 *
 * The kerb line binds: its first piece starts at the miter inset (capped at MAX_INSET_M)
 * and runs one KERB_SEGMENT_M further while sitting pavedHalf across, so at the widest
 * class it reaches hypot(30 + 8, 15) = 40.86 m — 25.86 m past the paved edge.
 */
export const MARKING_REACH_M = 26;

export interface MarkingQuad {
  /** Convex ring in WORLD PIXELS, ready to tessellate. */
  ring: Ring;
  /** Absolute palette index: MATERIAL.LANE_MARK | MATERIAL.CROSSING | MATERIAL.KERB. */
  material: number;
}

export interface ParkingSpan {
  origin: Vec2;
  dir: Vec2;
  normal: Vec2;
  from: number;
  to: number;
  side: 1 | -1;
  roadHalf: number;
}

export interface RoadDetails {
  markings: MarkingQuad[];
  parkingSpans: ParkingSpan[];
}

/** Narrower carriageways (narrow, lane, alley) get no centre line and no zebra. */
const MARKED_WIDTH_M = 9;
const JUNCTION_DEGREE = 3;

const DASH_LENGTH_M = 3;
const DASH_PERIOD_M = 7;
const DASH_WIDTH_M = 0.3;

const CROSSING_OFFSET_M = 0.4;
const CROSSING_DEPTH_M = 3;
const STRIPE_WIDTH_M = 0.7;
const STRIPE_PERIOD_M = 1.4;

const KERB_WIDTH_M = 0.25;
/** Kerb lines are cut on a fixed grid rather than run edge-long: one quad spanning several
 * chunks would be owned by whichever chunk holds its midpoint. */
const KERB_SEGMENT_M = 8;

/** Clearance past the pavement before a marking starts. */
const CLEAR_M = 1.5;

/**
 * Ceiling on the miter inset. Two roads meeting at a hair's angle have a pavement union
 * running away to infinity, and the inset feeds MARKING_REACH_M, which feeds the chunk
 * margin, which sets how much every chunk over-generates. Bounded overshoot into the
 * junction beats an unbounded query rect.
 */
const MAX_INSET_M = 30;

/** Below this dot product two arms are one road passing through, not a turn. */
const STRAIGHT_THROUGH_DOT = -0.998;

/** Slack on the foreign-pavement test, in pixels. Matches the pipeline's own SNAP. */
const PAVEMENT_EPS = 1e-3;

interface Axis {
  /** Node `a` in world pixels. `t` runs along the edge from here, `c` across it. */
  origin: Vec2;
  dir: Vec2;
  normal: Vec2;
}

interface EdgeMarking {
  a: string;
  b: string;
  axis: Axis;
  length: number;
  roadHalf: number;
  pavedHalf: number;
  marked: boolean;
  kerbed: boolean;
}

/** One road leaving a junction. `dir` points away from the node. */
interface Arm {
  edge: number;
  dir: Vec2;
  pavedHalf: number;
}

const at = (axis: Axis, t: number, c: number): Vec2 => ({
  x: axis.origin.x + axis.dir.x * t + axis.normal.x * c,
  y: axis.origin.y + axis.dir.y * t + axis.normal.y * c
});

/** (t, c) -> world is a rotation, so t0 < t1 and c0 < c1 always wind positive. */
function quad(axis: Axis, t0: number, t1: number, c0: number, c1: number): Ring {
  return [at(axis, t0, c0), at(axis, t1, c0), at(axis, t1, c1), at(axis, t0, c1)];
}

/** Pieces of [from, to] cut on a fixed `step` grid measured from the edge start. */
function segments(from: number, to: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = Math.floor(from / step); k * step < to; k++) {
    const t0 = Math.max(from, k * step);
    const t1 = Math.min(to, (k + 1) * step);
    if (t1 > t0) out.push([t0, t1]);
  }
  return out;
}

/**
 * How far along an arm a line offset `halfWidth` from its centre stays buried in a
 * neighbouring arm's pavement.
 *
 * WHY not the junction disc radius, which is what this used to be: the disc only covers the
 * notch a bend leaves. Two strips meeting at an acute angle overlap for
 * (w_other + halfWidth·cos θ) / sin θ — far past the disc — so a marking inset by the radius
 * alone is drawn straight across the open junction. That is the broken-neon-line artifact.
 *
 * Straight-through arms are skipped before the miter; the collinear width check handles
 * same-direction overlaps whose kerb already lies outside the neighbouring pavement.
 */
function pavementInset(dir: Vec2, others: Arm[], halfWidth: number, maxInset: number): number {
  let inset = 0;
  for (const other of others) {
    const dot = dir.x * other.dir.x + dir.y * other.dir.y;
    // The road carrying on through a split obstructs nothing. Without this the centreline,
    // which has no half-width to put it outside the neighbour's strip, would inset to the
    // cap at every node a crossing road ever split — gapping the dashes city-wide.
    if (dot <= STRAIGHT_THROUGH_DOT) continue;
    const cos = Math.abs(dot);
    const sin = Math.abs(dir.x * other.dir.y - dir.y * other.dir.x);
    if (sin <= 0 && halfWidth * cos >= other.pavedHalf) continue;
    const reach = sin <= 0 ? maxInset : (other.pavedHalf + halfWidth * cos) / sin;
    inset = Math.max(inset, Math.min(reach, maxInset));
  }
  return inset;
}

/** Distance from a point to an edge's centreline segment, capped at the endpoints. */
function distanceToEdge(p: Vec2, e: EdgeMarking): number {
  const vx = p.x - e.axis.origin.x;
  const vy = p.y - e.axis.origin.y;
  const t = Math.min(e.length, Math.max(0, vx * e.axis.dir.x + vy * e.axis.dir.y));
  return Math.hypot(vx - e.axis.dir.x * t, vy - e.axis.dir.y * t);
}

// WHY: node-local insets cannot see roads that overlap without sharing a node.
function onForeignPavement(ring: Ring, own: number, edges: EdgeMarking[]): boolean {
  const source = edges[own]!;
  for (let i = 0; i < edges.length; i++) {
    if (i === own) continue;
    const e = edges[i]!;
    if (e.a === source.a || e.a === source.b || e.b === source.a || e.b === source.b) continue;
    for (const p of ring) {
      if (distanceToEdge(p, e) < e.pavedHalf - PAVEMENT_EPS) return true;
    }
  }
  return false;
}

/**
 * Lane dashes, pedestrian crossings and kerb lines for a road graph already in world pixels.
 *
 * WHY: every repeating pattern is anchored on the edge itself — dashes on arc length from
 * node `a`, zebra stripes on the carriageway centreline — never on the inset, the graph
 * bounds or the iteration order. A chunk builds from a clipped subgraph and keeps quads by
 * centroid, so an anchor that moved with the subgraph would double or drop dashes at seams.
 */
export function buildRoadDetails(graph: RoadGraph, pixelsPerMetre: number): RoadDetails {
  const nodes = nodeMap(graph);
  const classes = classMap(graph);
  const px = (m: number): number => m * pixelsPerMetre;

  const edges: EdgeMarking[] = [];
  const degree = new Map<string, number>();
  const arms = new Map<string, Arm[]>();

  const addArm = (id: string, arm: Arm): void => {
    const list = arms.get(id);
    if (list === undefined) arms.set(id, [arm]);
    else list.push(arm);
  };

  for (const edge of graph.edges) {
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    const roadClass = classes.get(edge.classId);
    if (!a || !b || !roadClass) continue;
    const length = edgeLength(a, b);
    if (length === 0) continue;

    const sidewalkM = edge.sidewalks === false ? 0 : roadClass.sidewalkM;
    const pavedHalf = px(roadClass.widthM / 2 + sidewalkM);
    const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const index = edges.length;

    edges.push({
      a: edge.a,
      b: edge.b,
      axis: { origin: { x: a.x, y: a.y }, dir, normal: { x: -dir.y, y: dir.x } },
      length,
      roadHalf: px(roadClass.widthM / 2),
      pavedHalf,
      marked: roadClass.widthM >= MARKED_WIDTH_M,
      kerbed: sidewalkM > 0
    });

    addArm(edge.a, { edge: index, dir, pavedHalf });
    addArm(edge.b, { edge: index, dir: { x: -dir.x, y: -dir.y }, pavedHalf });
    for (const id of [edge.a, edge.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  }

  const dashLength = px(DASH_LENGTH_M);
  const dashPeriod = px(DASH_PERIOD_M);
  const dashHalf = px(DASH_WIDTH_M) / 2;
  const crossOffset = px(CROSSING_OFFSET_M);
  const crossDepth = px(CROSSING_DEPTH_M);
  const stripeHalf = px(STRIPE_WIDTH_M) / 2;
  const stripePeriod = px(STRIPE_PERIOD_M);
  const kerbWidth = px(KERB_WIDTH_M);
  const kerbStep = px(KERB_SEGMENT_M);
  const clear = px(CLEAR_M);
  const maxInset = px(MAX_INSET_M);

  const quads: (MarkingQuad & { edge: number; parking?: ParkingSpan })[] = [];

  edges.forEach((e, index) => {
    const otherArms = (id: string): Arm[] =>
      (arms.get(id) ?? []).filter((arm) => arm.edge !== index);
    const armsA = otherArms(e.a);
    const armsB = otherArms(e.b);
    const inset = (list: Arm[], dir: Vec2, halfWidth: number): number =>
      pavementInset(dir, list, halfWidth, maxInset);

    const back = { x: -e.axis.dir.x, y: -e.axis.dir.y };
    const kerbA = inset(armsA, e.axis.dir, e.pavedHalf);
    const kerbB = inset(armsB, back, e.pavedHalf);

    if (e.marked) {
      const roadA = inset(armsA, e.axis.dir, e.roadHalf);
      const roadB = inset(armsB, back, e.roadHalf);
      const zebraA = roadA + crossOffset;
      const zebraB = e.length - roadB - crossOffset;

      // Dashes clear the zebra band as well as the junction, or they z-fight it: both sit
      // at the same height and only the material differs.
      const from = Math.max(inset(armsA, e.axis.dir, 0), zebraA + crossDepth) + clear;
      const to = Math.min(e.length - inset(armsB, back, 0), zebraB - crossDepth) - clear;
      for (let k = Math.max(0, Math.ceil(from / dashPeriod)); k * dashPeriod + dashLength <= to; k++) {
        const t0 = k * dashPeriod;
        quads.push({
          ring: quad(e.axis, t0, t0 + dashLength, -dashHalf, dashHalf),
          material: MATERIAL.LANE_MARK,
          edge: index
        });
      }

      if (zebraB - zebraA >= crossDepth * 2) {
        const stripes = Math.floor((e.roadHalf - stripeHalf) / stripePeriod);
        const bands: [number, number][] = [];
        if ((degree.get(e.a) ?? 0) >= JUNCTION_DEGREE) bands.push([zebraA, zebraA + crossDepth]);
        if ((degree.get(e.b) ?? 0) >= JUNCTION_DEGREE) bands.push([zebraB - crossDepth, zebraB]);
        for (const [t0, t1] of bands) {
          for (let k = -stripes; k <= stripes; k++) {
            const c = k * stripePeriod;
            quads.push({
              ring: quad(e.axis, t0, t1, c - stripeHalf, c + stripeHalf),
              material: MATERIAL.CROSSING,
              edge: index
            });
          }
        }
      }
    }

    if (!e.kerbed) return;
    // Clearance only where the kerb was actually cut back — a straight-through split has
    // zero inset and its kerb must stay continuous through the node.
    const from = kerbA > 0 ? kerbA + clear : 0;
    const to = e.length - (kerbB > 0 ? kerbB + clear : 0);
    for (const [t0, t1] of segments(from, to, kerbStep)) {
      for (const side of [1, -1] as const) {
        const outer = e.pavedHalf * side;
        const inner = outer - kerbWidth * side;
        quads.push({
          ring: quad(e.axis, t0, t1, Math.min(outer, inner), Math.max(outer, inner)),
          material: MATERIAL.KERB,
          edge: index,
          parking: {
            origin: e.axis.origin,
            dir: e.axis.dir,
            normal: e.axis.normal,
            from: t0,
            to: t1,
            side,
            roadHalf: e.roadHalf
          }
        });
      }
    }
  });

  const kept = quads.filter((q) => !onForeignPavement(q.ring, q.edge, edges));
  return {
    markings: kept.map(({ ring, material }) => ({ ring, material })),
    parkingSpans: kept.flatMap((q) => (q.parking === undefined ? [] : [q.parking]))
  };
}

export function buildMarkings(graph: RoadGraph, pixelsPerMetre: number): MarkingQuad[] {
  return buildRoadDetails(graph, pixelsPerMetre).markings;
}
