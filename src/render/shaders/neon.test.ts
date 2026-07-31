import { describe, expect, it } from "vitest";
import { NEON_FRAG, NEON_VERT } from "./neon.js";

describe("neon shaders", () => {
  it("selects radial falloff for ground pools", () => {
    expect(NEON_VERT).toContain("vRadial = aShade;");
    expect(NEON_FRAG).toContain("length(vLocal)");
    expect(NEON_FRAG).toContain("mix(signGlow, poolGlow, step(0.5, vRadial))");
  });

  it("uses neither discard nor unavailable derivatives", () => {
    expect(NEON_FRAG).not.toMatch(/\bdiscard\s*;|\bfwidth\s*\(|\bdFdx\s*\(|\bdFdy\s*\(/);
  });
});
