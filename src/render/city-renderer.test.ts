import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAMERA_ZOOM_MODE } from "../constants.js";
import { visibleWorldRect, type CameraState } from "../core/camera.js";
import type { MeshBuffers } from "../core/geom/mesh.js";
import type { Rect } from "../core/geom/types.js";
import { dollyLeanStrength } from "../core/lean-curve.js";
import { WHOLE_CITY_CHUNK_ID } from "./chunk-culling.js";
import { CityRenderer, type ChunkGeometry } from "./city-renderer.js";
import { FRAME_QUALITY } from "./frame-quality.js";

/**
 * A stub PIXI, not a GL context. It exists to count live GPU-backed objects, which is
 * the only renderer behaviour that cannot be checked through the pure culling function.
 */
const live = { meshes: 0, geometries: 0, textures: 0, renderTextures: 0 };

interface StubTarget {
  width: number;
  height: number;
  baseTexture: { width: number; height: number };
  frame: { width: number; height: number };
  orig: { width: number; height: number };
  noFrame: boolean;
  format?: number;
  type?: number;
  scaleMode?: number;
  framebuffer: { enableDepth: () => void };
  resize: (w: number, h: number, resizeBaseTexture?: boolean) => void;
  destroy: () => void;
}

/** Every live render target, in allocation order, so target *geometry* can be asserted. */
let createdTargets: StubTarget[] = [];

