import { difference, ringAsMulti } from "../geom/boolean.js";
import { rectContains, rectRing, type MultiPolygon, type Rect, type Vec2 } from "../geom/types.js";
import {
  BASE_BANK,
  DEFAULT_DISTRICT_PALETTE,
  FIRST_ZONE_BANK,
  LAST_ZONE_BANK,
  normalizePalette,
  presetByName,
  zoneBank,
  type DistrictPalette
} from "../palette.js";
import type { LotOptions, LotRegion } from "./blocks.js";

/** Everything about a district's buildings except the buildings themselves. */
export interface ZoneParams {
  /** Reroll this and the zone's buildings reshuffle. Nothing else moves. */
  seed: number;
  lotSizeM: number;
  gapM: number;
  minHeightM: number;
  maxHeightM: number;
  palette: DistrictPalette;
  /** Fraction of blocks that receive buildings. Empty blocks remain deliberate open space. */
  occupancy: number;
  /** Blend from lot-level height noise (0) toward coarse block clusters (1). */
  heightCluster: number;
  /** Weighted geometric families. Weights are normalized when scene data is loaded. */
  massingWeights: MassingWeights;
  /** Probability that an eligible facade receives a neon panel. */
  facadeRate: number;
  /** Probability that an eligible facade also receives a ground pool. */
  poolRate: number;
  /** Dominant-to-alternate wall slot weights, in WALL_A/B/C order. */
  wallWeights: WeightTriple;
  /** Dominant-to-alternate roof slot weights, in ROOF_A/B/C order. */
  roofWeights: WeightTriple;
  /** Neon slot weights, in NEON_A/B order. */
  neonWeights: WeightPair;
}

export type WeightTriple = [number, number, number];
export type WeightPair = [number, number];

export const MASSING_FAMILIES = ["block", "podiumTower", "terraced"] as const;
export type MassingFamily = (typeof MASSING_FAMILIES)[number];
export type MassingWeights = Record<MassingFamily, number>;

export interface Zone extends ZoneParams {
  id: string;
  /**
   * WHY: stored, never derived from array position. Deleting a zone rebuilds only its own
   * rect, so a shifting bank would leave every other district's baked material indices
   * pointing at the wrong palette entries without their chunks ever regenerating.
   */
  bank: number;
  /** Optional editor-facing label. It has no effect on generation. */
  name?: string;
  /** The area this zone governs, in metres relative to the city origin. */
  rect: Rect;
}

