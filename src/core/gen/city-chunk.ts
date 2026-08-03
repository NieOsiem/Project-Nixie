import { difference, intersection, ringAsMulti, union } from "../geom/boolean.js";
import { mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import { rectRing, type MultiPolygon, type Rect, type Ring, type Vec2 } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import { compileRouteNetwork, type CompiledRouteNetwork } from "../graph/compiler.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV2, type RouteClassId } from "./city.js";
import { chunkId, chunkRect, type ChunkKey } from "./chunks.js";
import { buildCityMarkings } from "./city-markings.js";
import { normalizeRing, validateTerrain } from "./terrain.js";

export interface CitySurfacePartitions {
  water: MultiPolygon;
  exposedLand: MultiPolygon;
  vehicleCarriageway: MultiPolygon;
  vehicleSidewalk: MultiPolygon;
  nonVehicleRoute: MultiPolygon;
  markings: MultiPolygon;
  laneMarkings: MultiPolygon;
  crossings: MultiPolygon;
  kerbs: MultiPolygon;
}

export interface CityChunkBuild {
  key: ChunkKey;
  id: string;
  boundsM: Rect;
  mesh: MeshBuffers;
  surfaces: CitySurfacePartitions;
  waterTriangleCount: number;
  exposedLandTriangleCount: number;
  vehicleTriangleCount: number;
  sidewalkTriangleCount: number;
  nonVehicleTriangleCount: number;
  markingTriangleCount: number;
}

export interface CityChunksBuild {
  chunks: CityChunkBuild[];
  compiledRoutes: number;
  compiledSegments: number;
  markingTriangleCount: number;
}

let compileObserver: ((network: CompiledRouteNetwork) => void) | null = null;

// WHY: Tests need to prove one compile per batch without adding production state or timing hooks.
export function setCityChunkCompileObserver(observer: ((network: CompiledRouteNetwork) => void) | null): void {
  compileObserver = observer;
}

function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(Math.min(a.x, a.x + a.width), Math.min(b.x, b.x + b.width));
  const y = Math.max(Math.min(a.y, a.y + a.height), Math.min(b.y, b.y + b.height));
  const right = Math.min(Math.max(a.x, a.x + a.width), Math.max(b.x, b.x + b.width));
  const bottom = Math.min(Math.max(a.y, a.y + a.height), Math.max(b.y, b.y + b.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function emptyRect(rect: Rect): boolean {
  return rect.width <= 0 || rect.height <= 0;
}

function sceneSurfaces(source: CitySourceV2, sceneBoundsM: Rect): { land: MultiPolygon; water: MultiPolygon } {
  const validation = validateTerrain(source.terrain);
  if (!validation.ok) throw new Error(validation.reason);
  const scene = ringAsMulti(rectRing(sceneBoundsM));
  const land = intersection(ringAsMulti(normalizeRing(source.terrain.land)), scene);
  return { land, water: difference(scene, land.length > 0 ? [land] : []) };
}

function edgeQuad(a: Vec2, b: Vec2, halfWidth: number): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0 || halfWidth <= 0) return [];
  const nx = (-dy / length) * halfWidth;
  const ny = (dx / length) * halfWidth;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny }
  ];
}

function nodeDisc(center: Vec2, radius: number, count = 20): Ring {
  if (radius <= 0) return [];
  const ring: Ring = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    ring.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  return ring;
}

function usableRing(ring: Ring): MultiPolygon {
  return ring.length >= 3 ? ringAsMulti(ring) : [];
}

