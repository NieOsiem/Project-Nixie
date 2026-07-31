import type { LookDials } from "./look-dials.js";
import { ScreenQuad } from "./screen-quad.js";
import {
  BLUR_FRAG,
  COMPOSITE_FRAG,
  DOWNSAMPLE_FRAG,
  STREAK_FRAG,
  STREAK_TAPS,
  THRESHOLD_FRAG
} from "./shaders/post.js";

const NARROW_DOWNSAMPLE = 4;
const WIDE_DOWNSAMPLE = 16;
const WIDE_STRENGTH = 0.55;
/**
 * Tap strides of the two horizontal streak passes, in wide-target texels.
 *
 * The second is `STREAK_TAPS`, not a free choice: pass A covers `STREAK_TAPS` texels contiguously,
 * so pass B's taps must sit exactly that far apart to tile it without gaps. Reach is
 * `STREAK_TAPS²` = 64 wide texels, ~1024 screen pixels at the 1/16 target.
 */
const STREAK_STRIDE_A = 1;
const STREAK_STRIDE_B = STREAK_TAPS;

/**
 * Threshold + downsample -> narrow and wide separable blurs + horizontal streak -> composite,
 * plus a blurred building mask for ground AO.
 *
 * Owns its render targets and sizes them from whatever scene texture it is handed, so the
 * caller only has to hand back the same texture each frame.
 */
export class BloomChain {
  /** False skips the blur, streak and threshold passes only. The composite always runs. */
  bloomEnabled = true;

  #dials: LookDials;
  #renderer: any;
  #threshold: ScreenQuad;
  #blurH: ScreenQuad;
  #blurV: ScreenQuad;
  #downsampleWide: ScreenQuad;
  #wideBlurH: ScreenQuad;
  #wideBlurV: ScreenQuad;
  #streakPassA: ScreenQuad;
  #streakPassB: ScreenQuad;
  #aoDownsample: ScreenQuad;
  #aoBlurH: ScreenQuad;
  #aoBlurV: ScreenQuad;
  #composite: ScreenQuad;
  #blank: any;

  #bloomA: any = null;
  #bloomB: any = null;
  #wideA: any = null;
  #wideB: any = null;
  #streakA: any = null;
  #streakB: any = null;
  #aoA: any = null;
  #aoB: any = null;
  #out: any = null;
  #capacityWidth = 0;
  #capacityHeight = 0;
  #width = 0;
  #height = 0;

  #srcTexel = new Float32Array(2);
  #bloomTexel = new Float32Array(2);
  #wideTexel = new Float32Array(2);
  #streakStepA = new Float32Array(2);
  #streakStepB = new Float32Array(2);
  #aoTexel = new Float32Array(2);
  #sceneUvScale = new Float32Array([1, 1]);
  #bloomUvScale = new Float32Array([1, 1]);
  #wideUvScale = new Float32Array([1, 1]);
  #streakUvScale = new Float32Array([1, 1]);
  #aoUvScale = new Float32Array([1, 1]);
  #shadowUvScale = new Float32Array([1, 1]);
  #maskUvScale = new Float32Array([1, 1]);

