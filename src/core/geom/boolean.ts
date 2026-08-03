import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon, Ring } from "./types.js";

/**
 * Collapse float noise so points that ought to coincide actually do. Road quads meeting
 * at a node are computed from different edge normals, and the junction discs are
 * trigonometric — without snapping, the boolean pass produces sliver artefacts.
 */
const SNAP = 1e-3;

const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

type PCRing = [number, number][];
type PCMulti = PCRing[][];

function cleanRing(ring: Ring): PCRing | null {
  const out: PCRing = [];
  for (const point of ring) {
    const next: [number, number] = [snap(point.x), snap(point.y)];
    const previous = out[out.length - 1];
    if (previous && previous[0] === next[0] && previous[1] === next[1]) continue;
    out.push(next);
  }
  if (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
  }
  if (out.length < 3) return null;
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    const b = out[(i + 1) % out.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) <= SNAP * SNAP) return null;
  const first = out[0]!;
  out.push([first[0], first[1]]);
  return out;
}

function cleanPolygon(polygon: Polygon): PCRing[] | null {
  const outer = cleanRing(polygon[0] ?? []);
  if (!outer) return null;
  const holes = polygon.slice(1).map(cleanRing).filter((ring): ring is PCRing => ring !== null);
  return [outer, ...holes];
}

function toPC(mp: MultiPolygon): PCMulti {
  return mp.map(cleanPolygon).filter((polygon): polygon is PCRing[] => polygon !== null);
}

function fromPC(mp: PCMulti): MultiPolygon {
  return mp.map((polygon) =>
    polygon.map((ring) => {
      // polygon-clipping closes its rings; our convention leaves them implicit.
      const points: Ring = ring.map(([x, y]) => ({ x, y }));
      const first = points[0];
      const last = points[points.length - 1];
      if (points.length > 1 && first && last && first.x === last.x && first.y === last.y) points.pop();
      return points;
    })
  );
}

function unionPC(parts: PCMulti[]): PCMulti {
  const [first, ...rest] = parts;
  if (!first) return [];
  try {
    return polygonClipping.union(first, ...rest);
  } catch (firstError) {
    // WHY: polygon-clipping's n-way sweep can lose coincident events on valid snapped corridors; pairwise union preserves the same topology.
    let aggregate = first;
    try {
      for (const part of rest) aggregate = polygonClipping.union(aggregate, part);
    } catch {
      throw firstError;
    }
    return aggregate;
  }
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
