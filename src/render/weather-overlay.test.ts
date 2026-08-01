import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOK_DIALS, type LookDials } from "./look-dials.js";
import { HASH_CYCLE, SPLASH_RATE } from "./shaders/weather.js";
import { WeatherOverlay } from "./weather-overlay.js";

class StubGeometry {
  addAttribute(): this {
    return this;
  }
  addIndex(): this {
    return this;
  }
  destroy(): void {}
}

class StubMesh {
  state: Record<string, unknown> = {};
  visible = true;
  eventMode = "auto";
  position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
  scale = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
  constructor(
    _geometry: unknown,
    public shader: { uniforms: Record<string, unknown> }
  ) {}
  destroy(): void {}
}

const EMPTY = { empty: true };

beforeEach(() => {
  (globalThis as { PIXI?: unknown }).PIXI = {
    Geometry: StubGeometry,
    Mesh: StubMesh,
    Shader: { from: (_v: string, _f: string, uniforms: Record<string, unknown>) => ({ uniforms }) },
    Texture: { EMPTY }
  };
});

afterEach(() => {
  delete (globalThis as { PIXI?: unknown }).PIXI;
});

const dials = (over: Partial<LookDials> = {}): LookDials => ({
  ...DEFAULT_LOOK_DIALS,
  ...over
});

const overlay = (): WeatherOverlay =>
  new WeatherOverlay(new Float32Array([0.5, 0.5]), new Float32Array([1, 1]));

describe("splash strike phase", () => {
  it("advances at the density-scaled rate, with no clock uniform anywhere", () => {
    // Density is a rate multiplier on the strikes. The pitch stays put, so pavement coverage is
    // identical at every density — coarsening the pitch instead would leave pavements dry.
    const weather = overlay();
    weather.advance(0.2, dials({ splashDensity: 2 }), 1);
    expect(weather.uniforms.uSplashPhase as number).toBeCloseTo(SPLASH_RATE * 2 * 0.2, 6);
    expect(weather.uniforms).not.toHaveProperty("uTime");
    weather.destroy();
  });

  it("wraps at EXACTLY HASH_CYCLE, which leaves strike index and ring life untouched", () => {
    // The shader takes floor(phase) as the strike index modulo HASH_CYCLE, and fract(phase) as the
    // ring's life. Only a wrap at an exact multiple of HASH_CYCLE leaves both alone — so this has
    // to pin where the wrap happens, not merely that one happens. Any earlier wrap jumps every
    // splash site in one frame, and that seamlessness is what lets the rate be a dial at all.
    const weather = overlay();
    const step = 0.02;
    let highest = 0;
    for (let i = 0; i < 24000; i++) {
      weather.advance(step, dials({ splashDensity: 1 }), 1);
      highest = Math.max(highest, weather.uniforms.uSplashPhase as number);
    }
    expect(highest).toBeLessThan(HASH_CYCLE);
    // Steps are SPLASH_RATE * step apart, so the top sample must land within one of the wrap.
    expect(highest).toBeGreaterThan(HASH_CYCLE - 2 * SPLASH_RATE * step);
    weather.destroy();
  });

  it("treats a negative density as a stop, never as running backwards", () => {
    const weather = overlay();
    weather.advance(0.2, dials({ splashDensity: -5 }), 1);
    expect(weather.uniforms.uSplashPhase as number).toBe(0);
    weather.destroy();
  });

  it("clamps one enormous step, so a backgrounded tab does not teleport the rain", () => {
    const weather = overlay();
    weather.advance(600, dials({ rainSpeedMPS: 10, splashDensity: 1 }), 1);
    expect(weather.uniforms.uFallM as number).toBeLessThanOrEqual(10 * 0.25);
    weather.destroy();
  });

  it("ignores a negative step", () => {
    const weather = overlay();
    weather.advance(0.5, dials(), 1);
    const before = weather.uniforms.uSplashPhase as number;
    weather.advance(-10, dials(), 1);
    expect(weather.uniforms.uSplashPhase as number).toBe(before);
    weather.destroy();
  });
});

describe("haze drift", () => {
  it("accumulates along the wind", () => {
    const weather = overlay();
    for (let i = 0; i < 10; i++) weather.advance(0.1, dials({ hazeDrift: 2 }), 1);
    const offset = weather.uniforms.uHazeOffsetM as Float32Array;
    expect(offset[0]).toBeGreaterThan(0);
    expect(offset[1]).toBeGreaterThan(0);
    // Unit wind, so one second of drift at 2 m/s moves 2 m.
    expect(Math.hypot(offset[0]!, offset[1]!)).toBeCloseTo(2, 3);
    weather.destroy();
  });

  it("never wraps, unlike every other accumulator here", () => {
    // WHY: value noise is not periodic in space, so there is no offset that leaves the veil
    // unchanged. It grows without bound instead, which float32 carries fine for decades.
    const weather = overlay();
    for (let i = 0; i < 200; i++) weather.advance(0.25, dials({ hazeDrift: 3 }), 1);
    const far = (weather.uniforms.uHazeOffsetM as Float32Array)[0]!;
    expect(far).toBeGreaterThan(100);
    weather.advance(0.2, dials({ hazeDrift: 3 }), 1);
    expect((weather.uniforms.uHazeOffsetM as Float32Array)[0]!).toBeGreaterThan(far);
    weather.destroy();
  });
});

