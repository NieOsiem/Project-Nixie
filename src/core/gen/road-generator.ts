import { hash2 } from "./hash.js";
import { allocateGeneratedId, ROUTE_CLASS_REGISTRY, type HubMode, type RoadLayout, type RoadSource, type RouteClassId } from "./city.js";
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

const EPS = 0.001;

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

function segmentInside(ring: Ring, a: Vec2, b: Vec2, clearanceM: number): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const count = Math.max(2, Math.ceil(length / 5));
  const nx = length > EPS ? (-(b.y - a.y) / length) * clearanceM : 0;
  const ny = length > EPS ? ((b.x - a.x) / length) * clearanceM : 0;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const centre = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (!pointInRing(centre, ring) || !pointInRing({ x: centre.x + nx, y: centre.y + ny }, ring) || !pointInRing({ x: centre.x - nx, y: centre.y - ny }, ring)) return false;
  }
  return true;
}

function generationSegmentInside(mask: Ring, land: Ring, a: Vec2, b: Vec2, clearanceM: number, sceneBounds?: Rect, allowSceneEdge = false): boolean {
  if (!allowSceneEdge && (!segmentInside(mask, a, b, clearanceM) || !segmentInside(land, a, b, clearanceM))) return false;
  const clippedScene = allowSceneEdge ? sceneBounds : undefined;
  return shapeInsideMasks(edgeQuad(a, b, clearanceM), mask, land, clippedScene) &&
    shapeInsideMasks(nodeDisc(a, clearanceM), mask, land, clippedScene) &&
    shapeInsideMasks(nodeDisc(b, clearanceM), mask, land, clippedScene);
}

function polygonArea(multi: ReturnType<typeof ringAsMulti>): number {
  return multi.reduce(
    (total, polygon) => total + polygon.reduce((area, ring, index) => area + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0),
    0
  );
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

function shapeInsideMasks(shape: Ring, mask: Ring, land: Ring, sceneBounds?: Rect): boolean {
  if (shape.length < 3) return true;
  const clipped = clippedShape(shape, sceneBounds);
  if (clipped.length === 0) return true;
  const maskMulti = ringAsMulti(mask);
  const landMulti = ringAsMulti(land);
  return polygonArea(difference(clipped, [maskMulti])) <= 1e-6 && polygonArea(difference(clipped, [landMulti])) <= 1e-6;
}

function corridorsInsideMask(source: RoadSource, mask: Ring, sceneBounds: Rect): boolean {
  const network = compileRouteNetwork(source);
  for (const span of network.segments) {
    const corridor = edgeQuad(span.a, span.b, span.clearanceM);
    if (corridor.length >= 3 && !shapeInsideMasks(corridor, mask, mask, sceneBounds)) return false;
    for (const point of [span.a, span.b]) {
      const disc = nodeDisc(point, span.clearanceM);
      if (disc.length < 3) continue;
      if (!shapeInsideMasks(disc, mask, mask, sceneBounds)) return false;
    }
  }
  return true;
}

function centroid(ring: Ring): Vec2 {
  let signed = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = a.x * b.y - b.x * a.y;
    signed += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  if (Math.abs(signed) <= EPS) {
    const box = bounds(ring);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  return { x: x / (3 * signed), y: y / (3 * signed) };
}

function interiorPoint(mask: Ring, land: Ring, seed: number, index: number, clearanceM: number): Vec2 {
  const box = bounds(mask);
  const centre = centroid(mask);
  // WHY: Reusing the centroid for later hubs would make multiple-hubs silently single-centre.
  if (index === 0 && pointInRing(centre, mask) && shapeInsideMasks(nodeDisc(centre, clearanceM), mask, land)) return centre;
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = box.x + hash2(index * 29 + attempt, 7, seed) * box.width;
    const y = box.y + hash2(index * 31 + attempt, 11, seed) * box.height;
    const point = { x, y };
    if (pointInRing(point, mask) && shapeInsideMasks(nodeDisc(point, clearanceM), mask, land)) return point;
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function addNode(nodes: Map<string, Vec2>, point: Vec2, seed: string, role: string): string {
  for (const [id, existing] of nodes) if (Math.hypot(existing.x - point.x, existing.y - point.y) <= EPS) return id;
  const id = allocateGeneratedId("node", seed, role, nodes.size, new Set(nodes.keys()));
  nodes.set(id, { x: point.x, y: point.y });
  return id;
}

interface DraftEdge { a: string; b: string; routeId: string; classId: RouteClassId; name: string | null; }

function properIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number; point: Vec2 } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= EPS) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return { t, u, point: { x: a.x + rx * t, y: a.y + ry * t } };
}

