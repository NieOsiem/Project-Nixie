import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAMERA_ZOOM_MODE } from "../constants.js";
import type { CameraState } from "../core/camera.js";
import type { MeshBuffers } from "../core/geom/mesh.js";
import type { Rect } from "../core/geom/types.js";
import { dollyLeanStrength } from "../core/lean-curve.js";
import { WHOLE_CITY_CHUNK_ID } from "./chunk-culling.js";
import { CityRenderer, type ChunkGeometry } from "./city-renderer.js";

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
  scale = { set: () => {} };
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
  BLEND_MODES: { NORMAL: 0, ADD: 1 },
  SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
  MIPMAP_MODES: { OFF: 0 },
  WRAP_MODES: { CLAMP: 0 }
};

const SCREEN_W = 3440;
const SCREEN_H = 1440;

/** Scene target plus the bloom chain's two blur targets and its composite. */
const BLOOM_RENDER_TEXTURES = 3;
/** One PIXI.Mesh + Geometry per post pass: threshold, blur H, blur V, composite. */
const BLOOM_QUADS = 4;

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

const neonChunk = (
  id: string,
  boundsPx: Rect,
  triangleCount = 1,
  neonTriangles = 1
): ChunkGeometry => ({ ...chunk(id, boundsPx, triangleCount), neon: buffers(neonTriangles) });

const NEAR: Rect = { x: -100, y: -100, width: 200, height: 200 };
const FAR: Rect = { x: 100_000, y: 100_000, width: 200, height: 200 };

interface RenderCall {
  content: StubContainer | StubMesh;
  options: { renderTexture: unknown; clear: boolean };
}

let renderCalls = 0;
let renderLog: RenderCall[] = [];
let renderedContent: StubContainer | null = null;

const hostRenderer = {
  resolution: 1,
  render: (content: StubContainer | StubMesh, options: RenderCall["options"]) => {
    renderCalls++;
    renderLog.push({ content, options });
    if (content instanceof StubContainer) renderedContent = content;
  }
};

const raw = (initial = buffers(4)): CityRenderer =>
  new CityRenderer(hostRenderer, initial, new Uint8Array(512), {
    pixelsPerMetre: 25,
    cameraHeightMetres: 900,
    cameraZoomMode: CAMERA_ZOOM_MODE.DOLLY
  });

/** Bloom is on by default; the chunk tests count meshes, and its quads are not the subject. */
const make = (initial = buffers(4)): CityRenderer => {
  const renderer = raw(initial);
  renderer.bloomEnabled = false;
  return renderer;
};

beforeEach(() => {
  (globalThis as { PIXI?: unknown }).PIXI = PIXI_STUB;
  live.meshes = 0;
  live.geometries = 0;
  live.textures = 0;
  live.renderTextures = 0;
  renderCalls = 0;
  renderLog = [];
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

describe("CityRenderer palette", () => {
  it("allocates exactly one palette texture however many chunks there are", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR), chunk("1,0", NEAR), chunk("2,0", NEAR), chunk("3,0", NEAR)]);
    expect(live.textures).toBe(1);

    r.updatePalette(new Uint8Array(512));
    expect(live.textures).toBe(1);

    r.destroy();
    expect(live.textures).toBe(0);
  });

  it("retinting redraws without touching the chunk set", () => {
    const r = make();
    r.update(cam());
    const before = renderCalls;

    r.updatePalette(new Uint8Array(512));
    r.update(cam());

    expect(renderCalls).toBe(before + 1);
    expect(r.stats()).toMatchObject({ chunks: 1 });
    r.destroy();
  });
});

