import { hash2 } from "./hash.js";
import { allocateGeneratedId, ROUTE_CLASS_REGISTRY, validateRoadSource, type HubMode, type RoadLayout, type RoadSource, type RouteClassId } from "./city.js";
import { deriveLabelledSeed } from "./terrain.js";
import { difference, intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, type Rect, type Ring, type Vec2 } from "../geom/types.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { validateRouteTopology } from "../graph/topology.js";
import { compiledRouteOccupancy } from "./district-plan.js";

export interface RoadGenerationInput {
  citySeed: string;
  mask: Ring;
  land?: Ring;
  layout?: RoadLayout;
  hubMode?: HubMode;
  sceneBounds?: Rect;
  /**
   * Metre-space polygons reserved for major landmark sites. Ordinary road corridors are
   * excluded from these polygons during segment fitting; an unavoidable overlap fails
   * generation rather than shipping roads through a reserved site.
   */
  reservedSites?: readonly Ring[];
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

function pointInAnyReserved(point: Vec2, reservedSites: readonly Ring[]): boolean {
  for (const site of reservedSites) {
    if (pointInRing(point, site)) return true;
  }
  return false;
}

/** Sample the corridor (centreline + both offsets every 2 m, plus endpoint discs) against mask, land, and reserved sites.
 *  Samples outside the scene rect are ignored (roads may run to the map edge). */
function corridorFits(a: Vec2, b: Vec2, clearanceM: number, mask: Ring, land: Ring, sceneBounds?: Rect, reservedSites?: readonly Ring[]): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= EPS) return false;
  const clearance = clearanceM + CLIP_MARGIN_M;
  const count = Math.max(1, Math.ceil(length / 2));
  const nx = (-(b.y - a.y) / length) * clearance;
  const ny = ((b.x - a.x) / length) * clearance;
  const check = (point: Vec2): boolean => {
    if (reservedSites !== undefined && pointInAnyReserved(point, reservedSites)) return false;
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
function clipSegment(a: Vec2, b: Vec2, clearanceM: number, mask: Ring, land: Ring, sceneBounds: Rect, minLen: number, out: Vec2[], reservedSites?: readonly Ring[]): void {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < minLen) return;
  const ts = [0, 1];
  for (const ring of [mask, land, ...(reservedSites ?? [])]) {
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
    if (reservedSites !== undefined && pointInAnyReserved(mid, reservedSites)) continue;
    fitInterval(a, b, t0, t1, clearanceM, mask, land, sceneBounds, minLen, out, reservedSites);
  }
}

function fitInterval(a: Vec2, b: Vec2, t0: number, t1: number, clearanceM: number, mask: Ring, land: Ring, sceneBounds: Rect, minLen: number, out: Vec2[], reservedSites?: readonly Ring[]): void {
  const p0 = lerpPoint(a, b, t0);
  const p1 = lerpPoint(a, b, t1);
  if (corridorFits(p0, p1, clearanceM, mask, land, sceneBounds, reservedSites)) {
    out.push(p0, p1);
    return;
  }
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if ((t1 - t0) * length < minLen) return;
  const tm = (t0 + t1) / 2;
  fitInterval(a, b, t0, tm, clearanceM, mask, land, sceneBounds, minLen, out, reservedSites);
  fitInterval(a, b, tm, t1, clearanceM, mask, land, sceneBounds, minLen, out, reservedSites);
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

interface MeshGuides {
  verticals: number[];
  horizontals: number[];
}

interface StreetCellPlan {
  rect: Rect;
  angle: number;
  index: number;
  centre: boolean;
}

interface AttachmentReservation {
  point: Vec2;
  lineIndex: number;
}

interface HubExclusion {
  point: Vec2;
  radius: number;
}

interface NetworkAttachment {
  point: Vec2;
  lineIndex: number;
  distance: number;
}

interface AttachmentOptions {
  majorOnly: boolean;
  maxDistance: number;
  minApproachAngleDeg: number;
  minAttachmentSpacing: number;
  minJunctionSpacing: number;
  minHubSpacing: number;
  minEndpointRun: number;
  minConnectorLength: number;
  excludedLineIndexes?: ReadonlySet<number>;
  extraReserved?: readonly Vec2[];
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
  streetCells: StreetCellPlan[];
  attachments: AttachmentReservation[];
  hubExclusions: HubExclusion[];
  reservedSites: readonly Ring[];
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


function pushComposite(state: PlanState, lines: readonly PlannedLine[]): boolean {
  const barriers = state.barriers.slice();
  for (const line of lines) {
    const clearance = clearanceOf(line.classId);
    for (const [a, b] of linePairs(line)) {
      if (parallelConflict(a, b, clearance, barriers)) {
        state.rejected++;
        return false;
      }
      barriers.push({ a, b, clearance });
    }
  }
  state.lines.push(...lines);
  state.barriers = barriers;
  return true;
}

function rectCentre(rect: Rect): Vec2 {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function expandedRect(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

function signedHash(a: number, b: number, seed: number): number {
  return hash2(a, b, seed) * 2 - 1;
}

/** Intersect one infinite line with a rectangle. Offset is measured on the line normal from the
 * rectangle centre, which makes it convenient to create locally rotated street families. */
function lineAcrossRect(rect: Rect, angle: number, offset = 0, margin = 0): [Vec2, Vec2] | null {
  const box = expandedRect(rect, margin);
  const centre = rectCentre(rect);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  const origin = { x: centre.x + nx * offset, y: centre.y + ny * offset };
  let lo = -Infinity;
  let hi = Infinity;
  const clipAxis = (value: number, direction: number, min: number, max: number): boolean => {
    if (Math.abs(direction) <= 1e-12) return value >= min - EPS && value <= max + EPS;
    const t0 = (min - value) / direction;
    const t1 = (max - value) / direction;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    return lo <= hi;
  };
  if (!clipAxis(origin.x, dx, box.x, box.x + box.width) || !clipAxis(origin.y, dy, box.y, box.y + box.height)) return null;
  return [
    { x: origin.x + dx * lo, y: origin.y + dy * lo },
    { x: origin.x + dx * hi, y: origin.y + dy * hi }
  ];
}

function gentlyBentLine(a: Vec2, b: Vec2, bend: number, phase: number): Vec2[] {
  const length = dist(a, b);
  if (length < 40 || Math.abs(bend) < 0.5) return [a, b];
  const nx = (-(b.y - a.y) / length);
  const ny = ((b.x - a.x) / length);
  const first = lerpPoint(a, b, 0.34);
  const second = lerpPoint(a, b, 0.68);
  const b0 = bend;
  const b1 = bend * (-0.25 + phase * 0.75);
  return [
    a,
    { x: first.x + nx * b0, y: first.y + ny * b0 },
    { x: second.x + nx * b1, y: second.y + ny * b1 },
    b
  ];
}

function irregularLoop(centre: Vec2, rx: number, ry: number, count: number, seed: number, salt: number, rotation = 0): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const angleJitter = signedHash(salt + i, 101, seed) * (Math.PI * 2 / count) * 0.16;
    const angle = rotation + (i / count) * Math.PI * 2 + angleJitter;
    const radial = 0.88 + hash2(salt + i, 103, seed) * 0.24;
    points.push({
      x: centre.x + Math.cos(angle) * rx * radial,
      y: centre.y + Math.sin(angle) * ry * radial
    });
  }
  return points;
}

function guidePositions(start: number, extent: number, targetSpacing: number, seed: number, salt: number): number[] {
  const count = Math.max(1, Math.min(5, Math.round(extent / targetSpacing)));
  const spacing = extent / (count + 1);
  const margin = Math.min(70, spacing * 0.35);
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    const base = start + spacing * (i + 1);
    const jitter = signedHash(salt + i, 107, seed) * Math.min(spacing * 0.18, 48);
    positions.push(clamp(base + jitter, start + margin, start + extent - margin));
  }
  positions.sort((a, b) => a - b);
  return positions;
}

function lineOffsetForPoint(rect: Rect, angle: number, point: Vec2): number {
  const centre = rectCentre(rect);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return (point.x - centre.x) * nx + (point.y - centre.y) * ny;
}

function plannedVehicleIntersections(state: PlanState, majorOnly = false): Vec2[] {
  const lines = state.lines.filter((line) => {
    if (!ROUTE_CLASS_REGISTRY.get(line.classId)?.vehicle) return false;
    if (!majorOnly) return true;
    return line.role.startsWith("arterial/") || line.role.startsWith("avenue/") || line.role.startsWith("ring/");
  });
  const result: Vec2[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      for (const [a, b] of linePairs(lines[i]!)) {
        for (const [c, d] of linePairs(lines[j]!)) {
          const hit = segmentIntersectionParam(a, b, c, d);
          if (!hit || hit.t <= 1e-4 || hit.t >= 1 - 1e-4 || hit.u <= 1e-4 || hit.u >= 1 - 1e-4) continue;
          const point = lerpPoint(a, b, hit.t);
          if (!result.some((other) => dist(other, point) <= 2)) result.push(point);
        }
      }
    }
  }
  return result;
}

