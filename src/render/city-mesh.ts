import { ATTRIBUTE_OFFSETS, VERTEX_STRIDE_BYTES, type MeshBuffers } from "../core/geom/mesh.js";
import { EMISSIVE_MAX } from "../core/palette.js";
import type { PaletteTexture } from "./palette-texture.js";
import { CITY_FRAG, CITY_VERT } from "./shaders/city.js";
import { BUILDING_MASK_FRAG, BUILDING_MASK_VERT } from "./shaders/occlusion.js";

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
  #cityShader: any;
  #maskShader: any;
  #pivot = new Float32Array(2);
  #maskPivot = new Float32Array(2);

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

    this.#cityShader = PIXI.Shader.from(CITY_VERT, CITY_FRAG, {
      uPivot: this.#pivot,
      uPixelsPerMetre: 25,
      uScreenPxPerMetre: 25,
      uCamHeight: 8750,
      uLeanStrength: 1,
      uDepthFar: 20000,
      uEmissiveMax: EMISSIVE_MAX,
      uPalette: palette.texture
    });
    this.#maskShader = PIXI.Shader.from(BUILDING_MASK_VERT, BUILDING_MASK_FRAG, {
      uPivot: this.#maskPivot,
      uPixelsPerMetre: 25,
      uCamHeight: 8750,
      uLeanStrength: 1
    });

    this.display = new PIXI.Mesh(this.#geometry, this.#cityShader);
    this.display.state.depthTest = true;
    this.display.state.depthMask = true;
    // Geometry is opaque and depth-sorted; blending would only cost fill rate.
    this.display.state.blend = false;
  }

  setCamera(c: CameraUniforms): void {
    this.#pivot[0] = c.pivotX;
    this.#pivot[1] = c.pivotY;
    this.#maskPivot[0] = c.pivotX;
    this.#maskPivot[1] = c.pivotY;
    const u = this.#cityShader.uniforms;
    u.uPixelsPerMetre = c.pixelsPerMetre;
    u.uScreenPxPerMetre = c.screenPxPerMetre;
    u.uCamHeight = c.cameraHeightPx;
    u.uLeanStrength = c.leanStrength;
    u.uDepthFar = c.depthFar;

    const m = this.#maskShader.uniforms;
    m.uPixelsPerMetre = c.pixelsPerMetre;
    m.uCamHeight = c.cameraHeightPx;
    m.uLeanStrength = c.leanStrength;
  }

  /** The mask is a flat silhouette, so it neither reads nor writes depth. */
  setMaskPass(enabled: boolean): void {
    this.display.shader = enabled ? this.#maskShader : this.#cityShader;
    this.display.state.depthTest = !enabled;
    this.display.state.depthMask = !enabled;
  }

  /** The palette texture is shared and outlives this mesh. */
  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
    this.#cityShader.destroy?.();
    this.#maskShader.destroy?.();
  }
}
