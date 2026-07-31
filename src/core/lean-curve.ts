export interface LeanCurvePoint {
  zoom: number;
  strength: number;
}

export const DOLLY_LEAN_POINTS: readonly LeanCurvePoint[] = [
  { zoom: 0.03, strength: 0.15 },
  { zoom: 0.07219857701073255, strength: 0.4 },
  { zoom: 0.14576543217413787, strength: 1.25 },
  { zoom: 0.4984537654813396, strength: 2.5 },
  { zoom: 1.1995884191131372, strength: 5 },
  { zoom: 2.0915217752808024, strength: 12 },
  { zoom: 5.9999999999999805, strength: 32 }
];

const xs = DOLLY_LEAN_POINTS.map((point) => Math.log(point.zoom));
const ys = DOLLY_LEAN_POINTS.map((point) => point.strength);
const widths = xs.slice(0, -1).map((x, i) => xs[i + 1]! - x);
const slopes = widths.map((width, i) => (ys[i + 1]! - ys[i]!) / width);

function endpointTangent(h0: number, h1: number, d0: number, d1: number): number {
  let tangent = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(tangent) !== Math.sign(d0)) return 0;
  if (Math.sign(d0) !== Math.sign(d1) && Math.abs(tangent) > 3 * Math.abs(d0)) {
    tangent = 3 * d0;
  }
  return tangent;
}

function curveTangents(pointCount = xs.length): number[] {
  const last = pointCount - 1;
  const tangents = [endpointTangent(widths[0]!, widths[1]!, slopes[0]!, slopes[1]!)];
  for (let i = 1; i < last; i++) {
    const before = slopes[i - 1]!;
    const after = slopes[i]!;
    if (before * after <= 0) {
      tangents.push(0);
      continue;
    }
    const beforeWidth = widths[i - 1]!;
    const afterWidth = widths[i]!;
    const w1 = 2 * afterWidth + beforeWidth;
    const w2 = afterWidth + 2 * beforeWidth;
    tangents.push((w1 + w2) / (w1 / before + w2 / after));
  }
  tangents.push(
    endpointTangent(
      widths[last - 1]!,
      widths[last - 2]!,
      slopes[last - 1]!,
      slopes[last - 2]!
    )
  );
  return tangents;
}

const tangents = curveTangents();
// WHY: zooms through 1.2x are already approved. Preserve their exact curve while extending it.
tangents[4] = curveTangents(5)[4]!;

export function dollyLeanStrength(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error("Zoom must be finite and positive.");
  const x = Math.log(zoom);
  const last = xs.length - 1;
  if (x <= xs[0]!) return ys[0]! + tangents[0]! * (x - xs[0]!);
  if (x >= xs[last]!) return ys[last]! + tangents[last]! * (x - xs[last]!);

  let i = 0;
  while (x > xs[i + 1]!) i++;
  const width = widths[i]!;
  const t = (x - xs[i]!) / width;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * ys[i]! +
    (t3 - 2 * t2 + t) * width * tangents[i]! +
    (-2 * t3 + 3 * t2) * ys[i + 1]! +
    (t3 - t2) * width * tangents[i + 1]!
  );
}
