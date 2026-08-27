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

// CRITIQUE #13: fewer but stronger environmental lights. Minor signs keep modest local
// pools (MIN_POOL_RADIUS_M..SMALL_POOL_MAX_RADIUS_M); major panels — billboards, banners,
// crowns — scale their radius with the panel's own reach up to MAX_POOL_RADIUS_M, so a
// handful of large sources visibly light the streetscape instead of many faint blobs.
export const MAX_POOL_RADIUS_M = 20;
export const MIN_POOL_RADIUS_M = 4;
const SMALL_POOL_MAX_RADIUS_M = 7;
const MAJOR_POOL_MIN_RADIUS_M = 8;
const MINOR_POOL_RADIUS_FACTOR = 1.5;
const MAJOR_POOL_RADIUS_FACTOR = 1.75;
// Minors pool at a fraction of their configured density. Majors scale too, but never
// drop below their own small floor: they are the rare, load-bearing light sources.
const MINOR_POOL_RATE_MULT = 0.16;
const MAJOR_POOL_RATE_MULT = 0.6;
const MAJOR_POOL_MIN_RATE = 0.15;
export const POOL_RATE = 0.4;
// A corner billboard may shove its pool centre toward the street by a seeded slice of
// the radius (fraction drawn from POOL_STREET_OFFSET_MIN_FRACTION..+SPAN). Salt 23 is
// new and independent of every existing stream.
const POOL_STREET_OFFSET_SALT = 23;
const POOL_STREET_OFFSET_MIN_FRACTION = 0.25;
const POOL_STREET_OFFSET_SPAN = 0.35;
// Relative cross-product threshold for "the footprint genuinely turns at this vertex".
const CORNER_TURN_EPSILON = 1e-3;

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
/** Highest sign bottom that may still throw a ground pool when its panel is a major one. */
export const POOL_MAX_SIGN_HEIGHT_M = 22;
const POOL_MAX_SIGN_BOTTOM_M = 8;
const POOL_HEIGHT_M = 0.03;
// Contrast, not uniform brightening: small pools dim slightly, major panels light hard.
const POOL_STRENGTH = 0.12;
const MAJOR_POOL_STRENGTH = 0.3;

const STRENGTH_SPREAD = 0.6;
const FACADE_STRENGTH = 0.7;

/** Brightest a panel can be, before the palette's own emissive strength. */
export const MAX_PANEL_STRENGTH = FACADE_STRENGTH + STRENGTH_SPREAD;
/**
 * Panel importance is packed into aSeed above the complete 0..MAX_PANEL_STRENGTH base-strength
 * range. The vertex shader decodes it, preserving the old minor-panel bytes and glyph seed.
 */
export const PANEL_IMPORTANCE_STRIDE = 2;
export const MAX_PANEL_IMPORTANCE = 3;

/** Local quad coords, one per corner: (-1,-1) (1,-1) (1,1) (-1,1). */
const LOCAL_U = [-1, 1, 1, -1];
const LOCAL_V = [-1, -1, 1, 1];

export type SemanticProfile =
  | "market_entertainment"
  | "corporate_civic"
  | "industrial_utility"
  | "residential"
  | "derelict_old_city"
  | "standard";

export type SignKind =
  | "sign"
  | "billboard"
  | "banner"
  | "crown"
  | "entry_band"
  | "status_panel"
  | "residential_ground"
  | "irregular";

const MIN_WIDTH_M: Record<SignKind, number> = {
  sign: SIGN_MIN_W_M,
  billboard: BILLBOARD_MIN_W_M,
  banner: BANNER_MIN_W_M,
  crown: 4,
  entry_band: 3,
  status_panel: 1.5,
  residential_ground: 1.5,
  irregular: 1.8
};

const MAX_WIDTH_M: Record<SignKind, number> = {
  sign: SIGN_MAX_W_M,
  billboard: BILLBOARD_MAX_W_M,
  banner: BANNER_MAX_W_M,
  crown: 9,
  entry_band: 7,
  status_panel: 3.0,
  residential_ground: 3.2,
  irregular: 4.2
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
  /** Facade panels only; tiers the ground pool's size, rate and strength. */
  kind?: SignKind;
  /** Facade-only core tier packed into aSeed; zero leaves minor panels byte-identical. */
  importance?: number;
  /** Unit outward normal of the mounting edge; set on corner-facing billboards only. */
  streetNormal?: { x: number; y: number };
}

