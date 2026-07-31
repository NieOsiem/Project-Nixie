import { ATTRIBUTE_OFFSETS, VERTEX_STRIDE_BYTES, type MeshBuffers } from "../core/geom/mesh.js";
import { EMISSIVE_MAX } from "../core/palette.js";
import type { CameraUniforms } from "./city-mesh.js";
import type { PaletteTexture } from "./palette-texture.js";
import { NEON_FRAG, NEON_VERT } from "./shaders/neon.js";

/**
 * Bounded additive sign quads, one draw call, sharing the city's palette texture.
 *
 * Must be drawn after the opaque geometry: it reads the depth buffer the city writes and
 * never writes to it.
 */
export class NeonMesh {
  readonly display: any;
  readonly triangleCount: number;

  #geometry: any;
  #pivot = new Float32Array(2);

  constructor(buffers: MeshBuffers, palette: PaletteTexture) {
    this.triangleCount = buffers.triangleCount;

    const vertexBuffer = new PIXI.Buffer(buffers.vertices);
    const F = PIXI.TYPES.FLOAT;
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aPos", vertexBuffer, 2, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.pos)
      .addAttribute("aHeight", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.height)
      .addAttribute("aMaterial", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.material)
      .addAttribute("aU", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.u)
      .addAttribute("aTop", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.top)
      .addAttribute("aSeed", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.seed)
      .addIndex(buffers.indices);

    const shader = PIXI.Shader.from(NEON_VERT, NEON_FRAG, {
      uPivot: this.#pivot,
      uPixelsPerMetre: 25,
      uCamHeight: 8750,
      uDepthFar: 20000,
      uEmissiveMax: EMISSIVE_MAX,
      uPalette: palette.texture
    });

    this.display = new PIXI.Mesh(this.#geometry, shader);
    this.display.state.blend = true;
    this.display.state.blendMode = PIXI.BLEND_MODES.ADD;
    // Depth-tested so a building occludes a glow behind it, but depthMask off so two
    // overlapping glows accumulate instead of the nearer one rejecting the further.
    this.display.state.depthTest = true;
    this.display.state.depthMask = false;
  }

  setCamera(c: CameraUniforms): void {
    const u = this.display.shader.uniforms;
    this.#pivot[0] = c.pivotX;
    this.#pivot[1] = c.pivotY;
    u.uPixelsPerMetre = c.pixelsPerMetre;
    u.uCamHeight = c.cameraHeightPx;
    u.uDepthFar = c.depthFar;
  }

  /** Leaves the palette texture alone — it is shared with every other mesh. */
  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
  }
}
