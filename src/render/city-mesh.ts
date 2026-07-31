import { ATTRIBUTE_OFFSETS, VERTEX_STRIDE_BYTES, type MeshBuffers } from "../core/geom/mesh.js";
import { EMISSIVE_MAX } from "../core/palette.js";
import type { PaletteTexture } from "./palette-texture.js";
import { CITY_FRAG, CITY_VERT } from "./shaders/city.js";

export interface CameraUniforms {
  pivotX: number;
  pivotY: number;
  pixelsPerMetre: number;
  /** World pixels per metre times the offscreen stage scale, i.e. screen pixels per metre. */
  screenPxPerMetre: number;
  cameraHeightPx: number;
  leanStrength: number;
  depthFar: number;
}

/** Extruded city geometry as one draw call, coloured through a palette lookup. */
export class CityMesh {
  readonly display: any;
  readonly triangleCount: number;

  #geometry: any;
  #pivot = new Float32Array(2);

  constructor(buffers: MeshBuffers, palette: PaletteTexture) {
    this.triangleCount = buffers.triangleCount;

    const vertexBuffer = new PIXI.Buffer(buffers.vertices);
    const F = PIXI.TYPES.FLOAT;
    const S = VERTEX_STRIDE_BYTES;
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aPos", vertexBuffer, 2, false, F, S, ATTRIBUTE_OFFSETS.pos)
      .addAttribute("aHeight", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.height)
      .addAttribute("aMaterial", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.material)
      .addAttribute("aShade", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.shade)
      .addAttribute("aKind", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.kind)
      .addAttribute("aU", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.u)
      .addAttribute("aTop", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.top)
      .addAttribute("aSeed", vertexBuffer, 1, false, F, S, ATTRIBUTE_OFFSETS.seed)
      .addIndex(buffers.indices);

    const shader = PIXI.Shader.from(CITY_VERT, CITY_FRAG, {
      uPivot: this.#pivot,
      uPixelsPerMetre: 25,
      uScreenPxPerMetre: 25,
      uCamHeight: 8750,
      uLeanStrength: 1,
      uDepthFar: 20000,
      uEmissiveMax: EMISSIVE_MAX,
      uPalette: palette.texture
    });

    this.display = new PIXI.Mesh(this.#geometry, shader);
    this.display.state.depthTest = true;
    this.display.state.depthMask = true;
    // Geometry is opaque and depth-sorted; blending would only cost fill rate.
    this.display.state.blend = false;
  }

  setCamera(c: CameraUniforms): void {
    const u = this.display.shader.uniforms;
    this.#pivot[0] = c.pivotX;
    this.#pivot[1] = c.pivotY;
    u.uPixelsPerMetre = c.pixelsPerMetre;
    u.uScreenPxPerMetre = c.screenPxPerMetre;
    u.uCamHeight = c.cameraHeightPx;
    u.uLeanStrength = c.leanStrength;
    u.uDepthFar = c.depthFar;
  }

  /** The palette texture is shared and outlives this mesh. */
  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
  }
}