/** Independent draws from one building's 0..1 seed. `hash2` wants integers. */
const roll = (seed: number, salt: number): number => hash2(Math.round(seed * 0x3fffffff), salt);

/**
 * Classifies a building facade into its semantic profile family.
 */
export function resolveSemanticProfile(spec: BuildingSpec): SemanticProfile {
  const profile = spec.facadeProfile?.toLowerCase() ?? "";
  if (!profile) return "standard";

  if (
    profile.includes("shopfront") ||
    profile.includes("arcade") ||
    profile.includes("entertainment") ||
    profile.includes("market") ||
    profile.includes("commercial")
  ) {
    return "market_entertainment";
  }

  if (
    profile.includes("corporate") ||
    profile.includes("civic") ||
    profile.includes("columns") ||
    profile.includes("glass") ||
    profile.includes("office")
  ) {
    return "corporate_civic";
  }

  if (
    profile.includes("industrial") ||
    profile.includes("utility") ||
    profile.includes("warehouse") ||
    profile.includes("logistics") ||
    profile.includes("louvre") ||
    profile.includes("shed")
  ) {
    return "industrial_utility";
  }

  if (
    profile.includes("residential") ||
    profile.includes("balcony") ||
    profile.includes("masonry")
  ) {
    return "residential";
  }

  if (
    profile.includes("derelict") ||
    profile.includes("old-city") ||
    profile.includes("shanty") ||
    profile.includes("decay") ||
    profile.includes("ruin")
  ) {
    return "derelict_old_city";
  }

  return "standard";
}

function profileFacadeRate(profile: SemanticProfile, specRate?: number): number {
  if (specRate !== undefined && Number.isFinite(specRate)) {
    return Math.max(0, Math.min(1, specRate));
  }
  switch (profile) {
    case "market_entertainment":
      return 0.85;
    case "corporate_civic":
      return 0.45;
    case "industrial_utility":
      return 0.2;
    case "residential":
      return 0.18;
    case "derelict_old_city":
      return 0.45;
    case "standard":
    default:
      return FACADE_RATE;
  }
}

/**
 * Retint for free: wall materials are absolute banked indices, so dividing one out gives
 * the building's district bank and the sign inherits that district's neon slots.
 */
function neonMaterial(spec: BuildingSpec, salt: number): number {
  const bank = Math.floor(spec.wallMaterial / BANK_SIZE);
  const weights = spec.neonWeights ?? [0.5, 0.5];
  const w0 = Number.isFinite(weights[0]) ? Math.max(0, weights[0]!) : 0.5;
  const w1 = Number.isFinite(weights[1]) ? Math.max(0, weights[1]!) : 0.5;
  const total = w0 + w1;
  const probA = total > 0 ? w0 / total : 0.5;
  const slot =
    roll(spec.seed, salt) < probA
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

/**
 * Outward unit normal of edge `edgeIdx` when the boundary genuinely turns at one of its
 * endpoints — a street corner a billboard's pool can spill across. Null on straight runs,
 * where light thrown outward would only climb the neighbouring wall.
 */
function streetSideNormal(ring: Ring, edgeIdx: number): { x: number; y: number } | null {
  const n = ring.length;
  const p = ring[(edgeIdx - 1 + n) % n]!;
  const a = ring[edgeIdx]!;
  const b = ring[(edgeIdx + 1) % n]!;
  const q = ring[(edgeIdx + 2) % n]!;

  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const lenAb = Math.hypot(abX, abY);
  if (lenAb === 0) return null;
  // Collinear vertices are just a long wall; a real corner bends the boundary.
  const turnsAtA =
    Math.abs((a.x - p.x) * abY - (a.y - p.y) * abX) >
    CORNER_TURN_EPSILON * Math.hypot(a.x - p.x, a.y - p.y) * lenAb;
  const turnsAtB =
    Math.abs(abX * (q.y - b.y) - abY * (q.x - b.x)) >
    CORNER_TURN_EPSILON * lenAb * Math.hypot(q.x - b.x, q.y - b.y);
  if (!turnsAtA && !turnsAtB) return null;

  // Shoelace sign picks which side of the edge is outside the lot.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const c = ring[i]!;
    const d = ring[(i + 1) % n]!;
    area2 += c.x * d.y - d.x * c.y;
  }
  const s = area2 >= 0 ? 1 : -1;
  return { x: (s * abY) / lenAb, y: (-s * abX) / lenAb };
}

