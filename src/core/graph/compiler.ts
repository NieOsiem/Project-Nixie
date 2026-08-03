import type { Vec2 } from "../geom/types.js";
import {
  ROUTE_CLASS_REGISTRY,
  type RoadEdgeSource,
  type RoadNodeSource,
  type RoadRouteSource,
  type RoadSource,
  type RouteClassDefinition,
  type RoadCurvePreset
} from "../gen/city.js";

export const CONNECTION_TOLERANCE_M = 1;
export const TOPOLOGY_EPSILON_M = 0.001;
export const CURVE_CHORD_TOLERANCE_M = 0.1;

export interface CompiledSpan {
  id: string;
  routeId: string;
  edgeId: string;
  aNodeId: string;
  bNodeId: string;
  a: Vec2;
  b: Vec2;
  startArcM: number;
  endArcM: number;
  classId: string;
  widthM: number;
  // WHY: Surface consumers need full width while bounds and validation need half width.
  clearanceWidthM: number;
  clearanceM: number;
  vehicle: boolean;
}

export interface CompiledStraightSegment extends CompiledSpan {
  index: number;
  lengthM: number;
}

export interface CompiledRoute {
  id: string;
  curvePreset: RoadCurvePreset;
  points: Vec2[];
  pointNodeIds: (string | null)[];
  spans: CompiledSpan[];
}

export interface CompiledJunctionArm {
  edgeId: string;
  routeId: string;
  nodeId: string;
  direction: Vec2;
  widthM: number;
  clearanceM: number;
}

export interface CompiledJunction {
  id: string;
  point: Vec2;
  arms: CompiledJunctionArm[];
}

export interface CompiledRouteNetwork {
  routes: CompiledRoute[];
  spans: CompiledSpan[];
  segments: CompiledStraightSegment[];
  junctions: CompiledJunction[];
  maxClearanceM: number;
}

interface PathEdge {
  edge: RoadEdgeSource;
  from: RoadNodeSource;
  to: RoadNodeSource;
}

interface Path {
  edges: PathEdge[];
  nodes: RoadNodeSource[];
}

const presetFactor: Record<RoadCurvePreset, number> = { tight: 0.2, standard: 0.3, broad: 0.4 };

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

const direction = (from: Vec2, to: Vec2): Vec2 => {
  const length = dist(from, to);
  if (length <= TOPOLOGY_EPSILON_M) return { x: 0, y: 0 };
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
};

const lexPathKey = (path: Path): string => `${path.nodes[0]?.id ?? ""}\0${path.edges[0]?.edge.id ?? ""}`;

function appendQuadratic(points: Vec2[], controls: [Vec2, Vec2, Vec2], edgeIds: string[], edgeId: string): void {
  const [a, c, b] = controls;
  const chord = dist(a, b);
  const controlDistance = Math.abs((c.x - (a.x + b.x) / 2) * (b.y - a.y) - (c.y - (a.y + b.y) / 2) * (b.x - a.x)) / Math.max(chord, TOPOLOGY_EPSILON_M);
  const count = Math.max(2, Math.ceil(Math.sqrt(Math.max(controlDistance, 0) / CURVE_CHORD_TOLERANCE_M)) * 2);
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const mt = 1 - t;
    points.push({ x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y });
    edgeIds.push(edgeId);
  }
}

