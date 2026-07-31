import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds, type Polygon } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, FIRST_ZONE_BANK } from "../palette.js";
import {
  buildingsForBlocks,
  HEIGHT_EXPONENT,
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

const region = (over: Partial<LotOptions> = {}, seed = 0, bank = FIRST_ZONE_BANK): LotRegion[] => [
  { seed, bank, options: options(over), clip: null }
];

const bankOf = (material: number): number => Math.floor(material / BANK_SIZE);
const slotOf = (material: number): number => material % BANK_SIZE;

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
  /** One half of a 900-wide block, as its own district. */
  const half = (x: number, seed: number, bank = FIRST_ZONE_BANK): LotRegion => ({
    seed,
    bank,
    options: options(),
    clip: [[rectRing({ x, y: 0, width: 450, height: 300 })]]
  });

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

  it("keeps a larger tower population than the old quadratic curve", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], region(), FRAME);
    const average =
      specs.reduce((sum, s) => sum + (s.height - 10) / 90, 0) / specs.length;
    expect(HEIGHT_EXPONENT).toBeLessThan(2);
    expect(average).toBeGreaterThan(0.36);
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
    const before = buildingsForBlocks(blocks, [half(0, 1), half(450, 2)], FRAME);
    const after = buildingsForBlocks(blocks, [half(0, 1), half(450, 3)], FRAME);

    const west = (specs: typeof before) => specs.filter((s) => ringBounds(s.footprint).x < 450);
    expect(after).toHaveLength(before.length);
    expect(west(after)).toEqual(west(before));
    expect(after.map((s) => s.height)).not.toEqual(before.map((s) => s.height));
  });

  it("takes wall and roof materials from the region's bank", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], region({}, 0, 5), FRAME);
    expect(specs.length).toBeGreaterThan(20);
    for (const s of specs) {
      expect(bankOf(s.wallMaterial)).toBe(5);
      expect(bankOf(s.roofMaterial)).toBe(5);
      expect(slotOf(s.wallMaterial)).toBeLessThanOrEqual(DISTRICT_SLOT.WALL_C);
      expect(slotOf(s.roofMaterial)).toBeGreaterThanOrEqual(DISTRICT_SLOT.ROOF_A);
      expect(slotOf(s.roofMaterial)).toBeLessThanOrEqual(DISTRICT_SLOT.ROOF_C);
    }
  });

  it("puts two districts' materials in disjoint banks", () => {
    const blocks = [block(0, 0, 900, 300)];
    const specs = buildingsForBlocks(blocks, [half(0, 1, 4), half(450, 2, 9)], FRAME);
    const banks = (side: (x: number) => boolean) =>
      new Set(specs.filter((s) => side(ringBounds(s.footprint).x)).flatMap((s) => [bankOf(s.wallMaterial), bankOf(s.roofMaterial)]));
    expect(banks((x) => x < 450)).toEqual(new Set([4]));
    expect(banks((x) => x >= 450)).toEqual(new Set([9]));
  });

  it("cannot let one district's reseed or move touch another's material indices", () => {
    const blocks = [block(0, 0, 900, 300)];
    const materials = (specs: ReturnType<typeof buildingsForBlocks>) =>
      specs
        .filter((s) => bankOf(s.wallMaterial) === 4)
        .map((s) => `${Math.round(ringBounds(s.footprint).x)}:${s.wallMaterial}/${s.roofMaterial}`)
        .sort();

    const before = materials(buildingsForBlocks(blocks, [half(0, 1, 4), half(450, 2, 9)], FRAME));
    const reseeded = materials(buildingsForBlocks(blocks, [half(0, 1, 4), half(450, 77, 9)], FRAME));
    // Moving the east district off its old span leaves that ground to the base region.
    const moved = materials(buildingsForBlocks(blocks, [half(0, 1, 4), half(600, 2, 9)], FRAME));

    expect(before.length).toBeGreaterThan(5);
    expect(reseeded).toEqual(before);
    expect(moved).toEqual(before);
  });

  it("gives every lot a facade seed independent of its height and materials", () => {
    const specs = buildingsForBlocks([block(0, 0, 900, 900)], region(), FRAME);
    expect(specs.length).toBeGreaterThan(20);
    for (const s of specs) {
      expect(s.seed).toBeGreaterThanOrEqual(0);
      expect(s.seed).toBeLessThan(1);
    }
    expect(new Set(specs.map((s) => Math.round(s.seed * 1000))).size).toBeGreaterThan(5);

    const t = specs.map((s) =>
      Math.pow((s.height - 10) / 90, 1 / HEIGHT_EXPONENT).toFixed(6)
    );
    expect(specs.map((s) => s.seed.toFixed(6))).not.toEqual(t);
    // The bank only picks the palette slot, so it must leave the facade seed alone.
    const other = buildingsForBlocks([block(0, 0, 900, 900)], region({}, 0, 11), FRAME);
    expect(other.map((s) => s.seed)).toEqual(specs.map((s) => s.seed));
  });

  it("keeps the facade seed deterministic per lot", () => {
    const a = buildingsForBlocks([block(0, 0, 600, 600)], region(), FRAME);
    const b = buildingsForBlocks([block(0, 0, 600, 600)], region(), FRAME);
    expect(b.map((s) => s.seed)).toEqual(a.map((s) => s.seed));
    expect(new Set(a.map((s) => s.seed)).size).toBeGreaterThan(1);
  });
});
