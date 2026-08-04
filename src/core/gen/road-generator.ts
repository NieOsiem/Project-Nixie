import { hash2 } from "./hash.js";
import { allocateGeneratedId, ROUTE_CLASS_REGISTRY, validateRoadSource, type HubMode, type RoadLayout, type RoadSource, type RouteClassId } from "./city.js";
import { deriveLabelledSeed } from "./terrain.js";
import { difference, intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, type Rect, type Ring, type Vec2 } from "../geom/types.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { validateRouteTopology } from "../graph/topology.js";

export interface RoadGenerationInput {
  citySeed: string;
  mask: Ring;
  land?: Ring;
  layout?: RoadLayout;
  hubMode?: HubMode;
  sceneBounds?: Rect;
}

export interface RoadGenerationDiagnostics {
  layout: RoadLayout;
  hubMode: HubMode;
  hubs: string[];
  attempts: number;
  discarded: number;
  warnings: string[];
}

export interface GeneratedRoadNetwork {
  roads: RoadSource;
  diagnostics: RoadGenerationDiagnostics;
}

type CurvePreset = "tight" | "standard" | "broad";

const EPS = 0.001;
const NEAR_PARALLEL_SIN = 0.1;
const JUNCTION_TOLERANCE_M = 1;
const CLIP_MARGIN_M = 1;
const PARALLEL_MARGIN_M = 2;
const DEG = Math.PI / 180;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function clearanceOf(classId: RouteClassId): number {
  const cls = ROUTE_CLASS_REGISTRY.get(classId);
  if (!cls) return 3;
  return cls.widthM / 2 + cls.sidewalkM;
}

function minLengthOf(classId: RouteClassId): number {
  return classId === "highway" || classId === "arterial" || classId === "street" || classId === "narrow" ? 10 : 6;
}

function bounds(ring: Ring): Rect {
  const xs = ring.map((point) => point.x);
  const ys = ring.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function pointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (Math.abs((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) <= EPS && point.x >= Math.min(a.x, b.x) - EPS && point.x <= Math.max(a.x, b.x) + EPS && point.y >= Math.min(a.y, b.y) - EPS && point.y <= Math.max(a.y, b.y) + EPS) return true;
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

function pointInRect(point: Vec2, rect: Rect): boolean {
  return point.x >= rect.x - EPS && point.x <= rect.x + rect.width + EPS && point.y >= rect.y - EPS && point.y <= rect.y + rect.height + EPS;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerpPoint(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Sample the corridor (centreline + both offsets every 2 m, plus endpoint discs) against mask and land.
 *  Samples outside the scene rect are ignored (roads may run to the map edge). */
function corridorFits(a: Vec2, b: Vec2, clearanceM: number, mask: Ring, land: Ring, sceneBounds?: Rect): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= EPS) return false;
  const clearance = clearanceM + CLIP_MARGIN_M;
  const count = Math.max(1, Math.ceil(length / 2));
  const nx = (-(b.y - a.y) / length) * clearance;
  const ny = ((b.x - a.x) / length) * clearance;
  const check = (point: Vec2): boolean => {
    if (sceneBounds && !pointInRect(point, sceneBounds)) return true;
    return pointInRing(point, mask) && pointInRing(point, land);
  };
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const centre = lerpPoint(a, b, t);
    if (!check(centre) || !check({ x: centre.x + nx, y: centre.y + ny }) || !check({ x: centre.x - nx, y: centre.y - ny })) return false;
  }
  for (const point of [a, b]) {
    for (let k = 0; k < 24; k++) {
      const angle = (k / 24) * Math.PI * 2;
      if (!check({ x: point.x + Math.cos(angle) * clearance, y: point.y + Math.sin(angle) * clearance })) return false;
    }
  }
  return true;
}

function segmentIntersectionParam(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) <= 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  return { t, u };
}

function projectPoint(a: Vec2, b: Vec2, p: Vec2): { t: number; point: Vec2; dist: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const point = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, point, dist: Math.hypot(p.x - point.x, p.y - point.y) };
}

/** True when the candidate segment runs within corridor sums (+ margin) of a near-parallel barrier
 *  over overlapping projections. This is the geometry the topology validator flags. */
function parallelConflict(a: Vec2, b: Vec2, clearanceA: number, barriers: readonly { a: Vec2; b: Vec2; clearance: number }[]): boolean {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const len = Math.hypot(ux, uy);
  if (len <= EPS) return false;
  const dx = ux / len;
  const dy = uy / len;
  for (const barrier of barriers) {
    if (dist(a, barrier.a) <= EPS || dist(a, barrier.b) <= EPS || dist(b, barrier.a) <= EPS || dist(b, barrier.b) <= EPS) continue;
    const vx = barrier.b.x - barrier.a.x;
    const vy = barrier.b.y - barrier.a.y;
    const vlen = Math.hypot(vx, vy);
    if (vlen <= EPS) continue;
    const ex = vx / vlen;
    const ey = vy / vlen;
    if (Math.abs(dx * ey - dy * ex) > NEAR_PARALLEL_SIN) continue;
    const sep = Math.abs(dx * (barrier.a.y - a.y) - dy * (barrier.a.x - a.x));
    if (sep >= clearanceA + barrier.clearance + PARALLEL_MARGIN_M) continue;
    const ta0 = dx * a.x + dy * a.y;
    const ta1 = dx * b.x + dy * b.y;
    const tb0 = dx * barrier.a.x + dy * barrier.a.y;
    const tb1 = dx * barrier.b.x + dy * barrier.b.y;
    const lo = Math.max(Math.min(ta0, ta1), Math.min(tb0, tb1));
    const hi = Math.min(Math.max(ta0, ta1), Math.max(tb0, tb1));
    if (lo <= hi + EPS) return true;
  }
  return false;
}

/** Clip segment to land/mask: keep the inside intervals, then shrink/refine until corridors fit. */
function clipSegment(a: Vec2, b: Vec2, clearanceM: number, mask: Ring, land: Ring, sceneBounds: Rect, minLen: number, out: Vec2[]): void {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < minLen) return;
  const ts = [0, 1];
  for (const ring of [mask, land]) {
    for (let i = 0; i < ring.length; i++) {
      const c = ring[i]!;
      const d = ring[(i + 1) % ring.length]!;
      const x = segmentIntersectionParam(a, b, c, d);
      if (x && x.t > 1e-6 && x.t < 1 - 1e-6 && x.u > 1e-6 && x.u < 1 - 1e-6) ts.push(x.t);
    }
  }
  ts.sort((p, q) => p - q);
  const unique: number[] = [];
  for (const t of ts) if (unique.length === 0 || t - unique[unique.length - 1]! > 1e-6) unique.push(t);
  for (let i = 0; i + 1 < unique.length; i++) {
    const t0 = unique[i]!;
    const t1 = unique[i + 1]!;
    const mid = lerpPoint(a, b, (t0 + t1) / 2);
    if (!pointInRing(mid, mask) || !pointInRing(mid, land)) continue;
    fitInterval(a, b, t0, t1, clearanceM, mask, land, sceneBounds, minLen, out);
  }
}

function fitInterval(a: Vec2, b: Vec2, t0: number, t1: number, clearanceM: number, mask: Ring, land: Ring, sceneBounds: Rect, minLen: number, out: Vec2[]): void {
  const p0 = lerpPoint(a, b, t0);
  const p1 = lerpPoint(a, b, t1);
  if (corridorFits(p0, p1, clearanceM, mask, land, sceneBounds)) {
    out.push(p0, p1);
    return;
  }
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if ((t1 - t0) * length < minLen) return;
  const tm = (t0 + t1) / 2;
  fitInterval(a, b, t0, tm, clearanceM, mask, land, sceneBounds, minLen, out);
  fitInterval(a, b, tm, t1, clearanceM, mask, land, sceneBounds, minLen, out);
}

interface PlannedLine {
  points: Vec2[];
  classId: RouteClassId;
  preset: CurvePreset;
  role: string;
  closed?: boolean;
}