function pathForComponent(routeEdges: RoadEdgeSource[], nodes: Map<string, RoadNodeSource>): Path[] {
  const byNode = new Map<string, RoadEdgeSource[]>();
  const add = (id: string, edge: RoadEdgeSource): void => {
    const list = byNode.get(id) ?? [];
    list.push(edge);
    byNode.set(id, list);
  };
  for (const edge of routeEdges) {
    add(edge.a, edge);
    add(edge.b, edge);
  }
  for (const list of byNode.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const used = new Set<string>();
  const paths: Path[] = [];
  const starts = [...byNode.keys()].sort((a, b) => a.localeCompare(b)).filter((id) => (byNode.get(id)?.length ?? 0) !== 2);
  const walk = (start: string, first: RoadEdgeSource): Path => {
    const pathEdges: PathEdge[] = [];
    const pathNodes: RoadNodeSource[] = [];
    let current = start;
    let edge = first;
    while (!used.has(edge.id)) {
      used.add(edge.id);
      const from = nodes.get(current);
      const nextId = edge.a === current ? edge.b : edge.a;
      const to = nodes.get(nextId);
      if (!from || !to) break;
      if (pathNodes.length === 0) pathNodes.push(from);
      pathEdges.push({ edge, from, to });
      pathNodes.push(to);
      current = nextId;
      const next = (byNode.get(current) ?? []).find((candidate) => !used.has(candidate.id));
      if (!next || (byNode.get(current)?.length ?? 0) !== 2) break;
      edge = next;
    }
    return { edges: pathEdges, nodes: pathNodes };
  };
  for (const start of starts) for (const edge of byNode.get(start) ?? []) if (!used.has(edge.id)) paths.push(walk(start, edge));
  for (const edge of [...routeEdges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (used.has(edge.id)) continue;
    const firstNode = (edge.a.localeCompare(edge.b) <= 0 ? edge.a : edge.b);
    paths.push(walk(firstNode, edge));
  }
  return paths.sort((a, b) => lexPathKey(a).localeCompare(lexPathKey(b)));
}

function compilePath(path: Path, route: RoadRouteSource, classes: ReadonlyMap<string, RouteClassDefinition>, smoothableNodes: ReadonlySet<string>): CompiledRoute {
  const points: Vec2[] = [];
  const pointNodeIds: (string | null)[] = [];
  const pointEdgeIds: string[] = [];
  const spans: CompiledSpan[] = [];
  const factor = presetFactor[route.curvePreset];
  const arc: number[] = [0];
  for (let i = 1; i < path.nodes.length; i++) arc.push(arc[i - 1]! + dist(path.nodes[i - 1]!, path.nodes[i]!));

  const pushPoint = (point: Vec2, nodeId: string | null, edgeId: string): void => {
    const previous = points[points.length - 1];
    if (previous && dist(previous, point) <= TOPOLOGY_EPSILON_M) return;
    points.push({ x: point.x, y: point.y });
    pointNodeIds.push(nodeId);
    pointEdgeIds.push(edgeId);
  };
  pushPoint(path.nodes[0]!, path.nodes[0]!.id, path.edges[0]!.edge.id);
  for (let i = 1; i < path.nodes.length; i++) {
    const node = path.nodes[i]!;
    const prev = path.nodes[i - 1]!;
    const edge = path.edges[i - 1]!.edge;
    const currentClass = classes.get(edge.classId);
    if (!currentClass) continue;
    if (i < path.nodes.length - 1) {
      const next = path.nodes[i + 1]!;
      const nextEdge = path.edges[i]!.edge;
      const nextClass = classes.get(nextEdge.classId);
      // WHY: Smoothing class transitions or branches would move an explicit junction arm.
      if (!smoothableNodes.has(node.id) || nextEdge.routeId !== edge.routeId || !nextClass || nextClass.id !== currentClass.id || (path.nodes.filter((candidate) => candidate.id === node.id).length !== 1)) {
        pushPoint(node, node.id, edge.id);
        continue;
      }
      const incoming = dist(prev, node);
      const outgoing = dist(node, next);
      const offset = Math.min(incoming * factor, outgoing * factor, incoming * 0.49, outgoing * 0.49);
      if (offset <= TOPOLOGY_EPSILON_M) {
        pushPoint(node, node.id, edge.id);
        continue;
      }
      const entry = { x: node.x + ((prev.x - node.x) / incoming) * offset, y: node.y + ((prev.y - node.y) / incoming) * offset };
      const exit = { x: node.x + ((next.x - node.x) / outgoing) * offset, y: node.y + ((next.y - node.y) / outgoing) * offset };
      pushPoint(entry, null, edge.id);
      appendQuadratic(points, [entry, node, exit], pointEdgeIds, edge.id);
      pointNodeIds[pointNodeIds.length - 1] = null;
      pointEdgeIds[pointEdgeIds.length - 1] = nextEdge.id;
      continue;
    }
    pushPoint(node, node.id, edge.id);
  }

  let arcM = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const length = dist(a, b);
    if (length <= TOPOLOGY_EPSILON_M) continue;
    const sourceEdge = path.edges.find((candidate) => candidate.edge.id === pointEdgeIds[i]) ?? path.edges[Math.min(path.edges.length - 1, Math.max(0, i))]!;
    const prevNode = pointNodeIds[i] ?? path.nodes[Math.min(path.nodes.length - 1, Math.max(0, i - 1))]?.id ?? sourceEdge.edge.a;
    const nextNode = pointNodeIds[i + 1] ?? path.nodes[Math.min(path.nodes.length - 1, i + 1)]?.id ?? sourceEdge.edge.b;
    const sourceClass = classes.get(sourceEdge.edge.classId)!;
    const span: CompiledSpan = {
      id: `${sourceEdge.edge.id}:${i}`,
      routeId: route.id,
      edgeId: sourceEdge.edge.id,
      aNodeId: prevNode,
      bNodeId: nextNode,
      a: { ...a },
      b: { ...b },
      startArcM: arcM,
      endArcM: arcM + length,
      classId: sourceClass.id,
      widthM: sourceClass.widthM,
      clearanceWidthM: sourceClass.widthM + sourceClass.sidewalkM * 2,
      clearanceM: sourceClass.widthM / 2 + sourceClass.sidewalkM,
      vehicle: sourceClass.vehicle
    };
    spans.push(span);
    arcM += length;
  }
  return { id: route.id, curvePreset: route.curvePreset, points, pointNodeIds, spans };
}

function buildJunctions(source: RoadSource, classes: ReadonlyMap<string, RouteClassDefinition>): CompiledJunction[] {
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const incident = new Map<string, RoadEdgeSource[]>();
  for (const edge of source.edges) {
    for (const id of [edge.a, edge.b]) {
      const list = incident.get(id) ?? [];
      list.push(edge);
      incident.set(id, list);
    }
  }
  const byNode = new Map<string, CompiledJunctionArm[]>();
  for (const edge of source.edges) {
    const classDef = classes.get(edge.classId);
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    if (!classDef || !a || !b) continue;
    const addArm = (nodeId: string, other: RoadNodeSource): void => {
      const node = nodes.get(nodeId);
      if (!node) return;
      const list = byNode.get(nodeId) ?? [];
      list.push({ edgeId: edge.id, routeId: edge.routeId, nodeId: other.id, direction: direction(node, other), widthM: classDef.widthM, clearanceM: classDef.widthM / 2 + classDef.sidewalkM });
      byNode.set(nodeId, list);
    };
    addArm(edge.a, b);
    addArm(edge.b, a);
  }
  const result: CompiledJunction[] = [];
  for (const [id, arms] of [...byNode.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sourceEdges = incident.get(id) ?? [];
    const routeSet = new Set(sourceEdges.map((edge) => edge.routeId));
    if (sourceEdges.length <= 1 || (sourceEdges.length === 2 && routeSet.size === 1)) continue;
    const node = nodes.get(id)!;
    const deduped = [...new Map(arms.map((arm) => [`${arm.edgeId}:${arm.nodeId}`, arm])).values()].sort((a, b) => `${a.edgeId}:${a.nodeId}`.localeCompare(`${b.edgeId}:${b.nodeId}`));
    result.push({ id, point: { x: node.x, y: node.y }, arms: deduped });
  }
  return result;
}

export function compileRouteNetwork(source: RoadSource, classes: ReadonlyMap<string, RouteClassDefinition> = ROUTE_CLASS_REGISTRY): CompiledRouteNetwork {
  const nodes = new Map([...source.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((node) => [node.id, node]));
  const incident = new Map<string, RoadEdgeSource[]>();
  for (const edge of source.edges) for (const id of [edge.a, edge.b]) incident.set(id, [...(incident.get(id) ?? []), edge]);
  const smoothableNodes = new Set<string>();
  for (const [id, edges] of incident) if (edges.length === 2 && edges[0]!.routeId === edges[1]!.routeId && edges[0]!.classId === edges[1]!.classId) smoothableNodes.add(id);
  const routeSources = [...source.routes].sort((a, b) => a.id.localeCompare(b.id));
  const routes: CompiledRoute[] = [];
  for (const route of routeSources) {
    const edges = source.edges.filter((edge) => edge.routeId === route.id).sort((a, b) => a.id.localeCompare(b.id));
    for (const path of pathForComponent(edges, nodes)) routes.push(compilePath(path, route, classes, smoothableNodes));
  }
  const spans = routes.flatMap((route) => route.spans).sort((a, b) => a.id.localeCompare(b.id));
  const segments = compileStraightSegments({ routes, spans, segments: [], junctions: [], maxClearanceM: 0 });
  const maxClearanceM = spans.reduce((max, span) => Math.max(max, span.clearanceM), 0);
  return { routes, spans, segments, junctions: buildJunctions(source, classes), maxClearanceM };
}

export function compileStraightSegments(network: CompiledRouteNetwork): CompiledStraightSegment[] {
  return network.routes.flatMap((route) => route.spans.map((span, index) => ({ ...span, id: `${span.edgeId}:${index}`, index, lengthM: dist(span.a, span.b) }))).sort((a, b) => a.id.localeCompare(b.id));
}

export function routeClassForSpan(span: CompiledSpan, classes: ReadonlyMap<string, RouteClassDefinition> = ROUTE_CLASS_REGISTRY): RouteClassDefinition | undefined {
  return classes.get(span.classId);
}
