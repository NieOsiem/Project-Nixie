import { FOOT_PROBE_FRAG, FOOT_PROBE_VERT } from "./shaders/occlusion.js";

/** The mask and the rect it covers, in world pixels. */
export interface MaskFrame {
  texture: any;
  viewX: number;
  viewY: number;
  viewWidth: number;
  viewHeight: number;
}

const COVERED = 128;

/**
 * Samples the building mask at a set of ground points, one texel each.
 *
 * Verdicts are one frame old by construction: `submit` queues the draw and `verdicts`
 * reads the row the *previous* submit filled, so the readback never waits on work the GPU
 * has not finished. A frame of lag on "is this token behind a wall" is not visible; the
 * pipeline stall from reading the row we just drew would be.
 */
export class FootProbe {
  readonly capacity: number;

  #renderer: any;
  #target: any;
  #geometry: any;
  #mesh: any;
  #footUv: Float32Array;
  #footBuffer: any;
  #verdicts: Uint8Array;
  #maskUvScale = new Float32Array([1, 1]);
  #pending = 0;

  constructor(renderer: any, capacity = 256) {
    this.#renderer = renderer;
    this.capacity = capacity;
    this.#verdicts = new Uint8Array(capacity);
    this.#footUv = new Float32Array(capacity * 2);

    const slots = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) {
      slots[i * 2] = i + 0.5;
      slots[i * 2 + 1] = 0.5;
    }

    this.#footBuffer = new PIXI.Buffer(this.#footUv);
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aSlot", new PIXI.Buffer(slots), 2)
      .addAttribute("aFootUv", this.#footBuffer, 2);

    const shader = PIXI.Shader.from(FOOT_PROBE_VERT, FOOT_PROBE_FRAG, {
      uMask: PIXI.Texture.EMPTY,
      uMaskUvScale: this.#maskUvScale
    });
    this.#mesh = new PIXI.Mesh(this.#geometry, shader, undefined, PIXI.DRAW_MODES.POINTS);
    this.#mesh.state.depthTest = false;
    this.#mesh.state.blend = false;

    this.#target = PIXI.RenderTexture.create({
      width: capacity,
      height: 1,
      resolution: 1,
      scaleMode: PIXI.SCALE_MODES.NEAREST
    });
  }

  /** Coverage of the points handed to the previous `submit`, in that order. */
  verdicts(): Uint8Array {
    if (this.#pending === 0) return this.#verdicts.subarray(0, 0);

    const pixels = this.#renderer.extract.pixels(this.#target);
    for (let i = 0; i < this.#pending; i++) this.#verdicts[i] = pixels[i * 4 + 3]!;
    return this.#verdicts.subarray(0, this.#pending);
  }

  /** `feet` is x, y pairs in world pixels. Anything past `capacity` is dropped. */
  submit(frame: MaskFrame, feet: ArrayLike<number>, count: number): void {
    const n = Math.min(count, this.capacity);
    this.#pending = n;
    if (n === 0) return;

    for (let i = 0; i < n; i++) {
      this.#footUv[i * 2] = (feet[i * 2]! - frame.viewX) / frame.viewWidth;
      this.#footUv[i * 2 + 1] = (feet[i * 2 + 1]! - frame.viewY) / frame.viewHeight;
    }
    this.#footBuffer.update(this.#footUv);

    this.#mesh.shader.uniforms.uMask = frame.texture;
    this.#maskUvScale[0] =
      frame.texture.width / (frame.texture.baseTexture?.width ?? frame.texture.width);
    this.#maskUvScale[1] =
      frame.texture.height / (frame.texture.baseTexture?.height ?? frame.texture.height);
    this.#mesh.size = n;
    this.#renderer.render(this.#mesh, { renderTexture: this.#target, clear: true });
  }

  /** Nothing is queued, so `verdicts` stops reporting on a set the caller has dropped. */
  clear(): void {
    this.#pending = 0;
  }

  destroy(): void {
    this.#mesh.destroy();
    this.#geometry.destroy();
    this.#target.destroy(true);
  }
}

export const isCovered = (verdict: number | undefined): boolean => (verdict ?? 0) >= COVERED;