describe("CityRenderer neon pass", () => {
  it("draws neon after every opaque chunk, into the same target, without clearing", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 2));
    r.update(cam({ scale: 4 }));

    expect(renderLog).toHaveLength(2);
    expect(renderLog[0]?.options.clear).toBe(true);
    expect(renderLog[1]?.options.clear).toBe(false);
    expect(renderLog[1]?.options.renderTexture).toBe(renderLog[0]?.options.renderTexture);
    expect((renderLog[1]?.content as StubContainer).children).toHaveLength(1);
    expect(
      (renderLog[1]?.content as StubContainer).children[0]?.shader.uniforms.uLeanStrength
    ).toBeGreaterThan(1);
    r.destroy();
  });

  it("skips the second pass entirely when no chunk has neon", () => {
    const r = make();
    r.update(cam());

    expect(renderLog).toHaveLength(1);
    expect(r.stats()).toMatchObject({ neonTriangles: 0 });
    r.destroy();
  });

  it("culls neon with its chunk, by visibility not by reparenting", () => {
    const r = make();
    r.clearChunks();
    r.setChunks([neonChunk("near", NEAR, 3, 2), neonChunk("far", FAR, 5, 4)]);
    r.update(cam());

    const neon = renderLog[1]?.content as StubContainer;
    expect(neon.children.map((c) => c.visible)).toEqual([true, false]);
    expect(r.stats()).toMatchObject({ triangles: 3, neonTriangles: 2 });
    r.destroy();
  });

  it("destroys a chunk's neon mesh with the chunk", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 2));
    expect(live.meshes).toBe(2);
    expect(live.geometries).toBe(2);

    r.removeChunk("0,0");
    expect(live.meshes).toBe(0);
    expect(live.geometries).toBe(0);
    r.destroy();
  });

  it("allocates no neon mesh for an empty neon buffer", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 0));

    expect(live.meshes).toBe(1);
    expect(renderLog).toHaveLength(0);
    r.destroy();
  });

  it("gives neon the same camera uniforms as the opaque geometry", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 2));
    r.update(cam({ pivotX: 12, pivotY: 34 }));

    const opaque = (renderLog[0]?.content as StubContainer).children[0]?.shader.uniforms;
    const neon = (renderLog[1]?.content as StubContainer).children[0]?.shader.uniforms;
    expect(neon?.uCamHeight).toBe(opaque?.uCamHeight);
    expect(neon?.uDepthFar).toBe(opaque?.uDepthFar);
    r.destroy();
  });
});

