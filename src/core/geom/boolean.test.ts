import { describe, expect, it } from "vitest";
import { canonicalizeBooleanOperands, difference, intersectMultiWithRing, intersection, ringAsMulti, subtractPieceFromMulti, union } from "./boolean.js";
import { rectRing, ringArea, type MultiPolygon, type Rect, type Ring } from "./types.js";
import { validateRing } from "../gen/terrain.js";

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

  it("drops rings that collapse after snapping without promoting a hole", () => {
    const collapsed = [[[
      { x: 0, y: 0 },
      { x: 0.0004, y: 0 },
      { x: 0.0004, y: 0.0004 }
    ]]];
    expect(union([collapsed])).toEqual([]);

    const outer = rectRing({ x: 0, y: 0, width: 10, height: 10 });
    const tinyHole = [
      { x: 4, y: 4 },
      { x: 4.0004, y: 4 },
      { x: 4.0004, y: 4.0004 }
    ];
    const result = union([[[outer, tinyHole]]]);
    expect(totalArea(result)).toBeCloseTo(100, 6);

    const nearDuplicate = ringAsMulti([
      { x: 3.6240000000000006, y: 44.436 },
      { x: 3.6240000000000028, y: 44.436 },
      { x: 4, y: 45 },
      { x: 3, y: 45 }
    ]);
    expect(totalArea(union([nearDuplicate]))).toBeGreaterThan(0);
  });
});

describe("canonicalizeBooleanOperands", () => {
  it("makes outer and hole contacts explicit without changing area, winding, or ring ownership", () => {
    const first: MultiPolygon = [[
      rectRing({ x: 0, y: 0, width: 20, height: 20 }),
      [...rectRing({ x: 5, y: 5, width: 10, height: 10 })].reverse()
    ]];
    const second: MultiPolygon = [
      [rectRing({ x: 2, y: -4, width: 6, height: 4 })],
      [rectRing({ x: 7, y: 5, width: 6, height: 3 })]
    ];
    const beforeAreas = [totalArea(first), totalArea(second)];
    const beforeWinding = first[0]!.map((ring) => Math.sign(ringArea(ring)));

    const canonical = canonicalizeBooleanOperands(first, second);
    expect(canonicalizeBooleanOperands(first, second)).toEqual(canonical);
    expect(canonical.map(totalArea)).toEqual(beforeAreas);
    expect(canonical[0]).toHaveLength(1);
    expect(canonical[0]![0]).toHaveLength(2);
    expect(canonical[0]![0]!.map((ring) => Math.sign(ringArea(ring)))).toEqual(beforeWinding);
    expect(canonical[0]![0]![0]).toHaveLength(first[0]![0]!.length + 2);
    expect(canonical[0]![0]![1]).toHaveLength(first[0]![1]!.length + 2);
    for (const operand of canonical) {
      for (const polygon of operand) {
        for (const ring of polygon) expect(validateRing(ring)).toEqual({ ok: true });
      }
    }
  });

  it("splits both operands at the other operand's vertices", () => {
    const horizontal: Ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 0, y: 4 }
    ];
    const nestedContact: Ring = [
      { x: 5, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 3 },
      { x: 5, y: 3 }
    ];
    const [canonicalFirst, canonicalSecond] = canonicalizeBooleanOperands(ringAsMulti(horizontal), ringAsMulti(nestedContact));
    expect(canonicalFirst[0]![0]).toHaveLength(5);
    expect(canonicalSecond[0]![0]).toHaveLength(5);
    expect(totalArea(canonicalFirst)).toBeCloseTo(40, 9);
    expect(totalArea(canonicalSecond)).toBeCloseTo(30, 9);
  });

  it("canonicalizes contacts created by snapping in polygon-clipping's exact coordinate space", () => {
    const horizontal: Ring = [
      { x: 0.0004, y: 0.0004 },
      { x: 10.0004, y: 0.0004 },
      { x: 10.0004, y: 4.0004 },
      { x: 0.0004, y: 4.0004 }
    ];
    const snappedContact: Ring = [
      { x: 5.0004, y: -0.0004 },
      { x: 15.0004, y: -0.0004 },
      { x: 15.0004, y: 2.9996 },
      { x: 5.0004, y: 2.9996 }
    ];

    const [canonicalFirst, canonicalSecond] = canonicalizeBooleanOperands(
      ringAsMulti(horizontal),
      ringAsMulti(snappedContact)
    );

    expect(canonicalFirst[0]![0]).toHaveLength(5);
    expect(canonicalSecond[0]![0]).toHaveLength(5);
    expect(canonicalFirst[0]![0]).toContainEqual({ x: 5, y: 0 });
    expect(canonicalSecond[0]![0]).toContainEqual({ x: 10, y: 0 });
    expect(totalArea(canonicalFirst)).toBeCloseTo(40, 9);
    expect(totalArea(canonicalSecond)).toBeCloseTo(30, 9);
    for (const operand of [canonicalFirst, canonicalSecond]) {
      for (const polygon of operand) {
        for (const ring of polygon) {
          expect(validateRing(ring)).toEqual({ ok: true });
          for (const point of ring) {
            expect(point.x * 1000).toBeCloseTo(Math.round(point.x * 1000), 9);
            expect(point.y * 1000).toBeCloseTo(Math.round(point.y * 1000), 9);
          }
        }
      }
    }
  });

  it("deduplicates and rejects degenerate rings after snapping just like boolean operations", () => {
    const collapsedOuter: Ring = [
      { x: 0, y: 0 },
      { x: 0.0004, y: 0 },
      { x: 0.0004, y: 0.0004 }
    ];
    const validOuter = rectRing({ x: 0, y: 0, width: 10, height: 10 });
    const collapsedHole: Ring = [
      { x: 4, y: 4 },
      { x: 4.0004, y: 4 },
      { x: 4.0004, y: 4.0004 }
    ];

    const [empty, cleaned] = canonicalizeBooleanOperands(
      ringAsMulti(collapsedOuter),
      [[validOuter, collapsedHole]]
    );

    expect(empty).toEqual([]);
    expect(cleaned).toEqual([[validOuter]]);
    expect(union([cleaned])).toEqual(cleaned);
  });
});

