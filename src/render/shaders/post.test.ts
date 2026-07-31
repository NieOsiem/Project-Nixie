import { describe, expect, it } from "vitest";
import { COMPOSITE_FRAG, DOWNSAMPLE_FRAG } from "./post.js";

describe("composite shader", () => {
  it("tone-maps over-range radiance with one shared RGB scale", () => {
    expect(COMPOSITE_FRAG).toContain("float m = max(max(c.r, c.g), c.b);");
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 / (1.0 + max(m - 1.0, 0.0));");
  });

  it("composites narrow and wide bloom before grading", () => {
    expect(DOWNSAMPLE_FRAG.match(/texture2D/g)).toHaveLength(4);
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomNarrow,");
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomWide,");
    expect(COMPOSITE_FRAG).toContain("vec3(0.018, 0.012, 0.045) * shadow");
    expect(COMPOSITE_FRAG).toContain("mix(vec3(l), c, 1.12)");
  });

  it("darkens only ground covered by the roof-shadow target", () => {
    expect(COMPOSITE_FRAG).toContain(
      "texture2D(uShadow, vUv).r * (1.0 - texture2D(uBuildingMask, vUv).a)"
    );
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - 0.38 * castShadow;");
  });
});
