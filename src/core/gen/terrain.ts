import { hash2 } from "./hash.js";
import { rectRing, ringArea, type Rect, type Ring, type Vec2 } from "../geom/types.js";

export type TerrainMode = "rectangle" | "coastal" | "custom";
export type CoastEdge = "north" | "east" | "south" | "west";

export interface TerrainGeneration {
  terrainMode: TerrainMode;
  coastEdge: CoastEdge | null;
}

export interface TerrainSource {
  land: Ring;
  urbanFootprint: Ring | null;
}

export interface CitySourceV2 {
  origin: Vec2;
  citySeed: string;
  generation: TerrainGeneration;
  terrain: TerrainSource;
}

export interface CityStateV2 {
  kind: "city-generator-2";
  schemaVersion: 1;
  generatorVersion: number;
  revision: number;
  source: CitySourceV2;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** The tolerance is in square metres; geometry smaller than this is not useful terrain. */
export const RING_AREA_EPSILON = 1e-6;
const GEOMETRY_EPSILON = 1e-9;

function samePoint(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (Math.abs(cross(a, b, p)) > GEOMETRY_EPSILON) return false;
  return (
    p.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON &&
    p.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON &&
    p.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON &&
    p.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON
  );
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  const opposite =
    ((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
      (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON));
  return (
    opposite ||
    (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d))
  );
}

function pointInOrOnRing(p: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (pointOnSegment(p, a, b)) return true;
    if ((a.y > p.y) !== (b.y > p.y)) {
      const atX = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < atX) inside = !inside;
    }
  }
  return inside;
}

/** Remove an optional repeated closure and normalize to the positive winding. */
export function normalizeRing(ring: Ring): Ring {
  const out = ring.map((p) => ({ x: p.x, y: p.y }));
  while (out.length > 1 && samePoint(out[0]!, out[out.length - 1]!)) out.pop();
  if (ringArea(out) < 0) out.reverse();
  return out;
}

export function validateRing(ring: Ring): ValidationResult {
  if (!Array.isArray(ring)) return { ok: false, reason: "Ring must be an array." };
  if (ring.length < 3) return { ok: false, reason: "Ring needs at least three vertices." };
  if (ring.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return { ok: false, reason: "Ring vertices must have finite coordinates." };
  }

  const normalized = normalizeRing(ring);
  if (normalized.length < 3) return { ok: false, reason: "Ring needs at least three distinct vertices." };
  for (let i = 0; i < normalized.length; i++) {
    if (samePoint(normalized[i]!, normalized[(i + 1) % normalized.length]!)) {
      return { ok: false, reason: "Ring has repeated consecutive vertices." };
    }
  }
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (samePoint(normalized[i]!, normalized[j]!)) {
        return { ok: false, reason: "Ring repeats a vertex." };
      }
    }
  }

  const area = Math.abs(ringArea(normalized));
  if (!Number.isFinite(area) || area <= RING_AREA_EPSILON) {
    return { ok: false, reason: `Ring area must exceed ${RING_AREA_EPSILON} square metres.` };
  }

  for (let i = 0; i < normalized.length; i++) {
    const a = normalized[i]!;
    const b = normalized[(i + 1) % normalized.length]!;
    for (let j = i + 1; j < normalized.length; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === normalized.length - 1);
      if (adjacent) continue;
      if (segmentsIntersect(a, b, normalized[j]!, normalized[(j + 1) % normalized.length]!)) {
        return { ok: false, reason: "Ring self-intersects or self-touches." };
      }
    }
  }
  return { ok: true };
}

