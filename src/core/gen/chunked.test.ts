import { describe, expect, it } from "vitest";
import { intersection } from "../geom/boolean.js";
import type { BuildingSpec } from "../geom/extrude.js";
import { VERTEX_FLOATS } from "../geom/mesh.js";
import { ringArea, ringCentroid, type MultiPolygon, type Rect } from "../geom/types.js";
import { FIRST_ZONE_BANK } from "../palette.js";
import { buildingsForBlocks } from "./blocks.js";
import { chunkRect } from "./chunks.js";
import { buildChunk, chunkMarginM, cityChunks } from "./chunked.js";
import { MARKING_REACH_M } from "./markings.js";
import {
  buildCity,
  cityBounds,
  cityToPixels,
  demoCity,
  pixelsToMetres,
  rectToPixels,
  ROAD_CLASSES,
  type CityParams
} from "./demo-city.js";
import { buildRoadSurfaces } from "./roads.js";
import { DEFAULT_ZONE_PARAMS, lotRegions } from "./zones.js";

const ORIGIN = { x: 5000, y: 4000 };
const PPM = 25;
const MARGIN_M = 20;

const CITY = demoCity(ORIGIN);
const CITY_BOUNDS_M = cityBounds(CITY, MARGIN_M)!;
const KEYS = cityChunks(CITY_BOUNDS_M);
const CHUNKS = KEYS.map((k) => buildChunk(CITY, k, CITY_BOUNDS_M, PPM));

/**
 * The demo city is smaller than one chunk on both axes, so every chunk rect pokes outside
 * it and overhang can never show. Spreading the same graph over several chunks puts real
 * chunk boundaries in the city interior, where lots straddle them.
 */
function wideCity(factor: number): CityParams {
  const graph = CITY.graph;
  return {
    ...CITY,
    graph: { ...graph, nodes: graph.nodes.map((n) => ({ ...n, x: n.x * factor, y: n.y * factor })) }
  };
}

/** The whole-city path with the specs left visible — `buildCity` only reports a count. */
function wholeCitySpecs(params: CityParams, boundsM: Rect, ppm: number): BuildingSpec[] {
  const px = cityToPixels(params, ppm);
  const bounds = rectToPixels(boundsM, params.origin, ppm);
  const surfaces = buildRoadSurfaces(px.graph, bounds, ppm);
  return buildingsForBlocks(
    surfaces.blocks,
    lotRegions(params.base, px.zones, bounds, ppm, params.origin),
    { originPx: params.origin, pixelsPerMetre: ppm }
  );
}

/**
 * Points are sorted because chunk and city rings can start at different vertices.
 *
 * WHY: quantised, because a chunk unions a subset of the road quads and polygon-clipping
 * then recomputes oblique intersection points from a different input set, landing ~2.5e-4 px
 * away. `worstDeviation` is what actually bounds the error; the bucket is only wide enough
 * that noise cannot straddle it.
 */
const specKey = (s: BuildingSpec): string =>
  [
    ...s.footprint.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort(),
    s.height.toFixed(9),
    s.wallMaterial,
    s.roofMaterial
  ].join("|");

/** Every footprint coordinate on one axis, sorted, so two builds can be compared pairwise. */
const coords = (specs: BuildingSpec[], axis: "x" | "y"): number[] =>
  specs.flatMap((s) => s.footprint.map((p) => p[axis])).sort((a, b) => a - b);

function worstDeviation(a: BuildingSpec[], b: BuildingSpec[]): number {
  let worst = 0;
  for (const axis of ["x", "y"] as const) {
    const left = coords(a, axis);
    const right = coords(b, axis);
    if (left.length !== right.length) return Infinity;
    for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(left[i]! - right[i]!));
  }
  return worst;
}

const multiArea = (mp: MultiPolygon): number =>
  mp.reduce(
    (sum, poly) =>
      sum +
      poly.reduce(
        (s, ring, i) => s + (i === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring))),
        0
      ),
    0
  );

const WIDEST_PAVED_M = Math.max(...ROAD_CLASSES.map((c) => c.widthM / 2 + c.sidewalkM));

