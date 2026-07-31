import { ScreenQuad } from "./screen-quad.js";
import {
  BLUR_FRAG,
  COMPOSITE_FRAG,
  DOWNSAMPLE_FRAG,
  THRESHOLD_FRAG
} from "./shaders/post.js";

const NARROW_DOWNSAMPLE = 4;
const WIDE_DOWNSAMPLE = 16;
const WIDE_STRENGTH = 0.55;

/**
 * Threshold + downsample -> narrow and wide separable blurs -> composite.
 *
 * Owns its render targets and sizes them from whatever scene texture it is handed, so the
 * caller only has to hand back the same texture each frame.
 */
export class BloomChain {
  #renderer: any;
  #threshold: ScreenQuad;
  #blurH: ScreenQuad;
  #blurV: ScreenQuad;
  #downsampleWide: ScreenQuad;
  #wideBlurH: ScreenQuad;
  #wideBlurV: ScreenQuad;
  #composite: ScreenQuad;

  #bloomA: any = null;
  #bloomB: any = null;
  #wideA: any = null;
  #wideB: any = null;
  #out: any = null;
  #capacityWidth = 0;
  #capacityHeight = 0;
  #width = 0;
  #height = 0;

  #srcTexel = new Float32Array(2);
  #bloomTexel = new Float32Array(2);
  #wideTexel = new Float32Array(2);
  #sceneUvScale = new Float32Array([1, 1]);
  #bloomUvScale = new Float32Array([1, 1]);
  #wideUvScale = new Float32Array([1, 1]);
  #shadowUvScale = new Float32Array([1, 1]);
  #maskUvScale = new Float32Array([1, 1]);

