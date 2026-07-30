import type { Ring, Vec2 } from "./types.js";

function perpendicularDistanceSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  const cross = dx * (a.y - p.y) - dy * (a.x - p.x);
  return (cross * cross) / lenSq;
}

/** Douglas-Peucker over an open polyline. Iterative, so ring size can't blow the stack. */
function simplifyChain(points: Vec2[], toleranceSq: number): Vec2[] {
  const n = points.length;
  if (n < 3) return [...points];

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let worstIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistanceSq(points[i]!, points[first]!, points[last]!);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worstIndex !== -1 && worst > toleranceSq) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Simplify a closed ring, collapsing the many short segments that junction discs and
 * boolean operations leave behind. Each removed point is one fewer Wall document.
 */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  const n = ring.length;
  if (n < 4) return [...ring];

  // WHY: anchor on an extreme point so the result depends on the ring's shape, not on
  // wherever the boolean pass happened to start it. Keeps wall ids stable across rebuilds.
  let anchor = 0;
  for (let i = 1; i < n; i++) {
    const best = ring[anchor]!;
    const p = ring[i]!;
    if (p.x < best.x || (p.x === best.x && p.y < best.y)) anchor = i;
  }
  const rotated = [...ring.slice(anchor), ...ring.slice(0, anchor)];

  let far = 1;
  let farDist = -1;
  for (let i = 1; i < n; i++) {
    const dx = rotated[i]!.x - rotated[0]!.x;
    const dy = rotated[i]!.y - rotated[0]!.y;
    const d = dx * dx + dy * dy;
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }

  const toleranceSq = tolerance * tolerance;
  const head = simplifyChain(rotated.slice(0, far + 1), toleranceSq);
  const tail = simplifyChain([...rotated.slice(far), rotated[0]!], toleranceSq);
  const result = [...head.slice(0, -1), ...tail.slice(0, -1)];

  return result.length >= 3 ? result : [...ring];
}
