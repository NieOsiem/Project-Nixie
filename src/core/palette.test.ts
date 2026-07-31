import { describe, expect, it } from "vitest";
import {
  BANK_COUNT,
  BANK_SIZE,
  BASE_BANK,
  CITY_BANK,
  CITY_SURFACES,
  DEFAULT_DISTRICT_PALETTE,
  DISTRICT_SLOT,
  EMISSIVE_MAX,
  FIRST_ZONE_BANK,
  LAST_ZONE_BANK,
  MATERIAL,
  PALETTE_PRESETS,
  PALETTE_ROWS,
  PALETTE_SIZE,
  materialIndex,
  normalizePalette,
  packPalette,
  presetByName,
  zoneBank,
  type DistrictPalette,
  type Material
} from "./palette.js";

const mat = (over: Partial<Material> = {}): Material => ({
  base: { r: 1, g: 0.5, b: 0 },
  emissive: { r: 0, g: 1, b: 0.25 },
  emissiveStrength: 2,
  ...over
});

const baseAt = (d: Uint8Array, i: number): number[] => [...d.slice(i * 4, i * 4 + 4)];
const emissiveAt = (d: Uint8Array, i: number): number[] => {
  const at = (PALETTE_SIZE + i) * 4;
  return [...d.slice(at, at + 4)];
};

const legacyNeonSprawl = (): DistrictPalette => ({
  name: "Neon Sprawl",
  materials: [
    { base: { r: 0.165, g: 0.12, b: 0.275 }, emissive: { r: 0.62, g: 0.34, b: 0.95 }, emissiveStrength: 0.26 },
    { base: { r: 0.24, g: 0.105, b: 0.19 }, emissive: { r: 1, g: 0.28, b: 0.58 }, emissiveStrength: 0.32 },
    { base: { r: 0.085, g: 0.19, b: 0.22 }, emissive: { r: 0.22, g: 0.9, b: 1 }, emissiveStrength: 0.28 },
    { base: { r: 0.12, g: 0.095, b: 0.195 }, emissive: { r: 0.5, g: 0.3, b: 0.9 }, emissiveStrength: 0.05 },
    { base: { r: 0.075, g: 0.16, b: 0.18 }, emissive: { r: 0.2, g: 0.85, b: 0.95 }, emissiveStrength: 0.06 },
    { base: { r: 0.19, g: 0.085, b: 0.16 }, emissive: { r: 0.95, g: 0.3, b: 0.6 }, emissiveStrength: 0.06 },
    { base: { r: 0.025, g: 0.008, b: 0.015 }, emissive: { r: 1, g: 0.24, b: 0.6 }, emissiveStrength: 1.6 },
    { base: { r: 0.008, g: 0.02, b: 0.022 }, emissive: { r: 0.28, g: 0.95, b: 1 }, emissiveStrength: 1.5 }
  ]
});