function planarize(nodes: Map<string, Vec2>, edges: DraftEdge[], seed: string): DraftEdge[] {
  const nodeIdAt = (point: Vec2): string => addNode(nodes, point, seed, "crossing");
  const byId = (): Map<string, Vec2> => nodes;
  const splits = new Map<number, { t: number; nodeId: string }[]>();
  for (let i = 0; i < edges.length; i++) {
    const left = edges[i]!;
    const a = byId().get(left.a);
    const b = byId().get(left.b);
    if (!a || !b) continue;
    for (let j = i + 1; j < edges.length; j++) {
      const right = edges[j]!;
      if (left.a === right.a || left.a === right.b || left.b === right.a || left.b === right.b) continue;
      const c = byId().get(right.a);
      const d = byId().get(right.b);
      if (!c || !d) continue;
      const hit = properIntersection(a, b, c, d);
      if (!hit) continue;
      const nodeId = nodeIdAt(hit.point);
      const l = splits.get(i) ?? [];
      l.push({ t: hit.t, nodeId });
      splits.set(i, l);
      const r = splits.get(j) ?? [];
      r.push({ t: hit.u, nodeId });
      splits.set(j, r);
    }
  }
  if (splits.size === 0) return edges;
  const out: DraftEdge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const points = [{ t: 0, nodeId: edge.a }, ...(splits.get(i) ?? []), { t: 1, nodeId: edge.b }].sort((a, b) => a.t - b.t);
    for (let part = 0; part + 1 < points.length; part++) {
      const a = points[part]!.nodeId;
      const b = points[part + 1]!.nodeId;
      if (a !== b) out.push({ ...edge, a, b });
    }
  }
  return out;
}

function collinearOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const crossD = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  if (Math.abs(cross) > EPS || Math.abs(crossD) > EPS) return false;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= EPS) return true;
  const t0 = ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (length * length);
  const t1 = ((d.x - a.x) * (b.x - a.x) + (d.y - a.y) * (b.y - a.y)) / (length * length);
  return Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > EPS;
}

