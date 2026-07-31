import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FootProbe, isCovered, type MaskFrame } from "./foot-probe.js";

class StubBuffer {
  updates = 0;
  constructor(public data: Float32Array) {}
  update(data: Float32Array): void {
    this.data = data;
    this.updates++;
  }
}

const attributes = new Map<string, StubBuffer>();

class StubGeometry {
  addAttribute(name: string, buffer: StubBuffer): this {
    attributes.set(name, buffer);
    return this;
  }
  destroy(): void {}
}

class StubMesh {
  state: Record<string, unknown> = {};
  size = 0;
  constructor(
    _geometry: unknown,
    public shader: { uniforms: Record<string, unknown> },
    _state: unknown,
    public drawMode: number
  ) {}
  destroy(): void {}
}

interface RenderCall {
  size: number;
  mask: unknown;
  footUv: Float32Array;
}

let renderLog: RenderCall[] = [];
/** RGBA rows the stub readback hands out, newest first. */
let maskRow = new Uint8Array(0);

const hostRenderer = {
  resolution: 1,
  extract: { pixels: () => maskRow },
  render: (mesh: StubMesh) => {
    renderLog.push({
      size: mesh.size,
      mask: mesh.shader.uniforms.uMask,
      footUv: Float32Array.from(attributes.get("aFootUv")!.data)
    });
  }
};

const frame = (over: Partial<MaskFrame> = {}): MaskFrame => ({
  texture: { mask: true },
  viewX: 100,
  viewY: 200,
  viewWidth: 400,
  viewHeight: 800,
  ...over
});

/** RGBA row where slot `i` carries `values[i]` in alpha. */
const row = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    out[i * 4 + 3] = v;
  });
  return out;
};

beforeEach(() => {
  attributes.clear();
  renderLog = [];
  maskRow = new Uint8Array(0);
  (globalThis as { PIXI?: unknown }).PIXI = {
    Buffer: StubBuffer,
    Geometry: StubGeometry,
    Mesh: StubMesh,
    Shader: { from: (_v: string, _f: string, uniforms: Record<string, unknown>) => ({ uniforms }) },
    Texture: { EMPTY: { empty: true } },
    RenderTexture: { create: () => ({ destroy: () => {} }) },
    SCALE_MODES: { NEAREST: 0 },
    DRAW_MODES: { POINTS: 0 }
  };
});

afterEach(() => {
  delete (globalThis as { PIXI?: unknown }).PIXI;
});

describe("FootProbe", () => {
  it("reports nothing until a set has been submitted", () => {
    const probe = new FootProbe(hostRenderer, 4);
    expect(probe.verdicts()).toHaveLength(0);
    probe.destroy();
  });

  it("puts world feet into mask UV space, one point per token", () => {
    const probe = new FootProbe(hostRenderer, 4);
    probe.submit(frame(), [100, 200, 300, 600], 2);

    const call = renderLog[0]!;
    expect(call.size).toBe(2);
    expect(call.mask).toEqual({ mask: true });
    expect(Array.from(call.footUv.subarray(0, 4))).toEqual([0, 0, 0.5, 0.5]);
    probe.destroy();
  });

  it("returns the row the previous submit drew, in slot order", () => {
    const probe = new FootProbe(hostRenderer, 4);
    probe.submit(frame(), [100, 200, 300, 600], 2);
    maskRow = row(255, 0, 0, 0);

    const verdicts = probe.verdicts();
    expect(verdicts).toHaveLength(2);
    expect(isCovered(verdicts[0])).toBe(true);
    expect(isCovered(verdicts[1])).toBe(false);
    probe.destroy();
  });

  it("drops feet past capacity rather than overrunning the row", () => {
    const probe = new FootProbe(hostRenderer, 2);
    probe.submit(frame(), [0, 0, 0, 0, 0, 0], 3);

    expect(renderLog[0]?.size).toBe(2);
    maskRow = row(255, 255);
    expect(probe.verdicts()).toHaveLength(2);
    probe.destroy();
  });

  it("stops reporting on a set the caller has dropped", () => {
    const probe = new FootProbe(hostRenderer, 4);
    probe.submit(frame(), [100, 200], 1);
    probe.clear();

    expect(probe.verdicts()).toHaveLength(0);
    probe.destroy();
  });

  it("skips the draw entirely when no token is on screen", () => {
    const probe = new FootProbe(hostRenderer, 4);
    probe.submit(frame(), [], 0);

    expect(renderLog).toHaveLength(0);
    expect(probe.verdicts()).toHaveLength(0);
    probe.destroy();
  });
});

describe("isCovered", () => {
  it("treats a missing slot as uncovered", () => {
    expect(isCovered(undefined)).toBe(false);
  });

  it("splits on half coverage so a mask edge does not flicker", () => {
    expect(isCovered(127)).toBe(false);
    expect(isCovered(128)).toBe(true);
  });
});
