import { CAMERA_ZOOM_MODE, type CameraZoomMode } from "../constants.js";
import {
  cameraEquals,
  cloneCamera,
  offscreenTransform,
  visibleWorldRect,
  type CameraState
} from "../core/camera.js";
import type { MeshBuffers } from "../core/geom/mesh.js";
import type { Rect } from "../core/geom/types.js";
import { dollyLeanStrength } from "../core/lean-curve.js";
import { BloomChain } from "./bloom.js";
import {
  UNCULLED_BOUNDS,
  WHOLE_CITY_CHUNK_ID,
  visibleChunkIds,
  type ChunkGeometry
} from "./chunk-culling.js";
import { CityMesh } from "./city-mesh.js";
import { NeonMesh } from "./neon-mesh.js";
import type { MaskFrame } from "./foot-probe.js";
import { PaletteTexture } from "./palette-texture.js";
import { ScreenQuad } from "./screen-quad.js";
import { CITY_OVERLAY_FRAG } from "./shaders/occlusion.js";

export type { ChunkGeometry } from "./chunk-culling.js";

const SHADOW_DOWNSAMPLE = 4;

export interface CityRendererOptions {
  pixelsPerMetre: number;
  cameraHeightMetres: number;
  cameraZoomMode: CameraZoomMode;
}

export interface LeanCalibrationPoint {
  zoom: number;
  leanStrength: number;
  automaticLeanStrength: number;
  leanOverride: number | null;
  cameraZoomMode: CameraZoomMode;
  cameraHeightMetres: number;
  pixelsPerMetre: number;
  screenWidth: number;
  screenHeight: number;
  renderScale: number;
}

interface LiveChunk {
  id: string;
  boundsPx: Rect;
  mesh: CityMesh;
  neon: NeonMesh | null;
}

/**
 * Renders the city into an offscreen target, then presents it as a single quad.
 *
 * The indirection buys three things the direct-to-stage approach cannot: we own the
 * depth buffer, the post chain is isolated from whatever filters other modules hang
 * on the shared groups, and render resolution becomes an independent dial.
 *
 * Geometry is held as a map of chunks; each update draws only those whose bounds meet
 * the visible world rect.
 */
export class CityRenderer {
  readonly display: any;
  /**
   * The buildings again, over whatever the host draws between this and `display`.
   *
   * Kept as a second display object rather than a filter on each token: it is the same
   * quad, texture and transform as `display`, so it cannot drift out of alignment, and
   * the host decides what it covers purely by where it is inserted.
   */
  readonly overlay: any;

  #renderer: any;
  #target: any = null;
  #maskTarget: any = null;
  #shadowTarget: any = null;
  #overlay: ScreenQuad;
  #content: any;
  #neonContent: any;
  #chunks = new Map<string, LiveChunk>();
  #palette: PaletteTexture;
  #bloom: BloomChain | null;
  #bloomStrength = 1.3;
  #lastCamera: CameraState | null = null;
  #contentDirty = true;
  #renderCount = 0;
  #chunksDrawn = 0;
  #visibleTriangles = 0;
  #visibleNeonTriangles = 0;
  #renderScale = 1;
  #supersample = 1;
  #pixelsPerMetre: number;
  #cameraHeightMetres: number;
  #cameraZoomMode: CameraZoomMode;
  #cameraZoom = 1;
  #automaticLeanStrength = 1;
  #leanStrength = 1;
  #leanOverride: number | null = null;

