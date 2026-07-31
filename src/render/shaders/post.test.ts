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
  });

  it("grades chroma by luma so dark masses desaturate and bright signage does not", () => {
    expect(COMPOSITE_FRAG).toContain(
      "float chroma = mix(0.55, 1.15, smoothstep(0.18, 0.62, l));"
    );
    expect(COMPOSITE_FRAG).toContain("c = max(mix(vec3(l), c, chroma), vec3(0.0));");
  });

  it("falls off with screen distance from the projection pivot, not the frame centre", () => {
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uPivotUv;");
    expect(COMPOSITE_FRAG).toContain(
      "c *= 1.0 - 0.25 * smoothstep(0.20, 0.72, length(vUv - uPivotUv));"
    );
  });

  it("lifts ambient exactly once, in the city shader rather than here", () => {
    expect(COMPOSITE_FRAG).not.toContain("* shadow");
  });

  it("darkens only ground covered by the roof-shadow target", () => {
    expect(COMPOSITE_FRAG).toContain(
      "texture2D(uShadow, vUv).r * (1.0 - texture2D(uBuildingMask, vUv).a)"
    );
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - 0.38 * castShadow;");
  });
});
