import type { BuildingSpec } from "../geom/extrude.js";
import { KIND, MeshBuilder, type MeshBuffers } from "../geom/mesh.js";
import { ringCentroid } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, materialIndex } from "../palette.js";
import { hash2 } from "./hash.js";

/**
 * Padding around a sign's own rectangle, in metres. The falloff happens in the fragment
 * shader inside this padding, so a 3 x 1.5 m sign occupies a 7 x 5.5 m quad.
 *
 * WHY: this is the fill-rate dial. Neon cost scales with glow area, not light count
 * (HANDOFF §3 rule 1), so every metre added here is paid on every sign in the city.
 */
export const GLOW_MARGIN_M = 2;
/** Largest half-extent a rooftop strip's bright core reaches from the roof centroid. */
export const BEACON_CORE_MAX_M = 4;

const FACADE_RATE = 0.3;
const FACADE_MIN_BUILDING_M = 6;
const SIGN_MIN_W_M = 2;
const SIGN_MAX_W_M = 4.5;
const SIGN_MIN_H_M = 1;
const SIGN_MAX_H_M = 2;
const SIGN_LOW_M = 0.35;
const SIGN_HIGH_M = 0.85;

const BEACON_RATE = 0.45;
const BEACON_MIN_BUILDING_M = 30;
/** Fraction of the roof's long axis the lit bar spans. */
const STRIP_SPAN = 0.55;
const STRIP_HALF_WIDTH_M = 0.9;

const STRENGTH_SPREAD = 0.6;
const FACADE_STRENGTH = 0.7;
const BEACON_STRENGTH = 1;

/** Local quad coords, one per corner: (-1,-1) (1,-1) (1,1) (-1,1). */
const LOCAL_U = [-1, 1, 1, -1];
const LOCAL_V = [-1, -1, 1, 1];

interface Corner {
  x: number;
  y: number;
  h: number;
}

interface NeonQuad {
  corners: Corner[];
  material: number;
  strength: number;
}

/** Independent draws from one building's 0..1 seed. `hash2` wants integers. */
const roll = (seed: number, salt: number): number => hash2(Math.round(seed * 0x3fffffff), salt);

/**
 * Retint for free: wall materials are absolute banked indices, so dividing one out gives
 * the building's district bank and the sign inherits that district's neon slots.
 */
function neonMaterial(spec: BuildingSpec, salt: number): number {
  const bank = Math.floor(spec.wallMaterial / BANK_SIZE);
  const slot = roll(spec.seed, salt) < 0.5 ? DISTRICT_SLOT.NEON_A : DISTRICT_SLOT.NEON_B;
  return materialIndex(bank, slot);
}

/** A glowing bar mounted on one wall edge, clamped to fit that edge. */
function facadeSign(spec: BuildingSpec, pixelsPerMetre: number): NeonQuad | null {
  if (roll(spec.seed, 1) >= FACADE_RATE) return null;
  if (spec.height < FACADE_MIN_BUILDING_M) return null;

  const ring = spec.footprint;
  const n = ring.length;
  if (n < 3) return null;

  const minSpanM = SIGN_MIN_W_M + 2 * GLOW_MARGIN_M;
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) >= minSpanM * pixelsPerMetre) candidates.push(i);
  }
  if (candidates.length === 0) return null;

  const pick = Math.min(candidates.length - 1, Math.floor(roll(spec.seed, 2) * candidates.length));
  const a = ring[candidates[pick]!]!;
  const b = ring[(candidates[pick]! + 1) % n]!;
  const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
  const lenM = lenPx / pixelsPerMetre;

  const widthM = Math.min(
    SIGN_MIN_W_M + roll(spec.seed, 3) * (SIGN_MAX_W_M - SIGN_MIN_W_M),
    lenM - 2 * GLOW_MARGIN_M
  );
  const halfWM = widthM / 2 + GLOW_MARGIN_M;
  const halfHM = (SIGN_MIN_H_M + roll(spec.seed, 4) * (SIGN_MAX_H_M - SIGN_MIN_H_M)) / 2 + GLOW_MARGIN_M;

  const ux = (b.x - a.x) / lenPx;
  const uy = (b.y - a.y) / lenPx;
  const alongPx = (halfWM + roll(spec.seed, 5) * (lenM - 2 * halfWM)) * pixelsPerMetre;
  const halfWPx = halfWM * pixelsPerMetre;
  const x0 = a.x + ux * (alongPx - halfWPx);
  const y0 = a.y + uy * (alongPx - halfWPx);
  const x1 = a.x + ux * (alongPx + halfWPx);
  const y1 = a.y + uy * (alongPx + halfWPx);

  // Clamped so the padded quad never reaches below ground on a low building.
  const centreH = Math.max(
    halfHM,
    (SIGN_LOW_M + roll(spec.seed, 6) * (SIGN_HIGH_M - SIGN_LOW_M)) * spec.height
  );

  return {
    corners: [
      { x: x0, y: y0, h: centreH - halfHM },
      { x: x1, y: y1, h: centreH - halfHM },
      { x: x1, y: y1, h: centreH + halfHM },
      { x: x0, y: y0, h: centreH + halfHM }
    ],
    material: neonMaterial(spec, 8),
    strength: FACADE_STRENGTH + roll(spec.seed, 9) * STRENGTH_SPREAD
  };
}

