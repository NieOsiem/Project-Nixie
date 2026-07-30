import { describe, expect, it } from "vitest";
import { difference, intersection, ringAsMulti, union } from "./boolean.js";
import { rectRing, ringArea, type MultiPolygon, type Rect } from "./types.js";

const box = (r: Rect): MultiPolygon => ringAsMulti(rectRing(r));
const totalArea = (mp: MultiPolygon): number =>
  mp.reduce(
    (sum, polygon) =>
      sum + polygon.reduce((s, ring, i) => s + (i === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0),
    0
  );

describe("union", () => {
  it("merges overlapping boxes into one polygon", () => {
    const result = union([
      box({ x: 0, y: 0, width: 10, height: 10 }),
      box({ x: 5, y: 0, width: 10, height: 10 })
    ]);
    expect(result).toHaveLength(1);
    expect(totalArea(result)).toBeCloseTo(150, 3);
  });

  it("keeps disjoint boxes separate", () => {
    const result = union([
      box({ x: 0, y: 0, width: 10, height: 10 }),
      box({ x: 50, y: 0, width: 10, height: 10 })
    ]);
    expect(result).toHaveLength(2);
    expect(totalArea(result)).toBeCloseTo(200, 3);
  });

  it("returns nothing for no input", () => {
    expect(union([])).toEqual([]);
    expect(union([[], []])).toEqual([]);
  });

  it("passes a single input through", () => {
    expect(totalArea(union([box({ x: 0, y: 0, width: 4, height: 4 })]))).toBeCloseTo(16, 3);
  });

  it("leaves rings implicitly closed", () => {
    const ring = union([box({ x: 0, y: 0, width: 10, height: 10 })])[0]![0]!;
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    expect(first.x === last.x && first.y === last.y).toBe(false);
    expect(ring).toHaveLength(4);
  });
});

describe("difference", () => {
  it("cuts a notch out of a box", () => {
    const result = difference(box({ x: 0, y: 0, width: 10, height: 10 }), [
      box({ x: 0, y: 0, width: 4, height: 4 })
    ]);
    expect(totalArea(result)).toBeCloseTo(84, 3);
  });

  it("produces a hole when the cut is interior", () => {
    const result = difference(box({ x: 0, y: 0, width: 30, height: 30 }), [
      box({ x: 10, y: 10, width: 10, height: 10 })
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    expect(totalArea(result)).toBeCloseTo(800, 3);
  });

  it("splits a box into separate blocks when a cross is removed", () => {
    // The shape of the block-derivation step: bounds minus a road cross.
    const result = difference(box({ x: 0, y: 0, width: 30, height: 30 }), [
      box({ x: 13, y: 0, width: 4, height: 30 }),
      box({ x: 0, y: 13, width: 30, height: 4 })
    ]);
    expect(result).toHaveLength(4);
    expect(totalArea(result)).toBeCloseTo(13 * 13 * 4, 3);
  });

  it("returns the base untouched when nothing is cut", () => {
    const base = box({ x: 0, y: 0, width: 10, height: 10 });
    expect(difference(base, [])).toBe(base);
    expect(totalArea(difference(base, [[]]))).toBeCloseTo(100, 3);
  });

  it("returns nothing when the base is empty", () => {
    expect(difference([], [box({ x: 0, y: 0, width: 10, height: 10 })])).toEqual([]);
  });

  it("returns nothing when fully covered", () => {
    const result = difference(box({ x: 2, y: 2, width: 4, height: 4 }), [
      box({ x: 0, y: 0, width: 10, height: 10 })
    ]);
    expect(totalArea(result)).toBeCloseTo(0, 6);
  });
});

describe("intersection", () => {
  it("keeps only the overlap", () => {
    const result = intersection(
      box({ x: 0, y: 0, width: 10, height: 10 }),
      box({ x: 6, y: 6, width: 10, height: 10 })
    );
    expect(totalArea(result)).toBeCloseTo(16, 3);
  });

  it("is empty for disjoint input", () => {
    const result = intersection(
      box({ x: 0, y: 0, width: 10, height: 10 }),
      box({ x: 100, y: 100, width: 10, height: 10 })
    );
    expect(result).toEqual([]);
  });

  it("short-circuits on empty input", () => {
    expect(intersection([], box({ x: 0, y: 0, width: 1, height: 1 }))).toEqual([]);
    expect(intersection(box({ x: 0, y: 0, width: 1, height: 1 }), [])).toEqual([]);
  });
});