class StubGeometry {
  attributes: string[] = [];
  constructor() {
    live.geometries++;
  }
  addAttribute(name: string): this {
    this.attributes.push(name);
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
  eventMode = "auto";
  position = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
  scale = { x: 1, y: 1, set(x: number, y: number) { this.x = x; this.y = y; } };
  shader: { uniforms: Record<string, unknown> };
  constructor(
    public geometry: StubGeometry,
    shader: { uniforms: Record<string, unknown> }
  ) {
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
    create: (options: {
      width: number;
      height: number;
      format?: number;
      type?: number;
      scaleMode?: number;
    }) => {
      live.renderTextures++;
      const baseTexture = { width: options.width, height: options.height };
      const frame = { width: options.width, height: options.height };
      const orig = { width: options.width, height: options.height };
      const target: StubTarget = {
        width: options.width,
        height: options.height,
        baseTexture,
        frame,
        orig,
        noFrame: true,
        format: options.format,
        type: options.type,
        scaleMode: options.scaleMode,
        framebuffer: { enableDepth: () => {} },
        resize(w: number, h: number, resizeBaseTexture = true) {
          this.width = w;
          this.height = h;
          frame.width = w;
          frame.height = h;
          orig.width = w;
          orig.height = h;
          if (resizeBaseTexture) {
            baseTexture.width = w;
            baseTexture.height = h;
          }
        },
        destroy: () => {
          live.renderTextures--;
          const at = createdTargets.indexOf(target);
          if (at >= 0) createdTargets.splice(at, 1);
        }
      };
      createdTargets.push(target);
      return target;
    }
  },
  TYPES: { FLOAT: 0, UNSIGNED_BYTE: 1, HALF_FLOAT: 2 },
  FORMATS: { RGBA: 0, RED: 1 },
  BLEND_MODES: { NORMAL: 0, ADD: 1 },
  SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
  MIPMAP_MODES: { OFF: 0 },
  WRAP_MODES: { CLAMP: 0 }
};

const SCREEN_W = 3440;
const SCREEN_H = 1440;

/** Opaque colour, building silhouette, and quarter-resolution roof shadows. */
const CITY_PASSES = 3;
const CITY_RENDER_TEXTURES = 3;
/**
 * The building-occlusion quad and the weather quad, allocated once for the renderer's lifetime.
 * Neither owns a render target: both sample textures the city passes already produced.
 */
const OVERLAY_QUAD = 2;

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

const detailChunk = (
  id: string,
  boundsPx: Rect,
  triangleCount = 1,
  detailTriangles = 1
): ChunkGeometry => ({ ...chunk(id, boundsPx, triangleCount), detail: buffers(detailTriangles) });

const NEAR: Rect = { x: -100, y: -100, width: 200, height: 200 };
const FAR: Rect = { x: 100_000, y: 100_000, width: 200, height: 200 };

interface RenderCall {
  content: StubContainer | StubMesh;
  options: { renderTexture: unknown; clear: boolean };
}

let renderCalls = 0;
let renderLog: RenderCall[] = [];
let renderedContent: StubContainer | null = null;

/** The composite is always the last pass of a frame, and the only one fit to present. */
const lastCall = (): RenderCall => renderLog[renderLog.length - 1]!;

const hostRenderer = {
  resolution: 1,
  render: (content: StubContainer | StubMesh, options: RenderCall["options"]) => {
    renderCalls++;
    renderLog.push({ content, options });
    // Non-empty only: the post chain blanks its bloom targets with an empty container, and
    // the shadow pass blanks with another, so "last container rendered" is not the city.
    if (content instanceof StubContainer && content.children.length > 0) {
      renderedContent = content;
    }
    const target = options.renderTexture as {
      width?: number;
      height?: number;
      noFrame?: boolean;
      frame?: { width: number; height: number };
      orig?: { width: number; height: number };
      baseTexture?: { width: number; height: number };
    };
    if (target.noFrame && target.baseTexture) {
      target.width = target.baseTexture.width;
      target.height = target.baseTexture.height;
      if (target.frame) Object.assign(target.frame, target.baseTexture);
      if (target.orig) Object.assign(target.orig, target.baseTexture);
    }
  }
};

const raw = (initial = buffers(4)): CityRenderer =>
  new CityRenderer(hostRenderer, initial, new Uint8Array(512), {
    pixelsPerMetre: 25,
    cameraHeightMetres: 900,
    cameraZoomMode: CAMERA_ZOOM_MODE.DOLLY
  });

/** Bloom off only skips the blur passes now — it trims the log, the chain is there either way. */
const make = (initial = buffers(4)): CityRenderer => {
  const renderer = raw(initial);
  renderer.bloomEnabled = false;
  return renderer;
};

/**
 * The post chain always allocates its quads and targets and always composites, and how many
 * of each is `bloom.ts`'s business. Measured so the counts below stay about chunk meshes.
 */
const post = { quads: 0, targets: 0, passesOn: 0, passesOff: 0 };

const measurePost = (): void => {
  const r = raw();
  post.quads = live.meshes - 1 - OVERLAY_QUAD;
  renderCalls = 0;
  r.update(cam());
  post.passesOn = renderCalls - CITY_PASSES;
  post.targets = live.renderTextures - CITY_RENDER_TEXTURES;
  r.bloomEnabled = false;
  renderCalls = 0;
  r.update(cam());
  post.passesOff = renderCalls - CITY_PASSES;
  r.destroy();
};

const zeroCounters = (): void => {
  live.meshes = 0;
  live.geometries = 0;
  live.textures = 0;
  live.renderTextures = 0;
  createdTargets = [];
  renderCalls = 0;
  renderLog = [];
  renderedContent = null;
};

beforeEach(() => {
  (globalThis as { PIXI?: unknown }).PIXI = PIXI_STUB;
  zeroCounters();
  measurePost();
  zeroCounters();
});

afterEach(() => {
  delete (globalThis as { PIXI?: unknown }).PIXI;
});

describe("CityRenderer chunk map", () => {
  it("binds the roof centroid attribute", () => {
    const r = make();
    r.update(cam());
    const city = (renderLog[0]?.content as StubContainer).children[0]!;
    expect(city.geometry.attributes).toContain("aRoofCentre");
    r.destroy();
  });

  it("installs setGeometry as one reserved uncullable chunk", () => {
    const r = make(buffers(7));
    r.update(cam());

    expect(r.stats()).toMatchObject({ chunks: 1, chunksDrawn: 1, triangles: 7, trianglesTotal: 7 });
    expect(live.meshes).toBe(1 + OVERLAY_QUAD + post.quads);
    r.destroy();
  });

  it("destroys the displaced mesh when setGeometry is called again", () => {
    const r = make();
    r.setGeometry(buffers(9));

    expect(live.meshes).toBe(1 + OVERLAY_QUAD + post.quads);
    expect(live.geometries).toBe(1 + OVERLAY_QUAD + post.quads);
    expect(r.stats()).toMatchObject({ chunks: 1, trianglesTotal: 9 });
    r.destroy();
  });

  it("setChunks replaces the whole set, reserved chunk included", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR, 3), chunk("1,0", FAR, 5)]);

