import { describe, expect, it } from "vitest";
import { MAX_PANEL_STRENGTH } from "../../core/gen/neon.js";
import { DISTRICT_SLOT, PALETTE_PRESETS } from "../../core/palette.js";
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
    expect(NEON_VERT).toContain(
      "float bias = mix(SIGN_BIAS_M, POOL_BIAS_M + curvature, step(0.5, aShade));"
    );
  });

  it("adds the pool's linear-interpolation depth error to its bias", () => {
    // A flat bias cannot cover it: the error scales with quad size and 1 / camera height,
    // and at r=30 it crosses 1.5 m at every camera at or below the 500 m default.
    expect(NEON_VERT).toContain("float span = max(aRoofCentre.x, aRoofCentre.y);");
    expect(NEON_VERT).toContain(
      "float curvature = span * span * uPixelsPerMetre / max(uCamHeight, 1.0);"
    );
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

  it("keeps unlit glyph gaps under the composite's clamp", () => {
    // post.ts ends in c *= 1/(1 + max(m-1, 0)), which for m >= 1 is an exact clamp to 1.0,
    // not a shoulder. Everything at or above the clamp renders identically, so the panel's
    // structure can only live in what stays below it. If a gap clips, the panel is a blob.
    const mix = NEON_FRAG.match(/g = spill \* ([\d.]+) \+ lit \* ([\d.]+);/);
    expect(mix).not.toBeNull();
    const [gapCoefficient, litCoefficient] = [Number(mix![1]), Number(mix![2])];

    const brightestNeon = Math.max(
      ...PALETTE_PRESETS.flatMap((p) =>
        [DISTRICT_SLOT.NEON_A, DISTRICT_SLOT.NEON_B].map(
          (slot) => p.materials[slot]!.emissiveStrength
        )
      )
    );
    const peak = brightestNeon * MAX_PANEL_STRENGTH;

    expect(gapCoefficient * peak).toBeLessThan(0.85);
    expect((gapCoefficient + litCoefficient) * peak).toBeGreaterThan(1);
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
