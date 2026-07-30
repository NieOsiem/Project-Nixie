import type { Vec2 } from "../geom/types.js";
import { nodeMap, type RoadEdge, type RoadGraph, type RoadNode } from "./road-graph.js";

export interface EditOptions {
  /** A drawn endpoint closer than this to an existing node or road fuses into it. */
  snapPx: number;
}

const EPS = 1e-6;
/**
 * A stop is either an exact crossing or a point projected onto a segment, so float noise
 * is a few ULPs at world scale. A thousandth of a pixel is far above that and far below
 * anything the boolean pass (which snaps at 1e-3) can tell apart.
 */
const ON_EDGE_PX = 1e-3;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Closest point on segment a→b to p, with its parameter in [0, 1]. */
export function projectOnSegment(a: Vec2, b: Vec2, p: Vec2): { u: number; point: Vec2 } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) return { u: 0, point: { x: a.x, y: a.y } };
  const raw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const u = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return { u, point: { x: a.x + dx * u, y: a.y + dy * u } };
}

/** Parameters of the proper crossing of a→b with p→q, or null if they miss or are parallel. */
function segmentCross(a: Vec2, b: Vec2, p: Vec2, q: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = q.x - p.x;
  const sy = q.y - p.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;
  const t = ((p.x - a.x) * sy - (p.y - a.y) * sx) / denom;
  const u = ((p.x - a.x) * ry - (p.y - a.y) * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u };
}

function freshId(prefix: string, used: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
}

/** Nearest node, else nearest point on a road, else p unchanged. */
export function snapToGraph(graph: RoadGraph, p: Vec2, snapPx: number): Vec2 {
  let best: Vec2 | null = null;
  let bestD = snapPx;

  for (const n of graph.nodes) {
    const d = dist(n, p);
    if (d <= bestD) {
      bestD = d;
      best = { x: n.x, y: n.y };
    }
  }
  if (best !== null) return best;

  const nodes = nodeMap(graph);
  for (const e of graph.edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b) continue;
    const proj = projectOnSegment(a, b, p);
    const d = dist(proj.point, p);
    if (d <= bestD) {
      bestD = d;
      best = proj.point;
    }
  }
  return best ?? { x: p.x, y: p.y };
}

