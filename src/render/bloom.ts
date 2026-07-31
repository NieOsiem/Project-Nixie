import { ScreenQuad } from "./screen-quad.js";
import { BLUR_FRAG, COMPOSITE_FRAG, THRESHOLD_FRAG } from "./shaders/post.js";

/** Blur runs at 1/4 in each axis. The 0.24 ms budget in the handoff was measured there. */
const DOWNSAMPLE = 4;

/**
 * Threshold + downsample -> separable blur H -> blur V -> composite.
 *
 * Owns its render targets and sizes them from whatever scene texture it is handed, so the
 * caller only has to hand back the same texture each frame.
 */
export class BloomChain {
  #renderer: any;
  #threshold: ScreenQuad;
  #blurH: ScreenQuad;
  #blurV: ScreenQuad;
  #composite: ScreenQuad;

  #bloomA: any = null;
  #bloomB: any = null;
  #out: any = null;
  #width = 0;
  #height = 0;

  #srcTexel = new Float32Array(2);
  #bloomTexel = new Float32Array(2);

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
    this.#composite = new ScreenQuad(COMPOSITE_FRAG, {
      uScene: PIXI.Texture.EMPTY,
      uBloom: PIXI.Texture.EMPTY,
      uStrength: 1
    });
  }

  /** Runs the chain and returns the composite target, ready to present. */
  render(scene: any, strength: number): any {
    this.#ensureTargets(scene);
    const renderer = this.#renderer;

    this.#threshold.uniforms.uScene = scene;
    renderer.render(this.#threshold.display, { renderTexture: this.#bloomA, clear: true });

    this.#blurH.uniforms.uTex = this.#bloomA;
    renderer.render(this.#blurH.display, { renderTexture: this.#bloomB, clear: true });

    this.#blurV.uniforms.uTex = this.#bloomB;
    renderer.render(this.#blurV.display, { renderTexture: this.#bloomA, clear: true });

    const composite = this.#composite.uniforms;
    composite.uScene = scene;
    composite.uBloom = this.#bloomA;
    composite.uStrength = strength;
    renderer.render(this.#composite.display, { renderTexture: this.#out, clear: true });

    return this.#out;
  }

  destroy(): void {
    this.#releaseTargets();
    this.#threshold.destroy();
    this.#blurH.destroy();
    this.#blurV.destroy();
    this.#composite.destroy();
  }

  #ensureTargets(scene: any): void {
    if (this.#out !== null && this.#width === scene.width && this.#height === scene.height) return;

    this.#releaseTargets();
    this.#width = scene.width;
    this.#height = scene.height;

    const bw = Math.max(1, Math.ceil(scene.width / DOWNSAMPLE));
    const bh = Math.max(1, Math.ceil(scene.height / DOWNSAMPLE));
    this.#bloomA = this.#createTarget(bw, bh);
    this.#bloomB = this.#createTarget(bw, bh);
    this.#out = this.#createTarget(scene.width, scene.height);

    const resolution = this.#renderer.resolution;
    this.#srcTexel[0] = 1 / (scene.width * resolution);
    this.#srcTexel[1] = 1 / (scene.height * resolution);
    this.#bloomTexel[0] = 1 / (bw * resolution);
    this.#bloomTexel[1] = 1 / (bh * resolution);

    this.#threshold.sizeTo(this.#bloomA);
    this.#blurH.sizeTo(this.#bloomB);
    this.#blurV.sizeTo(this.#bloomA);
    this.#composite.sizeTo(this.#out);
  }

  #createTarget(width: number, height: number): any {
    return PIXI.RenderTexture.create({
      width,
      height,
      resolution: this.#renderer.resolution,
      // WHY: the blur's tap offsets are the linear-sampling ones — NEAREST turns its five
      // taps back into five texels and the gaussian collapses.
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });
  }

  #releaseTargets(): void {
    for (const target of [this.#bloomA, this.#bloomB, this.#out]) target?.destroy(true);
    this.#bloomA = null;
    this.#bloomB = null;
    this.#out = null;
    this.#width = 0;
    this.#height = 0;
  }
}
