import type { Rect } from "../core/geom/types.js";
import { DEFAULT_LOOK_DIALS, type LookDials } from "./look-dials.js";
import { ScreenQuad } from "./screen-quad.js";
import {
  FALL_WRAP_M,
  HASH_CYCLE,
  SPLASH_RATE,
  WEATHER_FRAG,
  WIND_DIR
} from "./shaders/weather.js";

/**
 * There is no clock uniform. Every animated term is an accumulated *distance* or *phase*, wrapped
 * where its own pattern repeats: `FALL_WRAP_M` for the drops, `HASH_CYCLE` for the splash phase,
 * and the haze drift never wraps at all. Integrating rather than multiplying a rate by a clock is
 * what lets a rate be a live dial without the field jumping when the dial moves.
 */

/** WHY: a backgrounded tab hands back one enormous step on return, which teleports the rain. */
const MAX_STEP_S = 0.25;

/**
 * The animated weather quad: rain, splashes and drifting haze over the presented city.
 *
 * Split into two update paths on purpose. Everything camera-dependent rides in `setFrame`, called
 * from the city update that is frame-cached, because none of it animates. Only the clock, the haze
 * drift and the dials go through `advance`, which runs every frame whether the city redrew or not.
 */
export class WeatherOverlay {
  readonly display: any;

  #quad: ScreenQuad;
  /**
   * Splash strike phase, in strikes. Wrapped at `HASH_CYCLE`, which leaves both `floor` (the strike
   * index driving the site hash) and `fract` (the ring's life) untouched across a wrap.
   */
  #splashPhase = 0;
  /**
   * Drift accumulator, kept in doubles and copied into the uniform.
   *
   * WHY not accumulate in the Float32Array: the offset grows without bound, and once it is large
   * a float32 swallows a per-frame increment this small outright — a slow `hazeDrift` would stop
   * moving after an hour instead of getting imprecise.
   */
  #driftX = 0;
  #driftY = 0;
/**
   * How far the drop lattice has travelled, **metres**. The lattice is world-space, so this needs
   * no zoom term at all — zoom magnifies the motion for free, the way it magnifies the city.
   * Integrated rather than derived from the clock so that changing `rainSpeedMPS` mid-session
   * moves the rain from where it is instead of teleporting it.
   */
  #fallM = 0;
  #hazeOffsetM = new Float32Array(2);
  #worldOriginM = new Float32Array(2);
  #worldSizeM = new Float32Array(2);

