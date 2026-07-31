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
import { DEFAULT_LOOK_DIALS, type LookDials } from "./look-dials.js";
import {
  UNCULLED_BOUNDS,
  WHOLE_CITY_CHUNK_ID,
  visibleChunkIds,
  type ChunkGeometry
} from "./chunk-culling.js";
import { CityMesh } from "./city-mesh.js";
import {
  FRAME_QUALITY,
  frameQualityProfile,
  type FrameQuality
} from "./frame-quality.js";
import { NeonMesh } from "./neon-mesh.js";
import type { MaskFrame } from "./foot-probe.js";
import { PaletteTexture } from "./palette-texture.js";
import { ScreenQuad } from "./screen-quad.js";
import { CITY_OVERLAY_FRAG } from "./shaders/occlusion.js";
import { RAIN_FALL_M } from "./shaders/weather.js";
import { WeatherOverlay } from "./weather-overlay.js";

export type { ChunkGeometry } from "./chunk-culling.js";

const SHADOW_DOWNSAMPLE = 4;
const DETAIL_MIN_SCREEN_PX_PER_METRE = 3;

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
  detail: CityMesh | null;
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
  /**
   * Rain, splashes and drifting haze, animated over the presented city.
   *
   * A third display object rather than a term in the post chain: the settled frame is cached and a
   * stationary frame draws nothing, so a time-varying composite would charge the whole city cost
   * at 60 fps forever. Inserted above the token layers, since rain falls in front of people.
   */
  readonly weather: any;

  #renderer: any;
  #target: any = null;
  #maskTarget: any = null;
  #shadowTarget: any = null;
  #overlay: ScreenQuad;
  #content: any;
  #detailContent: any;
  #neonContent: any;
  #blankContent: any;
  #chunks = new Map<string, LiveChunk>();
  #palette: PaletteTexture;
  #bloom: BloomChain;
  #weather: WeatherOverlay;
  /** One object, shared with the bloom chain and the weather quad. Mutated in place to retune. */
  #dials: LookDials = { ...DEFAULT_LOOK_DIALS };
  #bloomStrength = 1.3;
  #rainStrength = 1;
  #lastAnimateS: number | null = null;
  #lastCamera: CameraState | null = null;
  #lastQuality: FrameQuality | null = null;
  #contentDirty = true;
  #renderCount = 0;
  #chunksDrawn = 0;
  #visibleTriangles = 0;
  #visibleDetailTriangles = 0;
  #visibleNeonTriangles = 0;
  #renderScale = 1;
  #supersample = 1;
  #pivotUv = new Float32Array([0.5, 0.5]);
  #overlayUvScale = new Float32Array([1, 1]);
  #activeRenderScale = 1;
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
    this.#bloom = new BloomChain(renderer, this.#dials);

    this.#content = new PIXI.Container();
    this.#detailContent = new PIXI.Container();
    this.#neonContent = new PIXI.Container();
    this.#blankContent = new PIXI.Container();
    this.setGeometry(buffers);

    this.display = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.display.eventMode = "none";

    this.#overlay = new ScreenQuad(CITY_OVERLAY_FRAG, {
      uCity: PIXI.Texture.EMPTY,
      uMask: PIXI.Texture.EMPTY,
      uUvScale: this.#overlayUvScale
    });
    // Unlike the post chain this one lands on top of foreign content, so it must blend.
    this.#overlay.display.state.blend = true;
    this.#overlay.display.visible = false;
    this.#overlay.display.eventMode = "none";
    this.overlay = this.#overlay.display;

    this.#weather = new WeatherOverlay(this.#pivotUv, this.#overlayUvScale);
    this.weather = this.#weather.display;
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

  /** Off skips the blur passes only — the composite always runs, so the chain always exists. */
  get bloomEnabled(): boolean {
    return this.#bloom.bloomEnabled;
  }

  set bloomEnabled(value: boolean) {
    if (value === this.#bloom.bloomEnabled) return;
    this.#bloom.bloomEnabled = value;
    this.#contentDirty = true;
  }

  /** Live look dials, mutated in place. Call `markContentDirty` after touching them. */
  get lookDials(): LookDials {
    return this.#dials;
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

  /**
   * Weather intensity. 0 hides the overlay outright, so a dry night costs no fill.
   *
   * Deliberately does not dirty the content: the overlay is outside the frame cache and picks
   * this up on the next `animate`, so it retunes live even while the camera is parked.
   */
  get rainStrength(): number {
    return this.#rainStrength;
  }

  set rainStrength(value: number) {
    this.#rainStrength = Math.max(0, value);
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

    let detail: CityMesh | null = null;
    if (chunk.detail !== undefined && chunk.detail.triangleCount > 0) {
      detail = new CityMesh(chunk.detail, this.#palette);
      this.#detailContent.addChild(detail.display);
    }

    let neon: NeonMesh | null = null;
    if (chunk.neon !== undefined && chunk.neon.triangleCount > 0) {
      neon = new NeonMesh(chunk.neon, this.#palette);
      this.#neonContent.addChild(neon.display);
    }

    this.#chunks.set(chunk.id, { id: chunk.id, boundsPx: chunk.boundsPx, mesh, detail, neon });
    this.#contentDirty = true;
  }

  removeChunk(id: string): void {
    const chunk = this.#chunks.get(id);
    if (chunk === undefined) return;
    this.#chunks.delete(id);
    this.#content.removeChild(chunk.mesh.display);
    chunk.mesh.destroy();
    if (chunk.detail !== null) {
      this.#detailContent.removeChild(chunk.detail.display);
      chunk.detail.destroy();
    }
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

  update(camera: CameraState, quality: FrameQuality = FRAME_QUALITY.SETTLED): void {
    if (camera.screenWidth <= 0 || camera.screenHeight <= 0) return;
    const targetChanged = this.#ensureTarget(camera, quality);
    const qualityChanged = this.#lastQuality !== quality;
    if (
      !targetChanged &&
      !qualityChanged &&
      !this.#contentDirty &&
      cameraEquals(this.#lastCamera, camera)
    ) {
      return;
    }

    const profile = frameQualityProfile(quality);
    const view = visibleWorldRect(camera);
    const t = offscreenTransform(camera, this.#activeRenderScale);
    // The pivot lands on target pixel stage * effectiveScale of a target that is
    // screen * effectiveScale wide, so the scale cancels and this is just the stage fraction.
    this.#pivotUv[0] = camera.stageX / camera.screenWidth;
    this.#pivotUv[1] = camera.stageY / camera.screenHeight;
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
      screenPxPerMetre: this.#pixelsPerMetre * t.scale,
      detailQuality: profile.shaderDetail
    };

    const drawn = new Set(visibleChunkIds(this.#chunks.values(), view));
    const showDetail =
      profile.geometryDetail === "all" ||
      this.#pixelsPerMetre * zoom >= DETAIL_MIN_SCREEN_PX_PER_METRE;
    this.#chunksDrawn = drawn.size;
    this.#visibleTriangles = 0;
    this.#visibleDetailTriangles = 0;
    this.#visibleNeonTriangles = 0;
    for (const chunk of this.#chunks.values()) {
      const draw = drawn.has(chunk.id);
      chunk.mesh.display.visible = draw;
      if (chunk.detail !== null) chunk.detail.display.visible = draw && showDetail;
      if (chunk.neon !== null) chunk.neon.display.visible = draw;
      if (!draw) continue;
      chunk.mesh.setCamera(uniforms);
      this.#visibleTriangles += chunk.mesh.triangleCount;
      if (chunk.detail !== null && showDetail) {
        chunk.detail.setCamera(uniforms);
        this.#visibleDetailTriangles += chunk.detail.triangleCount;
      }
      if (chunk.neon !== null) {
        chunk.neon.setCamera(uniforms);
        this.#visibleNeonTriangles += chunk.neon.triangleCount;
      }
    }

    this.#content.position.set(t.x, t.y);
    this.#content.scale.set(t.scale);
    this.#detailContent.position.set(t.x, t.y);
    this.#detailContent.scale.set(t.scale);
    this.#neonContent.position.set(t.x, t.y);
    this.#neonContent.scale.set(t.scale);

    this.#renderer.render(this.#content, { renderTexture: this.#target, clear: true });
    if (this.#visibleDetailTriangles > 0) {
      this.#renderer.render(this.#detailContent, { renderTexture: this.#target, clear: false });
    }
    // WHY: neon depth-tests against the opaque pass, so every chunk's buildings must have
    // written depth first — drawing a chunk's glow before a later chunk's walls shows it
    // through them. `clear:false` skips the clear entirely, so that depth survives.
    if (this.#neonContent.children.length > 0) {
      this.#renderer.render(this.#neonContent, { renderTexture: this.#target, clear: false });
    }

    for (const chunk of this.#chunks.values()) {
      chunk.mesh.setMaskPass(true);
      chunk.detail?.setMaskPass(true);
    }
    try {
      this.#renderer.render(this.#content, { renderTexture: this.#maskTarget, clear: true });
      if (this.#visibleDetailTriangles > 0) {
        this.#renderer.render(this.#detailContent, {
          renderTexture: this.#maskTarget,
          clear: false
        });
      }
    } finally {
      for (const chunk of this.#chunks.values()) {
        chunk.mesh.setMaskPass(false);
        chunk.detail?.setMaskPass(false);
      }
    }

    if (profile.shadows) {
      this.#content.position.set(t.x / SHADOW_DOWNSAMPLE, t.y / SHADOW_DOWNSAMPLE);
      this.#content.scale.set(t.scale / SHADOW_DOWNSAMPLE);
      this.#detailContent.position.set(t.x / SHADOW_DOWNSAMPLE, t.y / SHADOW_DOWNSAMPLE);
      this.#detailContent.scale.set(t.scale / SHADOW_DOWNSAMPLE);
      for (const chunk of this.#chunks.values()) {
        chunk.mesh.setShadowPass(true);
        chunk.detail?.setShadowPass(true);
      }
      try {
        this.#renderer.render(this.#content, { renderTexture: this.#shadowTarget, clear: true });
        if (this.#visibleDetailTriangles > 0) {
          this.#renderer.render(this.#detailContent, {
            renderTexture: this.#shadowTarget,
            clear: false
          });
        }
      } finally {
        for (const chunk of this.#chunks.values()) {
          chunk.mesh.setShadowPass(false);
          chunk.detail?.setShadowPass(false);
        }
        this.#content.position.set(t.x, t.y);
        this.#content.scale.set(t.scale);
        this.#detailContent.position.set(t.x, t.y);
        this.#detailContent.scale.set(t.scale);
      }
    } else {
      this.#renderer.render(this.#blankContent, {
        renderTexture: this.#shadowTarget,
        clear: true
      });
    }

    this.display.texture = this.#bloom.render(
      this.#target,
      this.#bloomStrength,
      this.#shadowTarget,
      this.#maskTarget,
      this.#pivotUv
    );
    this.display.position.set(view.x, view.y);
    this.display.width = view.width;
    this.display.height = view.height;
    this.#setUvScale(this.#overlayUvScale, this.display.texture);

    this.#overlay.uniforms.uCity = this.display.texture;
    this.#overlay.uniforms.uMask = this.#maskTarget;
    this.#overlay.display.position.set(view.x, view.y);
    this.#overlay.display.scale.set(view.width, view.height);
    this.#overlay.display.visible = this.#chunksDrawn > 0;

    // WHY the raw scene target and not the composite: height and coverage live in the scene
    // target's alpha, and the composite writes a flat 1.0 there. Handing it the presented texture
    // instead type-checks, renders, and silently reports every pixel as ground.
    this.#weather.setFrame(
      this.display.texture,
      this.#target,
      view,
      this.#pixelsPerMetre,
      zoom,
      (RAIN_FALL_M / Math.max(this.#cameraHeightMetres - RAIN_FALL_M, 1)) * leanStrength
    );

    this.#lastCamera = cloneCamera(camera);
    this.#lastQuality = quality;
    this.#contentDirty = false;
    this.#renderCount++;
  }

  /**
   * One frame of weather, independent of whether the city redrew.
   *
   * Separate from `update` because that early-outs on a static camera — this is the whole reason
   * the animation lives in its own quad. Cheap: a clock, a drift offset and the dial uniforms.
   */
  animate(nowMs: number): void {
    const seconds = nowMs / 1000;
    const elapsed = this.#lastAnimateS === null ? 0 : seconds - this.#lastAnimateS;
    this.#lastAnimateS = seconds;
    this.#weather.advance(elapsed, this.#dials, this.#rainStrength);
    this.#weather.display.visible =
      this.#target !== null && this.#chunksDrawn > 0 && this.#rainStrength > 0;
  }

  stats(): Record<string, unknown> {
    let trianglesTotal = 0;
    let detailTrianglesTotal = 0;
    for (const chunk of this.#chunks.values()) {
      trianglesTotal += chunk.mesh.triangleCount;
      detailTrianglesTotal += chunk.detail?.triangleCount ?? 0;
    }
    return {
      renderCount: this.#renderCount,
      renderScale: this.#renderScale,
      supersample: this.#supersample,
      effectiveRenderScale: this.#settledRenderScale(),
      activeRenderScale: this.#activeRenderScale,
      frameQuality: this.#lastQuality,
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
      detailTriangles: this.#visibleDetailTriangles,
      neonTriangles: this.#visibleNeonTriangles,
      trianglesTotal: trianglesTotal + detailTrianglesTotal,
      detailTrianglesTotal,
      bloom: this.#bloom.bloomEnabled,
      bloomStrength: this.#bloomStrength,
      rainStrength: this.#rainStrength,
      lookDials: { ...this.#dials },
      targetSize: this.#target ? [this.#target.width, this.#target.height] : null,
      targetCapacity: this.#target
        ? [
            this.#target.baseTexture?.width ?? this.#target.width,
            this.#target.baseTexture?.height ?? this.#target.height
          ]
        : null,
      shadowTargetSize: this.#shadowTarget
        ? [this.#shadowTarget.width, this.#shadowTarget.height]
        : null
    };
  }

  destroy(): void {
    this.#bloom.destroy();
    this.#releaseTarget();
    this.clearChunks();
    this.#overlay.destroy();
    this.#weather.destroy();
    this.#palette.destroy();
    this.#content.destroy({ children: true });
    this.#detailContent.destroy({ children: true });
    this.#neonContent.destroy({ children: true });
    this.#blankContent.destroy({ children: true });
    this.display.destroy();
    this.#lastCamera = null;
    this.#lastQuality = null;
    this.#lastAnimateS = null;
  }

  #ensureTarget(camera: CameraState, quality: FrameQuality): boolean {
    const capacityScale = this.#settledRenderScale();
    this.#activeRenderScale = this.#renderScaleFor(quality);
    const capacityWidth = Math.ceil(camera.screenWidth * capacityScale);
    const capacityHeight = Math.ceil(camera.screenHeight * capacityScale);
    const width = Math.ceil(camera.screenWidth * this.#activeRenderScale);
    const height = Math.ceil(camera.screenHeight * this.#activeRenderScale);
    const capacityShadowWidth = Math.max(1, Math.ceil(capacityWidth / SHADOW_DOWNSAMPLE));
    const capacityShadowHeight = Math.max(1, Math.ceil(capacityHeight / SHADOW_DOWNSAMPLE));
    const shadowWidth = Math.max(1, Math.ceil(width / SHADOW_DOWNSAMPLE));
    const shadowHeight = Math.max(1, Math.ceil(height / SHADOW_DOWNSAMPLE));
    let changed = false;

    if (this.#target === null) {
      this.#target = PIXI.RenderTexture.create({
        width: capacityWidth,
        height: capacityHeight,
        resolution: this.#renderer.resolution,
        format: PIXI.FORMATS.RGBA,
        type: PIXI.TYPES.HALF_FLOAT,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      this.#target.framebuffer.enableDepth();
      this.#maskTarget = PIXI.RenderTexture.create({
        width: capacityWidth,
        height: capacityHeight,
        resolution: this.#renderer.resolution,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      this.#shadowTarget = PIXI.RenderTexture.create({
        width: capacityShadowWidth,
        height: capacityShadowHeight,
        resolution: this.#renderer.resolution,
        format: PIXI.FORMATS.RED,
        type: PIXI.TYPES.UNSIGNED_BYTE,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      // WHY: the scene target's alpha carries surface height for the composite to decode, so
      // presenting it directly renders the city translucent. Only the composite may be shown.
      this.display.texture = PIXI.Texture.EMPTY;
      changed = true;
    } else if (
      (this.#target.baseTexture?.width ?? this.#target.width) !== capacityWidth ||
      (this.#target.baseTexture?.height ?? this.#target.height) !== capacityHeight
    ) {
      this.#target.resize(capacityWidth, capacityHeight);
      this.#maskTarget.resize(capacityWidth, capacityHeight);
      this.#shadowTarget.resize(capacityShadowWidth, capacityShadowHeight);
      changed = true;
    }

    changed = this.#resizeFrame(this.#target, width, height) || changed;
    changed = this.#resizeFrame(this.#maskTarget, width, height) || changed;
    changed = this.#resizeFrame(this.#shadowTarget, shadowWidth, shadowHeight) || changed;
    return changed;
  }

  #settledRenderScale(): number {
    return Math.min(2, this.#renderScale * this.#supersample);
  }

  #renderScaleFor(quality: FrameQuality): number {
    return quality === FRAME_QUALITY.SETTLED ? this.#settledRenderScale() : this.#renderScale;
  }

  #resizeFrame(target: any, width: number, height: number): boolean {
    if (target.width === width && target.height === height) return false;
    // WHY: Pixi resets frameless targets to capacity after rendering. Keep an explicit active frame while reusing the allocation.
    target.noFrame = false;
    target.resize(width, height, false);
    return true;
  }

  #setUvScale(out: Float32Array, texture: any): void {
    out[0] = texture.width / (texture.baseTexture?.width ?? texture.width);
    out[1] = texture.height / (texture.baseTexture?.height ?? texture.height);
  }

  #releaseTarget(): void {
    if (this.#target !== null) {
      this.display.texture = PIXI.Texture.EMPTY;
      this.#target.destroy(true);
    }
    this.#maskTarget?.destroy(true);
    this.#shadowTarget?.destroy(true);
    this.#overlay.display.visible = false;
    this.#overlay.uniforms.uCity = PIXI.Texture.EMPTY;
    this.#overlay.uniforms.uMask = PIXI.Texture.EMPTY;
    this.#weather.clear();
    this.#target = null;
    this.#maskTarget = null;
    this.#shadowTarget = null;
  }
}