export const DEFAULT_ZONE_PARAMS: ZoneParams = {
  seed: 0,
  lotSizeM: 26,
  gapM: 4,
  minHeightM: 8,
  maxHeightM: 170,
  palette: DEFAULT_DISTRICT_PALETTE,
  occupancy: 0.92,
  heightCluster: 0.35,
  massingWeights: { block: 0.48, podiumTower: 0.4, terraced: 0.12 },
  facadeRate: 0.52,
  poolRate: 0.28,
  wallWeights: [0.62, 0.26, 0.12],
  roofWeights: [0.65, 0.25, 0.1],
  neonWeights: [0.58, 0.42]
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: unknown, fallback: number): number {
  const n = finite(value, fallback);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function weights3(value: unknown, fallback: WeightTriple): WeightTriple {
  const values = Array.isArray(value) ? value : [];
  const raw = [
    Math.max(0, finite(values[0], fallback[0])),
    Math.max(0, finite(values[1], fallback[1])),
    Math.max(0, finite(values[2], fallback[2]))
  ];
  const total = raw[0]! + raw[1]! + raw[2]!;
  return total > 0 ? [raw[0]! / total, raw[1]! / total, raw[2]! / total] : [...fallback];
}

function weights2(value: unknown, fallback: WeightPair): WeightPair {
  const values = Array.isArray(value) ? value : [];
  const raw = [Math.max(0, finite(values[0], fallback[0])), Math.max(0, finite(values[1], fallback[1]))];
  const total = raw[0]! + raw[1]!;
  return total > 0 ? [raw[0]! / total, raw[1]! / total] : [...fallback];
}

function massingWeights(value: unknown, fallback: MassingWeights): MassingWeights {
  const source = value && typeof value === "object" ? (value as Partial<MassingWeights>) : {};
  const raw = MASSING_FAMILIES.map((family) => Math.max(0, finite(source[family], fallback[family])));
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return { ...fallback };
  return {
    block: raw[0]! / total,
    podiumTower: raw[1]! / total,
    terraced: raw[2]! / total
  };
}

/** Normalize persisted or editor-supplied values without retaining mutable defaults. */
export function normalizeZoneParams(
  params: Partial<ZoneParams> | null | undefined
): ZoneParams {
  const source = params ?? {};
  const base = DEFAULT_ZONE_PARAMS;
  const lotSizeM = Math.max(1, finite(source.lotSizeM, base.lotSizeM));
  const gapM = Math.min(
    Math.max(0, finite(source.gapM, base.gapM)),
    Math.max(0, lotSizeM - 0.001)
  );
  const minHeightM = Math.max(0, finite(source.minHeightM, base.minHeightM));
  const maxHeightM = Math.max(minHeightM, finite(source.maxHeightM, base.maxHeightM));
  return {
    seed: Math.round(finite(source.seed, base.seed)),
    lotSizeM,
    gapM,
    minHeightM,
    maxHeightM,
    palette: normalizePalette(source.palette),
    occupancy: clamp01(source.occupancy, base.occupancy),
    heightCluster: clamp01(source.heightCluster, base.heightCluster),
    massingWeights: massingWeights(source.massingWeights, base.massingWeights),
    facadeRate: clamp01(source.facadeRate, base.facadeRate),
    poolRate: clamp01(source.poolRate, base.poolRate),
    wallWeights: weights3(source.wallWeights, base.wallWeights),
    roofWeights: weights3(source.roofWeights, base.roofWeights),
    neonWeights: weights2(source.neonWeights, base.neonWeights)
  };
}

/** Deep-copy params before placing them in a scene flag or handing them to an editor. */
export function copyZoneParams(params: ZoneParams): ZoneParams {
  return normalizeZoneParams({
    ...params,
    massingWeights: { ...params.massingWeights },
    wallWeights: [...params.wallWeights] as WeightTriple,
    roofWeights: [...params.roofWeights] as WeightTriple,
    neonWeights: [...params.neonWeights] as WeightPair,
    palette: normalizePalette(params.palette)
  });
}

export interface DistrictPreset {
  id: string;
  label: string;
  params: ZoneParams;
}

const palettePreset = (name: string): DistrictPalette =>
  normalizePalette(presetByName(name) ?? DEFAULT_DISTRICT_PALETTE);

const preset = (
  id: string,
  label: string,
  values: Omit<Partial<ZoneParams>, "palette"> & { palette: DistrictPalette }
): DistrictPreset => ({
  id,
  label,
  params: normalizeZoneParams({ ...DEFAULT_ZONE_PARAMS, ...values })
});

/** Four intentionally distinct starting grammars for a new district. */
export const DISTRICT_PRESETS: readonly DistrictPreset[] = [
  preset("corporate-core", "Corporate Core", {
    palette: palettePreset("Corpo Chrome"),
    lotSizeM: 34,
    gapM: 7,
    minHeightM: 22,
    maxHeightM: 210,
    occupancy: 0.76,
    heightCluster: 0.9,
    massingWeights: { block: 0.16, podiumTower: 0.7, terraced: 0.14 },
    facadeRate: 0.3,
    poolRate: 0.12,
    wallWeights: [0.78, 0.17, 0.05],
    roofWeights: [0.76, 0.2, 0.04],
    neonWeights: [0.72, 0.28]
  }),
  preset("night-market", "Night Market", {
    palette: palettePreset("Red Light"),
    lotSizeM: 18,
    gapM: 2.5,
    minHeightM: 5,
    maxHeightM: 52,
    occupancy: 0.94,
    heightCluster: 0.62,
    massingWeights: { block: 0.74, podiumTower: 0.08, terraced: 0.18 },
    facadeRate: 0.82,
    poolRate: 0.68,
    wallWeights: [0.5, 0.37, 0.13],
    roofWeights: [0.52, 0.34, 0.14],
    neonWeights: [0.44, 0.56]
  }),
  preset("industrial-utility", "Industrial Utility", {
    palette: palettePreset("Industrial"),
    lotSizeM: 46,
    gapM: 9,
    minHeightM: 5,
    maxHeightM: 38,
    occupancy: 0.58,
    heightCluster: 0.78,
    massingWeights: { block: 0.86, podiumTower: 0.02, terraced: 0.12 },
    facadeRate: 0.16,
    poolRate: 0.05,
    wallWeights: [0.7, 0.2, 0.1],
    roofWeights: [0.56, 0.3, 0.14],
    neonWeights: [0.65, 0.35]
  }),
  preset("residential-megablocks", "Residential Megablocks", {
    palette: palettePreset("Green Zone"),
    lotSizeM: 30,
    gapM: 6,
    minHeightM: 12,
    maxHeightM: 98,
    occupancy: 0.72,
    heightCluster: 0.74,
    massingWeights: { block: 0.45, podiumTower: 0.25, terraced: 0.3 },
    facadeRate: 0.2,
    poolRate: 0.1,
    wallWeights: [0.63, 0.27, 0.1],
    roofWeights: [0.68, 0.24, 0.08],
    neonWeights: [0.38, 0.62]
  })
];

export function districtPresetById(id: string): DistrictPreset | null {
  const found = DISTRICT_PRESETS.find((entry) => entry.id === id);
  return found === undefined
    ? null
    : { ...found, params: copyZoneParams(found.params) };
}

export function copyDistrictPreset(id: string): ZoneParams | null {
  const found = districtPresetById(id);
  return found === null ? null : copyZoneParams(found.params);
}

const ZONE_BANK_COUNT = LAST_ZONE_BANK - FIRST_ZONE_BANK + 1;

/** Lots below this are slivers left by a block edge clipping a lot cell. */
const MIN_LOT_AREA_M2 = 40;

export function lotOptions(params: ZoneParams, originPx: Vec2, pixelsPerMetre: number): LotOptions {
  return {
    originPx,
    lotSizePx: params.lotSizeM * pixelsPerMetre,
    gapPx: params.gapM * pixelsPerMetre,
    minAreaPx2: MIN_LOT_AREA_M2 * pixelsPerMetre * pixelsPerMetre,
    minHeightM: params.minHeightM,
    maxHeightM: params.maxHeightM,
    occupancy: params.occupancy,
    heightCluster: params.heightCluster,
    massingWeights: { ...params.massingWeights },
    facadeRate: params.facadeRate,
    poolRate: params.poolRate,
    wallWeights: [...params.wallWeights] as WeightTriple,
    roofWeights: [...params.roofWeights] as WeightTriple,
    neonWeights: [...params.neonWeights] as WeightPair
  };
}

/**
 * Split the city into disjoint regions, one per zone plus the leftover.
 *
 * Later zones win where they overlap, and each region is cut against the ones above it,
 * so every lot belongs to exactly one region. That disjointness is the whole point:
 * it is what makes reseeding a zone provably unable to disturb its neighbours.
 *
 * Each region anchors its lot grid to its own top-left corner, so blocks inside a zone
 * share a rhythm and changing one zone's lot size cannot shift another's. The leftover
 * anchors to `originPx` — metre coordinate (0, 0) — never to the bounds, which move on
 * every edit and would slide every unzoned building with them.
 *
 * Zones and bounds arrive already converted to world pixels.
 */
export function lotRegions(
  base: ZoneParams,
  zonesPx: Zone[],
  boundsPx: Rect,
  pixelsPerMetre: number,
  originPx: Vec2
): LotRegion[] {
  const regions: LotRegion[] = [];
  const covered: MultiPolygon[] = [];

  for (let i = zonesPx.length - 1; i >= 0; i--) {
    const zone = zonesPx[i]!;
    const rect = ringAsMulti(rectRing(zone.rect));
    const own = difference(rect, covered);
    covered.push(rect);
    if (own.length === 0) continue;
    regions.push({
      seed: zone.seed,
      bank: zone.bank,
      clip: own,
      options: lotOptions(zone, { x: zone.rect.x, y: zone.rect.y }, pixelsPerMetre)
    });
  }

  const rest = covered.length === 0 ? null : difference(ringAsMulti(rectRing(boundsPx)), covered);
  if (rest === null || rest.length > 0) {
    regions.push({
      seed: base.seed,
      bank: BASE_BANK,
      clip: rest,
      options: lotOptions(base, originPx, pixelsPerMetre)
    });
  }
  return regions;
}

/** Topmost zone containing p, matching the last-wins order used by `lotRegions`. */
export function zoneAt(zones: Zone[], p: Vec2): Zone | null {
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i]!;
    if (rectContains(zone.rect, p)) return zone;
  }
  return null;
}

export function nextZoneId(zones: Zone[]): string {
  const used = new Set(zones.map((z) => z.id));
  for (let i = 1; ; i++) {
    const id = `z${i}`;
    if (!used.has(id)) return id;
  }
}

/** Lowest district bank no live zone holds, so a deleted zone's bank comes back. */
export function nextZoneBank(zones: Zone[]): number {
  const used = new Set(zones.map((z) => z.bank));
  for (let i = 0; i < ZONE_BANK_COUNT; i++) {
    const bank = zoneBank(i);
    if (!used.has(bank)) return bank;
  }
  // Every district bank is live. Sharing a tint beats refusing the zone.
  return zoneBank(zones.length);
}
