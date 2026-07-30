import { describe, expect, it } from "vitest";
import { intersection } from "../geom/boolean.js";
import { ringArea, type Rect } from "../geom/types.js";
import { DEFAULT_ZONE_PARAMS, lotOptions, lotRegions, nextZoneId, zoneAt, type Zone } from "./zones.js";

const BOUNDS: Rect = { x: 0, y: 0, width: 1000, height: 1000 };
/** Where metre coordinate (0, 0) sits. Zones and bounds arrive already converted. */
const ORIGIN = { x: 0, y: 0 };

const zone = (id: string, rect: Rect, seed = 0): Zone => ({ ...DEFAULT_ZONE_PARAMS, id, rect, seed });

const area = (regionIndex: number, regions: ReturnType<typeof lotRegions>): number =>
  (regions[regionIndex]!.clip ?? []).reduce(
    (sum, polygon) => sum + polygon.reduce((s, ring) => s + Math.abs(ringArea(ring)), 0),
    0
  );

describe("lotOptions", () => {
  it("scales lengths with pixels per metre and leaves heights in metres", () => {
    const a = lotOptions(DEFAULT_ZONE_PARAMS, { x: 0, y: 0 }, 25);
    const b = lotOptions(DEFAULT_ZONE_PARAMS, { x: 0, y: 0 }, 50);
    expect(b.lotSizePx).toBe(a.lotSizePx * 2);
    expect(b.gapPx).toBe(a.gapPx * 2);
    expect(b.minAreaPx2).toBe(a.minAreaPx2 * 4);
    expect(b.maxHeightM).toBe(a.maxHeightM);
  });

  it("anchors the lot grid to the origin it is given", () => {
    expect(lotOptions(DEFAULT_ZONE_PARAMS, { x: 300, y: -40 }, 25).originPx).toEqual({ x: 300, y: -40 });
  });
});

describe("lotRegions", () => {
  it("covers everything with one region when there are no zones", () => {
    const regions = lotRegions(DEFAULT_ZONE_PARAMS, [], BOUNDS, 25, ORIGIN);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.clip).toBeNull();
    expect(regions[0]!.seed).toBe(DEFAULT_ZONE_PARAMS.seed);
  });

  it("splits into the zone and the leftover", () => {
    const regions = lotRegions(
      DEFAULT_ZONE_PARAMS,
      [zone("z1", { x: 0, y: 0, width: 400, height: 1000 }, 7)],
      BOUNDS,
      25,
      ORIGIN
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]!.seed).toBe(7);
    expect(area(0, regions)).toBeCloseTo(400 * 1000, 3);
    expect(area(1, regions)).toBeCloseTo(600 * 1000, 3);
  });

  it("makes overlapping zones disjoint, last one winning", () => {
    const regions = lotRegions(
      DEFAULT_ZONE_PARAMS,
      [zone("z1", { x: 0, y: 0, width: 600, height: 1000 }, 1), zone("z2", { x: 400, y: 0, width: 600, height: 1000 }, 2)],
      BOUNDS,
      25,
      ORIGIN
    );
    expect(regions).toHaveLength(2);
    // z2 was added last, so it keeps the whole overlap and z1 is cut back.
    expect(regions[0]!.seed).toBe(2);
    expect(area(0, regions)).toBeCloseTo(600 * 1000, 3);
    expect(area(1, regions)).toBeCloseTo(400 * 1000, 3);

    const overlap = intersection(regions[0]!.clip!, regions[1]!.clip!);
    expect(overlap).toEqual([]);
  });

  it("drops a zone completely buried by a later one", () => {
    const regions = lotRegions(
      DEFAULT_ZONE_PARAMS,
      [zone("z1", { x: 100, y: 100, width: 100, height: 100 }, 1), zone("z2", { x: 0, y: 0, width: 500, height: 500 }, 2)],
      BOUNDS,
      25,
      ORIGIN
    );
    expect(regions.map((r) => r.seed)).toEqual([2, DEFAULT_ZONE_PARAMS.seed]);
  });

  it("omits the leftover when zones cover the bounds", () => {
    const regions = lotRegions(DEFAULT_ZONE_PARAMS, [zone("z1", BOUNDS, 3)], BOUNDS, 25, ORIGIN);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.seed).toBe(3);
  });

  it("gives each zone its own lot anchor", () => {
    const regions = lotRegions(
      DEFAULT_ZONE_PARAMS,
      [zone("z1", { x: 250, y: 375, width: 200, height: 200 })],
      BOUNDS,
      25,
      ORIGIN
    );
    expect(regions[0]!.options.originPx).toEqual({ x: 250, y: 375 });
  });

  it("anchors the unzoned grid to the city origin, not to the bounds", () => {
    // Bounds move on every edit; anchoring there would reshuffle the whole city the
    // moment a road extends past the old edge. The origin is metre (0, 0) and never moves.
    const origin = { x: 5000, y: 4000 };
    const near = lotRegions(DEFAULT_ZONE_PARAMS, [], { x: -400, y: 900, width: 100, height: 100 }, 25, origin);
    const far = lotRegions(DEFAULT_ZONE_PARAMS, [], { x: 7777, y: -3333, width: 5000, height: 5000 }, 25, origin);
    expect(near[0]!.options.originPx).toEqual(origin);
    expect(far[0]!.options).toEqual(near[0]!.options);
  });
});

describe("zoneAt", () => {
  const zones = [
    zone("z1", { x: 0, y: 0, width: 100, height: 100 }),
    zone("z2", { x: 50, y: 50, width: 100, height: 100 })
  ];

  it("returns the topmost zone under the point", () => {
    expect(zoneAt(zones, { x: 75, y: 75 })?.id).toBe("z2");
    expect(zoneAt(zones, { x: 10, y: 10 })?.id).toBe("z1");
  });

  it("returns nothing outside every zone", () => {
    expect(zoneAt(zones, { x: 400, y: 400 })).toBeNull();
    expect(zoneAt([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("nextZoneId", () => {
  it("fills the first free slot", () => {
    expect(nextZoneId([])).toBe("z1");
    expect(nextZoneId([zone("z1", BOUNDS), zone("z3", BOUNDS)])).toBe("z2");
  });
});
