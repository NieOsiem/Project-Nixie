import { describe, expect, it } from "vitest";
import { describeBuildingMassing, type BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, ringBounds, ringCentroid } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, FIRST_ZONE_BANK, materialIndex } from "../palette.js";
import { hash2 } from "./hash.js";
import {
  BEACON_CORE_MAX_M,
  BILLBOARD_MAX_W_M,
  BILLBOARD_MIN_W_M,
  GLOW_MARGIN_M,
  POOL_RADIUS_M,
  POOL_RATE,
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
    strength: m.vertices[at + 8]!
  };
};

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
      expect(vertexAt(m, q + 1).x - pool.x).toBeCloseTo(POOL_RADIUS_M * PPM * 2, 3);
      expect(vertexAt(m, q + 3).y - pool.y).toBeCloseTo(POOL_RADIUS_M * PPM * 2, 3);
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
    const slack = Math.max(GLOW_MARGIN_M + BEACON_CORE_MAX_M, POOL_RADIUS_M) * PPM;
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

  it("signs 35-55% of a realistic city", () => {
    // Raised from the original 30-40% band: the 780M runs the city at vsync with headroom
    // to spare, and the reference art is far denser with signage than one-in-three.
    const specs = cityOf(1400);
    const signed = specs.filter((s) => neonMesh([s], PPM).vertexCount > 0).length;
    const rate = signed / specs.length;
    expect(rate).toBeGreaterThan(0.35);
    expect(rate).toBeLessThan(0.55);
  });

  it("stays inside the 800-visible-sign budget for a 1400-building city", () => {
    const m = neonMesh(cityOf(1400), PPM);
    let signs = 0;
    for (let q = 0; q < m.vertexCount; q += 4) {
      if (vertexAt(m, q).radial === 0) signs++;
    }
    expect(signs).toBeLessThan(800);
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

  it("centres rooftop strips on the actual offset top footprint", () => {
    let checked = false;
    for (let i = 0; i < 500 && !checked; i++) {
      const spec = detailedTower(hash2(i, 81, 17));
      const massing = describeBuildingMassing(spec, PPM);
      const outerCentre = ringCentroid(massing.volumes[0]!.footprint);
      const top = massing.volumes[massing.volumes.length - 1]!;
      const topCentre = ringCentroid(top.footprint);
      if (Math.hypot(topCentre.x - outerCentre.x, topCentre.y - outerCentre.y) < 0.01) continue;

      const mesh = neonMesh([spec], PPM);
      for (let q = 0; q < mesh.vertexCount; q += 4) {
        const vertices = [0, 1, 2, 3].map((corner) => vertexAt(mesh, q + corner));
        if (vertices[0]!.radial !== 0) continue;
        if (!vertices.every((vertex) => Math.abs(vertex.height - top.topHeight) < 1e-5)) continue;
        const cx = vertices.reduce((sum, vertex) => sum + vertex.x, 0) / vertices.length;
        const cy = vertices.reduce((sum, vertex) => sum + vertex.y, 0) / vertices.length;
        expect(cx).toBeCloseTo(topCentre.x, 4);
        expect(cy).toBeCloseTo(topCentre.y, 4);
        checked = true;
        break;
      }
    }
    expect(checked).toBe(true);
  });
});