    expect(r.stats()).toMatchObject({ chunks: 2, trianglesTotal: 8 });
    expect(live.meshes).toBe(2 + OVERLAY_QUAD + post.quads);
    r.destroy();
  });

  it("setChunk replaces one chunk in place without leaking its mesh", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR, 3)]);
    r.setChunk(chunk("0,0", NEAR, 11));

    expect(r.stats()).toMatchObject({ chunks: 1, trianglesTotal: 11 });
    expect(live.meshes).toBe(1 + OVERLAY_QUAD + post.quads);
    expect(live.geometries).toBe(1 + OVERLAY_QUAD + post.quads);
    r.destroy();
  });

  it("removeChunk and clearChunks destroy what they drop", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR), chunk("1,0", NEAR), chunk("2,0", NEAR)]);

    r.removeChunk("1,0");
    expect(live.meshes).toBe(2 + OVERLAY_QUAD + post.quads);
    r.removeChunk("nope");
    expect(live.meshes).toBe(2 + OVERLAY_QUAD + post.quads);

    r.clearChunks();
    expect(live.meshes).toBe(OVERLAY_QUAD + post.quads);
    expect(live.geometries).toBe(OVERLAY_QUAD + post.quads);
    expect(r.stats()).toMatchObject({ chunks: 0 });
    r.destroy();
  });

  it("destroy releases every chunk mesh and the render target", () => {
    const r = make();
    r.setChunks([chunk("0,0", NEAR), chunk("1,0", FAR)]);
    r.update(cam());
    expect(live.renderTextures).toBe(CITY_RENDER_TEXTURES + post.targets);

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

    expect(renderCalls).toBe(before + CITY_PASSES + post.passesOff);
    expect(r.stats()).toMatchObject({ chunks: 1 });
    r.destroy();
  });
});

describe("CityRenderer building overlay", () => {
  it("masks the presented city with the building silhouette, on the same rect", () => {
    const r = make();
    r.setChunk(chunk("0,0", NEAR));
    const camera = cam({ pivotX: 900, pivotY: 700, scale: 2 });
    r.update(camera);

    const view = visibleWorldRect(camera);
    const overlay = r.overlay as StubMesh;
    const display = r.display as StubSprite;
    expect(overlay.visible).toBe(true);
    expect([overlay.position.x, overlay.position.y]).toEqual([view.x, view.y]);
    expect([overlay.scale.x, overlay.scale.y]).toEqual([view.width, view.height]);
    expect([display.width, display.height]).toEqual([view.width, view.height]);
    expect(overlay.shader.uniforms.uCity).toBe(display.texture);
    expect(overlay.shader.uniforms.uMask).not.toBe(display.texture);
    r.destroy();
  });

  it("draws the silhouette pass into its own target, flat and after the colour pass", () => {
    const r = make();
    r.setChunk(chunk("0,0", NEAR));
    r.update(cam());

    const mask = renderLog[1];
    expect(mask?.options.clear).toBe(true);
    expect(mask?.options.renderTexture).not.toBe(renderLog[0]?.options.renderTexture);
    expect(mask?.options.renderTexture).toBe((r.overlay as StubMesh).shader.uniforms.uMask);
    // The colour shader and its depth state are restored once the pass is done.
    const chunkMesh = (renderLog[0]?.content as StubContainer).children[0];
    expect(chunkMesh?.shader.uniforms).toHaveProperty("uPalette");
    expect(chunkMesh?.state.depthTest).toBe(true);
    r.destroy();
  });

  it("hides the overlay while no chunk is on screen", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(chunk("0,0", FAR));
    r.update(cam());

    expect((r.overlay as StubMesh).visible).toBe(false);
    r.destroy();
  });
});