  /** `dials` is the renderer's own object, shared not copied: mutating it retunes the next frame. */
  constructor(renderer: any, dials: LookDials) {
    this.#renderer = renderer;
    this.#dials = dials;

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
    // uTexel is the real wide texel, used only for the clamp window; tap spacing rides in uStep,
    // so the two are never conflated the way an inflated uTexel forced them to be.
    this.#streakPassA = new ScreenQuad(STREAK_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#wideTexel,
      uTexUvScale: this.#wideUvScale,
      uStep: this.#streakStepA,
      uSpan: STREAK_STRIDE_A
    });
    this.#streakPassB = new ScreenQuad(STREAK_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#wideTexel,
      uTexUvScale: this.#streakUvScale,
      uStep: this.#streakStepB,
      uSpan: STREAK_STRIDE_B
    });
    this.#aoDownsample = new ScreenQuad(DOWNSAMPLE_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uSrcTexel: this.#srcTexel,
      uTexUvScale: this.#maskUvScale
    });
    this.#aoBlurH = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#aoTexel,
      uTexUvScale: this.#aoUvScale,
      uDir: new Float32Array([1, 0])
    });
    this.#aoBlurV = new ScreenQuad(BLUR_FRAG, {
      uTex: PIXI.Texture.EMPTY,
      uTexel: this.#aoTexel,
      uTexUvScale: this.#aoUvScale,
      uDir: new Float32Array([0, 1])
    });
    this.#composite = new ScreenQuad(COMPOSITE_FRAG, {
      uScene: PIXI.Texture.EMPTY,
      uBloomNarrow: PIXI.Texture.EMPTY,
      uBloomWide: PIXI.Texture.EMPTY,
      uStreak: PIXI.Texture.EMPTY,
      uShadow: PIXI.Texture.EMPTY,
      uBuildingMask: PIXI.Texture.EMPTY,
      uAo: PIXI.Texture.EMPTY,
      uNarrowStrength: 1,
      uWideStrength: WIDE_STRENGTH,
      uStreakStrength: dials.streakStrength,
      uAoStrength: dials.aoStrength,
      uAoHeightM: dials.aoHeightM,
      uFogStrength: dials.fogStrength,
      uFogDensity: dials.fogDensity,
      uFogHeightM: dials.fogHeightM,
      uFogInscatter: dials.fogInscatter,
      uFogTintR: dials.fogTintR,
      uFogTintG: dials.fogTintG,
      uFogTintB: dials.fogTintB,
      uPivotUv: new Float32Array([0.5, 0.5]),
      uSceneUvScale: this.#sceneUvScale,
      uBloomUvScale: this.#bloomUvScale,
      uWideUvScale: this.#wideUvScale,
      uStreakUvScale: this.#streakUvScale,
      uShadowUvScale: this.#shadowUvScale,
      uMaskUvScale: this.#maskUvScale,
      uAoUvScale: this.#aoUvScale
    });
    this.#blank = new PIXI.Container();
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

    if (this.bloomEnabled) {
      this.#threshold.uniforms.uScene = scene;
      renderer.render(this.#threshold.display, { renderTexture: this.#bloomA, clear: true });

      this.#downsampleWide.uniforms.uTex = this.#bloomA;
      renderer.render(this.#downsampleWide.display, { renderTexture: this.#wideA, clear: true });

      this.#streakPassA.uniforms.uTex = this.#wideA;
      renderer.render(this.#streakPassA.display, { renderTexture: this.#streakB, clear: true });

      this.#streakPassB.uniforms.uTex = this.#streakB;
      renderer.render(this.#streakPassB.display, { renderTexture: this.#streakA, clear: true });

      this.#blurH.uniforms.uTex = this.#bloomA;
      renderer.render(this.#blurH.display, { renderTexture: this.#bloomB, clear: true });

      this.#blurV.uniforms.uTex = this.#bloomB;
      renderer.render(this.#blurV.display, { renderTexture: this.#bloomA, clear: true });

      this.#wideBlurH.uniforms.uTex = this.#wideA;
      renderer.render(this.#wideBlurH.display, { renderTexture: this.#wideB, clear: true });

      this.#wideBlurV.uniforms.uTex = this.#wideB;
      renderer.render(this.#wideBlurV.display, { renderTexture: this.#wideA, clear: true });
    } else {
      // WHY: the fog inscatters uBloomWide even with bloom off, so a stale wide target would
      // leak the last lit frame into the haze. Cleared every frame on purpose — guarding this
      // behind a dirty flag made the pass count frame-dependent and put the leak one missed
      // invalidation away, to save three clears of quarter- and sixteenth-res targets.
      renderer.render(this.#blank, { renderTexture: this.#bloomA, clear: true });
      renderer.render(this.#blank, { renderTexture: this.#wideA, clear: true });
      renderer.render(this.#blank, { renderTexture: this.#streakA, clear: true });
    }

    this.#aoDownsample.uniforms.uTex = buildingMask;
    renderer.render(this.#aoDownsample.display, { renderTexture: this.#aoA, clear: true });

    this.#aoBlurH.uniforms.uTex = this.#aoA;
    renderer.render(this.#aoBlurH.display, { renderTexture: this.#aoB, clear: true });

    this.#aoBlurV.uniforms.uTex = this.#aoB;
    renderer.render(this.#aoBlurV.display, { renderTexture: this.#aoA, clear: true });

    const dials = this.#dials;
    const composite = this.#composite.uniforms;
    composite.uScene = scene;
    composite.uBloomNarrow = this.#bloomA;
    composite.uBloomWide = this.#wideA;
    composite.uStreak = this.#streakA;
    composite.uShadow = shadow;
    composite.uBuildingMask = buildingMask;
    composite.uAo = this.#aoA;
    composite.uNarrowStrength = this.bloomEnabled ? strength : 0;
    composite.uWideStrength = this.bloomEnabled ? strength * WIDE_STRENGTH : 0;
    // Scaled by bloomStrength like the other two: the streak is a lens artefact off the same
    // thresholded highlights, so the world slider at 0 must not leave streaks behind.
    composite.uStreakStrength = this.bloomEnabled ? strength * dials.streakStrength : 0;
    composite.uAoStrength = dials.aoStrength;
    composite.uAoHeightM = dials.aoHeightM;
    composite.uFogStrength = dials.fogStrength;
    composite.uFogDensity = dials.fogDensity;
    composite.uFogHeightM = dials.fogHeightM;
    composite.uFogInscatter = dials.fogInscatter;
    composite.uFogTintR = dials.fogTintR;
    composite.uFogTintG = dials.fogTintG;
    composite.uFogTintB = dials.fogTintB;
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
    this.#streakPassA.destroy();
    this.#streakPassB.destroy();
    this.#aoDownsample.destroy();
    this.#aoBlurH.destroy();
    this.#aoBlurV.destroy();
    this.#composite.destroy();
    this.#blank.destroy({ children: true });
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
      this.#streakA = this.#createTarget(
        capacityWideWidth,
        capacityWideHeight,
        PIXI.TYPES.HALF_FLOAT
      );
      this.#streakB = this.#createTarget(
        capacityWideWidth,
        capacityWideHeight,
        PIXI.TYPES.HALF_FLOAT
      );
      this.#aoA = this.#createTarget(
        capacityBloomWidth,
        capacityBloomHeight,
        PIXI.TYPES.UNSIGNED_BYTE
      );
      this.#aoB = this.#createTarget(
        capacityBloomWidth,
        capacityBloomHeight,
        PIXI.TYPES.UNSIGNED_BYTE
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
    this.#resizeFrame(this.#streakA, ww, wh);
    this.#resizeFrame(this.#streakB, ww, wh);
    this.#resizeFrame(this.#aoA, bw, bh);
    this.#resizeFrame(this.#aoB, bw, bh);
    this.#resizeFrame(this.#out, this.#width, this.#height);
    this.#setUvScale(this.#bloomUvScale, this.#bloomA);
    this.#setUvScale(this.#wideUvScale, this.#wideA);
    this.#setUvScale(this.#streakUvScale, this.#streakA);
    this.#setUvScale(this.#aoUvScale, this.#aoA);

    const resolution = this.#renderer.resolution;
    this.#srcTexel[0] = 1 / (capacityWidth * resolution);
    this.#srcTexel[1] = 1 / (capacityHeight * resolution);
    this.#bloomTexel[0] = 1 / ((this.#bloomA.baseTexture?.width ?? bw) * resolution);
    this.#bloomTexel[1] = 1 / ((this.#bloomA.baseTexture?.height ?? bh) * resolution);
    this.#wideTexel[0] = 1 / ((this.#wideA.baseTexture?.width ?? ww) * resolution);
    this.#wideTexel[1] = 1 / ((this.#wideA.baseTexture?.height ?? wh) * resolution);
    // Horizontal only: y stays 0 so the streak never walks off its own row.
    this.#streakStepA[0] = this.#wideTexel[0] * STREAK_STRIDE_A;
    this.#streakStepB[0] = this.#wideTexel[0] * STREAK_STRIDE_B;
    this.#aoTexel[0] = 1 / ((this.#aoA.baseTexture?.width ?? bw) * resolution);
    this.#aoTexel[1] = 1 / ((this.#aoA.baseTexture?.height ?? bh) * resolution);

    this.#threshold.sizeTo(this.#bloomA);
    this.#blurH.sizeTo(this.#bloomB);
    this.#blurV.sizeTo(this.#bloomA);
    this.#downsampleWide.sizeTo(this.#wideA);
    this.#wideBlurH.sizeTo(this.#wideB);
    this.#wideBlurV.sizeTo(this.#wideA);
    this.#streakPassA.sizeTo(this.#streakB);
    this.#streakPassB.sizeTo(this.#streakA);
    this.#aoDownsample.sizeTo(this.#aoA);
    this.#aoBlurH.sizeTo(this.#aoB);
    this.#aoBlurV.sizeTo(this.#aoA);
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
    for (const target of [
      this.#bloomA,
      this.#bloomB,
      this.#wideA,
      this.#wideB,
      this.#streakA,
      this.#streakB,
      this.#aoA,
      this.#aoB,
      this.#out
    ]) {
      target?.destroy(true);
    }
    this.#bloomA = null;
    this.#bloomB = null;
    this.#wideA = null;
    this.#wideB = null;
    this.#streakA = null;
    this.#streakB = null;
    this.#aoA = null;
    this.#aoB = null;
    this.#out = null;
    this.#capacityWidth = 0;
    this.#capacityHeight = 0;
    this.#width = 0;
    this.#height = 0;
  }
}
