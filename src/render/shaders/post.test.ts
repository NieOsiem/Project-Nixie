import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK_DIALS } from "../look-dials.js";
import {
  BLUR_FRAG,
  COMPOSITE_FRAG,
  DOWNSAMPLE_FRAG,
  STREAK_FRAG,
  STREAK_TAPS,
  THRESHOLD_FRAG
} from "./post.js";
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";

describe("composite shader", () => {
  it("tone-maps over-range radiance with one shared RGB scale", () => {
    expect(COMPOSITE_FRAG).toContain("float m = max(max(c.r, c.g), c.b);");
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 / (1.0 + max(m - 1.0, 0.0));");
  });

  it("composites narrow and wide bloom before grading", () => {
    expect(DOWNSAMPLE_FRAG.match(/texture2D/g)).toHaveLength(4);
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomNarrow,");
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomWide,");
  });

  it("keeps body chroma, boosts bright signage, and preserves a black floor", () => {
    expect(COMPOSITE_FRAG).toContain(
      "float chroma = mix(0.93, 1.15, smoothstep(0.18, 0.62, l));"
    );
    expect(COMPOSITE_FRAG).toContain(
      "c = max(mix(vec3(l), c, chroma) - vec3(0.012), vec3(0.0));"
    );
  });

  it("falls off with screen distance from the projection pivot, not the frame centre", () => {
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uPivotUv;");
    expect(COMPOSITE_FRAG).toContain(
      "c *= 1.0 - 0.16 * smoothstep(0.20, 0.72, length(vUv - uPivotUv));"
    );
  });

  it("lifts ambient exactly once, in the city shader rather than here", () => {
    expect(COMPOSITE_FRAG).not.toContain("* shadow");
  });

  it("darkens only ground covered by the roof-shadow target", () => {
    expect(COMPOSITE_FRAG).toContain("texture2D(uShadow, vUv * uShadowUvScale).r");
    expect(COMPOSITE_FRAG).toContain(
      "texture2D(uBuildingMask, vUv * uMaskUvScale).a"
    );
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - 0.38 * castShadow;");
  });

  it("samples only the active frame of reusable render-target capacity", () => {
    expect(THRESHOLD_FRAG).toContain("vec2 uv = vUv * uSceneUvScale;");
    expect(DOWNSAMPLE_FRAG).toContain("vec2 uv = vUv * uTexUvScale;");
    expect(BLUR_FRAG).toContain("vec2 uv = vUv * uTexUvScale;");
    expect(COMPOSITE_FRAG).toContain("texture2D(uScene, vUv * uSceneUvScale)");
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomNarrow, vUv * uBloomUvScale)");
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomWide, vUv * uWideUvScale)");
    expect(THRESHOLD_FRAG).toContain("uSceneUvScale - edge");
    expect(DOWNSAMPLE_FRAG).toContain("uTexUvScale - edge");
    expect(BLUR_FRAG).toContain("clamp(uv + o2, edge, limit)");
  });

  it("routes every new sampler through its own active-frame uv scale", () => {
    expect(COMPOSITE_FRAG).toContain("texture2D(uStreak, vUv * uStreakUvScale)");
    expect(COMPOSITE_FRAG).toContain("texture2D(uAo, vUv * uAoUvScale)");
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uStreakUvScale;");
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uAoUvScale;");
  });

  it("decodes height from scene alpha with the shared encoding constants", () => {
    expect(COMPOSITE_FRAG).toContain(
      `float covered = step(${(SCENE_ALPHA_FLOOR * 0.5).toFixed(7)}, sceneSample.a);`
    );
    expect(COMPOSITE_FRAG).toContain(
      `float heightM = max(sceneSample.a - ${SCENE_ALPHA_FLOOR.toFixed(6)}, 0.0)`
    );
    expect(COMPOSITE_FRAG).toContain(
      `/ (1.0 - ${SCENE_ALPHA_FLOOR.toFixed(6)}) * ${SCENE_HEIGHT_NORM_M.toFixed(1)};`
    );
  });

  it("declares a uniform for every look dial", () => {
    for (const uniform of [
      "uniform float uStreakStrength;",
      "uniform float uAoStrength;",
      "uniform float uAoHeightM;",
      "uniform float uFogStrength;",
      "uniform float uFogDensity;",
      "uniform float uFogHeightM;",
      "uniform float uFogInscatter;",
      "uniform float uFogTintR;",
      "uniform float uFogTintG;",
      "uniform float uFogTintB;",
      "uniform float uFogTintB;"
    ]) {
      expect(COMPOSITE_FRAG).toContain(uniform);
    }
  });

  it("fogs as a bounded mix toward a haze carrying the wide-bloom inscatter", () => {
    expect(COMPOSITE_FRAG).toContain(
      "vec3 haze = vec3(uFogTintR, uFogTintG, uFogTintB) + wideBloom * uFogInscatter;"
    );
    expect(COMPOSITE_FRAG).toContain("c = mix(c, haze, clamp(fog, 0.0, 1.0));");
    // The tone map is an exact clamp at 1.0, so an additive haze would vanish instead of reading.
    expect(COMPOSITE_FRAG).not.toMatch(/c\s*\+=[^;]*haze/);
    expect(COMPOSITE_FRAG).toContain("float density = exp(-heightM / max(uFogHeightM, 0.001));");
    expect(COMPOSITE_FRAG).toContain(
      "float fog = (1.0 - exp(-uFogDensity * radial)) * density * covered * uFogStrength;"
    );
  });

  it("multiplies AO down, gated by coverage and the height ramp", () => {
    expect(COMPOSITE_FRAG).toContain("float lowness = 1.0 - smoothstep(0.0, uAoHeightM, heightM);");
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - uAoStrength * ao * lowness * covered;");
  });

  it("carries no grain and no time term — grain lives in the host's filter stack", () => {
    for (const gone of [
      "grain",
      "uGrainStrength",
      "uGrainCells",
      "hash21",
      "uScreenPxPerMetre",
      "uTime"
    ]) {
      expect(COMPOSITE_FRAG).not.toContain(gone);
    }
  });
});

