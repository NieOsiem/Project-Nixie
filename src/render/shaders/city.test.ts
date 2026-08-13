import { describe, expect, it } from "vitest";
import { CITY_FRAG, CITY_VERT, SEED_STEPS } from "./city.js";
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
    // Mechanical floors: every 5-8 floors a louvered band with windows gated off.
    expect(CITY_FRAG).toContain("float mechFloor = step(0.85, fract((floorId + 0.5) / mechEvery));");
    expect(CITY_FRAG).toContain("float mechWindows = 1.0 - mechFloor;");
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
      "vAccent = accent.rgb * (accent.a * uEmissiveMax) * 0.36;"
    );
  });

  it("has a uniform moving branch, a dedicated low-rise style, and gates architecture off short props", () => {
    expect(CITY_FRAG).toContain("uniform float uDetailQuality;");
    expect(CITY_FRAG.match(/if \(uDetailQuality < 0\.5\)/g)).toHaveLength(2);
    expect(CITY_FRAG).toContain("const float ARCHITECTURE_MIN_M = 5.0;");
    // Low-rise (<5 m) gets a real shed style instead of a blank wall.
    expect(CITY_FRAG).toContain("float corr = slab(fract(h / CORRUG_M)");
    expect(CITY_FRAG).toContain("Moving frames");
  });

  it("uses the saturated body and restrained ambient look dials", () => {
    expect(CITY_FRAG).toContain("float canyon = mix(0.70, 1.0,");
    // Bodies are exposed, emissives are not: gaining them would move what clears the threshold.
    expect(CITY_VERT).toContain("vBase = base.rgb * 1.7;");
    expect(CITY_VERT).toContain("vEmissive = emissive.rgb * (emissive.a * uEmissiveMax);");
    expect(CITY_FRAG).toContain("colour + vec3(0.020, 0.014, 0.035)");
  });

  it("gates parapet emission to a minority and caps the rest by value", () => {
    expect(CITY_FRAG).toContain("float parapetGlow = step(0.62, hash11(seed + 3.41));");
    expect(CITY_FRAG).toContain("coping + parapetShadow");
    // Both quality branches use the same gated glow, or a building would change style
    // when the camera settles. One assignment, two uses.
    expect(CITY_FRAG.match(/float parapetGlow = /g)).toHaveLength(1);
    expect(CITY_FRAG.match(/0\.8 \* coping \* parapetGlow/g)).toHaveLength(3);
    expect(CITY_FRAG.match(/0\.55 \* coping/g)).toHaveLength(2);
  });

  it("hashes a snapped seed, never the raw varying", () => {
    // WHY: wall quads carry a varying w, so vSeed interpolates ~1 ULP off the constant the
    // four vertices agree on. hash11 multiplies by 78233 before the sin, which turned that
    // into a different facade style per band on NVIDIA while AMD happened to be exact.
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
    expect(CITY_FRAG).toContain("colour + vec3(0.020, 0.014, 0.035), sceneAlpha);");
    // The floor is what separates "ground at height 0" from "nothing drawn", so it cannot
    // be an integer literal the interpolation would emit without a decimal point.
    expect(CITY_FRAG).toMatch(/const float SCENE_ALPHA_FLOOR = 0\.\d+;/);
  });

  it("breaks up flat ground with two LOD-gated octaves of world-space value noise", () => {
    expect(CITY_FRAG).toContain("if (vKind < 0.5) colour = flatGround();");
    expect(CITY_FRAG).toContain("const float GROUND_COARSE_M = 34.0;");
    expect(CITY_FRAG).toContain("const float GROUND_FINE_M = 8.5;");
    // Fine octave at half the coarse amplitude, +/-8% peak into vBase.
    expect(CITY_FRAG).toContain("const float GROUND_COARSE_AMP = 0.107;");
    expect(CITY_FRAG).toContain("const float GROUND_FINE_AMP = 0.053;");
    expect(CITY_FRAG).toContain("vec2 w = f * f * (3.0 - 2.0 * f);");

    const flat = CITY_FRAG.slice(
      CITY_FRAG.indexOf("vec3 flatGround()"),
      CITY_FRAG.indexOf("vec3 facade()")
    );
    expect(flat).toContain("valueNoise(vWorldM / GROUND_COARSE_M)");
    expect(flat).toContain("valueNoise(vWorldM / GROUND_FINE_M)");
    expect(flat).toContain("lod(GROUND_COARSE_M, uScreenPxPerMetre)");
    expect(flat).toContain("lod(GROUND_FINE_M, uScreenPxPerMetre)");
    // Broad surfaces must keep max(emissive) * strength * EMISSIVE_MAX < 0.55, so the noise
    // multiplies vBase and vEmissive is passed through untouched.
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
    expect(CITY_FRAG).not.toMatch(
      /\bparapet\b|\bskylight\b|\bsolar\b|\baccentStyle\b|\bpanelRim\b/
    );
  });

  it("separates rooftop clutter caps with an inset value split and bright rim", () => {
    expect(CITY_FRAG).toContain("float cap = 1.0 - step(-0.5, vShade);");
    expect(CITY_FRAG).toContain("smoothstep(0.68, 0.84, max(abs(vU), abs(vTop)))");
    expect(CITY_FRAG).toContain("vBase * 1.12 + vEmissive * 0.10");
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
