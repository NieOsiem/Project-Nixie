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
  #width = 0;
  #height = 0;

  #srcTexel = new Float32Array(2);
  #bloomTexel = new Float32Array(2);
  #wideTexel = new Float32Array(2);

  constructor(renderer: any) {
    this.#renderer = renderer;

    this.#threshold = new ScreenQuad(THRESHOLD_FRAG, {
      uScene: PIXI.Texture.EMPTY,
      uSrcTexel: this.#srcTexel
    });
    this.#blurH = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#bloomTexel,
      uDir: new Float32Array([1, 0])
    });
    this.#blurV = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#bloomTexel,
      uDir: new Float32Array([0, 1])
    });
    this.#downsampleWide = new ScreenQuad(DOWNSAMPLE_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uSrcTexel: this.#bloomTexel
    });
    this.#wideBlurH = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#wideTexel,
      uDir: new Float32Array([1, 0])
    });
    this.#wideBlurV = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#wideTexel,
      uDir: new Float32Array([0, 1])
    });
    this.#composite = new ScreenQuad(COMPOSITE_FRAG, {
      uScene: PIXI.Texture.EMPTY,
      uBloomNarrow: PIXI.Texture.EMPTY,
      uBloomWide: PIXI.Texture.EMPTY,
      uShadow: PIXI.Texture.EMPTY,
      uBuildingMask: PIXI.Texture.EMPTY,
      uNarrowStrength: 1,
      uWideStrength: WIDE_STRENGTH
    });
  }

  /** Runs the chain and returns the composite target, ready to present. */
  render(scene: any, strength: number, shadow: any, buildingMask: any): any {
    this.#ensureTargets(scene);
    const renderer = this.#renderer;

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
    if (this.#out !== null && this.#width === scene.width && this.#height === scene.height) return;

    this.#releaseTargets();
    this.#width = scene.width;
    this.#height = scene.height;

    const bw = Math.max(1, Math.ceil(scene.width / NARROW_DOWNSAMPLE));
    const bh = Math.max(1, Math.ceil(scene.height / NARROW_DOWNSAMPLE));
    const ww = Math.max(1, Math.ceil(scene.width / WIDE_DOWNSAMPLE));
    const wh = Math.max(1, Math.ceil(scene.height / WIDE_DOWNSAMPLE));
    this.#bloomA = this.#createTarget(bw, bh, PIXI.TYPES.HALF_FLOAT);
    this.#bloomB = this.#createTarget(bw, bh, PIXI.TYPES.HALF_FLOAT);
    this.#wideA = this.#createTarget(ww, wh, PIXI.TYPES.HALF_FLOAT);
    this.#wideB = this.#createTarget(ww, wh, PIXI.TYPES.HALF_FLOAT);
    this.#out = this.#createTarget(scene.width, scene.height, PIXI.TYPES.UNSIGNED_BYTE);

    const resolution = this.#renderer.resolution;
    this.#srcTexel[0] = 1 / (scene.width * resolution);
    this.#srcTexel[1] = 1 / (scene.height * resolution);
    this.#bloomTexel[0] = 1 / (bw * resolution);
    this.#bloomTexel[1] = 1 / (bh * resolution);
    this.#wideTexel[0] = 1 / (ww * resolution);
    this.#wideTexel[1] = 1 / (wh * resolution);

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

  #releaseTargets(): void {
    for (const target of [this.#bloomA, this.#bloomB, this.#wideA, this.#wideB, this.#out]) {
      target?.destroy(true);
    }
    this.#bloomA = null;
    this.#bloomB = null;
    this.#wideA = null;
    this.#wideB = null;
    this.#out = null;
    this.#width = 0;
    this.#height = 0;
  }
}
