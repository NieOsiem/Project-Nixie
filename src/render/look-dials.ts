import { WEATHER, type Weather } from "../constants.js";

/**
 * Live look dials for the post chain and the weather overlay.
 *
 * Plain mutable object of numbers, owned by `CityRenderer` and handed to both consumers, which
 * push it into their uniforms every frame. Numbers only: `setLookDials` validates by key and
 * rejects anything non-finite, so a vec2 dial would need its own path.
 *
 * Its own module rather than `bloom.ts` so the bloom chain does not own rain parameters.
 */
export interface LookDials {
  fogStrength: number;
  fogDensity: number;
  fogHeightM: number;
  fogInscatter: number;
  fogTintR: number;
  fogTintG: number;
  fogTintB: number;
  aoStrength: number;
  aoHeightM: number;
  streakStrength: number;
  wetStrength: number;
  puddleCoverage: number;
  puddleScaleM: number;
  wetDarken: number;
  wetGloss: number;
  smearStrength: number;
  smearHeightM: number;
  rainDrops: number;
  rainSpeedMPS: number;
  rainStreakDuty: number;
  rainDensity: number;
  mistBelowPx: number;
  dropsAbovePx: number;
  rainLit: number;
  splashStrength: number;
  splashSizeM: number;
  splashDensity: number;
  hazeStrength: number;
  hazeBandM: number;
  hazeDrift: number;
  hazeInscatter: number;
}

/**
 * The original post-chain, weather and wet-look values are user-tuned in Foundry. Grain lives in
 * FX Master's filter stack, not here.
 */
export const DEFAULT_LOOK_DIALS: LookDials = {
  fogStrength: 0.35,
  fogDensity: 3.2,
  fogHeightM: 36,
  fogInscatter: 32,
  fogTintR: 0.055,
  fogTintG: 0.045,
  fogTintB: 0.085,
  aoStrength: 0.45,
  aoHeightM: 18,
  streakStrength: 1.3,
  wetStrength: 0.7,
  puddleCoverage: 0.45,
  puddleScaleM: 4,
  wetDarken: 0.78,
  wetGloss: 0.6,
  smearStrength: 1,
  smearHeightM: 50,
  rainDrops: 0.55,
  // Stylised, not meteorological: a top-down camera projects almost none of a raindrop's 9 m/s
  // fall, so this apparent speed stands in for the fall we cannot see.
  rainSpeedMPS: 35,
  /**
   * Streak length as a fraction of the drop's own cell, which is what keeps the field
   * self-similar — see `RAIN_SPACING_M`. Sets the aspect ratio, here about 12.6:1. Raise toward
   * `DUTY_MAX` for longer streaks; at the cap drops merge into continuous lines.
   */
  rainStreakDuty: 0.35,
  /**
   * Multiplies the drop count by dividing the column pitch. This is the density knob —
   * `rainStrength` is amplitude, so raising that past 1 makes drops brighter, not more numerous.
   * Bounded only by `MIN_CELL_RATIO`, which stops a cell shrinking below the drop inside it.
   */
  rainDensity: 2,
  /** Drop width in screen px at or below which rain is pure mist. Raise to see mist sooner. */
  mistBelowPx: 0.05,
  /** Drop width in screen px at or above which rain is entirely discrete drops. */
  dropsAbovePx: 0.75,
  rainLit: 1.6,
  splashStrength: 0.2,
  splashSizeM: 0.35,
  splashDensity: 1,
  hazeStrength: 0.12,
  hazeBandM: 46,
  hazeDrift: 0.7,
  hazeInscatter: 0.35
};

/**
 * Weather presets. User-tuned in Foundry, 2026-08-01.
 *
 * A preset is only the handful of dials that actually differ between wet and wetter — every other
 * value, the whole post chain included, is identical across all three and stays in
 * `DEFAULT_LOOK_DIALS`. That is the point: the weather system is a small set of numbers per
 * preset, not a parallel copy of the dial set, so tuning a shared value does not have to be done
 * three times.
 *
 * `strength` multiplies `rainStrength`, so `CLEAR` hides the overlay outright and costs no fill
 * rather than drawing a field of zeroes. It still carries an explicit zero wetness dial because
 * the wet look is part of the always-drawn composite.
 */
export interface WeatherPreset {
  strength: number;
  dials: Partial<LookDials>;
}

export const WEATHER_PRESETS: Record<Weather, WeatherPreset> = {
  [WEATHER.CLEAR]: { strength: 0, dials: { wetStrength: 0 } },
  [WEATHER.DRIZZLE]: {
    strength: 1,
    dials: {
      wetStrength: 0.25,
      rainDrops: 0.45,
      rainSpeedMPS: 25,
      rainStreakDuty: 0.25,
      rainDensity: 0.5,
      splashDensity: 0.35
    }
  },
  [WEATHER.RAIN]: {
    strength: 1,
    dials: {
      wetStrength: 0.7,
      rainDrops: 0.55,
      rainSpeedMPS: 35,
      rainStreakDuty: 0.35,
      rainDensity: 2,
      splashDensity: 1
    }
  },
  [WEATHER.STORM]: {
    strength: 1,
    dials: {
      wetStrength: 1,
      rainDrops: 0.85,
      rainSpeedMPS: 65,
      rainStreakDuty: 0.35,
      rainDensity: 14,
      splashDensity: 3
    }
  }
};
