import { difference, intersection, ringAsMulti } from "../geom/boolean.js";
import { emptyMesh, mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import { rectRing, type MultiPolygon, type Rect, type Ring } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import {
  normalizeRing,
  validateTerrain,
  type CitySourceV2,
  type TerrainSource
} from "./terrain.js";
import { chunkId, chunkRect, chunksCovering, type ChunkKey } from "./chunks.js";

export interface TerrainSurfaces {
  land: MultiPolygon;
  water: MultiPolygon;
}

export interface TerrainChunkBuild {
  key: ChunkKey;
  id: string;
  mesh: MeshBuffers;
  surfaces: TerrainSurfaces;
  boundsM: Rect;
  landTriangleCount: number;
  waterTriangleCount: number;
}

function terrainOf(source: TerrainSource | CitySourceV2): TerrainSource {
  return "terrain" in source ? source.terrain : source;
}

function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(Math.min(a.x, a.x + a.width), Math.min(b.x, b.x + b.width));
  const y = Math.max(Math.min(a.y, a.y + a.height), Math.min(b.y, b.y + b.height));
  const right = Math.min(Math.max(a.x, a.x + a.width), Math.max(b.x, b.x + b.width));
  const bottom = Math.min(Math.max(a.y, a.y + a.height), Math.max(b.y, b.y + b.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function isEmpty(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

function toPixels(ring: Ring, source: CitySourceV2, pixelsPerMetre: number): Ring {
  return ring.map((p) => ({
    x: source.origin.x + p.x * pixelsPerMetre,
    y: source.origin.y + p.y * pixelsPerMetre
  }));
}

function surfacesInScene(source: TerrainSource | CitySourceV2, sceneBoundsM: Rect): TerrainSurfaces {
  const terrain = terrainOf(source);
  const validation = validateTerrain(terrain);
  if (!validation.ok) throw new Error(validation.reason);
  const bounds = intersectRect(sceneBoundsM, sceneBoundsM);
  if (isEmpty(bounds)) return { land: [], water: [] };

  const scene = ringAsMulti(rectRing(bounds));
  const land = intersection(ringAsMulti(normalizeRing(terrain.land)), scene);
  const water = difference(scene, land.length > 0 ? [land] : []);
  return { land, water };
}

function clipSurfaces(surfaces: TerrainSurfaces, clipRect: Rect): TerrainSurfaces {
  if (isEmpty(clipRect)) return { land: [], water: [] };
  const clip = ringAsMulti(rectRing(clipRect));
  return {
    land: intersection(surfaces.land, clip),
    water: intersection(surfaces.water, clip)
  };
}

function pixelsSurfaces(
  surfaces: TerrainSurfaces,
  source: CitySourceV2,
  pixelsPerMetre: number
): TerrainSurfaces {
  const convert = (multi: MultiPolygon): MultiPolygon =>
    multi.map((polygon) => polygon.map((ring) => toPixels(ring, source, pixelsPerMetre)));
  return { land: convert(surfaces.land), water: convert(surfaces.water) };
}

export function terrainSurfaces(
  source: TerrainSource | CitySourceV2,
  sceneBoundsM: Rect
): TerrainSurfaces {
  return surfacesInScene(source, sceneBoundsM);
}

export function buildTerrainChunk(
  source: CitySourceV2,
  key: ChunkKey,
  sceneBoundsM: Rect,
  pixelsPerMetre: number
): TerrainChunkBuild {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) {
    throw new Error("Pixels per metre must be positive and finite.");
  }
  if (!Number.isFinite(source.origin.x) || !Number.isFinite(source.origin.y)) {
    throw new Error("City origin must be finite.");
  }

  const boundsM = chunkRect(key);
  const clipRect = intersectRect(boundsM, sceneBoundsM);
  const sceneSurfaces = surfacesInScene(source, sceneBoundsM);
  const surfaces = clipSurfaces(sceneSurfaces, clipRect);
  if (isEmpty(clipRect)) {
    return {
      key,
      id: chunkId(key),
      mesh: emptyMesh(),
      surfaces,
      boundsM,
      landTriangleCount: 0,
      waterTriangleCount: 0
    };
  }

  const px = pixelsSurfaces(surfaces, source, pixelsPerMetre);
  const landMesh = flatMesh(px.land, 0, MATERIAL.GROUND, 1);
  const waterMesh = flatMesh(px.water, 0, MATERIAL.WATER, 1);
  const mesh = mergeMeshes([landMesh, waterMesh]);
  return {
    key,
    id: chunkId(key),
    mesh,
    surfaces,
    boundsM,
    landTriangleCount: landMesh.triangleCount,
    waterTriangleCount: waterMesh.triangleCount
  };
}

export function terrainChunks(
  source: CitySourceV2,
  sceneBoundsM: Rect,
  pixelsPerMetre: number
): TerrainChunkBuild[] {
  return chunksCovering(sceneBoundsM).map((key) =>
    buildTerrainChunk(source, key, sceneBoundsM, pixelsPerMetre)
  );
}

