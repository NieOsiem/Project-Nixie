import {
  describeBuildingMassing,
  type BuildingMassing,
  type BuildingSpec
} from "../geom/extrude.js";
import { KIND, MeshBuilder, type MeshBuffers } from "../geom/mesh.js";
import type { Ring } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, materialIndex } from "../palette.js";
import { hash2 } from "./hash.js";

/**
 * Padding around a sign's own rectangle, in metres. The falloff happens in the fragment
 * shader inside this padding, so a 3 x 1.5 m sign occupies a 7 x 5.5 m quad.
 *
 * WHY: this is the fill-rate dial. Neon cost scales with glow area, not light count
 * (HANDOFF §3 rule 1), so every metre added here is paid on every sign in the city.
 *
 * The pad is absolute on both axes, which is why the shader needs the panel's own
 * half-extents to keep a bar shaped like a bar.
 */
export const GLOW_MARGIN_M = 2;
export const POOL_RADIUS_M = 30;
export const POOL_RATE = 1;

const FACADE_RATE = 0.75;
const FACADE_MIN_BUILDING_M = 6;

const SIGN_MIN_W_M = 2;
const SIGN_MAX_W_M = 4.5;
const SIGN_MIN_H_M = 1;
const SIGN_MAX_H_M = 2;

export const BILLBOARD_MIN_W_M = 8;
export const BILLBOARD_MAX_W_M = 15;
export const BILLBOARD_RATE = 0.18;
const BILLBOARD_MIN_BUILDING_M = 25;
const BILLBOARD_MIN_H_M = 3;
const BILLBOARD_MAX_H_M = 5;

export const BANNER_RATE = 0.5;
export const BANNER_MIN_BUILDING_M = 30;
const BANNER_MIN_W_M = 2;
const BANNER_MAX_W_M = 3.5;
const BANNER_MIN_H_M = 10;
const BANNER_MAX_H_M = 26;
const BANNER_MAX_FACADE_FRACTION = 0.6;
const BANNER_TOP_LOW = 0.55;
const BANNER_TOP_HIGH = 0.9;

/**
 * Horizontal signs live in the bottom band, never mid-facade.
 *
 * WHY: this camera squashes height by d(lean)/dh, which is zero at the pivot, so a 1.5 m
 * sign hung at 60 m projects to nothing and reads as a bare halo. The ground is the
 * surface with real screen area — down here a sign also lights the street.
 */
export const SIGN_BAND_TOP_M = 12;
const SIZE_RAMP_FULL_M = 60;

const POOL_MAX_SIGN_HEIGHT_M = 15;
const POOL_HEIGHT_M = 0.03;
const POOL_STRENGTH = 0.22;

const STRENGTH_SPREAD = 0.6;
const FACADE_STRENGTH = 0.7;

/** Brightest a panel can be, before the palette's own emissive strength. */
export const MAX_PANEL_STRENGTH = FACADE_STRENGTH + STRENGTH_SPREAD;

/** Local quad coords, one per corner: (-1,-1) (1,-1) (1,1) (-1,1). */
const LOCAL_U = [-1, 1, 1, -1];
const LOCAL_V = [-1, -1, 1, 1];

type SignKind = "sign" | "billboard" | "banner";

const MIN_WIDTH_M: Record<SignKind, number> = {
  sign: SIGN_MIN_W_M,
  billboard: BILLBOARD_MIN_W_M,
  banner: BANNER_MIN_W_M
};
const MAX_WIDTH_M: Record<SignKind, number> = {
  sign: SIGN_MAX_W_M,
  billboard: BILLBOARD_MAX_W_M,
  banner: BANNER_MAX_W_M
};

interface Corner {
  x: number;
  y: number;
  h: number;
}

interface NeonQuad {
  corners: Corner[];
  /** The panel's own half-extents in metres, i.e. the padded quad minus `GLOW_MARGIN_M`. */
  halfWidthM: number;
  halfHeightM: number;
  material: number;
  strength: number;
  radial: number;
}

/** Independent draws from one building's 0..1 seed. `hash2` wants integers. */
const roll = (seed: number, salt: number): number => hash2(Math.round(seed * 0x3fffffff), salt);

/**
 * Retint for free: wall materials are absolute banked indices, so dividing one out gives
 * the building's district bank and the sign inherits that district's neon slots.
 */
