import { POST_VERT } from "./shaders/post.js";

/**
 * One full-target quad for a post pass.
 *
 * A plain `PIXI.Mesh` rather than a `PIXI.Filter`: the post chain runs outside any normal
 * render pass, where the FilterSystem's filter area and padding have nothing sane to key
 * off. Geometry is the unit square and the mesh transform scales it, so the same shader
 * serves every target size.
 */
export class ScreenQuad {
  readonly display: any;

  #geometry: any;

  constructor(frag: string, uniforms: Record<string, unknown>) {
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aCorner", [0, 0, 1, 0, 1, 1, 0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]);

    this.display = new PIXI.Mesh(this.#geometry, PIXI.Shader.from(POST_VERT, frag, uniforms));
    this.display.state.depthTest = false;
    // Full coverage, and the composite adds bloom in the shader; blending would only cost fill rate.
    this.display.state.blend = false;
  }

  get uniforms(): Record<string, unknown> {
    return this.display.shader.uniforms;
  }

  /** Scale to a render texture's logical size, which is what the projection is built from. */
  sizeTo(target: any): void {
    this.display.scale.set(target.width, target.height);
  }

  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
  }
}