describe("streak shader", () => {
  it("spaces taps uniformly so passes tile without gaps", () => {
    // The bug this replaced: BLUR_FRAG with an inflated uTexel. Its 1.3846 / 3.2308 offsets are
    // the linear-sampling ones and only hold at unit texel steps; scaled up they leave several
    // unsampled texels between taps, so a bright source resolved as five ghost copies rather
    // than a streak — invisible on horizontal lines, glaring on points and vertical bars.
    expect(STREAK_FRAG).toContain("vec2 o = uStep * t;");
    expect(STREAK_FRAG).not.toContain("1.3846");
    expect(STREAK_FRAG).not.toContain("3.2307");
    expect(STREAK_FRAG).not.toContain("uDir");
  });

  it("weights geometrically, which is what makes two passes compose into one kernel", () => {
    // a^t1 * a^t2 = a^(t1+t2), so the two-pass kernel is exactly a^t over the whole reach.
    expect(STREAK_FRAG).toContain("float w = pow(0.94, t * uSpan);");
    expect(STREAK_FRAG).toContain(`for (int i = 1; i <= ${STREAK_TAPS}; i++) {`);
  });

  it("normalises, so a streak spreads a highlight without inventing energy", () => {
    expect(STREAK_FRAG).toContain("weight += 2.0 * w;");
    expect(STREAK_FRAG).toContain("gl_FragColor = vec4(sum / weight, 1.0);");
  });

  it("clamps to the active frame like every other pass", () => {
    expect(STREAK_FRAG).toContain("vec2 uv = vUv * uTexUvScale;");
    expect(STREAK_FRAG).toContain("vec2 limit = uTexUvScale - edge;");
    expect(STREAK_FRAG).toContain("clamp(uv + o, edge, limit)");
    expect(STREAK_FRAG).toContain("clamp(uv - o, edge, limit)");
  });

  it("uses a constant loop bound, the only kind ES 1.00 guarantees", () => {
    expect(STREAK_FRAG).not.toMatch(/i\s*<=?\s*u[A-Z]/);
    expect(STREAK_TAPS).toBe(8);
  });
});

describe("look dials", () => {
  it("keeps the agreed defaults", () => {
    expect(DEFAULT_LOOK_DIALS).toEqual({
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
      rainSpeedMPS: 55,
      rainStreakDuty: 0.35,
      rainLit: 1.6,
      splashStrength: 0.2,
      splashSizeM: 0.35,
      hazeStrength: 0.12,
      hazeBandM: 46,
      hazeDrift: 0.7,
      hazeInscatter: 0.35
    });
  });
});
