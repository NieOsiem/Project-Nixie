import { describe, expect, it } from "vitest";
import { DISTRICT_PALETTE_IDS } from "./gen/district-registry.js";
import {
  BANK_COUNT,
  BANK_SIZE,
  BASE_BANK,
  BUILTIN_PALETTES,
  CITY_BANK,
  CITY_SLOT,
  CITY_SURFACES,
  DEFAULT_DISTRICT_PALETTE,
  DISTRICT_SLOT,
  EMISSIVE_MAX,
  FIRST_ZONE_BANK,
  LAST_ZONE_BANK,
  MATERIAL,
  OPEN_SPACE_SURFACE_SHADES,
  OPEN_SPACE_SURFACE_SLOTS,
  PALETTE_PRESETS,
  PALETTE_ROWS,
  PALETTE_SIZE,
  builtinPalette,
  materialIndex,
  normalizePalette,
  packPalette,
  paletteBanks,
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
  it("reserves exactly one shared water material slot", () => {
    expect(CITY_SLOT.WATER).toBe(6);
    expect(MATERIAL.WATER).toBe(materialIndex(CITY_BANK, CITY_SLOT.WATER));
    expect(CITY_SURFACES).toHaveLength(8);
    expect(CITY_SLOT.NON_VEHICLE_ROUTE).toBe(7);
    expect(MATERIAL.NON_VEHICLE_ROUTE).toBe(materialIndex(CITY_BANK, CITY_SLOT.NON_VEHICLE_ROUTE));
    expect(CITY_SURFACES.length).toBe(BANK_SIZE);
  });

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

  it("maps palette ids to zone banks independent of the order they appear in", () => {
    const a = paletteBanks(["corporate", "industrial", "night-market"]);
    const b = paletteBanks(["night-market", "industrial", "corporate"]);
    expect([...a.entries()]).toEqual([...b.entries()]);
    // The sort order is the only input: first palette alphabetically takes the first zone bank.
    expect(a.get("corporate")).toBe(FIRST_ZONE_BANK);
    expect(a.get("industrial")).toBe(FIRST_ZONE_BANK + 1);
    expect(a.get("night-market")).toBe(FIRST_ZONE_BANK + 2);
  });

  it("derives banks from palette ids alone, never district order or district ids", () => {
    const first = paletteBanks(["corporate", "night-market"]);
    const second = paletteBanks(["night-market", "corporate"]);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(paletteBanks(["corporate", "night-market"]).get("night-market")).toBe(
      paletteBanks(["night-market", "corporate"]).get("night-market")
    );
  });

  it("dedupes, stays deterministic, and wraps inside the zone range", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `palette-${String(i).padStart(2, "0")}`);
    const banks = paletteBanks(ids);
    expect(banks.size).toBe(40);
    expect(paletteBanks(ids)).toEqual(banks);
    for (const bank of banks.values()) {
      expect(bank).toBeGreaterThanOrEqual(FIRST_ZONE_BANK);
      expect(bank).toBeLessThanOrEqual(LAST_ZONE_BANK);
    }
    expect(paletteBanks(["dup", "dup", "other"]).size).toBe(2);
  });

  it("materialIndex round-trips to its bank and slot", () => {
    const i = materialIndex(7, DISTRICT_SLOT.ROOF_B);
    expect(Math.floor(i / BANK_SIZE)).toBe(7);
    expect(i % BANK_SIZE).toBe(DISTRICT_SLOT.ROOF_B);
  });

  it("resolves every shipping open-space surface style inside a district bank", () => {
    const shippingStyles = [
      "grass",
      "paving",
      "tarmac",
      "scrub",
      "concrete",
      "planting",
      "gravel"
    ];
    for (const style of shippingStyles) {
      const slot = OPEN_SPACE_SURFACE_SLOTS[style];
      expect(slot).toBeDefined();
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(BANK_SIZE);
    }
    expect(OPEN_SPACE_SURFACE_SLOTS["grass"]).not.toBe(OPEN_SPACE_SURFACE_SLOTS["gravel"]);
  });

  it("keeps every shipping surface shade distinct and bounded", () => {
    const shades = Object.entries(OPEN_SPACE_SURFACE_SHADES)
      .filter(([style]) => OPEN_SPACE_SURFACE_SLOTS[style] !== undefined)
      .map(([, shade]) => shade);
    expect(shades).toHaveLength(7);
    expect(new Set(shades).size).toBe(7);
    for (const shade of shades) {
      expect(shade).toBeGreaterThan(0);
      expect(shade).toBeLessThanOrEqual(1);
    }
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
    const surfaces = [
      ...CITY_SURFACES,
      ...PALETTE_PRESETS.flatMap((p) => p.materials.slice(0, DISTRICT_SLOT.NEON_A))
    ];
    for (const m of surfaces) {
      const peak =
        Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * m.emissiveStrength * EMISSIVE_MAX;
      expect(peak).toBeLessThan(0.36);
    }
  });

  it("separates Neon Sprawl bodies, wall light, and strong architectural accents", () => {
    const [wallA, wallB, wallC, , , , neonA, neonB] = DEFAULT_DISTRICT_PALETTE.materials;
    expect(wallA).toMatchObject({
      base: { r: 0.168, g: 0.133, b: 0.238 },
      emissive: { r: 0.42, g: 0.30, b: 0.62 },
      emissiveStrength: 0.07
    });
    expect(wallB).toMatchObject({
      base: { r: 0.077, g: 0.196, b: 0.210 },
      emissive: { r: 0.20, g: 0.60, b: 0.62 },
      emissiveStrength: 0.06
    });
    expect(wallC).toMatchObject({
      base: { r: 0.217, g: 0.098, b: 0.189 },
      emissive: { r: 0.62, g: 0.22, b: 0.48 },
      emissiveStrength: 0.07
    });
    expect(neonA).toMatchObject({
      emissive: { r: 1.0, g: 0.18, b: 0.58 },
      emissiveStrength: 1.65
    });
    expect(neonB).toMatchObject({
      emissive: { r: 0.18, g: 0.95, b: 0.92 },
      emissiveStrength: 1.55
    });
  });

  const luma = (m: Material): number =>
    0.299 * m.base.r + 0.587 * m.base.g + 0.114 * m.base.b;

  it("enforces clear luminance hierarchy and minimum slot separation in shared surfaces", () => {
    const water = CITY_SURFACES[CITY_SLOT.WATER]!;
    const ground = CITY_SURFACES[CITY_SLOT.GROUND]!;
    const road = CITY_SURFACES[CITY_SLOT.ROAD]!;
    const route = CITY_SURFACES[CITY_SLOT.NON_VEHICLE_ROUTE]!;
    const kerb = CITY_SURFACES[CITY_SLOT.KERB]!;
    const sidewalk = CITY_SURFACES[CITY_SLOT.SIDEWALK]!;
    const laneMark = CITY_SURFACES[CITY_SLOT.LANE_MARK]!;
    const crossing = CITY_SURFACES[CITY_SLOT.CROSSING]!;

    const lWater = luma(water);
    const lGround = luma(ground);
    const lRoad = luma(road);
    const lRoute = luma(route);
    const lKerb = luma(kerb);
    const lSidewalk = luma(sidewalk);
    const lLaneMark = luma(laneMark);
    const lCrossing = luma(crossing);

    // Monotonic dark-to-light progression. CRITIQUE C12 pulled the paint down a tier: the
    // kerb now reads darker than a service route, and lane paint sits just under sidewalk
    // concrete instead of glowing above it.
    expect(lWater).toBeLessThan(lGround);
    expect(lGround).toBeLessThan(lRoad);
    expect(lRoad).toBeLessThan(lKerb);
    expect(lKerb).toBeLessThan(lRoute);
    expect(lRoute).toBeLessThan(lLaneMark);
    expect(lLaneMark).toBeLessThan(lSidewalk);
    expect(lSidewalk).toBeLessThan(lCrossing);

    // Minimum slot separation to prevent mud
    expect(lRoad - lGround).toBeGreaterThanOrEqual(0.015);
    expect(lKerb - lRoad).toBeGreaterThanOrEqual(0.01);
    expect(lSidewalk - lRoad).toBeGreaterThanOrEqual(0.05);
    expect(lLaneMark - lRoad).toBeGreaterThanOrEqual(0.04);
    expect(lCrossing - lLaneMark).toBeGreaterThanOrEqual(0.02);

    // Bounded luminance bands
    expect(lGround).toBeGreaterThanOrEqual(0.06);
    expect(lGround).toBeLessThanOrEqual(0.08);
    expect(lRoad).toBeGreaterThanOrEqual(0.075);
    expect(lRoad).toBeLessThanOrEqual(0.10);
    expect(lSidewalk).toBeGreaterThanOrEqual(0.135);
    expect(lSidewalk).toBeLessThanOrEqual(0.17);
    expect(lLaneMark).toBeGreaterThanOrEqual(0.12);
    expect(lLaneMark).toBeLessThanOrEqual(0.16);
    expect(lCrossing).toBeLessThanOrEqual(0.18);
  });

  it("finds presets by name and nothing else", () => {
    expect(presetByName(DEFAULT_DISTRICT_PALETTE.name)).toEqual(DEFAULT_DISTRICT_PALETTE);
    expect(presetByName("no such preset")).toBeNull();
  });

  it("gives every preset at least two meaningfully chromed, hue-separated body materials", () => {
    const chroma = (m: Material): number =>
      Math.max(m.base.r, m.base.g, m.base.b) - Math.min(m.base.r, m.base.g, m.base.b);
    const distance = (a: Material, b: Material): number =>
      Math.abs(a.base.r - b.base.r) + Math.abs(a.base.g - b.base.g) + Math.abs(a.base.b - b.base.b);
    for (const preset of PALETTE_PRESETS) {
      const bodies = [0, 1, 2, 3, 4, 5].map((slot) => preset.materials[slot]!);
      expect(bodies.filter((m) => chroma(m) >= 0.045).length, `${preset.name} chromed bodies`).toBeGreaterThanOrEqual(2);
      let best = 0;
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          best = Math.max(best, distance(bodies[i]!, bodies[j]!));
        }
      }
      expect(best, `${preset.name} body hue separation`).toBeGreaterThanOrEqual(0.06);
    }
  });
});

