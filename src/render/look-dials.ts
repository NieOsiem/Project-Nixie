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
  rainDrops: number;
  rainSpeedMPS: number;
  rainStreakDuty: number;
  rainLit: number;
  splashStrength: number;
  splashSizeM: number;
  hazeStrength: number;
  hazeBandM: number;
  hazeDrift: number;
  hazeInscatter: number;
}

/**
 * Post-chain values are user-tuned in Foundry (2026-07-31), not guesses. Grain lives in FX
 * Master's filter stack, not here. The weather block is a starting point, not yet tuned.
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
  rainDrops: 1.85,
  // Stylised, not meteorological: a top-down camera projects almost none of a raindrop's 9 m/s
  // fall, so this apparent speed stands in for the fall we cannot see.
  rainSpeedMPS: 55,
  /**
   * Streak length as a fraction of the drop's own cell, which is what keeps the field
   * self-similar — see `RAIN_SPACING_M`. Sets the aspect ratio, here about 12.6:1. Raise toward
   * `DUTY_MAX` for longer streaks; at the cap drops merge into continuous lines.
   */
  rainStreakDuty: 0.35,
  rainLit: 1.6,
  splashStrength: 0.2,
  splashSizeM: 0.35,
  hazeStrength: 0.12,
  hazeBandM: 46,
  hazeDrift: 0.7,
  hazeInscatter: 0.35
};
