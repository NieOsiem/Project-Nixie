/**
 * Deterministic scalar hash in [0, 1). Position plus seed in, same value out on every
 * client forever — which is what lets the flag store a seed instead of the results.
 */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (y | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15) ^ (seed | 0), 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Deterministic pick from a list. */
export function hashPick<T>(items: readonly T[], x: number, y: number, salt = 0, seed = 0): T {
  if (items.length === 0) throw new Error("hashPick needs a non-empty list.");
  const t = hash2(x + salt * 7919, y - salt * 104729, seed);
  return items[Math.min(items.length - 1, Math.floor(t * items.length))]!;
}