describe("packPalette", () => {
  it("always fills the full texture regardless of bank count", () => {
    expect(packPalette([]).length).toBe(PALETTE_SIZE * PALETTE_ROWS * 4);
    expect(packPalette([[mat()]]).length).toBe(PALETTE_SIZE * PALETTE_ROWS * 4);
  });

  it("writes base colour to row 0 with opaque alpha", () => {
    expect(baseAt(packPalette([[mat()]]), 0)).toEqual([255, 128, 0, 255]);
  });

  it("writes emissive colour and strength to row 1", () => {
    const d = packPalette([[mat()]]);
    expect(emissiveAt(d, 0)).toEqual([0, 255, 64, Math.round((2 / EMISSIVE_MAX) * 255)]);
  });

  it("places bank b at entry b * BANK_SIZE", () => {
    const blue = mat({ base: { r: 0, g: 0, b: 1 } });
    const d = packPalette([[mat()], [], [], [], [], [blue]]);
    expect(baseAt(d, materialIndex(5, 0))).toEqual([0, 0, 255, 255]);
    // The slot before it belongs to bank 4 and must be untouched.
    expect(baseAt(d, materialIndex(5, 0) - 1)).toEqual([0, 0, 0, 0]);
  });

  it("places slot s within its own bank", () => {
    const green = mat({ base: { r: 0, g: 1, b: 0 } });
    const bank = Array.from({ length: BANK_SIZE }, (_, s) => (s === DISTRICT_SLOT.NEON_B ? green : mat()));
    const d = packPalette([[], bank]);
    expect(baseAt(d, materialIndex(1, DISTRICT_SLOT.NEON_B))).toEqual([0, 255, 0, 255]);
  });

  it("clamps out-of-range channels", () => {
    const d = packPalette([[mat({ base: { r: 4, g: -1, b: 0.5 }, emissiveStrength: 99 })]]);
    expect(baseAt(d, 0).slice(0, 3)).toEqual([255, 0, 128]);
    expect(emissiveAt(d, 0)[3]).toBe(255);
  });

  it("leaves unused banks and slots zeroed", () => {
    const d = packPalette([[mat()]]);
    expect(baseAt(d, 1)).toEqual([0, 0, 0, 0]);
    expect(baseAt(d, materialIndex(BANK_COUNT - 1, 0))).toEqual([0, 0, 0, 0]);
  });

  it("rejects more banks than the palette holds", () => {
    const many = Array.from({ length: BANK_COUNT + 1 }, () => [mat()]);
    expect(() => packPalette(many)).toThrow(/32/);
  });

  it("rejects a bank with more materials than BANK_SIZE", () => {
    const fat = Array.from({ length: BANK_SIZE + 1 }, () => mat());
    expect(() => packPalette([fat])).toThrow(/8/);
  });
});

describe("bank layout", () => {
  it("keeps the shared surfaces in bank 0, out of every district's reach", () => {
    for (const index of Object.values(MATERIAL)) {
      expect(Math.floor(index / BANK_SIZE)).toBe(CITY_BANK);
    }
    expect(BASE_BANK).toBeGreaterThan(CITY_BANK);
    expect(FIRST_ZONE_BANK).toBeGreaterThan(BASE_BANK);
  });

  it("wraps zone banks inside the district range and never onto a reserved bank", () => {
    for (const i of [0, 1, 29, 30, 200, -1, -37]) {
      const bank = zoneBank(i);
      expect(bank).toBeGreaterThanOrEqual(FIRST_ZONE_BANK);
      expect(bank).toBeLessThanOrEqual(LAST_ZONE_BANK);
    }
    expect(zoneBank(0)).toBe(FIRST_ZONE_BANK);
    expect(zoneBank(LAST_ZONE_BANK - FIRST_ZONE_BANK + 1)).toBe(FIRST_ZONE_BANK);
  });

  it("materialIndex round-trips to its bank and slot", () => {
    const i = materialIndex(7, DISTRICT_SLOT.ROOF_B);
    expect(Math.floor(i / BANK_SIZE)).toBe(7);
    expect(i % BANK_SIZE).toBe(DISTRICT_SLOT.ROOF_B);
  });
});

