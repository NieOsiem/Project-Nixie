import { describe, expect, it } from "vitest";
import { BUILDING_MASK_FRAG } from "./occlusion.js";

describe("building mask shader", () => {
  it("includes rooftop clutter while excluding neon and flat surfaces", () => {
    expect(BUILDING_MASK_FRAG).toContain("(vKind > 3.5 && vKind < 4.5)");
    expect(BUILDING_MASK_FRAG).toContain("if (!building) discard;");
  });
});