function isMajorPlanningLine(line: PlannedLine): boolean {
  return line.role.startsWith("arterial/") || line.role.startsWith("avenue/") || line.role.startsWith("ring/");
}

function reserveAttachment(state: PlanState, attachment: NetworkAttachment | null): void {
  if (!attachment) return;
  state.attachments.push({ point: attachment.point, lineIndex: attachment.lineIndex });
}

/** Choose a calm attachment point rather than blindly snapping to the nearest segment.
 * Generated local roads avoid existing major junctions, hub centres, nearby attachments,
 * road endpoints, and shallow-angle approaches. This keeps irregular neighbourhoods while
 * preventing several individually valid roads from collapsing into one unreadable knot. */
function findNetworkAttachment(state: PlanState, point: Vec2, approachFrom: Vec2, options: AttachmentOptions): NetworkAttachment | null {
  const hotspots = plannedVehicleIntersections(state, options.majorOnly);
  const reserved = [...state.attachments.map((entry) => entry.point), ...(options.extraReserved ?? [])];
  const minApproachSin = Math.sin(options.minApproachAngleDeg * DEG);
  let best: NetworkAttachment | null = null;
  let bestScore = Infinity;

  for (let lineIndex = 0; lineIndex < state.lines.length; lineIndex++) {
    if (options.excludedLineIndexes?.has(lineIndex)) continue;
    const line = state.lines[lineIndex]!;
    if (!ROUTE_CLASS_REGISTRY.get(line.classId)?.vehicle) continue;
    if (options.majorOnly && !isMajorPlanningLine(line)) continue;

    for (const [a, b] of linePairs(line)) {
      const projection = projectPoint(a, b, point);
      if (!projection || projection.t <= 1e-6 || projection.t >= 1 - 1e-6 || projection.dist > options.maxDistance || projection.dist < options.minConnectorLength) continue;

      const segmentLength = dist(a, b);
      if (segmentLength <= EPS) continue;
      const endpointRun = Math.min(projection.t, 1 - projection.t) * segmentLength;
      if (endpointRun < options.minEndpointRun) continue;

      const approachLength = dist(approachFrom, projection.point);
      if (approachLength <= EPS) continue;
      const approachX = projection.point.x - approachFrom.x;
      const approachY = projection.point.y - approachFrom.y;
      const roadX = b.x - a.x;
      const roadY = b.y - a.y;
      const crossingSin = Math.abs(approachX * roadY - approachY * roadX) / (approachLength * segmentLength);
      if (crossingSin < minApproachSin) continue;

      if (hotspots.some((hotspot) => dist(hotspot, projection.point) < options.minJunctionSpacing)) continue;
      if (state.hubPoints.some((hub) => dist(hub, projection.point) < options.minHubSpacing)) continue;
      if (reserved.some((other) => dist(other, projection.point) < options.minAttachmentSpacing)) continue;

      const score = projection.dist + Math.abs(projection.t - 0.5) * 5;
      if (score < bestScore) {
        bestScore = score;
        best = { point: projection.point, lineIndex, distance: projection.dist };
      }
    }
  }
  return best;
}

function plannedLineHitsVehicleNetwork(state: PlanState, a: Vec2, b: Vec2, majorOnly: boolean): boolean {
  for (const line of state.lines) {
    if (!ROUTE_CLASS_REGISTRY.get(line.classId)?.vehicle) continue;
    if (majorOnly && !isMajorPlanningLine(line)) continue;
    for (const [c, d] of linePairs(line)) {
      const hit = segmentIntersectionParam(a, b, c, d);
      if (hit && hit.t > 1e-3 && hit.t < 1 - 1e-3 && hit.u > 1e-3 && hit.u < 1 - 1e-3) return true;
    }
  }
  return false;
}

function distancePointToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const projection = projectPoint(a, b, point);
  if (!projection) return dist(point, a);
  return dist(point, lerpPoint(a, b, clamp(projection.t, 0, 1)));
}

function lineClearsHubExclusions(state: PlanState, points: readonly Vec2[], extraMargin = 0): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    for (const exclusion of state.hubExclusions) {
      if (distancePointToSegment(exclusion.point, points[i]!, points[i + 1]!) < exclusion.radius + extraMargin) return false;
    }
  }
  return true;
}

/** Old towns should sit near the city centre without being impaled by every major road.
 * Search a small deterministic neighbourhood and choose the point with the largest clearance
 * from the already planned arterial skeleton and its intersections. */
function calmOldTownCentre(state: PlanState): Vec2 {
  const candidates: Vec2[] = [state.centre];
  const maxRadius = Math.min(105, state.minDim * 0.12);
  for (let ring = 1; ring <= 3; ring++) {
    const radius = (ring / 3) * maxRadius;
    const count = 8 + ring * 2;
    const rotation = hash2(41 + ring, 1, state.seed) * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = rotation + (i / count) * Math.PI * 2;
      candidates.push({ x: state.centre.x + Math.cos(angle) * radius, y: state.centre.y + Math.sin(angle) * radius });
    }
  }
  const intersections = plannedVehicleIntersections(state, true);
  let best = state.centre;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    if (!pointInRect(candidate, state.box) || !pointInRing(candidate, state.mask) || !pointInRing(candidate, state.land)) continue;
    let majorClearance = Infinity;
    for (const line of state.lines) {
      if (!isMajorPlanningLine(line)) continue;
      for (const [a, b] of linePairs(line)) majorClearance = Math.min(majorClearance, distancePointToSegment(candidate, a, b) - clearanceOf(line.classId));
    }
    const junctionClearance = intersections.reduce((value, point) => Math.min(value, dist(candidate, point)), Infinity);
    const displacementPenalty = dist(candidate, state.centre) * 0.08;
    const score = Math.min(majorClearance, junctionClearance * 0.75) - displacementPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
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

