export const PALETTE_SIZE = 64;
export const PALETTE_ROWS = 2;
/** Emissive strength is stored in a byte; this is the value 255 maps to. */
export const EMISSIVE_MAX = 4;

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

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const toByte = (v: number): number => Math.round(clamp01(v) * 255);

/**
 * Pack materials into an RGBA8 lookup texture: row 0 base colour, row 1 emissive
 * colour with strength in alpha.
 *
 * A texture rather than a uniform array because GLSL ES 1.00 only guarantees
 * dynamic indexing of uniform arrays in vertex shaders, and a texture also scales
 * past the uniform-vector limit without changing the shader.
 */
export function packPalette(materials: Material[]): Uint8Array {
  if (materials.length > PALETTE_SIZE) {
    throw new Error(`Palette holds ${PALETTE_SIZE} materials, got ${materials.length}.`);
  }

  const data = new Uint8Array(PALETTE_SIZE * PALETTE_ROWS * 4);
  materials.forEach((m, i) => {
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
  return data;
}

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });

export const MATERIAL = {
  ROOF_DARK: 0,
  WALL_VIOLET: 1,
  ROOF_WARM: 2,
  WALL_MAGENTA: 3,
  WALL_TEAL: 4,
  ROOF_ACCENT: 5
} as const;

export const DEFAULT_MATERIALS: Material[] = [
  { base: rgb(0.085, 0.075, 0.115), emissive: rgb(0, 0, 0), emissiveStrength: 0 },
  { base: rgb(0.165, 0.125, 0.235), emissive: rgb(0.58, 0.28, 0.78), emissiveStrength: 0.28 },
  { base: rgb(0.145, 0.105, 0.11), emissive: rgb(0, 0, 0), emissiveStrength: 0 },
  { base: rgb(0.205, 0.115, 0.175), emissive: rgb(1, 0.38, 0.56), emissiveStrength: 0.38 },
  { base: rgb(0.1, 0.16, 0.2), emissive: rgb(0.28, 0.86, 1), emissiveStrength: 0.3 },
  { base: rgb(0.19, 0.135, 0.1), emissive: rgb(1, 0.64, 0.32), emissiveStrength: 0.52 }
];
