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

/** Node positions in grid squares, relative to the layout origin. */
const NODE_GRID: Record<string, Vec2> = {
  A: { x: -40, y: -26 },
  B: { x: 0, y: -26 },
  C: { x: 40, y: -26 },
  D: { x: -40, y: 0 },
  E: { x: 0, y: 0 },
  F: { x: 40, y: 0 },
  G: { x: -40, y: 26 },
  H: { x: 0, y: 26 },
  I: { x: 40, y: 26 }
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

/** Everything the flag stores. Params, never results. */
export interface CityParams {
  graph: RoadGraph;
  base: ZoneParams;
  zones: Zone[];
}

export function demoGraph(origin: Vec2, gridSize: number): RoadGraph {
  return {
    nodes: Object.entries(NODE_GRID).map(([id, p]) => ({
      id,
      x: origin.x + p.x * gridSize,
      y: origin.y + p.y * gridSize
    })),
    edges: EDGE_PAIRS.map(([a, b, classId]) => ({ id: `${a}${b}`, a, b, classId })),
    classes: ROAD_CLASSES.map((c) => ({ ...c }))
  };
}

export function demoCity(origin: Vec2, gridSize: number): CityParams {
  return { graph: demoGraph(origin, gridSize), base: { ...DEFAULT_ZONE_PARAMS }, zones: [] };
}

export function graphBounds(graph: RoadGraph, marginPx: number): Rect {
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
    x: minX - marginPx,
    y: minY - marginPx,
    width: maxX - minX + marginPx * 2,
    height: maxY - minY + marginPx * 2
  };
}

/**
 * Ground extent: everything the roads and zones touch, plus a margin. Recomputed on every
 * edit, because a road drawn past the old edge has to bring the ground with it.
 */
export function cityBounds(params: CityParams, marginPx: number): Rect | null {
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
    x: minX - marginPx,
    y: minY - marginPx,
    width: maxX - minX + marginPx * 2,
    height: maxY - minY + marginPx * 2
  };
}

export interface CityBuild {
  mesh: MeshBuffers;
  surfaces: RoadSurfaces;
  buildingCount: number;
  blockCount: number;
}

export function buildCity(params: CityParams, bounds: Rect, pixelsPerMetre: number): CityBuild {
  const surfaces = buildRoadSurfaces(params.graph, bounds, pixelsPerMetre);
  const regions = lotRegions(params.base, params.zones, bounds, pixelsPerMetre);
  const buildings = buildingsForBlocks(surfaces.blocks, regions);

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