function planArterials(state: PlanState): MeshGuides {
  const targetSpacing = clamp(state.minDim / 2.7, 270, 380);
  const proposedVerticals = guidePositions(state.box.x, state.box.width, targetSpacing, state.seed, 200);
  const proposedHorizontals = guidePositions(state.box.y, state.box.height, targetSpacing, state.seed, 300);
  const verticals: number[] = [];
  const horizontals: number[] = [];
  const boxCentre = rectCentre(state.box);

  for (let i = 0; i < proposedVerticals.length; i++) {
    const guide = proposedVerticals[i]!;
    const angle = Math.PI / 2 + signedHash(i, 211, state.seed) * 8 * DEG;
    const offset = lineOffsetForPoint(state.box, angle, { x: guide, y: boxCentre.y });
    const ends = lineAcrossRect(state.box, angle, offset, 28);
    if (!ends) continue;
    const bend = signedHash(i, 213, state.seed) * Math.min(42, state.minDim * 0.045);
    if (pushLine(state, gentlyBentLine(ends[0], ends[1], bend, hash2(i, 215, state.seed)), "arterial", "broad", `arterial/x/${i}`)) verticals.push(guide);
  }
  for (let i = 0; i < proposedHorizontals.length; i++) {
    const guide = proposedHorizontals[i]!;
    const angle = signedHash(i, 217, state.seed) * 8 * DEG;
    const offset = lineOffsetForPoint(state.box, angle, { x: boxCentre.x, y: guide });
    const ends = lineAcrossRect(state.box, angle, offset, 28);
    if (!ends) continue;
    const bend = signedHash(i, 219, state.seed) * Math.min(42, state.minDim * 0.045);
    if (pushLine(state, gentlyBentLine(ends[0], ends[1], bend, hash2(i, 221, state.seed)), "arterial", "broad", `arterial/y/${i}`)) horizontals.push(guide);
  }
  return { verticals, horizontals };
}

/** A European avenue is a historic connector, not one half of a symmetric X. One long diagonal
 * crosses the city; a second, shorter connector curves between adjacent sides on larger maps. */
function planAvenues(state: PlanState): void {
  const firstAngle = (20 + hash2(1, 1, state.seed) * 18) * DEG * (hash2(1, 2, state.seed) < 0.5 ? 1 : -1);
  const firstPass = {
    x: state.centre.x + signedHash(1, 3, state.seed) * Math.min(90, state.minDim * 0.1),
    y: state.centre.y + signedHash(1, 4, state.seed) * Math.min(70, state.minDim * 0.08)
  };
  const first = lineAcrossRect(state.box, firstAngle, lineOffsetForPoint(state.box, firstAngle, firstPass), 45);
  if (first) {
    pushLine(
      state,
      gentlyBentLine(first[0], first[1], signedHash(1, 5, state.seed) * Math.min(55, state.minDim * 0.055), hash2(1, 6, state.seed)),
      "arterial",
      "broad",
      "avenue/0"
    );
  }

  if (state.minDim < 620) return;
  const secondAngle = firstAngle + (hash2(2, 1, state.seed) < 0.5 ? 68 : 108) * DEG;
  const secondPass = {
    x: state.centre.x + signedHash(2, 2, state.seed) * Math.min(180, state.box.width * 0.18),
    y: state.centre.y + signedHash(2, 3, state.seed) * Math.min(150, state.box.height * 0.18)
  };
  const full = lineAcrossRect(state.box, secondAngle, lineOffsetForPoint(state.box, secondAngle, secondPass), 25);
  if (!full) return;
  const reverse = hash2(2, 4, state.seed) < 0.5;
  const a = reverse ? full[1] : full[0];
  const far = reverse ? full[0] : full[1];
  const b = lerpPoint(a, far, 0.72 + hash2(2, 5, state.seed) * 0.12);
  pushLine(
    state,
    gentlyBentLine(a, b, signedHash(2, 6, state.seed) * Math.min(65, state.minDim * 0.065), hash2(2, 7, state.seed)),
    "arterial",
    "standard",
    "avenue/1"
  );
}

/** An irregular orbital route gives the city a broad outer structure without drawing a rectangle
 * around the map. Degree-two anchors are intentionally left on one route so the shared curve
 * compiler rounds the faceted loop into a gentle, deterministic ring. */
function planRings(state: PlanState): void {
  const rx = Math.min(state.box.width * 0.39, state.box.width / 2 - 34);
  const ry = Math.min(state.box.height * 0.39, state.box.height / 2 - 34);
  if (rx < 85 || ry < 85) return;
  const count = state.minDim >= 900 ? 12 : 10;
  const rotation = hash2(3, 1, state.seed) * Math.PI * 2;
  const classId: RouteClassId = state.minDim >= 650 ? "arterial" : "street";
  const ring = irregularLoop(state.centre, rx, ry, count, state.seed, 400, rotation);
  if (!pushLine(state, ring, classId, "broad", "ring/orbital", { closed: true })) return;

  const cycleRx = rx + 18;
  const cycleRy = ry + 18;
  if (state.centre.x - cycleRx < state.box.x + 5 || state.centre.x + cycleRx > state.box.x + state.box.width - 5 || state.centre.y - cycleRy < state.box.y + 5 || state.centre.y + cycleRy > state.box.y + state.box.height - 5) return;
  const cycle = irregularLoop(state.centre, cycleRx, cycleRy, count, state.seed, 400, rotation);
  pushLine(state, cycle, "cycleway", "standard", "cycle/orbital", { closed: true });
}

/** Old-town centre: one irregular narrow-street loop, one crooked market spine, and a handful of
 * short radial streets. It reads as accumulated urban fabric rather than a symbolic square/X. */
