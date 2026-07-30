import { difference, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, type MultiPolygon, type Rect, type Ring, type Vec2 } from "../geom/types.js";
import { classMap, edgeLength, nodeMap, type RoadGraph } from "../graph/road-graph.js";

export interface RoadSurfaces {
  road: MultiPolygon;
  sidewalk: MultiPolygon;
  blocks: MultiPolygon;
}

const DISC_SEGMENTS = 16;

/** Rectangle of the given half-width centred on the segment a→b. */
export function edgeQuad(a: Vec2, b: Vec2, halfWidth: number): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) throw new Error("Cannot build a quad for a zero-length edge.");

  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny }
  ];
}

/**
 * Filler at a junction. Perpendicular crossings are already covered by the overlapping
 * quads; this exists for bends and acute angles, where the quads leave a notch on the
 * outside of the turn.
 */
export function nodeDisc(centre: Vec2, radius: number, segments = DISC_SEGMENTS): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    ring.push({ x: centre.x + Math.cos(t) * radius, y: centre.y + Math.sin(t) * radius });
  }
  return ring;
}

export function buildRoadSurfaces(
  graph: RoadGraph,
  bounds: Rect,
  pixelsPerMetre: number
): RoadSurfaces {
  const nodes = nodeMap(graph);
  const classes = classMap(graph);

  const roadParts: MultiPolygon[] = [];
  const pavedParts: MultiPolygon[] = [];
  const roadRadius = new Map<string, number>();
  const pavedRadius = new Map<string, number>();

  for (const edge of graph.edges) {
    const a = nodes.get(edge.a);
    const b = nodes.get(edge.b);
    const roadClass = classes.get(edge.classId);
    if (!a || !b || !roadClass || edgeLength(a, b) === 0) continue;

    const sidewalkM = edge.sidewalks === false ? 0 : roadClass.sidewalkM;
    const roadHalf = (roadClass.widthM / 2) * pixelsPerMetre;
    const pavedHalf = (roadClass.widthM / 2 + sidewalkM) * pixelsPerMetre;

    roadParts.push(ringAsMulti(edgeQuad(a, b, roadHalf)));
    pavedParts.push(ringAsMulti(edgeQuad(a, b, pavedHalf)));

    for (const id of [edge.a, edge.b]) {
      roadRadius.set(id, Math.max(roadRadius.get(id) ?? 0, roadHalf));
      pavedRadius.set(id, Math.max(pavedRadius.get(id) ?? 0, pavedHalf));
    }
  }

  for (const [id, radius] of roadRadius) {
    const node = nodes.get(id);
    if (node) roadParts.push(ringAsMulti(nodeDisc(node, radius)));
  }
  for (const [id, radius] of pavedRadius) {
    const node = nodes.get(id);
    if (node) pavedParts.push(ringAsMulti(nodeDisc(node, radius)));
  }

  const road = union(roadParts);
  const paved = union(pavedParts);

  return {
    road,
    sidewalk: difference(paved, [road]),
    blocks: difference(ringAsMulti(rectRing(bounds)), [paved])
  };
}