describe("CityRenderer bloom", () => {
  it("is on by default and presents the composite instead of the scene target", () => {
    const r = raw();
    expect(r.stats()).toMatchObject({ bloom: true, bloomStrength: 1.3 });

    r.update(cam());
    const scene = renderLog[0]?.options.renderTexture;
    const presented = renderLog[renderLog.length - 1]?.options.renderTexture;
    expect(presented).not.toBe(scene);
    expect((r.display as StubSprite).texture).toBe(presented);
    r.destroy();
  });

  it("runs four post passes and releases every target on destroy", () => {
    const r = raw();
    r.update(cam());

    expect(renderCalls).toBe(1 + BLOOM_QUADS);
    expect(live.renderTextures).toBe(1 + BLOOM_RENDER_TEXTURES);

    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("disabling releases the post quads and targets and does no post work", () => {
    const r = raw();
    r.update(cam());
    expect(live.meshes).toBe(1 + BLOOM_QUADS);

    r.bloomEnabled = false;
    expect(live.meshes).toBe(1);
    expect(live.geometries).toBe(1);
    expect(live.renderTextures).toBe(1);

    renderCalls = 0;
    r.update(cam());
    expect(renderCalls).toBe(1);
    expect(r.stats()).toMatchObject({ bloom: false });
    expect((r.display as StubSprite).texture).toBe(renderLog[renderLog.length - 1]?.options.renderTexture);

    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("re-enabling rebuilds the chain without leaking the old one", () => {
    const r = raw();
    r.update(cam());
    r.bloomEnabled = false;
    r.bloomEnabled = true;
    r.update(cam());

    expect(live.meshes).toBe(1 + BLOOM_QUADS);
    expect(live.renderTextures).toBe(1 + BLOOM_RENDER_TEXTURES);
    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("resizes its targets with the scene target rather than accumulating them", () => {
    const r = raw();
    r.update(cam());
    r.renderScale = 0.5;
    r.update(cam());

    expect(live.renderTextures).toBe(1 + BLOOM_RENDER_TEXTURES);
    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("bloomStrength redraws only when it actually changes", () => {
    const r = raw();
    r.update(cam());
    const before = renderCalls;

    r.bloomStrength = r.bloomStrength;
    r.update(cam());
    expect(renderCalls).toBe(before);

    r.bloomStrength = 0.4;
    r.update(cam());
    expect(renderCalls).toBe(before + 1 + BLOOM_QUADS);
    expect(r.stats()).toMatchObject({ bloomStrength: 0.4 });
    r.destroy();
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
      expect(u.uLeanStrength).toBeCloseTo(dollyLeanStrength(1));
      expect(u.uPixelsPerMetre).toBe(25);
    }
    expect(uniforms[2]?.uCamHeight).toBe(8750);
    r.destroy();
  });

  it("feeds screen pixels per metre, which follows zoom and render scale", () => {
    const r = make();
    r.renderScale = 0.5;
    r.update(cam({ scale: 4 }));

    const u = renderedContent?.children[0]?.shader.uniforms;
    expect(u?.uPixelsPerMetre).toBe(25);
    expect(u?.uScreenPxPerMetre).toBe(25 * 4 * 0.5);
    r.destroy();
  });

  it("raises Dolly lean quadratically without changing camera height", () => {
    const r = make();
    r.update(cam({ scale: 2 }));

    const u = renderedContent?.children[0]?.shader.uniforms;
    expect(u?.uCamHeight).toBe(900 * 25);
    expect(u?.uLeanStrength).toBeCloseTo(dollyLeanStrength(2));
    r.destroy();
  });

  it("leaves the Dolly curve uncapped below its reference zoom", () => {
    const r = make();
    r.update(cam({ scale: 0.5 }));

    const u = renderedContent?.children[0]?.shader.uniforms;
    expect(u?.uCamHeight).toBe(900 * 25);
    expect(u?.uLeanStrength).toBeCloseTo(dollyLeanStrength(0.5));
    expect(r.stats()).toMatchObject({
      cameraZoom: 0.5,
      leanOverride: null
    });
    r.destroy();
  });

  it("applies and reports an uncapped calibration override", () => {
    const r = make();
    const camera = cam({ scale: 1.75 });
    r.update(camera);
    const afterAutomatic = renderCalls;

    r.leanOverride = 12.5;
    expect(r.leanCalibrationPoint()).toMatchObject({
      zoom: 1.75,
      leanStrength: 12.5,
      leanOverride: 12.5,
      cameraZoomMode: CAMERA_ZOOM_MODE.DOLLY,
      cameraHeightMetres: 900,
      pixelsPerMetre: 25,
      screenWidth: SCREEN_W,
      screenHeight: SCREEN_H,
      renderScale: 1
    });
    r.update(camera);

    const u = renderedContent?.children[0]?.shader.uniforms;
    expect(u?.uLeanStrength).toBe(12.5);
    expect(renderCalls).toBe(afterAutomatic + 1);
    r.destroy();
  });

  it("restores the automatic curve when the calibration override is cleared", () => {
    const r = make();
    r.leanOverride = 0;
    r.update(cam({ scale: 2 }));
    expect(renderedContent?.children[0]?.shader.uniforms.uLeanStrength).toBe(0);

    r.leanOverride = null;
    r.update(cam({ scale: 2 }));
    expect(renderedContent?.children[0]?.shader.uniforms.uLeanStrength).toBeCloseTo(
      dollyLeanStrength(2)
    );
    r.destroy();
  });

  it("switches a live renderer from Dolly to Fixed mode", () => {
    const r = make();
    const camera = cam({ scale: 4 });
    r.update(camera);
    const afterDolly = renderCalls;

    r.cameraZoomMode = CAMERA_ZOOM_MODE.FIXED;
    r.update(camera);

    const u = renderedContent?.children[0]?.shader.uniforms;
    expect(u?.uCamHeight).toBe(900 * 25);
    expect(u?.uLeanStrength).toBe(1);
    expect(renderCalls).toBe(afterDolly + 1);
    r.destroy();
  });

  it("does not cap Dolly lean at high zoom", () => {
    const r = make();
    r.update(cam({ scale: 20 }));

    const u = renderedContent?.children[0]?.shader.uniforms;
    expect(u?.uCamHeight).toBe(900 * 25);
    expect(u?.uLeanStrength).toBeCloseTo(dollyLeanStrength(20));
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