function minLengthOfPlannedLine(line: PlannedLine): number {
  // Polygonal roundabout edges deliberately use short chords so approaches can attach to the
  // ring at exact junction vertices without a decorative road continuing through the centre.
  if (line.role.includes("roundabout/") && line.role.includes("/ring/")) return 1.25;
  return minLengthOf(line.classId);
}

interface Barrier {
  a: Vec2;
  b: Vec2;
  clearance: number;
}

interface PlanState {
  mask: Ring;
  land: Ring;
  sceneBounds: Rect;
  box: Rect;
  centre: Vec2;
  minDim: number;
  seed: number;
  lines: PlannedLine[];
  barriers: Barrier[];
  hubPoints: Vec2[];
  warnings: string[];
  rejected: number;
}

function linePairs(line: PlannedLine): [Vec2, Vec2][] {
  const pairs: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < line.points.length; i++) pairs.push([line.points[i]!, line.points[i + 1]!]);
  if (line.closed && line.points.length > 2) pairs.push([line.points[line.points.length - 1]!, line.points[0]!]);
  return pairs;
}

function barriersForLines(lines: readonly PlannedLine[]): Barrier[] {
  const barriers: Barrier[] = [];
  for (const line of lines) {
    const clearance = clearanceOf(line.classId);
    for (const [a, b] of linePairs(line)) barriers.push({ a, b, clearance });
  }
  return barriers;
}

/** Add a planned polyline unless any of its segments would run near-parallel-close to an existing line. */
function pushLine(state: PlanState, points: Vec2[], classId: RouteClassId, preset: CurvePreset, role: string, opts: { closed?: boolean } = {}): boolean {
  if (points.length < 2) return false;
  const pts = points;
  const clearance = clearanceOf(classId);
  const pairs: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < pts.length; i++) pairs.push([pts[i]!, pts[i + 1]!]);
  if (opts.closed && pts.length > 2) pairs.push([pts[pts.length - 1]!, pts[0]!]);
  for (const [a, b] of pairs) {
    if (parallelConflict(a, b, clearance, state.barriers)) {
      state.rejected++;
      return false;
    }
  }
  state.lines.push({ points: pts, classId, preset, role, closed: opts.closed });
  for (const [a, b] of pairs) state.barriers.push({ a, b, clearance });
  return true;
}

function axisLines(state: PlanState): { verticals: number[]; horizontals: number[] } {
  const verticals: number[] = [state.box.x, state.box.x + state.box.width];
  const horizontals: number[] = [state.box.y, state.box.y + state.box.height];
  for (const line of state.lines) {
    const pts = line.points;
    if (line.closed || pts.length < 2) continue;
    const xMin = Math.min(...pts.map((p) => p.x));
    const xMax = Math.max(...pts.map((p) => p.x));
    const yMin = Math.min(...pts.map((p) => p.y));
    const yMax = Math.max(...pts.map((p) => p.y));
    if (xMax - xMin <= EPS && yMax - yMin > EPS) verticals.push(xMin);
    else if (yMax - yMin <= EPS && xMax - xMin > EPS) horizontals.push(yMin);
  }
  const dedupe = (values: number[]): number[] => [...new Set(values.map((v) => Math.round(v / 1e-3) / 1e3))].sort((p, q) => p - q);
  return { verticals: dedupe(verticals), horizontals: dedupe(horizontals) };
}

function planArterials(state: PlanState): { verticals: number[]; horizontals: number[] } {
  const verticals: number[] = [];
  const horizontals: number[] = [];
  const spacing = Math.min(clamp(state.minDim / 3, 220, 420), state.minDim * 0.45);
  for (const axis of ["x", "y"] as const) {
    const extent = axis === "x" ? state.box.width : state.box.height;
    const start = axis === "x" ? state.box.x : state.box.y;
    const centre = axis === "x" ? state.centre.x : state.centre.y;
    const out = axis === "x" ? verticals : horizontals;
    for (let k = 0; ; k++) {
      const offset = (k + 0.5) * spacing;
      if (offset > extent / 2 - 8) break;
      for (const sign of [1, -1]) {
        const pos = centre + sign * offset;
        if (pos < start + 4 || pos > start + extent - 4) continue;
        const a = axis === "x" ? { x: pos, y: state.box.y } : { x: state.box.x, y: pos };
        const b = axis === "x" ? { x: pos, y: state.box.y + state.box.height } : { x: state.box.x + state.box.width, y: pos };
        if (pushLine(state, [a, b], "arterial", "broad", `arterial/${axis}/${k}/${sign}`)) out.push(pos);
      }
    }
    out.sort((p, q) => p - q);
  }
  return { verticals, horizontals };
}

function planAvenues(state: PlanState): void {
  const diag = Math.hypot(state.box.width, state.box.height) / 2 + 100;
  const theta1 = (15 + hash2(1, 1, state.seed) * 20) * DEG;
  const theta2 = (15 + hash2(1, 2, state.seed) * 20) * DEG;
  const c = state.centre;
  pushLine(state, [
    { x: c.x + Math.cos(theta1) * diag, y: c.y + Math.sin(theta1) * diag },
    { x: c.x - Math.cos(theta1) * diag, y: c.y - Math.sin(theta1) * diag }
  ], "arterial", "broad", "avenue/0");
  pushLine(state, [
    { x: c.x + Math.cos(-theta2) * diag, y: c.y + Math.sin(-theta2) * diag },
    { x: c.x - Math.cos(-theta2) * diag, y: c.y - Math.sin(-theta2) * diag }
  ], "arterial", "broad", "avenue/1");
}

/** Ring road (one route per side, so corners stay sharp and nothing can sweep into the diagonals)
 *  plus a cycleway loop 18 m further out. All-or-nothing: a side that would run parallel-close
 *  to the mesh kills the whole ring. */
function planRings(state: PlanState): void {
  const inset = clamp(state.minDim * 0.07, 24, 70);
  const rw = state.box.width - 2 * inset;
  const rh = state.box.height - 2 * inset;
  if (rw < 80 || rh < 80) return;
  const x0 = state.box.x + inset;
  const x1 = state.box.x + state.box.width - inset;
  const y0 = state.box.y + inset;
  const y1 = state.box.y + state.box.height - inset;
  const classId: RouteClassId = state.minDim >= 600 ? "arterial" : "street";
  const clearance = clearanceOf(classId);
  const sides: [Vec2, Vec2][] = [
    [{ x: x0, y: y0 }, { x: x1, y: y0 }],
    [{ x: x1, y: y0 }, { x: x1, y: y1 }],
    [{ x: x1, y: y1 }, { x: x0, y: y1 }],
    [{ x: x0, y: y1 }, { x: x0, y: y0 }]
  ];
  for (const [a, b] of sides) {
    if (parallelConflict(a, b, clearance, state.barriers)) return;
  }
  const names = ["ring/n", "ring/e", "ring/s", "ring/w"] as const;
  for (let i = 0; i < 4; i++) {
    const [a, b] = sides[i]! as [Vec2, Vec2];
    state.lines.push({ points: [a, b], classId, preset: "broad", role: names[i]! });
    state.barriers.push({ a, b, clearance });
  }
  if (inset >= 30) {
    const cx0 = x0 - 18;
    const cx1 = x1 + 18;
    const cy0 = y0 - 18;
    const cy1 = y1 + 18;
    if (cx0 < state.box.x + 4 || cy0 < state.box.y + 4) return;
    const cycleClearance = clearanceOf("cycleway");
    const cycleSides: [Vec2, Vec2][] = [
      [{ x: cx0, y: cy0 }, { x: cx1, y: cy0 }],
      [{ x: cx1, y: cy0 }, { x: cx1, y: cy1 }],
      [{ x: cx1, y: cy1 }, { x: cx0, y: cy1 }],
      [{ x: cx0, y: cy1 }, { x: cx0, y: cy0 }]
    ];
    for (const [a, b] of cycleSides) {
      if (parallelConflict(a, b, cycleClearance, state.barriers)) return;
    }
    const cycleNames = ["cycle/n", "cycle/e", "cycle/s", "cycle/w"] as const;
    for (let i = 0; i < 4; i++) {
      const [a, b] = cycleSides[i]!;
      state.lines.push({ points: [a, b], classId: "cycleway", preset: "tight", role: cycleNames[i]! });
      state.barriers.push({ a, b, clearance: cycleClearance });
    }
  }
}