function chooseSignKind(
  profile: SemanticProfile,
  facadeHeight: number,
  ring: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec
): { kind: SignKind; candidateEdges: number[] } | null {
  const wanted: SignKind[] = [];

  switch (profile) {
    case "market_entertainment":
      // Favors ground frontage signs or selected vertical banners; billboards on tall buildings
      if (facadeHeight >= BANNER_MIN_BUILDING_M && roll(spec.seed, 15) < 0.65) {
        wanted.push("banner");
      }
      if (facadeHeight >= BILLBOARD_MIN_BUILDING_M && roll(spec.seed, 14) < 0.25) {
        wanted.push("billboard");
      }
      wanted.push("sign");
      break;

    case "corporate_civic":
      // Restrained: crowns on upper facades, or sleek entry bands over ground doors
      if (facadeHeight >= 20 && roll(spec.seed, 16) < 0.6) {
        wanted.push("crown");
      }
      wanted.push("entry_band");
      break;

    case "industrial_utility":
      // Sparse loading and status panels
      wanted.push("status_panel");
      break;

    case "residential":
      // Ground-local subtle signs
      wanted.push("residential_ground");
      break;

    case "derelict_old_city":
      // Irregular partial signage
      if (facadeHeight >= BANNER_MIN_BUILDING_M && roll(spec.seed, 15) < 0.2) {
        wanted.push("banner");
      }
      wanted.push("irregular");
      wanted.push("sign");
      break;

    case "standard":
    default:
      if (facadeHeight >= BANNER_MIN_BUILDING_M && roll(spec.seed, 15) < BANNER_RATE) {
        wanted.push("banner");
      }
      if (facadeHeight >= BILLBOARD_MIN_BUILDING_M && roll(spec.seed, 14) < BILLBOARD_RATE) {
        wanted.push("billboard");
      }
      wanted.push("sign");
      break;
  }

  for (const k of wanted) {
    const candidates = edgeCandidates(ring, MIN_WIDTH_M[k], pixelsPerMetre);
    if (candidates.length > 0) {
      return { kind: k, candidateEdges: candidates };
    }
  }

  return null;
}

/** A glowing panel mounted on one wall edge, clamped to fit that edge. */
function facadeSign(
  spec: BuildingSpec,
  massing: BuildingMassing,
  pixelsPerMetre: number
): NeonQuad | null {
  const profile = resolveSemanticProfile(spec);
  const rate = profileFacadeRate(profile, spec.facadeRate);
  if (roll(spec.seed, 1) >= rate) return null;

  // Residential clustering: residential signs are sparse and clustered rather than universal
  if (profile === "residential" && spec.facadeRate === undefined) {
    if (roll(spec.seed, 21) > 0.45) return null;
  }

  const facadeHeight = massing.volumes[0]!.topHeight;
  if (facadeHeight < FACADE_MIN_BUILDING_M) return null;

  const ring = massing.volumes[0]!.footprint;
  if (ring.length < 3) return null;

  const selection = chooseSignKind(profile, facadeHeight, ring, pixelsPerMetre, spec);
  if (selection === null) return null;

  const { kind, candidateEdges } = selection;
  const pick = Math.min(
    candidateEdges.length - 1,
    Math.floor(roll(spec.seed, 2) * candidateEdges.length)
  );
  const edgeIdx = candidateEdges[pick]!;
  const a = ring[edgeIdx]!;
  const b = ring[(edgeIdx + 1) % ring.length]!;
  const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
  const lenM = lenPx / pixelsPerMetre;

  // Size scaling
  const sizeRamp = Math.min(1, facadeHeight / SIZE_RAMP_FULL_M);
  const size = Math.min(1, roll(spec.seed, 3) * 0.6 + 0.4 * sizeRamp);

  const rawWidthM = MIN_WIDTH_M[kind] + size * (MAX_WIDTH_M[kind] - MIN_WIDTH_M[kind]);
  const widthM = Math.min(rawWidthM, Math.max(MIN_WIDTH_M[kind], lenM - 2 * GLOW_MARGIN_M));
  const heightM = panelHeightM(kind, spec, facadeHeight, size);
  const importance =
    kind === "crown"
      ? MAX_PANEL_IMPORTANCE
      : kind === "billboard" || kind === "banner"
        ? widthM * heightM >= 54
          ? 2
          : 1
        : 0;
  const halfWM = widthM / 2 + GLOW_MARGIN_M;
  const halfHM = heightM / 2 + GLOW_MARGIN_M;

  const ux = (b.x - a.x) / lenPx;
  const uy = (b.y - a.y) / lenPx;

  let alongFraction: number;
  if (kind === "crown" || kind === "entry_band") {
    alongFraction = 0.3 + roll(spec.seed, 5) * 0.4;
  } else {
    alongFraction = roll(spec.seed, 5);
  }

  const alongPx = (halfWM + alongFraction * (lenM - 2 * halfWM)) * pixelsPerMetre;
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
    strength: panelStrength(profile, spec),
    radial: 0,
    kind,
    importance,
    streetNormal: kind === "billboard" ? (streetSideNormal(ring, edgeIdx) ?? undefined) : undefined
  };
}