  constructor(
    renderer: any,
    buffers: MeshBuffers,
    palette: Uint8Array,
    options: CityRendererOptions
  ) {
    this.#renderer = renderer;
    this.#pixelsPerMetre = options.pixelsPerMetre;
    this.#cameraHeightMetres = options.cameraHeightMetres;
    this.#cameraZoomMode = options.cameraZoomMode;
    // One texture for every chunk: retinting a district must not mean an upload per chunk.
    this.#palette = new PaletteTexture(palette);
    this.#bloom = new BloomChain(renderer);

    this.#content = new PIXI.Container();
    this.#neonContent = new PIXI.Container();
    this.setGeometry(buffers);

    this.display = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.display.eventMode = "none";

    this.#overlay = new ScreenQuad(CITY_OVERLAY_FRAG, {
      uCity: PIXI.Texture.EMPTY,
      uMask: PIXI.Texture.EMPTY
    });
    // Unlike the post chain this one lands on top of foreign content, so it must blend.
    this.#overlay.display.state.blend = true;
    this.#overlay.display.visible = false;
    this.#overlay.display.eventMode = "none";
    this.overlay = this.#overlay.display;
  }

  /** Resolution multiplier for the offscreen pass. Lower trades sharpness for frame time. */
  get renderScale(): number {
    return this.#renderScale;
  }

  set renderScale(value: number) {
    const clamped = Math.min(1, Math.max(0.25, value));
    if (clamped === this.#renderScale) return;
    this.#renderScale = clamped;
    this.#releaseTarget();
    this.#contentDirty = true;
  }

  get supersample(): number {
    return this.#supersample;
  }

  set supersample(value: number) {
    const clamped = Math.min(2, Math.max(1, value));
    if (clamped === this.#supersample) return;
    this.#supersample = clamped;
    this.#releaseTarget();
    this.#contentDirty = true;
  }

  /** Virtual camera altitude. Lower leans buildings harder; the dial on the fake-3D look. */
  get cameraHeightMetres(): number {
    return this.#cameraHeightMetres;
  }

  set cameraHeightMetres(value: number) {
    const clamped = Math.max(50, value);
    if (clamped === this.#cameraHeightMetres) return;
    this.#cameraHeightMetres = clamped;
    this.#contentDirty = true;
  }

  get cameraZoomMode(): CameraZoomMode {
    return this.#cameraZoomMode;
  }

  set cameraZoomMode(value: CameraZoomMode) {
    if (value === this.#cameraZoomMode) return;
    this.#cameraZoomMode = value;
    this.#contentDirty = true;
  }

  get leanOverride(): number | null {
    return this.#leanOverride;
  }

  set leanOverride(value: number | null) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error("Lean override must be a finite non-negative number or null.");
    }
    if (value === this.#leanOverride) return;
    this.#leanOverride = value;
    this.#contentDirty = true;
  }

  leanCalibrationPoint(): LeanCalibrationPoint {
    const camera = this.#lastCamera;
    if (camera === null) throw new Error("The city has not rendered a camera frame yet.");
    const leanStrength =
      this.#cameraZoomMode === CAMERA_ZOOM_MODE.DOLLY
        ? (this.#leanOverride ?? this.#automaticLeanStrength)
        : 1;
    return {
      zoom: this.#cameraZoom,
      leanStrength,
      automaticLeanStrength: this.#automaticLeanStrength,
      leanOverride: this.#leanOverride,
      cameraZoomMode: this.#cameraZoomMode,
      cameraHeightMetres: this.#cameraHeightMetres,
      pixelsPerMetre: this.#pixelsPerMetre,
      screenWidth: camera.screenWidth,
      screenHeight: camera.screenHeight,
      renderScale: this.#renderScale
    };
  }

  get bloomEnabled(): boolean {
    return this.#bloom !== null;
  }

  set bloomEnabled(value: boolean) {
    const bloom = this.#bloom;
    if (value === (bloom !== null)) return;
    if (bloom === null) {
      this.#bloom = new BloomChain(this.#renderer);
    } else {
      bloom.destroy();
      this.#bloom = null;
      // WHY: display.texture is the composite target that destroy just released.
      this.display.texture = this.#target ?? PIXI.Texture.EMPTY;
    }
    this.#contentDirty = true;
  }

  get bloomStrength(): number {
    return this.#bloomStrength;
  }

  set bloomStrength(value: number) {
    const clamped = Math.max(0, value);
    if (clamped === this.#bloomStrength) return;
    this.#bloomStrength = clamped;
    this.#contentDirty = true;
  }

  markContentDirty(): void {
    this.#contentDirty = true;
  }

  /**
   * Swap in regenerated whole-city geometry without tearing down the render target.
   *
   * Mixing rule: this is an ordinary chunk under a reserved id with bounds that never
   * cull, so `setChunks`/`clearChunks`/`removeChunk` drop it exactly like any other.
   */
  setGeometry(buffers: MeshBuffers): void {
    this.setChunk({ id: WHOLE_CITY_CHUNK_ID, mesh: buffers, boundsPx: UNCULLED_BOUNDS });
  }

  /** Replace the whole chunk set. Every displaced mesh is destroyed. */
  setChunks(chunks: ChunkGeometry[]): void {
    this.clearChunks();
    for (const chunk of chunks) this.setChunk(chunk);
  }

  /** Add a chunk, or replace the one already under that id. */
  setChunk(chunk: ChunkGeometry): void {
    this.removeChunk(chunk.id);

    const mesh = new CityMesh(chunk.mesh, this.#palette);
    this.#content.addChild(mesh.display);

    let neon: NeonMesh | null = null;
    if (chunk.neon !== undefined && chunk.neon.triangleCount > 0) {
      neon = new NeonMesh(chunk.neon, this.#palette);
      this.#neonContent.addChild(neon.display);
    }

    this.#chunks.set(chunk.id, { id: chunk.id, boundsPx: chunk.boundsPx, mesh, neon });
    this.#contentDirty = true;
  }

  removeChunk(id: string): void {
    const chunk = this.#chunks.get(id);
    if (chunk === undefined) return;
    this.#chunks.delete(id);
    this.#content.removeChild(chunk.mesh.display);
    chunk.mesh.destroy();
    if (chunk.neon !== null) {
      this.#neonContent.removeChild(chunk.neon.display);
      chunk.neon.destroy();
    }
    this.#contentDirty = true;
  }

  clearChunks(): void {
    for (const id of [...this.#chunks.keys()]) this.removeChunk(id);
  }

  updatePalette(palette: Uint8Array): void {
    this.#palette.update(palette);
    this.#contentDirty = true;
  }

  /** The silhouette the overlay clips to, for asking whether a ground point is hidden. */
  maskFrame(): MaskFrame | null {
    const camera = this.#lastCamera;
    if (camera === null || this.#maskTarget === null) return null;
    const view = visibleWorldRect(camera);
    return {
      texture: this.#maskTarget,
      viewX: view.x,
      viewY: view.y,
      viewWidth: view.width,
      viewHeight: view.height
    };
  }

  update(camera: CameraState): void {
    if (camera.screenWidth <= 0 || camera.screenHeight <= 0) return;
    const resized = this.#ensureTarget(camera);
    if (!resized && !this.#contentDirty && cameraEquals(this.#lastCamera, camera)) return;

    const view = visibleWorldRect(camera);
    const t = offscreenTransform(camera, this.#effectiveRenderScale());
    const zoom = camera.scale > 0 ? camera.scale : 1;
    const automaticLeanStrength = dollyLeanStrength(zoom);
    const leanStrength =
      this.#cameraZoomMode === CAMERA_ZOOM_MODE.DOLLY
        ? (this.#leanOverride ?? automaticLeanStrength)
        : 1;
    const cameraHeightPx = this.#cameraHeightMetres * this.#pixelsPerMetre;
    this.#cameraZoom = zoom;
    this.#automaticLeanStrength = automaticLeanStrength;
    this.#leanStrength = leanStrength;
    const uniforms = {
      pivotX: camera.pivotX,
      pivotY: camera.pivotY,
      pixelsPerMetre: this.#pixelsPerMetre,
      cameraHeightPx,
      leanStrength,
      // Generous, because geometry outside the view still leans into it. Depth is
      // 24-bit, so the slack costs no meaningful precision.
      depthFar: 2 * Math.hypot(0.5 * Math.hypot(view.width, view.height), cameraHeightPx),
      screenPxPerMetre: this.#pixelsPerMetre * t.scale
    };

    const drawn = new Set(visibleChunkIds(this.#chunks.values(), view));
    this.#chunksDrawn = drawn.size;
    this.#visibleTriangles = 0;
    this.#visibleNeonTriangles = 0;
    for (const chunk of this.#chunks.values()) {
      const draw = drawn.has(chunk.id);
      chunk.mesh.display.visible = draw;
      if (chunk.neon !== null) chunk.neon.display.visible = draw;
      if (!draw) continue;
      chunk.mesh.setCamera(uniforms);
      this.#visibleTriangles += chunk.mesh.triangleCount;
      if (chunk.neon !== null) {
        chunk.neon.setCamera(uniforms);
        this.#visibleNeonTriangles += chunk.neon.triangleCount;
      }
    }

    this.#content.position.set(t.x, t.y);
    this.#content.scale.set(t.scale);
    this.#neonContent.position.set(t.x, t.y);
    this.#neonContent.scale.set(t.scale);

    this.#renderer.render(this.#content, { renderTexture: this.#target, clear: true });
    // WHY: neon depth-tests against the opaque pass, so every chunk's buildings must have
    // written depth first — drawing a chunk's glow before a later chunk's walls shows it
    // through them. `clear:false` skips the clear entirely, so that depth survives.
    if (this.#neonContent.children.length > 0) {
      this.#renderer.render(this.#neonContent, { renderTexture: this.#target, clear: false });
    }

    for (const chunk of this.#chunks.values()) chunk.mesh.setMaskPass(true);
    try {
      this.#renderer.render(this.#content, { renderTexture: this.#maskTarget, clear: true });
    } finally {
      for (const chunk of this.#chunks.values()) chunk.mesh.setMaskPass(false);
    }

    this.#content.position.set(t.x / SHADOW_DOWNSAMPLE, t.y / SHADOW_DOWNSAMPLE);
    this.#content.scale.set(t.scale / SHADOW_DOWNSAMPLE);
    for (const chunk of this.#chunks.values()) chunk.mesh.setShadowPass(true);
    try {
      this.#renderer.render(this.#content, { renderTexture: this.#shadowTarget, clear: true });
    } finally {
      for (const chunk of this.#chunks.values()) chunk.mesh.setShadowPass(false);
      this.#content.position.set(t.x, t.y);
      this.#content.scale.set(t.scale);
    }

    this.display.texture =
      this.#bloom === null
        ? this.#target
        : this.#bloom.render(
            this.#target,
            this.#bloomStrength,
            this.#shadowTarget,
            this.#maskTarget
          );
    this.display.position.set(view.x, view.y);
    this.display.width = view.width;
    this.display.height = view.height;

    this.#overlay.uniforms.uCity = this.display.texture;
    this.#overlay.uniforms.uMask = this.#maskTarget;
    this.#overlay.display.position.set(view.x, view.y);
    this.#overlay.display.scale.set(view.width, view.height);
    this.#overlay.display.visible = this.#chunksDrawn > 0;

    this.#lastCamera = cloneCamera(camera);
    this.#contentDirty = false;
    this.#renderCount++;
  }

  stats(): Record<string, unknown> {
    let trianglesTotal = 0;
    for (const chunk of this.#chunks.values()) trianglesTotal += chunk.mesh.triangleCount;
    return {
      renderCount: this.#renderCount,
      renderScale: this.#renderScale,
      supersample: this.#supersample,
      effectiveRenderScale: this.#effectiveRenderScale(),
      cameraHeightMetres: this.#cameraHeightMetres,
      cameraZoomMode: this.#cameraZoomMode,
      cameraZoom: this.#cameraZoom,
      automaticLeanStrength: this.#automaticLeanStrength,
      leanStrength: this.#leanStrength,
      leanOverride: this.#leanOverride,
      pixelsPerMetre: this.#pixelsPerMetre,
      chunks: this.#chunks.size,
      chunksDrawn: this.#chunksDrawn,
      triangles: this.#visibleTriangles,
      neonTriangles: this.#visibleNeonTriangles,
      trianglesTotal,
      bloom: this.#bloom !== null,
      bloomStrength: this.#bloomStrength,
      targetSize: this.#target ? [this.#target.width, this.#target.height] : null,
      shadowTargetSize: this.#shadowTarget
        ? [this.#shadowTarget.width, this.#shadowTarget.height]
        : null
    };
  }

  destroy(): void {
    this.#bloom?.destroy();
    this.#bloom = null;
    this.#releaseTarget();
    this.clearChunks();
    this.#overlay.destroy();
    this.#palette.destroy();
    this.#content.destroy({ children: true });
    this.#neonContent.destroy({ children: true });
    this.display.destroy();
    this.#lastCamera = null;
  }

  #ensureTarget(camera: CameraState): boolean {
    const effectiveScale = this.#effectiveRenderScale();
    const w = Math.ceil(camera.screenWidth * effectiveScale);
    const h = Math.ceil(camera.screenHeight * effectiveScale);

    if (this.#target === null) {
      this.#target = PIXI.RenderTexture.create({
        width: w,
        height: h,
        resolution: this.#renderer.resolution,
        format: PIXI.FORMATS.RGBA,
        type: PIXI.TYPES.HALF_FLOAT,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      this.#target.framebuffer.enableDepth();
      this.#maskTarget = PIXI.RenderTexture.create({
        width: w,
        height: h,
        resolution: this.#renderer.resolution,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      this.#shadowTarget = PIXI.RenderTexture.create({
        width: Math.max(1, Math.ceil(w / SHADOW_DOWNSAMPLE)),
        height: Math.max(1, Math.ceil(h / SHADOW_DOWNSAMPLE)),
        resolution: this.#renderer.resolution,
        format: PIXI.FORMATS.RED,
        type: PIXI.TYPES.UNSIGNED_BYTE,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      this.display.texture = this.#target;
      return true;
    }

    if (this.#target.width !== w || this.#target.height !== h) {
      this.#target.resize(w, h);
      this.#maskTarget.resize(w, h);
      this.#shadowTarget.resize(
        Math.max(1, Math.ceil(w / SHADOW_DOWNSAMPLE)),
        Math.max(1, Math.ceil(h / SHADOW_DOWNSAMPLE))
      );
      return true;
    }
    return false;
  }

  #effectiveRenderScale(): number {
    return Math.min(2, this.#renderScale * this.#supersample);
  }

  #releaseTarget(): void {
    if (this.#target !== null) {
      this.display.texture = PIXI.Texture.EMPTY;
      this.#target.destroy(true);
    }
    this.#maskTarget?.destroy(true);
    this.#shadowTarget?.destroy(true);
    this.#overlay.display.visible = false;
    this.#target = null;
    this.#maskTarget = null;
    this.#shadowTarget = null;
  }
}
