import { intersection, ringAsMulti } from "../geom/boolean.js";
import type { BuildingSpec } from "../geom/extrude.js";
import {
  rectRing,
  ringArea,
  ringBounds,
  ringCentroid,
  type MultiPolygon,
  type Polygon,
  type Vec2
} from "../geom/types.js";
import { DISTRICT_SLOT, materialIndex } from "../palette.js";
import { hash2 } from "./hash.js";
import type { MassingFamily, MassingWeights, WeightPair, WeightTriple } from "./zones.js";

export interface LotOptions {
  /** Anchor for the lot grid. Blocks sharing an anchor share a rhythm. */
  originPx: Vec2;
  /** Target lot edge length in world pixels. */
  lotSizePx: number;
  /** Alley gap between neighbouring lots, in world pixels. */
  gapPx: number;
  /** Lots smaller than this are dropped as slivers. */
  minAreaPx2: number;
  minHeightM: number;
  maxHeightM: number;
  /** District identity dials. Optional keeps low-level fixtures source-compatible. */
  occupancy?: number;
  heightCluster?: number;
  massingWeights?: MassingWeights;
  facadeRate?: number;
  poolRate?: number;
  wallWeights?: WeightTriple;
  roofWeights?: WeightTriple;
  neonWeights?: WeightPair;
}

/** A slice of the city generated from one seed with one set of lot params. */
export interface LotRegion {
  seed: number;
  /** Palette bank its buildings take wall and roof materials from. */
  bank: number;
  options: LotOptions;
  /** Area this region governs, or null for "wherever no other region reaches". */
  clip: MultiPolygon | null;
}

/**
 * The absolute city frame lot identity is hashed in, so height and material survive a
 * scene regrid.
 *
 * WHY: this is deliberately not `LotOptions.originPx`, which is the per-region lot-grid
 * anchor — a zone's own corner. Hashing against that would reshuffle a zone's buildings
 * whenever the zone moved or resized. Every region must hash in one shared frame.
 */
export interface HashFrame {
  /** World-pixel point at which city metre coordinate (0, 0) sits. */
  originPx: Vec2;
  pixelsPerMetre: number;
}

const WALL_SLOTS = [DISTRICT_SLOT.WALL_A, DISTRICT_SLOT.WALL_B, DISTRICT_SLOT.WALL_C] as const;
const ROOF_SLOTS = [DISTRICT_SLOT.ROOF_A, DISTRICT_SLOT.ROOF_B, DISTRICT_SLOT.ROOF_C] as const;

/** Salt 3, matching `hashPick`'s offsets — 0 is height, 1 and 2 are the material picks. */
const facadeSeed = (x: number, y: number, seed: number): number =>
  hash2(x + 3 * 7919, y - 3 * 104729, seed);

export const HEIGHT_EXPONENT = 1.55;

const DEFAULT_WALL_WEIGHTS: WeightTriple = [0.62, 0.26, 0.12];
const DEFAULT_ROOF_WEIGHTS: WeightTriple = [0.65, 0.25, 0.1];
const DEFAULT_NEON_WEIGHTS: WeightPair = [0.58, 0.42];
const DEFAULT_MASSING_WEIGHTS: MassingWeights = {
  block: 0.48,
  podiumTower: 0.4,
  terraced: 0.12
};

function clamp01(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value!));
}