function planOldTown(state: PlanState): void {
  if (state.minDim < 320) return;
  const townCentre = calmOldTownCentre(state);
  const rx = clamp(state.minDim * 0.078, 36, 84);
  const ry = rx * (0.74 + hash2(4, 1, state.seed) * 0.28);
  const count = 7 + Math.floor(hash2(4, 2, state.seed) * 3);
  const rotation = hash2(4, 3, state.seed) * Math.PI * 2;
  const loop = irregularLoop(townCentre, rx, ry, count, state.seed, 500, rotation);
  if (!pushLine(state, loop, "narrow", "standard", "oldtown/loop", { closed: true })) return;

  const spineAngle = rotation + (20 + hash2(4, 4, state.seed) * 45) * DEG;
  const dx = Math.cos(spineAngle);
  const dy = Math.sin(spineAngle);
  const nx = -dy;
  const ny = dx;
  const half = Math.max(rx, ry) * 1.05;
  const spineA = { x: townCentre.x - dx * half, y: townCentre.y - dy * half };
  const spineB = { x: townCentre.x + dx * half, y: townCentre.y + dy * half };
  const mid = {
    x: townCentre.x + nx * signedHash(4, 5, state.seed) * Math.min(14, rx * 0.22),
    y: townCentre.y + ny * signedHash(4, 5, state.seed) * Math.min(14, rx * 0.22)
  };
  pushLine(state, [spineA, mid, spineB], "narrow", "tight", "oldtown/market-spine");

  if (hash2(4, 6, state.seed) < 0.45) {
    const pathAngle = spineAngle + (68 + hash2(4, 8, state.seed) * 28) * DEG;
    const pdx = Math.cos(pathAngle);
    const pdy = Math.sin(pathAngle);
    const pathHalf = Math.min(rx, ry) * 0.58;
    pushLine(state, [
      { x: townCentre.x - pdx * pathHalf, y: townCentre.y - pdy * pathHalf },
      { x: townCentre.x + pdx * pathHalf, y: townCentre.y + pdy * pathHalf }
    ], "plaza-route", "tight", "oldtown/market-path");
  }

  const spokeCount = state.minDim >= 700 ? 3 : 2;
  const connectedMajorLines = new Set<number>();
  for (let i = 0; i < spokeCount; i++) {
    const vertexIndex = Math.floor(((i + hash2(4, 7, state.seed)) / spokeCount) * loop.length) % loop.length;
    const start = loop[vertexIndex]!;
    const connection = findNetworkAttachment(state, start, start, {
      majorOnly: true,
      maxDistance: clamp(state.minDim * 0.38, 120, 360),
      minApproachAngleDeg: 32,
      minAttachmentSpacing: 52,
      minJunctionSpacing: 44,
      minHubSpacing: Math.max(rx * 1.25, 54),
      minEndpointRun: 24,
      minConnectorLength: 24,
      excludedLineIndexes: connectedMajorLines
    });
    if (!connection) continue;
    const length = dist(start, connection.point);
    const bend = signedHash(i, 513, state.seed) * Math.min(22, length * 0.1);
    if (pushLine(state, gentlyBentLine(start, connection.point, bend, hash2(i, 515, state.seed)), i === 0 ? "street" : "narrow", "tight", `oldtown/spoke/${i}`)) {
      connectedMajorLines.add(connection.lineIndex);
      reserveAttachment(state, connection);
    }
  }
  state.hubPoints.push(townCentre);
  state.hubExclusions.push({ point: townCentre, radius: Math.max(rx, ry) + 26 });
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

function planRoundabouts(state: PlanState, hubMode: HubMode, gridCrossings?: MeshGuides): void {
  const radius = clamp(state.minDim * 0.035, 18, 42);
  const picked: Vec2[] = [];
  const tryRing = (centre: Vec2, role: string): boolean => {
    if (picked.some((point) => dist(point, centre) < Math.max(2.2 * radius, 80))) return false;
    if (!roundaboutAt(state, centre, role)) return false;
    picked.push(centre);
    state.hubPoints.push(centre);
    state.hubExclusions.push({ point: centre, radius: radius + 22 });
    return true;
  };

  if (gridCrossings) {
    tryRing(state.centre, "roundabout/0");
    if (hubMode === "multiple-hubs") {
      const target = hash2(5, 1, state.seed) < 0.5 ? 2 : 1;
      const candidates: Vec2[] = [];
      for (const x of gridCrossings.verticals) {
        for (const y of gridCrossings.horizontals) {
          const candidate = { x, y };
          if (dist(candidate, state.centre) >= Math.max(2.2 * radius, 60)) candidates.push(candidate);
        }
      }
      const order = candidates.map((candidate, index) => ({ candidate, key: hash2(index, 41, state.seed) })).sort((a, b) => a.key - b.key);
      for (const { candidate } of order) {
        if (picked.length - 1 >= target) break;
        tryRing(candidate, `roundabout/${picked.length}`);
      }
    }
    return;
  }

  // Organic layouts use actual major-road intersections. Guide-grid crossings are no longer
  // reliable because the arterials themselves bend and rotate.
  const candidates = plannedVehicleIntersections(state, true)
    .filter((point) => dist(point, state.centre) >= Math.max(state.minDim * 0.22, 100))
    .filter((point) => point.x > state.box.x + radius + 12 && point.x < state.box.x + state.box.width - radius - 12 && point.y > state.box.y + radius + 12 && point.y < state.box.y + state.box.height - radius - 12);
  const order = candidates.map((candidate, index) => ({ candidate, key: hash2(index, 43, state.seed) })).sort((a, b) => a.key - b.key);
  const target = hubMode === "multiple-hubs" && state.minDim >= 700 ? 2 : 1;
  for (const { candidate } of order) {
    if (picked.length >= target) break;
    tryRing(candidate, `roundabout/${picked.length}`);
  }
}

/** Secondary European hubs are small irregular market loops with two connector streets. They are
 * staged transactionally so a rejected connector cannot leave an isolated decorative loop. */
function planSecondaryHubs(state: PlanState, hubMode: HubMode, layout: RoadLayout, mesh: MeshGuides): void {
  if (hubMode !== "multiple-hubs" || layout === "grid") return;
  const xs = [state.box.x, ...mesh.verticals, state.box.x + state.box.width];
  const ys = [state.box.y, ...mesh.horizontals, state.box.y + state.box.height];
  const cells: Rect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      cells.push({ x: xs[i]!, y: ys[j]!, width: xs[i + 1]! - xs[i]!, height: ys[j + 1]! - ys[j]! });
    }
  }
  const candidates = cells
    .map((cell, index) => {
      const centre = {
        x: cell.x + cell.width * (0.4 + hash2(index, 601, state.seed) * 0.2),
        y: cell.y + cell.height * (0.4 + hash2(index, 603, state.seed) * 0.2)
      };
      return { cell, centre, index };
    })
    .filter(({ cell, centre }) => Math.min(cell.width, cell.height) >= 165 && dist(centre, state.centre) >= state.minDim * 0.28);
  const order = candidates.map((candidate) => ({ candidate, key: hash2(candidate.index, 605, state.seed) })).sort((a, b) => a.key - b.key);
  const target = state.minDim >= 900 && hash2(7, 1, state.seed) < 0.45 ? 2 : 1;
  const placed: Vec2[] = [];

  for (const { candidate } of order) {
    if (placed.length >= target) break;
    if (placed.some((point) => dist(point, candidate.centre) < state.minDim * 0.3)) continue;
    const radius = clamp(Math.min(candidate.cell.width, candidate.cell.height) * 0.17, 24, 44);
    const loop = irregularLoop(candidate.centre, radius, radius * (0.78 + hash2(candidate.index, 607, state.seed) * 0.24), 6 + Math.floor(hash2(candidate.index, 609, state.seed) * 2), state.seed, 700 + candidate.index * 13, hash2(candidate.index, 611, state.seed) * Math.PI * 2);
    const lines: PlannedLine[] = [{ points: loop, classId: "street", preset: "standard", role: `secondary/${placed.length}/loop`, closed: true }];
    const attachments: NetworkAttachment[] = [];
    const excludedMajorLines = new Set<number>();

    const connectorAngles = [
      Math.atan2(state.centre.y - candidate.centre.y, state.centre.x - candidate.centre.x),
      Math.atan2(candidate.centre.y - state.centre.y, candidate.centre.x - state.centre.x) + signedHash(candidate.index, 613, state.seed) * 35 * DEG
    ];
    for (let connectorIndex = 0; connectorIndex < connectorAngles.length; connectorIndex++) {
      const angle = connectorAngles[connectorIndex]!;
      let start = loop[0]!;
      let best = Infinity;
      for (const point of loop) {
        const pointAngle = Math.atan2(point.y - candidate.centre.y, point.x - candidate.centre.x);
        const delta = Math.abs(Math.atan2(Math.sin(pointAngle - angle), Math.cos(pointAngle - angle)));
        if (delta < best) {
          best = delta;
          start = point;
        }
      }
      const attachment = findNetworkAttachment(state, start, start, {
        majorOnly: true,
        maxDistance: clamp(Math.hypot(candidate.cell.width, candidate.cell.height) * 0.8, 110, 320),
        minApproachAngleDeg: 30,
        minAttachmentSpacing: 58,
        minJunctionSpacing: 44,
        minHubSpacing: 58,
        minEndpointRun: 24,
        minConnectorLength: 24,
        excludedLineIndexes: excludedMajorLines,
        extraReserved: attachments.map((entry) => entry.point)
      });
      if (!attachment) continue;
      const length = dist(start, attachment.point);
      const points = gentlyBentLine(start, attachment.point, signedHash(candidate.index, 615 + connectorIndex, state.seed) * Math.min(18, length * 0.1), hash2(candidate.index, 619 + connectorIndex, state.seed));
      lines.push({ points, classId: connectorIndex === 0 ? "street" : "narrow", preset: "tight", role: `secondary/${placed.length}/connector/${connectorIndex}` });
      attachments.push(attachment);
      excludedMajorLines.add(attachment.lineIndex);
    }
    if (lines.length < 3 || !pushComposite(state, lines)) continue;
    for (const attachment of attachments) reserveAttachment(state, attachment);
    placed.push(candidate.centre);
    state.hubPoints.push(candidate.centre);
    state.hubExclusions.push({ point: candidate.centre, radius: radius + 22 });
  }
}

