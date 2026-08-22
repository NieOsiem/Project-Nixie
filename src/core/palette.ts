/**
 * Materials live in fixed-size banks so a district can be retinted by rewriting eight
 * texture entries — no geometry rebuild, which is the entire point of S6.
 *
 * Bank 0 is the shared city bank (ground, carriageway, pavement, road markings): it is
 * never district-tinted, because a road crossing a district boundary must not change
 * colour halfway. Bank 1 is the unzoned remainder. Zones take banks 2 upward.
 */
export const BANK_SIZE = 8;
export const BANK_COUNT = 32;
export const PALETTE_SIZE = BANK_SIZE * BANK_COUNT;
export const PALETTE_ROWS = 2;
/** Emissive strength is stored in a byte; this is the value 255 maps to. */
export const EMISSIVE_MAX = 4;

export const CITY_BANK = 0;
export const BASE_BANK = 1;
export const FIRST_ZONE_BANK = 2;
export const LAST_ZONE_BANK = BANK_COUNT - 1;

/** Slot within the shared city bank. */
export const CITY_SLOT = {
  GROUND: 0,
  ROAD: 1,
  SIDEWALK: 2,
  LANE_MARK: 3,
  CROSSING: 4,
  KERB: 5,
  WATER: 6,
  NON_VEHICLE_ROUTE: 7
} as const;

/** Slot within a district bank. Every district palette supplies exactly these, in order. */
export const DISTRICT_SLOT = {
  WALL_A: 0,
  WALL_B: 1,
  WALL_C: 2,
  ROOF_A: 3,
  ROOF_B: 4,
  ROOF_C: 5,
  NEON_A: 6,
  NEON_B: 7
} as const;

export const DISTRICT_SLOT_LABELS: [number, string][] = [
  [DISTRICT_SLOT.WALL_A, "Wall A"],
  [DISTRICT_SLOT.WALL_B, "Wall B"],
  [DISTRICT_SLOT.WALL_C, "Wall C"],
  [DISTRICT_SLOT.ROOF_A, "Roof A"],
  [DISTRICT_SLOT.ROOF_B, "Roof B"],
  [DISTRICT_SLOT.ROOF_C, "Roof C"],
  [DISTRICT_SLOT.NEON_A, "Neon A"],
  [DISTRICT_SLOT.NEON_B, "Neon B"]
];

export const materialIndex = (bank: number, slot: number): number => bank * BANK_SIZE + slot;

/**
 * Open-space surface styles resolve to a district slot inside the open space's own bank,
 * so the ground stays district-retintable. The plan already resolved a category slot;
 * this table re-derives the material from the surface style so the two categories that
 * share a plan slot (park and service-yard both ROOF_A) still get distinct payloads.
 */
export const OPEN_SPACE_SURFACE_SLOTS: Readonly<Record<string, number>> = Object.freeze({
  grass: DISTRICT_SLOT.ROOF_A,
  paving: DISTRICT_SLOT.WALL_A,
  tarmac: DISTRICT_SLOT.WALL_B,
  scrub: DISTRICT_SLOT.WALL_C,
  concrete: DISTRICT_SLOT.ROOF_B,
  planting: DISTRICT_SLOT.ROOF_C,
  gravel: DISTRICT_SLOT.ROOF_B
});

/**
 * Per-style flat-ground shade: the flat path multiplies the base colour by this, so each
 * style keeps its own tone (park brightest, service grounds darkest) without new geometry.
 */
export const OPEN_SPACE_SURFACE_SHADES: Readonly<Record<string, number>> = Object.freeze({
  grass: 1,
  paving: 0.97,
  tarmac: 0.9,
  scrub: 0.94,
  concrete: 0.88,
  planting: 0.96,
  gravel: 0.86
});

/** Absolute indices into the shared bank. Generation code refers to surfaces by these. */
export const MATERIAL = {
  GROUND: materialIndex(CITY_BANK, CITY_SLOT.GROUND),
  ROAD: materialIndex(CITY_BANK, CITY_SLOT.ROAD),
  SIDEWALK: materialIndex(CITY_BANK, CITY_SLOT.SIDEWALK),
  LANE_MARK: materialIndex(CITY_BANK, CITY_SLOT.LANE_MARK),
  CROSSING: materialIndex(CITY_BANK, CITY_SLOT.CROSSING),
  KERB: materialIndex(CITY_BANK, CITY_SLOT.KERB),
  WATER: materialIndex(CITY_BANK, CITY_SLOT.WATER),
  NON_VEHICLE_ROUTE: materialIndex(CITY_BANK, CITY_SLOT.NON_VEHICLE_ROUTE)
} as const;

/** Zone n takes the nth district bank, wrapping once the palette runs out. */
export function zoneBank(index: number): number {
  const span = LAST_ZONE_BANK - FIRST_ZONE_BANK + 1;
  return FIRST_ZONE_BANK + (((index % span) + span) % span);
}

