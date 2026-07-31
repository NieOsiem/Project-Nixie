import { describe, expect, it } from "vitest";
import { describeBuildingMassing, type BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, ringBounds } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, FIRST_ZONE_BANK, materialIndex } from "../palette.js";
import { hash2 } from "./hash.js";
import {
  BANNER_MIN_BUILDING_M,
  BILLBOARD_MAX_W_M,
  BILLBOARD_MIN_W_M,
  GLOW_MARGIN_M,
  POOL_RADIUS_M,
  POOL_RATE,
  SIGN_BAND_TOP_M,
  neonMesh
} from "./neon.js";

const PPM = 25;

/** Lot sizes, heights and banks in the ranges DEFAULT_ZONE_PARAMS actually produces. */
function cityOf(count: number): BuildingSpec[] {
  const specs: BuildingSpec[] = [];
  for (let i = 0; i < count; i++) {
    const t = hash2(i, 1, 7);
    const sizeM = 8 + hash2(i, 2, 7) * 14;
    const bank = FIRST_ZONE_BANK + (i % 4);
    specs.push({
      footprint: rectRing({
        x: (i % 40) * 26 * PPM,
        y: Math.floor(i / 40) * 26 * PPM,
        width: sizeM * PPM,
        height: sizeM * 0.8 * PPM
      }),
      height: 8 + t * t * 132,
      roofMaterial: materialIndex(bank, DISTRICT_SLOT.ROOF_A),
      wallMaterial: materialIndex(bank, DISTRICT_SLOT.WALL_A + (i % 3)),
      seed: hash2(i, 3, 7)
    });
  }
  return specs;
}

const detailedTower = (seed: number): BuildingSpec => ({
  footprint: rectRing({ x: 0, y: 0, width: 30 * PPM, height: 24 * PPM }),
  height: 80,
  roofMaterial: materialIndex(FIRST_ZONE_BANK, DISTRICT_SLOT.ROOF_A),
  wallMaterial: materialIndex(FIRST_ZONE_BANK, DISTRICT_SLOT.WALL_A),
  seed,
  detailedMassing: true
});

const vertexAt = (m: MeshBuffers, i: number) => {
  const at = i * VERTEX_FLOATS;
  return {
    x: m.vertices[at]!,
    y: m.vertices[at + 1]!,
    height: m.vertices[at + 2]!,
    material: m.vertices[at + 3]!,
    radial: m.vertices[at + 4]!,
    kind: m.vertices[at + 5]!,
    u: m.vertices[at + 6]!,
    top: m.vertices[at + 7]!,
    strength: m.vertices[at + 8]!,
    halfWidthM: m.vertices[at + 9]!,
    halfHeightM: m.vertices[at + 10]!
  };
};

/** Every quad as (first corner, opposite corner) pairs, in emission order. */
function quadsOf(m: MeshBuffers) {
  const out = [];
  for (let q = 0; q < m.vertexCount; q += 4) {
    const corners = [0, 1, 2, 3].map((k) => vertexAt(m, q + k));
    out.push({
      ...corners[0]!,
      widthPx: Math.hypot(corners[1]!.x - corners[0]!.x, corners[1]!.y - corners[0]!.y),
      bottomM: Math.min(...corners.map((c) => c.height)),
      topM: Math.max(...corners.map((c) => c.height))
    });
  }
  return out;
}

