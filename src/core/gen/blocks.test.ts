import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds, type Polygon } from "../geom/types.js";
import { buildingsForBlocks, subdivideBlock, type LotOptions } from "./blocks.js";

const options = (over: Partial<LotOptions> = {}): LotOptions => ({
  lotSizePx: 100,
  gapPx: 20,
  minAreaPx2: 400,
  minHeightM: 10,
  maxHeightM: 100,
  ...over
});

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
    expect(buildingsForBlocks(blocks, options())).toHaveLength(9);
  });

  it("keeps heights inside the configured range", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], options());
    expect(specs.length).toBeGreaterThan(20);
    for (const s of specs) {
      expect(s.height).toBeGreaterThanOrEqual(10);
      expect(s.height).toBeLessThanOrEqual(100);
    }
  });

  it("varies height across lots", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], options());
    const distinct = new Set(specs.map((s) => Math.round(s.height)));
    expect(distinct.size).toBeGreaterThan(5);
  });

  it("is deterministic", () => {
    const a = buildingsForBlocks([block(0, 0, 600, 600)], options());
    const b = buildingsForBlocks([block(0, 0, 600, 600)], options());
    expect(b.map((s) => s.height)).toEqual(a.map((s) => s.height));
    expect(b.map((s) => s.wallMaterial)).toEqual(a.map((s) => s.wallMaterial));
  });

  it("assigns more than one material", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], options());
    expect(new Set(specs.map((s) => s.wallMaterial)).size).toBeGreaterThan(1);
    expect(new Set(specs.map((s) => s.roofMaterial)).size).toBeGreaterThan(1);
  });

  it("returns nothing for no blocks", () => {
    expect(buildingsForBlocks([], options())).toEqual([]);
  });
});
