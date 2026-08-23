import { describe, expect, it } from "vitest";
import {
  CITY_FRAG,
  CITY_VERT,
  FACADE_WINDOW_COLOR_SHARES,
  SEED_STEPS
} from "./city.js";
import { NEON_FRAG } from "./neon.js";
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";

describe("city fragment shader", () => {
  it("keeps architectural emission outside the wall canyon falloff", () => {
    expect(CITY_FRAG).toContain(
      "vBase * (vShade * canyon * articulation * mechTone * (1.0 - 0.3 * recess))"
    );
    expect(CITY_FRAG).toContain("col += vAccent * (0.95 * lit * glass * 0.6");
  });

  it("uses five facade families, per-window cells and three-to-six-floor sections", () => {
    expect(CITY_FRAG).toContain("const float FLOOR_M = 3.4;");
    expect(CITY_FRAG).toContain("const float BAY_M = 2.4;");
    expect(CITY_FRAG).toContain("floor(hash11(seed + 1.73) * 4.0)");
    expect(CITY_FRAG).toContain("float curtain = 1.0 - step(0.32, family);");
    expect(CITY_FRAG).toContain("float punched = step(0.32, family)");
    expect(CITY_FRAG).toContain("float ribbon = step(0.58, family)");
    expect(CITY_FRAG).toContain("float industrial = step(0.78, family)");
    expect(CITY_FRAG).toContain("float feature = step(0.92, family);");
    expect(CITY_FRAG).toContain("float cellX = floor(vU / BAY_M);");
    expect(CITY_FRAG).toContain("float lit = step(litThreshold,");
    expect(CITY_FRAG).toContain("float mechFloor = step(0.85, fract((floorId + 0.5) / mechEvery));");
    expect(CITY_FRAG).toContain("float mechWindows = 1.0 - mechFloor;");
  });

  it("keeps dense lit towers while distributing window colour into pinned district, neutral and contrast tiers", () => {
    expect(CITY_FRAG).toContain("float litThreshold = mix(0.18, 0.5,");
    expect(CITY_FRAG).not.toContain("mix(0.35, 0.68");
    expect(CITY_FRAG).toContain("vec3 districtC = mix(vec3(0.72, 0.92, 1.0)");
    expect(CITY_FRAG).toContain("vec3 neutralC = vec3(0.78, 0.90, 1.0)");
    expect(CITY_FRAG).toContain("vec3 contrastC = normalize(vAccent + vec3(0.05))");
    expect(CITY_FRAG).toContain(`step(${FACADE_WINDOW_COLOR_SHARES.district}, windowHue)`);
    expect(CITY_FRAG).toContain(
      `step(${FACADE_WINDOW_COLOR_SHARES.district + FACADE_WINDOW_COLOR_SHARES.neutral}, windowHue)`
    );
    expect(CITY_FRAG).toMatch(/float on = step\(0\.22,/);
    expect(CITY_FRAG).toContain("vec3(0.08, 0.13, 0.21)");
    expect(CITY_FRAG).toContain("glassC + vEmissive * 0.35, shop * 0.85");
    expect(CITY_FRAG).toContain("(0.85 * signStrip + 0.30 * shop) * signOn * shopTone");
  });

  it("pins deterministic lit-window hashes to 68/20/12 colour populations", () => {
    expect(FACADE_WINDOW_COLOR_SHARES).toEqual({ district: 0.68, neutral: 0.20, contrast: 0.12 });
    expect(Object.values(FACADE_WINDOW_COLOR_SHARES).reduce((sum, share) => sum + share, 0)).toBe(1);

    const counts = { district: 0, neutral: 0, contrast: 0 };
    const fract = (value: number): number => value - Math.floor(value);
    for (let index = 0; index < 40_000; index++) {
      const cellX = index % 200;
      const cellY = Math.floor(index / 200);
      const seed = Math.round(fract(Math.sin(index * 12.9898) * 43758.5453) * SEED_STEPS) / SEED_STEPS;
      const hue = fract(Math.sin((cellX + seed * 47.9) * 127.1 + (cellY + seed * 23.3) * 311.7) * 43758.5453);
      if (hue < FACADE_WINDOW_COLOR_SHARES.district) counts.district++;
      else if (hue < FACADE_WINDOW_COLOR_SHARES.district + FACADE_WINDOW_COLOR_SHARES.neutral) counts.neutral++;
      else counts.contrast++;
    }
    expect(counts.district / 40_000).toBeCloseTo(0.68, 2);
    expect(counts.neutral / 40_000).toBeCloseTo(0.20, 2);
    expect(counts.contrast / 40_000).toBeCloseTo(0.12, 2);
  });

  it("samples a strong district accent independently of the body material", () => {
    expect(CITY_VERT).toContain("float accentSlot = mix(");
    expect(CITY_VERT).toContain("6.0,");
    expect(CITY_VERT).toContain("7.0,");
    expect(CITY_VERT).toContain("float neonWeightA = 0.5;");
    expect(CITY_VERT).toContain("clamp(aRoofCentre.x, 0.0, 1.0)");
    expect(CITY_VERT).toContain("step(neonWeightA, fract(aSeed * 17.0 + 0.13))");
    expect(CITY_VERT).not.toContain("step(0.5, fract(aSeed * 17.0 + 0.13))");
    expect(CITY_VERT).toContain("vec4 accent = texture2DLod(uPalette,");
    expect(CITY_VERT).toContain(
      "vAccent = accent.rgb * (accent.a * uEmissiveMax) * 0.36 * emissiveGate;"
    );
  });

  it("has a uniform moving branch, a dedicated low-rise style, and gates architecture off short props", () => {
    expect(CITY_FRAG).toContain("uniform float uDetailQuality;");
    expect(CITY_FRAG.match(/if \(uDetailQuality < 0\.5\)/g)).toHaveLength(2);
    expect(CITY_FRAG).toContain("const float ARCHITECTURE_MIN_M = 5.0;");
    expect(CITY_FRAG).toContain("float corr = slab(fract(h / CORRUG_M)");
    expect(CITY_FRAG).toContain("Moving frames");
  });

  it("exposes bodies through dials and gates every emissive term, keeping ambient spill district-hued", () => {
    expect(CITY_FRAG).toContain("float canyon = mix(0.84, 1.0,");
    expect(CITY_FRAG).toContain("- 0.22 * (1.0 - smoothstep(0.0, 9.0, h))");
    expect(CITY_FRAG).toContain("- 0.08 * (valueNoise(vec2(vU / 3.0, h / 3.0)) - 0.5)");
    expect(CITY_VERT).toContain("uniform float uBodyExposure;");
    expect(CITY_VERT).toContain("vBase = base.rgb * uBodyExposure;");
    expect(CITY_FRAG).toContain("uniform float uSkyLift;");
    expect(CITY_FRAG).toContain("colour += vBase * (uSkyLift * smoothstep(-2.0, 22.0, vHeight));");
    expect(CITY_VERT).toContain(
      "float emissiveGate = uEmissiveGain * (1.0 - min(uDebugNoEmissive, 1.0));"
    );
    expect(CITY_VERT).toContain("vEmissive = emissive.rgb * (emissive.a * uEmissiveMax) * emissiveGate;");
    expect(CITY_VERT).toContain("varying vec3 vAmbient;");
    expect(CITY_VERT).toContain(
      "vAmbient = min(emissive.rgb * (emissive.a * uEmissiveMax) * 0.55, vec3(0.070)) * emissiveGate;"
    );
    expect(CITY_FRAG).toContain("varying vec3 vAmbient;");
    expect(CITY_FRAG).toContain("colour += vAmbient;");
    expect(CITY_FRAG).not.toContain("vec3(0.020, 0.014, 0.035)");
  });

  it("gates parapet emission to a minority and caps the rest by value", () => {
    expect(CITY_FRAG).toContain("float parapetGlow = step(0.85, hash11(seed + 3.41));");
    expect(CITY_FRAG).toContain("coping + parapetShadow");
    expect(CITY_FRAG.match(/float parapetGlow = /g)).toHaveLength(1);
    expect(CITY_FRAG.match(/0\.04 \+ 0\.40 \* coping \* parapetGlow/g)).toHaveLength(3);
    expect(CITY_FRAG.match(/0\.55 \* coping/g)).toHaveLength(2);
  });

  it("hashes a snapped seed, never the raw varying", () => {
    expect(CITY_FRAG).toContain(
      `return floor(raw * ${SEED_STEPS}.0 + 0.5) / ${SEED_STEPS}.0;`
    );
    const facade = CITY_FRAG.slice(
      CITY_FRAG.indexOf("vec3 facade()"),
      CITY_FRAG.indexOf("vec3 roof()")
    );
    expect(facade).toContain("float seed = buildingSeed(vSeed);");
    expect(facade.match(/vSeed/g)).toHaveLength(1);
    expect(NEON_FRAG).toContain(
      `float seed = floor(vSeed * ${SEED_STEPS}.0 + 0.5) / ${SEED_STEPS}.0;`
    );
    expect(NEON_FRAG).toContain("hash11(floor(cell) + seed * 37.0)");
  });

  it("encodes surface height into scene alpha from the shared constants", () => {
    expect(CITY_FRAG).toContain(`const float SCENE_HEIGHT_NORM_M = ${SCENE_HEIGHT_NORM_M}.0;`);
    expect(CITY_FRAG).toContain(`const float SCENE_ALPHA_FLOOR = ${SCENE_ALPHA_FLOOR};`);
    expect(CITY_FRAG).toContain("float sceneAlpha = SCENE_ALPHA_FLOOR");
    expect(CITY_FRAG).toContain(
      "+ (1.0 - SCENE_ALPHA_FLOOR) * clamp(vHeight / SCENE_HEIGHT_NORM_M, 0.0, 1.0);"
    );
    expect(CITY_FRAG).toContain("gl_FragColor = vec4(colour, sceneAlpha);");
    expect(CITY_FRAG).toMatch(/const float SCENE_ALPHA_FLOOR = 0\.\d+;/);
  });

  it("breaks up flat ground with two LOD-gated octaves of world-space value noise", () => {
    expect(CITY_FRAG).toContain("if (vKind < 0.5) colour = flatGround();");
    expect(CITY_FRAG).toContain("const float GROUND_COARSE_M = 34.0;");
    expect(CITY_FRAG).toContain("const float GROUND_FINE_M = 8.5;");
    expect(CITY_FRAG).toContain("const float GROUND_COARSE_AMP = 0.125;");
    expect(CITY_FRAG).toContain("const float GROUND_FINE_AMP = 0.062;");
    expect(CITY_FRAG).toContain("vec2 w = f * f * (3.0 - 2.0 * f);");

    const flat = CITY_FRAG.slice(
      CITY_FRAG.indexOf("vec3 flatGround()"),
      CITY_FRAG.indexOf("vec3 facade()")
    );
    expect(flat).toContain("valueNoise(vWorldM / GROUND_COARSE_M)");
    expect(flat).toContain("valueNoise(vWorldM / GROUND_FINE_M)");
    expect(flat).toContain("lod(GROUND_COARSE_M, uScreenPxPerMetre)");
    expect(flat).toContain("lod(GROUND_FINE_M, uScreenPxPerMetre)");
    expect(flat).toContain("return vBase * vShade * mottle + vEmissive;");
    expect(flat.match(/vEmissive/g)).toHaveLength(1);
    expect(flat).not.toMatch(/vEmissive\s*\*|\*\s*vEmissive/);
  });

  it("uses neither discard nor unavailable derivatives", () => {
    expect(CITY_FRAG).not.toMatch(/\bdiscard\b|\bfwidth\s*\(|\bdFdx\s*\(|\bdFdy\s*\(/);
  });

  it("perspective-corrects facade coordinates across both wall triangles", () => {
    expect(CITY_VERT).toContain("float perspectiveW = eye / (eye + hpx * uLeanStrength);");
    expect(CITY_VERT).toContain(
      "gl_Position = vec4(projected * perspectiveW, z * perspectiveW, perspectiveW);"
    );
  });

  it("keeps varied roof materials fixed in the footprint's local frame", () => {
    expect(CITY_VERT).toContain("vWorldM = aPos / uPixelsPerMetre;");
    expect(CITY_VERT).toContain("vRoofCentreM = aRoofCentre / uPixelsPerMetre;");
    expect(CITY_VERT).not.toContain("vWorldM = leaned / uPixelsPerMetre;");
    expect(CITY_FRAG).toContain("const float ROOF_STRIP_M = 2.4;");
    expect(CITY_FRAG).toContain("const float ROOF_PANEL_U_M = 5.2;");
    expect(CITY_FRAG).toContain("const float ROOF_RIB_M = 1.1;");
    expect(CITY_FRAG).toContain("const float ROOF_PATCH_M = 5.6;");
    expect(CITY_FRAG).toContain("vec2 along = vec2(cos(vTop), sin(vTop));");
    expect(CITY_FRAG).toContain("vec2 across = vec2(-along.y, along.x);");
    expect(CITY_FRAG).toContain(
      "vec2 local = vec2(dot(fromCentre, along), dot(fromCentre, across));"
    );
    expect(CITY_FRAG).toContain("float membraneStyle = 1.0 - step(0.40, family);");
    expect(CITY_FRAG).toContain("float panelStyle = step(0.40, family)");
    expect(CITY_FRAG).toContain("float ribStyle = step(0.70, family)");
    expect(CITY_FRAG).toContain("float repairStyle = step(0.90, family);");
    expect(CITY_FRAG).toContain("- seam * 0.085 - patch * 0.07;");
    expect(CITY_FRAG).toContain("+ vEmissive * 0.02;");
    expect(CITY_FRAG).toContain("(hash11(seed + 8.41) - 0.5) * 0.12;");
    expect(CITY_FRAG).toContain("* 0.09 * toneLod;");
    expect(CITY_FRAG).not.toMatch(
      /\bparapet\b|\bskylight\b|\bsolar\b|\baccentStyle\b|\bpanelRim\b/
    );
  });

  it("separates rooftop clutter caps with an inset value split and bright rim", () => {
    expect(CITY_FRAG).toContain("float cap = 1.0 - step(-0.5, vShade);");
    expect(CITY_FRAG).toContain("smoothstep(0.68, 0.84, max(abs(vU), abs(vTop)))");
    expect(CITY_FRAG).toContain("vBase * 1.2 + vEmissive * 0.04");
    expect(CITY_FRAG).toContain("vBase * 0.72 + vEmissive * 0.02");
    expect(CITY_FRAG).toContain("else if (vKind > 3.5 && vKind < 4.5) colour = clutter();");
  });

  it("shades physical architectural detail and preserves its neon emission", () => {
    expect(CITY_FRAG).toContain("vec3 architectureDetail()");
    expect(CITY_FRAG).toContain("vec3 capColour = vBase * 1.08 + vEmissive;");
    expect(CITY_FRAG).toContain(
      "else if (vKind > 4.5 && vKind < 5.5) colour = architectureDetail();"
    );
  });

  it("shades car bodies, glass and dim parked lights without emissive bloom", () => {
    const car = CITY_FRAG.slice(CITY_FRAG.indexOf("vec3 car()"), CITY_FRAG.indexOf("void main()"));
    expect(car).toContain("return vBase * vShade * 0.92;");
    expect(car).toContain("vec3(0.30, 0.24, 0.12)");
    expect(car).toContain("vec3(0.25, 0.018, 0.035)");
    expect(car).not.toContain("vEmissive");
    expect(CITY_FRAG).toContain("else if (vKind > 5.5 && vKind < 6.5) colour = car();");
  });
});
