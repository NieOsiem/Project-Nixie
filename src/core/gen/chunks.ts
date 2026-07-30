import type { Rect, Vec2 } from "../geom/types.js";

/** Chunk edge length in metres. The grid is anchored at metre origin (0, 0). */
export const CHUNK_SIZE_M = 128;

export interface ChunkKey {
  cx: number;
  cy: number;
}

/** Stable string form for use as a Map key. */
export function chunkId(key: ChunkKey): string {
  return `${key.cx},${key.cy}`;
}

export function parseChunkId(id: string): ChunkKey {
  const parts = /^(-?\d+),(-?\d+)$/.exec(id);
  if (parts === null) throw new Error(`Not a chunk id: ${id}`);
  return { cx: Number(parts[1]), cy: Number(parts[2]) };
}

/** The chunk containing a point. A point on a boundary belongs to the higher chunk. */
export function chunkKeyAt(p: Vec2, sizeM = CHUNK_SIZE_M): ChunkKey {
  return { cx: Math.floor(p.x / sizeM), cy: Math.floor(p.y / sizeM) };
}

/** The metre-space rect a chunk covers, `[cx*size, cx*size + size)` on each axis. */
export function chunkRect(key: ChunkKey, sizeM = CHUNK_SIZE_M): Rect {
  return { x: key.cx * sizeM, y: key.cy * sizeM, width: sizeM, height: sizeM };
}

/**
 * Every chunk whose rect intersects the given rect, sorted by cx then cy.
 *
 * WHY: half-open on the max edge to match `chunkRect`, so `chunksCovering(chunkRect(k))`
 * is `[k]`. `rectsIntersect` deliberately differs — it counts edge touches. Do not unify.
 */
export function chunksCovering(rect: Rect, sizeM = CHUNK_SIZE_M): ChunkKey[] {
  const x0 = Math.floor(Math.min(rect.x, rect.x + rect.width) / sizeM);
  const y0 = Math.floor(Math.min(rect.y, rect.y + rect.height) / sizeM);
  const x1 = Math.max(x0, Math.ceil(Math.max(rect.x, rect.x + rect.width) / sizeM) - 1);
  const y1 = Math.max(y0, Math.ceil(Math.max(rect.y, rect.y + rect.height) / sizeM) - 1);

  const keys: ChunkKey[] = [];
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) keys.push({ cx, cy });
  }
  return keys;
}

/**
 * Generation margin. A chunk must union road quads and junction discs whose centreline
 * lies outside it but whose width reaches in. Returns the chunk rect grown by marginM.
 */
export function chunkQueryRect(key: ChunkKey, marginM: number, sizeM = CHUNK_SIZE_M): Rect {
  return {
    x: key.cx * sizeM - marginM,
    y: key.cy * sizeM - marginM,
    width: sizeM + marginM * 2,
    height: sizeM + marginM * 2
  };
}
