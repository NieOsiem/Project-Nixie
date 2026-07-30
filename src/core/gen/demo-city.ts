import { extrudeBuilding } from "../geom/extrude.js";
import { mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import type { Rect, Vec2 } from "../geom/types.js";
import type { RoadClass, RoadGraph } from "../graph/road-graph.js";
import { MATERIAL } from "../palette.js";
import { buildingsForBlocks } from "./blocks.js";
import { buildRoadSurfaces, type RoadSurfaces } from "./roads.js";
import { DEFAULT_ZONE_PARAMS, lotRegions, type Zone, type ZoneParams } from "./zones.js";

const ARTERIAL = "arterial";
const STREET = "street";

/**
 * Module-owned presets, not per-city data — `loadCityState` overwrites whatever a stored
 * graph carries with this list, so adding a class here never strands an existing city
 * with edges pointing at a class it has never heard of.
 *
 * Widths are metres; the scene is 2 m per grid square, so the square counts in the
 * comments are what you actually see on the grid.
 */
export const ROAD_CLASSES: RoadClass[] = [
  { id: "highway", widthM: 24, sidewalkM: 3 }, //     12 squares + 1.5 each side
  { id: ARTERIAL, widthM: 16, sidewalkM: 3 }, //       8 squares
  { id: STREET, widthM: 9, sidewalkM: 2.5 }, //      4.5 squares
  { id: "narrow", widthM: 6, sidewalkM: 2 }, //        3 squares + 1 each side
  { id: "lane", widthM: 4, sidewalkM: 1.5 }, //        2 squares
  { id: "alley", widthM: 2, sidewalkM: 0 } //          1 square, no pavement
];

export const DEFAULT_ROAD_CLASS = STREET;

/** Road classes are presets, so a loaded city takes the current list rather than its own. */
export function withRoadClasses(graph: RoadGraph): RoadGraph {
  return { ...graph, classes: ROAD_CLASSES.map((c) => ({ ...c })) };
}

/** Node positions in metres, relative to the city origin. ±40/±26 squares at 2 m each. */
const NODE_METRES: Record<string, Vec2> = {
  A: { x: -80, y: -52 },
  B: { x: 0, y: -52 },
  C: { x: 80, y: -52 },
  D: { x: -80, y: 0 },
  E: { x: 0, y: 0 },
  F: { x: 80, y: 0 },
  G: { x: -80, y: 52 },
  H: { x: 0, y: 52 },
  I: { x: 80, y: 52 }
};

/**
 * Fixture graph for S2, chosen to hit every junction shape the surface pass has to
 * survive: E is a perpendicular four-way, F and H are T-junctions, the corners are
 * ninety-degree bends, and D–B is an oblique avenue that turns B and D into acute
 * multi-way junctions.
 */
const EDGE_PAIRS: [string, string, string][] = [
  ["A", "B", STREET],
  ["B", "C", STREET],
  ["D", "E", ARTERIAL],
  ["E", "F", ARTERIAL],
  ["G", "H", STREET],
  ["H", "I", STREET],
  ["A", "D", STREET],
  ["D", "G", STREET],
  ["B", "E", ARTERIAL],
  ["E", "H", ARTERIAL],
  ["C", "F", STREET],
  ["F", "I", STREET],
  ["D", "B", STREET]
];

/**
 * Everything the flag stores. Params, never results.
 *
 * Node positions and zone rects are **metres** relative to `origin`, so a scene grid
 * resize rescales the whole city instead of shearing positions away from widths.
 */
export interface CityParams {
  /** Scene world-pixel point at which city metre coordinate (0, 0) sits. */
  origin: Vec2;
  graph: RoadGraph;
  base: ZoneParams;
  zones: Zone[];
}

export function demoGraph(): RoadGraph {
  return {
    nodes: Object.entries(NODE_METRES).map(([id, p]) => ({ id, x: p.x, y: p.y })),
    edges: EDGE_PAIRS.map(([a, b, classId]) => ({ id: `${a}${b}`, a, b, classId })),
    classes: ROAD_CLASSES.map((c) => ({ ...c }))
  };
}

export function demoCity(origin: Vec2): CityParams {
  return { origin, graph: demoGraph(), base: { ...DEFAULT_ZONE_PARAMS }, zones: [] };
}

/* -------------------------------------------- */
/*  Metres -> world pixels                      */
/* -------------------------------------------- */

export function metresToPixels(p: Vec2, origin: Vec2, pixelsPerMetre: number): Vec2 {
  return { x: origin.x + p.x * pixelsPerMetre, y: origin.y + p.y * pixelsPerMetre };
}

export function pixelsToMetres(p: Vec2, origin: Vec2, pixelsPerMetre: number): Vec2 {
  return { x: (p.x - origin.x) / pixelsPerMetre, y: (p.y - origin.y) / pixelsPerMetre };
}

export function rectToPixels(r: Rect, origin: Vec2, pixelsPerMetre: number): Rect {
  return {
    x: origin.x + r.x * pixelsPerMetre,
    y: origin.y + r.y * pixelsPerMetre,
    width: r.width * pixelsPerMetre,
    height: r.height * pixelsPerMetre
  };
}

/**
 * The one conversion in the pipeline. Everything downstream — booleans, tessellation,
 * extrusion, wall emission — works in world pixels, so it must all be fed from here.
 */
export function cityToPixels(
  params: CityParams,
  pixelsPerMetre: number
): { graph: RoadGraph; zones: Zone[] } {
  const { origin } = params;
  return {
    graph: {
      ...params.graph,
      nodes: params.graph.nodes.map((n) => ({
        ...n,
        ...metresToPixels(n, origin, pixelsPerMetre)
      }))
    },
    zones: params.zones.map((z) => ({ ...z, rect: rectToPixels(z.rect, origin, pixelsPerMetre) }))
  };
}

/** Metres, like everything else on `CityParams`. */
export function graphBounds(graph: RoadGraph, marginM: number): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  return {
    x: minX - marginM,
    y: minY - marginM,
    width: maxX - minX + marginM * 2,
    height: maxY - minY + marginM * 2
  };
}