function panelHeightM(
  kind: SignKind,
  spec: BuildingSpec,
  facadeHeight: number,
  size: number
): number {
  switch (kind) {
    case "banner":
      return Math.min(
        BANNER_MIN_H_M + roll(spec.seed, 4) * (BANNER_MAX_H_M - BANNER_MIN_H_M),
        facadeHeight * BANNER_MAX_FACADE_FRACTION
      );
    case "billboard":
      return BILLBOARD_MIN_H_M + size * (BILLBOARD_MAX_H_M - BILLBOARD_MIN_H_M);
    case "crown":
      return 1.2 + size * 1.4;
    case "entry_band":
      return 0.8 + size * 0.7;
    case "status_panel":
      return 0.7 + size * 0.7;
    case "residential_ground":
      return 0.8 + size * 0.6;
    case "irregular":
      return 0.8 + roll(spec.seed, 4) * 1.4;
    case "sign":
    default:
      return SIGN_MIN_H_M + size * (SIGN_MAX_H_M - SIGN_MIN_H_M);
  }
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
    const topH =
      (BANNER_TOP_LOW + roll(spec.seed, 6) * (BANNER_TOP_HIGH - BANNER_TOP_LOW)) * facadeHeight;
    return Math.min(ceiling, Math.max(halfHM, topH - halfHM));
  }

  if (kind === "crown") {
    const crownOffset = 0.5 + roll(spec.seed, 6) * 1.0;
    const targetH = facadeHeight - halfHM - crownOffset;
    return Math.min(ceiling, Math.max(halfHM, targetH));
  }

  if (kind === "entry_band") {
    const bandH = 2.5 + roll(spec.seed, 6) * 2.0;
    return Math.min(ceiling, Math.max(halfHM, bandH));
  }

  if (kind === "status_panel") {
    const panelH = 2.0 + roll(spec.seed, 6) * 3.5;
    return Math.min(ceiling, Math.max(halfHM, panelH));
  }

  if (kind === "residential_ground") {
    const groundH = 2.0 + roll(spec.seed, 6) * 2.0;
    return Math.min(ceiling, Math.max(halfHM, groundH));
  }

  if (kind === "irregular") {
    const band = Math.min(facadeHeight * 0.5, SIGN_BAND_TOP_M);
    return Math.min(ceiling, Math.max(halfHM, halfHM + roll(spec.seed, 6) * (band - halfHM)));
  }

  const band = Math.max(halfHM, SIGN_BAND_TOP_M);
  return Math.min(ceiling, Math.max(halfHM, halfHM + roll(spec.seed, 6) * (band - halfHM)));
}

function panelStrength(
  profile: SemanticProfile,
  spec: BuildingSpec
): number {
  const baseRoll = roll(spec.seed, 9);
  switch (profile) {
    case "market_entertainment":
      return 0.75 + baseRoll * 0.45;
    case "corporate_civic":
      return 0.65 + baseRoll * 0.2;
    case "industrial_utility":
      return 0.5 + baseRoll * 0.25;
    case "residential":
      return 0.45 + baseRoll * 0.25;
    case "derelict_old_city":
      return 0.3 + baseRoll * 0.6;
    case "standard":
    default:
      return FACADE_STRENGTH + baseRoll * STRENGTH_SPREAD;
  }
}

