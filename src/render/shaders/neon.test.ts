import { describe, expect, it } from "vitest";
import { NEON_FRAG, NEON_VERT } from "./neon.js";

describe("neon shaders", () => {
  it("selects radial falloff for ground pools", () => {
    expect(NEON_VERT).toContain("vRadial = aShade;");
    expect(NEON_FRAG).toContain("if (vRadial > 0.5)");
    expect(NEON_FRAG).toContain("pow(max(0.0, 1.0 - length(vLocal)), 2.0)");
  });

  it("biases a facade panel far less than a pool, so a hidden wall stays hidden", () => {
    expect(NEON_VERT).toContain("const float SIGN_BIAS_M = 0.25;");
    expect(NEON_VERT).toContain("const float POOL_BIAS_M = 1.5;");
    expect(NEON_VERT).toContain("float bias = mix(SIGN_BIAS_M, POOL_BIAS_M, step(0.5, aShade));");
  });

  it("thresholds the panel per axis against its own half-extents", () => {
    expect(NEON_VERT).toContain("vPanelM = aRoofCentre;");
    expect(NEON_FRAG).toContain("vec2 panel = vPanelM / max(vPanelM + uGlowMarginM, vec2(1e-4));");
    expect(NEON_FRAG).toContain("max(d.x / max(panel.x, 1e-4), d.y / max(panel.y, 1e-4))");
  });

  it("LODs the glyph pattern against the axis it runs along", () => {
    // Vertical glyphs live on a banner, where a metre of height is squashed by d(lean)/dh.
    expect(NEON_VERT).toContain(
      "length(fromPivot) * uCamHeight / (eye * eye) * uScreenPxPerMetre * uLeanStrength"
    );
    expect(NEON_VERT).toContain(
      "vGlyphPxPerM = aRoofCentre.x >= aRoofCentre.y ? uScreenPxPerMetre : upPxPerMetre;"
    );
    expect(NEON_FRAG).toContain("smoothstep(1.5, 4.0, GLYPH_PERIOD_M * vGlyphPxPerM)");
  });

  it("uses neither discard nor unavailable derivatives", () => {
    expect(NEON_FRAG).not.toMatch(/\bdiscard\s*;|\bfwidth\s*\(|\bdFdx\s*\(|\bdFdy\s*\(/);
  });

  it("declares no local named after a GLSL ES 1.00 reserved word", () => {
    const reserved = "half|fixed|double|long|short|input|output|flat|packed|union|interface";
    for (const src of [NEON_VERT, NEON_FRAG]) {
      const code = src.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(
        new RegExp(`\\b(?:float|int|bool|vec[234]|mat[234])\\s+(?:${reserved})\\b`)
      );
    }
  });

  it("perspective-corrects local coordinates across both quad triangles", () => {
    expect(NEON_VERT).toContain("float perspectiveW = eye / (eye + hpx * uLeanStrength);");
    expect(NEON_VERT).toContain(
      "gl_Position = vec4(projected * perspectiveW, z * perspectiveW, perspectiveW);"
    );
  });
});
