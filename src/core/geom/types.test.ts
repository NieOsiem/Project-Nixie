import { describe, expect, it } from "vitest";
import { normalizeRect, rectContains, rectRing, ringArea, ringBounds, ringCentroid, type Ring } from "./types.js";

const square = (size = 10): Ring => [
  { x: 0, y: 0 },
  { x: size, y: 0 },
  { x: size, y: size },
  { x: 0, y: size }
];

describe("ringArea", () => {
  it("is positive for the canonical winding", () => {
    expect(ringArea(square())).toBe(100);
  });

  it("flips sign with winding", () => {
    expect(ringArea([...square()].reverse())).toBe(-100);
  });

  it("is zero for a degenerate ring", () => {
    expect(ringArea([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toBe(0);
  });
});

describe("ringBounds", () => {
  it("covers every point", () => {
    expect(ringBounds(square(8))).toEqual({ x: 0, y: 0, width: 8, height: 8 });
  });

  it("handles negative coordinates", () => {
    const r = ringBounds([{ x: -30, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 25 }]);
    expect(r).toEqual({ x: -30, y: -5, width: 40, height: 30 });
  });
});

describe("ringCentroid", () => {
  it("finds the centre of a square", () => {
    const c = ringCentroid(square());
    expect(c.x).toBeCloseTo(5, 9);
    expect(c.y).toBeCloseTo(5, 9);
  });

  it("is winding-independent", () => {
    const a = ringCentroid(square());
    const b = ringCentroid([...square()].reverse());
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  it("falls back to the bounding-box centre for a zero-area ring", () => {
    const c = ringCentroid([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }]);
    expect(c).toEqual({ x: 10, y: 10 });
  });
});

describe("rectRing", () => {
  it("produces a positively wound rectangle", () => {
    const ring = rectRing({ x: 3, y: 4, width: 10, height: 5 });
    expect(ring).toHaveLength(4);
    expect(ringArea(ring)).toBe(50);
    expect(ringBounds(ring)).toEqual({ x: 3, y: 4, width: 10, height: 5 });
  });
});

describe("normalizeRect", () => {
  it("leaves a positive rect alone", () => {
    const r = { x: 1, y: 2, width: 3, height: 4 };
    expect(normalizeRect(r)).toEqual(r);
  });

  it("flips a rect dragged up and left", () => {
    expect(normalizeRect({ x: 10, y: 10, width: -4, height: -6 })).toEqual({
      x: 6,
      y: 4,
      width: 4,
      height: 6
    });
  });
});

describe("rectContains", () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };

  it("accepts interior and edge points", () => {
    expect(rectContains(r, { x: 5, y: 5 })).toBe(true);
    expect(rectContains(r, { x: 0, y: 10 })).toBe(true);
  });

  it("rejects points outside", () => {
    expect(rectContains(r, { x: -0.1, y: 5 })).toBe(false);
    expect(rectContains(r, { x: 5, y: 10.1 })).toBe(false);
  });
});
