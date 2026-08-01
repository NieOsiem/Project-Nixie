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

  it("varies only the rain character, leaving the shared look alone", () => {
    // The point of a preset being four numbers: fog, AO, streak, tint, haze and splash *size* are
    // identical across all three, so tuning a shared value is not a three-way edit. If a preset
    // starts carrying post-chain dials, applyWeather's markContentDirty becomes load-bearing.
    const allowed = new Set([
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

  it("clear draws nothing at all rather than a field of zeroes", () => {
    // strength 0 multiplies rainStrength, and the renderer hides the quad at or below 0 — so a dry
    // night costs no fill. Carrying zeroed dials instead would still pay for the whole pass.
    expect(WEATHER_PRESETS[WEATHER.CLEAR].strength).toBe(0);
    expect(WEATHER_PRESETS[WEATHER.CLEAR].dials).toEqual({});
  });

  it("orders drizzle, rain and storm monotonically on every dial they vary", () => {
    // Not decoration: these are the three the user tuned by eye, and a preset that went backwards
    // on one dial would read as the wrong weather while looking deliberate.
    const ladder: Weather[] = [WEATHER.DRIZZLE, WEATHER.RAIN, WEATHER.STORM];
    for (const key of ["rainDrops", "rainSpeedMPS", "rainDensity", "splashDensity"] as const) {
      const values = ladder.map((name) => WEATHER_PRESETS[name].dials[key as keyof LookDials]!);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!, `${key} is not monotonic`).toBeGreaterThan(values[i - 1]!);
      }
    }
  });

  it("gives every wet preset a full set of the dials it is responsible for", () => {
    // A preset that omits one silently inherits whatever the previous preset left behind, which
    // makes the selector order-dependent.
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
});