/**
 * Maps a city's distinct palette ids to district banks.
 *
 * WHY sorted, not insertion-ordered: retinting must depend only on which palettes the city
 * uses, never on district order or district ids. Two cities with the same palette set
 * resolve the same id to the same bank, so a palette swap cannot reshuffle every bank.
 */
export function paletteBanks(paletteIds: Iterable<string>): ReadonlyMap<string, number> {
  return new Map([...new Set(paletteIds)].sort().map((id, index) => [id, zoneBank(index)]));
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Material {
  base: RGB;
  emissive: RGB;
  emissiveStrength: number;
}

/** What a district stores in the scene flag. `materials` is BANK_SIZE long. */
export interface DistrictPalette {
  name: string;
  materials: Material[];
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const toByte = (v: number): number => Math.round(clamp01(v) * 255);

/**
 * Pack banks into an RGBA8 lookup texture: row 0 base colour, row 1 emissive colour with
 * strength in alpha. `banks[b]` fills entries [b*BANK_SIZE, (b+1)*BANK_SIZE).
 *
 * A texture rather than a uniform array because GLSL ES 1.00 only guarantees dynamic
 * indexing of uniform arrays in vertex shaders, and a texture also scales past the
 * uniform-vector limit without changing the shader.
 */
export function packPalette(banks: ReadonlyArray<ReadonlyArray<Material>>): Uint8Array {
  if (banks.length > BANK_COUNT) {
    throw new Error(`Palette holds ${BANK_COUNT} banks, got ${banks.length}.`);
  }

  const data = new Uint8Array(PALETTE_SIZE * PALETTE_ROWS * 4);
  banks.forEach((bank, b) => {
    if (bank.length > BANK_SIZE) {
      throw new Error(`Bank ${b} holds ${BANK_SIZE} materials, got ${bank.length}.`);
    }
    bank.forEach((m, slot) => {
      const i = materialIndex(b, slot);
      const base = i * 4;
      data[base] = toByte(m.base.r);
      data[base + 1] = toByte(m.base.g);
      data[base + 2] = toByte(m.base.b);
      data[base + 3] = 255;

      const emissive = (PALETTE_SIZE + i) * 4;
      data[emissive] = toByte(m.emissive.r);
      data[emissive + 1] = toByte(m.emissive.g);
      data[emissive + 2] = toByte(m.emissive.b);
      data[emissive + 3] = toByte(m.emissiveStrength / EMISSIVE_MAX);
    });
  });
  return data;
}

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });
const dark = (r: number, g: number, b: number): Material => ({
  base: rgb(r, g, b),
  emissive: rgb(0, 0, 0),
  emissiveStrength: 0
});
const lit = (
  base: RGB,
  emissive: RGB,
  emissiveStrength: number
): Material => ({ base, emissive, emissiveStrength });

/**
 * Shared surfaces in Bank 0: grounded dark metropolitan foundation.
 * Emissive strengths stay strictly low to prevent whole-ground bloom (peak < 0.55 under EMISSIVE_MAX = 4).
 */
export const CITY_SURFACES: Material[] = [
  dark(0.065, 0.068, 0.078),                                          // GROUND: dark charcoal soil/asphalt base
  lit(rgb(0.082, 0.086, 0.098), rgb(0.24, 0.26, 0.35), 0.05),        // ROAD: blue-black dense carriageway
  lit(rgb(0.148, 0.152, 0.165), rgb(0.42, 0.45, 0.52), 0.04),        // SIDEWALK: cool charcoal concrete
  lit(rgb(0.205, 0.200, 0.175), rgb(0.85, 0.82, 0.68), 0.06),        // LANE_MARK: faded sodium road line
  lit(rgb(0.225, 0.235, 0.248), rgb(0.82, 0.88, 0.96), 0.06),        // CROSSING: pale white/cyan pedestrian crossing
  lit(rgb(0.120, 0.124, 0.135), rgb(0.32, 0.36, 0.42), 0.04),        // KERB: dark concrete curb boundary
  dark(0.018, 0.028, 0.045),                                          // WATER: deep murky reflective runoff
  lit(rgb(0.105, 0.108, 0.120), rgb(0.32, 0.38, 0.46), 0.05)         // NON_VEHICLE_ROUTE: dark service alley / pedestrian passage
];

const district = (name: string, materials: Material[]): DistrictPalette => ({ name, materials });