describe("CityRenderer weather overlay", () => {
  it("animates on frames where the cached city draws nothing", () => {
    // The entire reason this is a separate quad. If the clock only advanced when the city
    // redrew, rain would freeze the moment the camera stopped — which is most of the time.
    const r = make();
    r.setChunk(chunk("0,0", NEAR));
    r.update(cam());
    r.animate(1000);
    const settled = renderCalls;
    const before = (r.weather as StubMesh).shader.uniforms.uSplashPhase as number;

    r.update(cam());
    r.animate(1500);

    expect(renderCalls).toBe(settled);
    expect((r.weather as StubMesh).shader.uniforms.uSplashPhase as number).toBeGreaterThan(before);
    expect((r.weather as StubMesh).visible).toBe(true);
    r.destroy();
  });

  it("reads height off the raw scene target, not the composite that flattened its alpha", () => {
    const r = make();
    r.setChunk(chunk("0,0", NEAR));
    const camera = cam({ pivotX: 900, pivotY: 700, scale: 2 });
    r.update(camera);
    r.animate(0);

    const view = visibleWorldRect(camera);
    const weather = r.weather as StubMesh;
    const display = r.display as StubSprite;
    expect(weather.shader.uniforms.uCity).toBe(display.texture);
    expect(weather.shader.uniforms.uHeight).toBe(createdTargets[0]);
    expect(weather.shader.uniforms.uHeight).not.toBe(display.texture);
    expect([weather.position.x, weather.position.y]).toEqual([view.x, view.y]);
    expect([weather.scale.x, weather.scale.y]).toEqual([view.width, view.height]);
    r.destroy();
  });

  it("hides at zero strength and comes back live, without redrawing the city", () => {
    const r = make();
    r.setChunk(chunk("0,0", NEAR));
    r.update(cam());
    r.animate(0);
    expect((r.weather as StubMesh).visible).toBe(true);

    // A dial outside the frame cache: it must take effect on the next tick with the camera parked.
    r.rainStrength = 0;
    const before = renderCalls;
    r.update(cam());
    r.animate(16);
    expect((r.weather as StubMesh).visible).toBe(false);

    r.rainStrength = 1;
    r.update(cam());
    r.animate(32);
    expect((r.weather as StubMesh).visible).toBe(true);
    expect(renderCalls).toBe(before);
    expect(r.stats()).toMatchObject({ rainStrength: 1 });
    r.destroy();
  });

  it("stays hidden while no chunk is on screen", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(chunk("0,0", FAR));
    r.update(cam());
    r.animate(0);

    expect((r.weather as StubMesh).visible).toBe(false);
    r.destroy();
  });

  it("animates safely before any city frame exists", () => {
    const r = make();
    r.animate(0);
    r.animate(16);
    expect((r.weather as StubMesh).visible).toBe(false);
    r.destroy();
  });
});

describe("CityRenderer neon pass", () => {
  it("draws neon after every opaque chunk, into the same target, without clearing", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 2));
    r.update(cam({ scale: 4 }));

    expect(renderLog).toHaveLength(CITY_PASSES + 1 + post.passesOff);
    expect(renderLog[0]?.options.clear).toBe(true);
    expect(renderLog[1]?.options.clear).toBe(false);
    expect(renderLog[1]?.options.renderTexture).toBe(renderLog[0]?.options.renderTexture);
    expect(renderLog[2]?.options.clear).toBe(true);
    expect(renderLog[2]?.options.renderTexture).not.toBe(renderLog[0]?.options.renderTexture);
    expect(renderLog[3]?.options.clear).toBe(true);
    expect(renderLog[3]?.options.renderTexture).not.toBe(renderLog[2]?.options.renderTexture);
    expect((renderLog[1]?.content as StubContainer).children).toHaveLength(1);
    expect(
      (renderLog[1]?.content as StubContainer).children[0]?.shader.uniforms.uLeanStrength
    ).toBeGreaterThan(1);
    r.destroy();
  });

  it("skips the second pass entirely when no chunk has neon", () => {
    const r = make();
    r.update(cam());

    expect(renderLog).toHaveLength(CITY_PASSES + post.passesOff);
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
    expect(live.meshes).toBe(2 + OVERLAY_QUAD + post.quads);
    expect(live.geometries).toBe(2 + OVERLAY_QUAD + post.quads);

    r.removeChunk("0,0");
    expect(live.meshes).toBe(OVERLAY_QUAD + post.quads);
    expect(live.geometries).toBe(OVERLAY_QUAD + post.quads);
    r.destroy();
  });

  it("allocates no neon mesh for an empty neon buffer", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 0));

    expect(live.meshes).toBe(1 + OVERLAY_QUAD + post.quads);
    expect(renderLog).toHaveLength(0);
    r.destroy();
  });

  it("gives neon the same camera uniforms as the opaque geometry", () => {
    const r = make();
    r.clearChunks();
    r.setChunk(neonChunk("0,0", NEAR, 3, 2));
    r.update(cam({ pivotX: 12, pivotY: 34 }));

    const opaque = (renderLog[0]?.content as StubContainer).children[0]?.shader.uniforms;
    const neonMesh = (renderLog[1]?.content as StubContainer).children[0]!;
    const neon = neonMesh.shader.uniforms;
    expect(neon.uCamHeight).toBe(opaque?.uCamHeight);
    expect(neon.uDepthFar).toBe(opaque?.uDepthFar);
    expect(neonMesh.geometry.attributes).toContain("aShade");
    r.destroy();
  });
});

