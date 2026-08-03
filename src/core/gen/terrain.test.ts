import { describe, expect, it } from "vitest";
import { rectRing, ringArea, type Rect, type Ring } from "../geom/types.js";
import {
  coastalLand,
  deriveLabelledSeed,
  generationMask,
  normalizeCitySeed,
  normalizeRing,
  rectangleLand,
  validateRing,
  validateTerrain,
  type CityStateV2,
  type TerrainSource
} from "./terrain.js";

const BOUNDS: Rect = { x: -100, y: -80, width: 200, height: 160 };

describe("terrain seed and envelope", () => {
  it("normalizes copyable seed text and rejects empty values", () => {
    expect(normalizeCitySeed("  neon-city  ")).toBe("neon-city");
    expect(() => normalizeCitySeed("  ")).toThrow();
  });

  it("derives independent deterministic labelled streams", () => {
    expect(deriveLabelledSeed("city", "terrain")).toBe(3143348727);
    expect(deriveLabelledSeed("city", "roads")).toBe(1922403397);
    expect(deriveLabelledSeed(" city ", "terrain")).toBe(deriveLabelledSeed("city", "terrain"));
  });

  it("has only the minimum phase-one source envelope", () => {
    const state: CityStateV2 = {
      kind: "city-generator-2",
      schemaVersion: 1,
      generatorVersion: 8,
      revision: 1,
      source: {
        origin: { x: 100, y: 200 },
        citySeed: "city",
        generation: { terrainMode: "rectangle", coastEdge: null },
        terrain: { land: rectangleLand(BOUNDS), urbanFootprint: null }
      }
    };
    expect(Object.keys(state)).toEqual(["kind", "schemaVersion", "generatorVersion", "revision", "source"]);
    expect(Object.keys(state.source)).toEqual(["origin", "citySeed", "generation", "terrain"]);
  });
});

describe("terrain boundaries", () => {
  it("creates a rectangle without a repeated closure", () => {
    const land = rectangleLand(BOUNDS);
    expect(land).toHaveLength(4);
    expect(land[0]).not.toEqual(land[land.length - 1]);
    expect(validateRing(land)).toEqual({ ok: true });
  });

  it("accepts winding and closure normalization without moving vertices", () => {
    const clockwiseClosed: Ring = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 0 }
    ];
    expect(validateRing(clockwiseClosed)).toEqual({ ok: true });
    const normalized = normalizeRing(clockwiseClosed);
    expect(normalized).toHaveLength(4);
    expect(Math.abs(ringArea(normalized))).toBe(100);
    expect(new Set(normalized.map((p) => `${p.x},${p.y}`))).toEqual(
      new Set(clockwiseClosed.slice(0, -1).map((p) => `${p.x},${p.y}`))
    );
  });

  it("rejects malformed, repeated, self-crossing, and near-zero rings", () => {
    expect(validateRing([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toMatchObject({ ok: false });
    expect(validateRing(rectRing({ x: 0, y: 0, width: 1, height: 1 }).map((p) => ({ ...p, x: 0 })))).toMatchObject({ ok: false });
    expect(
      validateRing([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 10, y: 0 }
      ])
    ).toMatchObject({ ok: false });
    expect(
      validateRing([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 }
      ])
    ).toMatchObject({ ok: false });
    expect(
      validateRing([
        { x: 0, y: 0 },
        { x: Number.NaN, y: 10 },
        { x: 10, y: 0 }
      ])
    ).toMatchObject({ ok: false });
    expect(
      validateRing([
        { x: 0, y: 0 },
        { x: 0.000001, y: 0 },
        { x: 0.000001, y: 0.000001 }
      ])
    ).toMatchObject({ ok: false });
  });

  it("makes each coast deterministic, valid, and attached to the selected edge", () => {
    for (const edge of ["north", "east", "south", "west"] as const) {
      const land = coastalLand(BOUNDS, "fixed-seed", edge);
      expect(validateRing(land)).toEqual({ ok: true });
      expect(coastalLand(BOUNDS, "fixed-seed", edge)).toEqual(land);
      expect(coastalLand(BOUNDS, "other-seed", edge)).not.toEqual(land);
      const top = { x: 0, y: BOUNDS.y + 1 };
      const right = { x: BOUNDS.x + BOUNDS.width - 1, y: 0 };
      const bottom = { x: 0, y: BOUNDS.y + BOUNDS.height - 1 };
      const left = { x: BOUNDS.x + 1, y: 0 };
      const topSea = { x: 0, y: BOUNDS.y - 1 };
      const rightSea = { x: BOUNDS.x + BOUNDS.width + 1, y: 0 };
      const bottomSea = { x: 0, y: BOUNDS.y + BOUNDS.height + 1 };
      const leftSea = { x: BOUNDS.x - 1, y: 0 };
      const inside = edge === "north" ? bottom : edge === "east" ? left : edge === "south" ? top : right;
      const sea = edge === "north" ? topSea : edge === "east" ? rightSea : edge === "south" ? bottomSea : leftSea;
      const contains = (p: { x: number; y: number }): boolean => {
        let insideFlag = false;
        for (let i = 0; i < land.length; i++) {
          const a = land[i]!;
          const b = land[(i + 1) % land.length]!;
          if ((a.y > p.y) !== (b.y > p.y)) {
            const atX = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
            if (p.x < atX) insideFlag = !insideFlag;
          }
        }
        return insideFlag;
      };
      expect(contains(inside)).toBe(true);
      expect(contains(sea)).toBe(false);
    }
  });
});

describe("terrain source validation", () => {
  const land = rectangleLand({ x: 0, y: 0, width: 100, height: 100 });

  it("allows urban footprint contact with the land boundary", () => {
    const terrain: TerrainSource = {
      land,
      urbanFootprint: rectRing({ x: 0, y: 20, width: 40, height: 40 })
    };
    expect(validateTerrain(terrain)).toEqual({ ok: true });
    expect(generationMask(terrain)).toBe(terrain.urbanFootprint);
  });

  it("allows footprint edges to touch a concave land vertex without crossing outside", () => {
    expect(
      validateTerrain({
        land: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 50, y: 100 },
          { x: 50, y: 50 },
          { x: 0, y: 50 }
        ],
        urbanFootprint: [
          { x: 40, y: 40 },
          { x: 60, y: 60 },
          { x: 65, y: 55 },
          { x: 45, y: 35 }
        ]
      })
    ).toEqual({ ok: true });
  });

  it("rejects urban footprint outside or crossing the land boundary", () => {
    expect(
      validateTerrain({ land, urbanFootprint: rectRing({ x: 90, y: 20, width: 20, height: 20 }) })
    ).toMatchObject({ ok: false });
    expect(
      validateTerrain({
        land: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 30 },
          { x: 30, y: 30 },
          { x: 30, y: 100 },
          { x: 0, y: 100 }
        ],
        urbanFootprint: rectRing({ x: 10, y: 20, width: 80, height: 20 })
      })
    ).toMatchObject({ ok: false });
  });

  it("rejects a land replacement that strands the existing footprint", () => {
    const terrain: TerrainSource = {
      land: rectRing({ x: 0, y: 0, width: 100, height: 100 }),
      urbanFootprint: rectRing({ x: 60, y: 20, width: 30, height: 30 })
    };
    expect(validateTerrain(terrain)).toEqual({ ok: true });
    expect(
      validateTerrain({ ...terrain, land: rectRing({ x: 0, y: 0, width: 70, height: 100 }) })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/footprint/i) });
  });
});
