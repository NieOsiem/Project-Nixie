import { describe, expect, it } from "vitest";
import { CITY_FRAG, CITY_VERT } from "./city.js";

describe("city fragment shader", () => {
  it("keeps emissive light outside the wall canyon falloff", () => {
    expect(CITY_FRAG).toContain(
      "vBase * vShade * canyon * (1.0 - 0.60 * recess) + vEmissive * light"
    );
  });

  it("uses the coarse facade and ambient look dials", () => {
    expect(CITY_FRAG).toContain("const float WINDOW_M = 3.0;");
    expect(CITY_FRAG).toContain("float style = step(0.35,");
    expect(CITY_FRAG).toContain("max(max(1.15 * lit,");
    expect(CITY_FRAG).toContain("float canyon = mix(0.62, 1.0,");
    // Bodies are exposed, emissives are not: gaining them would move what clears the threshold.
    expect(CITY_VERT).toContain("vBase = base.rgb * 1.7;");
    expect(CITY_VERT).toContain("vEmissive = emissive.rgb * (emissive.a * uEmissiveMax);");
    expect(CITY_FRAG).toContain("colour + vec3(0.045, 0.04, 0.085)");
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

  it("gives roofs a directional plane and shape-gated building-local structures", () => {
    expect(CITY_FRAG).toContain("vec2 extentM = max(vec2(vU, abs(vShade))");
    expect(CITY_FRAG).toContain("float structured = step(0.0, vShade);");
    expect(CITY_FRAG).toContain("float plane = mix(1.0, 0.84, slope);");
    expect(CITY_FRAG).toContain("float angle = vTop;");
    expect(CITY_FRAG).toContain("mat2(ca, -sa, sa, ca)");
    expect(CITY_FRAG).toContain("float padStyle = 1.0 - step(0.42, style);");
    expect(CITY_FRAG).toContain("float barsStyle = step(0.42, style)");
    expect(CITY_FRAG).not.toMatch(/\bradial\b|fract\(cell\)/);
  });

  it("separates rooftop clutter caps with an inset value split and bright rim", () => {
    expect(CITY_FRAG).toContain("float cap = 1.0 - step(-0.5, vShade);");
    expect(CITY_FRAG).toContain("smoothstep(0.68, 0.84, max(abs(vU), abs(vTop)))");
    expect(CITY_FRAG).toContain("vBase * 1.12 + vEmissive * 0.10");
    expect(CITY_FRAG).toContain("else if (vKind > 3.5 && vKind < 4.5) colour = clutter();");
  });
});