function discardGeneratedOverlaps(nodes: Map<string, Vec2>, edges: DraftEdge[]): DraftEdge[] {
  const keep: DraftEdge[] = [];
  const discardedRoutes = new Set<string>();
  for (const edge of edges) {
    if (discardedRoutes.has(edge.routeId)) continue;
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    if (!a || !b) continue;
    const duplicate = keep.some((other) => {
      const c = nodes.get(other.a);
      const d = nodes.get(other.b);
      if (!c || !d) return false;
      if (collinearOverlap(a, b, c, d)) return true;
      if (edge.a === other.a || edge.a === other.b || edge.b === other.a || edge.b === other.b) return false;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const length = Math.hypot(vx, vy);
      const rvx = d.x - c.x;
      const rvy = d.y - c.y;
      const rightLength = Math.hypot(rvx, rvy);
      if (length <= EPS || rightLength <= EPS || Math.abs(vx * rvy - vy * rvx) / (length * rightLength) > 0.1) return false;
      const leftClearance = (ROUTE_CLASS_REGISTRY.get(edge.classId)?.widthM ?? 0) / 2 + (ROUTE_CLASS_REGISTRY.get(edge.classId)?.sidewalkM ?? 0);
      const rightClearance = (ROUTE_CLASS_REGISTRY.get(other.classId)?.widthM ?? 0) / 2 + (ROUTE_CLASS_REGISTRY.get(other.classId)?.sidewalkM ?? 0);
      const separation = Math.abs(vx * (c.y - a.y) - vy * (c.x - a.x)) / length;
      if (separation >= leftClearance + rightClearance - EPS) return false;
      const t0 = ((c.x - a.x) * vx + (c.y - a.y) * vy) / (length * length);
      const t1 = ((d.x - a.x) * vx + (d.y - a.y) * vy) / (length * length);
      return Math.min(1, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > EPS;
    });
    if (!duplicate) keep.push(edge);
    else discardedRoutes.add(edge.routeId);
  }
  return keep.filter((edge) => !discardedRoutes.has(edge.routeId));
}

function cleanupGeneratedTopology(roads: RoadSource, cleanupSeed: number, protectedNodeIds: ReadonlySet<string> = new Set()): RoadSource {
  let current = roads;
  for (let attempt = 0; attempt < roads.edges.length; attempt++) {
    const validation = validateRouteTopology(current, compileRouteNetwork(current));
    if (validation.ok) return current;
    const edgeIds = new Set<string>();
    for (const problem of validation.problems) {
      for (const match of problem.matchAll(/(?:spans|corridors) "([^"]+)"/g)) {
        const spanId = match[1]!;
        edgeIds.add(spanId.includes(":") ? spanId.slice(0, spanId.indexOf(":")) : spanId);
      }
      const duplicate = problem.match(/Duplicate corridor between nodes "([^"]+)" and "([^"]+)"/);
      if (duplicate) {
        for (const edge of current.edges) {
          if ((edge.a === duplicate[1] && edge.b === duplicate[2]) || (edge.a === duplicate[2] && edge.b === duplicate[1])) edgeIds.add(edge.id);
        }
      }
    }
    const candidateRoutes = [...new Set([...edgeIds]
      .map((id) => current.edges.find((edge) => edge.id === id)?.routeId)
      .filter((id): id is string => id !== undefined))];
    const removableRoutes = candidateRoutes.filter((routeId) => !current.edges.some((edge) => edge.routeId === routeId && (protectedNodeIds.has(edge.a) || protectedNodeIds.has(edge.b))));
    const removeRoute = (removableRoutes.length > 0 ? removableRoutes : candidateRoutes)
      .sort((a, b) => {
        const rankA = deriveLabelledSeed(`${cleanupSeed}\0${a}`, "roads/cleanup");
        const rankB = deriveLabelledSeed(`${cleanupSeed}\0${b}`, "roads/cleanup");
        return rankA - rankB || a.localeCompare(b);
      })
      .at(-1) ?? current.edges.at(-1)?.routeId;
    if (!removeRoute) break;
    const edges = current.edges.filter((edge) => edge.routeId !== removeRoute);
    const usedNodes = new Set(edges.flatMap((edge) => [edge.a, edge.b]));
    const usedRoutes = new Set(edges.map((edge) => edge.routeId));
    current = { nodes: current.nodes.filter((node) => usedNodes.has(node.id)), routes: current.routes.filter((route) => usedRoutes.has(route.id)), edges };
  }
  return current;
}

function majorVehicleComponents(source: RoadSource): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const edge of source.edges) {
    if (!ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) continue;
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edge.b]);
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edge.a]);
  }
  const components = new Map<string, number>();
  let next = 0;
  for (const start of [...adjacency.keys()].sort((a, b) => a.localeCompare(b))) {
    if (components.has(start)) continue;
    const queue = [start];
    components.set(start, next);
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const neighbour of [...(adjacency.get(node) ?? [])].sort((a, b) => a.localeCompare(b))) {
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
  const vehicleNodeIds = new Set(source.edges
    .filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle)
    .flatMap((edge) => [edge.a, edge.b]));
  let best: { id: string; distance: number } | undefined;
  for (const node of source.nodes) {
    if (!vehicleNodeIds.has(node.id)) continue;
    const distance = Math.hypot(node.x - point.x, node.y - point.y);
    if (best === undefined || distance < best.distance || distance === best.distance && node.id.localeCompare(best.id) < 0) {
      best = { id: node.id, distance };
    }
  }
  return best?.id;
}

function pruneDisconnectedVehicleComponents(source: RoadSource, rootPoint: Vec2): RoadSource {
  const rootId = nearestVehicleNodeId(source, rootPoint);
  if (!rootId) return source;
  const components = majorVehicleComponents(source);
  const rootComponent = components.get(rootId);
  if (rootComponent === undefined) return source;
  const edges = source.edges.filter((edge) => {
    if (!ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle) return true;
    return components.get(edge.a) === rootComponent && components.get(edge.b) === rootComponent;
  });
  if (edges.length === source.edges.length) return source;
  const usedNodes = new Set(edges.flatMap((edge) => [edge.a, edge.b]));
  const usedRoutes = new Set(edges.map((edge) => edge.routeId));
  return {
    nodes: source.nodes.filter((node) => usedNodes.has(node.id)),
    routes: source.routes.filter((route) => usedRoutes.has(route.id)),
    edges
  };
}

function exactNodeId(source: RoadSource, point: Vec2): string | undefined {
  return source.nodes.find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= EPS)?.id;
}