/** The junction closest to p, within maxPx. */
export function nearestNode(graph: RoadGraph, p: Vec2, maxPx: number): RoadNode | null {
  let best: RoadNode | null = null;
  let bestD = maxPx;
  for (const n of graph.nodes) {
    const d = dist(n, p);
    if (d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** The road whose centreline passes closest to p, within maxPx. */
export function nearestEdge(graph: RoadGraph, p: Vec2, maxPx: number): RoadEdge | null {
  const nodes = nodeMap(graph);
  let best: RoadEdge | null = null;
  let bestD = maxPx;
  for (const e of graph.edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b) continue;
    const d = dist(projectOnSegment(a, b, p).point, p);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * Add a road from `from` to `to`, keeping the graph planar.
 *
 * Every crossing with an existing road becomes a shared node and splits that road, so a
 * drawn grid yields real junctions rather than roads passing through each other. Without
 * this the surface pass still unions correctly, but junction discs are missing at the
 * crossings and deleting one road leaves the other cut in a place no node explains.
 */
export function insertRoad(
  graph: RoadGraph,
  from: Vec2,
  to: Vec2,
  classId: string,
  options: EditOptions
): RoadGraph {
  const nodes: RoadNode[] = graph.nodes.map((n) => ({ ...n }));
  const edges: RoadEdge[] = graph.edges.map((e) => ({ ...e }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  const snapPx = Math.max(options.snapPx, 0);

  const a = snapToGraph(graph, from, snapPx);
  const b = snapToGraph(graph, to, snapPx);
  if (dist(a, b) <= Math.max(snapPx, EPS)) return graph;

  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const stops: { t: number; point: Vec2 }[] = [
    { t: 0, point: a },
    { t: 1, point: b }
  ];
  for (const e of edges) {
    const p = byId.get(e.a);
    const q = byId.get(e.b);
    if (!p || !q) continue;
    const hit = segmentCross(a, b, p, q);
    if (hit === null) continue;
    stops.push({
      t: hit.t,
      point: { x: p.x + (q.x - p.x) * hit.u, y: p.y + (q.y - p.y) * hit.u }
    });
  }
  stops.sort((l, r) => l.t - r.t);

  const resolve = (point: Vec2): string => {
    for (const n of nodes) {
      if (dist(n, point) <= Math.max(snapPx, ON_EDGE_PX)) return n.id;
    }
    const id = freshId("n", nodeIds);
    const node: RoadNode = { id, x: point.x, y: point.y };
    nodeIds.add(id);
    nodes.push(node);
    byId.set(id, node);

    // Splitting after the node exists means a later stop on the same original road
    // resolves against whichever half actually contains it.
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      const p = byId.get(e.a);
      const q = byId.get(e.b);
      if (!p || !q) continue;
      const proj = projectOnSegment(p, q, point);
      if (proj.u <= 0 || proj.u >= 1 || dist(proj.point, point) > ON_EDGE_PX) continue;
      const tailId = freshId("e", edgeIds);
      edgeIds.add(tailId);
      edges.splice(i + 1, 0, { id: tailId, a: id, b: e.b, classId: e.classId });
      edges[i] = { ...e, b: id };
      break;
    }
    return id;
  };

  const chain: string[] = [];
  for (const stop of stops) {
    const id = resolve(stop.point);
    if (chain[chain.length - 1] !== id) chain.push(id);
  }

  for (let i = 0; i + 1 < chain.length; i++) {
    const na = chain[i]!;
    const nb = chain[i + 1]!;
    const exists = edges.some(
      (e) => (e.a === na && e.b === nb) || (e.a === nb && e.b === na)
    );
    if (exists) continue;
    const id = freshId("e", edgeIds);
    edgeIds.add(id);
    edges.push({ id, a: na, b: nb, classId });
  }

  return { ...graph, nodes, edges };
}

export function pruneOrphanNodes(graph: RoadGraph): RoadGraph {
  const used = new Set<string>();
  for (const e of graph.edges) {
    used.add(e.a);
    used.add(e.b);
  }
  if (graph.nodes.every((n) => used.has(n.id))) return graph;
  return { ...graph, nodes: graph.nodes.filter((n) => used.has(n.id)) };
}

export function removeRoad(graph: RoadGraph, edgeId: string): RoadGraph {
  const edges = graph.edges.filter((e) => e.id !== edgeId);
  if (edges.length === graph.edges.length) return graph;
  return pruneOrphanNodes({ ...graph, edges });
}

/** Rewire every road off `fromId` onto `intoId`, dropping the self-loops and duplicates. */
export function mergeNodes(graph: RoadGraph, fromId: string, intoId: string): RoadGraph {
  const seen = new Set<string>();
  const edges: RoadEdge[] = [];

  for (const e of graph.edges) {
    const a = e.a === fromId ? intoId : e.a;
    const b = e.b === fromId ? intoId : e.b;
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...e, a, b });
  }
  return pruneOrphanNodes({ ...graph, edges });
}

/**
 * Drag a junction to a new position. Dropping it on another junction welds the two,
 * which is how a mis-drawn road gets reconnected without deleting and redrawing it.
 *
 * Roads the moved node's edges now cross are *not* re-split — the graph can leave
 * planarity this way. Draw over the crossing to restore it.
 */
export function moveNode(
  graph: RoadGraph,
  nodeId: string,
  to: Vec2,
  options: EditOptions
): RoadGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;

  for (const other of graph.nodes) {
    if (other.id !== nodeId && dist(other, to) <= options.snapPx) {
      return mergeNodes(graph, nodeId, other.id);
    }
  }

  if (node.x === to.x && node.y === to.y) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, x: to.x, y: to.y } : n))
  };
}

/** Flip a single road's pavement on or off, independent of its class default. */
export function toggleSidewalks(graph: RoadGraph, edgeId: string): RoadGraph {
  let found = false;
  const edges = graph.edges.map((e) => {
    if (e.id !== edgeId) return e;
    found = true;
    return { ...e, sidewalks: e.sidewalks === false };
  });
  return found ? { ...graph, edges } : graph;
}
