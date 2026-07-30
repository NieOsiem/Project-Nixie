import type { MeshBuffers } from "../core/geom/mesh.js";
import { rectsIntersect, type Rect } from "../core/geom/types.js";

export interface ChunkGeometry {
  id: string;
  mesh: MeshBuffers;
  /** Culling bounds in WORLD PIXELS, already including any building overhang. */
  boundsPx: Rect;
}

/** All culling needs. Both `ChunkGeometry` and the renderer's live chunks satisfy it. */
export interface CullableChunk {
  id: string;
  boundsPx: Rect;
}

/** Reserved id for the single whole-city mesh installed by `CityRenderer.setGeometry`. */
export const WHOLE_CITY_CHUNK_ID = "__whole-city__";

// WHY: finite on purpose — an infinite rect makes `x + width` NaN, and every NaN
// comparison in rectsIntersect is false, which would cull the thing it must never cull.
const UNCULLED_EXTENT = 1e12;

/** Bounds every finite view rect intersects, so the whole-city mesh is never culled. */
export const UNCULLED_BOUNDS: Rect = {
  x: -UNCULLED_EXTENT,
  y: -UNCULLED_EXTENT,
  width: 2 * UNCULLED_EXTENT,
  height: 2 * UNCULLED_EXTENT
};

/**
 * Ids of the chunks that overlap the view, in iteration order.
 *
 * WHY: footprint bounds need no overhang margin. The shader leans vertices radially
 * outward from the pivot, which the host pins to screen centre, so off-screen geometry
 * only ever leans further off-screen — padding this rect fixes a bug that cannot happen.
 */
export function visibleChunkIds(chunks: Iterable<CullableChunk>, viewRect: Rect): string[] {
  const ids: string[] = [];
  for (const chunk of chunks) {
    if (rectsIntersect(chunk.boundsPx, viewRect)) ids.push(chunk.id);
  }
  return ids;
}