function neonMaterial(spec: BuildingSpec, salt: number): number {
  const bank = Math.floor(spec.wallMaterial / BANK_SIZE);
  const weights = spec.neonWeights ?? [0.5, 0.5];
  const slot =
    roll(spec.seed, salt) < weights[0]!
      ? DISTRICT_SLOT.NEON_A
      : DISTRICT_SLOT.NEON_B;
  return materialIndex(bank, slot);
}

/** Edges long enough to carry a padded panel of this width. */
function edgeCandidates(ring: Ring, minWidthM: number, pixelsPerMetre: number): number[] {
  const need = (minWidthM + 2 * GLOW_MARGIN_M) * pixelsPerMetre;
  const out: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) >= need) out.push(i);
  }
  return out;
}

/** A glowing panel mounted on one wall edge, clamped to fit that edge. */
function facadeSign(
  spec: BuildingSpec,
  massing: BuildingMassing,
  pixelsPerMetre: number
): NeonQuad | null {
  const facadeRate =
    spec.facadeRate === undefined || !Number.isFinite(spec.facadeRate)
      ? FACADE_RATE
      : Math.max(0, Math.min(1, spec.facadeRate));
  if (roll(spec.seed, 1) >= facadeRate) return null;
  const facadeHeight = massing.volumes[0]!.topHeight;
  if (facadeHeight < FACADE_MIN_BUILDING_M) return null;

  const ring = massing.volumes[0]!.footprint;
  if (ring.length < 3) return null;

  // Preference order, each falling through when no wall is long enough for it.
  const wanted: SignKind[] = [];
  if (facadeHeight >= BANNER_MIN_BUILDING_M && roll(spec.seed, 15) < BANNER_RATE) {
    wanted.push("banner");
  }
  if (facadeHeight >= BILLBOARD_MIN_BUILDING_M && roll(spec.seed, 14) < BILLBOARD_RATE) {
    wanted.push("billboard");
  }
  wanted.push("sign");

  let kind: SignKind | null = null;
  let candidates: number[] = [];
  for (const k of wanted) {
    candidates = edgeCandidates(ring, MIN_WIDTH_M[k], pixelsPerMetre);
    if (candidates.length > 0) {
      kind = k;
      break;
    }
  }
  if (kind === null) return null;

  const pick = Math.min(candidates.length - 1, Math.floor(roll(spec.seed, 2) * candidates.length));
  const a = ring[candidates[pick]!]!;
  const b = ring[(candidates[pick]! + 1) % ring.length]!;
  const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
  const lenM = lenPx / pixelsPerMetre;

  // A 3 m sign on a 100 m tower is a speck; bias the size roll upward with height.
  const sizeRamp = Math.min(1, facadeHeight / SIZE_RAMP_FULL_M);
  const size = Math.min(1, roll(spec.seed, 3) * 0.6 + 0.4 * sizeRamp);

  const widthM = Math.min(
    MIN_WIDTH_M[kind] + size * (MAX_WIDTH_M[kind] - MIN_WIDTH_M[kind]),
    lenM - 2 * GLOW_MARGIN_M
  );
  const heightM = panelHeightM(kind, spec, facadeHeight, size);
  const halfWM = widthM / 2 + GLOW_MARGIN_M;
  const halfHM = heightM / 2 + GLOW_MARGIN_M;

  const ux = (b.x - a.x) / lenPx;
  const uy = (b.y - a.y) / lenPx;
  const alongPx = (halfWM + roll(spec.seed, 5) * (lenM - 2 * halfWM)) * pixelsPerMetre;
  const halfWPx = halfWM * pixelsPerMetre;
  const x0 = a.x + ux * (alongPx - halfWPx);
  const y0 = a.y + uy * (alongPx - halfWPx);
  const x1 = a.x + ux * (alongPx + halfWPx);
  const y1 = a.y + uy * (alongPx + halfWPx);

  const centreH = panelCentreH(kind, spec, facadeHeight, halfHM);

  return {
    corners: [
      { x: x0, y: y0, h: centreH - halfHM },
      { x: x1, y: y1, h: centreH - halfHM },
      { x: x1, y: y1, h: centreH + halfHM },
      { x: x0, y: y0, h: centreH + halfHM }
    ],
    halfWidthM: widthM / 2,
    halfHeightM: heightM / 2,
    material: neonMaterial(spec, 8),
    strength: FACADE_STRENGTH + roll(spec.seed, 9) * STRENGTH_SPREAD,
    radial: 0
  };
}

