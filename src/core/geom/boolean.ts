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

function toPC(mp: MultiPolygon): PCMulti {
  return mp.map((polygon) =>
    polygon.map((ring) => {
      const out: PCRing = ring.map((p) => [snap(p.x), snap(p.y)]);
      const first = out[0];
      const last = out[out.length - 1];
      if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
      return out;
    })
  );
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

const isEmpty = (mp: MultiPolygon): boolean => mp.length === 0;

export function union(parts: MultiPolygon[]): MultiPolygon {
  const usable = parts.filter((p) => !isEmpty(p));
  if (usable.length === 0) return [];
  const [first, ...rest] = usable;
  return fromPC(polygonClipping.union(toPC(first!), ...rest.map(toPC)));
}

export function difference(base: MultiPolygon, cuts: MultiPolygon[]): MultiPolygon {
  if (isEmpty(base)) return [];
  const usable = cuts.filter((p) => !isEmpty(p));
  if (usable.length === 0) return base;
  return fromPC(polygonClipping.difference(toPC(base), ...usable.map(toPC)));
}

export function intersection(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (isEmpty(a) || isEmpty(b)) return [];
  return fromPC(polygonClipping.intersection(toPC(a), toPC(b)));
}

export const asMulti = (polygon: Polygon): MultiPolygon => [polygon];
export const ringAsMulti = (ring: Ring): MultiPolygon => [[ring]];
