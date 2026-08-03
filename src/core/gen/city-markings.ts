import { ringAsMulti, union } from "../geom/boolean.js";
import type { MultiPolygon, Ring, Vec2 } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY } from "./city.js";
import type { CompiledJunction, CompiledRouteNetwork, CompiledSpan } from "../graph/compiler.js";

export interface CityMarkingParts {
  laneMarkings: MultiPolygon;
  crossings: MultiPolygon;
  kerbs: MultiPolygon;
}

const DASH_LENGTH_M = 3;
const DASH_PERIOD_M = 7;
const DASH_WIDTH_M = 0.3;
const CROSSING_OFFSET_M = 0.4;
const CROSSING_DEPTH_M = 3;
const STRIPE_WIDTH_M = 0.7;
const STRIPE_PERIOD_M = 1.4;
const KERB_WIDTH_M = 0.25;
const KERB_SEGMENT_M = 8;
const CLEAR_M = 1.5;
const MAX_INSET_M = 30;
const STRAIGHT_THROUGH_DOT = -0.998;
const PAVEMENT_EPS = 1e-3;

// WHY: acute-junction kerbs can extend beyond the paved half-width; dirty bounds use this cap.
export const CITY_MARKING_REACH_M = 26;

interface Axis {
  origin: Vec2;
  dir: Vec2;
  normal: Vec2;
}

interface MarkingPiece {
  ring: Ring;
  span: CompiledSpan;
}

const length = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

function axisFor(span: CompiledSpan): Axis | null {
  const spanLength = length(span.a, span.b);
  if (spanLength <= 0) return null;
  const dir = { x: (span.b.x - span.a.x) / spanLength, y: (span.b.y - span.a.y) / spanLength };
  return { origin: span.a, dir, normal: { x: -dir.y, y: dir.x } };
}

const at = (axis: Axis, t: number, c: number): Vec2 => ({
  x: axis.origin.x + axis.dir.x * t + axis.normal.x * c,
  y: axis.origin.y + axis.dir.y * t + axis.normal.y * c
});

function quad(axis: Axis, t0: number, t1: number, c0: number, c1: number): Ring {
  return [at(axis, t0, c0), at(axis, t1, c0), at(axis, t1, c1), at(axis, t0, c1)];
}

function fixedSegments(from: number, to: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  if (to <= from) return out;
  for (let k = Math.floor(from / step); k * step < to; k++) {
    const t0 = Math.max(from, k * step);
    const t1 = Math.min(to, (k + 1) * step);
    if (t1 > t0) out.push([t0, t1]);
  }
  return out;
}

function endpointJunction(network: CompiledRouteNetwork, span: CompiledSpan, endpoint: "a" | "b"): CompiledJunction | undefined {
  const nodeId = endpoint === "a" ? span.aNodeId : span.bNodeId;
  return network.junctions.find((junction) => junction.id === nodeId);
}

function routeBoundary(routeSpans: readonly CompiledSpan[], span: CompiledSpan, endpoint: "a" | "b"): boolean {
  if (routeSpans.length === 0) return false;
  return endpoint === "a" ? span.startArcM === routeSpans[0]!.startArcM : span.endArcM === routeSpans[routeSpans.length - 1]!.endArcM;
}