function edgeCrossesOutside(land: Ring, a: Vec2, b: Vec2): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const cuts = [0, 1];
  for (let i = 0; i < land.length; i++) {
    const c = land[i]!;
    const d = land[(i + 1) % land.length]!;
    const sx = d.x - c.x;
    const sy = d.y - c.y;
    const denominator = dx * sy - dy * sx;
    const qx = c.x - a.x;
    const qy = c.y - a.y;
    if (Math.abs(denominator) > GEOMETRY_EPSILON) {
      const t = (qx * sy - qy * sx) / denominator;
      const u = (qx * dy - qy * dx) / denominator;
      if (
        t >= -GEOMETRY_EPSILON &&
        t <= 1 + GEOMETRY_EPSILON &&
        u >= -GEOMETRY_EPSILON &&
        u <= 1 + GEOMETRY_EPSILON
      ) {
        cuts.push(Math.max(0, Math.min(1, t)));
      }
      continue;
    }
    if (Math.abs(qx * dy - qy * dx) > GEOMETRY_EPSILON) continue;
    cuts.push(((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSquared);
    cuts.push(((d.x - a.x) * dx + (d.y - a.y) * dy) / lengthSquared);
  }
  const sorted = cuts
    .filter((t) => t >= 0 && t <= 1)
    .sort((left, right) => left - right)
    .filter((t, index, values) => index === 0 || Math.abs(t - values[index - 1]!) > GEOMETRY_EPSILON);
  for (let i = 0; i < sorted.length - 1; i++) {
    const t = (sorted[i]! + sorted[i + 1]!) / 2;
    if (!pointInOrOnRing({ x: a.x + dx * t, y: a.y + dy * t }, land)) return true;
  }
  return false;
}

export function validateTerrain(terrain: TerrainSource): ValidationResult {
  const land = validateRing(terrain.land);
  if (!land.ok) return { ok: false, reason: `Land: ${land.reason}` };
  if (terrain.urbanFootprint === null) return { ok: true };

  const footprint = validateRing(terrain.urbanFootprint);
  if (!footprint.ok) return { ok: false, reason: `Urban footprint: ${footprint.reason}` };
  const landRing = normalizeRing(terrain.land);
  const urbanRing = normalizeRing(terrain.urbanFootprint);
  if (urbanRing.some((p) => !pointInOrOnRing(p, landRing))) {
    return { ok: false, reason: "Urban footprint must be contained in land." };
  }
  for (let i = 0; i < urbanRing.length; i++) {
    const a = urbanRing[i]!;
    const b = urbanRing[(i + 1) % urbanRing.length]!;
    if (edgeCrossesOutside(landRing, a, b)) {
      return { ok: false, reason: "Urban footprint crosses outside land." };
    }
  }
  return { ok: true };
}

export function normalizeCitySeed(seed: string): string {
  if (typeof seed !== "string") throw new Error("City seed must be text.");
  const normalized = seed.trim();
  if (normalized.length === 0) throw new Error("City seed must not be empty.");
  return normalized;
}

/** Stable integer derivation from text and an independent stream label. */
export function deriveLabelledSeed(citySeed: string, label: string): number {
  const seed = normalizeCitySeed(citySeed);
  if (typeof label !== "string" || label.length === 0) throw new Error("Seed label must not be empty.");
  let h = 0x811c9dc5;
  const text = `${seed}\u0000${label}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rectangleLand(bounds: Rect): Ring {
  const x = Math.min(bounds.x, bounds.x + bounds.width);
  const y = Math.min(bounds.y, bounds.y + bounds.height);
  const width = Math.abs(bounds.width);
  const height = Math.abs(bounds.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
    throw new Error("Rectangle bounds must be finite and non-empty.");
  }
  return rectRing({ x, y, width, height });
}

function coastDepths(seed: number, count: number, span: number): number[] {
  const depth = Math.min(span * 0.22, span * 0.35);
  return Array.from({ length: count }, (_, i) => {
    if (i === 0 || i === count - 1) return 0;
    const t = i / (count - 1);
    return depth * (0.72 + hash2(i, 17, seed) * 0.56) * Math.sin(Math.PI * t);
  });
}

export function coastalLand(bounds: Rect, citySeed: string, edge: CoastEdge): Ring {
  const x = Math.min(bounds.x, bounds.x + bounds.width);
  const y = Math.min(bounds.y, bounds.y + bounds.height);
  const width = Math.abs(bounds.width);
  const height = Math.abs(bounds.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
    throw new Error("Coastal bounds must be finite and non-empty.");
  }
  const seed = deriveLabelledSeed(citySeed, "terrain");
  const count = 8;
  const depths = coastDepths(seed, count, Math.min(width, height));
  const coast: Ring = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const d = depths[i]!;
    if (edge === "north") coast.push({ x: x + width * t, y: y + d });
    else if (edge === "south") coast.push({ x: x + width * (1 - t), y: y + height - d });
    else if (edge === "east") coast.push({ x: x + width - d, y: y + height * t });
    else if (edge === "west") coast.push({ x: x + d, y: y + height * (1 - t) });
    else throw new Error(`Unknown coast edge: ${String(edge)}`);
  }

  if (edge === "north") return normalizeRing([...coast, { x: x + width, y: y + height }, { x, y: y + height }]);
  if (edge === "south") return normalizeRing([{ x, y }, { x: x + width, y }, ...coast]);
  if (edge === "east") return normalizeRing([{ x, y }, ...coast, { x, y: y + height }]);
  return normalizeRing([{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, ...coast]);
}

export function generationMask(source: TerrainSource | CitySourceV2): Ring {
  const terrain = "terrain" in source ? source.terrain : source;
  return terrain.urbanFootprint ?? terrain.land;
}
