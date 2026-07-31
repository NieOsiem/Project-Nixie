import { describe, expect, it } from "vitest";
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";
import { FALL_RATE, JITTER_CYCLE, SPLASH_RATE, WEATHER_FRAG, WIND_DIR } from "./weather.js";

describe("weather shader", () => {
  it("decodes height from scene alpha with the same constants the composite uses", () => {
    expect(WEATHER_FRAG).toContain(`const float SCENE_ALPHA_FLOOR = ${SCENE_ALPHA_FLOOR};`);
    expect(WEATHER_FRAG).toContain(
      `const float SCENE_HEIGHT_NORM_M = ${SCENE_HEIGHT_NORM_M}.0;`
    );
    expect(WEATHER_FRAG).toContain(`const float ALPHA_BACKGROUND = ${SCENE_ALPHA_FLOOR * 0.5};`);
    expect(WEATHER_FRAG).toContain("float heightM = max(encoded.a - SCENE_ALPHA_FLOOR, 0.0)");
    expect(WEATHER_FRAG).toContain("/ (1.0 - SCENE_ALPHA_FLOOR) * SCENE_HEIGHT_NORM_M;");
  });

  it("discards where nothing was drawn, so off-city fill costs nothing", () => {
    expect(WEATHER_FRAG).toContain("if (encoded.a < ALPHA_BACKGROUND) discard;");
  });

  it("builds the streak as wind plus the projection's own radial lean", () => {
    // Added as vectors, which is also what removes the pivot singularity: normalizing
    // fromPivotPx and scaling by its own length would be a 0/0 at the projection centre.
    expect(WEATHER_FRAG).toContain(
      "vec2 smearPx = WIND * uRainStreakPx + fromPivotPx * uRadialSmear;"
    );
    expect(WEATHER_FRAG).toContain(
      "vec2 fromPivotPx = (vUv - uPivotUv) * uWorldSizeM * uPxPerMetre;"
    );
    expect(WEATHER_FRAG).toContain("vec2 tAxis = smearPx / max(lenPx, 0.001);");
    expect(WEATHER_FRAG).not.toContain("normalize(fromPivotPx)");
  });

  it("carries a unit wind vector, shared with the drift the class accumulates", () => {
    // Not cosmetic: its length scales the streak here and hazeDrift in weather-overlay.ts, so a
    // non-unit value makes both dials read in a unit they do not claim.
    expect(Math.hypot(WIND_DIR[0], WIND_DIR[1])).toBe(1);
    expect(WEATHER_FRAG).toContain(`const vec2 WIND = vec2(${WIND_DIR[0]}, ${WIND_DIR[1]});`);
  });

  it("meters the drop lattice in screen pixels off a world-anchored origin", () => {
    // Both halves matter: world-anchored so the pattern pans with the city, screen-metered so a
    // drop never falls under a pixel wide (shimmer) and the on-screen count cannot grow with the
    // visible area until a 7 km view is a solid sheet.
    expect(WEATHER_FRAG).toContain("vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;");
    expect(WEATHER_FRAG).toContain("vec2 p = worldM * uPxPerMetre;");
  });

  it("advances the lattice at a rate constant across the frame", () => {
    // A per-fragment rate has a phase gradient that grows with t: the lattice scrambles within a
    // minute. Direction and length may vary per fragment; speed may not.
    expect(WEATHER_FRAG).toContain(`const float FALL_RATE = ${FALL_RATE};`);
    expect(WEATHER_FRAG).toContain("- uTime * FALL_RATE");
    expect(WEATHER_FRAG).not.toMatch(/uTime\s*\*\s*u[A-Z]/);
  });

  it("keys the drop jitter to the cycle the clock wrap preserves", () => {
    expect(WEATHER_FRAG).toContain(`const float JITTER_CYCLE = ${JITTER_CYCLE}.0;`);
    expect(WEATHER_FRAG).toContain("hash21(vec2(cx, mod(cy, JITTER_CYCLE)))");
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
    expect(WEATHER_FRAG).toContain("splashRing(p) * ground * uSplashStrength");
    expect(WEATHER_FRAG).toContain(`const float SPLASH_RATE = ${SPLASH_RATE};`);
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

  it("uses no derivatives, which ES 1.00 does not guarantee", () => {
    expect(WEATHER_FRAG).not.toContain("fwidth");
    expect(WEATHER_FRAG).not.toContain("dFdx");
    expect(WEATHER_FRAG).not.toContain("dFdy");
    expect(WEATHER_FRAG).not.toContain("#extension");
  });
});