function planStreets(state: PlanState, layout: RoadLayout, mesh: MeshGuides): void {
  const xs = [state.box.x, ...mesh.verticals, state.box.x + state.box.width];
  const ys = [state.box.y, ...mesh.horizontals, state.box.y + state.box.height];
  const centreIn = (cell: Rect): boolean => state.centre.x >= cell.x && state.centre.x <= cell.x + cell.width && state.centre.y >= cell.y && state.centre.y <= cell.y + cell.height;
  let cellIndex = 0;

  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cell: Rect = { x: xs[i]!, y: ys[j]!, width: xs[i + 1]! - xs[i]!, height: ys[j + 1]! - ys[j]! };
      const isCentre = centreIn(cell);
      if (Math.min(cell.width, cell.height) < 70) {
        cellIndex++;
        continue;
      }

      if (layout === "mixed" && isCentre) {
        const spacing = clamp(state.minDim / 9, 70, 110);
        for (const axis of ["x", "y"] as const) {
          const lo = axis === "x" ? cell.x + 24 : cell.y + 24;
          const hi = axis === "x" ? cell.x + cell.width - 24 : cell.y + cell.height - 24;
          const centre = axis === "x" ? state.centre.x : state.centre.y;
          const positions = [centre];
          for (let k = 1; k < 8; k++) positions.push(centre - k * spacing, centre + k * spacing);
          for (const position of positions.sort((a, b) => a - b)) {
            if (position < lo || position > hi) continue;
            const a = axis === "x" ? { x: position, y: cell.y - 24 } : { x: cell.x - 24, y: position };
            const b = axis === "x" ? { x: position, y: cell.y + cell.height + 24 } : { x: cell.x + cell.width + 24, y: position };
            const classId: RouteClassId = Math.abs(position - centre) <= EPS ? "arterial" : "street";
            pushLine(state, [a, b], classId, "tight", `lattice/${axis}/${Math.round((position - centre) / spacing)}`);
          }
        }
        if (roundaboutAt(state, state.centre, "roundabout/core")) {
          state.hubExclusions.push({ point: state.centre, radius: clamp(state.minDim * 0.035, 18, 42) + 22 });
        }
        state.streetCells.push({ rect: cell, angle: 0, index: cellIndex, centre: true });
        cellIndex++;
        continue;
      }

      const cellCentre = rectCentre(cell);
      const nearHub = state.hubPoints.some((hub) => dist(hub, cellCentre) < Math.max(95, Math.min(cell.width, cell.height) * 0.7));
      const zoneIndex = Math.floor(i / 2) * 31 + Math.floor(j / 2);
      const preferVertical = cell.width > cell.height * 1.15 || (cell.width >= cell.height * 0.85 && hash2(zoneIndex, 701, state.seed) < 0.55);
      const base = preferVertical ? Math.PI / 2 : 0;
      const maxRotation = layout === "european" ? 24 : 14;
      let angle = base + signedHash(zoneIndex, 703, state.seed) * maxRotation * DEG + signedHash(cellIndex, 704, state.seed) * 4 * DEG;
      if (layout === "european" && hash2(zoneIndex, 705, state.seed) < 0.14) angle += signedHash(zoneIndex, 707, state.seed) * (16 + hash2(zoneIndex, 709, state.seed) * 16) * DEG;
      const normalWidth = Math.abs(Math.sin(angle)) * cell.width + Math.abs(Math.cos(angle)) * cell.height;
      const targetSpacing = layout === "european" ? 145 + hash2(cellIndex, 711, state.seed) * 40 : 125 + hash2(cellIndex, 711, state.seed) * 30;
      let count = Math.max(1, Math.min(layout === "european" ? 3 : 4, Math.round(normalWidth / targetSpacing) - 1));
      if (isCentre && layout === "european") count = 0;
      else if (nearHub && layout === "european") count = Math.min(count, 1);
      const maxOffset = Math.max(0, normalWidth / 2 - 30);
      const acceptedOffsets: number[] = [];
      for (let k = 0; k < count; k++) {
        const baseOffset = count === 1 ? signedHash(cellIndex, 713, state.seed) * maxOffset * 0.28 : -maxOffset + ((k + 1) / (count + 1)) * maxOffset * 2;
        const offset = baseOffset + signedHash(cellIndex * 11 + k, 715, state.seed) * Math.min(22, targetSpacing * 0.18);
        if (acceptedOffsets.some((other) => Math.abs(other - offset) < (layout === "european" ? 85 : 72))) continue;
        const ends = lineAcrossRect(cell, angle, offset, 55);
        if (!ends) continue;
        const snapDistance = Math.min(135, Math.max(70, state.minDim * 0.12));
        let attachmentA = findNetworkAttachment(state, ends[0], ends[1], {
          majorOnly: true,
          maxDistance: snapDistance,
          minApproachAngleDeg: 32,
          minAttachmentSpacing: 44,
          minJunctionSpacing: 34,
          minHubSpacing: nearHub ? 68 : 50,
          minEndpointRun: 22,
          minConnectorLength: 12
        });
        let attachmentB = findNetworkAttachment(state, ends[1], ends[0], {
          majorOnly: true,
          maxDistance: snapDistance,
          minApproachAngleDeg: 32,
          minAttachmentSpacing: 44,
          minJunctionSpacing: 34,
          minHubSpacing: nearHub ? 68 : 50,
          minEndpointRun: 22,
          minConnectorLength: 12,
          extraReserved: attachmentA ? [attachmentA.point] : []
        });
        if (attachmentA && attachmentB && dist(attachmentA.point, attachmentB.point) < 72) {
          if (attachmentA.distance <= attachmentB.distance) attachmentB = null;
          else attachmentA = null;
        }
        const a = attachmentA?.point ?? ends[0];
        const b = attachmentB?.point ?? ends[1];
        if (!attachmentA && !attachmentB && !plannedLineHitsVehicleNetwork(state, a, b, true)) continue;
        const length = dist(a, b);
        if (length < 42) continue;
        const bend = signedHash(cellIndex * 13 + k, 717, state.seed) * Math.min(layout === "european" ? 24 : 18, length * 0.07);
        const classId: RouteClassId = hash2(cellIndex * 17 + k, 719, state.seed) < (layout === "european" ? 0.5 : 0.38) ? "narrow" : "street";
        const candidatePoints = gentlyBentLine(a, b, bend, hash2(cellIndex * 19 + k, 721, state.seed));
        if (!lineClearsHubExclusions(state, candidatePoints, clearanceOf(classId))) continue;
        if (pushLine(state, candidatePoints, classId, hash2(cellIndex * 23 + k, 723, state.seed) < 0.55 ? "tight" : "standard", `street/${cellIndex}/${k}`)) {
          acceptedOffsets.push(offset);
          reserveAttachment(state, attachmentA);
          reserveAttachment(state, attachmentB);
        }
      }

      // A minority of cells get a second, oblique family. This is what creates wedges,
      // triangular blocks, and three/five-arm junctions instead of a uniformly perturbed grid.
      if (!isCentre && !nearHub && hash2(cellIndex, 725, state.seed) < (layout === "european" ? 0.18 : 0.12)) {
        const crossAngle = angle + (68 + hash2(cellIndex, 727, state.seed) * 42) * DEG;
        const crossNormalWidth = Math.abs(Math.sin(crossAngle)) * cell.width + Math.abs(Math.cos(crossAngle)) * cell.height;
        const offset = signedHash(cellIndex, 729, state.seed) * Math.max(0, crossNormalWidth / 2 - 40) * 0.45;
        const ends = lineAcrossRect(cell, crossAngle, offset, 55);
        if (ends) {
          const snapDistance = Math.min(120, Math.max(65, state.minDim * 0.1));
          let attachmentA = findNetworkAttachment(state, ends[0], ends[1], {
            majorOnly: true,
            maxDistance: snapDistance,
            minApproachAngleDeg: 34,
            minAttachmentSpacing: 48,
            minJunctionSpacing: 38,
            minHubSpacing: 54,
            minEndpointRun: 24,
            minConnectorLength: 14
          });
          let attachmentB = findNetworkAttachment(state, ends[1], ends[0], {
            majorOnly: true,
            maxDistance: snapDistance,
            minApproachAngleDeg: 34,
            minAttachmentSpacing: 48,
            minJunctionSpacing: 38,
            minHubSpacing: 54,
            minEndpointRun: 24,
            minConnectorLength: 14,
            extraReserved: attachmentA ? [attachmentA.point] : []
          });
          if (attachmentA && attachmentB && dist(attachmentA.point, attachmentB.point) < 80) {
            if (attachmentA.distance <= attachmentB.distance) attachmentB = null;
            else attachmentA = null;
          }
          const a = attachmentA?.point ?? ends[0];
          const b = attachmentB?.point ?? ends[1];
          if ((attachmentA || attachmentB || plannedLineHitsVehicleNetwork(state, a, b, true)) && dist(a, b) >= 42) {
            const bend = signedHash(cellIndex, 731, state.seed) * Math.min(20, dist(a, b) * 0.06);
            const classId: RouteClassId = hash2(cellIndex, 735, state.seed) < 0.62 ? "narrow" : "street";
            const candidatePoints = gentlyBentLine(a, b, bend, hash2(cellIndex, 733, state.seed));
            if (lineClearsHubExclusions(state, candidatePoints, clearanceOf(classId)) && pushLine(state, candidatePoints, classId, "tight", `street/${cellIndex}/cross`)) {
              reserveAttachment(state, attachmentA);
              reserveAttachment(state, attachmentB);
            }
          }
        }
      }
      state.streetCells.push({ rect: cell, angle, index: cellIndex, centre: isCentre });
      cellIndex++;
    }
  }
}

