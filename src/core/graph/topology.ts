import type { Vec2 } from "../geom/types.js";
import {
  allocateManualId,
  ROUTE_CLASS_REGISTRY,
  validateRoadSource,
  type RoadEdgeSource,
  type RoadNodeSource,
  type RoadOrigin,
  type RoadSource,
  type RouteClassId,
  type RoadCurvePreset
} from "../gen/city.js";
import { compileRouteNetwork, CONNECTION_TOLERANCE_M, TOPOLOGY_EPSILON_M, type CompiledRouteNetwork } from "./compiler.js";

export interface TopologyValidation {
  ok: boolean;
  problems: string[];
}

export interface RoadEditOptions {
  revision?: number;
  sequence?: number;
  toleranceM?: number;
}

export interface ConnectRoadOptions extends RoadEditOptions {
  classId: RouteClassId;
  curvePreset?: RoadCurvePreset;
  name?: string | null;
  origin?: RoadOrigin;
  routeId?: string;
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
function project(a: Vec2, b: Vec2, p: Vec2): { point: Vec2; u: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  if (denominator <= TOPOLOGY_EPSILON_M * TOPOLOGY_EPSILON_M) return { point: { ...a }, u: 0 };
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator));
  return { point: { x: a.x + dx * u, y: a.y + dy * u }, u };
}

interface Intersection {
  t: number;
  u: number;
  point: Vec2;
  proper: boolean;
  collinear: boolean;
}

function intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Intersection | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  if (Math.abs(denominator) <= TOPOLOGY_EPSILON_M) {
    if (Math.abs(qx * ry - qy * rx) > TOPOLOGY_EPSILON_M) return null;
    const rr = rx * rx + ry * ry;
    if (rr <= TOPOLOGY_EPSILON_M * TOPOLOGY_EPSILON_M) return null;
    const t0 = (qx * rx + qy * ry) / rr;
    const t1 = ((d.x - a.x) * rx + (d.y - a.y) * ry) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if (hi - lo <= TOPOLOGY_EPSILON_M) return null;
    return { t: lo, u: 0, point: { x: a.x + rx * lo, y: a.y + ry * lo }, proper: false, collinear: true };
  }
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t < -TOPOLOGY_EPSILON_M || t > 1 + TOPOLOGY_EPSILON_M || u < -TOPOLOGY_EPSILON_M || u > 1 + TOPOLOGY_EPSILON_M) return null;
  return { t, u, point: { x: a.x + t * rx, y: a.y + t * ry }, proper: t > TOPOLOGY_EPSILON_M && t < 1 - TOPOLOGY_EPSILON_M && u > TOPOLOGY_EPSILON_M && u < 1 - TOPOLOGY_EPSILON_M, collinear: false };
}

const sameUndirectedEdge = (a: string, b: string, c: string, d: string): boolean => (a === c && b === d) || (a === d && b === c);

function extendedCorridorOverlap(left: CompiledRouteNetwork["segments"][number], right: CompiledRouteNetwork["segments"][number]): boolean {
  const vx = left.b.x - left.a.x;
  const vy = left.b.y - left.a.y;
  const length = Math.hypot(vx, vy);
  if (length <= TOPOLOGY_EPSILON_M) return false;
  const rvx = right.b.x - right.a.x;
  const rvy = right.b.y - right.a.y;
  const rightLength = Math.hypot(rvx, rvy);
  if (rightLength <= TOPOLOGY_EPSILON_M || Math.abs(vx * rvy - vy * rvx) / (length * rightLength) > 0.1) return false;
  // WHY: Close parallel centrelines become invalid only when their class-owned corridors share a run.
  const separation = Math.abs(vx * (right.a.y - left.a.y) - vy * (right.a.x - left.a.x)) / length;
  if (separation >= left.clearanceM + right.clearanceM - TOPOLOGY_EPSILON_M) return false;
  const t0 = ((right.a.x - left.a.x) * vx + (right.a.y - left.a.y) * vy) / (length * length);
  const t1 = ((right.b.x - left.a.x) * vx + (right.b.y - left.a.y) * vy) / (length * length);
  const overlap = Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
  return overlap > TOPOLOGY_EPSILON_M;
}

