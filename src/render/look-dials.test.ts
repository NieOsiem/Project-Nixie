import { describe, expect, it } from "vitest";
import { WEATHER, type Weather } from "../constants.js";
import { DEFAULT_LOOK_DIALS, WEATHER_PRESETS, type LookDials } from "./look-dials.js";

const wet = (Object.keys(WEATHER_PRESETS) as Weather[]).filter(
  (name) => WEATHER_PRESETS[name].strength > 0
);

describe("weather presets", () => {
  it("covers every weather value, so the setting cannot select a missing preset", () => {
    for (const name of Object.values(WEATHER)) {
      expect(WEATHER_PRESETS[name]).toBeDefined();
    }
    expect(Object.keys(WEATHER_PRESETS)).toHaveLength(Object.values(WEATHER).length);
  });

  it("only ever names real dials", () => {
    for (const [name, preset] of Object.entries(WEATHER_PRESETS)) {
      for (const key of Object.keys(preset.dials)) {
        expect(DEFAULT_LOOK_DIALS, `${name} names a dial that does not exist`).toHaveProperty(key);
      }
    }
  });

  it("keeps smear controls shared with the wet look", () => {
    for (const [name, preset] of Object.entries(WEATHER_PRESETS)) {
      expect(preset.dials, `${name} owns smearStrength`).not.toHaveProperty("smearStrength");
      expect(preset.dials, `${name} owns smearHeightM`).not.toHaveProperty("smearHeightM");
    }
  });

  it("varies only the rain character, leaving the shared look alone", () => {
    const allowed = new Set([
      "wetStrength",
      "rainDrops",
      "rainSpeedMPS",
      "rainStreakDuty",
      "rainDensity",
      "splashDensity"
    ]);
    for (const [name, preset] of Object.entries(WEATHER_PRESETS)) {
      for (const key of Object.keys(preset.dials)) {
        expect(allowed, `${name} varies ${key}`).toContain(key);
      }
    }
  });

  it("clear is explicitly dry while drawing nothing at all", () => {
    expect(WEATHER_PRESETS[WEATHER.CLEAR].strength).toBe(0);
    expect(WEATHER_PRESETS[WEATHER.CLEAR].dials).toEqual({ wetStrength: 0 });
  });

  it("orders drizzle, rain and storm monotonically on every dial they vary", () => {
    const ladder: Weather[] = [WEATHER.DRIZZLE, WEATHER.RAIN, WEATHER.STORM];
    for (const key of [
      "wetStrength",
      "rainDrops",
      "rainSpeedMPS",
      "rainDensity",
      "splashDensity"
    ] as const) {
      const values = ladder.map((name) => WEATHER_PRESETS[name].dials[key as keyof LookDials]!);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `${key} is not monotonic`).toBeGreaterThan(values[i - 1]!);
      }
    }
  });

  it("gives every wet preset a full set of the dials it is responsible for", () => {
    const owned = new Set(Object.keys(WEATHER_PRESETS[WEATHER.RAIN].dials));
    for (const name of wet) {
      expect(new Set(Object.keys(WEATHER_PRESETS[name].dials)), name).toEqual(owned);
    }
  });

  it("defaults the dials to the Rain preset, the setting's own default", () => {
    for (const [key, value] of Object.entries(WEATHER_PRESETS[WEATHER.RAIN].dials)) {
      expect(DEFAULT_LOOK_DIALS[key as keyof LookDials]).toBe(value);
    }
  });

  it("keeps the smear defaults finite and positive where required", () => {
    expect(Number.isFinite(DEFAULT_LOOK_DIALS.smearStrength)).toBe(true);
    expect(DEFAULT_LOOK_DIALS.smearStrength).toBe(1);
    expect(Number.isFinite(DEFAULT_LOOK_DIALS.smearHeightM)).toBe(true);
    expect(DEFAULT_LOOK_DIALS.smearHeightM).toBe(50);
  });
});