/** Old-town: a sharp-cornered square of narrow streets around the central crossing with a
 *  pedestrian plaza X across it. */
function planOldTown(state: PlanState): void {
  if (state.minDim < 320) return;
  const half = clamp(state.minDim * 0.075, 28, 75);
  const c = state.centre;
  const clearance = clearanceOf("narrow");
  const sides: [Vec2, Vec2][] = [
    [{ x: c.x - half, y: c.y - half }, { x: c.x + half, y: c.y - half }],
    [{ x: c.x + half, y: c.y - half }, { x: c.x + half, y: c.y + half }],
    [{ x: c.x + half, y: c.y + half }, { x: c.x - half, y: c.y + half }],
    [{ x: c.x - half, y: c.y + half }, { x: c.x - half, y: c.y - half }]
  ];
  for (const [a, b] of sides) {
    if (parallelConflict(a, b, clearance, state.barriers)) return;
  }
  const names = ["oldtown/n", "oldtown/e", "oldtown/s", "oldtown/w"] as const;
  for (let i = 0; i < 4; i++) {
    const [a, b] = sides[i]! as [Vec2, Vec2];
    state.lines.push({ points: [a, b], classId: "narrow", preset: "tight", role: names[i]! });
    state.barriers.push({ a, b, clearance });
  }
  // Two full diagonals crossing at the centre (the four half-diagonals would be collinear
  // pairs on the same line, which the junction pass cannot distinguish).
  pushLine(state, [{ x: c.x - half, y: c.y - half }, { x: c.x + half, y: c.y + half }], "plaza-route", "standard", "plaza/0");
  pushLine(state, [{ x: c.x + half, y: c.y - half }, { x: c.x - half, y: c.y + half }], "plaza-route", "standard", "plaza/1");
  state.hubPoints.push(c);
}

/** Return the segment parameters where a segment crosses a circle. */
function segmentCircleIntersections(a: Vec2, b: Vec2, centre: Vec2, radius: number): number[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - centre.x;
  const fy = a.y - centre.y;
  const qa = dx * dx + dy * dy;
  if (qa <= 1e-12) return [];
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - radius * radius;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < -1e-9) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const values = [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]
    .filter((t) => t > 1e-8 && t < 1 - 1e-8)
    .sort((x, y) => x - y);
  return values.filter((t, index) => index === 0 || Math.abs(t - values[index - 1]!) > 1e-8);
}

function snapToCircle(point: Vec2, centre: Vec2, radius: number): Vec2 {
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  const length = Math.hypot(dx, dy);
  if (length <= EPS) return { x: centre.x + radius, y: centre.y };
  return { x: centre.x + (dx / length) * radius, y: centre.y + (dy / length) * radius };
}

/** Remove the parts of a polyline inside a circle and return the remaining approach pieces. */
function clipPolylineOutsideCircle(points: readonly Vec2[], centre: Vec2, radius: number): { pieces: Vec2[][]; removedInterior: boolean } {
  const pieces: Vec2[][] = [];
  let current: Vec2[] | null = null;
  let removedInterior = false;
  const flush = (): void => {
    if (current && current.length >= 2 && dist(current[0]!, current[current.length - 1]!) > EPS) pieces.push(current);
    current = null;
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ts = [0, ...segmentCircleIntersections(a, b, centre, radius), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k]!;
      const t1 = ts[k + 1]!;
      const mid = lerpPoint(a, b, (t0 + t1) / 2);
      const outside = dist(mid, centre) >= radius - 1e-7;
      let p0 = lerpPoint(a, b, t0);
      let p1 = lerpPoint(a, b, t1);
      if (Math.abs(dist(p0, centre) - radius) <= 1e-5) p0 = snapToCircle(p0, centre, radius);
      if (Math.abs(dist(p1, centre) - radius) <= 1e-5) p1 = snapToCircle(p1, centre, radius);
      if (!outside) {
        removedInterior = true;
        flush();
        continue;
      }
      if (!current) current = [p0, p1];
      else if (dist(current[current.length - 1]!, p0) <= EPS) current.push(p1);
      else {
        flush();
        current = [p0, p1];
      }
    }
  }
  flush();
  return { pieces, removedInterior };
}

/** Replace a vehicle-road crossing with a polygonal roundabout. The operation is transactional:
 *  every through road is cut back to the ring, every approach terminates on the ring, and no
 *  partial ring or partially cut road is published when any candidate edge conflicts. */
function roundaboutAt(state: PlanState, centre: Vec2, role: string): boolean {
  const radius = clamp(state.minDim * 0.035, 18, 42);
  if (centre.x - radius - 8 < state.box.x || centre.x + radius + 8 > state.box.x + state.box.width || centre.y - radius - 8 < state.box.y || centre.y + radius + 8 > state.box.y + state.box.height) return false;

  const retained: PlannedLine[] = [];
  const approaches: PlannedLine[] = [];
  const attachmentAngles: number[] = [];
  let affectedLines = 0;
  for (let lineIndex = 0; lineIndex < state.lines.length; lineIndex++) {
    const line = state.lines[lineIndex]!;
    if (!ROUTE_CLASS_REGISTRY.get(line.classId)?.vehicle || line.closed) {
      retained.push(line);
      continue;
    }
    const clipped = clipPolylineOutsideCircle(line.points, centre, radius);
    if (!clipped.removedInterior) {
      retained.push(line);
      continue;
    }
    affectedLines++;
    for (let pieceIndex = 0; pieceIndex < clipped.pieces.length; pieceIndex++) {
      const points = clipped.pieces[pieceIndex]!;
      for (const endpoint of [points[0]!, points[points.length - 1]!]) {
        if (Math.abs(dist(endpoint, centre) - radius) <= 1e-4) attachmentAngles.push(Math.atan2(endpoint.y - centre.y, endpoint.x - centre.x));
      }
      approaches.push({ ...line, points, closed: false, role: `${line.role}/${role}/approach/${lineIndex}/${pieceIndex}` });
    }
  }
  // A one-road traffic circle is not a useful hub and an isolated ring can become the pruning root.
  if (affectedLines < 2 || attachmentAngles.length < 4) return false;

  interface RingVertex { angle: number; point: Vec2; attachment: boolean; }
  const vertices: RingVertex[] = [];
  const normalAngle = (angle: number): number => {
    const tau = Math.PI * 2;
    return ((angle % tau) + tau) % tau;
  };
  const addVertex = (angle: number, attachment: boolean): void => {
    const a = normalAngle(angle);
    const existing = vertices.find((vertex) => Math.min(Math.abs(vertex.angle - a), Math.PI * 2 - Math.abs(vertex.angle - a)) <= 1e-6);
    const point = { x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius };
    if (existing) {
      if (attachment) {
        existing.point = point;
        existing.attachment = true;
      }
      return;
    }
    vertices.push({ angle: a, point, attachment });
  };
  for (let k = 0; k < 24; k++) addVertex((15 + k * 15) * DEG, false);
  for (const angle of attachmentAngles) addVertex(angle, true);
  // Do not leave a tiny ring chord merely because an approach lands a few degrees from a
  // decorative base vertex. Keep the exact attachment and drop the nearby base vertex.
  const attachments = vertices.filter((vertex) => vertex.attachment);
  for (let i = vertices.length - 1; i >= 0; i--) {
    const vertex = vertices[i]!;
    if (vertex.attachment) continue;
    const tooClose = attachments.some((attachment) => {
      const delta = Math.min(Math.abs(vertex.angle - attachment.angle), Math.PI * 2 - Math.abs(vertex.angle - attachment.angle));
      return 2 * radius * Math.sin(delta / 2) < 2.5;
    });
    if (tooClose) vertices.splice(i, 1);
  }
  vertices.sort((a, b) => a.angle - b.angle);

  // Snap approach endpoints onto the exact ring vertices used below.
  for (const line of approaches) {
    for (const index of [0, line.points.length - 1]) {
      const point = line.points[index]!;
      if (Math.abs(dist(point, centre) - radius) > 1e-4) continue;
      const angle = normalAngle(Math.atan2(point.y - centre.y, point.x - centre.x));
      let best = vertices[0]!;
      let bestDelta = Infinity;
      for (const vertex of vertices) {
        const delta = Math.min(Math.abs(vertex.angle - angle), Math.PI * 2 - Math.abs(vertex.angle - angle));
        if (delta < bestDelta) {
          best = vertex;
          bestDelta = delta;
        }
      }
      line.points[index] = best.point;
    }
  }

  const candidateLines = [...retained, ...approaches];
  const candidateBarriers = barriersForLines(candidateLines);
  const ringLines: PlannedLine[] = [];
  const ringClearance = clearanceOf("street");
  for (let k = 0; k < vertices.length; k++) {
    const a = vertices[k]!.point;
    const b = vertices[(k + 1) % vertices.length]!.point;
    if (parallelConflict(a, b, ringClearance, candidateBarriers)) {
      state.rejected++;
      return false;
    }
    const line: PlannedLine = { points: [a, b], classId: "street", preset: "tight", role: `${role}/ring/${k}` };
    ringLines.push(line);
    candidateBarriers.push({ a, b, clearance: ringClearance });
  }

  state.lines = [...candidateLines, ...ringLines];
  state.barriers = candidateBarriers;
  return true;
}

