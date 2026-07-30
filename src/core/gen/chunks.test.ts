import { describe, expect, it } from "vitest";
import type { Rect } from "../geom/types.js";
import {
  CHUNK_SIZE_M,
  chunkId,
  chunkKeyAt,
  chunkQueryRect,
  chunkRect,
  chunksCovering,
  parseChunkId,
  rectsIntersect,
  unionRect,
  type ChunkKey
} from "./chunks.js";

const ids = (keys: ChunkKey[]): string[] => keys.map(chunkId);

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe("chunkKeyAt", () => {
  it("puts the metre origin in chunk zero", () => {
    expect(chunkKeyAt({ x: 0, y: 0 })).toEqual({ cx: 0, cy: 0 });
    expect(chunkKeyAt({ x: CHUNK_SIZE_M - 1, y: 1 })).toEqual({ cx: 0, cy: 0 });
  });

  it("floors negative coordinates instead of truncating them", () => {
    expect(chunkKeyAt({ x: -1, y: -1 })).toEqual({ cx: -1, cy: -1 });
    expect(chunkKeyAt({ x: -0.5, y: -0.5 })).toEqual({ cx: -1, cy: -1 });
    expect(chunkKeyAt({ x: -CHUNK_SIZE_M - 1, y: -CHUNK_SIZE_M * 2 - 1 })).toEqual({ cx: -2, cy: -3 });
  });

  it("gives a point exactly on a boundary to the higher chunk", () => {
    expect(chunkKeyAt({ x: CHUNK_SIZE_M, y: CHUNK_SIZE_M })).toEqual({ cx: 1, cy: 1 });
    expect(chunkKeyAt({ x: -CHUNK_SIZE_M, y: -CHUNK_SIZE_M })).toEqual({ cx: -1, cy: -1 });
  });

  it("honours a non-default chunk size", () => {
    expect(chunkKeyAt({ x: 30, y: -1 }, 10)).toEqual({ cx: 3, cy: -1 });
    expect(chunkKeyAt({ x: 29.9, y: -10 }, 10)).toEqual({ cx: 2, cy: -1 });
  });
});

describe("chunkRect", () => {
  it("covers one chunk size from its own corner", () => {
    expect(chunkRect({ cx: 0, cy: 0 })).toEqual({ x: 0, y: 0, width: CHUNK_SIZE_M, height: CHUNK_SIZE_M });
    expect(chunkRect({ cx: 2, cy: 1 })).toEqual({
      x: CHUNK_SIZE_M * 2,
      y: CHUNK_SIZE_M,
      width: CHUNK_SIZE_M,
      height: CHUNK_SIZE_M
    });
  });

  it("places negative chunks below and left of the origin", () => {
    expect(chunkRect({ cx: -1, cy: -2 })).toEqual({
      x: -CHUNK_SIZE_M,
      y: -CHUNK_SIZE_M * 2,
      width: CHUNK_SIZE_M,
      height: CHUNK_SIZE_M
    });
  });

  it("agrees with chunkKeyAt at its corner and its centre", () => {
    for (const key of [{ cx: 0, cy: 0 }, { cx: 3, cy: -7 }, { cx: -2, cy: -2 }]) {
      const r = chunkRect(key);
      expect(chunkKeyAt({ x: r.x, y: r.y })).toEqual(key);
      expect(chunkKeyAt({ x: r.x + r.width / 2, y: r.y + r.height / 2 })).toEqual(key);
    }
  });

  it("honours a non-default chunk size", () => {
    expect(chunkRect({ cx: -1, cy: 2 }, 10)).toEqual({ x: -10, y: 20, width: 10, height: 10 });
  });
});

describe("chunkId", () => {
  it("round-trips negative keys", () => {
    for (const key of [{ cx: 0, cy: 0 }, { cx: -1, cy: -1 }, { cx: -14, cy: 9 }, { cx: 9, cy: -14 }]) {
      expect(parseChunkId(chunkId(key))).toEqual(key);
    }
  });

  it("distinguishes transposed coordinates", () => {
    expect(chunkId({ cx: 9, cy: -14 })).not.toBe(chunkId({ cx: -14, cy: 9 }));
  });

  it("rejects a malformed id rather than yielding a NaN key", () => {
    expect(() => parseChunkId("3")).toThrow();
    expect(() => parseChunkId("3,")).toThrow();
    expect(() => parseChunkId("a,b")).toThrow();
  });
});