function groundPool(
  sign: NeonQuad,
  spec: BuildingSpec,
  profile: SemanticProfile,
  pixelsPerMetre: number
): NeonQuad | null {
  // CRITIQUE #13 tiering: major panels (billboard, banner, crown) are the few sources
  // allowed to dominate a block face — bigger reach, harder light — and they may hang
  // mid-tower yet still throw their pool down to the street. Everything else stays modest.
  const kind = sign.kind ?? "sign";
  const major = kind === "billboard" || kind === "banner" || kind === "crown";

  // Keyed off the panel's bottom: genuine ground-reaching signs only.
  const bottomH = Math.min(...sign.corners.map((c) => c.h));
  if (bottomH > (major ? POOL_MAX_SIGN_HEIGHT_M : POOL_MAX_SIGN_BOTTOM_M)) return null;

  const defaultPoolRate =
    profile === "market_entertainment"
      ? 0.45
      : profile === "corporate_civic"
        ? 0.3
        : profile === "residential"
          ? 0.2
          : profile === "industrial_utility"
            ? 0.15
            : profile === "derelict_old_city"
              ? 0.25
              : POOL_RATE;

  const configuredRate =
    spec.poolRate === undefined || !Number.isFinite(spec.poolRate)
      ? defaultPoolRate
      : Math.max(0, Math.min(1, spec.poolRate));
  // Fewer, stronger: minors thin to a fraction of their configured density; majors keep
  // a scaled share but never below MAJOR_POOL_MIN_RATE.
  const poolRate = Math.min(
    1,
    major
      ? Math.max(configuredRate * MAJOR_POOL_RATE_MULT, MAJOR_POOL_MIN_RATE)
      : configuredRate * MINOR_POOL_RATE_MULT
  );

  if (roll(spec.seed, 13) >= poolRate) return null;

  let cx = sign.corners.reduce((sum, c) => sum + c.x, 0) / sign.corners.length;
  let cy = sign.corners.reduce((sum, c) => sum + c.y, 0) / sign.corners.length;
  const radiusM = poolRadiusM(sign, major);
  if (sign.streetNormal !== undefined) {
    // Spill across the intersection: shift the centre toward the street by a seeded
    // slice of the radius (drawn after the rate roll; salt 23 is new and independent).
    const offsetFraction =
      POOL_STREET_OFFSET_MIN_FRACTION +
      POOL_STREET_OFFSET_SPAN * roll(spec.seed, POOL_STREET_OFFSET_SALT);
    cx += sign.streetNormal.x * radiusM * offsetFraction;
    cy += sign.streetNormal.y * radiusM * offsetFraction;
  }

  const r = radiusM * pixelsPerMetre;
  return {
    corners: [
      { x: cx - r, y: cy - r, h: POOL_HEIGHT_M },
      { x: cx + r, y: cy - r, h: POOL_HEIGHT_M },
      { x: cx + r, y: cy + r, h: POOL_HEIGHT_M },
      { x: cx - r, y: cy + r, h: POOL_HEIGHT_M }
    ],
    halfWidthM: radiusM,
    halfHeightM: radiusM,
    material: sign.material,
    strength: sign.strength * (major ? MAJOR_POOL_STRENGTH : POOL_STRENGTH),
    radial: 1
  };
}

function poolRadiusM(sign: NeonQuad, major: boolean): number {
  const halfDiagM = Math.hypot(sign.halfWidthM, sign.halfHeightM);
  const reachM = (major ? MAJOR_POOL_RADIUS_FACTOR : MINOR_POOL_RADIUS_FACTOR) * halfDiagM;
  return Math.min(
    major ? MAX_POOL_RADIUS_M : SMALL_POOL_MAX_RADIUS_M,
    Math.max(major ? MAJOR_POOL_MIN_RADIUS_M : MIN_POOL_RADIUS_M, reachM)
  );
}

/** A mass with neon disabled emits no geometry, so its renderer pass remains empty. */
export function neonMesh(buildings: BuildingSpec[], pixelsPerMetre: number): MeshBuffers {
  const quads: NeonQuad[] = [];
  for (const spec of buildings) {
    if (spec.neonEnabled === false) continue;
    const massing = describeBuildingMassing(spec, pixelsPerMetre);
    const facade = facadeSign(spec, massing, pixelsPerMetre);
    if (facade !== null) {
      quads.push(facade);
      const profile = resolveSemanticProfile(spec);
      const pool = groundPool(facade, spec, profile, pixelsPerMetre);
      if (pool !== null) quads.push(pool);
    }
  }

  const builder = new MeshBuilder(quads.length * 4, quads.length * 2);
  for (const quad of quads) {
    const base = builder.vertexCount;
    const encodedStrength =
      quad.strength +
      (quad.radial < 0.5 ? (quad.importance ?? 0) * PANEL_IMPORTANCE_STRIDE : 0);
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
        encodedStrength,
        quad.halfWidthM,
        quad.halfHeightM
      );
    }
    builder.triangle(base, base + 1, base + 2);
    builder.triangle(base, base + 2, base + 3);
  }
  return builder.build();
}