function planRoundabouts(state: PlanState, hubMode: HubMode, gridCrossings?: { verticals: number[]; horizontals: number[] }): void {
  const R = clamp(state.minDim * 0.035, 18, 42);
  const picked: Vec2[] = [];
  const tryRing = (centre: Vec2, role: string): boolean => {
    if (picked.some((p) => dist(p, centre) < Math.max(2.2 * R, 80))) return false;
    if (roundaboutAt(state, centre, role)) {
      picked.push(centre);
      state.hubPoints.push(centre);
      return true;
    }
    return false;
  };
  if (gridCrossings) {
    tryRing(state.centre, "roundabout/0");
    if (hubMode === "multiple-hubs") {
      const target = hash2(5, 1, state.seed) < 0.5 ? 2 : 1;
      const candidates: Vec2[] = [];
      for (const x of gridCrossings.verticals) {
        for (const y of gridCrossings.horizontals) {
          const c = { x, y };
          if (dist(c, state.centre) >= Math.max(2.2 * R, 60)) candidates.push(c);
        }
      }
      const order = candidates.map((c, i) => ({ c, t: hash2(i, 41, state.seed) })).sort((p, q) => p.t - q.t);
      for (const { c } of order) {
        if (picked.length - 1 >= target) break;
        tryRing(c, `roundabout/${picked.length}`);
      }
    }
    return;
  }
  // european / mixed: one roundabout at an outer mesh crossing, far from the avenues.
  const verticals: number[] = [];
  const horizontals: number[] = [];
  for (const line of state.lines) {
    if (line.role.startsWith("arterial/x")) verticals.push(line.points[0]!.x);
    else if (line.role.startsWith("arterial/y")) horizontals.push(line.points[0]!.y);
  }
  const crossings: Vec2[] = [];
  for (const x of verticals) {
    for (const y of horizontals) crossings.push({ x, y });
  }
  const candidates = crossings.filter((c) => dist(c, state.centre) >= Math.max(state.minDim * 0.2, 90));
  const order = candidates.map((c, i) => ({ c, t: hash2(i, 43, state.seed) })).sort((p, q) => p.t - q.t);
  for (const { c } of order) {
    if (tryRing(c, "roundabout/0")) break;
  }
}

/** Secondary market squares for multiple-hubs: small sharp squares of streets in far cells. */
function planSecondaryHubs(state: PlanState, hubMode: HubMode, layout: RoadLayout): void {
  if (hubMode !== "multiple-hubs" || layout === "grid") return;
  const verticals: number[] = [];
  const horizontals: number[] = [];
  for (const line of state.lines) {
    if (line.role.startsWith("arterial/x")) verticals.push(line.points[0]!.x);
    else if (line.role.startsWith("arterial/y")) horizontals.push(line.points[0]!.y);
  }
  const uniqueSorted = (values: number[]): number[] => values
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]!) > EPS);
  const arterialXs = uniqueSorted(verticals);
  const arterialYs = uniqueSorted(horizontals);
  const half = clamp(state.minDim * 0.045, 22, 45);
  const cells: Rect[] = [];
  {
    const xs = [state.box.x, ...arterialXs, state.box.x + state.box.width];
    const ys = [state.box.y, ...arterialYs, state.box.y + state.box.height];
    for (let i = 0; i + 1 < xs.length; i++) {
      for (let j = 0; j + 1 < ys.length; j++) {
        cells.push({ x: xs[i]!, y: ys[j]!, width: xs[i + 1]! - xs[i]!, height: ys[j + 1]! - ys[j]! });
      }
    }
  }
  const candidates = cells
    .map((cell) => ({ x: cell.x + cell.width / 2, y: cell.y + cell.height / 2, cell }))
    .filter(({ x, y, cell }) => Math.min(cell.width, cell.height) / 2 >= half + 25 && dist({ x, y }, state.centre) >= state.minDim * 0.2);
  const order = candidates.map((c, i) => ({ c, t: hash2(i, 47, state.seed) })).sort((p, q) => p.t - q.t);
  const target = hash2(7, 1, state.seed) < 0.5 ? 2 : 1;
  const placed: Vec2[] = [];
  const clearance = clearanceOf("street");
  for (const { c } of order) {
    if (placed.length >= target) break;
    if (placed.some((p) => dist(p, c) < state.minDim * 0.25)) continue;
    const sides: [Vec2, Vec2][] = [
      [{ x: c.x - half, y: c.y - half }, { x: c.x + half, y: c.y - half }],
      [{ x: c.x + half, y: c.y - half }, { x: c.x + half, y: c.y + half }],
      [{ x: c.x + half, y: c.y + half }, { x: c.x - half, y: c.y + half }],
      [{ x: c.x - half, y: c.y + half }, { x: c.x - half, y: c.y - half }]
    ];
    if (sides.some(([a, b]) => parallelConflict(a, b, clearance, state.barriers))) continue;
    const names = [`secondary/${placed.length}/n`, `secondary/${placed.length}/e`, `secondary/${placed.length}/s`, `secondary/${placed.length}/w`];
    for (let i = 0; i < 4; i++) {
      const [a, b] = sides[i]! as [Vec2, Vec2];
      state.lines.push({ points: [a, b], classId: "street", preset: "tight", role: names[i]! });
      state.barriers.push({ a, b, clearance });
    }
    placed.push(c);
    state.hubPoints.push(c);
  }
}