describe("chunksCovering", () => {
  it("returns the single chunk holding a small rect", () => {
    expect(ids(chunksCovering(rect(10, 10, 20, 20)))).toEqual(["0,0"]);
  });

  it("returns one chunk for a zero-size rect", () => {
    expect(ids(chunksCovering(rect(10, 10, 0, 0)))).toEqual(["0,0"]);
    expect(ids(chunksCovering(rect(-10, -10, 0, 0)))).toEqual(["-1,-1"]);
  });

  it("still returns a row of chunks for a zero-height rect", () => {
    expect(ids(chunksCovering(rect(10, 10, CHUNK_SIZE_M, 0)))).toEqual(["0,0", "1,0"]);
  });

  it("spans negative and positive coordinates across the origin", () => {
    expect(ids(chunksCovering(rect(-10, -10, 20, 20)))).toEqual(["-1,-1", "-1,0", "0,-1", "0,0"]);
  });

  it("excludes a chunk the rect only touches at its far edge", () => {
    expect(ids(chunksCovering(rect(0, 0, CHUNK_SIZE_M, CHUNK_SIZE_M)))).toEqual(["0,0"]);
    expect(ids(chunksCovering(rect(0, 0, CHUNK_SIZE_M + 1, CHUNK_SIZE_M + 1)))).toEqual([
      "0,0",
      "0,1",
      "1,0",
      "1,1"
    ]);
  });

  it("returns exactly the one chunk a chunk rect came from", () => {
    for (const key of [
      { cx: 0, cy: 0 },
      { cx: -1, cy: -1 },
      { cx: -3, cy: 5 },
      { cx: 7, cy: -12 }
    ]) {
      expect(chunksCovering(chunkRect(key))).toEqual([key]);
      expect(chunksCovering(chunkRect(key, 10), 10)).toEqual([key]);
    }
  });

  it("returns chunks sorted by cx then cy", () => {
    expect(ids(chunksCovering(rect(-CHUNK_SIZE_M - 1, -1, CHUNK_SIZE_M * 2 + 2, 1)))).toEqual([
      "-2,-1",
      "-1,-1",
      "0,-1",
      "1,-1"
    ]);
    expect(ids(chunksCovering(rect(-1, -1, 2, CHUNK_SIZE_M + 2)))).toEqual([
      "-1,-1",
      "-1,0",
      "-1,1",
      "0,-1",
      "0,0",
      "0,1"
    ]);
  });

  it("covers a rect drawn with negative extents", () => {
    expect(ids(chunksCovering(rect(10, 10, -20, -20)))).toEqual(["-1,-1", "-1,0", "0,-1", "0,0"]);
  });

  it("returns chunks whose rects all intersect the query rect", () => {
    const query = rect(-200, 50, 500, 300);
    for (const key of chunksCovering(query)) {
      expect(rectsIntersect(chunkRect(key), query)).toBe(true);
    }
  });

  it("honours a non-default chunk size", () => {
    expect(ids(chunksCovering(rect(0, 0, 20, 20), 10))).toEqual(["0,0", "0,1", "1,0", "1,1"]);
    expect(ids(chunksCovering(rect(0, 0, 21, 21), 10))).toEqual([
      "0,0",
      "0,1",
      "0,2",
      "1,0",
      "1,1",
      "1,2",
      "2,0",
      "2,1",
      "2,2"
    ]);
  });
});

describe("chunkQueryRect", () => {
  it("grows the chunk rect by the margin on every side", () => {
    expect(chunkQueryRect({ cx: 0, cy: 0 }, 5)).toEqual({
      x: -5,
      y: -5,
      width: CHUNK_SIZE_M + 10,
      height: CHUNK_SIZE_M + 10
    });
    expect(chunkQueryRect({ cx: -1, cy: 2 }, 5)).toEqual({
      x: -CHUNK_SIZE_M - 5,
      y: CHUNK_SIZE_M * 2 - 5,
      width: CHUNK_SIZE_M + 10,
      height: CHUNK_SIZE_M + 10
    });
  });

  it("equals the chunk rect at zero margin", () => {
    expect(chunkQueryRect({ cx: -3, cy: 4 }, 0)).toEqual(chunkRect({ cx: -3, cy: 4 }));
  });

  it("reaches into all eight neighbours so their wide geometry is seen", () => {
    expect(ids(chunksCovering(chunkQueryRect({ cx: 0, cy: 0 }, 5)))).toEqual([
      "-1,-1",
      "-1,0",
      "-1,1",
      "0,-1",
      "0,0",
      "0,1",
      "1,-1",
      "1,0",
      "1,1"
    ]);
  });

  it("honours a non-default chunk size", () => {
    expect(chunkQueryRect({ cx: 2, cy: -1 }, 1, 10)).toEqual({ x: 19, y: -11, width: 12, height: 12 });
  });
});

describe("rectsIntersect", () => {
  it("detects overlap in either argument order", () => {
    const a = rect(0, 0, 100, 100);
    const b = rect(50, 50, 100, 100);
    expect(rectsIntersect(a, b)).toBe(true);
    expect(rectsIntersect(b, a)).toBe(true);
  });

  it("treats edge-touching rects as intersecting", () => {
    expect(rectsIntersect(rect(0, 0, 100, 100), rect(100, 0, 100, 100))).toBe(true);
    expect(rectsIntersect(rect(0, 0, 100, 100), rect(100, 100, 100, 100))).toBe(true);
  });

  it("rejects rects with a gap between them", () => {
    expect(rectsIntersect(rect(0, 0, 100, 100), rect(100.5, 0, 100, 100))).toBe(false);
    expect(rectsIntersect(rect(0, 0, 100, 100), rect(0, -200, 100, 100))).toBe(false);
  });

  it("finds a fully contained rect", () => {
    expect(rectsIntersect(rect(-50, -50, 200, 200), rect(0, 0, 10, 10))).toBe(true);
  });

  it("finds a zero-size rect sitting on an edge", () => {
    expect(rectsIntersect(rect(0, 0, 100, 100), rect(100, 50, 0, 0))).toBe(true);
  });
});

describe("unionRect", () => {
  it("contains both inputs", () => {
    expect(unionRect(rect(0, 0, 10, 10), rect(90, 40, 10, 10))).toEqual(rect(0, 0, 100, 50));
  });

  it("returns the outer rect when one contains the other", () => {
    const outer = rect(-20, -20, 100, 100);
    expect(unionRect(outer, rect(0, 0, 10, 10))).toEqual(outer);
    expect(unionRect(rect(0, 0, 10, 10), outer)).toEqual(outer);
  });

  it("spans rects on opposite sides of the origin", () => {
    expect(unionRect(rect(-100, -100, 50, 50), rect(100, 100, 50, 50))).toEqual(
      rect(-100, -100, 250, 250)
    );
  });

  it("keeps a zero-size rect as a point", () => {
    expect(unionRect(rect(5, 5, 0, 0), rect(5, 5, 0, 0))).toEqual(rect(5, 5, 0, 0));
  });
});
