import { describe, expect, it } from "vitest";
import { BLUR_FRAG, COMPOSITE_FRAG, DOWNSAMPLE_FRAG, THRESHOLD_FRAG } from "./post.js";

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

  it("keeps body chroma, boosts bright signage, and preserves a black floor", () => {
    expect(COMPOSITE_FRAG).toContain(
      "float chroma = mix(0.93, 1.15, smoothstep(0.18, 0.62, l));"
    );
    expect(COMPOSITE_FRAG).toContain(
      "c = max(mix(vec3(l), c, chroma) - vec3(0.012), vec3(0.0));"
    );
  });

  it("falls off with screen distance from the projection pivot, not the frame centre", () => {
    expect(COMPOSITE_FRAG).toContain("uniform vec2 uPivotUv;");
    expect(COMPOSITE_FRAG).toContain(
      "c *= 1.0 - 0.16 * smoothstep(0.20, 0.72, length(vUv - uPivotUv));"
    );
  });

  it("lifts ambient exactly once, in the city shader rather than here", () => {
    expect(COMPOSITE_FRAG).not.toContain("* shadow");
  });

  it("darkens only ground covered by the roof-shadow target", () => {
    expect(COMPOSITE_FRAG).toContain("texture2D(uShadow, vUv * uShadowUvScale).r");
    expect(COMPOSITE_FRAG).toContain(
      "texture2D(uBuildingMask, vUv * uMaskUvScale).a"
    );
    expect(COMPOSITE_FRAG).toContain("c *= 1.0 - 0.38 * castShadow;");
  });

  it("samples only the active frame of reusable render-target capacity", () => {
    expect(THRESHOLD_FRAG).toContain("vec2 uv = vUv * uSceneUvScale;");
    expect(DOWNSAMPLE_FRAG).toContain("vec2 uv = vUv * uTexUvScale;");
    expect(BLUR_FRAG).toContain("vec2 uv = vUv * uTexUvScale;");
    expect(COMPOSITE_FRAG).toContain("texture2D(uScene, vUv * uSceneUvScale)");
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomNarrow, vUv * uBloomUvScale)");
    expect(COMPOSITE_FRAG).toContain("texture2D(uBloomWide, vUv * uWideUvScale)");
    expect(THRESHOLD_FRAG).toContain("uSceneUvScale - edge");
    expect(DOWNSAMPLE_FRAG).toContain("uTexUvScale - edge");
    expect(BLUR_FRAG).toContain("clamp(uv + o2, edge, limit)");
  });
});