function planStreets(state: PlanState, layout: RoadLayout): void {
  const verticals: number[] = [];
  const horizontals: number[] = [];
  for (const line of state.lines) {
    if (line.role.startsWith("arterial/x")) verticals.push(line.points[0]!.x);
    else if (line.role.startsWith("arterial/y")) horizontals.push(line.points[0]!.y);
  }
  const uniqueSorted = (values: number[]): number[] => values
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]!) > EPS);
  const xs = [state.box.x, ...uniqueSorted(verticals), state.box.x + state.box.width];
  const ys = [state.box.y, ...uniqueSorted(horizontals), state.box.y + state.box.height];
  const centreIn = (cell: Rect): boolean => state.centre.x >= cell.x && state.centre.x <= cell.x + cell.width && state.centre.y >= cell.y && state.centre.y <= cell.y + cell.height;
  let cellIndex = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cell = { x: xs[i]!, y: ys[j]!, width: xs[i + 1]! - xs[i]!, height: ys[j + 1]! - ys[j]! };
      if (layout === "mixed" && centreIn(cell)) {
        // Strict local grid: the central x/y pair is explicit, with symmetric street pairs
        // added only where the arterial-bounded cell has enough room.
        const spacing = clamp(state.minDim / 9, 70, 110);
        for (const axis of ["x", "y"] as const) {
          const lo = axis === "x" ? cell.x + 24 : cell.y + 24;
          const hi = axis === "x" ? cell.x + cell.width - 24 : cell.y + cell.height - 24;
          const centre = axis === "x" ? state.centre.x : state.centre.y;
          const positions = [centre];
          for (let k = 1; k < 8; k++) {
            const offset = k * spacing;
            positions.push(centre - offset, centre + offset);
          }
          for (const pos of positions.sort((a, b) => a - b)) {
            if (pos < lo || pos > hi) continue;
            const a = axis === "x" ? { x: pos, y: cell.y } : { x: cell.x, y: pos };
            const b = axis === "x" ? { x: pos, y: cell.y + cell.height } : { x: cell.x + cell.width, y: pos };
            const classId: RouteClassId = Math.abs(pos - centre) <= EPS ? "arterial" : "street";
            pushLine(state, [a, b], classId, "tight", `lattice/${axis}/${Math.round((pos - centre) / spacing)}`);
          }
        }
        roundaboutAt(state, state.centre, "roundabout/core");
        cellIndex++;
        continue;
      }
      const w = cell.width;
      const h = cell.height;
      if (Math.min(w, h) < 60) {
        cellIndex++;
        continue;
      }
      const vertical = hash2(cellIndex, 3, state.seed) < 0.7;
      const both = hash2(cellIndex, 5, state.seed) < 0.15;
      const span = vertical ? w : h;
      const n = Math.max(0, Math.min(4, Math.round(span / 120) - 1 + (hash2(cellIndex, 7, state.seed) < 0.4 ? 1 : 0)));
      const placed: number[] = [];
      for (let k = 0; k < n; k++) {
        const t = hash2(cellIndex, 9 + k, state.seed);
        const off = 24 + t * Math.max(1, span - 48);
        if (placed.some((o) => Math.abs(o - off) < 90)) continue;
        const classId = hash2(cellIndex, 13 + k, state.seed) < 0.45 ? "narrow" : "street";
        const a = vertical ? { x: cell.x + off, y: cell.y } : { x: cell.x, y: cell.y + off };
        const b = vertical ? { x: cell.x + off, y: cell.y + cell.height } : { x: cell.x + cell.width, y: cell.y + off };
        if (pushLine(state, [a, b], classId, "standard", `street/${cellIndex}/${k}`)) placed.push(off);
      }
      if (both) {
        const t = hash2(cellIndex, 21, state.seed);
        const spanOther = vertical ? h : w;
        const off = 24 + t * Math.max(1, spanOther - 48);
        const classId = hash2(cellIndex, 23, state.seed) < 0.45 ? "narrow" : "street";
        const a = vertical ? { x: cell.x, y: cell.y + off } : { x: cell.x + off, y: cell.y };
        const b = vertical ? { x: cell.x + cell.width, y: cell.y + off } : { x: cell.x + off, y: cell.y + cell.height };
        pushLine(state, [a, b], classId, "standard", `street/${cellIndex}/x`);
      }
      cellIndex++;
    }
  }
}

/** Mid-block lanes/alleys in every block formed by the axis-aligned network, some as cul-de-sacs. */
function planLanes(state: PlanState): void {
  const { verticals, horizontals } = axisLines(state);
  let blockIndex = 0;
  for (let i = 0; i + 1 < verticals.length; i++) {
    for (let j = 0; j + 1 < horizontals.length; j++) {
      const x0 = verticals[i]!;
      const x1 = verticals[i + 1]!;
      const y0 = horizontals[j]!;
      const y1 = horizontals[j + 1]!;
      const w = x1 - x0;
      const h = y1 - y0;
      const p = hash2(blockIndex, 1, state.seed);
      // Keep the old-town core clear: lanes there would T-junction centimetres from the
      // plaza diagonals' crossings and manufacture degenerate twin junctions.
      if (Math.min(w, h) < 50 || p >= 0.45 || dist({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, state.centre) < 40) {
        blockIndex++;
        continue;
      }
      const vertical = p < 0.225;
      const off = (vertical ? (x0 + x1) / 2 : (y0 + y1) / 2) + (hash2(blockIndex, 3, state.seed) - 0.5) * 12;
      const classId = hash2(blockIndex, 5, state.seed) < 0.5 ? "lane" : "alley";
      const cul = hash2(blockIndex, 7, state.seed) < 0.25;
      const depth = 0.55 + hash2(blockIndex, 9, state.seed) * 0.3;
      const a = vertical ? { x: off, y: y0 } : { x: x0, y: off };
      const b = vertical ? { x: off, y: cul ? y0 + h * depth : y1 } : { x: cul ? x0 + w * depth : x1, y: off };
      pushLine(state, [a, b], classId, "tight", `lane/${blockIndex}`);
      blockIndex++;
    }
  }
}

/** Highways from the ring to the map edge, one per side, placed in the gaps between parallel roads. */
function planHighways(state: PlanState): void {
  const inset = clamp(state.minDim * 0.07, 24, 70);
  const rw = state.box.width - 2 * inset;
  const rh = state.box.height - 2 * inset;
  if (rw < 80 || rh < 80) return;
  const count = state.minDim >= 450 ? 3 + (hash2(9, 1, state.seed) < 0.5 ? 1 : 0) : 2;
  const sides = ["w", "e", "n", "s"] as const;
  const chosen: { side: string; pos: number }[] = [];
  let guard = 0;
  while (chosen.length < count && guard++ < 80) {
    const side = sides[Math.floor(hash2(9, 2 + chosen.length * 2, state.seed) * 4)]!;
    const isH = side === "w" || side === "e";
    const extent = isH ? state.box.height : state.box.width;
    const lo = inset + 40;
    const hi = extent - inset - 40;
    if (hi <= lo) break;
    const pos = lo + hash2(9, 3 + chosen.length * 2, state.seed) * (hi - lo);
    if (chosen.some((c) => c.side === side && Math.abs(c.pos - pos) < 100)) continue;
    const a = side === "w" ? { x: state.box.x + inset, y: state.box.y + pos } : side === "e" ? { x: state.box.x + state.box.width - inset, y: state.box.y + pos } : side === "n" ? { x: state.box.x + pos, y: state.box.y + inset } : { x: state.box.x + pos, y: state.box.y + state.box.height - inset };
    const b = side === "w" ? { x: state.box.x, y: state.box.y + pos } : side === "e" ? { x: state.box.x + state.box.width, y: state.box.y + pos } : side === "n" ? { x: state.box.x + pos, y: state.box.y } : { x: state.box.x + pos, y: state.box.y + state.box.height };
    if (pushLine(state, [a, b], "highway", "standard", `highway/${side}/${chosen.length}`)) chosen.push({ side, pos });
  }
  if (chosen.length === 0) state.warnings.push("no highway position fit");
}

/** Waterfront promenade: find contiguous coastal runs, offset each run independently,
 *  keep only clear pieces, then connect exposed run ends to the nearest vehicle road. */
function planPromenade(state: PlanState): void {
  const land = state.land;
  const signed = ringArea(land);
  const ccw = signed > 0;
  interface CoastEdge { index: number; a: Vec2; b: Vec2; nx: number; ny: number; }
  const coastByIndex = new Map<number, CoastEdge>();
  for (let i = 0; i < land.length; i++) {
    const a = land[i]!;
    const b = land[(i + 1) % land.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < EPS) continue;
    const dx = (b.x - a.x) / length;
    const dy = (b.y - a.y) / length;
    const nx = ccw ? dy : -dy;
    const ny = ccw ? -dx : dx;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const probe = { x: mid.x + nx * 2, y: mid.y + ny * 2 };
    if (pointInRect(probe, state.sceneBounds) && !pointInRing(probe, land)) coastByIndex.set(i, { index: i, a, b, nx, ny });
  }
  if (coastByIndex.size === 0) return;

  const runs: { edges: CoastEdge[]; closed: boolean }[] = [];
  if (coastByIndex.size === land.length) {
    runs.push({ edges: [...coastByIndex.values()].sort((a, b) => a.index - b.index), closed: true });
  } else {
    let nonCoast = 0;
    while (coastByIndex.has(nonCoast)) nonCoast++;
    let current: CoastEdge[] = [];
    for (let step = 1; step <= land.length; step++) {
      const index = (nonCoast + step) % land.length;
      const edge = coastByIndex.get(index);
      if (edge) current.push(edge);
      else if (current.length > 0) {
        runs.push({ edges: current, closed: false });
        current = [];
      }
    }
    if (current.length > 0) runs.push({ edges: current, closed: false });
  }

  const insetPoint = (point: Vec2, previous: CoastEdge | undefined, next: CoastEdge | undefined): Vec2 => {
    if (!previous && next) return { x: point.x - next.nx * 6, y: point.y - next.ny * 6 };
    if (previous && !next) return { x: point.x - previous.nx * 6, y: point.y - previous.ny * 6 };
    const ix = -(previous!.nx + next!.nx);
    const iy = -(previous!.ny + next!.ny);
    const length = Math.hypot(ix, iy);
    if (length <= 1e-6) return { x: point.x - next!.nx * 6, y: point.y - next!.ny * 6 };
    const ux = ix / length;
    const uy = iy / length;
    const inwardX = -next!.nx;
    const inwardY = -next!.ny;
    const projection = Math.max(0.35, ux * inwardX + uy * inwardY);
    const miter = Math.min(18, 6 / projection);
    return { x: point.x + ux * miter, y: point.y + uy * miter };
  };

  const clearance = clearanceOf("waterfront-promenade");
  const vehicleLines = state.lines.filter((line) => ROUTE_CLASS_REGISTRY.get(line.classId)?.vehicle);
  const accepted: { a: Vec2; b: Vec2; role: string }[] = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex]!;
    const vertices: Vec2[] = [];
    if (run.closed) {
      for (let i = 0; i < run.edges.length; i++) {
        const edge = run.edges[i]!;
        const previous = run.edges[(i - 1 + run.edges.length) % run.edges.length]!;
        vertices.push(insetPoint(edge.a, previous, edge));
      }
    } else {
      vertices.push(insetPoint(run.edges[0]!.a, undefined, run.edges[0]!));
      for (let i = 1; i < run.edges.length; i++) vertices.push(insetPoint(run.edges[i]!.a, run.edges[i - 1]!, run.edges[i]!));
      vertices.push(insetPoint(run.edges[run.edges.length - 1]!.b, run.edges[run.edges.length - 1]!, undefined));
    }
    const pairCount = run.closed ? vertices.length : vertices.length - 1;
    for (let i = 0; i < pairCount; i++) {
      const a = vertices[i]!;
      const b = vertices[(i + 1) % vertices.length]!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!pointInRing(mid, state.mask) || !pointInRing(mid, state.land)) continue;
      if (!corridorFits(a, b, clearance, state.mask, state.land, state.sceneBounds)) continue;
      const role = `promenade/${runIndex}/${i}`;
      if (pushLine(state, [a, b], "waterfront-promenade", "tight", role)) accepted.push({ a, b, role });
    }
  }
  if (accepted.length === 0) return;

  const endpointCounts = new Map<string, { point: Vec2; count: number; role: string }>();
  const endpointKey = (point: Vec2): string => `${Math.round(point.x * 1e4)},${Math.round(point.y * 1e4)}`;
  for (const piece of accepted) {
    for (const point of [piece.a, piece.b]) {
      const key = endpointKey(point);
      const current = endpointCounts.get(key);
      if (current) current.count++;
      else endpointCounts.set(key, { point, count: 1, role: piece.role });
    }
  }
  let connectorIndex = 0;
  for (const endpoint of endpointCounts.values()) {
    if (endpoint.count !== 1) continue;
    let best: { point: Vec2; d: number } | null = null;
    for (const line of vehicleLines) {
      for (const [a, b] of linePairs(line)) {
        const projection = projectPoint(a, b, endpoint.point);
        if (!projection || projection.t <= 1e-3 || projection.t >= 1 - 1e-3 || projection.dist <= JUNCTION_TOLERANCE_M || projection.dist >= 80) continue;
        if (!best || projection.dist < best.d) best = { point: projection.point, d: projection.dist };
      }
    }
    if (!best) continue;
    if (!corridorFits(endpoint.point, best.point, clearance, state.mask, state.land, state.sceneBounds)) continue;
    pushLine(state, [endpoint.point, best.point], "waterfront-promenade", "tight", `promenade/connector/${connectorIndex++}`);
  }
}