export function validateRouteTopology(source: RoadSource, network: CompiledRouteNetwork = compileRouteNetwork(source)): TopologyValidation {
  const problems = validateRoadSource(source);
  const spans = network.segments;
  for (let i = 0; i < spans.length; i++) {
    const left = spans[i]!;
    for (let j = i + 1; j < spans.length; j++) {
      const right = spans[j]!;
      if (left.id === right.id) continue;
      const sharesNode = left.aNodeId === right.aNodeId || left.aNodeId === right.bNodeId || left.bNodeId === right.aNodeId || left.bNodeId === right.bNodeId;
      const contiguousCompiled = left.routeId === right.routeId && (
        dist(left.a, right.a) <= TOPOLOGY_EPSILON_M ||
        dist(left.a, right.b) <= TOPOLOGY_EPSILON_M ||
        dist(left.b, right.a) <= TOPOLOGY_EPSILON_M ||
        dist(left.b, right.b) <= TOPOLOGY_EPSILON_M
      );
      const hit = intersection(left.a, left.b, right.a, right.b);
      if (!hit) {
        if (!sharesNode && !contiguousCompiled && extendedCorridorOverlap(left, right)) problems.push(`Road corridors "${left.id}" and "${right.id}" overlap for an extended run.`);
        continue;
      }
      if (contiguousCompiled && !hit.collinear) continue;
      if (hit.collinear) {
        problems.push(`Road spans "${left.id}" and "${right.id}" overlap for a non-zero length.`);
      } else if (hit.proper && !sharesNode) {
        problems.push(`Road spans "${left.id}" and "${right.id}" cross without an explicit junction.`);
      } else if (!sharesNode && (dist(left.a, right.a) <= TOPOLOGY_EPSILON_M || dist(left.a, right.b) <= TOPOLOGY_EPSILON_M || dist(left.b, right.a) <= TOPOLOGY_EPSILON_M || dist(left.b, right.b) <= TOPOLOGY_EPSILON_M)) {
        problems.push(`Road spans "${left.id}" and "${right.id}" touch without an explicit junction.`);
      }
      if (left.edgeId === right.edgeId && hit.collinear) problems.push(`Road edge "${left.edgeId}" doubles back over itself.`);
      if (!sharesNode && !hit.proper && !hit.collinear && extendedCorridorOverlap(left, right)) problems.push(`Road corridors "${left.id}" and "${right.id}" overlap for an extended run.`);
    }
  }
  const edgePairs = new Set<string>();
  for (const edge of source.edges) {
    const key = edge.a < edge.b ? `${edge.a}\0${edge.b}` : `${edge.b}\0${edge.a}`;
    if (edgePairs.has(key)) problems.push(`Duplicate corridor between nodes "${edge.a}" and "${edge.b}".`);
    edgePairs.add(key);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

function cloneSource(source: RoadSource): RoadSource {
  return { nodes: source.nodes.map((node) => ({ ...node })), routes: source.routes.map((route) => ({ ...route })), edges: source.edges.map((edge) => ({ ...edge })) };
}

function ids(source: RoadSource): Set<string> {
  return new Set([...source.nodes, ...source.routes, ...source.edges].map((item) => item.id));
}

function nextId(source: RoadSource, kind: "node" | "edge" | "route", revision = 0, sequence = 0, lineage = "edit"): string {
  return allocateManualId(kind, revision, sequence, lineage, ids(source));
}

function nearestNode(source: RoadSource, point: Vec2, tolerance: number): RoadNodeSource | undefined {
  let best: RoadNodeSource | undefined;
  let bestDistance = tolerance;
  for (const node of source.nodes) {
    const distance = dist(node, point);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

function edgeProjection(source: RoadSource, point: Vec2, tolerance: number): { edge: RoadEdgeSource; point: Vec2; distance: number; u: number } | undefined {
  const byId = new Map(source.nodes.map((node) => [node.id, node]));
  let best: { edge: RoadEdgeSource; point: Vec2; distance: number; u: number } | undefined;
  for (const edge of source.edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (!a || !b) continue;
    const candidate = project(a, b, point);
    const distance = dist(candidate.point, point);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { edge, point: candidate.point, distance, u: candidate.u };
  }
  return best;
}

function splitProperCrossings(source: RoadSource, options: RoadEditOptions = {}): RoadSource {
  const out = cloneSource(source);
  const byId = new Map(out.nodes.map((node) => [node.id, node]));
  const splits = new Map<string, { t: number; nodeId: string }[]>();
  const intersectionNodes = new Map<string, string>();
  let sequence = options.sequence ?? 0;
  for (let i = 0; i < out.edges.length; i++) {
    const left = out.edges[i]!;
    const a = byId.get(left.a);
    const b = byId.get(left.b);
    if (!a || !b) continue;
    for (let j = i + 1; j < out.edges.length; j++) {
      const right = out.edges[j]!;
      if (left.a === right.a || left.a === right.b || left.b === right.a || left.b === right.b) continue;
      const c = byId.get(right.a);
      const d = byId.get(right.b);
      if (!c || !d) continue;
      const hit = intersection(a, b, c, d);
      if (!hit || !hit.proper || hit.collinear) continue;
      const key = `${Math.round(hit.point.x / TOPOLOGY_EPSILON_M)}:${Math.round(hit.point.y / TOPOLOGY_EPSILON_M)}`;
      const nodeId = intersectionNodes.get(key) ?? nextId(out, "node", options.revision, sequence++, `${left.id}/${right.id}`);
      if (!intersectionNodes.has(key)) {
        intersectionNodes.set(key, nodeId);
        out.nodes.push({ id: nodeId, x: hit.point.x, y: hit.point.y });
        byId.set(nodeId, out.nodes[out.nodes.length - 1]!);
      }
      splits.set(left.id, [...(splits.get(left.id) ?? []), { t: hit.t, nodeId }]);
      splits.set(right.id, [...(splits.get(right.id) ?? []), { t: hit.u, nodeId }]);
    }
  }
  if (splits.size === 0) return out;
  const rebuilt: RoadEdgeSource[] = [];
  for (const edge of out.edges) {
    const points = [{ t: 0, nodeId: edge.a }, ...(splits.get(edge.id) ?? []), { t: 1, nodeId: edge.b }].sort((a, b) => a.t - b.t);
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!.nodeId;
      const b = points[i + 1]!.nodeId;
      if (a === b) continue;
      const id = i === 0 ? edge.id : nextId(out, "edge", options.revision, sequence++, `${edge.id}/cross/${i}`);
      rebuilt.push({ ...edge, id, a, b });
    }
  }
  out.edges = rebuilt;
  return out;
}

export function splitEdgeAtPoint(source: RoadSource, edgeId: string, point: Vec2, options: RoadEditOptions = {}): { source: RoadSource; nodeId: string } {
  const out = cloneSource(source);
  const edgeIndex = out.edges.findIndex((edge) => edge.id === edgeId);
  if (edgeIndex < 0) throw new Error(`Unknown road edge "${edgeId}".`);
  const edge = out.edges[edgeIndex]!;
  const byId = new Map(out.nodes.map((node) => [node.id, node]));
  const a = byId.get(edge.a);
  const b = byId.get(edge.b);
  if (!a || !b) throw new Error(`Road edge "${edgeId}" has missing endpoint.`);
  if (dist(a, point) <= TOPOLOGY_EPSILON_M) return { source: out, nodeId: a.id };
  if (dist(b, point) <= TOPOLOGY_EPSILON_M) return { source: out, nodeId: b.id };
  const nodeId = nextId(out, "node", options.revision, options.sequence, edgeId);
  out.nodes.push({ id: nodeId, x: point.x, y: point.y });
  const childId = nextId(out, "edge", options.revision, (options.sequence ?? 0) + 1, `${edgeId}/split`);
  out.edges[edgeIndex] = { ...edge, b: nodeId };
  out.edges.splice(edgeIndex + 1, 0, { ...edge, id: childId, a: nodeId });
  return { source: out, nodeId };
}

export function connectRoadPoints(source: RoadSource, points: readonly Vec2[], options: ConnectRoadOptions): RoadSource {
  if (points.length < 2) throw new Error("A road needs at least two points.");
  const out = cloneSource(source);
  const tolerance = Math.max(0, options.toleranceM ?? CONNECTION_TOLERANCE_M);
  const nodeIds: string[] = [];
  let sequence = options.sequence ?? 0;
  const resolve = (point: Vec2): string => {
    const node = nearestNode(out, point, tolerance);
    if (node) return node.id;
    const projection = edgeProjection(out, point, tolerance);
    if (projection) {
      const split = splitEdgeAtPoint(out, projection.edge.id, projection.point, { revision: options.revision, sequence: sequence++, toleranceM: tolerance });
      out.nodes = split.source.nodes;
      out.edges = split.source.edges;
      return split.nodeId;
    }
    const id = nextId(out, "node", options.revision, sequence++, "anchor");
    out.nodes.push({ id, x: point.x, y: point.y });
    return id;
  };
  for (const point of points) nodeIds.push(resolve(point));
  const routeId = options.routeId ?? nextId(out, "route", options.revision, sequence++, "route");
  if (!out.routes.some((route) => route.id === routeId)) out.routes.push({ id: routeId, curvePreset: options.curvePreset ?? "standard" });
  const usedEdges = ids(out);
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const a = nodeIds[i]!;
    const b = nodeIds[i + 1]!;
    if (a === b) continue;
    if (out.edges.some((edge) => edge.routeId === routeId && sameUndirectedEdge(edge.a, edge.b, a, b))) continue;
    const edgeId = allocateManualId("edge", options.revision ?? 0, sequence++, `${routeId}/${i}`, usedEdges);
    out.edges.push({ id: edgeId, a, b, routeId, classId: options.classId, name: options.name ?? null, locked: false, origin: options.origin ?? "authored" });
  }
  const planar = splitProperCrossings(out, { revision: options.revision, sequence });
  out.nodes = planar.nodes;
  out.edges = planar.edges;
  const validation = validateRouteTopology(out);
  if (!validation.ok) throw new Error(validation.problems.join(" "));
  return out;
}

export function moveNode(source: RoadSource, nodeId: string, point: Vec2, options: RoadEditOptions = {}): RoadSource {
  const out = cloneSource(source);
  const index = out.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new Error(`Unknown road node "${nodeId}".`);
  const tolerance = Math.max(0, options.toleranceM ?? CONNECTION_TOLERANCE_M);
  const weldTarget = out.nodes.find((node) => node.id !== nodeId && dist(node, point) <= tolerance);
  if (weldTarget) return weldNodes(out, nodeId, weldTarget.id);
  out.nodes[index] = { ...out.nodes[index]!, x: point.x, y: point.y };
  const validation = validateRouteTopology(out);
  if (!validation.ok) throw new Error(validation.problems.join(" "));
  return out;
}

export function weldNodes(source: RoadSource, fromId: string, intoId: string): RoadSource {
  if (fromId === intoId) return cloneSource(source);
  const out = cloneSource(source);
  if (!out.nodes.some((node) => node.id === fromId) || !out.nodes.some((node) => node.id === intoId)) throw new Error("Cannot weld an unknown road node.");
  const seen = new Set<string>();
  const edges: RoadEdgeSource[] = [];
  for (const edge of out.edges) {
    const a = edge.a === fromId ? intoId : edge.a;
    const b = edge.b === fromId ? intoId : edge.b;
    if (a === b) continue;
    const key = a < b ? `${a}\0${b}\0${edge.routeId}` : `${b}\0${a}\0${edge.routeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...edge, a, b });
  }
  out.edges = edges;
  const used = new Set(out.edges.flatMap((edge) => [edge.a, edge.b]));
  out.nodes = out.nodes.filter((node) => used.has(node.id));
  const validation = validateRouteTopology(out);
  if (!validation.ok) throw new Error(validation.problems.join(" "));
  return out;
}

export function deleteJunction(source: RoadSource, nodeId: string, options: RoadEditOptions = {}): RoadSource {
  const out = cloneSource(source);
  const node = out.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown road node "${nodeId}".`);
  const incident = out.edges.filter((edge) => edge.a === nodeId || edge.b === nodeId);
  const byId = new Map(out.nodes.map((candidate) => [candidate.id, candidate]));
  const maxClearance = incident.reduce((max, edge) => Math.max(max, (ROUTE_CLASS_REGISTRY.get(edge.classId)?.widthM ?? 0) / 2 + (ROUTE_CLASS_REGISTRY.get(edge.classId)?.sidewalkM ?? 0)), 0);
  const gap = Math.max(0.5, maxClearance + 0.25);
  let sequence = options.sequence ?? 0;
  for (const edge of incident) {
    const otherId = edge.a === nodeId ? edge.b : edge.a;
    const other = byId.get(otherId);
    if (!other) continue;
    const away = dist(node, other);
    if (away <= TOPOLOGY_EPSILON_M) continue;
    const ratio = Math.min(0.45, gap / away);
    const stub = { x: node.x + (other.x - node.x) * ratio, y: node.y + (other.y - node.y) * ratio };
    const stubId = nextId(out, "node", options.revision, sequence++, `${nodeId}/${edge.id}`);
    out.nodes.push({ id: stubId, ...stub });
    const edgeIndex = out.edges.findIndex((candidate) => candidate.id === edge.id);
    if (edgeIndex >= 0) out.edges[edgeIndex] = edge.a === nodeId ? { ...edge, a: stubId } : { ...edge, b: stubId };
  }
  out.edges = out.edges.filter((edge) => edge.a !== nodeId && edge.b !== nodeId);
  out.nodes = out.nodes.filter((candidate) => candidate.id !== nodeId);
  const used = new Set(out.edges.flatMap((edge) => [edge.a, edge.b]));
  out.nodes = out.nodes.filter((candidate) => used.has(candidate.id));
  const validation = validateRouteTopology(out);
  if (!validation.ok) throw new Error(validation.problems.join(" "));
  return out;
}

export function deleteEdges(source: RoadSource, edgeIds: readonly string[]): { source: RoadSource; disconnectedVehicleNetwork: boolean } {
  const remove = new Set(edgeIds);
  const out = cloneSource(source);
  out.edges = out.edges.filter((edge) => !remove.has(edge.id));
  const used = new Set(out.edges.flatMap((edge) => [edge.a, edge.b]));
  out.nodes = out.nodes.filter((node) => used.has(node.id));
  const routeUse = new Set(out.edges.map((edge) => edge.routeId));
  out.routes = out.routes.filter((route) => routeUse.has(route.id));
  const vehicleEdges = out.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle);
  const components = new Set<string>();
  const seen = new Set<string>();
  for (const edge of vehicleEdges) {
    if (seen.has(edge.id)) continue;
    const queue = [edge.a];
    seen.add(edge.id);
    const nodes = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      nodes.add(id);
      for (const other of vehicleEdges.filter((candidate) => candidate.a === id || candidate.b === id)) {
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        queue.push(other.a === id ? other.b : other.a);
      }
    }
    components.add([...nodes].sort().join(","));
  }
  const validation = validateRouteTopology(out);
  if (!validation.ok) throw new Error(validation.problems.join(" "));
  return { source: out, disconnectedVehicleNetwork: components.size > 1 };
}

export function appendRoute(source: RoadSource, points: readonly Vec2[], options: ConnectRoadOptions): RoadSource {
  return connectRoadPoints(source, points, options);
}
