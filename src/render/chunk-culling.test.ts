import { describe, expect, it } from "vitest";
import { emptyMesh } from "../core/geom/mesh.js";
import { rectsIntersect, type Rect } from "../core/geom/types.js";
import {
  UNCULLED_BOUNDS,
  WHOLE_CITY_CHUNK_ID,
  visibleChunkIds,
  type ChunkGeometry
} from "./chunk-culling.js";

const VIEW: Rect = { x: 0, y: 0, width: 1000, height: 800 };

const chunk = (id: string, boundsPx: Rect): ChunkGeometry => ({
  id,
  mesh: emptyMesh(),
  boundsPx
});

describe("visibleChunkIds", () => {
  it("returns nothing for an empty set", () => {
    expect(visibleChunkIds([], VIEW)).toEqual([]);
  });

  it("keeps a chunk fully inside the view", () => {
    expect(visibleChunkIds([chunk("in", { x: 100, y: 100, width: 200, height: 200 })], VIEW)).toEqual(
      ["in"]
    );
  });

  it("drops chunks fully outside the view on every side", () => {
    const outside = [
      chunk("right", { x: 1200, y: 100, width: 100, height: 100 }),
      chunk("left", { x: -400, y: 100, width: 100, height: 100 }),
      chunk("below", { x: 100, y: 900, width: 100, height: 100 }),
      chunk("above", { x: 100, y: -400, width: 100, height: 100 })
    ];
    expect(visibleChunkIds(outside, VIEW)).toEqual([]);
  });

  it("keeps a chunk straddling an edge", () => {
    const straddle = chunk("straddle", { x: -50, y: 700, width: 200, height: 200 });
    expect(visibleChunkIds([straddle], VIEW)).toEqual(["straddle"]);
  });

  it("keeps a chunk that only touches an edge", () => {
    const touching = chunk("touch", { x: 1000, y: 100, width: 100, height: 100 });
    expect(visibleChunkIds([touching], VIEW)).toEqual(["touch"]);
  });

  it("keeps a chunk whose nominal rect is outside but whose overhang bounds reach in", () => {
    const nominal: Rect = { x: 1024, y: 100, width: 128, height: 128 };
    const withOverhang: Rect = { ...nominal, x: nominal.x - 60, width: nominal.width + 60 };

    expect(rectsIntersect(nominal, VIEW)).toBe(false);
    expect(visibleChunkIds([chunk("overhang", withOverhang)], VIEW)).toEqual(["overhang"]);
  });

  it("preserves iteration order and filters in place", () => {
    const chunks = [
      chunk("a", { x: 0, y: 0, width: 10, height: 10 }),
      chunk("far", { x: 5000, y: 5000, width: 10, height: 10 }),
      chunk("b", { x: 500, y: 500, width: 10, height: 10 })
    ];
    expect(visibleChunkIds(chunks, VIEW)).toEqual(["a", "b"]);
  });

  it("never culls the reserved whole-city chunk, however far the view roams", () => {
    const whole = chunk(WHOLE_CITY_CHUNK_ID, UNCULLED_BOUNDS);
    const distant: Rect = { x: 9e8, y: -9e8, width: 4000, height: 2000 };

    expect(visibleChunkIds([whole], VIEW)).toEqual([WHOLE_CITY_CHUNK_ID]);
    expect(visibleChunkIds([whole], distant)).toEqual([WHOLE_CITY_CHUNK_ID]);
  });
});
