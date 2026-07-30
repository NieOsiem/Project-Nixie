import type { Vec2 } from "../geom/types.js";

export interface RoadClass {
  id: string;
  /** Carriageway width in metres, kerb to kerb. */
  widthM: number;
  /** Pavement width in metres, added on each side. */
  sidewalkM: number;
}

export interface RoadNode {
  id: string;
  x: number;
  y: number;
}

export interface RoadEdge {
  id: string;
  a: string;
  b: string;
  classId: string;
  /** Per-road override of the class pavement. Absent means "use the class". */
  sidewalks?: boolean;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  classes: RoadClass[];
}

export function nodeMap(graph: RoadGraph): Map<string, RoadNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

export function classMap(graph: RoadGraph): Map<string, RoadClass> {
  return new Map(graph.classes.map((c) => [c.id, c]));
}

export function incidentEdges(graph: RoadGraph, nodeId: string): RoadEdge[] {
  return graph.edges.filter((e) => e.a === nodeId || e.b === nodeId);
}

export function nodeDegree(graph: RoadGraph, nodeId: string): number {
  return incidentEdges(graph, nodeId).length;
}

export function edgeVector(a: RoadNode, b: RoadNode): Vec2 {
  return { x: b.x - a.x, y: b.y - a.y };
}

export function edgeLength(a: RoadNode, b: RoadNode): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Structural problems that would make surface generation meaningless. */
export function validateGraph(graph: RoadGraph): string[] {
  const problems: string[] = [];
  const nodes = nodeMap(graph);
  const classes = classMap(graph);

  const seenNodes = new Set<string>();
  for (const n of graph.nodes) {
    if (seenNodes.has(n.id)) problems.push(`Duplicate node id "${n.id}".`);
    seenNodes.add(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) problems.push(`Node "${n.id}" has a non-finite position.`);
  }

  const seenEdges = new Set<string>();
  for (const e of graph.edges) {
    if (seenEdges.has(e.id)) problems.push(`Duplicate edge id "${e.id}".`);
    seenEdges.add(e.id);

    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a) problems.push(`Edge "${e.id}" references unknown node "${e.a}".`);
    if (!b) problems.push(`Edge "${e.id}" references unknown node "${e.b}".`);
    if (e.a === e.b) problems.push(`Edge "${e.id}" is a self-loop.`);
    if (a && b && edgeLength(a, b) === 0) problems.push(`Edge "${e.id}" has zero length.`);
    if (!classes.has(e.classId)) problems.push(`Edge "${e.id}" references unknown class "${e.classId}".`);
  }

  for (const c of graph.classes) {
    if (c.widthM <= 0) problems.push(`Class "${c.id}" has a non-positive width.`);
    if (c.sidewalkM < 0) problems.push(`Class "${c.id}" has a negative pavement width.`);
  }

  return problems;
}