function routeParts(network: CompiledRouteNetwork): {
  carriageway: MultiPolygon;
  paved: MultiPolygon;
  nonVehicle: MultiPolygon;
} {
  const carriagewayParts: MultiPolygon[] = [];
  const pavedParts: MultiPolygon[] = [];
  const nonVehicleParts: MultiPolygon[] = [];
  const carriagewayRadii = new Map<string, number>();
  const pavedRadii = new Map<string, number>();
  const nonVehicleRadii = new Map<string, number>();

  const endpoint = (point: Vec2, nodeId: string | null): string =>
    nodeId ?? `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
  for (const span of network.segments) {
    const cls = ROUTE_CLASS_REGISTRY.get(span.classId as RouteClassId);
    if (!cls || span.lengthM <= 0) continue;
    const routeHalf = span.widthM / 2;
    // WHY: The compiler exposes corridor half-width so the buffer radius must use it directly.
    const clearHalf = span.clearanceM;
    const ring = edgeQuad(span.a, span.b, routeHalf);
    const clear = edgeQuad(span.a, span.b, clearHalf);
    const aId = endpoint(span.a, span.aNodeId);
    const bId = endpoint(span.b, span.bNodeId);
    if (cls.vehicle) {
      carriagewayParts.push(usableRing(ring));
      pavedParts.push(usableRing(clear));
      carriagewayRadii.set(aId, Math.max(carriagewayRadii.get(aId) ?? 0, routeHalf));
      carriagewayRadii.set(bId, Math.max(carriagewayRadii.get(bId) ?? 0, routeHalf));
      pavedRadii.set(aId, Math.max(pavedRadii.get(aId) ?? 0, clearHalf));
      pavedRadii.set(bId, Math.max(pavedRadii.get(bId) ?? 0, clearHalf));
    } else {
      nonVehicleParts.push(usableRing(ring));
      nonVehicleRadii.set(aId, Math.max(nonVehicleRadii.get(aId) ?? 0, routeHalf));
      nonVehicleRadii.set(bId, Math.max(nonVehicleRadii.get(bId) ?? 0, routeHalf));
    }
  }
  const pointById = new Map<string, Vec2>();
  for (const span of network.segments) {
    pointById.set(endpoint(span.a, span.aNodeId), span.a);
    pointById.set(endpoint(span.b, span.bNodeId), span.b);
  }
  for (const [id, radius] of carriagewayRadii) carriagewayParts.push(usableRing(nodeDisc(pointById.get(id)!, radius)));
  for (const [id, radius] of pavedRadii) pavedParts.push(usableRing(nodeDisc(pointById.get(id)!, radius)));
  for (const [id, radius] of nonVehicleRadii) nonVehicleParts.push(usableRing(nodeDisc(pointById.get(id)!, radius)));
  return {
    carriageway: union(carriagewayParts),
    paved: union(pavedParts),
    nonVehicle: union(nonVehicleParts)
  };
}

function markingPartsByMaterial(network: CompiledRouteNetwork): { laneMarkings: MultiPolygon; crossings: MultiPolygon; kerbs: MultiPolygon; markings: MultiPolygon } {
  const markings = buildCityMarkings(network);
  return {
    laneMarkings: markings.laneMarkings,
    crossings: markings.crossings,
    kerbs: markings.kerbs,
    markings: union([markings.laneMarkings, markings.crossings, markings.kerbs])
  };
}

function clipSurfaces(surfaces: CitySurfacePartitions, clip: Rect): CitySurfacePartitions {
  if (emptyRect(clip)) {
    return { water: [], exposedLand: [], vehicleCarriageway: [], vehicleSidewalk: [], nonVehicleRoute: [], markings: [], laneMarkings: [], crossings: [], kerbs: [] };
  }
  const box = ringAsMulti(rectRing(clip));
  return {
    water: intersection(surfaces.water, box),
    exposedLand: intersection(surfaces.exposedLand, box),
    vehicleCarriageway: intersection(surfaces.vehicleCarriageway, box),
    vehicleSidewalk: intersection(surfaces.vehicleSidewalk, box),
    nonVehicleRoute: intersection(surfaces.nonVehicleRoute, box),
    markings: intersection(surfaces.markings, box),
    laneMarkings: intersection(surfaces.laneMarkings, box),
    crossings: intersection(surfaces.crossings, box),
    kerbs: intersection(surfaces.kerbs, box)
  };
}

function toPixels(surfaces: CitySurfacePartitions, source: CitySourceV2, pixelsPerMetre: number): CitySurfacePartitions {
  const convert = (multi: MultiPolygon): MultiPolygon => multi.map((polygon) => polygon.map((ring) => ring.map((p) => ({ x: source.origin.x + p.x * pixelsPerMetre, y: source.origin.y + p.y * pixelsPerMetre }))));
  return {
    water: convert(surfaces.water),
    exposedLand: convert(surfaces.exposedLand),
    vehicleCarriageway: convert(surfaces.vehicleCarriageway),
    vehicleSidewalk: convert(surfaces.vehicleSidewalk),
    nonVehicleRoute: convert(surfaces.nonVehicleRoute),
    markings: convert(surfaces.markings),
    laneMarkings: convert(surfaces.laneMarkings),
    crossings: convert(surfaces.crossings),
    kerbs: convert(surfaces.kerbs)
  };
}

function buildMeshes(surfaces: CitySurfacePartitions, source: CitySourceV2, ppm: number): { mesh: MeshBuffers; counts: number[] } {
  const px = toPixels(surfaces, source, ppm);
  const parts = [
    flatMesh(px.water, 0, MATERIAL.WATER, 1),
    flatMesh(px.exposedLand, 0, MATERIAL.GROUND, 1),
    flatMesh(px.vehicleCarriageway, 0, MATERIAL.ROAD, 1),
    flatMesh(px.vehicleSidewalk, 0, MATERIAL.SIDEWALK, 1),
    flatMesh(px.nonVehicleRoute, 0, MATERIAL.NON_VEHICLE_ROUTE, 1),
    flatMesh(px.laneMarkings, 0.05, MATERIAL.LANE_MARK, 1),
    flatMesh(px.crossings, 0.05, MATERIAL.CROSSING, 1),
    flatMesh(px.kerbs, 0.05, MATERIAL.KERB, 1)
  ];
  return {
    mesh: mergeMeshes(parts),
    counts: parts.map((part) => part.triangleCount)
  };
}

function fullSurfaces(source: CitySourceV2, sceneBoundsM: Rect, network: CompiledRouteNetwork): CitySurfacePartitions {
  const terrain = sceneSurfaces(source, sceneBoundsM);
  const roads = routeParts(network);
  // WHY: Candidate preflight must stay disjoint even before water validation rejects the route.
  const paved = intersection(roads.paved, terrain.land);
  const carriageway = intersection(roads.carriageway, terrain.land);
  const nonVehicleRaw = intersection(roads.nonVehicle, terrain.land);
  const nonVehicle = difference(nonVehicleRaw, [paved]);
  const occupied = union([paved, nonVehicle]);
  return {
    water: terrain.water,
    exposedLand: difference(terrain.land, [occupied]),
    vehicleCarriageway: carriageway,
    vehicleSidewalk: difference(paved, [carriageway]),
    nonVehicleRoute: nonVehicle,
    ...(() => {
      const markings = markingPartsByMaterial(network);
      return {
        markings: intersection(markings.markings, terrain.land),
        laneMarkings: intersection(markings.laneMarkings, terrain.land),
        crossings: intersection(markings.crossings, terrain.land),
        kerbs: intersection(markings.kerbs, terrain.land)
      };
    })()
  };
}

export function citySurfaces(source: CitySourceV2, sceneBoundsM: Rect): CitySurfacePartitions {
  return fullSurfaces(source, sceneBoundsM, compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY));
}

export function buildCityChunk(
  source: CitySourceV2,
  network: CompiledRouteNetwork,
  key: ChunkKey,
  sceneBoundsM: Rect,
  pixelsPerMetre: number,
  surfaces?: CitySurfacePartitions
): CityChunkBuild {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) throw new Error("Pixels per metre must be positive and finite.");
  const boundsM = chunkRect(key);
  const clip = intersectRect(boundsM, sceneBoundsM);
  const all = surfaces ?? fullSurfaces(source, sceneBoundsM, network);
  const clipped = clipSurfaces(all, clip);
  const { mesh, counts } = buildMeshes(clipped, source, pixelsPerMetre);
  return {
    key,
    id: chunkId(key),
    boundsM,
    mesh,
    surfaces: clipped,
    waterTriangleCount: counts[0]!,
    exposedLandTriangleCount: counts[1]!,
    vehicleTriangleCount: counts[2]!,
    sidewalkTriangleCount: counts[3]!,
    nonVehicleTriangleCount: counts[4]!,
    markingTriangleCount: counts[5]! + counts[6]! + counts[7]!
  };
}

export function buildCityChunks(
  source: CitySourceV2,
  keys: ChunkKey[],
  sceneBoundsM: Rect,
  pixelsPerMetre: number
): CityChunksBuild {
  if (!Number.isFinite(source.origin.x) || !Number.isFinite(source.origin.y)) throw new Error("City origin must be finite.");
  const network = compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY);
  compileObserver?.(network);
  const surfaces = fullSurfaces(source, sceneBoundsM, network);
  const builtChunks = keys.map((key) => buildCityChunk(source, network, key, sceneBoundsM, pixelsPerMetre, surfaces));
  return {
    chunks: builtChunks,
    compiledRoutes: network.routes.length,
    compiledSegments: network.segments.length,
    markingTriangleCount: builtChunks.reduce((sum, chunk) => sum + chunk.markingTriangleCount, 0)
  };
}

export const buildCityChunksSync = buildCityChunks;
