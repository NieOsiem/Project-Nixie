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
 * Shared surfaces. Emissive strengths here stay low: these cover most of the ground plane,
 * and anything above the bloom threshold over that much area washes the whole scene out.
 *
 * WHY these look small: the shader multiplies strength by EMISSIVE_MAX, so the value that has
 * to clear the 0.55 luma bloom threshold is `strength * 4`, not `strength`. Anything here above
 * ~0.13 glows. KERB sat at 0.95 and drew a lit cyan outline along every street.
 */
export const CITY_SURFACES: Material[] = [
  dark(0.1, 0.078, 0.155),
  lit(rgb(0.085, 0.07, 0.135), rgb(0.42, 0.26, 0.72), 0.09),
  lit(rgb(0.165, 0.14, 0.215), rgb(1, 0.7, 0.52), 0.06),
  lit(rgb(0.18, 0.15, 0.23), rgb(0.62, 0.46, 0.9), 0.08),
  lit(rgb(0.21, 0.19, 0.28), rgb(0.55, 0.68, 1), 0.09),
  lit(rgb(0.12, 0.115, 0.165), rgb(0.25, 0.95, 0.88), 0.06),
  dark(0.025, 0.045, 0.11),
  lit(rgb(0.13, 0.11, 0.2), rgb(0.32, 0.75, 0.95), 0.07)
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
 * Warm-shifted and lifted from the S1-S5 palette.
 *
 * WHY nothing here is near-black, least of all the roofs: the first Foundry look came back
 * reading as brown boxes on a black grid. Roofs are the largest visible area zoomed out, so
 * a dark base plus a warm emissive averaged out to mud. Every roof now carries a saturated
 * hue of its own, and the shared road sits at a visible violet rather than 0.04 grey.
 */
export const PRESET_NEON_SPRAWL = district("Neon Sprawl", [
  lit(rgb(0.17, 0.105, 0.3), rgb(0.18, 1, 0.78), 0.34),
  lit(rgb(0.22, 0.085, 0.19), rgb(1, 0.2, 0.62), 0.36),
  lit(rgb(0.095, 0.145, 0.25), rgb(0.18, 0.78, 1), 0.34),
  lit(rgb(0.14, 0.09, 0.24), rgb(0.48, 0.3, 0.95), 0.05),
  lit(rgb(0.07, 0.18, 0.19), rgb(0.18, 0.92, 0.88), 0.06),
  lit(rgb(0.19, 0.075, 0.17), rgb(1, 0.24, 0.62), 0.06),
  lit(rgb(0.025, 0.008, 0.015), rgb(1, 0.18, 0.58), 1.65),
  lit(rgb(0.008, 0.02, 0.022), rgb(0.18, 1, 0.82), 1.55)
]);

export const PALETTE_PRESETS: DistrictPalette[] = [
  PRESET_NEON_SPRAWL,
  district("Corpo Chrome", [
    lit(rgb(0.14, 0.16, 0.2), rgb(0.55, 0.75, 1), 0.22),
    lit(rgb(0.175, 0.19, 0.215), rgb(0.85, 0.92, 1), 0.26),
    lit(rgb(0.105, 0.14, 0.185), rgb(0.3, 0.6, 1), 0.28),
    lit(rgb(0.1, 0.115, 0.15), rgb(0.45, 0.65, 1), 0.05),
    lit(rgb(0.125, 0.145, 0.175), rgb(0.6, 0.8, 1), 0.05),
    lit(rgb(0.15, 0.165, 0.185), rgb(0.7, 0.85, 1), 0.08),
    lit(rgb(0.015, 0.018, 0.02), rgb(0.6, 0.85, 1), 1.4),
    lit(rgb(0.018, 0.018, 0.018), rgb(1, 1, 1), 1.25)
  ]),
  district("Red Light", [
    lit(rgb(0.245, 0.09, 0.13), rgb(1, 0.22, 0.36), 0.3),
    lit(rgb(0.215, 0.08, 0.16), rgb(1, 0.3, 0.7), 0.32),
    lit(rgb(0.2, 0.11, 0.085), rgb(1, 0.5, 0.2), 0.28),
    lit(rgb(0.15, 0.07, 0.095), rgb(0.9, 0.25, 0.45), 0.05),
    lit(rgb(0.18, 0.09, 0.085), rgb(1, 0.4, 0.3), 0.06),
    lit(rgb(0.165, 0.075, 0.115), rgb(1, 0.35, 0.55), 0.08),
    lit(rgb(0.025, 0.008, 0.012), rgb(1, 0.18, 0.42), 1.7),
    lit(rgb(0.022, 0.012, 0.005), rgb(1, 0.55, 0.15), 1.55)
  ]),
  district("Industrial", [
    lit(rgb(0.175, 0.145, 0.105), rgb(1, 0.7, 0.3), 0.16),
    lit(rgb(0.15, 0.12, 0.1), rgb(0.9, 0.55, 0.25), 0.14),
    lit(rgb(0.125, 0.145, 0.115), rgb(0.5, 0.8, 0.4), 0.16),
    lit(rgb(0.125, 0.105, 0.085), rgb(0.9, 0.6, 0.3), 0.04),
    lit(rgb(0.145, 0.125, 0.095), rgb(1, 0.65, 0.3), 0.05),
    lit(rgb(0.135, 0.135, 0.1), rgb(0.7, 0.8, 0.35), 0.06),
    lit(rgb(0.022, 0.014, 0.005), rgb(1, 0.66, 0.2), 1.3),
    lit(rgb(0.012, 0.02, 0.01), rgb(0.55, 1, 0.45), 1.2)
  ]),
  district("Green Zone", [
    lit(rgb(0.095, 0.175, 0.145), rgb(0.35, 1, 0.6), 0.26),
    lit(rgb(0.105, 0.165, 0.18), rgb(0.3, 0.9, 0.85), 0.24),
    lit(rgb(0.135, 0.18, 0.115), rgb(0.6, 1, 0.4), 0.22),
    lit(rgb(0.08, 0.13, 0.115), rgb(0.35, 0.95, 0.6), 0.05),
    lit(rgb(0.095, 0.15, 0.12), rgb(0.4, 1, 0.55), 0.06),
    lit(rgb(0.11, 0.155, 0.14), rgb(0.5, 0.95, 0.7), 0.07),
    lit(rgb(0.01, 0.022, 0.014), rgb(0.4, 1, 0.55), 1.45),
    lit(rgb(0.012, 0.02, 0.022), rgb(0.35, 0.95, 0.9), 1.35)
  ]),
  district("Midnight", [
    lit(rgb(0.095, 0.1, 0.16), rgb(0.4, 0.5, 1), 0.16),
    lit(rgb(0.11, 0.1, 0.17), rgb(0.55, 0.45, 1), 0.18),
    lit(rgb(0.085, 0.115, 0.165), rgb(0.35, 0.65, 1), 0.17),
    lit(rgb(0.075, 0.08, 0.13), rgb(0.35, 0.45, 1), 0.05),
    lit(rgb(0.09, 0.09, 0.145), rgb(0.5, 0.5, 1), 0.05),
    lit(rgb(0.105, 0.1, 0.15), rgb(0.9, 0.85, 1), 0.06),
    lit(rgb(0.012, 0.012, 0.024), rgb(0.55, 0.6, 1), 1.35),
    lit(rgb(0.018, 0.018, 0.02), rgb(0.95, 0.95, 1), 1.15)
  ])
];

export const DEFAULT_DISTRICT_PALETTE = PRESET_NEON_SPRAWL;

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
