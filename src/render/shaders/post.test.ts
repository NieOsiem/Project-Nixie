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

  it("adds mild body vibrance, boosts bright signage, and preserves a black floor", () => {
    expect(COMPOSITE_FRAG).toContain(
      "float chroma = mix(1.05, 1.25, smoothstep(0.18, 0.62, l));"
    );
    expect(COMPOSITE_FRAG).toContain(
      "c = max(mix(vec3(l), c, chroma) - vec3(0.004), vec3(0.0));"
    );
  });

  it("falls off with screen distance from the projection pivot, not the frame centre", () => {
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uPivotUv;");
    expect(COMPOSITE_FRAG).toContain(
      "c *= 1.0 - 0.1 * smoothstep(0.20, 0.72, length(vUv - uPivotUv));"
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
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - 0.22 * castShadow;");
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

  it("builds a covered low-ground mask and anchors puddles in world space", () => {
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uWorldOriginM;");
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uWorldSizeM;");
    expect(COMPOSITE_FRAG).toContain("vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;");
    expect(COMPOSITE_FRAG).toContain("float ground = (1.0 - smoothstep(0.0, WET_GROUND_HEIGHT_M, heightM)) * covered;");
    expect(COMPOSITE_FRAG).toContain("float puddleNoise = valueNoise(worldM / max(uPuddleScaleM, 0.001));");
    expect(COMPOSITE_FRAG).toContain("float puddleThreshold = 1.0 - clamp(uPuddleCoverage, 0.0, 1.0);");
    expect(COMPOSITE_FRAG).toContain("* step(0.0001, uPuddleCoverage);");
  });

  it("darkens before the cast shadow and applies only a bounded light-aware gloss", () => {
    const wet = COMPOSITE_FRAG.indexOf("c *= mix(1.0, clamp(uWetDarken, 0.0, 1.0), wet);");
    const gloss = COMPOSITE_FRAG.indexOf("c = mix(c, c * (1.0 + 0.35), gloss);");
    const shadow = COMPOSITE_FRAG.indexOf("float castShadow =");
    expect(wet).toBeGreaterThan(-1);
    expect(gloss).toBeGreaterThan(wet);
    expect(shadow).toBeGreaterThan(gloss);
    expect(COMPOSITE_FRAG).toContain("float light = clamp(dot(c, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);");
    expect(COMPOSITE_FRAG).not.toMatch(/c\s*\+=/);
  });

  it("smears only wide bloom away from the pivot, masked by the wet field", () => {
    for (const uniform of ["uniform float uRadialSmear;", "uniform float uSmearStrength;"]) {
      expect(COMPOSITE_FRAG).toContain(uniform);
    }
    const start = COMPOSITE_FRAG.indexOf("float smearAmount =");
    const end = COMPOSITE_FRAG.indexOf("float castShadow =");
    const smear = COMPOSITE_FRAG.slice(start, end);
    expect(smear).toContain("float smearAmount = wet * clamp(uSmearStrength, 0.0, 1.0);");
    expect(smear).toContain("vec2 smearReach = (vUv - uPivotUv) * uRadialSmear;");
    expect(smear).toContain("vUv + smearReach * t");
    expect(smear).toContain("texture2D(uBloomWide, sampleUv)");
    expect(smear).not.toContain("texture2D(uScene,");
    expect(smear).toContain("float w = pow(0.65, t * 4.0);");
    expect(smear).toContain("for (int i = 1; i <= 12; i++) {");
    expect(smear).toContain("vec2 rawUv = (vUv + smearReach * t) * uWideUvScale;");
    expect(smear).toContain("vec2 inFrame = step(vec2(0.0), rawUv) * step(rawUv, uWideUvScale);");
    expect(smear).toContain("float valid = inFrame.x * inFrame.y;");
    expect(smear).toContain("float tapWeight = valid * edgeFade.x * edgeFade.y;");
    expect(smear).toContain("smearSample += texture2D(uBloomWide, sampleUv).rgb * (w * tapWeight);");
    expect(smear).toContain("smearWeight += w;");
    expect(smear).toContain("vec2 edgeFade = smoothstep(");
    expect(smear).toContain("uWideTexel, rawUv)");
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uWideTexel;");
    expect(smear).toContain("float smearLuma = dot(smearSample, vec3(0.299, 0.587, 0.114));");
    expect(smear).toContain("float smearLight = clamp(smearLuma * uWideStrength, 0.0, 1.0);");
    expect(smear).toContain("vec3 smearHue = smearSample / max(smearLuma, 0.001);");
    expect(smear).toContain("vec3 smearLift = mix(vec3(smearLight), smearHue * smearLight, clamp(uWetGloss, 0.0, 1.0));");
    expect(smear).toContain("vec3 smearTarget = min(c + smearLift * 0.35, vec3(1.0));");
    expect(smear).toContain("c = mix(c, smearTarget, smearAmount);");
    expect(smear).not.toContain("max(c, min(smearSample");
  });

  it("formats interpolated constant floats for ESSL 100 and has no derivative or time terms", () => {
    expect(COMPOSITE_FRAG).not.toMatch(/\b(?:fwidth|dFdx|dFdy)\b/);
    expect(COMPOSITE_FRAG).not.toContain("uTime");
    expect(COMPOSITE_FRAG).not.toMatch(/const float [A-Z0-9_]+ = -?\d+(?:;|\s*;)/);
    expect(COMPOSITE_FRAG).toContain("const float WET_GROUND_HEIGHT_M = 2.5;");
    expect(COMPOSITE_FRAG).toContain("const float PUDDLE_EDGE = 0.08;");
  });

  it("carries no grain and no time term — grain lives in the host's filter stack", () => {
    for (const gone of [
      "grain",
      "uGrainStrength",
      "uGrainCells",
      "uScreenPxPerMetre",
      "uTime"
    ]) {
      expect(COMPOSITE_FRAG).not.toContain(gone);
    }
  });
});

describe("streak shader", () => {
  it("spaces taps uniformly so passes tile without gaps", () => {
    expect(STREAK_FRAG).toContain("vec2 o = uStep * t;");
    expect(STREAK_FRAG).not.toContain("1.3846");
    expect(STREAK_FRAG).not.toContain("3.2307");
    expect(STREAK_FRAG).not.toContain("uDir");
  });

  it("weights geometrically, which is what makes two passes compose into one kernel", () => {
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
      fogStrength: 0.12,
      fogDensity: 3.2,
      fogHeightM: 36,
      fogInscatter: 32,
      fogTintR: 0.075,
      fogTintG: 0.055,
      fogTintB: 0.13,
      aoStrength: 0.30,
      aoHeightM: 18,
      streakStrength: 1.5,
      wetStrength: 0.7,
      puddleCoverage: 0.45,
      puddleScaleM: 4,
      wetDarken: 0.78,
      wetGloss: 0.75,
      smearStrength: 1,
      smearHeightM: 50,
      rainDrops: 0.55,
      rainSpeedMPS: 35,
      rainStreakDuty: 0.35,
      rainDensity: 2,
      mistBelowPx: 0.05,
      dropsAbovePx: 0.75,
      rainLit: 1.6,
      splashStrength: 0.2,
      splashSizeM: 0.35,
      splashDensity: 1,
      hazeStrength: 0.12,
      hazeBandM: 46,
      hazeDrift: 0.7,
      hazeInscatter: 0.35
    });
  });
});