describe("built-in district palettes", () => {
  const GROUND_SLOTS = [
    DISTRICT_SLOT.WALL_A,
    DISTRICT_SLOT.WALL_B,
    DISTRICT_SLOT.WALL_C,
    DISTRICT_SLOT.ROOF_A,
    DISTRICT_SLOT.ROOF_B,
    DISTRICT_SLOT.ROOF_C
  ];

  const WALL_SLOTS = [DISTRICT_SLOT.WALL_A, DISTRICT_SLOT.WALL_B, DISTRICT_SLOT.WALL_C];
  const ROOF_SLOTS = [DISTRICT_SLOT.ROOF_A, DISTRICT_SLOT.ROOF_B, DISTRICT_SLOT.ROOF_C];
  const ALL_PALETTES = [...PALETTE_PRESETS, ...DISTRICT_PALETTE_IDS.map(builtinPalette)];

  const luma = (m: Material): number =>
    0.299 * m.base.r + 0.587 * m.base.g + 0.114 * m.base.b;

  it("keeps wall albedo in the saturated midtone band and roof albedo darker below it", () => {
    for (const palette of ALL_PALETTES) {
      for (const slot of WALL_SLOTS) {
        const l = luma(palette.materials[slot]!);
        expect(l, `${palette.name} wall slot ${slot} luma`).toBeGreaterThanOrEqual(0.11);
        expect(l, `${palette.name} wall slot ${slot} luma`).toBeLessThanOrEqual(0.22);
      }
      for (const slot of ROOF_SLOTS) {
        const l = luma(palette.materials[slot]!);
        expect(l, `${palette.name} roof slot ${slot} luma`).toBeGreaterThanOrEqual(0.09);
        expect(l, `${palette.name} roof slot ${slot} luma`).toBeLessThanOrEqual(0.17);
      }
    }
  });

  it("keeps every roof darker than its palette's walls", () => {
    for (const palette of ALL_PALETTES) {
      const walls = WALL_SLOTS.map((slot) => luma(palette.materials[slot]!));
      const roofs = ROOF_SLOTS.map((slot) => luma(palette.materials[slot]!));
      expect(Math.max(...roofs), `${palette.name} roof vs wall luma`).toBeLessThan(
        Math.min(...walls)
      );
    }
  });

  it("holds neon accents in the 1.2-1.7 strength band", () => {
    for (const palette of ALL_PALETTES) {
      for (const slot of [DISTRICT_SLOT.NEON_A, DISTRICT_SLOT.NEON_B]) {
        const s = palette.materials[slot]!.emissiveStrength;
        expect(s, `${palette.name} neon slot ${slot}`).toBeGreaterThanOrEqual(1.2);
        expect(s, `${palette.name} neon slot ${slot}`).toBeLessThanOrEqual(1.7);
      }
    }
  });

  it("keeps at least two meaningfully chromed, hue-separated non-neon body materials", () => {
    const chroma = (m: Material): number =>
      Math.max(m.base.r, m.base.g, m.base.b) - Math.min(m.base.r, m.base.g, m.base.b);
    const distance = (a: Material, b: Material): number =>
      Math.abs(a.base.r - b.base.r) + Math.abs(a.base.g - b.base.g) + Math.abs(a.base.b - b.base.b);
    for (const id of DISTRICT_PALETTE_IDS) {
      const palette = builtinPalette(id);
      const bodies = GROUND_SLOTS.map((slot) => palette.materials[slot]!);
      expect(
        bodies.filter((m) => chroma(m) >= 0.045).length,
        `${id} chromed bodies`
      ).toBeGreaterThanOrEqual(2);
      let best = 0;
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          best = Math.max(best, distance(bodies[i]!, bodies[j]!));
        }
      }
      expect(best, `${id} body hue separation`).toBeGreaterThanOrEqual(0.06);
    }
  });

  it("preserves Night Market dual red/pink and yellow neon accents", () => {
    const nm = builtinPalette("night-market");
    const neonA = nm.materials[DISTRICT_SLOT.NEON_A]!;
    const neonB = nm.materials[DISTRICT_SLOT.NEON_B]!;

    // NEON_A: vivid red/pink lantern
    expect(neonA.emissive.r).toBeGreaterThan(0.9);
    expect(neonA.emissive.r).toBeGreaterThan(neonA.emissive.g * 2);
    expect(neonA.emissiveStrength).toBeGreaterThanOrEqual(1.5);

    // NEON_B: brilliant yellow market signage
    expect(neonB.emissive.r).toBeGreaterThan(0.9);
    expect(neonB.emissive.g).toBeGreaterThan(0.85);
    expect(neonB.emissive.b).toBeLessThan(0.3);
    expect(neonB.emissiveStrength).toBeGreaterThanOrEqual(1.5);
  });

  it("differentiates primary and secondary neon hues across all districts", () => {
    for (const id of DISTRICT_PALETTE_IDS) {
      const palette = builtinPalette(id);
      const a = palette.materials[DISTRICT_SLOT.NEON_A]!;
      const b = palette.materials[DISTRICT_SLOT.NEON_B]!;
      const dr = Math.abs(a.emissive.r - b.emissive.r);
      const dg = Math.abs(a.emissive.g - b.emissive.g);
      const db = Math.abs(a.emissive.b - b.emissive.b);
      const hueDiff = dr + dg + db;
      expect(hueDiff, `${id} neon A/B hue distinction`).toBeGreaterThanOrEqual(0.3);
    }
  });

  const bankRegion = (packed: Uint8Array, bank: number): string =>
    [...packed.slice(bank * BANK_SIZE * 4, (bank + 1) * BANK_SIZE * 4)].join(",");

  it("resolves every shipping district palette id to a distinct full bank", () => {
    expect(new Set(DISTRICT_PALETTE_IDS).size).toBe(16);
    expect(Object.keys(BUILTIN_PALETTES).length).toBe(16);
    for (const id of DISTRICT_PALETTE_IDS) {
      const palette = builtinPalette(id);
      expect(palette).not.toBe(DEFAULT_DISTRICT_PALETTE);
      expect(palette.materials).toHaveLength(BANK_SIZE);
      for (const m of palette.materials) {
        for (const c of [m.base.r, m.base.g, m.base.b, m.emissive.r, m.emissive.g, m.emissive.b]) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
        expect(m.emissiveStrength).toBeGreaterThanOrEqual(0);
        expect(m.emissiveStrength).toBeLessThanOrEqual(EMISSIVE_MAX);
      }
    }
    const signatures = DISTRICT_PALETTE_IDS.map((id) => JSON.stringify(builtinPalette(id).materials));
    expect(new Set(signatures).size).toBe(signatures.length);
  });
  it("keeps a recognizable dominant body hue in every built-in district bank", () => {
    for (const id of DISTRICT_PALETTE_IDS) {
      const walls = builtinPalette(id).materials.slice(DISTRICT_SLOT.WALL_A, DISTRICT_SLOT.ROOF_A);
      const dominantChannels = walls.map((material) => {
        const channels = [material.base.r, material.base.g, material.base.b];
        return channels.indexOf(Math.max(...channels));
      });
      const dominantCount = Math.max(
        ...[0, 1, 2].map((channel) => dominantChannels.filter((candidate) => candidate === channel).length)
      );
      expect(dominantCount, `${id} wall family dominant hue`).toBeGreaterThanOrEqual(2);
      for (const wall of walls) {
        expect(luma(wall), `${id} matte wall value`).toBeLessThanOrEqual(0.22);
      }
    }
  });

  it("keeps ground-sampled wall and roof slots under the whole-ground bloom threshold", () => {
    for (const id of DISTRICT_PALETTE_IDS) {
      for (const slot of GROUND_SLOTS) {
        const m = builtinPalette(id).materials[slot]!;
        const peak =
          Math.max(m.emissive.r, m.emissive.g, m.emissive.b) * m.emissiveStrength * EMISSIVE_MAX;
        expect(peak).toBeLessThan(0.36);
      }
    }
  });

  it("maps ids to banks by sorted order, never district order", () => {
    const ids = ["waterfront", "corporate", "night-market"];
    expect(paletteBanks(ids)).toEqual(paletteBanks([...ids].reverse()));
    const sorted = [...ids].sort().map((id, index) => [id, FIRST_ZONE_BANK + index]);
    expect([...paletteBanks(ids).entries()]).toEqual(sorted);
  });

  it("packs several distinct ids into distinct bank bytes under the plan's sorted rule", () => {
    const ids = [
      "commercial",
      "entertainment",
      "industrial-heavy",
      "industrial-light",
      "night-market",
      "residential-mega"
    ];
    const banks: Material[][] = Array.from({ length: BANK_COUNT }, () =>
      DEFAULT_DISTRICT_PALETTE.materials
    );
    banks[CITY_BANK] = CITY_SURFACES;
    for (const [id, bank] of paletteBanks(ids)) banks[bank] = builtinPalette(id).materials;
    const packed = packPalette(banks);
    const regions = [...paletteBanks(ids).values()].map((bank) => bankRegion(packed, bank));
    expect(new Set(regions).size).toBe(regions.length);
    expect([...paletteBanks(ids).values()].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("falls back to the default palette for unknown or unzoned ids", () => {
    expect(builtinPalette("no-such-id")).toBe(DEFAULT_DISTRICT_PALETTE);
    expect(builtinPalette("")).toBe(DEFAULT_DISTRICT_PALETTE);
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
