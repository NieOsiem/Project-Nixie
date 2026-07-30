import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CameraState } from "../core/camera.js";
import type { MeshBuffers } from "../core/geom/mesh.js";
import type { Rect } from "../core/geom/types.js";
import { WHOLE_CITY_CHUNK_ID, type ChunkGeometry } from "./chunk-culling.js";
import { CityRenderer } from "./city-renderer.js";

/**
 * A stub PIXI, not a GL context. It exists to count live GPU-backed objects, which is
 * the only renderer behaviour that cannot be checked through the pure culling function.
 */
const live = { meshes: 0, geometries: 0, textures: 0, renderTextures: 0 };

class StubGeometry {
  constructor() {
    live.geometries++;
  }
  addAttribute(): this {
    return this;
  }
  addIndex(): this {
    return this;
  }
  destroy(): void {
    live.geometries--;
  }
}

class StubPaletteTexture {
  baseTexture: { resource: { data: Uint8Array }; update: () => void };
  constructor(data: Uint8Array) {
    live.textures++;
    this.baseTexture = { resource: { data }, update: () => {} };
  }
  destroy(): void {
    live.textures--;
  }
}

class StubMesh {
  state: Record<string, unknown> = {};
  visible = true;
  shader: { uniforms: Record<string, unknown> };
  constructor(_geometry: unknown, shader: { uniforms: Record<string, unknown> }) {
    live.meshes++;
    this.shader = shader;
  }
  destroy(): void {
    live.meshes--;
  }
}

class StubContainer {
  children: StubMesh[] = [];
  position = { set: () => {} };
  scale = { set: () => {} };
  addChild(child: StubMesh): StubMesh {
    this.children.push(child);
    return child;
  }
  removeChild(child: StubMesh): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
  }
  destroy(): void {}
}

class StubSprite {
  eventMode = "auto";
  width = 0;
  height = 0;
  position = { set: () => {} };
  constructor(public texture: unknown) {}
  destroy(): void {}
}

const PIXI_STUB = {
  Buffer: class {
    constructor(public data: unknown) {}
  },
  Geometry: StubGeometry,
  Mesh: StubMesh,
  Container: StubContainer,
  Sprite: StubSprite,
  Shader: { from: (_v: string, _f: string, uniforms: Record<string, unknown>) => ({ uniforms }) },
  Texture: {
    EMPTY: { empty: true },
    fromBuffer: (data: Uint8Array) => new StubPaletteTexture(data)
  },
  RenderTexture: {
    create: ({ width, height }: { width: number; height: number }) => {
      live.renderTextures++;
      return {
        width,
        height,
        framebuffer: { enableDepth: () => {} },
        resize(w: number, h: number) {
          this.width = w;
          this.height = h;
        },
        destroy: () => {
          live.renderTextures--;
        }
      };
    }
  },
  TYPES: { FLOAT: 0, UNSIGNED_BYTE: 1 },
  FORMATS: { RGBA: 0 },
  SCALE_MODES: { NEAREST: 0 },
  MIPMAP_MODES: { OFF: 0 },
  WRAP_MODES: { CLAMP: 0 }
};

const SCREEN_W = 3440;
const SCREEN_H = 1440;

const cam = (over: Partial<CameraState> = {}): CameraState => ({
  stageX: SCREEN_W / 2,
  stageY: SCREEN_H / 2,
  pivotX: 0,
  pivotY: 0,
  scale: 1,
  screenWidth: SCREEN_W,
  screenHeight: SCREEN_H,
  ...over
});

const buffers = (triangleCount: number): MeshBuffers => ({
  vertices: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount
});

const chunk = (id: string, boundsPx: Rect, triangleCount = 1): ChunkGeometry => ({
  id,
  mesh: buffers(triangleCount),
  boundsPx
});

const NEAR: Rect = { x: -100, y: -100, width: 200, height: 200 };
const FAR: Rect = { x: 100_000, y: 100_000, width: 200, height: 200 };

let renderCalls = 0;
let renderedContent: StubContainer | null = null;

const hostRenderer = {
  resolution: 1,
  render: (content: StubContainer) => {
    renderCalls++;
    renderedContent = content;
  }
};

const make = (initial = buffers(4)): CityRenderer =>
  new CityRenderer(hostRenderer, initial, new Uint8Array(512), {
    pixelsPerMetre: 25,
    cameraHeightMetres: 900
  });

beforeEach(() => {
  (globalThis as { PIXI?: unknown }).PIXI = PIXI_STUB;
  live.meshes = 0;
  live.geometries = 0;
  live.textures = 0;
  live.renderTextures = 0;
  renderCalls = 0;
  renderedContent = null;
});

afterEach(() => {
  delete (globalThis as { PIXI?: unknown }).PIXI;
});

