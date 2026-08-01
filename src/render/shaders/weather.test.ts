import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK_DIALS } from "../look-dials.js";
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";
import {
  DUTY_MAX,
  FALL_WRAP_M,
  glslFloat,
  HASH_CYCLE,
  MIN_CELL_RATIO,
  MIST_SHAPE_MEAN,
  RAIN_HALF_M,
  RAIN_PERIOD_M,
  RAIN_SPACING_M,
  RESOLVE_HI,
  RESOLVE_LO,
  SPLASH_JITTER_SPAN,
  SPLASH_RATE,
  SPLASH_SPACING_M,
  SPLASH_TARGET_SURFACE_M,
  WEATHER_FRAG,
  WIND_DIR
} from "./weather.js";

describe("weather shader", () => {
  it("decodes height from scene alpha with the same constants the composite uses", () => {
    expect(WEATHER_FRAG).toContain(
      `const float SCENE_ALPHA_FLOOR = ${glslFloat(SCENE_ALPHA_FLOOR)};`
    );
    expect(WEATHER_FRAG).toContain(
      `const float SCENE_HEIGHT_NORM_M = ${glslFloat(SCENE_HEIGHT_NORM_M)};`
    );
    expect(WEATHER_FRAG).toContain(
      `const float ALPHA_BACKGROUND = ${glslFloat(SCENE_ALPHA_FLOOR * 0.5)};`
    );
    expect(WEATHER_FRAG).toContain("float heightM = max(encoded.a - SCENE_ALPHA_FLOOR, 0.0)");
    expect(WEATHER_FRAG).toContain("/ (1.0 - SCENE_ALPHA_FLOOR) * SCENE_HEIGHT_NORM_M;");
  });

  it("discards where nothing was drawn, so off-city fill costs nothing", () => {
    expect(WEATHER_FRAG).toContain("if (encoded.a < ALPHA_BACKGROUND) discard;");
  });

  it("samples the lattice in a fixed basis — a rotating one aliases it into noise", () => {
    // The bug this replaced. `p` is a world-anchored absolute coordinate, hundreds of thousands
    // of pixels from the scene origin, so projecting it onto a basis that rotates across the
    // screen adds |p| * d(basis)/dpx to the phase gradient. Measured 8998 lattice units per
    // screen pixel at zoom 4 — 2.2 cells per pixel — against an intended 0.6, and the error grew
    // with zoom, so the rain changed character at every zoom level. Fixed basis: 0.60 flat
    // across a 60x range. The basis must stay a compile-time constant.
    expect(WEATHER_FRAG).toContain("const vec2 WIND_PERP =");
    expect(WEATHER_FRAG).toContain("float a = dot(wm, WIND_PERP);");
    expect(WEATHER_FRAG).toContain("dot(wm, WIND) - uFallM");
    expect(WEATHER_FRAG).not.toContain("nAxis");
    expect(WEATHER_FRAG).not.toContain("tAxis");
  });

  it("takes the projection's radial term as a scalar length, never as a direction", () => {
    // Length may vary per fragment; the lattice basis may not. Short streaks at the pivot,
    // long ones at the frame edge, all parallel.
    expect(WEATHER_FRAG).toContain("vec2 fromPivotM = (vUv - uPivotUv) * uWorldSizeM;");
    expect(WEATHER_FRAG).toContain("float radialM = length(fromPivotM) * uRadialSmear;");
    expect(WEATHER_FRAG).not.toContain("smearPx");
  });

  it("carries a unit wind vector, shared with the drift the class accumulates", () => {
    // Not cosmetic: its length scales the streak here and hazeDrift in weather-overlay.ts, so a
    // non-unit value makes both dials read in a unit they do not claim.
    expect(Math.hypot(WIND_DIR[0], WIND_DIR[1])).toBe(1);
    expect(WEATHER_FRAG).toContain(`const vec2 WIND = vec2(${glslFloat(WIND_DIR[0])}, ${glslFloat(WIND_DIR[1])});`);
  });

  it("meters the drop lattice in metres, so drops parallax and grow like world objects", () => {
    // The screen-space lattice this replaced could not help but read as an overlay: a
    // world-anchored particle never holds a constant screen size or a constant on-screen count.
    expect(WEATHER_FRAG).toContain("vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;");
    expect(WEATHER_FRAG).toContain(`const float RAIN_SPACING_M = ${glslFloat(RAIN_SPACING_M)};`);
    expect(WEATHER_FRAG).not.toContain("vec2 p = worldM * uPxPerMetre;");
    expect(WEATHER_FRAG).not.toContain("NEAR_SPACING_PX");
  });

  it("makes drops smaller AND more numerous as the view widens, never the reverse", () => {
    // This is the requirement two earlier designs inverted. A screen-space lattice held both
    // constant; band-passed octaves swapped to a coarser lattice when zoomed out and so gave FEWER
    // and BIGGER drops — city zoom drew 6.4 m drops in 46 x 230 m cells. Asserted straight off the
    // constants, in both directions, across the real zoom range.
    const screenPx = 3440 * 1440;
    const widths: number[] = [];
    const counts: number[] = [];
    for (const pxPerMetre of [300, 200, 100, 50, 25, 12.5, 5, 2.5, 1.5]) {
      widths.push(2 * RAIN_HALF_M * pxPerMetre);
      counts.push(screenPx / pxPerMetre ** 2 / (RAIN_SPACING_M * RAIN_PERIOD_M));
    }
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
      expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
    }
  });

  it("has exactly one lattice — no octave stack to invert the relationship again", () => {
    expect(WEATHER_FRAG.match(/dropLayer\(/g)).toHaveLength(2); // one definition, one call
    expect(WEATHER_FRAG).not.toContain("RAIN_OCTAVE");
    expect(WEATHER_FRAG).not.toContain("BAND_IN_LO");
    expect(WEATHER_FRAG).not.toContain("BAND_OUT_LO");
    // No per-octave scale factor, and no loop for one to iterate over.
    expect(WEATHER_FRAG).not.toContain("float scale");
    expect(WEATHER_FRAG).not.toMatch(/for\s*\(\s*int/);
  });

  it("dissolves sub-pixel drops into mist instead of drawing them", () => {
    // Below a pixel a drop can only alias, and it should not be drawn: rain seen from far enough
    // away IS mist. Trying to keep drops resolvable at every zoom is what caused the inversion.
    expect(WEATHER_FRAG).toContain("float dropPx = 2.0 * RAIN_HALF_M * uPxPerMetre;");
    expect(WEATHER_FRAG).toContain("float drops = mix(mist, dropField, resolve);");
  });

  it("takes both crossover edges as dials, guarding the degenerate ordering", () => {
    // smoothstep with e0 >= e1 divides by zero, and both ends are user-settable.
    expect(WEATHER_FRAG).toContain(
      "float resolve = smoothstep(uMistBelowPx, max(uDropsAbovePx, uMistBelowPx + 0.01), dropPx);"
    );
    expect(DEFAULT_LOOK_DIALS.mistBelowPx).toBe(RESOLVE_LO);
    expect(DEFAULT_LOOK_DIALS.dropsAbovePx).toBe(RESOLVE_HI);
  });

  it("scales density off the column pitch only, so the seamless wrap survives", () => {
    // FALL_WRAP_M is derived from the along-period, so a dial on that period would break the wrap.
    expect(WEATHER_FRAG).toContain(
      "float spacingM = max(RAIN_SPACING_M / max(uRainDensity, 0.01), RAIN_HALF_M * MIN_CELL_RATIO);"
    );
    expect(WEATHER_FRAG).toContain("dropField = dropLayer(worldM, spacingM, RAIN_PERIOD_M,");
    expect(WEATHER_FRAG).not.toContain("RAIN_PERIOD_M / ");
    // The mist reads the live pitch too, or density would move drops and mist apart in brightness.
    expect(WEATHER_FRAG).toContain(
      "float mean = MIST_SHAPE_MEAN * duty * (2.0 * RAIN_HALF_M / spacingM);"
    );
  });

  it("gives the mist the drop field's own mean, so the crossover cannot step", () => {
    expect(WEATHER_FRAG).toContain(`const float MIST_SHAPE_MEAN = ${glslFloat(MIST_SHAPE_MEAN)};`);
    // The noise modulation averages to 1, or it would shift the mean it just matched.
    expect(WEATHER_FRAG).toContain("mist = mean * (0.55 + 0.9 * valueNoise(hp / MIST_NOISE_M));");
    expect(0.55 + 0.9 * 0.5).toBeCloseTo(1, 9);
  });

  it("keeps the lattice multi-pixel until the drops have gone, even at max density", () => {
    // If cells went sub-pixel while drops were still being drawn, the lattice itself would alias.
    // MIN_CELL_RATIO is the floor density can push the pitch to, so that is the worst case.
    const pxPerHalfMetreAtHandover = RESOLVE_HI / (2 * RAIN_HALF_M);
    expect((RAIN_SPACING_M * pxPerHalfMetreAtHandover)).toBeGreaterThan(8);
    expect(RAIN_HALF_M * MIN_CELL_RATIO * pxPerHalfMetreAtHandover).toBeGreaterThan(4);
    // And the floor has to leave room for the drop it contains, jitter span included.
    expect(MIN_CELL_RATIO * 0.6).toBeGreaterThan(2);
  });

  it("gives every drop an independent offset along its column, not just across it", () => {
    // Without the along-offset each drop sat exactly one period from the next and the column
    // pulsed in step — visible as travelling bands once the rain moved.
    expect(WEATHER_FRAG).toContain("float t = (gy - cy - r2 * (1.0 - span)) / span;");
    expect(WEATHER_FRAG).toContain("float r1 = hash21(id);");
    expect(WEATHER_FRAG).toContain("float r2 = hash21(id + 11.3);");
    expect(WEATHER_FRAG).toContain("float r3 = hash21(id + 29.7);");
  });

  it("reduces every hash input, because sin() of a large argument is not random", () => {
    // Cell indices run to thousands. Unreduced they correlated neighbouring columns into the
    // bands the first version showed, and they also make the field non-periodic.
    expect(WEATHER_FRAG).toContain(`const float HASH_CYCLE = ${glslFloat(HASH_CYCLE)};`);
    expect(WEATHER_FRAG).toContain("float hx = mod(cx, HASH_CYCLE);");
    expect(WEATHER_FRAG).toContain("vec2 id = vec2(hx, mod(cy, HASH_CYCLE));");
    expect(WEATHER_FRAG).toContain("vec2 id = mod(cell, HASH_CYCLE);");
  });

  it("takes the drop phase as one uniform distance, not a rate times the clock", () => {
    // A per-fragment rate has a phase gradient that grows with t: the lattice scrambles within a
    // minute. A distance also lets rainSpeedMPS change mid-session without teleporting the field.
    expect(WEATHER_FRAG).toContain("uniform float uFallM;");
    expect(WEATHER_FRAG).not.toContain("FALL_RATE");
    expect(WEATHER_FRAG).not.toContain("uFallPx");
    expect(WEATHER_FRAG).not.toMatch(/uTime\s*\*\s*u[A-Z]/);
  });

  it("wraps the fall distance where the lattice is continuous across it", () => {
    // A wrap shifts the cell index by FALL_WRAP_M / period, which has to be a whole number of
    // HASH_CYCLEs or the wrap reshuffles the whole field in one frame.
    const shift = FALL_WRAP_M / RAIN_PERIOD_M / HASH_CYCLE;
    expect(Math.abs(shift - Math.round(shift))).toBeLessThan(1e-9);
  });

  it("caps streak duty so drops cannot merge into one continuous line", () => {
    expect(WEATHER_FRAG).toContain(`const float DUTY_MAX = ${glslFloat(DUTY_MAX)};`);
    expect(DUTY_MAX).toBeLessThan(1);
  });

  it("drifts the haze on an accumulated offset, never on the wrapping clock", () => {
    expect(WEATHER_FRAG).toContain("vec2 hp = worldM + uHazeOffsetM;");
    expect(WEATHER_FRAG).toContain("valueNoise(hp / HAZE_COARSE_M)");
    expect(WEATHER_FRAG).not.toMatch(/valueNoise\([^)]*uTime/);
  });

  it("veils what sits below the band and leaves the tall towers clear", () => {
    expect(WEATHER_FRAG).toContain("float below = 1.0");
    expect(WEATHER_FRAG).toContain(
      "- smoothstep(uHazeBandM - HAZE_BAND_FEATHER_M, uHazeBandM + HAZE_BAND_FEATHER_M, heightM);"
    );
  });

  it("splashes only near the ground, gated by the decoded height", () => {
    expect(WEATHER_FRAG).toContain(
      "float ground = 1.0 - smoothstep(0.0, SPLASH_MAX_HEIGHT_M, heightM);"
    );
    expect(WEATHER_FRAG).toContain("splashRing(worldM) * ground * uSplashStrength");
    expect(WEATHER_FRAG).toContain(`const float SPLASH_RATE = ${glslFloat(SPLASH_RATE)};`);
  });

  it("sizes splashes in metres, because a splash is on the ground and not on the lens", () => {
    // Held at a constant 27 screen px they measured 18 m across zoomed out — wider than a
    // building — and 9 cm zoomed in. Unlike a drop, which really is a thin line in front of the
    // camera, a splash is a physical mark and has to scale with the view.
    expect(WEATHER_FRAG).toContain(`const float SPLASH_SPACING_M = ${glslFloat(SPLASH_SPACING_M)};`);
    expect(WEATHER_FRAG).toContain("vec2 g = worldM / SPLASH_SPACING_M;");
    expect(WEATHER_FRAG).toContain("life * sizeM");
    expect(WEATHER_FRAG).not.toContain("SPLASH_RADIUS_PX");
    expect(WEATHER_FRAG).not.toContain("SPLASH_SPACING_PX");
  });

  it("retires small splashes rather than letting thousands of them read as static", () => {
    // Site count grows as 1/zoom^2 because the lattice is metre-based: a district-wide view holds
    // thousands, so the fade has to start well above one pixel.
    expect(WEATHER_FRAG).toContain("smoothstep(3.0, 8.0, sizeM * uPxPerMetre)");
  });

  it("moves the splash site every strike, not once per cell forever", () => {
    // Keyed to the cell alone the site never changed, so the same spot was struck over and over
    // and the illusion died. The strike index has to be in the site hash.
    expect(WEATHER_FRAG).toContain("float strike = mod(floor(t), HASH_CYCLE);");
    expect(WEATHER_FRAG).toContain("hash21(id + vec2(strike * 13.7, strike * 5.1))");
    expect(WEATHER_FRAG).toContain("float sizeM = uSplashSizeM * (0.55 + 0.9 * hash21(id + strike * 3.3));");
  });

  it("pitches the splash lattice so a pavement strip cannot fall between sites", () => {
    // At 9 m a 2.5 m pavement held a site in only ~40% of cells, so pavements read as dry while
    // the road was busy. The constraint is the jitter span, not the pitch: a strip narrower than
    // pitch x span can sit entirely between sites.
    expect(SPLASH_SPACING_M * SPLASH_JITTER_SPAN).toBeLessThanOrEqual(SPLASH_TARGET_SURFACE_M);
    // The span the constant claims has to be the one the shader actually jitters by.
    expect(WEATHER_FRAG).toContain(`0.15 + ${glslFloat(SPLASH_JITTER_SPAN)} * hash21(id +`);
  });

  it("makes water visibility follow the city's own light", () => {
    expect(WEATHER_FRAG).toContain("vec3 light = texture2D(uCity, uv).rgb;");
    expect(WEATHER_FRAG).toContain("float lit = RAIN_AMBIENT + dot(light, LUMA) * uRainLit;");
    expect(WEATHER_FRAG).toContain("vec3 waterC = RAIN_TINT + light * RAIN_LIGHT_GAIN;");
  });

  it("outputs premultiplied and normalised, so a dense pixel cannot over-brighten", () => {
    // The quad blends with premultiplied NORMAL. Clamping alpha alone would leave the colour
    // term over-bright wherever rain and haze both land hard on the same pixel.
    expect(WEATHER_FRAG).toContain("float norm = max(a, 1.0);");
    expect(WEATHER_FRAG).toContain(
      "gl_FragColor = vec4((water * waterC + haze * hazeC) / norm, a / norm);"
    );
  });

  it("samples every texture through the active-frame uv scale", () => {
    expect(WEATHER_FRAG).toContain("vec2 uv = vUv * uUvScale;");
    expect(WEATHER_FRAG).toContain("texture2D(uHeight, uv)");
    expect(WEATHER_FRAG).toContain("texture2D(uCity, uv)");
  });

  it("writes every float constant with a decimal point, as ES 1.00 requires", () => {
    // `const float X = 4;` does not compile — ESSL 100 has no implicit int-to-float conversion.
    // Interpolating a TS constant that happens to be whole is exactly how it gets in: it
    // type-checks and every string assertion still passes. Caught once, by glslangValidator.
    const declarations = WEATHER_FRAG.match(/const float \w+ = [^;]+;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(10);
    for (const declaration of declarations) {
      expect(declaration).toMatch(/=\s*-?\d+\.\d/);
    }
  });

  it("uses no derivatives, which ES 1.00 does not guarantee", () => {
    expect(WEATHER_FRAG).not.toContain("fwidth");
    expect(WEATHER_FRAG).not.toContain("dFdx");
    expect(WEATHER_FRAG).not.toContain("dFdy");
    expect(WEATHER_FRAG).not.toContain("#extension");
  });
});