describe("chunkMarginM", () => {
  it("takes the road term when it beats every lot size", () => {
    expect(chunkMarginM(CITY)).toBe(WIDEST_PAVED_M + MARKING_REACH_M);
  });

  /**
   * WHY this bound and not the bare paved half-width: markings key off node degree and
   * junction radius, both of which a clipped subgraph understates for a node outside the
   * query rect. Reaching this far puts every node that can place a marking in this chunk
   * inside the query rect, where all its incident edges survive and its degree is honest.
   * Shrink the margin to the paved half-width and crossings flicker at chunk seams.
   */
  it("reaches far enough for a junction's markings to be generated against a full degree", () => {
    for (const c of ROAD_CLASSES) {
      expect(chunkMarginM(CITY)).toBeGreaterThanOrEqual(c.widthM / 2 + c.sidewalkM + MARKING_REACH_M);
    }
  });

  it("takes a lot size when it beats the road term", () => {
    const big = WIDEST_PAVED_M + MARKING_REACH_M + 10;
    expect(chunkMarginM({ ...CITY, base: { ...CITY.base, lotSizeM: big } })).toBe(big);
  });

  it("takes a zone's lot size when it beats the base", () => {
    const zoned: CityParams = {
      ...CITY,
      zones: [
        {
          ...DEFAULT_ZONE_PARAMS,
          id: "z1",
          bank: FIRST_ZONE_BANK,
          lotSizeM: 90,
          rect: { x: 0, y: 0, width: 50, height: 50 }
        }
      ]
    };
    expect(chunkMarginM(zoned)).toBe(90);
  });
});

// If this fails, chunking is generating a different city and everything downstream of it
// is worthless. Do not weaken it.
describe("partition equivalence", () => {
  const whole = wholeCitySpecs(CITY, CITY_BOUNDS_M, PPM);
  const fromChunks = CHUNKS.flatMap((c) => c.buildings);

  it("has an oracle that matches buildCity", () => {
    expect(whole).toHaveLength(buildCity(CITY, CITY_BOUNDS_M, PPM).buildingCount);
    expect(whole.length).toBeGreaterThan(20);
  });

  it("produces the same number of buildings", () => {
    expect(CHUNKS.reduce((n, c) => n + c.buildingCount, 0)).toBe(whole.length);
    expect(fromChunks).toHaveLength(whole.length);
  });

  it("reproduces the same set of footprints, heights and materials", () => {
    expect(fromChunks.map(specKey).sort()).toEqual(whole.map(specKey).sort());
  });

  it("places every vertex bit-identically", () => {
    expect(worstDeviation(fromChunks, whole)).toBe(0);
  });

  it("covers more than one chunk", () => {
    expect(CHUNKS.filter((c) => c.buildingCount > 0).length).toBeGreaterThan(1);
  });
});

describe("single ownership", () => {
  it("never places one building in two chunks", () => {
    const owner = new Map<string, string>();
    for (const chunk of CHUNKS) {
      for (const spec of chunk.buildings) {
        const k = specKey(spec);
        expect(owner.get(k)).toBeUndefined();
        owner.set(k, chunk.id);
      }
    }
    expect(owner.size).toBe(CHUNKS.reduce((n, c) => n + c.buildingCount, 0));
  });

  it("keeps only centroids inside its own chunk rect", () => {
    for (const chunk of CHUNKS) {
      const r = chunkRect(chunk.key);
      for (const spec of chunk.buildings) {
        const c = pixelsToMetres(ringCentroid(spec.footprint), ORIGIN, PPM);
        expect(c.x).toBeGreaterThanOrEqual(r.x);
        expect(c.x).toBeLessThan(r.x + r.width);
        expect(c.y).toBeGreaterThanOrEqual(r.y);
        expect(c.y).toBeLessThan(r.y + r.height);
      }
    }
  });
});

describe("flat surfaces tile", () => {
  it("gives two adjacent chunks no shared road area", () => {
    const a = CHUNKS.find((c) => c.id === "-1,0")!;
    const b = CHUNKS.find((c) => c.id === "0,0")!;
    expect(multiArea(a.surfaces.road)).toBeGreaterThan(0);
    expect(multiArea(b.surfaces.road)).toBeGreaterThan(0);
    expect(multiArea(intersection(a.surfaces.road, b.surfaces.road))).toBeLessThan(1);
  });

  it("sums to the whole-city surface areas", () => {
    const whole = buildCity(CITY, CITY_BOUNDS_M, PPM).surfaces;
    const tolerance = 1e-4 * multiArea(whole.blocks);
    for (const kind of ["road", "sidewalk", "blocks"] as const) {
      const summed = CHUNKS.reduce((sum, c) => sum + multiArea(c.surfaces[kind]), 0);
      expect(Math.abs(summed - multiArea(whole[kind]))).toBeLessThan(tolerance);
    }
  });
});