const LEGACY_NEON_SPRAWL = district("Neon Sprawl", [
  lit(rgb(0.165, 0.12, 0.275), rgb(0.62, 0.34, 0.95), 0.26),
  lit(rgb(0.24, 0.105, 0.19), rgb(1, 0.28, 0.58), 0.32),
  lit(rgb(0.085, 0.19, 0.22), rgb(0.22, 0.9, 1), 0.28),
  lit(rgb(0.12, 0.095, 0.195), rgb(0.5, 0.3, 0.9), 0.05),
  lit(rgb(0.075, 0.16, 0.18), rgb(0.2, 0.85, 0.95), 0.06),
  lit(rgb(0.19, 0.085, 0.16), rgb(0.95, 0.3, 0.6), 0.06),
  lit(rgb(0.025, 0.008, 0.015), rgb(1, 0.24, 0.6), 1.6),
  lit(rgb(0.008, 0.02, 0.022), rgb(0.28, 0.95, 1), 1.5)
]);

/**
 * Phase 4 Default Palette: Neon Sprawl
 * Dark metropolitan body with restrained district hue in the physical albedo — violet,
 * teal and magenta wall families over dark plum/teal roofs — plus NEON_A/B illumination.
 */
export const PRESET_NEON_SPRAWL = district("Neon Sprawl", [
  lit(rgb(0.150, 0.122, 0.185), rgb(0.32, 0.45, 0.55), 0.06),        // WALL_A: violet charcoal concrete
  lit(rgb(0.122, 0.150, 0.168), rgb(0.45, 0.38, 0.52), 0.05),        // WALL_B: teal graphite composite
  lit(rgb(0.135, 0.110, 0.165), rgb(0.28, 0.42, 0.50), 0.06),        // WALL_C: magenta anodized facade
  lit(rgb(0.112, 0.100, 0.140), rgb(0.25, 0.30, 0.38), 0.03),        // ROOF_A: dark violet roofing membrane
  lit(rgb(0.098, 0.118, 0.130), rgb(0.28, 0.32, 0.40), 0.03),        // ROOF_B: teal aggregate gravel deck
  lit(rgb(0.120, 0.104, 0.132), rgb(0.30, 0.35, 0.42), 0.04),        // ROOF_C: plum coated service roof
  lit(rgb(0.015, 0.008, 0.014), rgb(1.0, 0.18, 0.58), 1.65),         // NEON_A: electric hot magenta
  lit(rgb(0.008, 0.016, 0.018), rgb(0.18, 0.95, 0.92), 1.55)         // NEON_B: vivid cyan / mint
]);

export const PALETTE_PRESETS: DistrictPalette[] = [
  PRESET_NEON_SPRAWL,
  district("Corpo Chrome", [
    lit(rgb(0.118, 0.150, 0.180), rgb(0.48, 0.65, 0.92), 0.06),
    lit(rgb(0.134, 0.162, 0.188), rgb(0.65, 0.78, 0.95), 0.05),
    lit(rgb(0.104, 0.136, 0.168), rgb(0.35, 0.52, 0.85), 0.07),
    lit(rgb(0.096, 0.116, 0.138), rgb(0.32, 0.45, 0.65), 0.03),
    lit(rgb(0.106, 0.124, 0.146), rgb(0.40, 0.55, 0.75), 0.03),
    lit(rgb(0.116, 0.132, 0.152), rgb(0.45, 0.60, 0.80), 0.04),
    lit(rgb(0.012, 0.016, 0.022), rgb(0.45, 0.82, 1.0), 1.5),
    lit(rgb(0.018, 0.018, 0.016), rgb(0.96, 0.98, 1.0), 1.35)
  ]),
  district("Red Light", [
    lit(rgb(0.168, 0.100, 0.116), rgb(0.75, 0.25, 0.38), 0.06),
    lit(rgb(0.152, 0.092, 0.108), rgb(0.68, 0.22, 0.45), 0.05),
    lit(rgb(0.178, 0.108, 0.122), rgb(0.72, 0.35, 0.25), 0.06),
    lit(rgb(0.120, 0.084, 0.096), rgb(0.45, 0.20, 0.30), 0.03),
    lit(rgb(0.128, 0.090, 0.102), rgb(0.50, 0.25, 0.28), 0.03),
    lit(rgb(0.136, 0.096, 0.108), rgb(0.55, 0.28, 0.35), 0.04),
    lit(rgb(0.022, 0.008, 0.012), rgb(1.0, 0.15, 0.36), 1.7),
    lit(rgb(0.020, 0.012, 0.005), rgb(1.0, 0.52, 0.15), 1.55)
  ]),
  district("Industrial", [
    lit(rgb(0.136, 0.134, 0.096), rgb(0.75, 0.52, 0.25), 0.05),
    lit(rgb(0.138, 0.124, 0.090), rgb(0.68, 0.45, 0.22), 0.05),
    lit(rgb(0.150, 0.136, 0.102), rgb(0.42, 0.60, 0.35), 0.06),
    lit(rgb(0.148, 0.096, 0.070), rgb(0.45, 0.35, 0.22), 0.03),
    lit(rgb(0.128, 0.094, 0.076), rgb(0.50, 0.38, 0.25), 0.03),
    lit(rgb(0.132, 0.104, 0.084), rgb(0.48, 0.42, 0.28), 0.03),
    lit(rgb(0.022, 0.014, 0.005), rgb(1.0, 0.65, 0.20), 1.45),
    lit(rgb(0.010, 0.018, 0.014), rgb(0.45, 0.95, 0.65), 1.3)
  ]),
  district("Green Zone", [
    lit(rgb(0.104, 0.152, 0.122), rgb(0.30, 0.75, 0.52), 0.06),
    lit(rgb(0.112, 0.158, 0.132), rgb(0.28, 0.68, 0.65), 0.05),
    lit(rgb(0.098, 0.144, 0.116), rgb(0.45, 0.72, 0.38), 0.06),
    lit(rgb(0.092, 0.120, 0.100), rgb(0.28, 0.55, 0.40), 0.03),
    lit(rgb(0.100, 0.128, 0.106), rgb(0.32, 0.60, 0.45), 0.03),
    lit(rgb(0.108, 0.134, 0.112), rgb(0.36, 0.65, 0.48), 0.04),
    lit(rgb(0.008, 0.020, 0.012), rgb(0.30, 1.0, 0.55), 1.55),
    lit(rgb(0.008, 0.018, 0.022), rgb(0.25, 0.90, 0.92), 1.4)
  ]),
  district("Midnight", [
    lit(rgb(0.108, 0.116, 0.168), rgb(0.38, 0.48, 0.85), 0.06),
    lit(rgb(0.118, 0.112, 0.162), rgb(0.48, 0.42, 0.82), 0.05),
    lit(rgb(0.098, 0.122, 0.172), rgb(0.32, 0.55, 0.88), 0.06),
    lit(rgb(0.088, 0.096, 0.132), rgb(0.30, 0.38, 0.68), 0.03),
    lit(rgb(0.098, 0.102, 0.140), rgb(0.36, 0.42, 0.72), 0.03),
    lit(rgb(0.106, 0.110, 0.148), rgb(0.42, 0.48, 0.78), 0.04),
    lit(rgb(0.010, 0.010, 0.022), rgb(0.45, 0.55, 1.0), 1.5),
    lit(rgb(0.016, 0.016, 0.020), rgb(0.92, 0.95, 1.0), 1.25)
  ])
];