describe("neonMesh", () => {
  it("is byte-identical across runs", () => {
    const specs = cityOf(400);
    const a = neonMesh(specs, PPM);
    const b = neonMesh(specs, PPM);
    expect([...a.vertices]).toEqual([...b.vertices]);
    expect([...a.indices]).toEqual([...b.indices]);
  });

  it("reorders output without changing any building's sign", () => {
    const specs = cityOf(200);
    const perBuilding = specs.map((s) => neonMesh([s], PPM));
    const reversed = neonMesh([...specs].reverse(), PPM);

    const expected: number[] = [];
    for (let i = specs.length - 1; i >= 0; i--) expected.push(...perBuilding[i]!.vertices);
    expect([...reversed.vertices]).toEqual(expected);
  });

  it("returns an empty mesh for a chunk that owns no buildings", () => {
    const m = neonMesh([], PPM);
    expect(m.vertexCount).toBe(0);
    expect(m.triangleCount).toBe(0);
    expect(m.vertices.length).toBe(0);
    expect(m.indices.length).toBe(0);
  });

  it("returns exclusively-owned exact-sized buffers, so the worker can transfer them", () => {
    for (const m of [neonMesh(cityOf(300), PPM), neonMesh([], PPM)]) {
      for (const view of [m.vertices, m.indices]) {
        expect(view.byteOffset).toBe(0);
        expect(view.buffer.byteLength).toBe(view.byteLength);
      }
      expect(m.vertices.buffer).not.toBe(m.indices.buffer);
    }
  });

  it("emits exactly 4 vertices and 2 triangles per sign", () => {
    const m = neonMesh(cityOf(300), PPM);
    expect(m.vertexCount % 4).toBe(0);
    expect(m.triangleCount).toBe((m.vertexCount / 4) * 2);
    expect(m.indices.length).toBe(m.triangleCount * 3);
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
  });

  it("tags every vertex NEON with in-range local coords and a positive strength", () => {
    const m = neonMesh(cityOf(300), PPM);
    expect(m.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vertexAt(m, i);
      expect(v.kind).toBe(KIND.NEON);
      expect([0, 1]).toContain(v.radial);
      expect(Math.abs(v.u)).toBeLessThanOrEqual(1);
      expect(Math.abs(v.top)).toBeLessThanOrEqual(1);
      expect(v.strength).toBeGreaterThan(0);
      expect(v.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("pairs low facade signs with reduced radial pools", () => {
    expect(POOL_RATE).toBe(1);
    const m = neonMesh(cityOf(300), PPM);
    let pools = 0;
    for (let q = 0; q < m.vertexCount; q += 4) {
      const pool = vertexAt(m, q);
      if (pool.radial !== 1) continue;
      pools++;
      const sign = vertexAt(m, q - 4);
      expect(sign.radial).toBe(0);
      expect(pool.material).toBe(sign.material);
      expect(pool.strength).toBeLessThan(sign.strength);
      for (let i = 0; i < 4; i++) expect(vertexAt(m, q + i).height).toBeCloseTo(0.03, 6);
      expect(vertexAt(m, q + 1).x - pool.x).toBeCloseTo(POOL_RADIUS_M * PPM * 2, 2);
      expect(vertexAt(m, q + 3).y - pool.y).toBeCloseTo(POOL_RADIUS_M * PPM * 2, 2);
    }
    expect(pools).toBeGreaterThan(0);
  });

  it("spans the padded quad in local coords", () => {
    const m = neonMesh(cityOf(60), PPM);
    for (let q = 0; q < m.vertexCount; q += 4) {
      const us = [0, 1, 2, 3].map((k) => vertexAt(m, q + k).u);
      const vs = [0, 1, 2, 3].map((k) => vertexAt(m, q + k).top);
      expect(us).toEqual([-1, 1, 1, -1]);
      expect(vs).toEqual([-1, -1, 1, 1]);
    }
  });

  it("keeps every quad inside its own building's footprint plus the glow margin", () => {
    const slack = POOL_RADIUS_M * PPM;
    const epsilon = 1e-3;
    for (const spec of cityOf(250)) {
      const m = neonMesh([spec], PPM);
      const b = ringBounds(spec.footprint);
      for (let i = 0; i < m.vertexCount; i++) {
        const v = vertexAt(m, i);
        expect(v.x).toBeGreaterThanOrEqual(b.x - slack - epsilon);
        expect(v.x).toBeLessThanOrEqual(b.x + b.width + slack + epsilon);
        expect(v.y).toBeGreaterThanOrEqual(b.y - slack - epsilon);
        expect(v.y).toBeLessThanOrEqual(b.y + b.height + slack + epsilon);
      }
    }
  });

  it("adds rare large facade billboards without crossing the roofline", () => {
    let billboards = 0;
    for (const spec of cityOf(1400)) {
      const mesh = neonMesh([spec], PPM);
      for (let q = 0; q < mesh.vertexCount; q += 4) {
        const a = vertexAt(mesh, q);
        const b = vertexAt(mesh, q + 1);
        const top = vertexAt(mesh, q + 2);
        if (a.radial !== 0 || top.height <= a.height) continue;
        expect(top.height).toBeLessThanOrEqual(spec.height + 1e-5);
        const paddedWidthM = Math.hypot(b.x - a.x, b.y - a.y) / PPM;
        if (paddedWidthM < BILLBOARD_MIN_W_M + 2 * GLOW_MARGIN_M - 1e-5) continue;
        billboards++;
        expect(paddedWidthM).toBeLessThanOrEqual(BILLBOARD_MAX_W_M + 2 * GLOW_MARGIN_M);
        expect(spec.height).toBeGreaterThanOrEqual(25);
      }
    }
    expect(billboards).toBeGreaterThan(5);
    expect(billboards).toBeLessThan(80);
  });

  it("resolves to a neon slot of the building's own bank", () => {
    for (const spec of cityOf(250)) {
      const m = neonMesh([spec], PPM);
      const wallBank = Math.floor(spec.wallMaterial / BANK_SIZE);
      for (let i = 0; i < m.vertexCount; i++) {
        const material = vertexAt(m, i).material;
        expect(Math.floor(material / BANK_SIZE)).toBe(wallBank);
        expect([DISTRICT_SLOT.NEON_A, DISTRICT_SLOT.NEON_B]).toContain(material % BANK_SIZE);
      }
    }
  });

  it("signs 70-80% of a realistic city", () => {
    const specs = cityOf(1400);
    const signed = specs.filter((s) => neonMesh([s], PPM).vertexCount > 0).length;
    const rate = signed / specs.length;
    expect(rate).toBeGreaterThan(0.7);
    expect(rate).toBeLessThan(0.8);
  });

  it("keeps total additive fill inside its overdraw budget", () => {
    // Panel *count* is the wrong proxy: measured on this fixture, panels are under 3% of
    // neon fill and the pools are the whole cost. Glow area is what the GPU pays.
    const specs = cityOf(1400);
    const ground = specs.reduce(
      (r, s) => {
        const b = ringBounds(s.footprint);
        return {
          x0: Math.min(r.x0, b.x),
          y0: Math.min(r.y0, b.y),
          x1: Math.max(r.x1, b.x + b.width),
          y1: Math.max(r.y1, b.y + b.height)
        };
      },
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    );
    const groundM2 = ((ground.x1 - ground.x0) / PPM) * ((ground.y1 - ground.y0) / PPM);

    let glowM2 = 0;
    for (const q of quadsOf(neonMesh(specs, PPM))) {
      // A pool's quad is its radius, not its half-extent plus a margin.
      glowM2 +=
        q.radial === 1
          ? (2 * POOL_RADIUS_M) ** 2
          : 2 * (q.halfWidthM + GLOW_MARGIN_M) * 2 * (q.halfHeightM + GLOW_MARGIN_M);
    }
    expect(glowM2 / groundM2).toBeLessThan(4.5);
  });

  it("carries each panel's own half-extents, which is what keeps a bar from going round", () => {
    const m = neonMesh(cityOf(400), PPM);
    let panels = 0;
    for (const q of quadsOf(m)) {
      if (q.radial !== 0) continue;
      panels++;
      expect(q.halfWidthM).toBeGreaterThan(0);
      expect(q.halfHeightM).toBeGreaterThan(0);
      // The padded quad is exactly the panel plus one glow margin on every side.
      expect(q.widthPx / PPM / 2).toBeCloseTo(q.halfWidthM + GLOW_MARGIN_M, 2);
      expect((q.topM - q.bottomM) / 2).toBeCloseTo(q.halfHeightM + GLOW_MARGIN_M, 5);
    }
    expect(panels).toBeGreaterThan(0);
  });

  it("keeps horizontal panels in the bottom band and pools every one of them", () => {
    const quads = quadsOf(neonMesh(cityOf(600), PPM));
    let horizontals = 0;
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i]!;
      if (q.radial !== 0 || q.halfHeightM > q.halfWidthM) continue;
      horizontals++;
      expect((q.topM + q.bottomM) / 2).toBeLessThanOrEqual(SIGN_BAND_TOP_M + 1e-5);
      expect(quads[i + 1]?.radial).toBe(1);
    }
    expect(horizontals).toBeGreaterThan(50);
  });

  it("hangs vertical banners on tall buildings, the one thing exempt from the band", () => {
    let banners = 0;
    let aboveBand = 0;
    for (const spec of cityOf(1400)) {
      for (const q of quadsOf(neonMesh([spec], PPM))) {
        if (q.radial !== 0 || q.halfHeightM <= q.halfWidthM) continue;
        banners++;
        expect(spec.height).toBeGreaterThanOrEqual(BANNER_MIN_BUILDING_M);
        expect(q.halfHeightM * 2).toBeGreaterThanOrEqual(6);
        expect(q.topM).toBeLessThanOrEqual(spec.height + 1e-5);
        expect(q.bottomM).toBeGreaterThanOrEqual(-1e-5);
        if ((q.topM + q.bottomM) / 2 > SIGN_BAND_TOP_M) aboveBand++;
      }
    }
    expect(banners).toBeGreaterThan(50);
    expect(aboveBand).toBeGreaterThan(banners / 2);
  });

  it("gives taller buildings bigger panels", () => {
    const short: number[] = [];
    const tall: number[] = [];
    for (const spec of cityOf(1400)) {
      for (const q of quadsOf(neonMesh([spec], PPM))) {
        // Plain signs only: billboards and banners have their own size ranges.
        if (q.radial !== 0 || q.halfHeightM > q.halfWidthM) continue;
        if (q.halfWidthM * 2 >= BILLBOARD_MIN_W_M) continue;
        (spec.height >= 60 ? tall : spec.height < 15 ? short : []).push(q.halfHeightM * 2);
      }
    }
    expect(short.length).toBeGreaterThan(20);
    expect(tall.length).toBeGreaterThan(20);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(tall)).toBeGreaterThan(mean(short) * 1.2);
  });

  it("keeps facade signs below the outer tier of detailed towers", () => {
    let facades = 0;
    for (let i = 0; i < 300; i++) {
      const spec = detailedTower(hash2(i, 71, 13));
      const outerTop = describeBuildingMassing(spec, PPM).volumes[0]!.topHeight;
      const mesh = neonMesh([spec], PPM);
      for (let q = 0; q < mesh.vertexCount; q += 4) {
        if (vertexAt(mesh, q).radial !== 0) continue;
        const heights = [0, 1, 2, 3].map((corner) => vertexAt(mesh, q + corner).height);
        if (Math.max(...heights) - Math.min(...heights) < 1e-5) continue;
        facades++;
        expect(Math.max(...heights)).toBeLessThanOrEqual(outerTop + 1e-5);
      }
    }
    expect(facades).toBeGreaterThan(20);
  });

});
