import { difference, ringAsMulti } from "../geom/boolean.js";
import { rectContains, rectRing, type MultiPolygon, type Rect, type Vec2 } from "../geom/types.js";
import type { LotOptions, LotRegion } from "./blocks.js";

/** Everything about a district's buildings except the buildings themselves. */
export interface ZoneParams {
  /** Reroll this and the zone's buildings reshuffle. Nothing else moves. */
  seed: number;
  lotSizeM: number;
  gapM: number;
  minHeightM: number;
  maxHeightM: number;
}

export interface Zone extends ZoneParams {
  id: string;
  /** The area this zone governs, in world pixels. */
  rect: Rect;
}

export const DEFAULT_ZONE_PARAMS: ZoneParams = {
  seed: 0,
  lotSizeM: 26,
  gapM: 4,
  minHeightM: 8,
  maxHeightM: 140
};

/** Lots below this are slivers left by a block edge clipping a lot cell. */
const MIN_LOT_AREA_M2 = 40;

/**
 * The unzoned lot grid anchors to world zero, never to the city bounds.
 *
 * WHY: bounds are recomputed on every edit, so anchoring there slides the entire lot
 * grid — and therefore every unzoned building's footprint, height and material — the
 * moment a road extends past the old edge. Zones are safe already: they anchor to their
 * own stored rect.
 */
const BASE_ORIGIN: Vec2 = { x: 0, y: 0 };

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
 * share a rhythm and changing one zone's lot size cannot shift another's.
 */
export function lotRegions(
  base: ZoneParams,
  zones: Zone[],
  bounds: Rect,
  pixelsPerMetre: number
): LotRegion[] {
  const regions: LotRegion[] = [];
  const covered: MultiPolygon[] = [];

  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i]!;
    const rect = ringAsMulti(rectRing(zone.rect));
    const own = difference(rect, covered);
    covered.push(rect);
    if (own.length === 0) continue;
    regions.push({
      seed: zone.seed,
      clip: own,
      options: lotOptions(zone, { x: zone.rect.x, y: zone.rect.y }, pixelsPerMetre)
    });
  }

  const rest = covered.length === 0 ? null : difference(ringAsMulti(rectRing(bounds)), covered);
  if (rest === null || rest.length > 0) {
    regions.push({
      seed: base.seed,
      clip: rest,
      options: lotOptions(base, BASE_ORIGIN, pixelsPerMetre)
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
