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
import { hash2, hashPick } from "./hash.js";

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
      for (const lot of subdivideBlock(block, options)) {
        const ring = lot[0]!;
        const centre = ringCentroid(ring);
        // Decimetres in absolute city metres. Metres alone would collide two slivers on
        // one key; float noise here is ~1e-11 m, so the rounding is exact.
        const cx = Math.round(((centre.x - frame.originPx.x) / frame.pixelsPerMetre) * 10);
        const cy = Math.round(((centre.y - frame.originPx.y) / frame.pixelsPerMetre) * 10);
        const t = hash2(cx, cy, seed);

        specs.push({
          footprint: ring,
          height:
            options.minHeightM +
            Math.pow(t, HEIGHT_EXPONENT) * (options.maxHeightM - options.minHeightM),
          roofMaterial: materialIndex(bank, hashPick(ROOF_SLOTS, cx, cy, 1, seed)),
          wallMaterial: materialIndex(bank, hashPick(WALL_SLOTS, cx, cy, 2, seed)),
          seed: facadeSeed(cx, cy, seed)
        });
      }
    }
  }
  return specs;
}