function outwardDirection(span: CompiledSpan, endpoint: "a" | "b"): Vec2 | null {
  const from = endpoint === "a" ? span.a : span.b;
  const to = endpoint === "a" ? span.b : span.a;
  const d = length(from, to);
  return d <= 0 ? null : { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
}

function pavementInset(network: CompiledRouteNetwork, span: CompiledSpan, endpoint: "a" | "b", halfWidth: number): number {
  const junction = endpointJunction(network, span, endpoint);
  const dir = outwardDirection(span, endpoint);
  if (!junction || !dir) return 0;
  let inset = 0;
  for (const arm of junction.arms) {
    if (arm.edgeId === span.edgeId) continue;
    const dot = dir.x * arm.direction.x + dir.y * arm.direction.y;
    if (dot <= STRAIGHT_THROUGH_DOT) continue;
    const cos = Math.abs(dot);
    const sin = Math.abs(dir.x * arm.direction.y - dir.y * arm.direction.x);
    if (sin <= 0 && halfWidth * cos >= arm.clearanceM) continue;
    const reach = sin <= 0 ? MAX_INSET_M : (arm.clearanceM + halfWidth * cos) / sin;
    inset = Math.max(inset, Math.min(reach, MAX_INSET_M));
  }
  return inset;
}

function distanceToSpan(point: Vec2, span: CompiledSpan): number {
  const dx = span.b.x - span.a.x;
  const dy = span.b.y - span.a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator <= 0 ? 0 : Math.max(0, Math.min(1, ((point.x - span.a.x) * dx + (point.y - span.a.y) * dy) / denominator));
  return Math.hypot(point.x - (span.a.x + dx * t), point.y - (span.a.y + dy * t));
}

function sharesEndpoint(a: CompiledSpan, b: CompiledSpan): boolean {
  return a.aNodeId === b.aNodeId || a.aNodeId === b.bNodeId || a.bNodeId === b.aNodeId || a.bNodeId === b.bNodeId;
}

function onForeignPavement(piece: MarkingPiece, all: readonly CompiledSpan[]): boolean {
  for (const other of all) {
    if (other.id === piece.span.id || sharesEndpoint(piece.span, other)) continue;
    for (const point of piece.ring) if (distanceToSpan(point, other) < other.clearanceM - PAVEMENT_EPS) return true;
  }
  return false;
}

function addCrossing(
  parts: MarkingPiece[],
  network: CompiledRouteNetwork,
  span: CompiledSpan,
  endpoint: "a" | "b",
  axis: Axis,
  roadHalf: number,
  used: Set<string>
): void {
  const junction = endpointJunction(network, span, endpoint);
  const cls = ROUTE_CLASS_REGISTRY.get(span.classId as never);
  if (!junction || junction.arms.length < 3 || !cls?.vehicle || !cls.centreMarking) return;
  const key = `${junction.id}:${span.edgeId}:${endpoint}`;
  if (used.has(key)) return;
  used.add(key);
  const inset = pavementInset(network, span, endpoint, roadHalf);
  const spanLength = length(span.a, span.b);
  const fromEnd = endpoint === "a" ? inset + CROSSING_OFFSET_M : spanLength - inset - CROSSING_OFFSET_M - CROSSING_DEPTH_M;
  const toEnd = fromEnd + CROSSING_DEPTH_M;
  if (fromEnd < 0 || toEnd > spanLength) return;
  const stripeHalf = STRIPE_WIDTH_M / 2;
  const stripes = Math.floor((roadHalf - stripeHalf) / STRIPE_PERIOD_M);
  for (let k = -stripes; k <= stripes; k++) {
    const c = k * STRIPE_PERIOD_M;
    parts.push({ ring: quad(axis, fromEnd, toEnd, c - stripeHalf, c + stripeHalf), span });
  }
}

export function buildCityMarkings(network: CompiledRouteNetwork): CityMarkingParts {
  const lanePieces: MarkingPiece[] = [];
  const crossingPieces: MarkingPiece[] = [];
  const kerbPieces: MarkingPiece[] = [];
  const all = network.segments;
  const crossings = new Set<string>();

  for (const route of network.routes) {
    for (const span of route.spans) {
      const cls = ROUTE_CLASS_REGISTRY.get(span.classId as never);
      const axis = axisFor(span);
      if (!cls || !axis || !cls.vehicle) continue;
      const roadHalf = cls.widthM / 2;
      const kerbHalf = span.clearanceM;
      const insetA = pavementInset(network, span, "a", kerbHalf);
      const insetB = pavementInset(network, span, "b", kerbHalf);
      if (cls.centreMarking) {
        const roadInsetA = pavementInset(network, span, "a", roadHalf);
        const roadInsetB = pavementInset(network, span, "b", roadHalf);
        const gapA = endpointJunction(network, span, "a") || routeBoundary(route.spans, span, "a") ? roadInsetA + CROSSING_OFFSET_M + CROSSING_DEPTH_M + CLEAR_M : 0;
        const gapB = endpointJunction(network, span, "b") || routeBoundary(route.spans, span, "b") ? roadInsetB + CROSSING_OFFSET_M + CROSSING_DEPTH_M + CLEAR_M : 0;
        const start = Math.max(span.startArcM, span.startArcM + gapA);
        const end = Math.min(span.endArcM, span.endArcM - gapB);
        for (let k = Math.floor(start / DASH_PERIOD_M); k * DASH_PERIOD_M < end; k++) {
          const dashStart = k * DASH_PERIOD_M;
          const dashEnd = dashStart + DASH_LENGTH_M;
          const from = Math.max(start, dashStart);
          const to = Math.min(end, dashEnd);
          if (to <= from) continue;
          lanePieces.push({ ring: quad(axis, from - span.startArcM, to - span.startArcM, -DASH_WIDTH_M / 2, DASH_WIDTH_M / 2), span });
        }
      }

      const localCrossings: MarkingPiece[] = [];
      addCrossing(localCrossings, network, span, "a", axis, roadHalf, crossings);
      addCrossing(localCrossings, network, span, "b", axis, roadHalf, crossings);
      crossingPieces.push(...localCrossings);

      if (cls.sidewalkM > 0) {
        const from = span.startArcM + (insetA > 0 ? insetA + CLEAR_M : 0);
        const to = span.endArcM - (insetB > 0 ? insetB + CLEAR_M : 0);
        for (const [pieceFrom, pieceTo] of fixedSegments(from, to, KERB_SEGMENT_M)) {
          for (const side of [1, -1] as const) {
            const outer = kerbHalf * side;
            const inner = outer - KERB_WIDTH_M * side;
            kerbPieces.push({
              ring: quad(axis, pieceFrom - span.startArcM, pieceTo - span.startArcM, Math.min(outer, inner), Math.max(outer, inner)),
              span
            });
          }
        }
      }
    }
  }

  const keep = (pieces: MarkingPiece[]): Ring[] => pieces.filter((piece) => !onForeignPavement(piece, all)).map((piece) => piece.ring);
  const lane = union(keep(lanePieces).map(ringAsMulti));
  const crossing = union(keep(crossingPieces).map(ringAsMulti));
  const kerbs = union(keep(kerbPieces).map(ringAsMulti));
  return { laneMarkings: lane, crossings: crossing, kerbs };
}
