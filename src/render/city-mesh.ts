import { ATTRIBUTE_OFFSETS, VERTEX_STRIDE_BYTES, type MeshBuffers } from "../core/geom/mesh.js";
import { EMISSIVE_MAX, PALETTE_ROWS, PALETTE_SIZE } from "../core/palette.js";
import { CITY_FRAG, CITY_VERT } from "./shaders/city.js";

export interface CameraUniforms {
  pivotX: number;
  pivotY: number;
  pixelsPerMetre: number;
  cameraHeightPx: number;
  depthFar: number;
}

/** Extruded city geometry as one draw call, coloured through a palette lookup. */
export class CityMesh {
  readonly display: any;
  readonly triangleCount: number;

  #geometry: any;
  #paletteTexture: any;
  #pivot = new Float32Array(2);

  constructor(buffers: MeshBuffers, palette: Uint8Array) {
    this.triangleCount = buffers.triangleCount;

    const vertexBuffer = new PIXI.Buffer(buffers.vertices);
    const F = PIXI.TYPES.FLOAT;
    this.#geometry = new PIXI.Geometry()
      .addAttribute("aPos", vertexBuffer, 2, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.pos)
      .addAttribute("aHeight", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.height)
      .addAttribute("aMaterial", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.material)
      .addAttribute("aShade", vertexBuffer, 1, false, F, VERTEX_STRIDE_BYTES, ATTRIBUTE_OFFSETS.shade)
      .addIndex(buffers.indices);

    this.#paletteTexture = PIXI.Texture.fromBuffer(palette, PALETTE_SIZE, PALETTE_ROWS, {
      format: PIXI.FORMATS.RGBA,
      type: PIXI.TYPES.UNSIGNED_BYTE,
      scaleMode: PIXI.SCALE_MODES.NEAREST,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      wrapMode: PIXI.WRAP_MODES.CLAMP
    });

    const shader = PIXI.Shader.from(CITY_VERT, CITY_FRAG, {
      uPivot: this.#pivot,
      uPixelsPerMetre: 25,
      uCamHeight: 8750,
      uDepthFar: 20000,
      uEmissiveMax: EMISSIVE_MAX,
      uPalette: this.#paletteTexture
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
    u.uCamHeight = c.cameraHeightPx;
    u.uDepthFar = c.depthFar;
  }

  updatePalette(palette: Uint8Array): void {
    this.#paletteTexture.baseTexture.resource.data.set(palette);
    this.#paletteTexture.baseTexture.update();
  }

  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
    this.#paletteTexture.destroy(true);
  }
}