export const DEFAULT_DISTRICT_PALETTE = PRESET_NEON_SPRAWL;

// Built-in district palettes: restrained hue in the physical wall/roof albedo + rich
// primary/secondary illumination. Emissive strengths on wall/roof stay below 0.10 (peak
// < 0.55) to keep open spaces and facades bloom-free; the albedo hue does the colour work.
export const BUILTIN_PALETTES: Readonly<Record<string, DistrictPalette>> = Object.freeze({
  corporate: district("Corporate", [
    lit(rgb(0.118, 0.148, 0.172), rgb(0.45, 0.62, 0.88), 0.06),        // WALL_A: cold cyan steel
    lit(rgb(0.140, 0.166, 0.188), rgb(0.65, 0.78, 0.95), 0.05),        // WALL_B: brushed steel composite
    lit(rgb(0.104, 0.132, 0.156), rgb(0.32, 0.50, 0.78), 0.06),        // WALL_C: deep corporate blue
    lit(rgb(0.128, 0.116, 0.112), rgb(0.30, 0.42, 0.60), 0.03),        // ROOF_A: warm charcoal deck
    lit(rgb(0.138, 0.124, 0.118), rgb(0.38, 0.50, 0.68), 0.03),        // ROOF_B: warm aggregate slab
    lit(rgb(0.146, 0.132, 0.126), rgb(0.42, 0.55, 0.72), 0.04),        // ROOF_C: warm service roof
    lit(rgb(0.012, 0.016, 0.020), rgb(0.50, 0.82, 1.0), 1.5),
    lit(rgb(0.018, 0.018, 0.018), rgb(0.95, 0.98, 1.0), 1.25)
  ]),
  commercial: district("Commercial", [
    lit(rgb(0.108, 0.150, 0.168), rgb(0.20, 0.80, 0.85), 0.06),        // WALL_A: aqua storefront glass frame
    lit(rgb(0.122, 0.162, 0.178), rgb(0.32, 0.75, 0.92), 0.05),        // WALL_B: pale cyan facade
    lit(rgb(0.098, 0.136, 0.152), rgb(0.25, 0.68, 0.88), 0.06),        // WALL_C: deep teal panel
    lit(rgb(0.096, 0.112, 0.124), rgb(0.22, 0.55, 0.65), 0.03),        // ROOF_A: cool slate deck
    lit(rgb(0.106, 0.120, 0.132), rgb(0.28, 0.62, 0.72), 0.03),        // ROOF_B: slate aggregate
    lit(rgb(0.114, 0.128, 0.140), rgb(0.32, 0.68, 0.78), 0.04),        // ROOF_C: slate service roof
    lit(rgb(0.008, 0.018, 0.020), rgb(0.18, 0.95, 0.92), 1.6),
    lit(rgb(0.010, 0.018, 0.025), rgb(0.30, 0.82, 1.0), 1.45)
  ]),
  "mixed-use": district("Mixed Use", [
    lit(rgb(0.158, 0.134, 0.104), rgb(0.85, 0.62, 0.32), 0.06),        // WALL_A: warm amber brick
    lit(rgb(0.146, 0.124, 0.098), rgb(0.78, 0.52, 0.28), 0.05),        // WALL_B: tan plaster
    lit(rgb(0.168, 0.144, 0.112), rgb(0.80, 0.68, 0.38), 0.05),        // WALL_C: honey sandstone
    lit(rgb(0.115, 0.098, 0.078), rgb(0.52, 0.40, 0.25), 0.03),        // ROOF_A: dark brown deck
    lit(rgb(0.126, 0.108, 0.086), rgb(0.58, 0.45, 0.28), 0.03),        // ROOF_B: brown aggregate
    lit(rgb(0.136, 0.116, 0.094), rgb(0.62, 0.48, 0.32), 0.04),        // ROOF_C: chestnut service roof
    lit(rgb(0.020, 0.014, 0.005), rgb(1.0, 0.70, 0.22), 1.55),
    lit(rgb(0.008, 0.016, 0.018), rgb(0.25, 0.88, 0.95), 1.35)
  ]),
  "residential-mega": district("Residential Mega", [
    lit(rgb(0.100, 0.152, 0.118), rgb(0.35, 0.85, 0.60), 0.06),        // WALL_A: sage green tower
    lit(rgb(0.110, 0.156, 0.128), rgb(0.40, 0.78, 0.65), 0.05),        // WALL_B: pale mint slab
    lit(rgb(0.094, 0.142, 0.114), rgb(0.45, 0.82, 0.52), 0.06),        // WALL_C: deep green panel
    lit(rgb(0.128, 0.106, 0.080), rgb(0.30, 0.60, 0.45), 0.03),        // ROOF_A: warm amber deck
    lit(rgb(0.138, 0.114, 0.086), rgb(0.36, 0.65, 0.50), 0.03),        // ROOF_B: amber aggregate
    lit(rgb(0.146, 0.122, 0.094), rgb(0.42, 0.70, 0.55), 0.04),        // ROOF_C: honey service roof
    lit(rgb(0.008, 0.020, 0.012), rgb(0.35, 1.0, 0.58), 1.5),
    lit(rgb(0.020, 0.014, 0.008), rgb(1.0, 0.78, 0.40), 1.35)
  ]),
  "residential-dense": district("Residential Dense", [
    lit(rgb(0.170, 0.124, 0.098), rgb(0.85, 0.45, 0.28), 0.06),        // WALL_A: terracotta brick
    lit(rgb(0.158, 0.116, 0.094), rgb(0.80, 0.50, 0.32), 0.05),        // WALL_B: burnt sienna plaster
    lit(rgb(0.180, 0.132, 0.104), rgb(0.88, 0.55, 0.30), 0.05),        // WALL_C: copper panel
    lit(rgb(0.124, 0.098, 0.082), rgb(0.55, 0.32, 0.22), 0.03),        // ROOF_A: dark umber deck
    lit(rgb(0.132, 0.104, 0.088), rgb(0.60, 0.38, 0.25), 0.03),        // ROOF_B: umber aggregate
    lit(rgb(0.140, 0.110, 0.092), rgb(0.65, 0.42, 0.28), 0.04),        // ROOF_C: brown service roof
    lit(rgb(0.020, 0.010, 0.006), rgb(1.0, 0.45, 0.22), 1.55),
    lit(rgb(0.020, 0.008, 0.015), rgb(1.0, 0.25, 0.65), 1.4)
  ]),
  "residential-low": district("Residential Low", [
    lit(rgb(0.124, 0.158, 0.106), rgb(0.52, 0.78, 0.38), 0.05),        // WALL_A: pale garden green
    lit(rgb(0.116, 0.150, 0.100), rgb(0.58, 0.72, 0.42), 0.05),        // WALL_B: olive plaster
    lit(rgb(0.132, 0.164, 0.112), rgb(0.48, 0.80, 0.35), 0.05),        // WALL_C: bright moss panel
    lit(rgb(0.150, 0.128, 0.096), rgb(0.38, 0.58, 0.32), 0.03),        // ROOF_A: warm amber deck
    lit(rgb(0.158, 0.136, 0.102), rgb(0.42, 0.62, 0.35), 0.03),        // ROOF_B: amber aggregate
    lit(rgb(0.164, 0.142, 0.108), rgb(0.48, 0.68, 0.40), 0.04),        // ROOF_C: honey service roof
    lit(rgb(0.014, 0.018, 0.008), rgb(0.65, 0.98, 0.35), 1.4),
    lit(rgb(0.018, 0.016, 0.008), rgb(1.0, 0.85, 0.48), 1.25)
  ]),
  "night-market": district("Night Market", [
    lit(rgb(0.162, 0.096, 0.118), rgb(0.90, 0.22, 0.48), 0.06),        // WALL_A: burgundy market wall
    lit(rgb(0.150, 0.090, 0.108), rgb(0.85, 0.18, 0.32), 0.05),        // WALL_B: wine-dark stall front
    lit(rgb(0.172, 0.104, 0.124), rgb(0.88, 0.32, 0.55), 0.06),        // WALL_C: crimson panel
    lit(rgb(0.122, 0.086, 0.096), rgb(0.55, 0.20, 0.35), 0.03),        // ROOF_A: dark wine deck
    lit(rgb(0.130, 0.092, 0.102), rgb(0.60, 0.22, 0.38), 0.03),        // ROOF_B: wine aggregate
    lit(rgb(0.138, 0.098, 0.108), rgb(0.65, 0.26, 0.42), 0.04),        // ROOF_C: maroon service roof
    lit(rgb(0.024, 0.006, 0.012), rgb(1.0, 0.16, 0.45), 1.75),
    lit(rgb(0.018, 0.018, 0.005), rgb(0.95, 0.92, 0.18), 1.6)
  ]),
  entertainment: district("Entertainment", [
    lit(rgb(0.148, 0.102, 0.178), rgb(0.72, 0.35, 0.95), 0.06),        // WALL_A: plum theatre wall
    lit(rgb(0.136, 0.096, 0.164), rgb(0.60, 0.28, 0.88), 0.05),        // WALL_B: violet velvet panel
    lit(rgb(0.158, 0.110, 0.188), rgb(0.78, 0.42, 0.98), 0.05),        // WALL_C: deep purple marquee
    lit(rgb(0.112, 0.088, 0.130), rgb(0.48, 0.25, 0.65), 0.03),        // ROOF_A: dark mauve deck
    lit(rgb(0.120, 0.094, 0.136), rgb(0.52, 0.28, 0.70), 0.03),        // ROOF_B: mauve aggregate
    lit(rgb(0.126, 0.100, 0.142), rgb(0.58, 0.32, 0.75), 0.04),        // ROOF_C: plum service roof
    lit(rgb(0.018, 0.008, 0.026), rgb(0.85, 0.28, 1.0), 1.7),
    lit(rgb(0.008, 0.018, 0.026), rgb(0.22, 0.85, 1.0), 1.55)
  ]),
  "old-city": district("Old City", [
    lit(rgb(0.176, 0.148, 0.112), rgb(0.88, 0.68, 0.38), 0.05),        // WALL_A: warm sandstone
    lit(rgb(0.164, 0.138, 0.104), rgb(0.82, 0.60, 0.34), 0.05),        // WALL_B: ochre plaster
    lit(rgb(0.186, 0.156, 0.118), rgb(0.85, 0.72, 0.42), 0.05),        // WALL_C: pale sandstone
    lit(rgb(0.140, 0.112, 0.090), rgb(0.58, 0.45, 0.28), 0.03),        // ROOF_A: terracotta deck
    lit(rgb(0.150, 0.120, 0.096), rgb(0.62, 0.48, 0.30), 0.03),        // ROOF_B: terracotta aggregate
    lit(rgb(0.158, 0.128, 0.102), rgb(0.68, 0.52, 0.34), 0.04),        // ROOF_C: clay service roof
    lit(rgb(0.020, 0.014, 0.006), rgb(1.0, 0.72, 0.32), 1.45),
    lit(rgb(0.008, 0.018, 0.016), rgb(0.28, 0.92, 0.85), 1.3)
  ]),
  "industrial-heavy": district("Industrial Heavy", [
    lit(rgb(0.140, 0.136, 0.092), rgb(0.85, 0.52, 0.22), 0.05),        // WALL_A: soot olive
    lit(rgb(0.132, 0.128, 0.086), rgb(0.78, 0.42, 0.18), 0.05),        // WALL_B: greased olive panel
    lit(rgb(0.150, 0.144, 0.098), rgb(0.82, 0.58, 0.25), 0.05),        // WALL_C: dirty khaki
    lit(rgb(0.148, 0.096, 0.070), rgb(0.55, 0.35, 0.18), 0.03),        // ROOF_A: rust deck
    lit(rgb(0.138, 0.092, 0.068), rgb(0.60, 0.38, 0.20), 0.03),        // ROOF_B: rust aggregate
    lit(rgb(0.144, 0.100, 0.074), rgb(0.65, 0.42, 0.22), 0.03),        // ROOF_C: oxide service roof
    lit(rgb(0.020, 0.012, 0.004), rgb(1.0, 0.58, 0.15), 1.4),
    lit(rgb(0.020, 0.006, 0.004), rgb(1.0, 0.22, 0.12), 1.25)
  ]),
  "industrial-light": district("Industrial Light", [
    lit(rgb(0.114, 0.140, 0.166), rgb(0.48, 0.65, 0.82), 0.05),        // WALL_A: cold steel blue
    lit(rgb(0.126, 0.148, 0.172), rgb(0.42, 0.58, 0.75), 0.05),        // WALL_B: pale steel panel
    lit(rgb(0.104, 0.132, 0.158), rgb(0.55, 0.70, 0.88), 0.05),        // WALL_C: machine blue
    lit(rgb(0.104, 0.112, 0.128), rgb(0.35, 0.48, 0.62), 0.03),        // ROOF_A: slate deck
    lit(rgb(0.112, 0.120, 0.136), rgb(0.40, 0.52, 0.68), 0.03),        // ROOF_B: slate aggregate
    lit(rgb(0.120, 0.128, 0.142), rgb(0.45, 0.58, 0.72), 0.04),        // ROOF_C: slate service roof
    lit(rgb(0.010, 0.015, 0.020), rgb(0.45, 0.82, 1.0), 1.35),
    lit(rgb(0.018, 0.012, 0.005), rgb(1.0, 0.75, 0.25), 1.25)
  ]),
  "logistics-port": district("Logistics Port", [
    lit(rgb(0.152, 0.118, 0.092), rgb(0.82, 0.52, 0.22), 0.05),        // WALL_A: rust container
    lit(rgb(0.094, 0.144, 0.140), rgb(0.25, 0.78, 0.72), 0.06),        // WALL_B: sea-teal crane
    lit(rgb(0.138, 0.124, 0.106), rgb(0.75, 0.48, 0.25), 0.05),        // WALL_C: warm quay concrete
    lit(rgb(0.118, 0.098, 0.088), rgb(0.52, 0.38, 0.20), 0.03),        // ROOF_A: brown deck
    lit(rgb(0.104, 0.122, 0.120), rgb(0.22, 0.55, 0.52), 0.03),        // ROOF_B: teal aggregate
    lit(rgb(0.112, 0.108, 0.100), rgb(0.32, 0.60, 0.58), 0.04),        // ROOF_C: neutral service roof
    lit(rgb(0.020, 0.012, 0.004), rgb(1.0, 0.62, 0.18), 1.45),
    lit(rgb(0.008, 0.018, 0.018), rgb(0.20, 0.95, 0.88), 1.55)
  ]),
  waterfront: district("Waterfront", [
    lit(rgb(0.100, 0.138, 0.168), rgb(0.28, 0.72, 0.95), 0.06),        // WALL_A: sea-glass blue
    lit(rgb(0.108, 0.146, 0.160), rgb(0.22, 0.65, 0.88), 0.05),        // WALL_B: coastal teal
    lit(rgb(0.114, 0.152, 0.174), rgb(0.35, 0.78, 0.98), 0.05),        // WALL_C: bright harbour blue
    lit(rgb(0.088, 0.112, 0.136), rgb(0.22, 0.52, 0.68), 0.03),        // ROOF_A: deep blue-slate deck
    lit(rgb(0.098, 0.120, 0.142), rgb(0.28, 0.58, 0.75), 0.03),        // ROOF_B: blue-slate aggregate
    lit(rgb(0.106, 0.128, 0.148), rgb(0.32, 0.62, 0.80), 0.04),        // ROOF_C: blue-slate service roof
    lit(rgb(0.006, 0.016, 0.022), rgb(0.22, 0.90, 1.0), 1.6),
    lit(rgb(0.012, 0.018, 0.022), rgb(0.65, 0.88, 1.0), 1.4)
  ]),
  civic: district("Civic", [
    lit(rgb(0.190, 0.168, 0.142), rgb(0.85, 0.82, 0.72), 0.05),        // WALL_A: pale limestone
    lit(rgb(0.180, 0.158, 0.130), rgb(0.80, 0.78, 0.70), 0.05),        // WALL_B: warm mineral plaster
    lit(rgb(0.198, 0.176, 0.148), rgb(0.88, 0.85, 0.75), 0.04),        // WALL_C: bright travertine
    lit(rgb(0.142, 0.126, 0.108), rgb(0.60, 0.58, 0.52), 0.03),        // ROOF_A: pale stone deck
    lit(rgb(0.150, 0.134, 0.114), rgb(0.65, 0.62, 0.55), 0.03),        // ROOF_B: stone aggregate
    lit(rgb(0.158, 0.140, 0.120), rgb(0.70, 0.66, 0.58), 0.03),        // ROOF_C: mineral service roof
    lit(rgb(0.018, 0.018, 0.018), rgb(0.96, 0.98, 1.0), 1.35),
    lit(rgb(0.020, 0.006, 0.008), rgb(1.0, 0.18, 0.25), 1.25)
  ]),
  utility: district("Utility", [
    lit(rgb(0.152, 0.148, 0.094), rgb(0.72, 0.78, 0.22), 0.05),        // WALL_A: olive equipment bay
    lit(rgb(0.138, 0.140, 0.090), rgb(0.65, 0.72, 0.25), 0.05),        // WALL_B: drab olive panel
    lit(rgb(0.156, 0.152, 0.106), rgb(0.78, 0.82, 0.28), 0.05),        // WALL_C: service yellow-green
    lit(rgb(0.142, 0.114, 0.076), rgb(0.50, 0.52, 0.20), 0.03),        // ROOF_A: amber deck
    lit(rgb(0.144, 0.126, 0.092), rgb(0.55, 0.58, 0.22), 0.03),        // ROOF_B: amber aggregate
    lit(rgb(0.150, 0.132, 0.096), rgb(0.60, 0.62, 0.25), 0.04),        // ROOF_C: amber service roof
    lit(rgb(0.016, 0.016, 0.005), rgb(0.88, 0.95, 0.22), 1.4),
    lit(rgb(0.018, 0.012, 0.005), rgb(1.0, 0.65, 0.20), 1.3)
  ]),
  derelict: district("Derelict", [
    lit(rgb(0.156, 0.120, 0.096), rgb(0.72, 0.55, 0.38), 0.05),        // WALL_A: rust brick
    lit(rgb(0.142, 0.110, 0.090), rgb(0.65, 0.48, 0.32), 0.04),        // WALL_B: stained plaster
    lit(rgb(0.166, 0.128, 0.102), rgb(0.78, 0.58, 0.42), 0.05),        // WALL_C: oxidised panel
    lit(rgb(0.122, 0.098, 0.082), rgb(0.48, 0.38, 0.25), 0.03),        // ROOF_A: dark brown deck
    lit(rgb(0.130, 0.104, 0.088), rgb(0.52, 0.42, 0.28), 0.03),        // ROOF_B: brown aggregate
    lit(rgb(0.138, 0.110, 0.092), rgb(0.58, 0.45, 0.30), 0.03),        // ROOF_C: umber service roof
    lit(rgb(0.018, 0.012, 0.006), rgb(0.95, 0.58, 0.28), 1.25),
    lit(rgb(0.016, 0.008, 0.014), rgb(0.92, 0.35, 0.65), 1.15)
  ])
});