describe("pairwise targeted ring booleans", () => {
  it("conserves area and source order across disjoint bbox-relevant polygons", () => {
    const right: MultiPolygon[number] = [
      rectRing({ x: 20, y: 0, width: 10, height: 10 }),
      [...rectRing({ x: 27, y: 3, width: 2, height: 2 })].reverse()
    ];
    const untouched: MultiPolygon[number] = [rectRing({ x: 50, y: 0, width: 10, height: 10 })];
    const left: MultiPolygon[number] = [
      rectRing({ x: 0, y: 0, width: 10, height: 10 }),
      [...rectRing({ x: 1, y: 3, width: 2, height: 2 })].reverse()
    ];
    const base: MultiPolygon = [right, untouched, left];
    const target = rectRing({ x: 6, y: -5, width: 18, height: 20 });

    const remainder = subtractPieceFromMulti(base, target);
    const overlap = intersectMultiWithRing(base, target);
    const minimumX = (polygon: MultiPolygon[number]): number =>
      Math.min(...polygon[0]!.map((point) => point.x));

    expect(remainder).toHaveLength(3);
    expect(remainder[1]).toBe(untouched);
    expect(remainder.map(minimumX)).toEqual([24, 50, 0]);
    expect(overlap.map(minimumX)).toEqual([20, 6]);
    expect(remainder[0]).toHaveLength(2);
    expect(remainder[2]).toHaveLength(2);
    expect(totalArea(remainder) + totalArea(overlap)).toBeCloseTo(totalArea(base), 9);
    for (const polygon of [...remainder, ...overlap]) {
      for (const ring of polygon) expect(validateRing(ring)).toEqual({ ok: true });
    }
  });

  it("preserves hole ownership across targeted difference and intersection", () => {
    const holes = [
      rectRing({ x: 4, y: 8, width: 2, height: 2 }),
      rectRing({ x: 12, y: 8, width: 2, height: 2 }),
      rectRing({ x: 17, y: 12, width: 2, height: 2 }),
      rectRing({ x: 24, y: 8, width: 2, height: 2 })
    ].map((ring) => [...ring].reverse());
    const base: MultiPolygon = [[rectRing({ x: 0, y: 0, width: 30, height: 20 }), ...holes]];
    const target = rectRing({ x: 8, y: 5, width: 14, height: 10 });

    const remainder = subtractPieceFromMulti(base, target);
    const overlap = intersectMultiWithRing(base, target);

    expect(totalArea(remainder) + totalArea(overlap)).toBeCloseTo(totalArea(base), 9);
    expect(remainder).toHaveLength(1);
    expect(overlap).toHaveLength(1);
    expect(remainder[0]).toHaveLength(4);
    expect(overlap[0]).toHaveLength(3);
    for (const polygon of [...remainder, ...overlap]) {
      for (const ring of polygon) expect(validateRing(ring)).toEqual({ ok: true });
    }
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

  it("normalizes decimal drift without rounding rational sweep intersections to another grid row", () => {
    // The sloped edge crosses x = -372.874 halfway between two grid rows.
    // polygon-clipping sweeps integer coordinates, normalizes only arithmetic
    // noise in result space, then converts the rational point back to metres.
    const subject = ringAsMulti([
      { x: -374.874, y: -251.367 },
      { x: -370.874, y: -251.367 },
      { x: -374.874, y: -248.366 }
    ]);
    const clip = box({ x: -372.874, y: -252, width: 4, height: 5 });
    const result = intersection(subject, clip);

    expect(intersection(subject, clip)).toEqual(result);
    expect(result).toHaveLength(1);
    expect(result[0]![0]).toHaveLength(3);
    expect(validateRing(result[0]![0]!)).toEqual({ ok: true });
    const rationalIntersection = result[0]![0]!.find((point) => Math.abs(point.x + 372.874) < 1e-9 && point.y > -251);
    expect(rationalIntersection).toBeDefined();
    expect(rationalIntersection!.y).toBeCloseTo(-249.8665, 9);
    // Keeping the half-grid intersection preserves the analytical 1.5005 m²
    // area; result quantization is many orders below the 0.001 m SNAP tolerance.
    expect(Math.abs(totalArea(result) - 1.5005)).toBeLessThanOrEqual(1e-9);
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