describe("CityRenderer bloom", () => {
  it("keeps HDR through the chain and tone-maps into an RGBA8 composite", () => {
    const r = raw();
    r.update(cam());

    const scene = renderLog[0]?.options.renderTexture;
    const mask = renderLog[1]?.options.renderTexture;
    const shadow = renderLog[2]?.options.renderTexture;
    expect(scene).toMatchObject({
      format: PIXI_STUB.FORMATS.RGBA,
      type: PIXI_STUB.TYPES.HALF_FLOAT,
      scaleMode: PIXI_STUB.SCALE_MODES.LINEAR
    });
    expect(shadow).toMatchObject({
      width: 860,
      height: 360,
      format: PIXI_STUB.FORMATS.RED,
      type: PIXI_STUB.TYPES.UNSIGNED_BYTE
    });
    expect(lastCall().options.renderTexture).toMatchObject({
      format: PIXI_STUB.FORMATS.RGBA,
      type: PIXI_STUB.TYPES.UNSIGNED_BYTE
    });

    const composite = (lastCall().content as StubMesh).shader.uniforms;
    expect(composite).toMatchObject({
      uScene: scene,
      uShadow: shadow,
      uBuildingMask: mask,
      uNarrowStrength: 1.3,
      uWideStrength: 1.3 * 0.55
    });
    const wideBlur = renderLog.find(
      (call) =>
        call.content instanceof StubMesh &&
        call.content.shader.uniforms.uTexUvScale === composite.uWideUvScale &&
        call.content.shader.uniforms.uTexel === composite.uWideTexel
    );
    expect(wideBlur).toBeDefined();
    r.destroy();
  });

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

  it("runs the whole chain and releases every target on destroy", () => {
    const r = raw();
    r.update(cam());

    expect(renderCalls).toBe(CITY_PASSES + post.passesOn);
    expect(live.renderTextures).toBe(CITY_RENDER_TEXTURES + post.targets);

    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("toggling bloom skips the blur passes without reallocating the chain", () => {
    const r = raw();
    r.update(cam());
    const meshes = live.meshes;
    const targets = live.renderTextures;
    const output = lastCall().options.renderTexture;

    r.bloomEnabled = false;
    renderCalls = 0;
    r.update(cam());

    expect(post.passesOff).toBeLessThan(post.passesOn);
    expect(renderCalls).toBe(CITY_PASSES + post.passesOff);
    expect(live.meshes).toBe(meshes);
    expect(live.geometries).toBe(meshes);
    expect(live.renderTextures).toBe(targets);
    expect(r.stats()).toMatchObject({ bloom: false });
    // The composite still runs, into the same target, and is still what gets presented.
    expect(lastCall().options.renderTexture).toBe(output);
    expect((r.display as StubSprite).texture).toBe(output);

    r.bloomEnabled = true;
    r.update(cam());
    expect(live.meshes).toBe(meshes);
    expect(live.renderTextures).toBe(targets);
    expect(lastCall().options.renderTexture).toBe(output);

    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("allocates every post target at its own ratio and reframes instead of reallocating", () => {
    const r = raw();
    r.renderScale = 1;
    r.supersample = 1.5;
    r.update(cam(), FRAME_QUALITY.MOTION);

    // capacity -> active frame, per target. Capacity follows the settled scale and never
    // shrinks; only the frame follows the moving one. Entering and leaving supersampling
    // otherwise reallocates the whole chain twice per pan gesture.
    const geometry = new Map<string, number>();
    for (const t of createdTargets) {
      const key = `${t.baseTexture.width}x${t.baseTexture.height}->${t.width}x${t.height}`;
      geometry.set(key, (geometry.get(key) ?? 0) + 1);
    }

    expect(Object.fromEntries(geometry)).toEqual({
      // scene, silhouette, composite out — full resolution.
      "5160x2160->3440x1440": 3,
      // roof shadow, narrow bloom pair, ambient-occlusion pair — quarter.
      "1290x540->860x360": 5,
      // wide bloom pair and anamorphic streak pair — sixteenth.
      "323x135->215x90": 4
    });

    r.destroy();
    expect(createdTargets).toHaveLength(0);
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("never presents the raw scene target, whose alpha carries surface height", () => {
    const r = raw();
    expect((r.display as StubSprite).texture).toBe(PIXI_STUB.Texture.EMPTY);

    r.update(cam());
    expect((r.display as StubSprite).texture).not.toBe(renderLog[0]?.options.renderTexture);

    // A reallocation reseeds display.texture, which is where the scene target used to leak in.
    r.renderScale = 0.5;
    expect((r.display as StubSprite).texture).toBe(PIXI_STUB.Texture.EMPTY);

    const before = renderCalls;
    r.update(cam());
    expect((r.display as StubSprite).texture).toBe(lastCall().options.renderTexture);
    expect((r.display as StubSprite).texture).not.toBe(renderLog[before]?.options.renderTexture);
    r.destroy();
  });

  it("exposes the chain's live dials and redraws only once told they changed", () => {
    const r = raw();
    r.update(cam());
    const before = renderCalls;
    const dials = r.lookDials;

    dials.fogStrength = 0.9;
    r.update(cam());
    expect(renderCalls).toBe(before);

    r.markContentDirty();
    r.update(cam());
    expect(renderCalls).toBe(before + CITY_PASSES + post.passesOn);
    expect(r.lookDials).toBe(dials);
    expect(r.stats()).toMatchObject({ lookDials: { fogStrength: 0.9 } });
    r.destroy();
  });

  it("passes the view-space wet field and every wet dial to the cached composite", () => {
    const r = raw();
    const camera = cam({ pivotX: 900, pivotY: 700, scale: 2 });
    const dials = r.lookDials;
    dials.wetStrength = 0.7;
    dials.puddleCoverage = 0.4;
    dials.puddleScaleM = 9;
    dials.wetDarken = 0.68;
    dials.wetGloss = 0.23;
    r.markContentDirty();
    r.update(camera);

    const view = visibleWorldRect(camera);
    const uniforms = (lastCall().content as StubMesh).shader.uniforms;
    const worldOrigin = Array.from(uniforms.uWorldOriginM as Float32Array);
    const worldSize = Array.from(uniforms.uWorldSizeM as Float32Array);
    expect(worldOrigin[0]).toBeCloseTo(view.x / 25);
    expect(worldOrigin[1]).toBeCloseTo(view.y / 25);
    expect(worldSize[0]).toBeCloseTo(view.width / 25);
    expect(worldSize[1]).toBeCloseTo(view.height / 25);
    expect(uniforms.uPxPerMetre).toBe(50);
    expect(uniforms).toMatchObject({
      uWetStrength: 0.7,
      uPuddleCoverage: 0.4,
      uPuddleScaleM: 9,
      uWetDarken: 0.68,
      uWetGloss: 0.23
    });
    r.destroy();
  });

  it("derives radial smear from the live height, camera altitude, and lean", () => {
    const r = raw();
    const camera = cam();
    r.update(camera);

    let uniforms = (lastCall().content as StubMesh).shader.uniforms;
    expect(uniforms.uSmearStrength).toBe(1);
    expect(uniforms.uRadialSmear).toBeCloseTo((50 / (900 - 50)) * dollyLeanStrength(1));

    const before = renderCalls;
    r.lookDials.smearStrength = 0.25;
    r.lookDials.smearHeightM = 0;
    r.update(camera);
    expect(renderCalls).toBe(before);

    r.markContentDirty();
    r.update(camera);
    uniforms = (lastCall().content as StubMesh).shader.uniforms;
    expect(uniforms.uSmearStrength).toBe(0.25);
    expect(uniforms.uRadialSmear).toBe(0);

    r.lookDials.smearHeightM = 12;
    r.cameraHeightMetres = 450;
    r.leanOverride = 2;
    r.update(cam({ scale: 2 }));
    uniforms = (lastCall().content as StubMesh).shader.uniforms;
    expect(uniforms.uRadialSmear).toBeCloseTo((12 / (450 - 12)) * 2);
    r.destroy();
  });

  it("resizes its targets with the scene target rather than accumulating them", () => {
    const r = raw();
    r.update(cam());
    r.renderScale = 0.5;
    r.update(cam());

    expect(live.renderTextures).toBe(CITY_RENDER_TEXTURES + post.targets);
    r.destroy();
    expect(live).toEqual({ meshes: 0, geometries: 0, textures: 0, renderTextures: 0 });
  });

  it("redraws with a new metre scale without reallocating the renderer", () => {
    const r = make();
    const camera = cam();
    r.update(camera);
    const before = renderCalls;

    r.pixelsPerMetre = 40;
    r.update(camera);

    expect(renderCalls).toBe(before + CITY_PASSES + post.passesOff);
    expect(renderedContent?.children[0]?.shader.uniforms.uPixelsPerMetre).toBe(40);
    expect(r.stats()).toMatchObject({ pixelsPerMetre: 40 });
    expect(() => {
      r.pixelsPerMetre = 0;
    }).toThrow(/positive/i);
    r.destroy();
  });

  it("reuses settled-frame capacity while post-processing the smaller moving frame", () => {
    const r = raw();
    r.supersample = 2;
    const camera = cam();

    r.update(camera, FRAME_QUALITY.MOTION);

    const scene = renderLog[0]?.options.renderTexture as {
      width: number;
      height: number;
      noFrame: boolean;
      baseTexture: { width: number; height: number };
    };
    const output = lastCall().options.renderTexture as typeof scene;
    const threshold = (renderLog[CITY_PASSES]?.content as StubMesh).shader.uniforms;
    const composite = (lastCall().content as StubMesh).shader.uniforms;
    expect(scene).toMatchObject({ width: 3440, height: 1440 });
    expect(scene.baseTexture).toEqual({ width: 6880, height: 2880 });
    expect(output).toMatchObject({ width: 3440, height: 1440 });
    expect(output.baseTexture).toEqual({ width: 6880, height: 2880 });
    expect(scene.noFrame).toBe(false);
    expect(output.noFrame).toBe(false);
    expect(Array.from(threshold.uSceneUvScale as Float32Array)).toEqual([0.5, 0.5]);
    expect(Array.from(composite.uBloomUvScale as Float32Array)).toEqual([0.5, 0.5]);
    expect(Array.from(composite.uWideUvScale as Float32Array)).toEqual([0.5, 0.5]);
    expect(live.renderTextures).toBe(CITY_RENDER_TEXTURES + post.targets);

    const afterMotion = renderCalls;
    r.update(camera, FRAME_QUALITY.SETTLED);

    const settledScene = renderLog[afterMotion]?.options.renderTexture as typeof scene;
    const settledOutput = lastCall().options.renderTexture as typeof scene;
    const settledComposite = (lastCall().content as StubMesh).shader.uniforms;
    expect(settledScene).toBe(scene);
    expect(settledOutput).toBe(output);
    expect(settledScene).toMatchObject({ width: 6880, height: 2880 });
    expect(Array.from(settledComposite.uSceneUvScale as Float32Array)).toEqual([1, 1]);
    expect(Array.from(settledComposite.uShadowUvScale as Float32Array)).toEqual([1, 1]);
    expect(Array.from(settledComposite.uMaskUvScale as Float32Array)).toEqual([1, 1]);
    expect(live.renderTextures).toBe(CITY_RENDER_TEXTURES + post.targets);
    r.destroy();
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
    expect(renderCalls).toBe(before + CITY_PASSES + post.passesOn);
    expect(r.stats()).toMatchObject({ bloomStrength: 0.4 });
    r.destroy();
  });
});

describe("CityRenderer supersampling", () => {
  it("sizes every target from the effective scale and reports both dials", () => {
    const r = make();
    r.renderScale = 0.75;
    r.supersample = 2;
    r.update(cam({ scale: 4 }));

    const scene = renderLog[0]?.options.renderTexture as { width: number; height: number };
    const mask = renderLog[1]?.options.renderTexture as { width: number; height: number };
    const shadow = renderLog[2]?.options.renderTexture as { width: number; height: number };
    const uniforms = renderedContent?.children[0]?.shader.uniforms;
    expect(scene).toMatchObject({ width: 5160, height: 2160 });
    expect(mask).toMatchObject({ width: 5160, height: 2160 });
    expect(shadow).toMatchObject({ width: 1290, height: 540 });
    expect(uniforms?.uScreenPxPerMetre).toBe(25 * 4 * 1.5);
    expect(r.stats()).toMatchObject({
      renderScale: 0.75,
      supersample: 2,
      effectiveRenderScale: 1.5,
      targetSize: [5160, 2160],
      shadowTargetSize: [1290, 540]
    });
    r.destroy();
  });

  it("clamps supersampling at 2x and rebuilds targets only when it changes", () => {
    const r = make();
    const camera = cam();
    r.update(camera);
    const firstTarget = renderLog[0]?.options.renderTexture;
    const afterFirst = renderCalls;

    r.supersample = 3;
    r.update(camera);
    expect(r.supersample).toBe(2);
    expect(renderCalls).toBe(afterFirst + CITY_PASSES + post.passesOff);
    expect(renderLog[afterFirst]?.options.renderTexture).not.toBe(firstTarget);
    expect(r.stats()).toMatchObject({
      effectiveRenderScale: 2,
      targetSize: [6880, 2880]
    });
    expect(live.renderTextures).toBe(CITY_RENDER_TEXTURES + post.targets);

    const afterSecond = renderCalls;
    r.supersample = 2;
    r.update(camera);
    expect(renderCalls).toBe(afterSecond);
    r.destroy();
  });
});

describe("CityRenderer frame quality", () => {
  it("uses the base target while moving and fills its reserved supersampled frame once settled", () => {
    const r = make();
    r.renderScale = 0.75;
    r.supersample = 2;
    r.setChunks([detailChunk("0,0", NEAR, 3, 5)]);
    const camera = cam({ scale: 4 });

    r.update(camera, FRAME_QUALITY.MOTION);

    const target = renderLog[0]?.options.renderTexture as {
      width: number;
      height: number;
      noFrame: boolean;
      baseTexture: { width: number; height: number };
    };
    const shadow = renderLog[4]?.options.renderTexture as typeof target;
    const movingUniforms = (renderLog[0]?.content as StubContainer).children[0]?.shader.uniforms;
    expect(target).toMatchObject({ width: 2580, height: 1080 });
    expect(target.baseTexture).toEqual({ width: 5160, height: 2160 });
    expect(target.noFrame).toBe(false);
    expect(shadow).toMatchObject({ width: 645, height: 270 });
    expect(shadow.baseTexture).toEqual({ width: 1290, height: 540 });
    expect(renderLog[4]?.content).toBe(renderLog[0]?.content);
    expect(movingUniforms?.uDetailQuality).toBe(1);
    expect(r.stats()).toMatchObject({
      frameQuality: FRAME_QUALITY.MOTION,
      activeRenderScale: 0.75,
      detailTriangles: 5,
      targetCapacity: [5160, 2160]
    });

    const afterMotion = renderCalls;
    r.update(camera, FRAME_QUALITY.MOTION);
    expect(renderCalls).toBe(afterMotion);

    r.update(camera, FRAME_QUALITY.SETTLED);

    const settledUniforms = (renderLog[afterMotion]?.content as StubContainer).children[0]?.shader
      .uniforms;
    // Six city passes, not CITY_PASSES: this fixture has a detail mesh, so colour, mask and
    // shadow each draw twice.
    expect(renderCalls).toBe(afterMotion + 6 + post.passesOff);
    expect(renderLog[afterMotion]?.options.renderTexture).toBe(target);
    expect(target).toMatchObject({ width: 5160, height: 2160 });
    expect(settledUniforms?.uDetailQuality).toBe(1);
    expect(r.stats()).toMatchObject({
      frameQuality: FRAME_QUALITY.SETTLED,
      activeRenderScale: 1.5,
      detailTriangles: 5,
      targetSize: [5160, 2160]
    });

    const afterSettled = renderCalls;
    r.update(camera, FRAME_QUALITY.SETTLED);
    expect(renderCalls).toBe(afterSettled);
    r.destroy();
  });

  it("culls moving detail below 3 screen pixels per metre and forces it when settled", () => {
    const r = make();
    r.setChunks([detailChunk("0,0", NEAR, 3, 5)]);
    const camera = cam({ scale: 0.1 });

    r.update(camera, FRAME_QUALITY.MOTION);
    expect(r.stats()).toMatchObject({ detailTriangles: 0 });

    r.update(camera, FRAME_QUALITY.SETTLED);
    expect(r.stats()).toMatchObject({ detailTriangles: 5 });
    r.destroy();
  });

  it("owns and releases optional detail meshes independently from base geometry", () => {
    const r = make();
    r.setChunks([detailChunk("0,0", NEAR, 3, 5)]);

    expect(live.meshes).toBe(2 + OVERLAY_QUAD + post.quads);
    expect(r.stats()).toMatchObject({ trianglesTotal: 8, detailTrianglesTotal: 5 });

    r.removeChunk("0,0");
    expect(live.meshes).toBe(OVERLAY_QUAD + post.quads);
    expect(live.geometries).toBe(OVERLAY_QUAD + post.quads);
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
    expect(renderCalls).toBe(afterFirst + CITY_PASSES + post.passesOff);

    r.removeChunk("0,0");
    r.update(cam());
    expect(renderCalls).toBe(afterFirst + (CITY_PASSES + post.passesOff) * 2);

    r.clearChunks();
    r.update(cam());
    expect(renderCalls).toBe(afterFirst + (CITY_PASSES + post.passesOff) * 3);
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
    expect(renderCalls).toBe(afterAutomatic + CITY_PASSES + post.passesOff);
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
    expect(renderCalls).toBe(afterDolly + CITY_PASSES + post.passesOff);
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
    expect(live.meshes).toBe(OVERLAY_QUAD + post.quads);
    r.destroy();
  });
});
