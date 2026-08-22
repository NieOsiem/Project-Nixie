import { describe, expect, it } from "vitest";
import { describeBuildingMassing, type BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, ringBounds } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, FIRST_ZONE_BANK, materialIndex } from "../palette.js";
import { hash2 } from "./hash.js";
import {
  BANNER_MIN_BUILDING_M,
  MAX_POOL_RADIUS_M,
  MIN_POOL_RADIUS_M,
  SIGN_BAND_TOP_M,
  neonMesh
} from "./neon.js";

const PPM = 25;

function cityOf(count: number, profile?: string): BuildingSpec[] {
  const specs: BuildingSpec[] = [];
  for (let i = 0; i < count; i++) {
    const t = hash2(i, 1, 7);
    const sizeM = 12 + hash2(i, 2, 7) * 16;
    const bank = FIRST_ZONE_BANK + (i % 4);
    specs.push({
      footprint: rectRing({
        x: (i % 40) * 36 * PPM,
        y: Math.floor(i / 40) * 36 * PPM,
        width: sizeM * PPM,
        height: sizeM * 0.85 * PPM
      }),
      height: 12 + t * t * 140,
      roofMaterial: materialIndex(bank, DISTRICT_SLOT.ROOF_A),
      wallMaterial: materialIndex(bank, DISTRICT_SLOT.WALL_A + (i % 3)),
      seed: hash2(i, 3, 7),
      facadeProfile: profile
    });
  }
  return specs;
}

