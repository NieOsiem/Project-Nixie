import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coalesceDistrictOverlayData,
  DISTRICT_OVERLAY_LINE_FRAG,
  DISTRICT_OVERLAY_LINE_VERT,
  DistrictOverlayLineMesh,
  DistrictOverlayLineMeshBuilder
} from "./district-overlay-mesh.js";

describe("DistrictOverlayLineMeshBuilder", () => {
  it("expands a segment into a coloured indexed quad with zoom-independent data", () => {
    const builder = new DistrictOverlayLineMeshBuilder();
    builder.add({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 0x123456, 0.5);

    const data = builder.build();
    expect(data.segmentCount).toBe(1);
    // base, unit normal, signed screen-pixel half-width, colour, alpha
    expect(data.vertices).toEqual(Float32Array.from([
      0, 0, -0, 1, 1, 0x12 / 255, 0x34 / 255, 0x56 / 255, 0.5,
      10, 0, -0, 1, 1, 0x12 / 255, 0x34 / 255, 0x56 / 255, 0.5,
      10, 0, -0, 1, -1, 0x12 / 255, 0x34 / 255, 0x56 / 255, 0.5,
      0, 0, -0, 1, -1, 0x12 / 255, 0x34 / 255, 0x56 / 255, 0.5
    ]));
    expect(Array.from(data.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("uses the world-space perpendicular for any segment direction", () => {
    const builder = new DistrictOverlayLineMeshBuilder();
    builder.add({ x: 4, y: 6 }, { x: 7, y: 10 }, 2, 0xffffff, 1);

    const data = builder.build();
    expect(data.vertices.slice(0, 18)).toEqual(Float32Array.from([
      4, 6, -0.8, 0.6, 1, 1, 1, 1, 1,
      7, 10, -0.8, 0.6, 1, 1, 1, 1, 1
    ]));
  });

  it("skips invalid and zero-length segments atomically", () => {
    const builder = new DistrictOverlayLineMeshBuilder();
    const valid = [{ x: 0, y: 0 }, { x: 2, y: 0 }] as const;
    builder.add(valid[0], valid[1], 1, 0x112233, 0.25);
    builder.add({ x: NaN, y: 0 }, valid[1], 1, 0x112233, 0.25);
    builder.add(valid[0], { x: Infinity, y: 0 }, 1, 0x112233, 0.25);
    builder.add(valid[0], valid[1], 0, 0x112233, 0.25);
    builder.add(valid[0], valid[1], -1, 0x112233, 0.25);
    builder.add(valid[0], valid[1], 1, 0x1000000, 0.25);
    builder.add(valid[0], valid[1], 1, 0x112233, -0.1);
    builder.add(valid[0], valid[1], 1, 0x112233, 1.1);
    builder.add(valid[0], valid[0], 1, 0x112233, 0.25);

    const data = builder.build();
    expect(data.segmentCount).toBe(1);
    expect(data.vertices).toHaveLength(36);
    expect(data.indices).toHaveLength(6);
  });

  it("produces deterministic compact buffers for tens of thousands of segments", () => {
    const builder = new DistrictOverlayLineMeshBuilder();
    for (let index = 0; index < 20_000; index++) {
      const x = index * 3;
      builder.add({ x, y: index % 17 }, { x: x + 2, y: index % 17 + 1 }, 1.5, index & 0xffffff, 0.5);
    }

    const data = builder.build();
    expect(data.segmentCount).toBe(20_000);
    expect(data.vertices).toHaveLength(20_000 * 4 * 9);
    expect(data.indices).toHaveLength(20_000 * 6);
    expect(Number.isFinite(data.vertices[0])).toBe(true);
    expect(data.vertices[8]).toBe(0.5);
    expect(data.indices[0]).toBe(0);
    expect(data.indices.at(-1)).toBe(20_000 * 4 - 1);
  });

  it("coalesces chunk buffers into one indexed mesh with re-based indices", () => {
    const first = new DistrictOverlayLineMeshBuilder();
    first.add({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 0xff0000, 0.5);
    const second = new DistrictOverlayLineMeshBuilder();
    second.add({ x: 0, y: 5 }, { x: 10, y: 5 }, 2, 0x00ff00, 1);

    const merged = coalesceDistrictOverlayData([first.build(), second.build()])!;
    expect(merged.segmentCount).toBe(2);
    expect(merged.vertices).toHaveLength(2 * 4 * 9);
    expect(merged.vertices.slice(0, 9)).toEqual(first.build().vertices.slice(0, 9));
    expect(merged.vertices.slice(36, 45)).toEqual(second.build().vertices.slice(0, 9));
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect(coalesceDistrictOverlayData([])).toBeNull();
  });

});

class StubBuffer {
  constructor(public readonly data: Float32Array) {}
}

class StubGeometry {
  readonly attributes: Array<{ name: string; buffer: StubBuffer; size: number; stride: number; offset: number }> = [];
  indices: Uint32Array | null = null;

  addAttribute(name: string, buffer: StubBuffer, size: number, _normalised: boolean, _type: number, stride: number, offset: number): this {
    this.attributes.push({ name, buffer, size, stride, offset });
    return this;
  }

  addIndex(indices: Uint32Array): this {
    this.indices = indices;
    return this;
  }

  destroy = vi.fn();
}

class StubMesh {
  state: Record<string, unknown> = {};
  destroy = vi.fn();

  constructor(public readonly geometry: StubGeometry, public readonly shader: unknown) {}
}

const geometryInstances: StubGeometry[] = [];

beforeEach(() => {
  geometryInstances.length = 0;
  (globalThis as { PIXI?: unknown }).PIXI = {
    Buffer: StubBuffer,
    Geometry: class extends StubGeometry {
      constructor() {
        super();
        geometryInstances.push(this);
      }
    },
    Mesh: StubMesh,
    Shader: { from: vi.fn(() => ({ uniforms: {} })) },
    TYPES: { FLOAT: 5126 }
  };
});

afterEach(() => {
  delete (globalThis as { PIXI?: unknown }).PIXI;
});

describe("DistrictOverlayLineMesh", () => {
  it("binds one indexed geometry with interleaved base, normal, width and colour attributes", () => {
    const builder = new DistrictOverlayLineMeshBuilder();
    builder.add({ x: 0, y: 0 }, { x: 4, y: 0 }, 2, 0xff0000, 0.5);
    const data = builder.build();
    const mesh = new DistrictOverlayLineMesh(data);
    const geometry = geometryInstances[0]!;

    expect(geometry.attributes.map(({ name, size, stride, offset }) => ({ name, size, stride, offset }))).toEqual([
      { name: "aBase", size: 2, stride: 36, offset: 0 },
      { name: "aNormal", size: 2, stride: 36, offset: 8 },
      { name: "aSignedHalfWidth", size: 1, stride: 36, offset: 16 },
      { name: "aColor", size: 3, stride: 36, offset: 20 },
      { name: "aAlpha", size: 1, stride: 36, offset: 32 }
    ]);
    expect(geometry.indices).toBe(data.indices);
    // WHY: the stub stands in for untyped PIXI.Mesh, so the display shape is asserted once here.
    const display = mesh.display as StubMesh;
    expect(display.state.blend).toBe(true);
    mesh.destroy();
    expect(display.destroy).toHaveBeenCalledOnce();
    expect(geometry.destroy).toHaveBeenCalledOnce();
  });

  it("exposes the inverse-zoom uniform so widths stay screen-constant without rebuilding geometry", () => {
    const builder = new DistrictOverlayLineMeshBuilder();
    builder.add({ x: 0, y: 0 }, { x: 4, y: 0 }, 2, 0xff0000, 0.5);
    const mesh = new DistrictOverlayLineMesh(builder.build());
    // WHY: the stub stands in for untyped PIXI.Shader, so the uniform surface is asserted once here.
    const shader = (mesh.display as StubMesh).shader as { uniforms: Record<string, unknown> };
    expect(shader.uniforms.uInvZoom).toBeUndefined();
    mesh.setInvZoom(0.5);
    expect(shader.uniforms.uInvZoom).toBe(0.5);
    mesh.destroy();
  });

  it("keeps its shaders in GLSL ES 1.00 form", () => {
    expect(DISTRICT_OVERLAY_LINE_VERT).toContain("attribute vec2 aBase;");
    expect(DISTRICT_OVERLAY_LINE_VERT).toContain("uniform mat3 projectionMatrix;");
    expect(DISTRICT_OVERLAY_LINE_VERT).toContain("uniform float uInvZoom;");
    expect(DISTRICT_OVERLAY_LINE_VERT).toContain("aSignedHalfWidth * uInvZoom");
    expect(DISTRICT_OVERLAY_LINE_FRAG).toContain("varying vec4 vColor;");
    expect(DISTRICT_OVERLAY_LINE_FRAG).toContain("vColor.rgb * vColor.a");
    expect(DISTRICT_OVERLAY_LINE_FRAG).not.toContain("#version");
  });
});