describe("CityRenderer chunk map", () => {
  it("installs setGeometry as one reserved uncullable chunk", () => {
    const r = make(buffers(7));
    r.update(cam());

    expect(r.stats()).toMatchObject({ chunks: 1, chunksDrawn: 1, triangles: 7, trianglesTotal: 7 });
    expect(live.meshes).toBe(1);
    r.destroy();
  });

  it("destroys the displaced mesh when setGeometry is called again", () => {
    const r = make();
    r.setGeometry(buffers(9));

    expect(live.meshes).toBe(1);
    expect(live.geometries).toBe(1);
    expect(live.textures).toBe(1);
    expect(r.stats()).toMatchObject({ chunks: 1, trianglesTotal: 9 });
    r.destroy();
  });

  it("setChunks replaces the whole set, reserved chunk included", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR, 3), chunk("1,0", FAR, 5)]);

    expect(r.stats()).toMatchObject({ chunks: 2, trianglesTotal: 8 });
    expect(live.meshes).toBe(2);
    r.destroy();
  });

  it("setChunk replaces one chunk in place without leaking its mesh", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR, 3)]);
    r.setChunk(chunk("0,0", NEAR, 11));

    expect(r.stats()).toMatchObject({ chunks: 1, trianglesTotal: 11 });
    expect(live.meshes).toBe(1);
    expect(live.geometries).toBe(1);
    expect(live.textures).toBe(1);
    r.destroy();
  });

  it("removeChunk and clearChunks destroy what they drop", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR), chunk("1,0", NEAR), chunk("2,0", NEAR)]);

    r.removeChunk("1,0");
    expect(live.meshes).toBe(2);
    r.removeChunk("nope");
    expect(live.meshes).toBe(2);

    r.clearChunks();
    expect(live.meshes).toBe(0);
    expect(live.geometries).toBe(0);
    expect(live.textures).toBe(0);
    expect(r.stats()).toMatchObject({ chunks: 0 });
    r.destroy();
  });

  it("destroy releases every chunk mesh and the render target", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR), chunk("1,0", FAR)]);
    r.update(cam());
    expect(live.renderTextures).toBe(1);

    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });
});

describe("CityRenderer culling", () => {
  it("draws only the chunks meeting the view, by visibility not by reparenting", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR, 3), chunk("far", FAR, 5)]);
    r.update(cam());

    expect(r.stats()).toMatchObject({
      chunks: 2,
      chunksDrawn: 1,
      triangles: 3,
      trianglesTotal: 8
    });
    expect(renderedContent?.children).toHaveLength(2);
    expect(renderedContent?.children.map((c) => c.visible)).toEqual([true, false]);
    r.destroy();
  });

  it("keeps the setGeometry chunk drawn even when every real chunk is culled", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(chunk("far", FAR, 5));
    r.setGeometry(buffers(6));
    r.update(cam());

    expect(r.stats()).toMatchObject({ chunks: 2, chunksDrawn: 1, triangles: 6 });
    r.destroy();
  });

  it("re-culls when the camera pans a chunk into view", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(chunk("far", FAR, 5));
    r.update(cam());
    expect(r.stats()).toMatchObject({ chunksDrawn: 0, triangles: 0 });

    r.update(cam({ pivotX: 100_100, pivotY: 100_100 }));
    expect(r.stats()).toMatchObject({ chunksDrawn: 1, triangles: 5 });
    r.destroy();
  });

  it("marks content dirty on any chunk-set change", () => {
    const r = make();
    const camera = cam();
    r.update(camera);
    const afterFirst = renderCalls;

    r.update(cam());
    expect(renderCalls).toBe(afterFirst);

    r.setChunk(chunk("0,0", NEAR));
    r.update(cam());
    expect(renderCalls).toBe(afterFirst + 1);

    r.removeChunk("0,0");
    r.update(cam());
    expect(renderCalls).toBe(afterFirst + 2);

    r.clearChunks();
    r.update(cam());
    expect(renderCalls).toBe(afterFirst + 3);
    r.destroy();
  });

  it("applies camera uniforms to every drawn chunk and leaves culled ones alone", () => {
    const r = make();
    r.clearChunks();
    r.setChunks([chunk("a", NEAR), chunk("b", NEAR), chunk("c", FAR)]);
    r.update(cam({ pivotX: 12, pivotY: 34 }));

    const uniforms = renderedContent?.children.map((c) => c.shader.uniforms) ?? [];
    expect(uniforms).toHaveLength(3);
    for (const u of uniforms.slice(0, 2)) {
      expect(u.uCamHeight).toBe(900 * 25);
      expect(u.uPixelsPerMetre).toBe(25);
    }
    expect(uniforms[2]?.uCamHeight).toBe(8750);
    r.destroy();
  });
});

describe("reserved chunk id", () => {
  it("is removable through the chunk API like any other id", () => {
    const r = make();
    expect(r.stats()).toMatchObject({ chunks: 1 });

    r.removeChunk(WHOLE_CITY_CHUNK_ID);
    expect(r.stats()).toMatchObject({ chunks: 0 });
    expect(live.meshes).toBe(0);
    r.destroy();
  });
});