describe("shipped palettes", () => {
  it("every preset fills a whole bank", () => {
    for (const preset of PALETTE_PRESETS) {
      expect(preset.materials).toHaveLength(BANK_SIZE);
      expect(preset.name.length).toBeGreaterThan(0);
    }
    expect(CITY_SURFACES.length).toBeLessThanOrEqual(BANK_SIZE);
  });

  it("preset names are unique, since the UI selects by name", () => {
    const names = PALETTE_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every channel in range so packing cannot silently clamp", () => {
    for (const m of [...CITY_SURFACES, ...PALETTE_PRESETS.flatMap((p) => p.materials)]) {
      for (const c of [m.base.r, m.base.g, m.base.b, m.emissive.r, m.emissive.g, m.emissive.b]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      expect(m.emissiveStrength).toBeGreaterThanOrEqual(0);
      expect(m.emissiveStrength).toBeLessThanOrEqual(EMISSIVE_MAX);
    }
  });

  it("keeps the ground plane and paint below the bloom threshold", () => {
    // WHY: broad shared surfaces wash out the scene above 0.55; paint above it floats in a halo.
    // Scaled by EMISSIVE_MAX because that is what the shader multiplies by — without it this
    // read 4x low and let KERB sit at 0.95, drawing a lit cyan outline along every street.
    // Covers all of CITY_SURFACES: the slice(0, 5) this replaces skipped KERB entirely.
    for (const m of CITY_SURFACES) {
      const peak =
        Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * m.emissiveStrength * EMISSIVE_MAX;
      expect(peak).toBeLessThan(0.55);
    }
  });

  it("separates Neon Sprawl bodies, wall light, and strong architectural accents", () => {
    const [wallA, wallB, wallC, , , , neonA, neonB] = DEFAULT_DISTRICT_PALETTE.materials;
    expect(wallA).toMatchObject({
      base: { r: 0.17, g: 0.105, b: 0.3 },
      emissive: { r: 0.18, g: 1, b: 0.78 },
      emissiveStrength: 0.34
    });
    expect(wallB).toMatchObject({
      emissive: { r: 1, g: 0.2, b: 0.62 },
      emissiveStrength: 0.36
    });
    expect(wallC).toMatchObject({
      emissive: { r: 0.18, g: 0.78, b: 1 },
      emissiveStrength: 0.34
    });
    expect(neonA).toMatchObject({
      emissive: { r: 1, g: 0.18, b: 0.58 },
      emissiveStrength: 1.65
    });
    expect(neonB).toMatchObject({
      emissive: { r: 0.18, g: 1, b: 0.82 },
      emissiveStrength: 1.55
    });
  });

  it("finds presets by name and nothing else", () => {
    expect(presetByName(DEFAULT_DISTRICT_PALETTE.name)).toEqual(DEFAULT_DISTRICT_PALETTE);
    expect(presetByName("no such preset")).toBeNull();
  });
});

describe("normalizePalette", () => {
  it("upgrades the exact legacy Neon Sprawl preset without overwriting edits", () => {
    expect(normalizePalette(legacyNeonSprawl())).toEqual(DEFAULT_DISTRICT_PALETTE);

    const customized = legacyNeonSprawl();
    customized.materials[0]!.base.r = 0.166;
    expect(normalizePalette(customized).materials[0]!.base.r).toBe(0.166);
  });

  it("pads a short stored bank from the default", () => {
    const p = normalizePalette({ name: "Half", materials: [mat(), mat()] });
    expect(p.materials).toHaveLength(BANK_SIZE);
    expect(p.materials[0]).toEqual(mat());
    expect(p.materials[BANK_SIZE - 1]).toEqual(DEFAULT_DISTRICT_PALETTE.materials[BANK_SIZE - 1]);
  });

  it("returns a full default bank for null or empty input", () => {
    expect(normalizePalette(null).materials).toHaveLength(BANK_SIZE);
    expect(normalizePalette(undefined)).toEqual(DEFAULT_DISTRICT_PALETTE);
    expect(normalizePalette({})).toEqual(DEFAULT_DISTRICT_PALETTE);
  });

  it("deep-copies so editing the result cannot mutate a shipped preset", () => {
    const p = normalizePalette(DEFAULT_DISTRICT_PALETTE);
    p.materials[0]!.base.r = 0.999;
    p.materials[0]!.emissiveStrength = 3.5;
    expect(DEFAULT_DISTRICT_PALETTE.materials[0]!.base.r).not.toBe(0.999);
    expect(DEFAULT_DISTRICT_PALETTE.materials[0]!.emissiveStrength).not.toBe(3.5);
  });
});
