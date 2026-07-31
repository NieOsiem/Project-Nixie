import { difference, ringAsMulti } from "../geom/boolean.js";
import { rectContains, rectRing, type MultiPolygon, type Rect, type Vec2 } from "../geom/types.js";
import {
  BASE_BANK,
  DEFAULT_DISTRICT_PALETTE,
  FIRST_ZONE_BANK,
  LAST_ZONE_BANK,
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
}

export interface Zone extends ZoneParams {
  id: string;
  /**
   * WHY: stored, never derived from array position. Deleting a zone rebuilds only its own
   * rect, so a shifting bank would leave every other district's baked material indices
   * pointing at the wrong palette entries without their chunks ever regenerating.
   */
  bank: number;
  /** The area this zone governs, in metres relative to the city origin. */
  rect: Rect;
}

export const DEFAULT_ZONE_PARAMS: ZoneParams = {
  seed: 0,
  lotSizeM: 26,
  gapM: 4,
  minHeightM: 8,
  maxHeightM: 170,
  palette: DEFAULT_DISTRICT_PALETTE
};

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
    maxHeightM: params.maxHeightM
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
