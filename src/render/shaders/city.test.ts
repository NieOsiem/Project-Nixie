import { describe, expect, it } from "vitest";
import { CITY_FRAG, CITY_VERT } from "./city.js";

describe("city fragment shader", () => {
  it("keeps architectural emission outside the wall canyon falloff", () => {
    expect(CITY_FRAG).toContain(
      "vBase * vShade * canyon * articulation * (1.0 - 0.58 * recess)"
    );
    expect(CITY_FRAG).toContain("+ vAccent * max(0.96 * lit, 0.88 * shop)");
  });

  it("uses four coarse facade families and clustered four-to-eight-floor sections", () => {
    expect(CITY_FRAG).toContain("const float GRID_M = 4.6;");
    expect(CITY_FRAG).toContain("const float RIBBON_M = 1.35;");
    expect(CITY_FRAG).toContain("const float FIN_M = 3.8;");
    expect(CITY_FRAG).toContain("const float FEATURE_M = 18.0;");
    expect(CITY_FRAG).toContain("floor(mix(4.0, 9.0,");
    expect(CITY_FRAG).toContain("float gridStyle = 1.0 - step(0.35, family);");
    expect(CITY_FRAG).toContain("float ribbonStyle = step(0.35, family)");
    expect(CITY_FRAG).toContain("float finStyle = step(0.65, family)");
    expect(CITY_FRAG).toContain("float featureStyle = step(0.85, family);");
    expect(CITY_FRAG).toContain("float litThreshold = mix(0.20, 0.40,");
    expect(CITY_FRAG).toContain("floor(vU / (GRID_M * 2.0))");
    expect(CITY_FRAG).toContain("floor(floorId / 2.0)");
  });

  it("samples a strong district accent independently of the body material", () => {
    expect(CITY_VERT).toContain("float accentSlot = mix(");
    expect(CITY_VERT).toContain("6.0,");
    expect(CITY_VERT).toContain("7.0,");
    expect(CITY_VERT).toContain("vec4 accent = texture2DLod(uPalette,");
    expect(CITY_VERT).toContain(
      "vAccent = accent.rgb * (accent.a * uEmissiveMax) * 0.36;"
    );
  });

  it("has a uniform moving branch and gates architecture off short props", () => {
    expect(CITY_FRAG).toContain("uniform float uDetailQuality;");
    expect(CITY_FRAG.match(/if \(uDetailQuality < 0\.5\)/g)).toHaveLength(2);
    expect(CITY_FRAG).toContain("const float ARCHITECTURE_MIN_M = 6.0;");
    expect(CITY_FRAG).toContain("if (architecture < 0.5) return vBase * vShade + vEmissive;");
    expect(CITY_FRAG).toContain("moving frames skip cell work");
  });

  it("uses the saturated body and restrained ambient look dials", () => {
    expect(CITY_FRAG).toContain("float canyon = mix(0.68, 1.0,");
    // Bodies are exposed, emissives are not: gaining them would move what clears the threshold.
    expect(CITY_VERT).toContain("vBase = base.rgb * 1.7;");
    expect(CITY_VERT).toContain("vEmissive = emissive.rgb * (emissive.a * uEmissiveMax);");
    expect(CITY_FRAG).toContain("colour + vec3(0.020, 0.014, 0.035)");
  });

  it("gates parapet emission to a minority and caps the rest by value", () => {
    expect(CITY_FRAG).toContain("float parapetGlow = step(0.62, hash11(vSeed + 3.41));");
    expect(CITY_FRAG).toContain("float coping = parapet * (1.0 - parapetGlow);");
    // Both quality branches gate off the same decision, or a building would change style
    // when the camera settles. One assignment, two uses.
    expect(CITY_FRAG.match(/float parapetGlow = /g)).toHaveLength(1);
    expect(CITY_FRAG.match(/parapet \* parapetGlow/g)).toHaveLength(2);
    expect(CITY_FRAG.match(/1\.0 \+ 0\.30 \* coping/g)).toHaveLength(2);
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

  it("gives roofs large inset, rim and skylight regions with a directional bevel", () => {
    expect(CITY_FRAG).toContain("vec2 extentM = max(vec2(vU, abs(vShade))");
    expect(CITY_FRAG).toContain("float structured = step(0.0, vShade) * architecture;");
    expect(CITY_FRAG).toContain("float plane = mix(1.08, 0.82, slope);");
    expect(CITY_FRAG).toContain("float angle = vTop;");
    expect(CITY_FRAG).toContain("mat2(ca, -sa, sa, ca)");
    expect(CITY_FRAG).toContain("float directionalBevel = clamp(");
    expect(CITY_FRAG).toContain("float insetOuter = slab(local.x, -0.70, 0.70,");
    expect(CITY_FRAG).toContain("float insetInner = slab(local.x, -0.57, 0.57,");
    expect(CITY_FRAG).toContain("float skylightArea = slab(local.x, -0.68, 0.68,");
    expect(CITY_FRAG).toContain("float stripe = fract((local.y + 0.58) / 0.28);");
    expect(CITY_FRAG).toContain("0.92 * skylightStyle * skylightBars");
    expect(CITY_FRAG).not.toMatch(/\bradial\b|fract\(cell\)/);
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
