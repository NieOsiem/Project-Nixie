import polygonClipping from "polygon-clipping";
import { rectsIntersect, ringArea, ringBounds, ringPerimeter, type MultiPolygon, type Polygon, type Ring } from "./types.js";

/**
 * Collapse float noise so points that ought to coincide actually do. Road quads meeting
 * at a node are computed from different edge normals, and the junction discs are
 * trigonometric — without snapping, the boolean pass produces sliver artefacts.
 */
const SNAP = 1e-3;

/** Absolute floor below which an overlap is never treated as real. */
const OVERLAP_AREA_FLOOR_M2 = 1e-5;

const toGridCoordinate = (value: number): number => Math.round(value / SNAP) || 0;
const fromGridCoordinate = (value: number): number => value * SNAP;

type GridPoint = [number, number];
type GridRing = GridPoint[];
type GridPolygon = GridRing[];
type GridMulti = GridPolygon[];

const sameGridPoint = (a: GridPoint, b: GridPoint): boolean => a[0] === b[0] && a[1] === b[1];

function cleanGridRing(ring: Ring): GridRing | null {
  const out: GridRing = [];
  for (const point of ring) {
    const next: GridPoint = [toGridCoordinate(point.x), toGridCoordinate(point.y)];
    const previous = out[out.length - 1];
    if (previous && sameGridPoint(previous, next)) continue;
    out.push(next);
  }
  if (out.length > 1 && sameGridPoint(out[0]!, out[out.length - 1]!)) out.pop();
  if (out.length < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < out.length; index++) {
    const a = out[index]!;
    const b = out[(index + 1) % out.length]!;
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  // In grid coordinates this is the same cutoff as SNAP² in world coordinates.
  if (Math.abs(twiceArea) <= 1) return null;
  return out;
}

function cleanGridPolygon(polygon: Polygon): GridPolygon | null {
  const outer = cleanGridRing(polygon[0] ?? []);
  if (!outer) return null;
  const holes = polygon.slice(1).map(cleanGridRing).filter((ring): ring is GridRing => ring !== null);
  return [outer, ...holes];
}

function toGridMulti(multi: MultiPolygon): GridMulti {
  return multi.map(cleanGridPolygon).filter((polygon): polygon is GridPolygon => polygon !== null);
}

function fromGridMulti(multi: GridMulti): MultiPolygon {
  return multi.map((polygon) =>
    polygon.map((ring) => ring.map(([x, y]) => ({ x: fromGridCoordinate(x), y: fromGridCoordinate(y) })))
  );
}

const gridPointOnSegment = (point: GridPoint, a: GridPoint, b: GridPoint): boolean => {
  const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  return cross === 0 &&
    point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1]);
};

function splitGridRingAtVertices(ring: GridRing, vertices: readonly GridPoint[]): GridRing {
  const split: GridRing = [];
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!;
    const b = ring[(index + 1) % ring.length]!;
    const onEdge: GridPoint[] = [];
    for (const vertex of vertices) {
      if (sameGridPoint(a, vertex) || sameGridPoint(b, vertex)) continue;
      if (gridPointOnSegment(vertex, a, b)) onEdge.push(vertex);
    }
    onEdge.sort((left, right) => {
      const leftDx = left[0] - a[0];
      const leftDy = left[1] - a[1];
      const rightDx = right[0] - a[0];
      const rightDy = right[1] - a[1];
      const along = leftDx * leftDx + leftDy * leftDy - (rightDx * rightDx + rightDy * rightDy);
      return along || left[0] - right[0] || left[1] - right[1];
    });
    split.push(a);
    for (const vertex of onEdge) {
      const previous = split[split.length - 1];
      if (!previous || !sameGridPoint(previous, vertex)) split.push(vertex);
    }
  }
  if (split.length > 1 && sameGridPoint(split[0]!, split[split.length - 1]!)) split.pop();
  return split;
}

