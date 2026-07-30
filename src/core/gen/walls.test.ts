import { describe, expect, it } from "vitest";
import { rectRing, type MultiPolygon, type Polygon } from "../geom/types.js";
import { totalWallLength, wallSegmentsFromBlocks, type WallSegment } from "./walls.js";

const options = { tolerancePx: 1 };

const box = (x: number, y: number, w: number, h: number): Polygon => [
  rectRing({ x, y, width: w, height: h })
];

/** Every endpoint must be shared by exactly two segments for the loop to be sealed. */
const isClosedLoop = (segments: WallSegment[]): boolean => {
  const degree = new Map<string, number>();
  const bump = (x: number, y: number) => {
    const k = `${x},${y}`;
    degree.set(k, (degree.get(k) ?? 0) + 1);
  };
  for (const s of segments) {
    bump(s.x1, s.y1);
    bump(s.x2, s.y2);
  }
  return [...degree.values()].every((d) => d % 2 === 0);
};

describe("wallSegmentsFromBlocks", () => {
  it("walls a rectangular block with four segments", () => {
    const segments = wallSegmentsFromBlocks([box(0, 0, 100, 50)], options);
    expect(segments).toHaveLength(4);
    expect(totalWallLength(segments)).toBeCloseTo(300, 6);
  });

  it("emits a sealed loop", () => {
    expect(isClosedLoop(wallSegmentsFromBlocks([box(0, 0, 100, 50)], options))).toBe(true);
  });

  it("walls holes as well as outer rings", () => {
    const withCourtyard: Polygon = [
      rectRing({ x: 0, y: 0, width: 300, height: 300 }),
      rectRing({ x: 100, y: 100, width: 100, height: 100 })
    ];
    const segments = wallSegmentsFromBlocks([withCourtyard], options);
    expect(segments).toHaveLength(8);
    expect(isClosedLoop(segments)).toBe(true);
  });

  it("handles several blocks", () => {
    const blocks: MultiPolygon = [box(0, 0, 100, 100), box(200, 0, 100, 100)];
    expect(wallSegmentsFromBlocks(blocks, options)).toHaveLength(8);
  });

  it("emits only integer coordinates", () => {
    const skewed: Polygon = [
      [
        { x: 0.4, y: 0.6 },
        { x: 100.7, y: 3.2 },
        { x: 98.1, y: 80.9 },
        { x: 1.3, y: 77.5 }
      ]
    ];
    for (const s of wallSegmentsFromBlocks([skewed], options)) {
      for (const v of [s.x1, s.y1, s.x2, s.y2]) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("stays sealed after rounding", () => {
    const skewed: Polygon = [
      [
        { x: 0.4, y: 0.6 },
        { x: 100.7, y: 3.2 },
        { x: 98.1, y: 80.9 },
        { x: 1.3, y: 77.5 }
      ]
    ];
    expect(isClosedLoop(wallSegmentsFromBlocks([skewed], options))).toBe(true);
  });

  it("drops segments that collapse when rounded", () => {
    const withNearDuplicate: Polygon = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100.2, y: 0.1 },
        { x: 100, y: 60 },
        { x: 0, y: 60 }
      ]
    ];
    const segments = wallSegmentsFromBlocks([withNearDuplicate], { tolerancePx: 0 });
    for (const s of segments) {
      expect(s.x1 === s.x2 && s.y1 === s.y2).toBe(false);
    }
    expect(isClosedLoop(segments)).toBe(true);
  });

  it("cuts wall count on arc-heavy rings as tolerance grows", () => {
    const arc: Polygon = [
      Array.from({ length: 48 }, (_, i) => ({
        x: 500 + 200 * Math.cos((i / 48) * Math.PI * 2),
        y: 500 + 200 * Math.sin((i / 48) * Math.PI * 2)
      }))
    ];
    const tight = wallSegmentsFromBlocks([arc], { tolerancePx: 0.01 }).length;
    const loose = wallSegmentsFromBlocks([arc], { tolerancePx: 25 }).length;
    expect(tight).toBe(48);
    expect(loose).toBeLessThan(12);
  });

  it("skips rings that collapse below a triangle", () => {
    const degenerate: Polygon = [
      [
        { x: 0, y: 0 },
        { x: 0.2, y: 0 },
        { x: 0.1, y: 0.2 }
      ]
    ];
    expect(wallSegmentsFromBlocks([degenerate], options)).toEqual([]);
  });

  it("returns nothing for no blocks", () => {
    expect(wallSegmentsFromBlocks([], options)).toEqual([]);
  });
});