/** Lanes follow the local street fabric. Organic layouts use one-ended crooked service streets;
 * Grid retains the old mid-block axis-aligned behaviour. */
function planLanes(state: PlanState, layout: RoadLayout): void {
  if (layout === "grid") {
    const { verticals, horizontals } = axisLines(state);
    let blockIndex = 0;
    for (let i = 0; i + 1 < verticals.length; i++) {
      for (let j = 0; j + 1 < horizontals.length; j++) {
        const x0 = verticals[i]!;
        const x1 = verticals[i + 1]!;
        const y0 = horizontals[j]!;
        const y1 = horizontals[j + 1]!;
        const width = x1 - x0;
        const height = y1 - y0;
        const chance = hash2(blockIndex, 1, state.seed);
        if (Math.min(width, height) < 50 || chance >= 0.45) {
          blockIndex++;
          continue;
        }
        const vertical = chance < 0.225;
        const offset = (vertical ? (x0 + x1) / 2 : (y0 + y1) / 2) + signedHash(blockIndex, 3, state.seed) * 6;
        const classId: RouteClassId = hash2(blockIndex, 5, state.seed) < 0.5 ? "lane" : "alley";
        const cul = hash2(blockIndex, 7, state.seed) < 0.25;
        const depth = 0.55 + hash2(blockIndex, 9, state.seed) * 0.3;
        const a = vertical ? { x: offset, y: y0 } : { x: x0, y: offset };
        const b = vertical ? { x: offset, y: cul ? y0 + height * depth : y1 } : { x: cul ? x0 + width * depth : x1, y: offset };
        pushLine(state, [a, b], classId, "tight", `lane/${blockIndex}`);
        blockIndex++;
      }
    }
    return;
  }

  for (const cell of state.streetCells) {
    if (cell.centre || Math.min(cell.rect.width, cell.rect.height) < 95 || hash2(cell.index, 801, state.seed) >= 0.34) continue;
    const angle = cell.angle + signedHash(cell.index, 803, state.seed) * 12 * DEG;
    const normalWidth = Math.abs(Math.sin(angle)) * cell.rect.width + Math.abs(Math.cos(angle)) * cell.rect.height;
    const offset = signedHash(cell.index, 805, state.seed) * Math.max(0, normalWidth / 2 - 24) * 0.65;
    const ends = lineAcrossRect(cell.rect, angle, offset, 20);
    if (!ends) continue;
    const fromFirst = hash2(cell.index, 807, state.seed) < 0.5;
    const rawStart = fromFirst ? ends[0] : ends[1];
    const far = fromFirst ? ends[1] : ends[0];
    const startAttachment = findNetworkAttachment(state, rawStart, far, {
      majorOnly: false,
      maxDistance: Math.min(85, Math.max(45, state.minDim * 0.075)),
      minApproachAngleDeg: 26,
      minAttachmentSpacing: 26,
      minJunctionSpacing: 20,
      minHubSpacing: 34,
      minEndpointRun: 14,
      minConnectorLength: 8
    });
    if (!startAttachment) continue;
    const start = startAttachment.point;
    const through = hash2(cell.index, 809, state.seed) < 0.1;
    const rawEnd = through ? far : lerpPoint(rawStart, far, 0.48 + hash2(cell.index, 811, state.seed) * 0.3);
    const endAttachment = through ? findNetworkAttachment(state, rawEnd, rawStart, {
      majorOnly: false,
      maxDistance: Math.min(70, Math.max(40, state.minDim * 0.06)),
      minApproachAngleDeg: 26,
      minAttachmentSpacing: 28,
      minJunctionSpacing: 20,
      minHubSpacing: 34,
      minEndpointRun: 14,
      minConnectorLength: 8,
      extraReserved: [startAttachment.point]
    }) : null;
    const end = endAttachment?.point ?? rawEnd;
    if (dist(start, end) < 22) continue;
    const classId: RouteClassId = hash2(cell.index, 813, state.seed) < 0.55 ? "lane" : "alley";
    const bend = signedHash(cell.index, 815, state.seed) * Math.min(12, dist(start, end) * 0.08);
    const candidatePoints = gentlyBentLine(start, end, bend, hash2(cell.index, 817, state.seed));
    if (lineClearsHubExclusions(state, candidatePoints, clearanceOf(classId)) && pushLine(state, candidatePoints, classId, "tight", `lane/${cell.index}`)) {
      reserveAttachment(state, startAttachment);
      reserveAttachment(state, endAttachment);
    }
  }
}

