import {
  cameraEquals,
  cloneCamera,
  offscreenTransform,
  visibleWorldRect,
  type CameraState
} from "../core/camera.js";
import type { MeshBuffers } from "../core/geom/extrude.js";
import { CityMesh } from "./city-mesh.js";

export interface CityRendererOptions {
  pixelsPerMetre: number;
  cameraHeightMetres: number;
}

/**
 * Renders the city into an offscreen target, then presents it as a single quad.
 *
 * The indirection buys three things the direct-to-stage approach cannot: we own the
 * depth buffer, the post chain is isolated from whatever filters other modules hang
 * on the shared groups, and render resolution becomes an independent dial.
 */
export class CityRenderer {
  readonly display: any;

  #renderer: any;
  #target: any = null;
  #content: any;
  #mesh: CityMesh;
  #lastCamera: CameraState | null = null;
  #contentDirty = true;
  #renderCount = 0;
  #renderScale = 1;
  #pixelsPerMetre: number;
  #cameraHeightMetres: number;

  constructor(
    renderer: any,
    buffers: MeshBuffers,
    palette: Uint8Array,
    options: CityRendererOptions
  ) {
    this.#renderer = renderer;
    this.#pixelsPerMetre = options.pixelsPerMetre;
    this.#cameraHeightMetres = options.cameraHeightMetres;

    this.#mesh = new CityMesh(buffers, palette);
    this.#content = new PIXI.Container();
    this.#content.addChild(this.#mesh.display);

    this.display = new PIXI.Sprite(PIXI.Texture.EMPTY);
    this.display.eventMode = "none";
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

  markContentDirty(): void {
    this.#contentDirty = true;
  }

  updatePalette(palette: Uint8Array): void {
    this.#mesh.updatePalette(palette);
    this.#contentDirty = true;
  }

  update(camera: CameraState): void {
    if (camera.screenWidth <= 0 || camera.screenHeight <= 0) return;
    const resized = this.#ensureTarget(camera);
    if (!resized && !this.#contentDirty && cameraEquals(this.#lastCamera, camera)) return;

    const view = visibleWorldRect(camera);
    const cameraHeightPx = this.#cameraHeightMetres * this.#pixelsPerMetre;
    this.#mesh.setCamera({
      pivotX: camera.pivotX,
      pivotY: camera.pivotY,
      pixelsPerMetre: this.#pixelsPerMetre,
      cameraHeightPx,
      // Generous, because geometry outside the view still leans into it. Depth is
      // 24-bit, so the slack costs no meaningful precision.
      depthFar: 2 * Math.hypot(0.5 * Math.hypot(view.width, view.height), cameraHeightPx)
    });

    const t = offscreenTransform(camera, this.#renderScale);
    this.#content.position.set(t.x, t.y);
    this.#content.scale.set(t.scale);
    this.#renderer.render(this.#content, { renderTexture: this.#target, clear: true });

    this.display.position.set(view.x, view.y);
    this.display.width = view.width;
    this.display.height = view.height;

    this.#lastCamera = cloneCamera(camera);
    this.#contentDirty = false;
    this.#renderCount++;
  }

  stats(): Record<string, unknown> {
    return {
      renderCount: this.#renderCount,
      renderScale: this.#renderScale,
      cameraHeightMetres: this.#cameraHeightMetres,
      pixelsPerMetre: this.#pixelsPerMetre,
      triangles: this.#mesh.triangleCount,
      targetSize: this.#target ? [this.#target.width, this.#target.height] : null
    };
  }

  destroy(): void {
    this.#releaseTarget();
    this.#content.removeChildren();
    this.#mesh.destroy();
    this.#content.destroy({ children: true });
    this.display.destroy();
    this.#lastCamera = null;
  }

  #ensureTarget(camera: CameraState): boolean {
    const w = Math.ceil(camera.screenWidth * this.#renderScale);
    const h = Math.ceil(camera.screenHeight * this.#renderScale);

    if (this.#target === null) {
      this.#target = PIXI.RenderTexture.create({
        width: w,
        height: h,
        resolution: this.#renderer.resolution
      });
      this.#target.framebuffer.enableDepth();
      this.display.texture = this.#target;
      return true;
    }

    if (this.#target.width !== w || this.#target.height !== h) {
      this.#target.resize(w, h);
      return true;
    }
    return false;
  }

  #releaseTarget(): void {
    if (this.#target === null) return;
    this.display.texture = PIXI.Texture.EMPTY;
    this.#target.destroy(true);
    this.#target = null;
  }
}