function requireMajorConnectivity(source: RoadSource, hubs: readonly Vec2[], entrances: readonly Vec2[]): void {
  const components = majorVehicleComponents(source);
  const hubComponents = hubs.map((point) => {
    const nodeId = exactNodeId(source, point);
    return nodeId === undefined ? undefined : components.get(nodeId);
  });
  const entranceComponents = entrances
    .map((point) => {
      const nodeId = exactNodeId(source, point);
      return nodeId === undefined ? undefined : components.get(nodeId);
    })
    .filter((component): component is number => component !== undefined);
  const targetComponents = [...hubComponents, ...entranceComponents];
  if (targetComponents.length === 0) return;
  if (hubComponents.some((component) => component === undefined) || new Set(targetComponents).size !== 1) {
    throw new Error("Generated major vehicle skeleton is disconnected.");
  }
}

function addPath(nodes: Map<string, Vec2>, edges: DraftEdge[], routes: Map<string, { curvePreset: "tight" | "standard" | "broad" }>, points: Vec2[], seed: string, role: string, classId: RouteClassId, curvePreset: "tight" | "standard" | "broad" = "standard"): string | undefined {
  if (points.length < 2) return undefined;
  const routeId = allocateGeneratedId("route", seed, role, routes.size, new Set(routes.keys()));
  routes.set(routeId, { curvePreset });
  const ids = points.map((point) => addNode(nodes, point, seed, `${role}/node`));
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = ids[i]!;
    const b = ids[i + 1]!;
    if (a === b || edges.some((edge) => edge.a === a && edge.b === b || edge.a === b && edge.b === a)) continue;
    edges.push({ a, b, routeId, classId, name: null });
  }
  return routeId;
}

interface SkeletonEndpoint {
  point: Vec2;
  hubIndex: number;
}

function tryAddPath(
  nodes: Map<string, Vec2>,
  edges: DraftEdge[],
  routes: Map<string, { curvePreset: "tight" | "standard" | "broad" }>,
  points: Vec2[],
  mask: Ring,
  land: Ring,
  clearanceM: number,
  seed: string,
  role: string,
  classId: RouteClassId,
  curvePreset: "tight" | "standard" | "broad",
  sceneBounds?: Rect
): boolean {
  if (points.length < 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  if (points.some((point, index) => index > 0 && Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y) <= EPS)) return false;
  for (let i = 0; i + 1 < points.length; i++) {
    if (!generationSegmentInside(mask, land, points[i]!, points[i + 1]!, clearanceM)) return false;
  }
  const edgeCount = edges.length;
  const routeId = addPath(nodes, edges, routes, points, seed, role, classId, curvePreset);
  if (routeId === undefined || edges.length === edgeCount) {
    if (routeId !== undefined) routes.delete(routeId);
    return false;
  }
  // WHY: A quadratic curve can leave a concave mask even when its source chords fit; reject that candidate before it contaminates the graph.
  const candidateEdges = edges.slice(edgeCount).map((edge, index) => ({ id: `draft-${edgeCount + index}`, ...edge, locked: false, origin: "generated" as const }));
  const candidateNodes = new Set(candidateEdges.flatMap((edge) => [edge.a, edge.b]));
  const candidateRouteIds = new Set(candidateEdges.map((edge) => edge.routeId));
  const candidatePath: RoadSource = {
    nodes: [...nodes.entries()].filter(([id]) => candidateNodes.has(id)).map(([id, point]) => ({ id, ...point })),
    routes: [...routes.entries()].filter(([id]) => candidateRouteIds.has(id)).map(([id, route]) => ({ id, ...route })),
    edges: candidateEdges
  };
  if (!corridorsInsideMask(candidatePath, mask, sceneBounds ?? bounds(mask))) {
    for (let i = edges.length - 1; i >= edgeCount; i--) edges.splice(i, 1);
    routes.delete(routeId);
    return false;
  }
  return true;
}

function nearestBoundaryPoints(mask: Ring, box: Rect): Vec2[] {
  const points: Vec2[] = [];
  const candidates = [
    { x: box.x + box.width / 2, y: box.y },
    { x: box.x + box.width, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height },
    { x: box.x, y: box.y + box.height / 2 }
  ];
  for (const candidate of candidates) if (pointInRing(candidate, mask)) points.push(candidate);
  return points;
}

