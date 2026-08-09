import { simplifyRing } from "../geom/simplify.js";
import type { MultiPolygon, Vec2 } from "../geom/types.js";

/** Integer endpoints, because the Wall document schema requires integer coordinates. */
export interface WallSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WallOptions {
  /** Douglas-Peucker tolerance in world pixels. */
  tolerancePx: number;
}

export interface MetreWallOptions {
  origin: Vec2;
  pixelsPerMetre: number;
  toleranceM?: number;
}

function roundAndDedupe(ring: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of ring) {
    const q = { x: Math.round(p.x), y: Math.round(p.y) };
    const prev = out[out.length - 1];
    if (prev && prev.x === q.x && prev.y === q.y) continue;
    out.push(q);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first.x === last.x && first.y === last.y) out.pop();
  return out;
}

/**
 * Wall the perimeter of every block, not every building.
 *
 * The block boundary is the line between paved corridor and buildable land, so one loop
 * per block replaces one loop per building — the difference between hundreds of Wall
 * documents and thousands. Alleys inside a block become decorative rather than walkable,
 * which is the trade the wall budget demands.
 */
export function wallSegmentsFromBlocks(
  blocks: MultiPolygon,
  options: WallOptions
): WallSegment[] {
  const segments: WallSegment[] = [];

  for (const polygon of blocks) {
    for (const ring of polygon) {
      const points = roundAndDedupe(simplifyRing(ring, options.tolerancePx));
      if (points.length < 3) continue;

      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        if (a.x === b.x && a.y === b.y) continue;
        segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
  }

  return segments;
}

export function wallSegmentsFromMetreCells(cells: MultiPolygon, options: MetreWallOptions): WallSegment[] {
  if (!Number.isFinite(options.pixelsPerMetre) || options.pixelsPerMetre <= 0) throw new Error("Pixels per metre must be positive and finite.");
  if (!Number.isFinite(options.origin.x) || !Number.isFinite(options.origin.y)) throw new Error("Wall origin must be finite.");
  const toleranceM = options.toleranceM ?? 1;
  if (!Number.isFinite(toleranceM) || toleranceM < 0) throw new Error("Wall simplification tolerance must be finite and non-negative.");
  const segments: WallSegment[] = [];
  for (const polygon of cells) {
    for (const ring of polygon) {
      const metres = simplifyRing(ring, toleranceM);
      const pixels = metres.map((point) => ({
        x: options.origin.x + point.x * options.pixelsPerMetre,
        y: options.origin.y + point.y * options.pixelsPerMetre
      }));
      const points = roundAndDedupe(pixels);
      if (points.length < 3) continue;
      for (let index = 0; index < points.length; index++) {
        const a = points[index]!;
        const b = points[(index + 1) % points.length]!;
        if (a.x !== b.x || a.y !== b.y) segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }
  }
  return segments;
}

export function totalWallLength(segments: WallSegment[]): number {
  return segments.reduce((sum, s) => sum + Math.hypot(s.x2 - s.x1, s.y2 - s.y1), 0);
}