describe("drop fall", () => {
  it("integrates a world speed in metres, with no zoom term at all", () => {
    // The lattice is world-space, so zoom magnifies the motion for free. A screen-space speed was
    // what made the rain feel slower zoomed in than out — a fixed px/s is a smaller fraction of a
    // magnified scene. Step stays under MAX_STEP_S or the backgrounded-tab clamp truncates it.
    const weather = overlay();
    weather.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 4, 0);
    weather.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);
    expect(weather.uniforms.uFallM as number).toBeCloseTo(2, 6);
    weather.destroy();
  });

  it("advances identically whatever the zoom, the magnification doing the rest", () => {
    const near = overlay();
    near.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 4, 0);
    near.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);

    const far = overlay();
    far.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 0.25, 0);
    far.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);

    expect(near.uniforms.uFallM as number).toBe(far.uniforms.uFallM as number);
    near.destroy();
    far.destroy();
  });

  it("keeps the phase continuous when the speed dial changes under it", () => {
    // Integrating rather than multiplying a rate by the clock is what stops the field teleporting
    // when the dial moves mid-session.
    const weather = overlay();
    weather.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);
    const before = weather.uniforms.uFallM as number;
    weather.advance(0, dials({ rainSpeedMPS: 90 }), 1);
    expect(weather.uniforms.uFallM as number).toBe(before);
    weather.destroy();
  });

  it("passes streak duty straight through, the shape being cell-relative", () => {
    const weather = overlay();
    weather.advance(0.016, dials({ rainStreakDuty: 0.42 }), 1);
    expect(weather.uniforms.uRainStreakDuty as number).toBe(0.42);
    weather.destroy();
  });
});

describe("weather uniforms", () => {
  it("pushes every dial it owns, plus the fog tint it shares with the composite", () => {
    const weather = overlay();
    weather.advance(
      0.016,
      dials({
        rainDrops: 0.3,
        rainSpeedMPS: 12,
        rainStreakDuty: 0.5,
        rainDensity: 3,
        mistBelowPx: 2,
        dropsAbovePx: 9,
        rainLit: 2.5,
        splashStrength: 0.7,
        splashSizeM: 0.8,
        splashDensity: 2,
        hazeStrength: 0.2,
        hazeBandM: 60,
        hazeInscatter: 0.9,
        fogTintR: 0.1,
        fogTintG: 0.2,
        fogTintB: 0.3
      }),
      1.4
    );
    expect(weather.uniforms).toMatchObject({
      uRainStrength: 1.4,
      uRainDrops: 0.3,
      uRainLit: 2.5,
      uRainDensity: 3,
      uMistBelowPx: 2,
      uDropsAbovePx: 9,
      uSplashStrength: 0.7,
      uSplashSizeM: 0.8,
      uHazeStrength: 0.2,
      uHazeBandM: 60,
      uHazeInscatter: 0.9,
      uFogTintR: 0.1,
      uFogTintG: 0.2,
      uFogTintB: 0.3
    });
    weather.destroy();
  });

  it("converts the view rect to metres and the lattice scale to screen pixels", () => {
    const weather = overlay();
    weather.setFrame(
      { city: true },
      { height: true },
      { x: 800, y: 400, width: 3440, height: 1440 },
      8,
      1.5,
      0.004
    );
    expect(Array.from(weather.uniforms.uWorldOriginM as Float32Array)).toEqual([100, 50]);
    expect(Array.from(weather.uniforms.uWorldSizeM as Float32Array)).toEqual([430, 180]);
    expect(weather.uniforms.uPxPerMetre).toBe(12);
    expect(weather.uniforms.uRadialSmear).toBe(0.004);
    expect(weather.display.position).toMatchObject({ x: 800, y: 400 });
    expect(weather.display.scale).toMatchObject({ x: 3440, y: 1440 });
    weather.destroy();
  });

  it("starts hidden and drops its texture references on clear", () => {
    const weather = overlay();
    expect(weather.display.visible).toBe(false);
    weather.setFrame({ city: true }, { height: true }, { x: 0, y: 0, width: 10, height: 10 }, 1, 1, 0);
    weather.display.visible = true;
    weather.clear();
    expect(weather.uniforms.uCity).toBe(EMPTY);
    expect(weather.uniforms.uHeight).toBe(EMPTY);
    expect(weather.display.visible).toBe(false);
    weather.destroy();
  });

  it("blends, unlike the post-chain quads that own their whole target", () => {
    const weather = overlay();
    expect(weather.display.state.blend).toBe(true);
    expect(weather.display.state.depthTest).toBe(false);
    weather.destroy();
  });
});