function addIrregularSkeleton(
  nodes: Map<string, Vec2>,
  edges: DraftEdge[],
  routes: Map<string, { curvePreset: "tight" | "standard" | "broad" }>,
  hubs: readonly Vec2[],
  mask: Ring,
  land: Ring,
  box: Rect,
  seed: number,
  idSeed: string,
  sceneBounds?: Rect,
  radiusScale = 1,
  withBends = true
): SkeletonEndpoint[] {
  const endpoints: SkeletonEndpoint[] = [];
  const radius = Math.min(box.width, box.height) * radiusScale;
  const armsPerHub = hubs.length === 1 ? 4 : 2;
  for (let hubIndex = 0; hubIndex < hubs.length; hubIndex++) {
    const hub = hubs[hubIndex]!;
    for (let arm = 0; arm < armsPerHub; arm++) {
      const baseAngle = hash2(hubIndex * 17 + arm, 13, seed) * Math.PI * 2;
      const classId: RouteClassId = arm === 0 ? "arterial" : "street";
      const classDef = ROUTE_CLASS_REGISTRY.get(classId)!;
      let added = false;
      for (let attempt = 0; attempt < 10 && !added; attempt++) {
        const angle = baseAngle + attempt * 0.47;
        const length = radius * (0.22 + hash2(hubIndex * 31 + arm * 7 + attempt, 23, seed) * 0.14);
        const direction = { x: Math.cos(angle), y: Math.sin(angle) };
        const normal = { x: -direction.y, y: direction.x };
        const endpoint = { x: hub.x + direction.x * length, y: hub.y + direction.y * length };
        const bendDistance = length * (0.45 + hash2(hubIndex * 37 + arm * 11 + attempt, 29, seed) * 0.15);
        const bendOffset = radius * (0.035 + hash2(hubIndex * 41 + arm * 13 + attempt, 31, seed) * 0.035);
        const bend = {
          x: hub.x + direction.x * bendDistance + normal.x * bendOffset,
          y: hub.y + direction.y * bendDistance + normal.y * bendOffset
        };
        const bendCandidate = withBends && (mask.length === 4 || hubIndex === 0 && arm === 0);
        if (bendCandidate) {
          added = tryAddPath(
            nodes,
            edges,
            routes,
            [hub, bend, endpoint],
            mask,
            land,
            classDef.widthM / 2 + classDef.sidewalkM,
            idSeed,
            `skeleton/${hubIndex}/${arm}`,
            classId,
            arm === 0 ? "broad" : "standard",
            sceneBounds
          );
        }
        if (!added) {
          added = tryAddPath(
            nodes,
            edges,
            routes,
            [hub, endpoint],
            mask,
            land,
            classDef.widthM / 2 + classDef.sidewalkM,
            idSeed,
            `skeleton/${hubIndex}/${arm}`,
            classId,
            arm === 0 ? "broad" : "standard",
            sceneBounds
          );
        }
        if (added) endpoints.push({ point: endpoint, hubIndex });
      }
    }
  }

  for (let hubIndex = 0; hubIndex < hubs.length; hubIndex++) {
    const hub = hubs[hubIndex]!;
    const local = endpoints
      .filter((endpoint) => endpoint.hubIndex === hubIndex)
      .sort((a, b) => Math.atan2(a.point.y - hub.y, a.point.x - hub.x) - Math.atan2(b.point.y - hub.y, b.point.x - hub.x));
    if (local.length < 2) continue;
    for (let i = 0; i < local.length; i++) {
      const left = local[i]!;
      const right = local[(i + 1) % local.length]!;
      const midpoint = { x: (left.point.x + right.point.x) / 2, y: (left.point.y + right.point.y) / 2 };
      const normal = { x: -(right.point.y - left.point.y), y: right.point.x - left.point.x };
      const normalLength = Math.hypot(normal.x, normal.y);
      const offset = normalLength > EPS ? radius * 0.04 / normalLength : 0;
      const bend = { x: midpoint.x + normal.x * offset, y: midpoint.y + normal.y * offset };
      const added = withBends && mask.length === 4 && tryAddPath(
        nodes,
        edges,
        routes,
        [left.point, bend, right.point],
        mask,
        land,
        ROUTE_CLASS_REGISTRY.get("street")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("street")!.sidewalkM,
        idSeed,
        `skeleton/${hubIndex}/connector/${i}`,
        "street",
        "standard",
        sceneBounds
      );
      if (!added) {
        tryAddPath(
          nodes,
          edges,
          routes,
          [left.point, right.point],
          mask,
          land,
          ROUTE_CLASS_REGISTRY.get("street")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("street")!.sidewalkM,
          idSeed,
          `skeleton/${hubIndex}/connector/${i}`,
          "street",
          "standard",
          sceneBounds
        );
      }
    }
  }
  return endpoints;
}