function planGrid(state: PlanState, hubMode: HubMode): void {
  const targetSpacing = clamp(state.minDim / 7.5, 90, 130);
  const countX = Math.max(2, Math.round(state.box.width / targetSpacing));
  const countY = Math.max(2, Math.round(state.box.height / targetSpacing));
  const positions = (start: number, extent: number, count: number, centre: number): number[] => {
    const spacing = extent / count;
    const end = start + extent;
    const values = [centre];
    for (let k = 1; ; k++) {
      const lo = centre - k * spacing;
      const hi = centre + k * spacing;
      let added = false;
      if (lo >= start - EPS) {
        values.push(Math.max(start, lo));
        added = true;
      }
      if (hi <= end + EPS) {
        values.push(Math.min(end, hi));
        added = true;
      }
      if (!added) break;
    }
    return values
      .sort((a, b) => a - b)
      .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]!) > EPS);
  };
  const verticals: number[] = [];
  const horizontals: number[] = [];
  for (const [k, x] of positions(state.box.x, state.box.width, countX, state.centre.x).entries()) {
    const a = { x, y: state.box.y };
    const b = { x, y: state.box.y + state.box.height };
    if (pushLine(state, [a, b], Math.abs(x - state.centre.x) <= EPS ? "arterial" : "street", "tight", `grid/v/${k}`)) verticals.push(x);
  }
  for (const [k, y] of positions(state.box.y, state.box.height, countY, state.centre.y).entries()) {
    const a = { x: state.box.x, y };
    const b = { x: state.box.x + state.box.width, y };
    if (pushLine(state, [a, b], Math.abs(y - state.centre.y) <= EPS ? "arterial" : "street", "tight", `grid/h/${k}`)) horizontals.push(y);
  }
  planRoundabouts(state, hubMode, { verticals, horizontals });
  planLanes(state);
}

function edgeQuad(a: Vec2, b: Vec2, halfWidth: number): Ring {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= EPS || halfWidth <= 0) return [];
  const nx = (-(b.y - a.y) / length) * halfWidth;
  const ny = ((b.x - a.x) / length) * halfWidth;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny }
  ];
}

function nodeDisc(center: Vec2, radius: number, count = 24): Ring {
  if (radius <= 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

function clippedShape(shape: Ring, sceneBounds?: Rect): ReturnType<typeof ringAsMulti> {
  if (!sceneBounds) return ringAsMulti(shape);
  return intersection(ringAsMulti(shape), ringAsMulti(rectRing(sceneBounds)));
}

function polygonArea(multi: ReturnType<typeof ringAsMulti>): number {
  return multi.reduce(
    (total, polygon) => total + polygon.reduce((area, ring, index) => area + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0),
    0
  );
}

function shapeInsideMasks(shape: Ring, mask: Ring, land: Ring, sceneBounds?: Rect): boolean {
  if (shape.length < 3) return true;
  const clipped = clippedShape(shape, sceneBounds);
  if (clipped.length === 0) return true;
  const maskMulti = ringAsMulti(mask);
  const landMulti = ringAsMulti(land);
  return polygonArea(difference(clipped, [maskMulti])) <= 1e-6 && polygonArea(difference(clipped, [landMulti])) <= 1e-6;
}

function corridorsInsideMasks(source: RoadSource, mask: Ring, land: Ring, sceneBounds: Rect): boolean {
  const network = compileRouteNetwork(source);
  for (const span of network.segments) {
    const corridor = edgeQuad(span.a, span.b, span.clearanceM);
    if (corridor.length >= 3 && !shapeInsideMasks(corridor, mask, land, sceneBounds)) {
      if (process.env.NIXIE_DEBUG_ROADS) {
        const { writeFileSync } = require("node:fs");
        writeFileSync(process.env.NIXIE_DEBUG_ROADS, JSON.stringify({ span, mask, land, sceneBounds }));
      }
      return false;
    }
    for (const point of [span.a, span.b]) {
      const disc = nodeDisc(point, span.clearanceM);
      if (disc.length < 3) continue;
      if (!shapeInsideMasks(disc, mask, land, sceneBounds)) return false;
    }
  }
  return true;
}

function majorVehicleComponents(source: RoadSource): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of source.edges) {
    if (!ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) continue;
    for (const node of [edge.a, edge.b]) {
      if (!adjacency.has(node)) adjacency.set(node, []);
      adjacency.get(node)!.push(edge.a === node ? edge.b : edge.a);
    }
  }
  const components = new Map<string, number>();
  let next = 0;
  for (const start of adjacency.keys()) {
    if (components.has(start)) continue;
    const queue = [start];
    components.set(start, next);
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi]!;
      for (const neighbour of adjacency.get(node) ?? []) {
        if (components.has(neighbour)) continue;
        components.set(neighbour, next);
        queue.push(neighbour);
      }
    }
    next++;
  }
  return components;
}

