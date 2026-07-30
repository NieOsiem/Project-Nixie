import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATERIALS,
  EMISSIVE_MAX,
  PALETTE_ROWS,
  PALETTE_SIZE,
  packPalette,
  type Material
} from "./palette.js";

const mat = (over: Partial<Material> = {}): Material => ({
  base: { r: 1, g: 0.5, b: 0 },
  emissive: { r: 0, g: 1, b: 0.25 },
  emissiveStrength: 2,
  ...over
});

describe("packPalette", () => {
  it("always fills the full texture regardless of material count", () => {
    expect(packPalette([]).length).toBe(PALETTE_SIZE * PALETTE_ROWS * 4);
    expect(packPalette([mat()]).length).toBe(PALETTE_SIZE * PALETTE_ROWS * 4);
  });

  it("writes base colour to row 0 with opaque alpha", () => {
    const d = packPalette([mat()]);
    expect([d[0], d[1], d[2], d[3]]).toEqual([255, 128, 0, 255]);
  });

  it("writes emissive colour and strength to row 1", () => {
    const d = packPalette([mat()]);
    const at = PALETTE_SIZE * 4;
    expect([d[at], d[at + 1], d[at + 2]]).toEqual([0, 255, 64]);
    expect(d[at + 3]).toBe(Math.round((2 / EMISSIVE_MAX) * 255));
  });

  it("indexes materials by column", () => {
    const d = packPalette([mat(), mat({ base: { r: 0, g: 0, b: 1 } })]);
    expect([d[4], d[5], d[6]]).toEqual([0, 0, 255]);
  });

  it("clamps out-of-range channels", () => {
    const d = packPalette([mat({ base: { r: 4, g: -1, b: 0.5 }, emissiveStrength: 99 })]);
    expect([d[0], d[1], d[2]]).toEqual([255, 0, 128]);
    expect(d[PALETTE_SIZE * 4 + 3]).toBe(255);
  });

  it("leaves unused slots zeroed", () => {
    const d = packPalette([mat()]);
    expect(d[4]).toBe(0);
    expect(d[7]).toBe(0);
  });

  it("rejects an oversized palette", () => {
    const many = Array.from({ length: PALETTE_SIZE + 1 }, () => mat());
    expect(() => packPalette(many)).toThrow(/64/);
  });
});

describe("DEFAULT_MATERIALS", () => {
  it("fits the palette and packs cleanly", () => {
    expect(DEFAULT_MATERIALS.length).toBeLessThanOrEqual(PALETTE_SIZE);
    expect(() => packPalette(DEFAULT_MATERIALS)).not.toThrow();
  });

  it("keeps every channel within range", () => {
    for (const m of DEFAULT_MATERIALS) {
      for (const c of [m.base.r, m.base.g, m.base.b, m.emissive.r, m.emissive.g, m.emissive.b]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      expect(m.emissiveStrength).toBeGreaterThanOrEqual(0);
      expect(m.emissiveStrength).toBeLessThanOrEqual(EMISSIVE_MAX);
    }
  });
});