  constructor(renderer: any) {
    this.#renderer = renderer;

    this.#threshold = new ScreenQuad(THRESHOLD_FRAG, {
      uScene: PIXI.Texture.EMPTY,
      uSrcTexel: this.#srcTexel,
      uSceneUvScale: this.#sceneUvScale
    });
    this.#blurH = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#bloomTexel,
      uTexUvScale: this.#bloomUvScale,
      uDir: new Float32Array([1, 0])
    });
    this.#blurV = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#bloomTexel,
      uTexUvScale: this.#bloomUvScale,
      uDir: new Float32Array([0, 1])
    });
    this.#downsampleWide = new ScreenQuad(DOWNSAMPLE_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uSrcTexel: this.#bloomTexel,
      uTexUvScale: this.#bloomUvScale
    });
    this.#wideBlurH = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#wideTexel,
      uTexUvScale: this.#wideUvScale,
      uDir: new Float32Array([1, 0])
    });
    this.#wideBlurV = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#wideTexel,
      uTexUvScale: this.#wideUvScale,
      uDir: new Float32Array([0, 1])
    });
    this.#composite = new ScreenQuad(COMPOSITE_FRAG, {
      uScene: PIXI.Texture.EMPTY,
      uBloomNarrow: PIXI.Texture.EMPTY,
      uBloomWide: PIXI.Texture.EMPTY,
      uShadow: PIXI.Texture.EMPTY,
      uBuildingMask: PIXI.Texture.EMPTY,
      uNarrowStrength: 1,
      uWideStrength: WIDE_STRENGTH,
      uPivotUv: new Float32Array([0.5, 0.5]),
      uSceneUvScale: this.#sceneUvScale,
      uBloomUvScale: this.#bloomUvScale,
      uWideUvScale: this.#wideUvScale,
      uShadowUvScale: this.#shadowUvScale,
      uMaskUvScale: this.#maskUvScale
    });
  }

  /** Runs the chain and returns the composite target, ready to present. */
  render(
    scene: any,
    strength: number,
    shadow: any,
    buildingMask: any,
    pivotUv: Float32Array
  ): any {
    this.#ensureTargets(scene);
    const renderer = this.#renderer;
    this.#setUvScale(this.#sceneUvScale, scene);
    this.#setUvScale(this.#shadowUvScale, shadow);
    this.#setUvScale(this.#maskUvScale, buildingMask);

    this.#threshold.uniforms.uScene = scene;
    renderer.render(this.#threshold.display, { renderTexture: this.#bloomA, clear: true });

    this.#downsampleWide.uniforms.uTex = this.#bloomA;
    renderer.render(this.#downsampleWide.display, { renderTexture: this.#wideA, clear: true });

    this.#blurH.uniforms.uTex = this.#bloomA;
    renderer.render(this.#blurH.display, { renderTexture: this.#bloomB, clear: true });

    this.#blurV.uniforms.uTex = this.#bloomB;
    renderer.render(this.#blurV.display, { renderTexture: this.#bloomA, clear: true });

    this.#wideBlurH.uniforms.uTex = this.#wideA;
    renderer.render(this.#wideBlurH.display, { renderTexture: this.#wideB, clear: true });

    this.#wideBlurV.uniforms.uTex = this.#wideB;
    renderer.render(this.#wideBlurV.display, { renderTexture: this.#wideA, clear: true });

    const composite = this.#composite.uniforms;
    composite.uScene = scene;
    composite.uBloomNarrow = this.#bloomA;
    composite.uBloomWide = this.#wideA;
    composite.uShadow = shadow;
    composite.uBuildingMask = buildingMask;
    composite.uNarrowStrength = strength;
    composite.uWideStrength = strength * WIDE_STRENGTH;
    composite.uPivotUv = pivotUv;
    renderer.render(this.#composite.display, { renderTexture: this.#out, clear: true });

    return this.#out;
  }

  destroy(): void {
    this.#releaseTargets();
    this.#threshold.destroy();
    this.#blurH.destroy();
    this.#blurV.destroy();
    this.#downsampleWide.destroy();
    this.#wideBlurH.destroy();
    this.#wideBlurV.destroy();
    this.#composite.destroy();
  }

  #ensureTargets(scene: any): void {
    const capacityWidth = scene.baseTexture?.width ?? scene.width;
    const capacityHeight = scene.baseTexture?.height ?? scene.height;
    if (
      this.#out === null ||
      this.#capacityWidth !== capacityWidth ||
      this.#capacityHeight !== capacityHeight
    ) {
      this.#releaseTargets();
      this.#capacityWidth = capacityWidth;
      this.#capacityHeight = capacityHeight;

      const capacityBloomWidth = Math.max(1, Math.ceil(capacityWidth / NARROW_DOWNSAMPLE));
      const capacityBloomHeight = Math.max(1, Math.ceil(capacityHeight / NARROW_DOWNSAMPLE));
      const capacityWideWidth = Math.max(1, Math.ceil(capacityWidth / WIDE_DOWNSAMPLE));
      const capacityWideHeight = Math.max(1, Math.ceil(capacityHeight / WIDE_DOWNSAMPLE));
      this.#bloomA = this.#createTarget(
        capacityBloomWidth,
        capacityBloomHeight,
        PIXI.TYPES.HALF_FLOAT
      );
      this.#bloomB = this.#createTarget(
        capacityBloomWidth,
        capacityBloomHeight,
        PIXI.TYPES.HALF_FLOAT
      );
      this.#wideA = this.#createTarget(
        capacityWideWidth,
        capacityWideHeight,
        PIXI.TYPES.HALF_FLOAT
      );
      this.#wideB = this.#createTarget(
        capacityWideWidth,
        capacityWideHeight,
        PIXI.TYPES.HALF_FLOAT
      );
      this.#out = this.#createTarget(capacityWidth, capacityHeight, PIXI.TYPES.UNSIGNED_BYTE);
    }

    if (this.#width === scene.width && this.#height === scene.height) return;
    this.#width = scene.width;
    this.#height = scene.height;

    const bw = Math.max(1, Math.ceil(this.#width / NARROW_DOWNSAMPLE));
    const bh = Math.max(1, Math.ceil(this.#height / NARROW_DOWNSAMPLE));
    const ww = Math.max(1, Math.ceil(this.#width / WIDE_DOWNSAMPLE));
    const wh = Math.max(1, Math.ceil(this.#height / WIDE_DOWNSAMPLE));
    this.#resizeFrame(this.#bloomA, bw, bh);
    this.#resizeFrame(this.#bloomB, bw, bh);
    this.#resizeFrame(this.#wideA, ww, wh);
    this.#resizeFrame(this.#wideB, ww, wh);
    this.#resizeFrame(this.#out, this.#width, this.#height);
    this.#setUvScale(this.#bloomUvScale, this.#bloomA);
    this.#setUvScale(this.#wideUvScale, this.#wideA);

    const resolution = this.#renderer.resolution;
    this.#srcTexel[0] = 1 / (capacityWidth * resolution);
    this.#srcTexel[1] = 1 / (capacityHeight * resolution);
    this.#bloomTexel[0] = 1 / ((this.#bloomA.baseTexture?.width ?? bw) * resolution);
    this.#bloomTexel[1] = 1 / ((this.#bloomA.baseTexture?.height ?? bh) * resolution);
    this.#wideTexel[0] = 1 / ((this.#wideA.baseTexture?.width ?? ww) * resolution);
    this.#wideTexel[1] = 1 / ((this.#wideA.baseTexture?.height ?? wh) * resolution);

    this.#threshold.sizeTo(this.#bloomA);
    this.#blurH.sizeTo(this.#bloomB);
    this.#blurV.sizeTo(this.#bloomA);
    this.#downsampleWide.sizeTo(this.#wideA);
    this.#wideBlurH.sizeTo(this.#wideB);
    this.#wideBlurV.sizeTo(this.#wideA);
    this.#composite.sizeTo(this.#out);
  }

  #createTarget(width: number, height: number, type: number): any {
    return PIXI.RenderTexture.create({
      width,
      height,
      resolution: this.#renderer.resolution,
      format: PIXI.FORMATS.RGBA,
      type,
      // WHY: the blur's tap offsets are the linear-sampling ones — NEAREST turns its five
      // taps back into five texels and the gaussian collapses.
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });
  }

  #resizeFrame(target: any, width: number, height: number): void {
    if (target.width === width && target.height === height) return;
    // WHY: Pixi resets frameless targets to capacity after rendering. Keep an explicit active frame while reusing the allocation.
    target.noFrame = false;
    target.resize(width, height, false);
  }

  #setUvScale(out: Float32Array, texture: any): void {
    out[0] = texture.width / (texture.baseTexture?.width ?? texture.width);
    out[1] = texture.height / (texture.baseTexture?.height ?? texture.height);
  }

  #releaseTargets(): void {
    for (const target of [this.#bloomA, this.#bloomB, this.#wideA, this.#wideB, this.#out]) {
      target?.destroy(true);
    }
    this.#bloomA = null;
    this.#bloomB = null;
    this.#wideA = null;
    this.#wideB = null;
    this.#out = null;
    this.#capacityWidth = 0;
    this.#capacityHeight = 0;
    this.#width = 0;
    this.#height = 0;
  }
}