  /**
   * `pivotUv` and `uvScale` are the renderer's own arrays, shared rather than copied. The scene
   * target, the silhouette and the composite output are allocated at one capacity and resized
   * together, so a single uv scale answers for all of them — the same assumption the occlusion
   * overlay already makes for its two samplers.
   */
  constructor(pivotUv: Float32Array, uvScale: Float32Array) {
    this.#quad = new ScreenQuad(WEATHER_FRAG, {
      uCity: PIXI.Texture.EMPTY,
      uHeight: PIXI.Texture.EMPTY,
      uUvScale: uvScale,
      uPivotUv: pivotUv,
      uWorldOriginM: this.#worldOriginM,
      uWorldSizeM: this.#worldSizeM,
      uHazeOffsetM: this.#hazeOffsetM,
      uPxPerMetre: 1,
      uRadialSmear: 0,
      uSplashPhase: 0,
      uFallM: 0,
      uRainStrength: 0,
      uRainDrops: DEFAULT_LOOK_DIALS.rainDrops,
      uRainStreakDuty: DEFAULT_LOOK_DIALS.rainStreakDuty,
      uRainDensity: DEFAULT_LOOK_DIALS.rainDensity,
      uMistBelowPx: DEFAULT_LOOK_DIALS.mistBelowPx,
      uDropsAbovePx: DEFAULT_LOOK_DIALS.dropsAbovePx,
      uRainLit: DEFAULT_LOOK_DIALS.rainLit,
      uSplashStrength: DEFAULT_LOOK_DIALS.splashStrength,
      uSplashSizeM: DEFAULT_LOOK_DIALS.splashSizeM,
      uHazeStrength: DEFAULT_LOOK_DIALS.hazeStrength,
      uHazeBandM: DEFAULT_LOOK_DIALS.hazeBandM,
      uHazeInscatter: DEFAULT_LOOK_DIALS.hazeInscatter,
      uFogTintR: DEFAULT_LOOK_DIALS.fogTintR,
      uFogTintG: DEFAULT_LOOK_DIALS.fogTintG,
      uFogTintB: DEFAULT_LOOK_DIALS.fogTintB
    });
    // Unlike the post chain this lands on top of foreign content, so it must blend.
    this.#quad.display.state.blend = true;
    this.#quad.display.visible = false;
    this.#quad.display.eventMode = "none";
    this.display = this.#quad.display;
  }

  get uniforms(): Record<string, unknown> {
    return this.#quad.uniforms;
  }

  /** Camera and texture state. Cheap enough to redo whenever the city frame does. */
  setFrame(
    city: any,
    height: any,
    view: Rect,
    pixelsPerMetre: number,
    zoom: number,
    radialSmear: number
  ): void {
    const uniforms = this.#quad.uniforms;
    uniforms.uCity = city;
    uniforms.uHeight = height;
    uniforms.uPxPerMetre = pixelsPerMetre * zoom;
    uniforms.uRadialSmear = radialSmear;
    this.#worldOriginM[0] = view.x / pixelsPerMetre;
    this.#worldOriginM[1] = view.y / pixelsPerMetre;
    this.#worldSizeM[0] = view.width / pixelsPerMetre;
    this.#worldSizeM[1] = view.height / pixelsPerMetre;
    this.display.position.set(view.x, view.y);
    this.display.scale.set(view.width, view.height);
  }

  /** One frame of animation. Safe before any city frame exists — the quad is hidden until then. */
  advance(dtSeconds: number, dials: LookDials, rainStrength: number): void {
    const dt = Math.min(Math.max(dtSeconds, 0), MAX_STEP_S);
    // Density is a rate multiplier on the strikes, not a change to the lattice pitch.
    this.#splashPhase =
      (this.#splashPhase + SPLASH_RATE * Math.max(0, dials.splashDensity) * dt) % HASH_CYCLE;
    // WHY: the haze drifts on an accumulated offset, not on the clock. Value noise is not
    // periodic, so a drift derived from a wrapping clock repatterns the whole veil in one frame.
    const step = dials.hazeDrift * dt;
    this.#driftX += WIND_DIR[0] * step;
    this.#driftY += WIND_DIR[1] * step;
    this.#hazeOffsetM[0] = this.#driftX;
    this.#hazeOffsetM[1] = this.#driftY;

    this.#fallM = (this.#fallM + dials.rainSpeedMPS * dt) % FALL_WRAP_M;

    const uniforms = this.#quad.uniforms;
    uniforms.uSplashPhase = this.#splashPhase;
    uniforms.uFallM = this.#fallM;
    uniforms.uRainStrength = rainStrength;
    uniforms.uRainDrops = dials.rainDrops;
    uniforms.uRainStreakDuty = dials.rainStreakDuty;
    uniforms.uRainDensity = dials.rainDensity;
    uniforms.uMistBelowPx = dials.mistBelowPx;
    uniforms.uDropsAbovePx = dials.dropsAbovePx;
    uniforms.uRainLit = dials.rainLit;
    uniforms.uSplashStrength = dials.splashStrength;
    uniforms.uSplashSizeM = dials.splashSizeM;
    uniforms.uHazeStrength = dials.hazeStrength;
    uniforms.uHazeBandM = dials.hazeBandM;
    uniforms.uHazeInscatter = dials.hazeInscatter;
    // Shared with the composite's fog: same air, so a mismatched tint would read as two hazes.
    uniforms.uFogTintR = dials.fogTintR;
    uniforms.uFogTintG = dials.fogTintG;
    uniforms.uFogTintB = dials.fogTintB;
  }

  clear(): void {
    this.#quad.uniforms.uCity = PIXI.Texture.EMPTY;
    this.#quad.uniforms.uHeight = PIXI.Texture.EMPTY;
    this.display.visible = false;
  }

  destroy(): void {
    this.#quad.destroy();
  }
}