function addIrregularLocalRoutes(
  nodes: Map<string, Vec2>,
  edges: DraftEdge[],
  routes: Map<string, { curvePreset: "tight" | "standard" | "broad" }>,
  hubs: readonly Vec2[],
  skeleton: readonly SkeletonEndpoint[],
  mask: Ring,
  land: Ring,
  box: Rect,
  seed: number,
  idSeed: string,
  layout: RoadLayout,
  withBends: boolean,
  sceneBounds?: Rect
): void {
  const anchors = skeleton.length > 0 ? skeleton : hubs.map((point, hubIndex) => ({ point, hubIndex }));
  const radius = Math.min(box.width, box.height) * (layout === "mixed" ? 0.4 : 1);
  const count = layout === "mixed" ? 7 : 11;
  for (let i = 0; i < count; i++) {
    const anchor = anchors[i % anchors.length]!;
    const angle = hash2(i, 43, seed) * Math.PI * 2;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const normal = { x: -direction.y, y: direction.x };
    const length = radius * (0.10 + hash2(i, 47, seed) * 0.10);
    const endpoint = { x: anchor.point.x + direction.x * length, y: anchor.point.y + direction.y * length };
    const bend = {
      x: anchor.point.x + direction.x * length * 0.48 + normal.x * radius * (0.025 + hash2(i, 53, seed) * 0.025),
      y: anchor.point.y + direction.y * length * 0.48 + normal.y * radius * (0.025 + hash2(i, 53, seed) * 0.025)
    };
    const classId: RouteClassId = i % 5 === 0 ? "alley" : i % 3 === 0 ? "lane" : i % 2 === 0 ? "narrow" : "street";
    const classDef = ROUTE_CLASS_REGISTRY.get(classId)!;
    const bendCandidate = withBends && (mask.length === 4 || i === 0);
    const added = bendCandidate && tryAddPath(
      nodes,
      edges,
      routes,
      [anchor.point, bend, endpoint],
      mask,
      land,
      classDef.widthM / 2 + classDef.sidewalkM,
      idSeed,
      `local/${i}`,
      classId,
      i % 2 === 0 ? "tight" : "standard",
      sceneBounds
    );
    if (!added) {
      tryAddPath(
        nodes,
        edges,
        routes,
        [anchor.point, endpoint],
        mask,
        land,
        classDef.widthM / 2 + classDef.sidewalkM,
        idSeed,
        `local/${i}`,
        classId,
        i % 2 === 0 ? "tight" : "standard",
        sceneBounds
      );
    }
  }
}