export function builtinPalette(paletteId: string): DistrictPalette {
  return BUILTIN_PALETTES[paletteId] ?? DEFAULT_DISTRICT_PALETTE;
}

export function presetByName(name: string): DistrictPalette | null {
  return PALETTE_PRESETS.find((p) => p.name === name) ?? null;
}

function sameMaterial(a: Material, b: Material): boolean {
  return (
    a.base.r === b.base.r &&
    a.base.g === b.base.g &&
    a.base.b === b.base.b &&
    a.emissive.r === b.emissive.r &&
    a.emissive.g === b.emissive.g &&
    a.emissive.b === b.emissive.b &&
    a.emissiveStrength === b.emissiveStrength
  );
}

function isMaterial(value: unknown): value is Material {
  if (!value || typeof value !== "object") return false;
  const material = value as Partial<Material>;
  const base = material.base;
  const emissive = material.emissive;
  return (
    !!base &&
    !!emissive &&
    Number.isFinite(base.r) &&
    Number.isFinite(base.g) &&
    Number.isFinite(base.b) &&
    Number.isFinite(emissive.r) &&
    Number.isFinite(emissive.g) &&
    Number.isFinite(emissive.b) &&
    Number.isFinite(material.emissiveStrength)
  );
}

function isLegacyNeonSprawl(palette: Partial<DistrictPalette> | null | undefined): boolean {
  return (
    palette?.name === LEGACY_NEON_SPRAWL.name &&
    palette.materials?.length === BANK_SIZE &&
    palette.materials.every((material, slot) =>
      isMaterial(material) && sameMaterial(material, LEGACY_NEON_SPRAWL.materials[slot]!)
    )
  );
}

/** Clones a palette, padding short banks from the default so a stored palette can grow. */
export function normalizePalette(palette: Partial<DistrictPalette> | null | undefined): DistrictPalette {
  const source = isLegacyNeonSprawl(palette)
    ? DEFAULT_DISTRICT_PALETTE.materials
    : (palette?.materials ?? []);
  const materials: Material[] = [];
  for (let slot = 0; slot < BANK_SIZE; slot++) {
    const candidate = source[slot];
    const m: Material = isMaterial(candidate)
      ? candidate
      : DEFAULT_DISTRICT_PALETTE.materials[slot]!;
    materials.push({
      base: { ...m.base },
      emissive: { ...m.emissive },
      emissiveStrength: m.emissiveStrength
    });
  }
  return { name: palette?.name ?? DEFAULT_DISTRICT_PALETTE.name, materials };
}
