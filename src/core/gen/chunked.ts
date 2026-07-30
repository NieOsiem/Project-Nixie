import { intersection, ringAsMulti } from "../geom/boolean.js";
import { extrudeBuilding, type BuildingSpec } from "../geom/extrude.js";
import { emptyMesh, mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import {
  rectRing,
  rectsIntersect,
  ringBounds,
  ringCentroid,
  unionRect,
  type Rect,
  type Vec2
} from "../geom/types.js";
import { nodeMap, type RoadGraph } from "../graph/road-graph.js";
import { MATERIAL } from "../palette.js";
import { buildingsForBlocks } from "./blocks.js";
import { chunkId, chunkQueryRect, chunkRect, chunksCovering, type ChunkKey } from "./chunks.js";
import { cityToPixels, pixelsToMetres, rectToPixels, type CityParams } from "./demo-city.js";
import { buildRoadSurfaces, type RoadSurfaces } from "./roads.js";
import { lotRegions } from "./zones.js";

export interface ChunkBuild {
  key: ChunkKey;
  id: string;
  mesh: MeshBuffers;
  /** Flat surfaces already clipped to the chunk rect. Disjoint between chunks. */
  surfaces: RoadSurfaces;
  /** Buildings this chunk owns, uncut — a kept building may overhang the chunk rect. */
  buildings: BuildingSpec[];
  /** Real extent in METRES, including buildings overhanging the chunk rect. */
  boundsM: Rect;
  buildingCount: number;
}

/**
 * Overlap a chunk must generate beyond its own rect to be seam-correct.
 *
 * The lot term is the one that is easy to get wrong: lots are owned by centroid, and a lot
 * centred on the chunk edge reaches up to half a lot outside it, so a full lot size is safe.
 */
export function chunkMarginM(params: CityParams): number {
  let margin = 0;
  for (const c of params.graph.classes) margin = Math.max(margin, c.widthM / 2 + c.sidewalkM);
  margin = Math.max(margin, params.base.lotSizeM);
  for (const z of params.zones) margin = Math.max(margin, z.lotSizeM);
  return margin;
}

function rectIntersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)
  };
}

const isEmptyRect = (r: Rect): boolean => r.width <= 0 || r.height <= 0;

/**
 * Every edge whose surface could reach into `rect`, plus the nodes they reference.
 *
 * WHY: the bounding box is grown by the margin, not tested bare. `rect` already extends a
 * margin past the chunk, so a bare test would drop edges whose pavement lands in that
 * outer ring — which changes the block boundary there, and with it lots the chunk owns.
 */
function clipGraph(graph: RoadGraph, rect: Rect, marginM: number): RoadGraph {
  const nodes = nodeMap(graph);
  const edges = graph.edges.filter((e) => {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    return a !== undefined && b !== undefined && segmentNearRect(a, b, rect, marginM);
  });

  const used = new Set<string>();
  for (const e of edges) {
    used.add(e.a);
    used.add(e.b);
  }
  return { ...graph, nodes: graph.nodes.filter((n) => used.has(n.id)), edges };
}

function segmentNearRect(a: Vec2, b: Vec2, rect: Rect, marginM: number): boolean {
  return rectsIntersect(
    {
      x: Math.min(a.x, b.x) - marginM,
      y: Math.min(a.y, b.y) - marginM,
      width: Math.abs(b.x - a.x) + marginM * 2,
      height: Math.abs(b.y - a.y) + marginM * 2
    },
    rect
  );
}

function boundsToMetres(r: Rect, origin: Vec2, pixelsPerMetre: number): Rect {
  const p = pixelsToMetres({ x: r.x, y: r.y }, origin, pixelsPerMetre);
  return { x: p.x, y: p.y, width: r.width / pixelsPerMetre, height: r.height / pixelsPerMetre };
}

/** Half-open on the max edges, matching `chunkRect`, so no lot is owned twice. */
function ownsCentroid(chunkM: Rect, p: Vec2): boolean {
  return (
    p.x >= chunkM.x &&
    p.x < chunkM.x + chunkM.width &&
    p.y >= chunkM.y &&
    p.y < chunkM.y + chunkM.height
  );
}

export function buildChunk(
  params: CityParams,
  key: ChunkKey,
  cityBoundsM: Rect,
  pixelsPerMetre: number
): ChunkBuild {
  const id = chunkId(key);
  const marginM = chunkMarginM(params);

  // WHY: clamping to the city bounds is what makes a chunked build agree with the
  // whole-city build at the city edge. Unclamped, an edge chunk invents ground outside it.
  const queryM = rectIntersection(chunkQueryRect(key, marginM), cityBoundsM);
  const chunkM = rectIntersection(chunkRect(key), cityBoundsM);
  if (isEmptyRect(queryM) || isEmptyRect(chunkM)) {
    return {
      key,
      id,
      mesh: emptyMesh(),
      surfaces: { road: [], sidewalk: [], blocks: [] },
      buildings: [],
      boundsM: chunkRect(key),
      buildingCount: 0
    };
  }

  const px = cityToPixels(
    { ...params, graph: clipGraph(params.graph, queryM, marginM) },
    pixelsPerMetre
  );
  const queryPx = rectToPixels(queryM, params.origin, pixelsPerMetre);
  const chunkPx = rectToPixels(chunkM, params.origin, pixelsPerMetre);

  const query = buildRoadSurfaces(px.graph, queryPx, pixelsPerMetre);

  // Flat surfaces are seamless, so a hard clip at the chunk edge cannot show.
  const clip = ringAsMulti(rectRing(chunkPx));
  const surfaces: RoadSurfaces = {
    road: intersection(query.road, clip),
    sidewalk: intersection(query.sidewalk, clip),
    blocks: intersection(query.blocks, clip)
  };

  // Buildings come off the query-rect blocks, never the clipped ones: a lot straddling the
  // seam has to be cut by the road, not by the chunk.
  const specs = buildingsForBlocks(
    query.blocks,
    lotRegions(params.base, px.zones, queryPx, pixelsPerMetre, params.origin),
    { originPx: params.origin, pixelsPerMetre }
  );

  const kept: BuildingSpec[] = [];
  let boundsM = chunkRect(key);
  for (const spec of specs) {
    const centroid = pixelsToMetres(ringCentroid(spec.footprint), params.origin, pixelsPerMetre);
    if (!ownsCentroid(chunkM, centroid)) continue;
    kept.push(spec);
    boundsM = unionRect(
      boundsM,
      boundsToMetres(ringBounds(spec.footprint), params.origin, pixelsPerMetre)
    );
  }

  const mesh = mergeMeshes([
    flatMesh(surfaces.blocks, 0, MATERIAL.GROUND, 1),
    flatMesh(surfaces.road, 0, MATERIAL.ROAD, 1),
    flatMesh(surfaces.sidewalk, 0, MATERIAL.SIDEWALK, 1),
    ...kept.map(extrudeBuilding)
  ]);

  return { key, id, mesh, surfaces, buildings: kept, boundsM, buildingCount: kept.length };
}

export function cityChunks(cityBoundsM: Rect): ChunkKey[] {
  return chunksCovering(cityBoundsM);
}
