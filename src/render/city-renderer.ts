import {
  cameraEquals,
  cloneCamera,
  offscreenTransform,
  visibleWorldRect,
  type CameraState,
  type Rect
} from "../core/camera.js";
import { createDemoBlock } from "./demo-block.js";

/**
 * Renders the city into an offscreen target, then presents it as a single quad.
 *
 * The indirection buys three things the direct-to-stage approach cannot: we own the
 * depth buffer (needed by the extrusion pass in S1), the post chain is isolated from
 * whatever filters other modules hang on the shared groups, and render resolution
 * becomes an independent dial from display resolution.
 */
export class CityRenderer {
  readonly display: any;

  #renderer: any;
  #target: any = null;
  #content: any;
  #lastCamera: CameraState | null = null;
  #contentDirty = true;
  #renderCount = 0;
  #renderScale = 1;

  constructor(renderer: any, demoRect: Rect) {
    this.#renderer = renderer;

    this.#content = new PIXI.Container();
    this.#content.addChild(createDemoBlock(demoRect));

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

  markContentDirty(): void {
    this.#contentDirty = true;
  }

  update(camera: CameraState): void {
    if (camera.screenWidth <= 0 || camera.screenHeight <= 0) return;
    const resized = this.#ensureTarget(camera);
    if (!resized && !this.#contentDirty && cameraEquals(this.#lastCamera, camera)) return;

    const t = offscreenTransform(camera, this.#renderScale);
    this.#content.position.set(t.x, t.y);
    this.#content.scale.set(t.scale);
    this.#renderer.render(this.#content, { renderTexture: this.#target, clear: true });

    const view = visibleWorldRect(camera);
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
      targetSize: this.#target ? [this.#target.width, this.#target.height] : null,
      contentChildren: this.#content.children.length
    };
  }

  destroy(): void {
    this.#releaseTarget();
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