/**
 * A lit bar lying on the roof, aligned to the building's longest footprint edge.
 *
 * WHY oriented rather than axis-aligned: this used to be a world-axis square, which read as
 * a glowing sticker pasted on the roof because it ignored the building underneath it
 * entirely. Following the footprint makes it read as rooftop signage.
 */
function rooftopStrip(spec: BuildingSpec, pixelsPerMetre: number): NeonQuad | null {
  if (spec.height < BEACON_MIN_BUILDING_M) return null;
  if (roll(spec.seed, 10) >= BEACON_RATE) return null;

  const ring = spec.footprint;
  const n = ring.length;
  if (n < 3) return null;

  let ux = 1;
  let uy = 0;
  let longest = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= longest) continue;
    longest = len;
    ux = (b.x - a.x) / len;
    uy = (b.y - a.y) / len;
  }
  if (longest <= 0) return null;

  const halfLenM = Math.min(BEACON_CORE_MAX_M, (longest * STRIP_SPAN) / (2 * pixelsPerMetre));
  if (halfLenM <= 0) return null;

  const alongPx = (halfLenM + GLOW_MARGIN_M) * pixelsPerMetre;
  const acrossPx = (STRIP_HALF_WIDTH_M + GLOW_MARGIN_M) * pixelsPerMetre;
  const c = ringCentroid(ring);
  const corner = (s: number, t: number): Corner => ({
    x: c.x + ux * alongPx * s - uy * acrossPx * t,
    y: c.y + uy * alongPx * s + ux * acrossPx * t,
    h: spec.height
  });

  return {
    corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    material: neonMaterial(spec, 11),
    strength: BEACON_STRENGTH + roll(spec.seed, 12) * STRENGTH_SPREAD
  };
}

/** Emits KIND.NEON quads for the buildings a chunk owns. Footprints are world pixels. */
export function neonMesh(buildings: BuildingSpec[], pixelsPerMetre: number): MeshBuffers {
  const quads: NeonQuad[] = [];
  for (const spec of buildings) {
    const facade = facadeSign(spec, pixelsPerMetre);
    if (facade !== null) quads.push(facade);
    const strip = rooftopStrip(spec, pixelsPerMetre);
    if (strip !== null) quads.push(strip);
  }

  const builder = new MeshBuilder(quads.length * 4, quads.length * 2);
  for (const quad of quads) {
    const base = builder.vertexCount;
    for (let i = 0; i < 4; i++) {
      const c = quad.corners[i]!;
      builder.vertex(
        c.x,
        c.y,
        c.h,
        quad.material,
        1,
        KIND.NEON,
        LOCAL_U[i]!,
        LOCAL_V[i]!,
        quad.strength
      );
    }
    builder.triangle(base, base + 1, base + 2);
    builder.triangle(base, base + 2, base + 3);
  }
  return builder.build();
}
