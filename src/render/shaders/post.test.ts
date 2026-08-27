import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK_DIALS } from "../look-dials.js";
import { SHADOW_LENGTH } from "../../core/geom/extrude.js";
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

  it("can present the graded frame in grayscale behind the debug dial", () => {
    const gray = COMPOSITE_FRAG.indexOf(
      "c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), clamp(uDebugGrayscale, 0.0, 1.0));"
    );
    const toneMap = COMPOSITE_FRAG.indexOf("c *= 1.0 / (1.0 + max(m - 1.0, 0.0));");
    const present = COMPOSITE_FRAG.indexOf("gl_FragColor", gray);
    expect(gray).toBeGreaterThan(toneMap);
    expect(present).toBeGreaterThan(gray);
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
    expect(COMPOSITE_FRAG).toContain("+ vec3(0.008, 0.005, 0.022) * uBlackLift;");
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

  it("darkens only exposed surfaces covered by the roof-shadow target", () => {
    expect(COMPOSITE_FRAG).toContain(
      "float buildingCoverage = texture2D(uBuildingMask, vUv * uMaskUvScale).a;"
    );
    expect(COMPOSITE_FRAG).toContain("texture2D(uShadow, vUv * uShadowUvScale).r");
    expect(COMPOSITE_FRAG).toContain("* (1.0 - buildingCoverage);");
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - uShadowStrength * castShadow;");
    expect(COMPOSITE_FRAG).not.toContain("0.22 * castShadow");
  });

  it("keeps the directional shadow reach modestly longer than the original projection", () => {
    expect(SHADOW_LENGTH).toBe(0.82);
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

  it("takes the bloom cut-in luma from the uBloomThreshold dial", () => {
    expect(THRESHOLD_FRAG).toContain("uniform float uBloomThreshold;");
    expect(THRESHOLD_FRAG).toContain(
      "float soft = clamp(l - uBloomThreshold + 0.200, 0.0, 0.400);"
    );
    expect(THRESHOLD_FRAG).toContain(
      "float w = max(soft, l - uBloomThreshold) / max(l, 0.0001);"
    );
    expect(THRESHOLD_FRAG).not.toContain("l - 0.400");
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
      "uniform float uShadowStrength;",
      "uniform float uAoStrength;",
      "uniform float uAoHeightM;",
      "uniform float uContactAoStrength;",
      "uniform float uLightSpillStrength;",
      "uniform float uLightSpillRadius;",
      "uniform float uFogStrength;",
      "uniform float uFogDensity;",
      "uniform float uFogHeightM;",
      "uniform float uFogInscatter;",
      "uniform float uFogTintR;",
      "uniform float uFogTintG;",
      "uniform float uFogTintB;",
      "uniform float uBlackLift;",
      "uniform float uPuddleReflectionStrength;",
      "uniform float uDebugGrayscale;"
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

  it("uses four quarter-res neighbours for a tight dial-driven contact ring", () => {
    expect(COMPOSITE_FRAG).toContain("float lowness = 1.0 - smoothstep(0.0, uAoHeightM, heightM);");
    expect(COMPOSITE_FRAG).toContain("float lowSurface = lowness * covered;");
    expect(COMPOSITE_FRAG).toContain("float aoEdge = max(");
    expect(COMPOSITE_FRAG).toContain("float contactBand = smoothstep(0.42, 0.72, ao)");
    expect(COMPOSITE_FRAG).toContain(
      "float contactAo = max(smoothstep(0.035, 0.16, aoEdge), contactBand)"
    );
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - uAoStrength * ao * lowSurface;");
    expect(COMPOSITE_FRAG).toContain(
      "c *= 1.0 - clamp(uContactAoStrength, 0.0, 1.0) * contactAo * lowSurface;"
    );
    expect(COMPOSITE_FRAG.match(/texture2D\(uAo/g)).toHaveLength(5);
  });

  it("places a world-space multi-scale puddle union from road, curb, and drainage cues", () => {
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uWorldOriginM;");
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uWorldSizeM;");
    expect(COMPOSITE_FRAG).toContain("vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;");
    expect(COMPOSITE_FRAG).toContain(
      "float ground = (1.0 - smoothstep(0.0, WET_GROUND_HEIGHT_M, heightM)) * covered;"
    );
    expect(COMPOSITE_FRAG.match(/texture2D\(uScene/g)).toHaveLength(5);
    expect(COMPOSITE_FRAG).toContain("float roadEdge = smoothstep(0.025, 0.12, max(");
    expect(COMPOSITE_FRAG).toContain("float broadRoad = (leftRoad + rightRoad + upRoad + downRoad) * 0.25;");
    expect(COMPOSITE_FRAG).toContain("float drainageBand = 1.0 - smoothstep(");
    expect(COMPOSITE_FRAG).toContain("float tinyField =");
    expect(COMPOSITE_FRAG).toContain("float mediumField =");
    expect(COMPOSITE_FRAG).toContain("float hugeField =");
    expect(COMPOSITE_FRAG).toContain(
      "float puddleNoise = max(tinyField - 0.08, max(mediumField, hugeField - 0.04))"
    );
    expect(COMPOSITE_FRAG).toContain("* roadMask * coverageGate;");
    expect(COMPOSITE_FRAG).toContain("float coverageGate = step(0.0001, uPuddleCoverage);");
  });

  it("orders damp road, matte occlusion, sharp reflection, spill, then the locked grade", () => {
    const wetDarken = COMPOSITE_FRAG.indexOf("c *= mix(vec3(1.0), darkTarget, darkMask);");
    const broadGloss = COMPOSITE_FRAG.indexOf(
      "c = mix(c, min(c * (1.0 + GLOSS_LIFT), vec3(1.0)), broadGloss);"
    );
    const reflectionInputs = COMPOSITE_FRAG.indexOf("float reflectionAmount =");
    const shadow = COMPOSITE_FRAG.indexOf("float castShadow =");
    const ao = COMPOSITE_FRAG.indexOf("float ao =");
    const generalAo = COMPOSITE_FRAG.indexOf("c *= 1.0 - uAoStrength * ao * lowSurface;");
    const contactAo = COMPOSITE_FRAG.indexOf(
      "c *= 1.0 - clamp(uContactAoStrength, 0.0, 1.0) * contactAo * lowSurface;"
    );
    const reflection = COMPOSITE_FRAG.indexOf("c = mix(c, reflectionTarget,");
    const spill = COMPOSITE_FRAG.indexOf("c = mix(c, spillTarget,");
    const grade = COMPOSITE_FRAG.indexOf("c = c * vec3(0.94, 0.91, 1.10)");
    const fog = COMPOSITE_FRAG.indexOf("c = mix(c, haze, clamp(fog, 0.0, 1.0));");
    expect(wetDarken).toBeGreaterThan(-1);
    expect(broadGloss).toBeGreaterThan(wetDarken);
    expect(reflectionInputs).toBeGreaterThan(broadGloss);
    expect(shadow).toBeGreaterThan(reflectionInputs);
    expect(ao).toBeGreaterThan(shadow);
    expect(generalAo).toBeGreaterThan(ao);
    expect(contactAo).toBeGreaterThan(generalAo);
    expect(reflection).toBeGreaterThan(contactAo);
    expect(spill).toBeGreaterThan(reflection);
    expect(grade).toBeGreaterThan(spill);
    expect(fog).toBeGreaterThan(grade);
    expect(COMPOSITE_FRAG).not.toMatch(/c\s*\+=/);
  });

  it("uses local colored wide bloom for sharp puddle reflection and the fan only for diffuse spill", () => {
    expect(COMPOSITE_FRAG.match(/texture2D\(uBloomWide/g)).toHaveLength(6);
    expect(COMPOSITE_FRAG).toContain(
      "vec3 fanBloom = (wideBloom + fanForward + fanBack + fanLeft + fanRight) * 0.2;"
    );
    expect(COMPOSITE_FRAG).toContain("vec3 reflectionBloom = wideBloom;");
    expect(COMPOSITE_FRAG).not.toContain("reflectionBloom = max(");
    expect(COMPOSITE_FRAG).toContain("float reflectionChroma =");
    expect(COMPOSITE_FRAG).toContain("float reflectionAmount = wet * smoothstep(0.48, 0.90, puddle)");
    expect(COMPOSITE_FRAG).toContain(
      "float reflectionSelect = smoothstep(0.020, 0.120, reflectionLuma)"
    );
    expect(COMPOSITE_FRAG).toContain("* smoothstep(0.010, 0.080, reflectionChroma);");
    expect(COMPOSITE_FRAG).toContain(
      "* min(reflectionLuma * uWideStrength * 1.8, 0.60);"
    );
    expect(COMPOSITE_FRAG).toContain("float spillChroma =");
    expect(COMPOSITE_FRAG).toContain(
      "float spillSelect = smoothstep(0.020, 0.120, spillLuma)"
    );
    expect(COMPOSITE_FRAG).toContain("* smoothstep(0.010, 0.080, spillChroma);");
    expect(COMPOSITE_FRAG).toContain(
      "c + spillHue * min(spillLuma * uWideStrength * 1.8, 0.54),"
    );
    expect(COMPOSITE_FRAG).toContain("float spillHeight = 1.0 - smoothstep(2.0, 16.0, heightM);");
    expect(COMPOSITE_FRAG).toContain("float surfaceHeightEdge = max(");
    expect(COMPOSITE_FRAG).toContain(
      "float lowWall = smoothstep(0.0015, 0.020, surfaceHeightEdge)"
    );
    expect(COMPOSITE_FRAG).toContain("float spillSurface = max(ground, lowWall) * covered;");
    expect(COMPOSITE_FRAG).toContain(
      "float spillOcclusion = 1.0 - clamp(ao * 0.72 + contactAo * 0.90, 0.0, 1.0);"
    );
  });

  it("rejects white local sources at the shared chroma gate", () => {
    const smoothstep = (lo: number, hi: number, value: number): number => {
      const t = Math.min(Math.max((value - lo) / (hi - lo), 0), 1);
      return t * t * (3 - 2 * t);
    };
    const selected = (luma: number, chroma: number): number =>
      smoothstep(0.020, 0.120, luma) * smoothstep(0.010, 0.080, chroma);
    expect(selected(1, 0)).toBe(0);
    expect(selected(0.12, 0.08)).toBe(1);
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
    expect(COMPOSITE_FRAG).toContain("const float PUDDLE_EDGE_WET = 0.18;");
    expect(COMPOSITE_FRAG).toContain("const float PUDDLE_EDGE_DRY = 0.04;");
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
      shadowStrength: 0.30,
      aoStrength: 0.42,
      aoHeightM: 24,
      contactAoStrength: 0.62,
      lightSpillStrength: 1.35,
      lightSpillRadius: 17,
      streakStrength: 1.5,
      wetStrength: 0.85,
      puddleCoverage: 0.32,
      puddleScaleM: 7,
      wetDarken: 0.64,
      wetGloss: 1,
      smearStrength: 1.5,
      puddleReflectionStrength: 1.6,
      smearHeightM: 70,
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
      hazeInscatter: 0.45,
      bodyExposure: 1.7,
      skyLift: 0.12,
      emissiveGain: 1,
      neonGain: 1,
      poolGain: 1,
      debugNoEmissive: 0,
      bloomThreshold: 0.4,
      blackLift: 1,
      debugGrayscale: 0
    });
  });
});