function nearestVehicleNodeId(source: RoadSource, point: Vec2): string | undefined {
  const vehicleNodeIds = new Set(source.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle).flatMap((edge) => [edge.a, edge.b]));
  let best: string | undefined;
  let bestD = Infinity;
  for (const node of source.nodes) {
    if (!vehicleNodeIds.has(node.id)) continue;
    const d = Math.hypot(node.x - point.x, node.y - point.y);
    if (d < bestD) {
      bestD = d;
      best = node.id;
    }
  }
  return best;
}

function nearestNodeId(source: RoadSource, point: Vec2, maxD: number): string | undefined {
  let best: string | undefined;
  let bestD = maxD;
  for (const node of source.nodes) {
    const d = Math.hypot(node.x - point.x, node.y - point.y);
    if (d <= bestD) {
      bestD = d;
      best = node.id;
    }
  }
  return best;
}

/** Construction rule, not repair: everything vehicle must reach the city centre. Clipping can
 *  strand a lane whose bounding streets were eaten by the coast; drop only those pieces. */
function pruneDisconnectedVehicleComponents(source: RoadSource, rootPoint: Vec2): RoadSource {
  const rootId = nearestVehicleNodeId(source, rootPoint);
  if (!rootId) return source;
  const components = majorVehicleComponents(source);
  const root = components.get(rootId);
  if (root === undefined) return source;
  const keep = new Set<string>();
  for (const [nodeId, component] of components) {
    if (component === root) keep.add(nodeId);
  }
  const edges = source.edges.filter((edge) => {
    const cls = ROUTE_CLASS_REGISTRY.get(edge.classId);
    if (!cls?.vehicle) return true;
    return keep.has(edge.a) && keep.has(edge.b);
  });
  const usedNodes = new Set(edges.flatMap((edge) => [edge.a, edge.b]));
  return {
    nodes: source.nodes.filter((node) => usedNodes.has(node.id)),
    routes: source.routes.filter((route) => edges.some((edge) => edge.routeId === route.id)),
    edges
  };
}

function nodeKeyOf(point: Vec2): string {
  return `${Math.round(point.x / 1e-4) / 1e4},${Math.round(point.y / 1e-4) / 1e4}`;
}

