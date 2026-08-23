import { ATTRIBUTE_OFFSETS, VERTEX_STRIDE_BYTES, type MeshBuffers } from "../core/geom/mesh.js";
import { LIGHT_DIRECTION, SHADOW_LENGTH } from "../core/geom/extrude.js";
import { EMISSIVE_MAX } from "../core/palette.js";
import type { PaletteTexture } from "./palette-texture.js";
import { CITY_FRAG, CITY_VERT } from "./shaders/city.js";
import { DEFAULT_LOOK_DIALS, type LookDials } from "./look-dials.js";
import { BUILDING_MASK_FRAG, BUILDING_MASK_VERT } from "./shaders/occlusion.js";
import { SHADOW_FRAG, SHADOW_VERT } from "./shaders/shadow.js";

export interface CameraUniforms {
  pivotX: number;
  pivotY: number;
  pixelsPerMetre: number;
  /** World pixels per metre times the offscreen stage scale, i.e. screen pixels per metre. */
  screenPxPerMetre: number;
  cameraHeightPx: number;
  leanStrength: number;
  depthFar: number;
  detailQuality: number;
}

/** Extruded city geometry as one draw call, coloured through a palette lookup. */
export class CityMesh {
  readonly display: any;
  readonly triangleCount: number;

  #geometry: any;
  #cityShader: any;
  #maskShader: any;
  #shadowShader: any;
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
      .addAttribute("aRoofCentre", vertexBuffer, 2, false, F, S, ATTRIBUTE_OFFSETS.roofCentre)
      .addIndex(buffers.indices);

    this.#cityShader = PIXI.Shader.from(CITY_VERT, CITY_FRAG, {
      uPivot: this.#pivot,
      uPixelsPerMetre: 25,
      uScreenPxPerMetre: 25,
      uCamHeight: 8750,
      uLeanStrength: 1,
      uDepthFar: 20000,
      uDetailQuality: 1,
      uEmissiveMax: EMISSIVE_MAX,
      uBodyExposure: DEFAULT_LOOK_DIALS.bodyExposure,
      uSkyLift: DEFAULT_LOOK_DIALS.skyLift,
      uEmissiveGain: DEFAULT_LOOK_DIALS.emissiveGain,
      uDebugNoEmissive: DEFAULT_LOOK_DIALS.debugNoEmissive,
      uPalette: palette.texture
    });
    this.#maskShader = PIXI.Shader.from(BUILDING_MASK_VERT, BUILDING_MASK_FRAG, {
      uPivot: this.#maskPivot,
      uPixelsPerMetre: 25,
      uCamHeight: 8750,
      uLeanStrength: 1
    });
    this.#shadowShader = PIXI.Shader.from(SHADOW_VERT, SHADOW_FRAG, {
      uPixelsPerMetre: 25,
      uSunDir: new Float32Array([-LIGHT_DIRECTION.x, -LIGHT_DIRECTION.y]),
      uSunLength: SHADOW_LENGTH
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
    u.uDetailQuality = c.detailQuality;

    const m = this.#maskShader.uniforms;
    m.uPixelsPerMetre = c.pixelsPerMetre;
    m.uCamHeight = c.cameraHeightPx;
    m.uLeanStrength = c.leanStrength;
    this.#shadowShader.uniforms.uPixelsPerMetre = c.pixelsPerMetre;
  }

  /**
   * Live look dials for the colour pass. Called from `CityRenderer.update` next to
   * `setCamera`, so a `markContentDirty` refresh re-pushes them even on a parked camera.
   */
  setDials(d: LookDials): void {
    const u = this.#cityShader.uniforms;
    u.uBodyExposure = d.bodyExposure;
    u.uSkyLift = d.skyLift;
    u.uEmissiveGain = d.emissiveGain;
    u.uDebugNoEmissive = d.debugNoEmissive;
  }

  /** The mask is a flat silhouette, so it neither reads nor writes depth. */
  setMaskPass(enabled: boolean): void {
    this.display.shader = enabled ? this.#maskShader : this.#cityShader;
    this.display.state.depthTest = !enabled;
    this.display.state.depthMask = !enabled;
  }

  /** The translated roof silhouettes neither read nor write the scene depth buffer. */
  setShadowPass(enabled: boolean): void {
    this.display.shader = enabled ? this.#shadowShader : this.#cityShader;
    this.display.state.depthTest = !enabled;
    this.display.state.depthMask = !enabled;
  }

  /** The palette texture is shared and outlives this mesh. */
  destroy(): void {
    this.display.destroy();
    this.#geometry.destroy();
    this.#cityShader.destroy?.();
    this.#maskShader.destroy?.();
    this.#shadowShader.destroy?.();
  }
}
