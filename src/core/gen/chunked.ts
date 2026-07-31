import { intersection, ringAsMulti } from "../geom/boolean.js";
import {
  LIGHT_DIRECTION,
  SHADOW_LENGTH,
  extrudeBuilding,
  type BuildingSpec
} from "../geom/extrude.js";
import { VERTEX_FLOATS, emptyMesh, mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import {
  rectRing,
  rectsIntersect,
  ringBounds,
  ringCentroid,
  unionRect,
  type MultiPolygon,
  type Rect,
  type Vec2
} from "../geom/types.js";
import { nodeMap, type RoadGraph } from "../graph/road-graph.js";
import { MATERIAL } from "../palette.js";
import { buildingsForBlocks } from "./blocks.js";
import { buildingDetailMesh } from "./building-detail.js";
import { parkedCars } from "./cars.js";
import { CLUTTER_MAX_HEIGHT_M, CLUTTER_MIN_BUILDING_M, clutterMesh } from "./clutter.js";
import { chunkId, chunkQueryRect, chunkRect, chunksCovering, type ChunkKey } from "./chunks.js";
import { cityToPixels, pixelsToMetres, rectToPixels, type CityParams } from "./demo-city.js";
import {
  MARKING_HEIGHT_M,
  MARKING_REACH_M,
  buildRoadDetails,
  type MarkingQuad
} from "./markings.js";
import { neonMesh } from "./neon.js";
import { buildRoadSurfaces, type RoadSurfaces } from "./roads.js";
import { lotRegions } from "./zones.js";

export interface ChunkBuild {
  key: ChunkKey;
  id: string;
  /** Complete baseline scene, kept visible at every render quality. */
  mesh: MeshBuffers;
  /** Additional geometry reserved for higher render-quality tiers. */
  detail: MeshBuffers;
  /** Additive neon quads. A separate mesh because it needs its own blend and depth state. */
  neon: MeshBuffers;
  /** Flat surfaces already clipped to the chunk rect. Disjoint between chunks. */
  surfaces: RoadSurfaces;
  /** Buildings this chunk owns, uncut — a kept building may overhang the chunk rect. */
  buildings: BuildingSpec[];
  /** Parked-car props this chunk owns, separate from buildings used for Foundry walls. */
  cars: BuildingSpec[];
  /** Real extent in METRES, including everything overhanging the chunk rect. */
  boundsM: Rect;
  buildingCount: number;
  carCount: number;
  markingCount: number;
}

/**
 * Overlap a chunk must generate beyond its own rect to be seam-correct.
 *
 * The lot term is the one that is easy to get wrong: lots are owned by centroid, and a lot
 * centred on the chunk edge reaches up to half a lot outside it, so a full lot size is safe.
 *
 * WHY the marking term: crossings key off node degree, and a node outside the query rect
 * loses the incident edges that point away from it, so it would present a lower degree here
 * than in the chunk next door. Reaching far enough that any node able to place a marking
 * inside this chunk is itself inside the query rect keeps every degree honest.
 */
export function chunkMarginM(params: CityParams): number {
  let margin = 0;
  for (const c of params.graph.classes) {
    margin = Math.max(margin, c.widthM / 2 + c.sidewalkM + MARKING_REACH_M);
  }
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

/**
 * One flat mesh per marking material.
 *
 * WHY grouped rather than one mesh per quad: `flatMesh` bakes the material into every
 * vertex, so a merge per material is the only way to keep the whole chunk in one draw.
 */
function markingMeshes(quads: MarkingQuad[]): MeshBuffers[] {
  const byMaterial = new Map<number, MultiPolygon>();
  for (const q of quads) {
    const polys = byMaterial.get(q.material);
    if (polys === undefined) byMaterial.set(q.material, [[q.ring]]);
    else polys.push([q.ring]);
  }
  return [...byMaterial].map(([material, polys]) =>
    flatMesh(polys, MARKING_HEIGHT_M, material, 1)
  );
}

/** Positional extent of a mesh, in metres. Neon quads reach past the footprints they sit on. */
function meshBoundsM(mesh: MeshBuffers, origin: Vec2, pixelsPerMetre: number): Rect | null {
  if (mesh.vertexCount === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.vertices[i * VERTEX_FLOATS]!;
    const y = mesh.vertices[i * VERTEX_FLOATS + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return boundsToMetres(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    origin,
    pixelsPerMetre
  );
}

function meshMaxHeightM(mesh: MeshBuffers): number {
  let height = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    height = Math.max(height, mesh.vertices[i * VERTEX_FLOATS + 2]!);
  }
  return height;
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
      detail: emptyMesh(),
      neon: emptyMesh(),
      surfaces: { road: [], sidewalk: [], blocks: [] },
      buildings: [],
      cars: [],
      boundsM: chunkRect(key),
      buildingCount: 0,
      carCount: 0,
      markingCount: 0
    };
  }

  const px = cityToPixels(
    { ...params, graph: clipGraph(params.graph, queryM, marginM) },
    pixelsPerMetre
  );
  const queryPx = rectToPixels(queryM, params.origin, pixelsPerMetre);
  const chunkPx = rectToPixels(chunkM, params.origin, pixelsPerMetre);

  const query = buildRoadSurfaces(px.graph, queryPx, pixelsPerMetre);
  const roadDetails = buildRoadDetails(px.graph, pixelsPerMetre);

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
    const buildingBoundsM = boundsToMetres(
      ringBounds(spec.footprint),
      params.origin,
      pixelsPerMetre
    );
    boundsM = unionRect(boundsM, buildingBoundsM);
    const shadowHeight =
      spec.height + (spec.height >= CLUTTER_MIN_BUILDING_M ? CLUTTER_MAX_HEIGHT_M : 0);
    boundsM = unionRect(boundsM, {
      ...buildingBoundsM,
      x: buildingBoundsM.x - LIGHT_DIRECTION.x * shadowHeight * SHADOW_LENGTH,
      y: buildingBoundsM.y - LIGHT_DIRECTION.y * shadowHeight * SHADOW_LENGTH
    });
  }

  // Markings are owned by centroid like buildings, and for the same reason: clipping them
  // to the chunk rect would cut a dash in half and lose the coordinate its stripe runs on.
  const markings: MarkingQuad[] = [];
  for (const quad of roadDetails.markings) {
    const centroid = pixelsToMetres(ringCentroid(quad.ring), params.origin, pixelsPerMetre);
    if (!ownsCentroid(chunkM, centroid)) continue;
    markings.push(quad);
    boundsM = unionRect(
      boundsM,
      boundsToMetres(ringBounds(quad.ring), params.origin, pixelsPerMetre)
    );
  }

  const cars: BuildingSpec[] = [];
  for (const car of parkedCars(
    roadDetails.parkingSpans,
    params.origin,
    pixelsPerMetre,
    px.zones
  )) {
    const centroid = pixelsToMetres(ringCentroid(car.footprint), params.origin, pixelsPerMetre);
    if (!ownsCentroid(chunkM, centroid)) continue;
    cars.push(car);
    const carBoundsM = boundsToMetres(
      ringBounds(car.footprint),
      params.origin,
      pixelsPerMetre
    );
    boundsM = unionRect(boundsM, carBoundsM);
    boundsM = unionRect(boundsM, {
      ...carBoundsM,
      x: carBoundsM.x - LIGHT_DIRECTION.x * car.height * SHADOW_LENGTH,
      y: carBoundsM.y - LIGHT_DIRECTION.y * car.height * SHADOW_LENGTH
    });
  }

  const mesh = mergeMeshes([
    flatMesh(surfaces.blocks, 0, MATERIAL.GROUND, 1),
    flatMesh(surfaces.road, 0, MATERIAL.ROAD, 1),
    flatMesh(surfaces.sidewalk, 0, MATERIAL.SIDEWALK, 1),
    ...markingMeshes(markings),
    ...kept.map((spec) => extrudeBuilding(spec, pixelsPerMetre)),
    ...cars.map((car) => extrudeBuilding(car, pixelsPerMetre)),
    clutterMesh(kept, pixelsPerMetre)
  ]);
  const detail = buildingDetailMesh(kept, pixelsPerMetre);
  const detailBounds = meshBoundsM(detail, params.origin, pixelsPerMetre);
  if (detailBounds !== null) {
    boundsM = unionRect(boundsM, detailBounds);
    const detailHeight = meshMaxHeightM(detail);
    boundsM = unionRect(boundsM, {
      ...detailBounds,
      x: detailBounds.x - LIGHT_DIRECTION.x * detailHeight * SHADOW_LENGTH,
      y: detailBounds.y - LIGHT_DIRECTION.y * detailHeight * SHADOW_LENGTH
    });
  }

  const neon = neonMesh(kept, pixelsPerMetre);
  const neonBounds = meshBoundsM(neon, params.origin, pixelsPerMetre);
  if (neonBounds !== null) boundsM = unionRect(boundsM, neonBounds);

  return {
    key,
    id,
    mesh,
    detail,
    neon,
    surfaces,
    buildings: kept,
    cars,
    boundsM,
    buildingCount: kept.length,
    carCount: cars.length,
    markingCount: markings.length
  };
}

export function cityChunks(cityBoundsM: Rect): ChunkKey[] {
  return chunksCovering(cityBoundsM);
}