describe("a city spanning several chunks", () => {
  const wide = wideCity(3);
  const boundsM = cityBounds(wide, MARGIN_M)!;
  const chunks = cityChunks(boundsM).map((k) => buildChunk(wide, k, boundsM, PPM));
  const fromChunks = chunks.flatMap((c) => c.buildings);
  const whole = wholeCitySpecs(wide, boundsM, PPM);

  it("still reproduces the whole-city buildings", () => {
    expect(whole.length).toBeGreaterThan(200);
    expect(fromChunks.map(specKey).sort()).toEqual(whole.map(specKey).sort());
  });

  it("stays within a thousandth of a world pixel on every vertex", () => {
    expect(worstDeviation(fromChunks, whole)).toBeLessThan(1e-3);
  });

  it("grows at least one chunk's bounds past its rect", () => {
    const grown = chunks.filter((c) => {
      const r = chunkRect(c.key);
      return (
        c.boundsM.x < r.x ||
        c.boundsM.y < r.y ||
        c.boundsM.x + c.boundsM.width > r.x + r.width ||
        c.boundsM.y + c.boundsM.height > r.y + r.height
      );
    });
    expect(grown.length).toBeGreaterThan(0);
  });

  it("keeps the overhang inside a margin of the chunk rect", () => {
    const margin = chunkMarginM(wide);
    for (const c of chunks) {
      const r = chunkRect(c.key);
      expect(c.boundsM.x).toBeGreaterThanOrEqual(r.x - margin);
      expect(c.boundsM.y).toBeGreaterThanOrEqual(r.y - margin);
      expect(c.boundsM.x + c.boundsM.width).toBeLessThanOrEqual(r.x + r.width + margin);
      expect(c.boundsM.y + c.boundsM.height).toBeLessThanOrEqual(r.y + r.height + margin);
    }
  });
});

describe("overhang", () => {
  it("contains every kept footprint and every emitted vertex", () => {
    for (const c of CHUNKS) {
      const inside = (p: { x: number; y: number }): void => {
        expect(p.x).toBeGreaterThanOrEqual(c.boundsM.x - 1e-6);
        expect(p.x).toBeLessThanOrEqual(c.boundsM.x + c.boundsM.width + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(c.boundsM.y - 1e-6);
        expect(p.y).toBeLessThanOrEqual(c.boundsM.y + c.boundsM.height + 1e-6);
      };
      for (const spec of c.buildings) {
        for (const p of spec.footprint) inside(pixelsToMetres(p, ORIGIN, PPM));
      }
      for (let i = 0; i < c.mesh.vertexCount; i++) {
        inside(
          pixelsToMetres(
            { x: c.mesh.vertices[i * VERTEX_FLOATS]!, y: c.mesh.vertices[i * VERTEX_FLOATS + 1]! },
            ORIGIN,
            PPM
          )
        );
      }
    }
  });

  it("stays within a margin of the chunk rect", () => {
    const margin = chunkMarginM(CITY);
    for (const c of CHUNKS) {
      const r = chunkRect(c.key);
      expect(c.boundsM.x).toBeGreaterThanOrEqual(r.x - margin);
      expect(c.boundsM.y).toBeGreaterThanOrEqual(r.y - margin);
      expect(c.boundsM.x + c.boundsM.width).toBeLessThanOrEqual(r.x + r.width + margin);
      expect(c.boundsM.y + c.boundsM.height).toBeLessThanOrEqual(r.y + r.height + margin);
    }
  });
});

describe("empty chunk", () => {
  const key = { cx: 50, cy: 50 };
  const far = buildChunk(CITY, key, CITY_BOUNDS_M, PPM);

  it("returns nothing without throwing", () => {
    expect(far.buildingCount).toBe(0);
    expect(far.buildings).toEqual([]);
    expect(far.mesh.vertexCount).toBe(0);
    expect(far.mesh.triangleCount).toBe(0);
    expect(far.surfaces.road).toEqual([]);
    expect(far.surfaces.blocks).toEqual([]);
    expect(far.boundsM).toEqual(chunkRect(key));
  });
});

describe("a road passing straight through", () => {
  const params: CityParams = {
    origin: ORIGIN,
    graph: {
      nodes: [
        { id: "a", x: -600, y: -600 },
        { id: "b", x: 600, y: 600 }
      ],
      edges: [{ id: "ab", a: "a", b: "b", classId: "arterial" }],
      classes: ROAD_CLASSES.map((c) => ({ ...c }))
    },
    base: { ...DEFAULT_ZONE_PARAMS },
    zones: []
  };
  const boundsM = cityBounds(params, MARGIN_M)!;

  it("lays road inside a chunk both endpoints are far outside", () => {
    const build = buildChunk(params, { cx: 0, cy: 0 }, boundsM, PPM);
    // A 16 m carriageway across the 128 m chunk diagonal, in world pixels.
    const expected = 16 * 128 * Math.SQRT2 * PPM * PPM;
    expect(multiArea(build.surfaces.road)).toBeGreaterThan(expected * 0.8);
    expect(multiArea(build.surfaces.road)).toBeLessThan(expected * 1.2);
  });
});