/**
 * Ground extent in metres: everything the roads and zones touch, plus a margin. Recomputed
 * on every edit, because a road drawn past the old edge has to bring the ground with it.
 */
export function cityBounds(params: CityParams, marginM: number): Rect | null {
  if (params.graph.nodes.length === 0 && params.zones.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const cover = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const n of params.graph.nodes) cover(n.x, n.y);
  for (const z of params.zones) {
    cover(z.rect.x, z.rect.y);
    cover(z.rect.x + z.rect.width, z.rect.y + z.rect.height);
  }

  return {
    x: minX - marginM,
    y: minY - marginM,
    width: maxX - minX + marginM * 2,
    height: maxY - minY + marginM * 2
  };
}

export interface CityBuild {
  mesh: MeshBuffers;
  surfaces: RoadSurfaces;
  buildingCount: number;
  blockCount: number;
}

export function buildCity(params: CityParams, boundsM: Rect, pixelsPerMetre: number): CityBuild {
  const px = cityToPixels(params, pixelsPerMetre);
  const bounds = rectToPixels(boundsM, params.origin, pixelsPerMetre);

  const surfaces = buildRoadSurfaces(px.graph, bounds, pixelsPerMetre);
  const regions = lotRegions(params.base, px.zones, bounds, pixelsPerMetre, params.origin);
  const buildings = buildingsForBlocks(surfaces.blocks, regions, {
    originPx: params.origin,
    pixelsPerMetre
  });

  // Ground, carriageway and pavement are disjoint by construction, so sharing height 0
  // costs no depth fighting.
  const mesh = mergeMeshes([
    flatMesh(surfaces.blocks, 0, MATERIAL.GROUND, 1),
    flatMesh(surfaces.road, 0, MATERIAL.ROAD, 1),
    flatMesh(surfaces.sidewalk, 0, MATERIAL.SIDEWALK, 1),
    ...buildings.map(extrudeBuilding)
  ]);

  return { mesh, surfaces, buildingCount: buildings.length, blockCount: surfaces.blocks.length };
}
