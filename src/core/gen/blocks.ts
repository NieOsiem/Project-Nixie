import { intersection, ringAsMulti } from "../geom/boolean.js";
import type { BuildingSpec } from "../geom/extrude.js";
import { rectRing, ringArea, ringBounds, ringCentroid, type MultiPolygon, type Polygon } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import { hash2, hashPick } from "./hash.js";

export interface LotOptions {
  /** Target lot edge length in world pixels. */
  lotSizePx: number;
  /** Alley gap between neighbouring lots, in world pixels. */
  gapPx: number;
  /** Lots smaller than this are dropped as slivers. */
  minAreaPx2: number;
  minHeightM: number;
  maxHeightM: number;
}

const WALL_MATERIALS = [MATERIAL.WALL_VIOLET, MATERIAL.WALL_MAGENTA, MATERIAL.WALL_TEAL] as const;
const ROOF_MATERIALS = [MATERIAL.ROOF_DARK, MATERIAL.ROOF_WARM, MATERIAL.ROOF_ACCENT] as const;

/**
 * Cut a block into buildable lots.
 *
 * The lot grid is anchored to absolute world coordinates rather than the block's own
 * bounds, so neighbouring blocks line up instead of each starting its own rhythm.
 * Buildings end up flush with the pavement, which is the correct urban form and avoids
 * needing a general polygon offset for setbacks.
 */
export function subdivideBlock(block: Polygon, options: LotOptions): Polygon[] {
  const outer = block[0];
  if (!outer || outer.length < 3) return [];

  const bounds = ringBounds(outer);
  const { lotSizePx, gapPx } = options;
  const inset = gapPx / 2;

  const firstCol = Math.floor(bounds.x / lotSizePx);
  const lastCol = Math.ceil((bounds.x + bounds.width) / lotSizePx);
  const firstRow = Math.floor(bounds.y / lotSizePx);
  const lastRow = Math.ceil((bounds.y + bounds.height) / lotSizePx);

  const lots: Polygon[] = [];
  for (let col = firstCol; col < lastCol; col++) {
    for (let row = firstRow; row < lastRow; row++) {
      const cell = rectRing({
        x: col * lotSizePx + inset,
        y: row * lotSizePx + inset,
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

export function buildingsForBlocks(blocks: MultiPolygon, options: LotOptions): BuildingSpec[] {
  const specs: BuildingSpec[] = [];
  for (const block of blocks) {
    for (const lot of subdivideBlock(block, options)) {
      const ring = lot[0]!;
      const centre = ringCentroid(ring);
      const cx = Math.round(centre.x);
      const cy = Math.round(centre.y);
      const t = hash2(cx, cy);

      specs.push({
        footprint: ring,
        height: options.minHeightM + t * t * (options.maxHeightM - options.minHeightM),
        roofMaterial: hashPick(ROOF_MATERIALS, cx, cy, 1),
        wallMaterial: hashPick(WALL_MATERIALS, cx, cy, 2)
      });
    }
  }
  return specs;
}