/**
 * Snap, clean, and make implicit vertex-on-edge contacts between two targeted
 * boolean operands explicit in both directions. Canonicalization deliberately
 * runs in integer SNAP-grid space: it sees exactly the topology later consumed
 * by polygon-clipping, including contacts created by snapping.
 *
 * Every outer and hole ring is split in its existing polygon/ring order, so
 * winding and outer-hole ownership are preserved. Degenerate snapped outer
 * rings remove their polygon; degenerate holes are discarded, matching every
 * boolean operation's operand cleaning.
 */
export function canonicalizeBooleanOperands(
  first: MultiPolygon,
  second: MultiPolygon
): [first: MultiPolygon, second: MultiPolygon] {
  const cleanFirst = toGridMulti(first);
  const cleanSecond = toGridMulti(second);
  const firstVertices = cleanFirst.flatMap((polygon) => polygon.flat());
  const secondVertices = cleanSecond.flatMap((polygon) => polygon.flat());
  return [
    fromGridMulti(cleanFirst.map((polygon) => polygon.map((ring) => splitGridRingAtVertices(ring, secondVertices)))),
    fromGridMulti(cleanSecond.map((polygon) => polygon.map((ring) => splitGridRingAtVertices(ring, firstVertices))))
  ];
}

/**
 * Subtract one ring from each bbox-relevant polygon in isolation. Independent
 * polygons must not share a sweep: unrelated ring events can otherwise affect
 * enclosure classification. Outputs stay grouped in source-polygon order, and
 * polygons outside the target bbox pass through verbatim with their holes.
 */
export function subtractPieceFromMulti(base: MultiPolygon, pieceRing: Ring): MultiPolygon {
  if (base.length === 0 || pieceRing.length < 3) return base;
  const pieceBounds = ringBounds(pieceRing);
  let result: MultiPolygon | null = null;
  for (let index = 0; index < base.length; index++) {
    const polygon = base[index]!;
    const outer = polygon[0];
    if (!outer || outer.length < 3 || !rectsIntersect(pieceBounds, ringBounds(outer))) {
      if (result) result.push(polygon);
      continue;
    }
    if (!result) result = base.slice(0, index);
    const [canonicalBase, canonicalPiece] = canonicalizeBooleanOperands([polygon], ringAsMulti(pieceRing));
    result.push(...difference(canonicalBase, [canonicalPiece]));
  }
  return result ?? base;
}

/**
 * Intersect one ring with each bbox-relevant polygon in isolation, flattening
 * each result immediately so polygon and hole ownership cannot cross operands.
 */
export function intersectMultiWithRing(base: MultiPolygon, ring: Ring): MultiPolygon {
  if (base.length === 0 || ring.length < 3) return [];
  const bounds = ringBounds(ring);
  const result: MultiPolygon = [];
  for (const polygon of base) {
    const outer = polygon[0];
    if (!outer || outer.length < 3 || !rectsIntersect(bounds, ringBounds(outer))) continue;
    const [canonicalBase, canonicalRing] = canonicalizeBooleanOperands([polygon], ringAsMulti(ring));
    result.push(...intersection(canonicalBase, canonicalRing));
  }
  return result;
}

/**
 * True when an overlay result is below the pipeline's snap precision: its mean
 * thickness is at most SNAP (or its area is below the absolute floor), so it is
 * numeric noise between polygons that share a boundary, not a real overlap.
 * WHY: validation gates re-intersect recomputed cuts against stored rings, and a
 * re-snapped cut deviates by up to SNAP, so any absolute area threshold smaller
 * than SNAP × shared-length rejects legitimate adjacent districts.
 */
export function isSnapNoise(multi: MultiPolygon): boolean {
  let area = 0;
  let perimeter = 0;
  for (const polygon of multi) {
    for (let index = 0; index < polygon.length; index++) {
      const ring = polygon[index]!;
      area += (index === 0 ? 1 : -1) * Math.abs(ringArea(ring));
      perimeter += ringPerimeter(ring);
    }
  }
  return area <= Math.max(OVERLAP_AREA_FLOOR_M2, SNAP * perimeter);
}

