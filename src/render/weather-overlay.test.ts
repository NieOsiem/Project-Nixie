import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOK_DIALS, type LookDials } from "./look-dials.js";
import {
  FALL_WRAP_PX,
  FAR_PERIOD_PX,
  JITTER_CYCLE,
  NEAR_PERIOD_PX,
  SPLASH_RATE
} from "./shaders/weather.js";
import { TIME_WRAP_S, WeatherOverlay } from "./weather-overlay.js";

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

/** How far a value sits from the nearest whole number. */
const fromWhole = (value: number): number => Math.abs(value - Math.round(value));

describe("weather clock", () => {
  it("wraps, because a session-length float32 clock loses the precision motion is made of", () => {
    const weather = overlay();
    for (let i = 0; i < 100; i++) weather.advance(TIME_WRAP_S / 50, dials(), 1);
    expect(weather.uniforms.uTime as number).toBeLessThan(TIME_WRAP_S);
    weather.destroy();
  });

  it("wraps the splash clock where the ring phase is continuous across it", () => {
    expect(fromWhole(TIME_WRAP_S * SPLASH_RATE)).toBeLessThan(1e-9);
  });

  it("wraps the fall distance where EVERY drop layer is continuous across it", () => {
    // A wrap shifts each layer's cell index by FALL_WRAP_PX / period. Each has to be a whole
    // number of jitter cycles, or the wrap reshuffles every drop on screen in one frame. Adding a
    // third layer with a period that does not divide in is the way this breaks.
    for (const period of [NEAR_PERIOD_PX, FAR_PERIOD_PX]) {
      expect(fromWhole(FALL_WRAP_PX / period / JITTER_CYCLE)).toBeLessThan(1e-9);
    }
  });

  it("clamps one enormous step, so a backgrounded tab does not teleport the rain", () => {
    const weather = overlay();
    weather.advance(600, dials(), 1);
    expect(weather.uniforms.uTime as number).toBeLessThanOrEqual(0.25);
    weather.destroy();
  });

  it("ignores a negative step", () => {
    const weather = overlay();
    weather.advance(0.5, dials(), 1);
    const before = weather.uniforms.uTime as number;
    weather.advance(-10, dials(), 1);
    expect(weather.uniforms.uTime as number).toBe(before);
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

  it("keeps moving across a clock wrap, being independent of it", () => {
    // WHY this is separate state: value noise is not periodic, so a drift derived from the
    // wrapping clock would repattern the entire veil in one frame every wrap.
    const weather = overlay();
    const step = TIME_WRAP_S / 4;
    for (let i = 0; i < 6; i++) weather.advance(step, dials({ hazeDrift: 1 }), 1);
    const wrapped = weather.uniforms.uTime as number;
    const before = (weather.uniforms.uHazeOffsetM as Float32Array)[0]!;
    weather.advance(0.2, dials({ hazeDrift: 1 }), 1);
    expect(wrapped).toBeLessThan(TIME_WRAP_S);
    expect((weather.uniforms.uHazeOffsetM as Float32Array)[0]!).toBeGreaterThan(before);
    weather.destroy();
  });
});

describe("drop fall", () => {
  it("advances further per second the further you zoom in", () => {
    // The complaint this fixes: at a constant screen speed the rain felt slower zoomed in than
    // out, because a fixed px/s is a smaller fraction of a magnified scene. A world speed makes
    // zoom magnify the motion the way it magnifies everything else.
    // Step stays under MAX_STEP_S, or the backgrounded-tab clamp truncates it.
    const near = overlay();
    near.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 4, 0);
    near.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);

    const far = overlay();
    far.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 0.25, 0);
    far.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);

    // 10 m/s x (50 x 4) px/m x 0.2 s = 400 px, against 10 x 12.5 x 0.2 = 25 px.
    expect(near.uniforms.uFallPx as number).toBeCloseTo(400, 6);
    expect(far.uniforms.uFallPx as number).toBeCloseTo(25, 6);
    near.destroy();
    far.destroy();
  });

  it("keeps the phase continuous when zoom changes the speed under it", () => {
    // Integrating the speed, rather than multiplying a zoom-dependent rate by the clock, is what
    // stops every drop on screen from jumping on each wheel notch.
    const weather = overlay();
    weather.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 1, 0);
    weather.advance(0.2, dials({ rainSpeedMPS: 10 }), 1);
    const before = weather.uniforms.uFallPx as number;

    weather.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 3, 0);
    weather.advance(0, dials({ rainSpeedMPS: 10 }), 1);
    expect(weather.uniforms.uFallPx as number).toBe(before);
    weather.destroy();
  });

  it("derives streak length from the same speed, so it scales with zoom too", () => {
    const weather = overlay();
    weather.setFrame({}, {}, { x: 0, y: 0, width: 100, height: 100 }, 50, 2, 0);
    weather.advance(0.016, dials({ rainSpeedMPS: 10, rainStreakS: 0.04 }), 1);
    // 10 m/s x 100 px/m x 0.04 s = 40 px.
    expect(weather.uniforms.uRainStreakPx as number).toBeCloseTo(40, 6);
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
        rainStreakS: 0.05,
        rainLit: 2.5,
        splashStrength: 0.7,
        splashSizeM: 0.8,
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
