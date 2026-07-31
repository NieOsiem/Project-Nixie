import { KIND, MeshBuilder, type MeshBuffers } from "./mesh.js";
import { triangulate } from "./tessellate.js";
import { ringArea, ringCentroid, type Ring, type Vec2 } from "./types.js";

export interface BuildingSpec {
  /** Footprint in world pixels. Winding is normalised internally. */
  footprint: Ring;
  /** Height in metres. Stays in metres so geometry survives a grid-size change. */
  height: number;
  roofMaterial: number;
  wallMaterial: number;
  /** 0..1 building hash. Picks the facade style and seeds its per-cell hashes. */
  seed: number;
}

/** Direction the key light arrives from, in world space (y grows downward). */
export const LIGHT_DIRECTION: Vec2 = { x: -0.5547, y: -0.8321 };
export const SHADOW_LENGTH = 0.65;
export const SHADE_MIN = 0.32;
export const SHADE_MAX = 0.72;
export const ROOF_SHADE = 1;

function supportsRoofStructures(poly: Ring): boolean {
  if (poly.length !== 4) return false;
  return poly.every((p, i) => {
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const next = poly[(i + 1) % poly.length]!;
    const ax = prev.x - p.x;
    const ay = prev.y - p.y;
    const bx = next.x - p.x;
    const by = next.y - p.y;
    const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return scale > 0 && Math.abs(ax * bx + ay * by) / scale < 0.2;
  });
}

/**
 * Normalise winding so `ringArea` is positive, which makes (dy, -dx) the outward edge
 * normal. Avoids reasoning about clockwise-ness in a y-down coordinate system, where
 * the visual and mathematical senses are opposite.
 */
export function withPositiveArea(ring: Ring): Ring {
  return ringArea(ring) < 0 ? [...ring].reverse() : ring;
}

/** Lambert-ish shade for a wall, from the outward normal of one footprint edge. */
export function wallShade(edgeStart: Vec2, edgeEnd: Vec2): number {
  const dx = edgeEnd.x - edgeStart.x;
  const dy = edgeEnd.y - edgeStart.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return SHADE_MIN;

  const nx = dy / len;
  const ny = -dx / len;
  const facing = 0.5 + 0.5 * (nx * LIGHT_DIRECTION.x + ny * LIGHT_DIRECTION.y);
  return SHADE_MIN + (SHADE_MAX - SHADE_MIN) * facing;
}

/** Footprint is world pixels, height is metres, so wall-U needs the scene's scale. */
export function extrudeBuilding(spec: BuildingSpec, pixelsPerMetre: number): MeshBuffers {
  const poly = withPositiveArea(spec.footprint);
  const n = poly.length;
  if (n < 3) throw new Error(`Footprint needs at least 3 points, got ${n}.`);

  const builder = new MeshBuilder(n * 5, n * 3 - 2);
  const { height, seed } = spec;
  const centre = ringCentroid(poly);
  let roofAngle = 0;
  let longestEdge = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= longestEdge) continue;
    longestEdge = length;
    roofAngle = Math.atan2(dy, dx);
  }
  const ux = Math.cos(roofAngle);
  const uy = Math.sin(roofAngle);
  let halfWidthPx = 0;
  let halfHeightPx = 0;
  for (const p of poly) {
    const dx = p.x - centre.x;
    const dy = p.y - centre.y;
    halfWidthPx = Math.max(halfWidthPx, Math.abs(dx * ux + dy * uy));
    halfHeightPx = Math.max(halfHeightPx, Math.abs(-dx * uy + dy * ux));
  }
  const halfWidthM = halfWidthPx / pixelsPerMetre;
  const halfHeightM = halfHeightPx / pixelsPerMetre;
  const roofHalfHeight = supportsRoofStructures(poly) ? halfHeightM : -Math.max(halfHeightM, 1e-6);

  const roof = triangulate([poly]);
  const roofBase = builder.vertexCount;
  for (const p of roof.positions) {
    builder.vertex(
      p.x,
      p.y,
      height,
      spec.roofMaterial,
      roofHalfHeight,
      KIND.ROOF,
      halfWidthM,
      roofAngle,
      seed,
      centre.x,
      centre.y
    );
  }
  for (let i = 0; i < roof.indices.length; i += 3) {
    builder.triangle(
      roofBase + roof.indices[i]!,
      roofBase + roof.indices[i + 1]!,
      roofBase + roof.indices[i + 2]!
    );
  }

  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const shade = wallShade(a, b);
    const w = spec.wallMaterial;
    const end = Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMetre;

    const base = builder.vertex(a.x, a.y, 0, w, shade, KIND.WALL, 0, height, seed);
    builder.vertex(b.x, b.y, 0, w, shade, KIND.WALL, end, height, seed);
    builder.vertex(b.x, b.y, height, w, shade, KIND.WALL, end, height, seed);
    builder.vertex(a.x, a.y, height, w, shade, KIND.WALL, 0, height, seed);

    builder.triangle(base, base + 1, base + 2);
    builder.triangle(base, base + 2, base + 3);
  }

  return builder.build();
}
