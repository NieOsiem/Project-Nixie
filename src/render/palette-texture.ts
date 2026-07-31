import { PALETTE_ROWS, PALETTE_SIZE } from "../core/palette.js";

/**
 * The RGBA8 material lookup, shared by every chunk mesh.
 *
 * One texture rather than one per mesh: retinting a district must cost a single upload,
 * not one per chunk. Row 0 is base colour, row 1 emissive with strength in alpha.
 */
export class PaletteTexture {
  readonly texture: any;

  constructor(palette: Uint8Array) {
    this.texture = PIXI.Texture.fromBuffer(palette, PALETTE_SIZE, PALETTE_ROWS, {
      format: PIXI.FORMATS.RGBA,
      type: PIXI.TYPES.UNSIGNED_BYTE,
      scaleMode: PIXI.SCALE_MODES.NEAREST,
      mipmap: PIXI.MIPMAP_MODES.OFF,
      wrapMode: PIXI.WRAP_MODES.CLAMP
    });
  }

  update(palette: Uint8Array): void {
    this.texture.baseTexture.resource.data.set(palette);
    this.texture.baseTexture.update();
  }

  destroy(): void {
    this.texture.destroy(true);
  }
}
