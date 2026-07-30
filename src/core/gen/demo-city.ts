import { extrudeBuilding } from "../geom/extrude.js";
import { mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import type { Rect, Vec2 } from "../geom/types.js";
import type { RoadGraph } from "../graph/road-graph.js";
import { MATERIAL } from "../palette.js";
import { buildingsForBlocks, type LotOptions } from "./blocks.js";
import { buildRoadSurfaces, type RoadSurfaces } from "./roads.js";

const ARTERIAL = "arterial";
const STREET = "street";

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

export function demoGraph(origin: Vec2, gridSize: number): RoadGraph {
  return {
    nodes: Object.entries(NODE_GRID).map(([id, p]) => ({
      id,
      x: origin.x + p.x * gridSize,
      y: origin.y + p.y * gridSize
    })),
    edges: EDGE_PAIRS.map(([a, b, classId]) => ({ id: `${a}${b}`, a, b, classId })),
    classes: [
      { id: ARTERIAL, widthM: 16, sidewalkM: 3 },
      { id: STREET, widthM: 9, sidewalkM: 2.5 }
    ]
  };
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

export function lotOptionsFromMetres(pixelsPerMetre: number): LotOptions {
  return {
    lotSizePx: 26 * pixelsPerMetre,
    gapPx: 4 * pixelsPerMetre,
    minAreaPx2: 40 * pixelsPerMetre * pixelsPerMetre,
    minHeightM: 8,
    maxHeightM: 140
  };
}

export interface CityBuild {
  mesh: MeshBuffers;
  surfaces: RoadSurfaces;
  buildingCount: number;
  blockCount: number;
}

export function buildCity(
  graph: RoadGraph,
  bounds: Rect,
  pixelsPerMetre: number,
  lotOptions: LotOptions
): CityBuild {
  const surfaces = buildRoadSurfaces(graph, bounds, pixelsPerMetre);
  const buildings = buildingsForBlocks(surfaces.blocks, lotOptions);

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