export function generateInitialRoadNetwork(input: RoadGenerationInput): GeneratedRoadNetwork {
  if (!input.mask.length) throw new Error("Road generation requires a non-empty mask.");
  const layout = input.layout ?? "european";
  const hubMode = input.hubMode ?? "single-centre";
  const land = input.land ?? input.mask;
  const majorSeed = deriveLabelledSeed(input.citySeed, "roads/major");
  const localSeed = deriveLabelledSeed(input.citySeed, "roads/local");
  const routesSeed = deriveLabelledSeed(input.citySeed, "roads/routes");
  const cleanupSeed = deriveLabelledSeed(input.citySeed, "roads/cleanup");
  const majorIdSeed = `${input.citySeed}\0roads/major`;
  const localIdSeed = `${input.citySeed}\0roads/local`;
  const routesIdSeed = `${input.citySeed}\0roads/routes`;
  const box = bounds(input.mask);
  const nodes = new Map<string, Vec2>();
  const routes = new Map<string, { curvePreset: "tight" | "standard" | "broad" }>();
  const draft: DraftEdge[] = [];
  const acceptedEntrances: Vec2[] = [];
  const hubClearance = ROUTE_CLASS_REGISTRY.get("arterial")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("arterial")!.sidewalkM;
  const hubs: Vec2[] = [interiorPoint(input.mask, land, majorSeed, 0, hubClearance)];
  if (hubMode === "multiple-hubs") {
    for (let i = 1; i < 4; i++) {
      const candidate = interiorPoint(input.mask, land, majorSeed, i, hubClearance);
      if (!hubs.every((hub) => Math.hypot(hub.x - candidate.x, hub.y - candidate.y) > Math.min(box.width, box.height) * 0.2)) continue;
      const anchor = hubs[0]!;
      const bend = { x: (anchor.x + candidate.x) / 2 + (hash2(i, 3, majorSeed) - 0.5) * box.width * 0.12, y: (anchor.y + candidate.y) / 2 + (hash2(i, 5, majorSeed) - 0.5) * box.height * 0.12 };
      const canConnect = generationSegmentInside(input.mask, land, anchor, candidate, hubClearance) ||
        (generationSegmentInside(input.mask, land, anchor, bend, hubClearance) && generationSegmentInside(input.mask, land, bend, candidate, hubClearance));
      if (canConnect) hubs.push(candidate);
    }
  }

  for (let i = 1; i < hubs.length; i++) {
    const a = hubs[0]!;
    const b = hubs[i]!;
    const bend = { x: (a.x + b.x) / 2 + (hash2(i, 3, majorSeed) - 0.5) * box.width * 0.12, y: (a.y + b.y) / 2 + (hash2(i, 5, majorSeed) - 0.5) * box.height * 0.12 };
    if (generationSegmentInside(input.mask, land, a, bend, ROUTE_CLASS_REGISTRY.get("arterial")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("arterial")!.sidewalkM) && generationSegmentInside(input.mask, land, bend, b, ROUTE_CLASS_REGISTRY.get("arterial")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("arterial")!.sidewalkM)) addPath(nodes, draft, routes, [a, bend, b], majorIdSeed, `major/${i}`, "arterial", "broad");
    else if (generationSegmentInside(input.mask, land, a, b, ROUTE_CLASS_REGISTRY.get("arterial")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("arterial")!.sidewalkM)) addPath(nodes, draft, routes, [a, b], majorIdSeed, `major/${i}`, "arterial", "broad");
  }
  const entrances = input.sceneBounds ? nearestBoundaryPoints(input.mask, input.sceneBounds) : nearestBoundaryPoints(input.mask, box);
  for (let i = 0; i < entrances.length; i++) {
    const entrance = entrances[i]!;
    const hub = hubs[i % hubs.length]!;
    if (generationSegmentInside(input.mask, land, hub, entrance, ROUTE_CLASS_REGISTRY.get("highway")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("highway")!.sidewalkM, input.sceneBounds ?? box, true)) {
      addPath(nodes, draft, routes, [hub, entrance], majorIdSeed, `entrance/${i}`, "highway", "standard");
      acceptedEntrances.push(entrance);
    }
  }

  const skeleton = layout === "grid"
    ? []
    : addIrregularSkeleton(nodes, draft, routes, hubs, input.mask, land, box, majorSeed, majorIdSeed, input.sceneBounds ?? box, layout === "mixed" ? 0.45 : 1, layout === "european");

  if (layout === "grid" || layout === "mixed") {
    const spacing = Math.max(28, Math.min(box.width, box.height) / 5);
    const centre = hubs[0]!;
    const rows = layout === "grid" ? 4 : 2;
    for (let i = -rows; i <= rows; i++) {
      const y = centre.y + i * spacing;
      const a = { x: box.x + spacing * 0.4, y };
      const b = { x: box.x + box.width - spacing * 0.4, y };
      if (generationSegmentInside(input.mask, land, a, b, ROUTE_CLASS_REGISTRY.get("street")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("street")!.sidewalkM)) addPath(nodes, draft, routes, [a, b], majorIdSeed, `grid/h/${i}`, i === 0 ? "arterial" : "street", "tight");
    }
    const cols = layout === "grid" ? 4 : 2;
    for (let i = -cols; i <= cols; i++) {
      const x = centre.x + i * spacing;
      const a = { x, y: box.y + spacing * 0.4 };
      const b = { x, y: box.y + box.height - spacing * 0.4 };
      if (generationSegmentInside(input.mask, land, a, b, ROUTE_CLASS_REGISTRY.get("street")!.widthM / 2 + ROUTE_CLASS_REGISTRY.get("street")!.sidewalkM)) addPath(nodes, draft, routes, [a, b], majorIdSeed, `grid/v/${i}`, i === 0 ? "arterial" : "street", "tight");
    }
  }

  if (layout === "european" || layout === "mixed") {
    addIrregularLocalRoutes(nodes, draft, routes, hubs, skeleton, input.mask, land, box, localSeed, localIdSeed, layout, layout === "european", input.sceneBounds ?? box);
  }

  if (hubs.length > 0) {
    const hub = skeleton[0]?.point ?? hubs[0]!;
    const direction = skeleton[0] === undefined ? { x: 1, y: 0 } : { x: skeleton[0].point.x - hubs[0]!.x, y: skeleton[0].point.y - hubs[0]!.y };
    const directionLength = Math.hypot(direction.x, direction.y) || 1;
    const normal = { x: -direction.y / directionLength, y: direction.x / directionLength };
    const routeLength = Math.min(box.width, box.height) * (0.1 + hash2(3, 7, routesSeed) * 0.04);
    const cycleBend = { x: hub.x + direction.x / directionLength * routeLength * 0.5 + normal.x * routeLength * 0.15, y: hub.y + direction.y / directionLength * routeLength * 0.5 + normal.y * routeLength * 0.15 };
    const endpoint = {
      x: hub.x + direction.x / directionLength * routeLength,
      y: hub.y + direction.y / directionLength * routeLength
    };
    tryAddPath(
      nodes,
      draft,
      routes,
      [hub, cycleBend, endpoint],
      input.mask,
      land,
      ROUTE_CLASS_REGISTRY.get("cycleway")!.widthM / 2,
      routesIdSeed,
      "route/cycle",
      "cycleway",
      "tight",
      input.sceneBounds ?? box
    );
  }

  const beforeDiscard = planarize(nodes, draft, routesIdSeed);
  const planarEdges = discardGeneratedOverlaps(nodes, beforeDiscard);
  const used = new Set([...nodes.keys(), ...routes.keys()]);
  const edgeIds = new Set(used);
  const edges = planarEdges.map((edge, index) => {
    const id = allocateGeneratedId("edge", routesIdSeed, `${edge.routeId}/${edge.classId}`, index, edgeIds);
    edgeIds.add(id);
    return { id, a: edge.a, b: edge.b, routeId: edge.routeId, classId: edge.classId, name: edge.name, locked: false, origin: "generated" as const };
  });
  const usedRouteIds = new Set(edges.map((edge) => edge.routeId));
  const initialRoads: RoadSource = { nodes: [...nodes.entries()].filter(([id]) => edges.some((edge) => edge.a === id || edge.b === id)).sort(([a], [b]) => a.localeCompare(b)).map(([id, point]) => ({ id, ...point })), routes: [...routes.entries()].filter(([id]) => usedRouteIds.has(id)).sort(([a], [b]) => a.localeCompare(b)).map(([id, route]) => ({ id, ...route })), edges };
  const protectedNodeIds = new Set(hubs.map((hub) => exactNodeId(initialRoads, hub)).filter((id): id is string => id !== undefined));
  const roads = pruneDisconnectedVehicleComponents(cleanupGeneratedTopology(initialRoads, cleanupSeed, protectedNodeIds), hubs[0]!);
  const topology = validateRouteTopology(roads, compileRouteNetwork(roads));
  if (!topology.ok) throw new Error(`Generated road topology is invalid: ${topology.problems.join(" ")}`);
  if (!corridorsInsideMask(roads, input.mask, input.sceneBounds ?? bounds(input.mask))) throw new Error("Generated road corridors leave the active generation mask.");
  const components = majorVehicleComponents(roads);
  const rootNodeId = nearestVehicleNodeId(roads, hubs[0]!);
  const rootComponent = rootNodeId === undefined ? undefined : components.get(rootNodeId);
  const connectedHubIds = rootComponent === undefined ? [] : [...new Set(hubs
    .map((hub) => nearestVehicleNodeId(roads, hub))
    .filter((nodeId): nodeId is string => nodeId !== undefined && components.get(nodeId) === rootComponent))];
  const connectedHubs = connectedHubIds
    .map((nodeId) => roads.nodes.find((node) => node.id === nodeId))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);
  const connectedEntrances = rootComponent === undefined ? [] : acceptedEntrances.filter((entrance) => {
    const nodeId = exactNodeId(roads, entrance);
    return nodeId !== undefined && components.get(nodeId) === rootComponent;
  });
  requireMajorConnectivity(roads, connectedHubs, connectedEntrances);
  return { roads, diagnostics: { layout, hubMode, hubs: connectedHubIds, attempts: draft.length, discarded: Math.max(0, draft.length - planarEdges.length), warnings: [] } };
}

export const generateRoadNetwork = generateInitialRoadNetwork;
