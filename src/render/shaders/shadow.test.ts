import { describe, expect, it } from "vitest";
import { SHADOW_FRAG, SHADOW_VERT } from "./shadow.js";

describe("building shadow shader", () => {
  it("projects walls between the footprint and translated roof, excluding flat geometry", () => {
    expect(SHADOW_VERT).toContain(
      "aPos + uSunDir * aHeight * uPixelsPerMetre * uSunLength"
    );
    expect(SHADOW_VERT).toContain("float building = step(0.5, aKind)");
    expect(SHADOW_VERT).toContain("step(3.5, aKind) * (1.0 - step(4.5, aKind))");
    expect(SHADOW_VERT).toContain("mix(vec4(2.0, 2.0, 0.0, 1.0)");
  });

  it("uses neither discard nor unavailable derivatives", () => {
    expect(SHADOW_VERT + SHADOW_FRAG).not.toMatch(
      /\bdiscard\b|\bfwidth\s*\(|\bdFdx\s*\(|\bdFdy\s*\(/
    );
  });
});
