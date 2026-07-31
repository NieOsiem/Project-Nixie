import { describe, expect, it } from "vitest";
import { NEON_FRAG, NEON_VERT } from "./neon.js";

describe("neon shaders", () => {
  it("selects radial falloff for ground pools", () => {
    expect(NEON_VERT).toContain("vRadial = aShade;");
    expect(NEON_FRAG).toContain("pow(max(0.0, 1.0 - length(vLocal)), 3.0)");
    expect(NEON_FRAG).toContain("mix(signGlow, poolGlow, step(0.5, vRadial))");
  });

  it("uses neither discard nor unavailable derivatives", () => {
    expect(NEON_FRAG).not.toMatch(/\bdiscard\s*;|\bfwidth\s*\(|\bdFdx\s*\(|\bdFdy\s*\(/);
  });

  it("perspective-corrects local coordinates across both quad triangles", () => {
    expect(NEON_VERT).toContain("float perspectiveW = eye / (eye + hpx * uLeanStrength);");
    expect(NEON_VERT).toContain(
      "gl_Position = vec4(projected * perspectiveW, z * perspectiveW, perspectiveW);"
    );
  });
});