function panelHeightM(
  kind: SignKind,
  spec: BuildingSpec,
  facadeHeight: number,
  size: number
): number {
  if (kind === "banner") {
    return Math.min(
      BANNER_MIN_H_M + roll(spec.seed, 4) * (BANNER_MAX_H_M - BANNER_MIN_H_M),
      facadeHeight * BANNER_MAX_FACADE_FRACTION
    );
  }
  const minH = kind === "billboard" ? BILLBOARD_MIN_H_M : SIGN_MIN_H_M;
  const maxH = kind === "billboard" ? BILLBOARD_MAX_H_M : SIGN_MAX_H_M;
  return minH + size * (maxH - minH);
}

/** Clamped so the padded quad stays between ground and roof. */
function panelCentreH(
  kind: SignKind,
  spec: BuildingSpec,
  facadeHeight: number,
  halfHM: number
): number {
  const ceiling = facadeHeight - halfHM;
  if (kind === "banner") {
    // Anchored by its top and hanging down — the shape that survives vertical squash and
    // the reason banners are exempt from the bottom band.
    const topH =
      (BANNER_TOP_LOW + roll(spec.seed, 6) * (BANNER_TOP_HIGH - BANNER_TOP_LOW)) * facadeHeight;
    return Math.min(ceiling, Math.max(halfHM, topH - halfHM));
  }
  const band = Math.max(halfHM, SIGN_BAND_TOP_M);
  return Math.min(ceiling, Math.max(halfHM, halfHM + roll(spec.seed, 6) * (band - halfHM)));
}

function groundPool(sign: NeonQuad, spec: BuildingSpec, pixelsPerMetre: number): NeonQuad | null {
  const poolRate =
    spec.poolRate === undefined || !Number.isFinite(spec.poolRate)
      ? POOL_RATE
      : Math.max(0, Math.min(1, spec.poolRate));
  if (roll(spec.seed, 13) >= poolRate) return null;
  // Keyed off the panel's bottom, not its centre: a banner earns a pool by reaching down
  // to the street, and every bottom-band sign already does.
  const bottomH = Math.min(...sign.corners.map((c) => c.h));
  if (bottomH > POOL_MAX_SIGN_HEIGHT_M) return null;

  const cx = sign.corners.reduce((sum, c) => sum + c.x, 0) / sign.corners.length;
  const cy = sign.corners.reduce((sum, c) => sum + c.y, 0) / sign.corners.length;
  const r = POOL_RADIUS_M * pixelsPerMetre;
  return {
    corners: [
      { x: cx - r, y: cy - r, h: POOL_HEIGHT_M },
      { x: cx + r, y: cy - r, h: POOL_HEIGHT_M },
      { x: cx + r, y: cy + r, h: POOL_HEIGHT_M },
      { x: cx - r, y: cy + r, h: POOL_HEIGHT_M }
    ],
    halfWidthM: POOL_RADIUS_M,
    halfHeightM: POOL_RADIUS_M,
    material: sign.material,
    strength: sign.strength * POOL_STRENGTH,
    radial: 1
  };
}

/**
 * Emits KIND.NEON quads for the buildings a chunk owns. Footprints are world pixels.
 * A mass whose grammar disabled neon contributes nothing here even when its signage
 * rate is high — the renderer gates its pass on these triangles, so an empty result
 * is a guaranteed zero-glow chunk.
 */
export function neonMesh(buildings: BuildingSpec[], pixelsPerMetre: number): MeshBuffers {
  const quads: NeonQuad[] = [];
  for (const spec of buildings) {
    if (spec.neonEnabled === false) continue;
    const massing = describeBuildingMassing(spec, pixelsPerMetre);
    const facade = facadeSign(spec, massing, pixelsPerMetre);
    if (facade !== null) {
      quads.push(facade);
      const pool = groundPool(facade, spec, pixelsPerMetre);
      if (pool !== null) quads.push(pool);
    }
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
        quad.radial,
        KIND.NEON,
        LOCAL_U[i]!,
        LOCAL_V[i]!,
        quad.strength,
        quad.halfWidthM,
        quad.halfHeightM
      );
    }
    builder.triangle(base, base + 1, base + 2);
    builder.triangle(base, base + 2, base + 3);
  }
  return builder.build();
}
