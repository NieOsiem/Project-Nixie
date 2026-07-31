/**
 * Encoding of surface height into the scene target's alpha channel.
 *
 * The scene render texture is half-float with depth test on, and nothing downstream ever
 * read its alpha — the composite and threshold both take `.rgb`, the neon pass deliberately
 * writes alpha 0 so additive glow cannot accumulate there, and the presented texture is the
 * composite's own RGBA8 output. So alpha is a free, depth-correct, nearest-wins height
 * buffer: the post chain gets per-pixel height for no extra pass, geometry or bandwidth.
 *
 * A cleared pixel is alpha 0, so the floor is what distinguishes "ground, height 0" from
 * "nothing drawn here" — without it the void outside the city reads as ground and takes
 * full fog.
 */

/** Height in metres that saturates the channel. Above this, buildings stop resolving apart. */
export const SCENE_HEIGHT_NORM_M = 256;

/** Alpha written at height 0. Anything below half of this is background, not geometry. */
export const SCENE_ALPHA_FLOOR = 1 / 64;
