import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds, type Polygon } from "../geom/types.js";
import {
  buildingsForBlocks,
  subdivideBlock,
  type HashFrame,
  type LotOptions,
  type LotRegion
} from "./blocks.js";

/** These fixtures work in raw pixels, so the frame is the identity one. */
const FRAME: HashFrame = { originPx: { x: 0, y: 0 }, pixelsPerMetre: 1 };

const options = (over: Partial<LotOptions> = {}): LotOptions => ({
  originPx: { x: 0, y: 0 },
  lotSizePx: 100,
  gapPx: 20,
  minAreaPx2: 400,
  minHeightM: 10,
  maxHeightM: 100,
  ...over
});

const region = (over: Partial<LotOptions> = {}, seed = 0): LotRegion[] => [
  { seed, options: options(over), clip: null }
];

const block = (x: number, y: number, w: number, h: number): Polygon => [
  rectRing({ x, y, width: w, height: h })
];

describe("subdivideBlock", () => {
  it("fills a block with lots on the absolute grid", () => {
    const lots = subdivideBlock(block(0, 0, 300, 300), options());
    expect(lots).toHaveLength(9);
    for (const lot of lots) {
      expect(Math.abs(ringArea(lot[0]!))).toBeCloseTo(80 * 80, 3);
    }
  });

  it("anchors the grid to world coordinates, not the block", () => {
    // Two blocks offset by exactly one lot must produce identically shaped lots.
    const a = subdivideBlock(block(0, 0, 200, 100), options());
    const b = subdivideBlock(block(100, 0, 200, 100), options());
    const sizeOf = (lots: Polygon[]) =>
      lots.map((l) => Math.round(Math.abs(ringArea(l[0]!)))).sort((x, y) => x - y);
    expect(sizeOf(b)).toEqual(sizeOf(a));
  });

  it("leaves alleys between lots", () => {
    const lots = subdivideBlock(block(0, 0, 200, 100), options());
    const boxes = lots.map((l) => ringBounds(l[0]!));
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("clips lots to the block boundary", () => {
    const lots = subdivideBlock(block(0, 0, 150, 100), options());
    for (const lot of lots) {
      const clipped = intersection(ringAsMulti(lot[0]!), [block(0, 0, 150, 100)]);
      const kept = Math.abs(ringArea(clipped[0]![0]!));
      expect(kept).toBeCloseTo(Math.abs(ringArea(lot[0]!)), 3);
    }
  });

  it("drops slivers below the minimum area", () => {
    // 215 wide leaves a third column clipped to 5x80 = 400, well under a full lot.
    const generous = subdivideBlock(block(0, 0, 215, 100), options({ minAreaPx2: 1 }));
    const strict = subdivideBlock(block(0, 0, 215, 100), options({ minAreaPx2: 4000 }));
    expect(generous).toHaveLength(3);
    expect(strict).toHaveLength(2);
    for (const lot of strict) expect(Math.abs(ringArea(lot[0]!))).toBeGreaterThanOrEqual(4000);
  });

  it("returns nothing for a degenerate block", () => {
    expect(subdivideBlock([], options())).toEqual([]);
    expect(subdivideBlock([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], options())).toEqual([]);
  });

  it("handles a concave block", () => {
    const l: Polygon = [
      [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
        { x: 300, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: 300 },
        { x: 0, y: 300 }
      ]
    ];
    const lots = subdivideBlock(l, options());
    expect(lots.length).toBeGreaterThan(0);
    const total = lots.reduce((s, lot) => s + Math.abs(ringArea(lot[0]!)), 0);
    expect(total).toBeLessThan(Math.abs(ringArea(l[0]!)));
  });
});

describe("buildingsForBlocks", () => {
  it("produces one spec per lot", () => {
    const blocks = [block(0, 0, 300, 300)];
    expect(buildingsForBlocks(blocks, region(), FRAME)).toHaveLength(9);
  });

  it("keeps heights inside the configured range", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], region(), FRAME);
    expect(specs.length).toBeGreaterThan(20);
    for (const s of specs) {
      expect(s.height).toBeGreaterThanOrEqual(10);
      expect(s.height).toBeLessThanOrEqual(100);
    }
  });

  it("varies height across lots", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], region(), FRAME);
    const distinct = new Set(specs.map((s) => Math.round(s.height)));
    expect(distinct.size).toBeGreaterThan(5);
  });

  it("is deterministic", () => {
    const a = buildingsForBlocks([block(0, 0, 600, 600)], region(), FRAME);
    const b = buildingsForBlocks([block(0, 0, 600, 600)], region(), FRAME);
    expect(b.map((s) => s.height)).toEqual(a.map((s) => s.height));
    expect(b.map((s) => s.wallMaterial)).toEqual(a.map((s) => s.wallMaterial));
  });

  it("assigns more than one material", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], region(), FRAME);
    expect(new Set(specs.map((s) => s.wallMaterial)).size).toBeGreaterThan(1);
    expect(new Set(specs.map((s) => s.roofMaterial)).size).toBeGreaterThan(1);
  });

  it("returns nothing for no blocks", () => {
    expect(buildingsForBlocks([], region(), FRAME)).toEqual([]);
  });

  it("reshuffles on a new seed without moving a lot", () => {
    const a = buildingsForBlocks([block(0, 0, 900, 900)], region({}, 0), FRAME);
    const b = buildingsForBlocks([block(0, 0, 900, 900)], region({}, 987654), FRAME);
    expect(b.map((s) => s.footprint)).toEqual(a.map((s) => s.footprint));
    expect(b.map((s) => s.height)).not.toEqual(a.map((s) => s.height));
  });

  it("keeps one region's reseed out of its neighbour", () => {
    const blocks = [block(0, 0, 900, 300)];
    const half = (x: number, seed: number): LotRegion => ({
      seed,
      options: options(),
      clip: [[rectRing({ x, y: 0, width: 450, height: 300 })]]
    });
    const before = buildingsForBlocks(blocks, [half(0, 1), half(450, 2)], FRAME);
    const after = buildingsForBlocks(blocks, [half(0, 1), half(450, 3)], FRAME);

    const west = (specs: typeof before) => specs.filter((s) => ringBounds(s.footprint).x < 450);
    expect(after).toHaveLength(before.length);
    expect(west(after)).toEqual(west(before));
    expect(after.map((s) => s.height)).not.toEqual(before.map((s) => s.height));
  });
});