export function generateInitialRoadNetwork(input: RoadGenerationInput): GeneratedRoadNetwork {
  if (!input.mask.length) throw new Error("Road generation requires a non-empty mask.");
  const layout = input.layout ?? "european";
  const hubMode = input.hubMode ?? "single-centre";
  const land = input.land ?? input.mask;
  const sceneBounds = input.sceneBounds ?? bounds(input.mask);
  const box = bounds(input.mask);
  const minDim = Math.min(box.width, box.height);
  if (minDim < 45) {
    return {
      roads: { nodes: [], routes: [], edges: [] },
      diagnostics: { layout, hubMode, hubs: [], attempts: 0, discarded: 0, warnings: ["mask too small for road generation"] }
    };
  }
  const state: PlanState = {
    mask: input.mask,
    land,
    sceneBounds,
    box,
    centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    minDim,
    seed: deriveLabelledSeed(input.citySeed, "roads/v2"),
    lines: [],
    barriers: [],
    hubPoints: [],
    warnings: [],
    rejected: 0
  };
  if (layout === "grid") {
    planGrid(state, hubMode);
  } else {
    state.hubPoints.push(state.centre);
    planArterials(state);
    planAvenues(state);
    planRings(state);
    if (layout === "european") planOldTown(state);
    planRoundabouts(state, hubMode);
    planSecondaryHubs(state, hubMode, layout);
    planStreets(state, layout);
    planLanes(state);
    planHighways(state);
  }
  planPromenade(state);

  // ---- clip every planned segment to the land ----
  const pieces: { a: Vec2; b: Vec2; lineIndex: number }[] = [];
  let attempts = 0;
  let discarded = state.rejected;
  for (let li = 0; li < state.lines.length; li++) {
    const line = state.lines[li]!;
    for (const [a, b] of linePairs(line)) {
      attempts++;
      const clipped: Vec2[] = [];
      clipSegment(a, b, clearanceOf(line.classId), input.mask, land, sceneBounds, minLengthOfPlannedLine(line), clipped);
      if (clipped.length === 0) {
        discarded++;
        continue;
      }
      for (let k = 0; k + 1 < clipped.length; k += 2) {
        const piece = { a: clipped[k]!, b: clipped[k + 1]!, lineIndex: li };
        // Merge contiguous collinear pieces of the same line: the corridor-fit recursion
        // splits at fit boundaries, and a degree-2 same-route node there would be smoothed
        // by the curve compiler, scrambling compiled node ids around it.
        const last = pieces[pieces.length - 1];
        if (last && last.lineIndex === li && dist(last.b, piece.a) <= EPS) {
          const ux = last.b.x - last.a.x;
          const uy = last.b.y - last.a.y;
          const vx = piece.b.x - piece.a.x;
          const vy = piece.b.y - piece.a.y;
          if (Math.abs(ux * vy - uy * vx) <= EPS * Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9) {
            last.b = piece.b;
            continue;
          }
        }
        pieces.push(piece);
      }
    }
  }

  // ---- junction pass: crossings, endpoint T-splits (2 m), endpoint merges (2 m) ----
  const splits: { t: number; point: Vec2 }[][] = pieces.map((piece) => [
    { t: 0, point: piece.a },
    { t: 1, point: piece.b }
  ]);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const x = segmentIntersectionParam(pieces[i]!.a, pieces[i]!.b, pieces[j]!.a, pieces[j]!.b);
      if (!x || x.t < 1e-4 || x.t > 1 - 1e-4 || x.u < 1e-4 || x.u > 1 - 1e-4) continue;
      const point = lerpPoint(pieces[i]!.a, pieces[i]!.b, x.t);
      splits[i]!.push({ t: x.t, point });
      splits[j]!.push({ t: x.u, point });
    }
  }
  const endpoints = pieces.flatMap((piece, i) => [
    { piece: i, end: 0, point: piece.a },
    { piece: i, end: 1, point: piece.b }
  ]);
  const finalPos: Vec2[] = [];
  for (const endpoint of endpoints) {
    let snapped: Vec2 | null = null;
    for (let j = 0; j < pieces.length; j++) {
      if (j === endpoint.piece) continue;
      const proj = projectPoint(pieces[j]!.a, pieces[j]!.b, endpoint.point);
      if (proj && proj.t > 1e-3 && proj.t < 1 - 1e-3 && proj.dist <= JUNCTION_TOLERANCE_M) {
        // A junction already exists within 2 m (e.g. a crossing): snap onto it instead of
        // manufacturing a twin junction that would yield overlapping micro-edges.
        let existing: Vec2 | undefined;
        for (const s of splits[j]!) {
          if (s.t <= 1e-4 || s.t >= 1 - 1e-4) continue;
          if (dist(s.point, proj.point) <= 2) { existing = s.point; break; }
        }
        const snapTarget = existing ?? proj.point;
        // Reject the snap when the endpoint's adjacent edge would end up lying along the
        // snapped-to piece (that is exactly the overlap the topology validator flags).
        const own = splits[endpoint.piece]!;
        let adjacent: Vec2 | undefined;
        if (endpoint.end === 1) {
          let bestT = -1;
          for (const s of own) if (s.t < 1 && s.t > bestT) { bestT = s.t; adjacent = s.point; }
        } else {
          let bestT = 2;
          for (const s of own) if (s.t > 0 && s.t < bestT) { bestT = s.t; adjacent = s.point; }
        }
        // Coalescing onto an existing junction skips the overlap rejection: any coincident
        // micro-edge it creates is removed by the identical-edge dedupe later.
        const conflict = existing ? false : parallelConflict(adjacent ?? snapTarget, snapTarget, clearanceOf(state.lines[pieces[endpoint.piece]!.lineIndex]!.classId), [{ a: pieces[j]!.a, b: pieces[j]!.b, clearance: clearanceOf(state.lines[pieces[j]!.lineIndex]!.classId) }]);
        if (!adjacent || !conflict) {
          snapped = snapTarget;
          if (!existing) splits[j]!.push({ t: proj.t, point: proj.point });
        }
        break;
      }
    }
    let merged: Vec2 | null = null;
    if (!snapped) {
      const own = splits[endpoint.piece]!;
      let adjacent: Vec2 | undefined;
      if (endpoint.end === 1) {
        let bestT = -1;
        for (const s of own) if (s.t < 1 && s.t > bestT) { bestT = s.t; adjacent = s.point; }
      } else {
        let bestT = 2;
        for (const s of own) if (s.t > 0 && s.t < bestT) { bestT = s.t; adjacent = s.point; }
      }
      const ownClearance = clearanceOf(state.lines[pieces[endpoint.piece]!.lineIndex]!.classId);
      const allBarriers = pieces.map((p) => ({ a: p.a, b: p.b, clearance: clearanceOf(state.lines[p.lineIndex]!.classId) }));
      for (const q of finalPos) {
        if (dist(endpoint.point, q) > JUNCTION_TOLERANCE_M) continue;
        if (adjacent && parallelConflict(adjacent, q, ownClearance, allBarriers)) continue;
        merged = q;
        break;
      }
    }
    finalPos.push(snapped ?? merged ?? { x: endpoint.point.x, y: endpoint.point.y });
  }
  for (let k = 0; k < endpoints.length; k++) {
    const { piece, end } = endpoints[k]!;
    splits[piece]![end] = { t: end, point: finalPos[k]! };
  }
  // Snap-moved endpoints change the piece geometry; re-run the crossing pass on the final
  // geometry so the adjusted edges get junctions where they now cross other pieces.
  const finalPieces = pieces.map((piece, i) => ({
    a: endpoints[2 * i]!.end === 0 ? finalPos[2 * i]! : piece.a,
    b: endpoints[2 * i + 1]!.end === 1 ? finalPos[2 * i + 1]! : piece.b,
    lineIndex: piece.lineIndex
  }));
  for (let i = 0; i < finalPieces.length; i++) {
    for (let j = i + 1; j < finalPieces.length; j++) {
      const x = segmentIntersectionParam(finalPieces[i]!.a, finalPieces[i]!.b, finalPieces[j]!.a, finalPieces[j]!.b);
      if (!x || x.t < 1e-4 || x.t > 1 - 1e-4 || x.u < 1e-4 || x.u > 1 - 1e-4) continue;
      const point = lerpPoint(finalPieces[i]!.a, finalPieces[i]!.b, x.t);
      // Snap-moved pieces intersect the same roads a few centimetres from the original
      // junction; a second junction that close just manufactures degenerate micro-edges.
      const nearExisting = (list: { t: number; point: Vec2 }[]): boolean => list.some((s) => s.t > 1e-4 && s.t < 1 - 1e-4 && dist(s.point, point) <= 1);
      if (nearExisting(splits[i]!) || nearExisting(splits[j]!)) continue;
      splits[i]!.push({ t: x.t, point });
      splits[j]!.push({ t: x.u, point });
    }
  }

  // ---- assemble ----
  const idSeed = `${input.citySeed}\0roads/v2`;
  const usedIds = new Set<string>();
  const routeIds = state.lines.map((line, i) => {
    const id = allocateGeneratedId("route", idSeed, `route/${line.role}`, i, usedIds);
    usedIds.add(id);
    return id;
  });
  const nodeIds = new Map<string, string>();
  const nodePos = new Map<string, Vec2>();
  const allocateNode = (point: Vec2): string => {
    const key = nodeKeyOf(point);
    const existing = nodeIds.get(key);
    if (existing) return existing;
    for (const [otherKey, id] of nodeIds) {
      const other = nodePos.get(otherKey)!;
      if (Math.hypot(other.x - point.x, other.y - point.y) <= 1) return id;
    }
    const id = allocateGeneratedId("node", idSeed, "v2/junction", nodeIds.size, usedIds);
    usedIds.add(id);
    nodeIds.set(key, id);
    nodePos.set(key, point);
    return id;
  };
  const edgeIds = new Set<string>();
  const edges: RoadSource["edges"] = [];
  for (let i = 0; i < pieces.length; i++) {
    const lineIndex = pieces[i]!.lineIndex;
    const ordered = splits[i]!.slice().sort((p, q) => p.t - q.t);
    const uniq: { t: number; point: Vec2 }[] = [];
    for (const s of ordered) {
      if (uniq.length === 0 || dist(s.point, uniq[uniq.length - 1]!.point) > 1) uniq.push(s);
    }
    for (let k = 0; k + 1 < uniq.length; k++) {
      const a = allocateNode(uniq[k]!.point);
      const b = allocateNode(uniq[k + 1]!.point);
      if (a === b) continue;
      const id = allocateGeneratedId("edge", idSeed, `edge/${i}/${k}`, edges.length, edgeIds);
      edgeIds.add(id);
      edges.push({ id, a, b, routeId: routeIds[lineIndex]!, classId: state.lines[lineIndex]!.classId, name: null, locked: false, origin: "generated" });
    }
  }
  // Identical node-pair edges (in either direction) are a degenerate twin of the same
  // junction and would read as corridor overlaps; keep only the first.
  const seenEdges = new Set<string>();
  const dedupedEdges = edges.filter((edge) => {
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });
  const usedNodeIds = new Set(dedupedEdges.flatMap((edge) => [edge.a, edge.b]));
  const usedRouteIds = new Set(dedupedEdges.map((edge) => edge.routeId));
  const roads: RoadSource = {
    nodes: [...nodeIds.keys()]
      .map((key) => ({ id: nodeIds.get(key)!, ...nodePos.get(key)! }))
      .filter((node) => usedNodeIds.has(node.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
    routes: state.lines
      .map((line, i) => ({ id: routeIds[i]!, curvePreset: line.preset }))
      .filter((route) => usedRouteIds.has(route.id))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: dedupedEdges
  };
  const pruned = pruneDisconnectedVehicleComponents(roads, state.centre);
  const sourceProblems = validateRoadSource(pruned);
  if (sourceProblems.length > 0) throw new Error(`Generated road source is invalid: ${sourceProblems.join(" ")}`);
  const topology = validateRouteTopology(pruned, compileRouteNetwork(pruned));
  if (!topology.ok) throw new Error(`Generated road topology is invalid: ${topology.problems.join(" ")}`);
  if (!corridorsInsideMasks(pruned, input.mask, land, sceneBounds)) throw new Error("Generated road corridors leave the active generation mask or land.");
  const hubs = state.hubPoints
    .map((point) => nearestNodeId(pruned, point, 100))
    .filter((id): id is string => id !== undefined)
    .filter((id, index, all) => all.indexOf(id) === index);
  return {
    roads: pruned,
    diagnostics: {
      layout,
      hubMode,
      hubs,
      attempts,
      discarded: discarded + (roads.edges.length - pruned.edges.length),
      warnings: state.warnings
    }
  };
}

export const generateRoadNetwork = generateInitialRoadNetwork;