/** Curved radial highway approaches cross the orbital route and terminate at the Scene edge. */
function planHighways(state: PlanState): void {
  const count = state.minDim >= 700 ? 3 + (hash2(9, 1, state.seed) < 0.45 ? 1 : 0) : 2;
  const sides = ["w", "e", "n", "s"] as const;
  const chosen: { side: string; position: number }[] = [];
  let guard = 0;
  while (chosen.length < count && guard++ < 100) {
    const side = sides[Math.floor(hash2(9, 2 + guard, state.seed) * sides.length)]!;
    const horizontal = side === "w" || side === "e";
    const extent = horizontal ? state.box.height : state.box.width;
    const margin = Math.min(95, extent * 0.14);
    const position = margin + hash2(9, 103 + guard, state.seed) * Math.max(1, extent - margin * 2);
    if (chosen.some((entry) => entry.side === side && Math.abs(entry.position - position) < 120)) continue;
    const edge = side === "w"
      ? { x: state.box.x, y: state.box.y + position }
      : side === "e"
        ? { x: state.box.x + state.box.width, y: state.box.y + position }
        : side === "n"
          ? { x: state.box.x + position, y: state.box.y }
          : { x: state.box.x + position, y: state.box.y + state.box.height };
    const total = dist(edge, state.centre);
    const depth = clamp(state.minDim * (0.2 + hash2(9, 207 + guard, state.seed) * 0.08), 125, 260);
    const inner = lerpPoint(edge, state.centre, Math.min(0.75, depth / Math.max(total, 1)));
    const bend = signedHash(9, 307 + guard, state.seed) * Math.min(34, depth * 0.16);
    if (pushLine(state, gentlyBentLine(inner, edge, bend, hash2(9, 407 + guard, state.seed)), "highway", "standard", `highway/${side}/${chosen.length}`)) chosen.push({ side, position });
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
      if (state.reservedSites.length > 0 && pointInAnyReserved(mid, state.reservedSites)) continue;
      if (!corridorFits(a, b, clearance, state.mask, state.land, state.sceneBounds, state.reservedSites)) continue;
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
    if (!corridorFits(endpoint.point, best.point, clearance, state.mask, state.land, state.sceneBounds, state.reservedSites)) continue;
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
  planLanes(state, "grid");
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

/**
 * Every piece of the canonical compiled route occupancy (corridor quads, junction node
 * discs at the widest radius, and smoothed curves — exactly what `compiledRouteOccupancy`
 * unions) must stay out of every reserved landmark site. Sharing the plan validator's
 * predicate keeps the road-side guarantee and the plan-side legality check identical.
 */
function corridorsAvoidSites(source: RoadSource, reservedSites: readonly Ring[]): boolean {
  if (reservedSites.length === 0) return true;
  const occupancy = compiledRouteOccupancy(compileRouteNetwork(source)).all;
  return reservedSites.every(
    (site) => polygonArea(intersection(ringAsMulti(site), occupancy)) <= 1e-6
  );
}

function nearestNodeId(source: RoadSource, point: Vec2, maxD: number, eligible?: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  let bestD = maxD;
  for (const node of source.nodes) {
    if (eligible && !eligible.has(node.id)) continue;
    const d = Math.hypot(node.x - point.x, node.y - point.y);
    if (d <= bestD) {
      bestD = d;
      best = node.id;
    }
  }
  return best;
}

function compactRoadSource(source: RoadSource): RoadSource {
  const usedNodes = new Set(source.edges.flatMap((edge) => [edge.a, edge.b]));
  const usedRoutes = new Set(source.edges.map((edge) => edge.routeId));
  return {
    nodes: source.nodes.filter((node) => usedNodes.has(node.id)),
    routes: source.routes.filter((route) => usedRoutes.has(route.id)),
    edges: source.edges
  };
}

function topologyStatus(source: RoadSource): { ok: boolean; problems: string[] } {
  try {
    const result = validateRouteTopology(source, compileRouteNetwork(source));
    return { ok: result.ok, problems: result.problems };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
}

function edgeIdsFromTopologyProblems(problems: readonly string[], source: RoadSource): Set<string> {
  const known = new Set(source.edges.map((edge) => edge.id));
  const result = new Set<string>();
  for (const problem of problems) {
    for (const match of problem.matchAll(/"([^"]+)"/g)) {
      const raw = match[1]!;
      const base = raw.replace(/:\d+$/, "");
      if (known.has(base)) result.add(base);
    }
  }
  return result;
}

function generatedRouteRemovalPriority(role: string | undefined): number {
  if (!role) return 50;
  if (role.includes("/ring/") && role.includes("roundabout/")) return 100;
  if (role.startsWith("lane/") || role.includes("/lane/")) return 0;
  if (role.startsWith("promenade/") || role.startsWith("plaza/") || role.includes("market-path") || role.startsWith("cycle/")) return 1;
  if (role.startsWith("street/")) return 2;
  if (role.startsWith("secondary/")) return 3;
  if (role.startsWith("highway/")) return 4;
  if (role.startsWith("oldtown/spoke/")) return 5;
  if (role.startsWith("oldtown/")) return 7;
  if (role.startsWith("avenue/")) return 8;
  if (role.startsWith("ring/")) return 9;
  if (role.startsWith("arterial/")) return 10;
  return 6;
}

function vehicleEdgeCount(source: RoadSource): number {
  return source.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle).length;
}

/** Give every edge of one generated route its own route record. The authoritative graph and all
 * junctions stay intact, but the compiler can no longer round through its degree-two anchors.
 * This is a much safer response to curve-only contacts than deleting the complete route. */
function straightenGeneratedRoute(
  source: RoadSource,
  routeId: string,
  idSeed: string,
  usedIds: Set<string>,
  roles: Map<string, string>
): RoadSource | null {
  const route = source.routes.find((candidate) => candidate.id === routeId);
  if (!route) return null;
  const routeEdges = source.edges.filter((edge) => edge.routeId === routeId).slice().sort((a, b) => a.id.localeCompare(b.id));
  if (routeEdges.length === 0) return null;
  if (routeEdges.length === 1) {
    if (route.curvePreset === "tight") return null;
    return {
      nodes: source.nodes,
      routes: source.routes.map((candidate) => candidate.id === routeId ? { ...candidate, curvePreset: "tight" as const } : candidate),
      edges: source.edges
    };
  }

  const role = roles.get(routeId) ?? routeId;
  const replacements: RoadSource["routes"] = [];
  const edgeRouteIds = new Map<string, string>();
  for (let index = 0; index < routeEdges.length; index++) {
    const edge = routeEdges[index]!;
    const replacementId = index === 0
      ? routeId
      : allocateGeneratedId("route", idSeed, `fallback/straight/${routeId}/${edge.id}`, index, usedIds);
    usedIds.add(replacementId);
    edgeRouteIds.set(edge.id, replacementId);
    replacements.push({ id: replacementId, curvePreset: "tight" });
    roles.set(replacementId, role);
  }

  return {
    nodes: source.nodes,
    routes: [...source.routes.filter((candidate) => candidate.id !== routeId), ...replacements].sort((a, b) => a.id.localeCompare(b.id)),
    edges: source.edges.map((edge) => edge.routeId === routeId ? { ...edge, routeId: edgeRouteIds.get(edge.id)! } : edge)
  };
}

function implicatedRouteIds(problems: readonly string[], source: RoadSource): Set<string> {
  const edgeIds = edgeIdsFromTopologyProblems(problems, source);
  return new Set(source.edges.filter((edge) => edgeIds.has(edge.id)).map((edge) => edge.routeId));
}

/** Generated roads should be valid by construction. When the canonical compiler still finds a
 * curve contact on a large map, preserve the graph first: straighten only implicated routes, then
 * (if necessary) all remaining multi-edge routes. Only genuine straight-edge conflicts may remove
 * individual edges, and a hard density floor prevents the fallback from silently erasing a city. */
function stabilizeGeneratedSource(
  source: RoadSource,
  roleByRouteId: ReadonlyMap<string, string>,
  idSeed: string
): { source: RoadSource; removedEdges: number; warnings: string[] } {
  let candidate = source;
  let status = topologyStatus(candidate);
  if (status.ok) return { source: candidate, removedEdges: 0, warnings: [] };

  const originalEdgeCount = source.edges.length;
  const originalVehicleEdges = vehicleEdgeCount(source);
  const minimumVehicleEdges = Math.max(1, Math.floor(originalVehicleEdges * 0.72));
  const usedIds = new Set([...source.nodes, ...source.routes, ...source.edges].map((item) => item.id));
  const roles = new Map(roleByRouteId);
  const straightened = new Set<string>();

  const straightenOneImplicated = (): boolean => {
    const implicated = implicatedRouteIds(status.problems, candidate);
    const choices = candidate.routes
      .filter((route) => implicated.has(route.id) && !straightened.has(route.id))
      .map((route) => ({ route, edgeCount: candidate.edges.filter((edge) => edge.routeId === route.id).length }))
      .sort((a, b) => b.edgeCount - a.edgeCount || a.route.id.localeCompare(b.route.id));
    const selected = choices.find((choice) => choice.edgeCount > 1 || choice.route.curvePreset !== "tight");
    if (!selected) return false;
    const next = straightenGeneratedRoute(candidate, selected.route.id, idSeed, usedIds, roles);
    straightened.add(selected.route.id);
    if (!next) return false;
    candidate = next;
    status = topologyStatus(candidate);
    return true;
  };

  // Most reported span contacts are introduced by smoothing one multi-anchor route.
  const targetedLimit = Math.min(48, candidate.routes.length);
  for (let iteration = 0; iteration < targetedLimit && !status.ok; iteration++) {
    if (!straightenOneImplicated()) break;
  }

  // Residual straight-edge conflicts (routes already straight) cannot be fixed by straightening;
  // remove the conflicting edge first, before any curve-sacrificing global pass runs.
  let removedEdges = 0;
  const maximumEdgeRemovals = Math.min(36, Math.max(6, Math.ceil(originalEdgeCount * 0.08)));
  while (!status.ok && removedEdges < maximumEdgeRemovals) {
    const edgeIds = edgeIdsFromTopologyProblems(status.problems, candidate);
    let choices = candidate.edges.filter((edge) => edgeIds.has(edge.id));
    if (choices.length === 0) break;
    choices = choices.slice().sort((a, b) => {
      const priority = generatedRouteRemovalPriority(roles.get(a.routeId)) - generatedRouteRemovalPriority(roles.get(b.routeId));
      if (priority !== 0) return priority;
      const vehicle = Number(Boolean(ROUTE_CLASS_REGISTRY.get(a.classId)?.vehicle)) - Number(Boolean(ROUTE_CLASS_REGISTRY.get(b.classId)?.vehicle));
      return vehicle !== 0 ? vehicle : a.id.localeCompare(b.id);
    });
    const selected = choices[0]!;
    const selectedVehicle = Boolean(ROUTE_CLASS_REGISTRY.get(selected.classId)?.vehicle);
    if (selectedVehicle && vehicleEdgeCount(candidate) - 1 < minimumVehicleEdges) break;
    candidate = compactRoadSource({
      nodes: candidate.nodes,
      routes: candidate.routes,
      edges: candidate.edges.filter((edge) => edge.id !== selected.id)
    });
    removedEdges++;
    status = topologyStatus(candidate);
    if (status.ok) break;
    // Removing an edge can expose a curve contact on a still-smoothed route; straighten it before removing more.
    straightenOneImplicated();
  }

  // Only as the very last resort: eliminate smoothing globally while keeping every node and edge.
  // This intentionally sacrifices some curves before sacrificing any city fabric.
  if (!status.ok) {
    const multi = candidate.routes
      .map((route) => ({ route, edgeCount: candidate.edges.filter((edge) => edge.routeId === route.id).length }))
      .filter((entry) => entry.edgeCount > 1 || entry.route.curvePreset !== "tight")
      .sort((a, b) => b.edgeCount - a.edgeCount || a.route.id.localeCompare(b.route.id));
    for (const entry of multi) {
      const next = straightenGeneratedRoute(candidate, entry.route.id, idSeed, usedIds, roles);
      if (!next) continue;
      candidate = next;
      straightened.add(entry.route.id);
    }
    status = topologyStatus(candidate);
  }

  if (!status.ok) {
    throw new Error(
      `Generated road topology is invalid after non-destructive fallback; refused to collapse the network below ${minimumVehicleEdges} vehicle edges: ${status.problems.join(" ")}`
    );
  }
  if (vehicleEdgeCount(candidate) < minimumVehicleEdges) {
    throw new Error(`Generated road fallback refused an implausibly sparse result (${vehicleEdgeCount(candidate)}/${originalVehicleEdges} vehicle edges).`);
  }

  const warnings: string[] = [];
  if (straightened.size > 0) warnings.push(`large-map topology fallback straightened ${straightened.size} generated route${straightened.size === 1 ? "" : "s"}`);
  if (removedEdges > 0) warnings.push(`large-map topology fallback removed ${removedEdges} conflicting edge${removedEdges === 1 ? "" : "s"}`);
  return { source: candidate, removedEdges: originalEdgeCount - candidate.edges.length, warnings };
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
  const seed = deriveLabelledSeed(input.citySeed, "roads/v2");
  const geometricCentre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const centre = layout !== "european"
    ? geometricCentre
    : {
        x: clamp(geometricCentre.x + signedHash(17, 1, seed) * Math.min(55, box.width * 0.045), box.x + minDim * 0.18, box.x + box.width - minDim * 0.18),
        y: clamp(geometricCentre.y + signedHash(17, 2, seed) * Math.min(45, box.height * 0.045), box.y + minDim * 0.18, box.y + box.height - minDim * 0.18)
      };
  const reservedSites = input.reservedSites ?? [];
  const state: PlanState = {
    mask: input.mask,
    land,
    sceneBounds,
    box,
    centre,
    minDim,
    seed,
    lines: [],
    barriers: [],
    hubPoints: [],
    streetCells: [],
    attachments: [],
    hubExclusions: [],
    reservedSites,
    warnings: [],
    rejected: 0
  };
  if (layout === "grid") {
    planGrid(state, hubMode);
  } else {
    state.hubPoints.push(state.centre);
    const mesh = planArterials(state);
    planAvenues(state);
    planRings(state);
    if (layout === "european") planOldTown(state);
    planRoundabouts(state, hubMode);
    planSecondaryHubs(state, hubMode, layout, mesh);
    planStreets(state, layout, mesh);
    planLanes(state, layout);
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
      clipSegment(a, b, clearanceOf(line.classId), input.mask, land, sceneBounds, minLengthOfPlannedLine(line), clipped, reservedSites);
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
  const roleByRouteId = new Map(routeIds.map((id, index) => [id, state.lines[index]!.role] as const));
  const stabilized = stabilizeGeneratedSource(roads, roleByRouteId, idSeed);
  const finalRoads = stabilized.source;
  const sourceProblems = validateRoadSource(finalRoads);
  if (sourceProblems.length > 0) throw new Error(`Generated road source is invalid: ${sourceProblems.join(" ")}`);
  const topology = validateRouteTopology(finalRoads, compileRouteNetwork(finalRoads));
  if (!topology.ok) throw new Error(`Generated road topology is invalid: ${topology.problems.join(" ")}`);
  if (!corridorsInsideMasks(finalRoads, input.mask, land, sceneBounds)) throw new Error("Generated road corridors leave the active generation mask or land.");
  if (!corridorsAvoidSites(finalRoads, reservedSites)) throw new Error("Generated road corridors cross a reserved landmark site; the reservation is not legal.");
  // Hubs must land on the vehicle network: a decorative loop (cycleway/promenade) can run closer to a hub point than the hub's own ring.
  const vehicleNodeIds = new Set<string>();
  for (const edge of finalRoads.edges) {
    if (!ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) continue;
    vehicleNodeIds.add(edge.a);
    vehicleNodeIds.add(edge.b);
  }
  const hubs = state.hubPoints
    .map((point) => nearestNodeId(finalRoads, point, 120, vehicleNodeIds))
    .filter((id): id is string => id !== undefined)
    .filter((id, index, all) => all.indexOf(id) === index);
  return {
    roads: finalRoads,
    diagnostics: {
      layout,
      hubMode,
      hubs,
      attempts,
      discarded: discarded + stabilized.removedEdges,
      warnings: [...state.warnings, ...stabilized.warnings]
    }
  };
}

export const generateRoadNetwork = generateInitialRoadNetwork;