const detailedTower = (seed: number, profile?: string): BuildingSpec => ({
  footprint: rectRing({ x: 0, y: 0, width: 32 * PPM, height: 26 * PPM }),
  height: 90,
  roofMaterial: materialIndex(FIRST_ZONE_BANK, DISTRICT_SLOT.ROOF_A),
  wallMaterial: materialIndex(FIRST_ZONE_BANK, DISTRICT_SLOT.WALL_A),
  seed,
  facadeProfile: profile,
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

function quadsOf(m: MeshBuffers) {
  const out = [];
  for (let q = 0; q < m.vertexCount; q += 4) {
    const corners = [0, 1, 2, 3].map((k) => vertexAt(m, q + k));
    out.push({
      ...corners[0]!,
      widthPx: Math.hypot(corners[1]!.x - corners[0]!.x, corners[1]!.y - corners[0]!.y),
      bottomM: Math.min(...corners.map((c) => c.height)),
      topM: Math.max(...corners.map((c) => c.height)),
      centerM: (Math.min(...corners.map((c) => c.height)) + Math.max(...corners.map((c) => c.height))) / 2
    });
  }
  return out;
}

describe("neonMesh", () => {
  it("is byte-identical across runs", () => {
    const specs = cityOf(300);
    const a = neonMesh(specs, PPM);
    const b = neonMesh(specs, PPM);
    expect([...a.vertices]).toEqual([...b.vertices]);
    expect([...a.indices]).toEqual([...b.indices]);
  });

  it("reorders output deterministically per building", () => {
    const specs = cityOf(150);
    const perBuilding = specs.map((s) => neonMesh([s], PPM));
    const reversed = neonMesh([...specs].reverse(), PPM);

    const expected: number[] = [];
    for (let i = specs.length - 1; i >= 0; i--) expected.push(...perBuilding[i]!.vertices);
    expect([...reversed.vertices]).toEqual(expected);
  });

  it("returns an empty mesh for an empty building list", () => {
    const m = neonMesh([], PPM);
    expect(m.vertexCount).toBe(0);
    expect(m.triangleCount).toBe(0);
    expect(m.vertices.length).toBe(0);
    expect(m.indices.length).toBe(0);
  });

  it("emits zero neon when neonEnabled is false", () => {
    const spec = {
      ...cityOf(1, "shopfront")[0]!,
      facadeRate: 1,
      poolRate: 1,
      neonEnabled: false
    };
    const m = neonMesh([spec], PPM);
    expect(m.vertexCount).toBe(0);
    expect(m.triangleCount).toBe(0);
  });

  it("filters neon-disabled buildings out of a mixed batch", () => {
    const disabled = { ...cityOf(2, "shopfront")[0]!, facadeRate: 1, poolRate: 1, neonEnabled: false };
    const enabled = { ...cityOf(2, "shopfront")[1]!, facadeRate: 1, poolRate: 1, neonEnabled: true };
    expect(neonMesh([disabled], PPM).vertexCount).toBe(0);
    const both = neonMesh([disabled, enabled], PPM);
    const alone = neonMesh([enabled], PPM);
    expect([...both.vertices]).toEqual([...alone.vertices]);
    expect([...both.indices]).toEqual([...alone.indices]);
  });

  it("produces transfer-safe independent ArrayBuffers", () => {
    for (const m of [neonMesh(cityOf(200), PPM), neonMesh([], PPM)]) {
      for (const view of [m.vertices, m.indices]) {
        expect(view.byteOffset).toBe(0);
        expect(view.buffer.byteLength).toBe(view.byteLength);
      }
      expect(m.vertices.buffer).not.toBe(m.indices.buffer);
    }
  });

  it("emits exactly 4 vertices and 2 triangles per quad", () => {
    const m = neonMesh(cityOf(250), PPM);
    expect(m.vertexCount % 4).toBe(0);
    expect(m.triangleCount).toBe((m.vertexCount / 4) * 2);
    expect(m.indices.length).toBe(m.triangleCount * 3);
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
  });

  it("tags every vertex KIND.NEON with valid local coords and positive strength", () => {
    const m = neonMesh(cityOf(250), PPM);
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

  it("spans local UV coordinates [-1, 1] per quad", () => {
    const m = neonMesh(cityOf(50), PPM);
    for (let q = 0; q < m.vertexCount; q += 4) {
      const us = [0, 1, 2, 3].map((k) => vertexAt(m, q + k).u);
      const vs = [0, 1, 2, 3].map((k) => vertexAt(m, q + k).top);
      expect(us).toEqual([-1, 1, 1, -1]);
      expect(vs).toEqual([-1, -1, 1, 1]);
    }
  });

  it("contains all quad vertices within building footprint bounds plus glow margin", () => {
    const slack = MAX_POOL_RADIUS_M * PPM;
    const epsilon = 1e-3;
    for (const spec of cityOf(150)) {
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

  it("resolves neon materials according to the district bank and neonWeights", () => {
    for (const spec of cityOf(150)) {
      const m = neonMesh([spec], PPM);
      const wallBank = Math.floor(spec.wallMaterial / BANK_SIZE);
      for (let i = 0; i < m.vertexCount; i++) {
        const material = vertexAt(m, i).material;
        expect(Math.floor(material / BANK_SIZE)).toBe(wallBank);
        expect([DISTRICT_SLOT.NEON_A, DISTRICT_SLOT.NEON_B]).toContain(material % BANK_SIZE);
      }
    }
  });

  it("favors ground frontage signs and vertical banners for market/entertainment profiles", () => {
    const marketSpecs = cityOf(400, "shopfront");
    const entertainmentSpecs = cityOf(400, "entertainment-arcade");
    const combined = [...marketSpecs, ...entertainmentSpecs];
    const signedCount = combined.filter((s) => neonMesh([s], PPM).vertexCount > 0).length;
    const rate = signedCount / combined.length;
    expect(rate).toBeGreaterThan(0.7);

    let banners = 0;
    for (const spec of combined) {
      if (spec.height < BANNER_MIN_BUILDING_M) continue;
      for (const q of quadsOf(neonMesh([spec], PPM))) {
        if (q.radial === 0 && q.halfHeightM > q.halfWidthM) banners++;
      }
    }
    expect(banners).toBeGreaterThan(15);
  });

  it("restrains corporate/civic profiles and favors crowns or entry bands with no high pools", () => {
    const corporateSpecs = cityOf(300, "glass-curtain");
    const civicSpecs = cityOf(300, "civic-columns");
    const specs = [...corporateSpecs, ...civicSpecs];

    let highCrowns = 0;
    let entryBands = 0;

    for (const spec of specs) {
      const quads = quadsOf(neonMesh([spec], PPM));
      for (let i = 0; i < quads.length; i++) {
        const q = quads[i]!;
        if (q.radial !== 0) continue;

        // High crown signs near the top of the building
        if (q.centerM > spec.height * 0.6 && spec.height >= 20) {
          highCrowns++;
          // High crown signs MUST NEVER emit ground pools
          if (quads[i + 1]?.radial === 1) {
            expect(quads[i + 1]!.bottomM).toBeLessThan(1);
            // Verify this pool does not belong to a high sign
            expect(q.bottomM).toBeLessThanOrEqual(8);
          }
        } else if (q.centerM <= SIGN_BAND_TOP_M) {
          entryBands++;
        }
      }
    }

    expect(highCrowns).toBeGreaterThan(10);
    expect(entryBands).toBeGreaterThan(10);
  });

  it("makes industrial and utility profiles sparse with compact status panels", () => {
    const specs = cityOf(500, "industrial-panel");
    const signed = specs.filter((s) => neonMesh([s], PPM).vertexCount > 0).length;
    const rate = signed / specs.length;
    expect(rate).toBeLessThan(0.35);

    for (const spec of specs) {
      for (const q of quadsOf(neonMesh([spec], PPM))) {
        if (q.radial === 0) {
          // Industrial status panels are compact
          expect(q.halfWidthM * 2).toBeLessThanOrEqual(4.5);
          expect(q.halfHeightM * 2).toBeLessThanOrEqual(2.5);
        }
      }
    }
  });

  it("clusters residential neon sparsely and keeps signs ground-local", () => {
    const specs = cityOf(500, "residential-balcony");
    const signed = specs.filter((s) => neonMesh([s], PPM).vertexCount > 0).length;
    const rate = signed / specs.length;
    expect(rate).toBeLessThan(0.25);

    for (const spec of specs) {
      for (const q of quadsOf(neonMesh([spec], PPM))) {
        if (q.radial === 0) {
          // Residential signs are strictly ground-local
          expect(q.centerM).toBeLessThanOrEqual(SIGN_BAND_TOP_M);
        }
      }
    }
  });

  it("allows irregular partial signage for derelict and old-city profiles", () => {
    const specs = cityOf(400, "derelict-reclamation");
    const strengths: number[] = [];
    for (const spec of specs) {
      for (const q of quadsOf(neonMesh([spec], PPM))) {
        if (q.radial === 0) {
          strengths.push(q.strength);
        }
      }
    }
    expect(strengths.length).toBeGreaterThan(15);
    const minStrength = Math.min(...strengths);
    const maxStrength = Math.max(...strengths);
    expect(maxStrength - minStrength).toBeGreaterThan(0.2);
  });

  it("only attaches ground glow pools to low signs with bounded radii", () => {
    const specs = cityOf(600);
    const m = neonMesh(specs, PPM);
    let pools = 0;

    for (let q = 0; q < m.vertexCount; q += 4) {
      const pool = vertexAt(m, q);
      if (pool.radial !== 1) continue;
      pools++;

      const sign = vertexAt(m, q - 4);
      expect(sign.radial).toBe(0);
      expect(pool.material).toBe(sign.material);
      expect(pool.strength).toBeLessThan(sign.strength);
      for (let i = 0; i < 4; i++) expect(vertexAt(m, q + i).height).toBeCloseTo(0.03, 5);

      expect(pool.halfWidthM).toBeGreaterThanOrEqual(MIN_POOL_RADIUS_M);
      expect(pool.halfWidthM).toBeLessThanOrEqual(MAX_POOL_RADIUS_M);
    }

    expect(pools).toBeGreaterThan(10);
  });

  it("keeps facade signs below the outer tier top of detailed towers", () => {
    let facades = 0;
    for (let i = 0; i < 150; i++) {
      const spec = detailedTower(hash2(i, 71, 13), "shopfront");
      const outerTop = describeBuildingMassing(spec, PPM).volumes[0]!.topHeight;
      const mesh = neonMesh([spec], PPM);
      for (let q = 0; q < mesh.vertexCount; q += 4) {
        if (vertexAt(mesh, q).radial !== 0) continue;
        const heights = [0, 1, 2, 3].map((corner) => vertexAt(mesh, q + corner).height);
        facades++;
        expect(Math.max(...heights)).toBeLessThanOrEqual(outerTop + 1e-5);
      }
    }
    expect(facades).toBeGreaterThan(10);
  });
});