function weightedPick<T>(items: readonly T[], weights: readonly number[], t: number): T {
  let cursor = Math.max(0, Math.min(0.999999999, t));
  for (let i = 0; i < items.length; i++) {
    cursor -= Math.max(0, weights[i] ?? 0);
    if (cursor < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

function weightedMaterial(
  slots: readonly number[],
  weights: readonly number[],
  x: number,
  y: number,
  salt: number,
  seed: number
): number {
  return weightedPick(slots, weights, hash2(x + salt * 7919, y - salt * 104729, seed));
}

function chooseMassing(
  weights: MassingWeights,
  x: number,
  y: number,
  seed: number
): MassingFamily {
  return weightedPick(
    ["block", "podiumTower", "terraced"] as const,
    [weights.block, weights.podiumTower, weights.terraced],
    hash2(x + 47 * 7919, y - 47 * 104729, seed)
  );
}

/**
 * Cut a block into buildable lots.
 *
 * The lot grid is anchored to `originPx` rather than to the block's own bounds, so
 * neighbouring blocks line up instead of each starting its own rhythm. Buildings end up
 * flush with the pavement, which is the correct urban form and avoids needing a general
 * polygon offset for setbacks.
 */
export function subdivideBlock(block: Polygon, options: LotOptions): Polygon[] {
  const outer = block[0];
  if (!outer || outer.length < 3) return [];

  const bounds = ringBounds(outer);
  const { lotSizePx, gapPx, originPx } = options;
  const inset = gapPx / 2;

  const firstCol = Math.floor((bounds.x - originPx.x) / lotSizePx);
  const lastCol = Math.ceil((bounds.x + bounds.width - originPx.x) / lotSizePx);
  const firstRow = Math.floor((bounds.y - originPx.y) / lotSizePx);
  const lastRow = Math.ceil((bounds.y + bounds.height - originPx.y) / lotSizePx);

  const lots: Polygon[] = [];
  for (let col = firstCol; col < lastCol; col++) {
    for (let row = firstRow; row < lastRow; row++) {
      const cell = rectRing({
        x: originPx.x + col * lotSizePx + inset,
        y: originPx.y + row * lotSizePx + inset,
        width: lotSizePx - gapPx,
        height: lotSizePx - gapPx
      });

      for (const piece of intersection(ringAsMulti(cell), [block])) {
        // A lot with a hole would need hole-aware extrusion; rare enough to skip.
        if (piece.length !== 1) continue;
        const ring = piece[0]!;
        if (ring.length < 3) continue;
        if (Math.abs(ringArea(ring)) < options.minAreaPx2) continue;
        lots.push(piece);
      }
    }
  }
  return lots;
}

export function buildingsForBlocks(
  blocks: MultiPolygon,
  regions: LotRegion[],
  frame: HashFrame
): BuildingSpec[] {
  const specs: BuildingSpec[] = [];
  for (const region of regions) {
    const area = region.clip === null ? blocks : intersection(blocks, region.clip);
    const { seed, options, bank } = region;

    for (const block of area) {
      const outer = block[0];
      if (!outer || outer.length < 3) continue;
      const occupancy = clamp01(options.occupancy, 1);

      for (const lot of subdivideBlock(block, options)) {
        const ring = lot[0]!;
        const centre = ringCentroid(ring);
        // Decimetres in absolute city metres. Metres alone would collide two slivers on
        // one key; float noise here is ~1e-11 m, so the rounding is exact.
        const cx = Math.round(((centre.x - frame.originPx.x) / frame.pixelsPerMetre) * 10);
        const cy = Math.round(((centre.y - frame.originPx.y) / frame.pixelsPerMetre) * 10);
        // One low-frequency decision per four-lot cell keeps open space coherent while
        // anchoring to absolute lot centres, so chunk clipping cannot change the result.
        const occupancySpanM = Math.max(1, (options.lotSizePx / frame.pixelsPerMetre) * 4);
        const occupancyX = Math.floor(
          (centre.x - frame.originPx.x) / (occupancySpanM * frame.pixelsPerMetre)
        );
        const occupancyY = Math.floor(
          (centre.y - frame.originPx.y) / (occupancySpanM * frame.pixelsPerMetre)
        );
        if (hash2(occupancyX, occupancyY, seed + 17) >= occupancy) continue;
        const t = hash2(cx, cy, seed);
        const cluster = clamp01(options.heightCluster, 0);
        const clusterSpanM = Math.max(1, (options.lotSizePx / frame.pixelsPerMetre) * 4);
        const clusterX = Math.floor((centre.x - frame.originPx.x) / (clusterSpanM * frame.pixelsPerMetre));
        const clusterY = Math.floor((centre.y - frame.originPx.y) / (clusterSpanM * frame.pixelsPerMetre));
        const clusterT = hash2(clusterX, clusterY, seed + 31);
        const heightT = t * (1 - cluster) + clusterT * cluster;
        const massing = chooseMassing(
          options.massingWeights ?? DEFAULT_MASSING_WEIGHTS,
          cx,
          cy,
          seed
        );
        const wallWeights = options.wallWeights ?? DEFAULT_WALL_WEIGHTS;
        const roofWeights = options.roofWeights ?? DEFAULT_ROOF_WEIGHTS;

        specs.push({
          footprint: ring,
          height:
            options.minHeightM +
            Math.pow(heightT, HEIGHT_EXPONENT) * (options.maxHeightM - options.minHeightM),
          roofMaterial: materialIndex(
            bank,
            weightedMaterial(ROOF_SLOTS, roofWeights, cx, cy, 1, seed)
          ),
          wallMaterial: materialIndex(
            bank,
            weightedMaterial(WALL_SLOTS, wallWeights, cx, cy, 2, seed)
          ),
          seed: facadeSeed(cx, cy, seed),
          detailedMassing: true,
          massingFamily: massing,
          facadeRate: options.facadeRate,
          poolRate: options.poolRate,
          neonWeights: options.neonWeights ?? DEFAULT_NEON_WEIGHTS
        });
      }
    }
  }
  return specs;
}