type PCRing = [number, number][];
type PCMulti = PCRing[][];

function toPC(multi: MultiPolygon): PCMulti {
  return toGridMulti(multi).map((polygon) =>
    polygon.map((ring) => {
      const closed: PCRing = ring.map(([x, y]) => [x, y]);
      const first = closed[0]!;
      closed.push([first[0], first[1]]);
      return closed;
    })
  );
}

/**
 * Integer inputs still produce rational intersections. Normalize only sweep
 * arithmetic noise (one millionth of a grid cell = one nanometre in world
 * space), rather than rounding genuine intersections to integer vertices.
 * This is far below SNAP while making repeated intersection coordinates
 * bit-identical before closure removal and deduplication.
 */
const PC_RESULT_QUANTUM = 1e-6;
const quantizePCCoordinate = (value: number): number =>
  Number.isInteger(value) ? value || 0 : Math.round(value / PC_RESULT_QUANTUM) * PC_RESULT_QUANTUM || 0;
const quantizePCPoint = ([x, y]: [number, number]): GridPoint => [
  quantizePCCoordinate(x),
  quantizePCCoordinate(y)
];

function cleanPCResultRing(ring: PCRing): PCRing | null {
  const out: PCRing = [];
  for (const point of ring) {
    const next = quantizePCPoint(point);
    const previous = out[out.length - 1];
    if (!previous || !sameGridPoint(previous, next)) out.push(next);
  }
  // polygon-clipping closes its rings; our convention leaves them implicit.
  // Compare after result-space quantization because independently calculated
  // closing events need not start bit-identical.
  if (out.length > 1 && sameGridPoint(out[0]!, out[out.length - 1]!)) out.pop();
  if (out.length < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < out.length; index++) {
    const a = out[index]!;
    const b = out[(index + 1) % out.length]!;
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(twiceArea) <= 1) return null;
  return out;
}

function fromPC(mp: PCMulti): MultiPolygon {
  const cleaned: PCMulti = [];
  for (const polygon of mp) {
    const outer = cleanPCResultRing(polygon[0] ?? []);
    if (!outer) continue;
    const holes = polygon.slice(1).map(cleanPCResultRing).filter((ring): ring is PCRing => ring !== null);
    cleaned.push([outer, ...holes]);
  }
  return cleaned.map((polygon) =>
    polygon.map((ring) => ring.map(([x, y]) => ({ x: fromGridCoordinate(x), y: fromGridCoordinate(y) })))
  );
}

function unionPC(parts: PCMulti[]): PCMulti {
  const [first, ...rest] = parts;
  return first ? polygonClipping.union(first, ...rest) : [];
}

export function union(parts: MultiPolygon[]): MultiPolygon {
  const usable = parts.map(toPC).filter((part) => part.length > 0);
  if (usable.length === 0) return [];
  return fromPC(unionPC(usable));
}

export function difference(base: MultiPolygon, cuts: MultiPolygon[]): MultiPolygon {
  if (cuts.length === 0) return base;
  const cleanBase = toPC(base);
  if (cleanBase.length === 0) return [];
  const usable = cuts.map(toPC).filter((part) => part.length > 0);
  if (usable.length === 0) return fromPC(cleanBase);
  return fromPC(polygonClipping.difference(cleanBase, ...usable));
}

export function intersection(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  const cleanA = toPC(a);
  const cleanB = toPC(b);
  if (cleanA.length === 0 || cleanB.length === 0) return [];
  return fromPC(polygonClipping.intersection(cleanA, cleanB));
}

export const asMulti = (polygon: Polygon): MultiPolygon => [polygon];
export const ringAsMulti = (ring: Ring): MultiPolygon => [[ring]];
