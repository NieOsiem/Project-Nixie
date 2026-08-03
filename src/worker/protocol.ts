/**
 * Wire format between the main thread and the generation worker.
 *
 * Pure: no `self`, no `postMessage`, no DOM. The worker entry owns the messaging so this
 * dispatcher stays testable under plain node.
 */

import { buildTerrainChunk } from "../core/gen/terrain-chunk.js";
import { buildCityChunks, type CityChunkBuild } from "../core/gen/city-chunk.js";
import { generateInitialRoadNetwork, type RoadGenerationInput, type RoadGenerationDiagnostics } from "../core/gen/road-generator.js";
import type { ChunkKey } from "../core/gen/chunks.js";
import type { Rect } from "../core/geom/types.js";
import type { CitySourceV2 } from "../core/gen/terrain.js";
import type { CitySourceV2 as CitySourceV2Roads, RoadLayout, HubMode, RoadSource } from "../core/gen/city.js";

export interface PingRequest {
  id: number;
  type: "ping";
  payload: unknown;
}

export interface BuildTerrainChunkRequest {
  id: number;
  type: "buildTerrainChunk";
  source: CitySourceV2;
  sourceRevision: number;
  key: ChunkKey;
  sceneBoundsM: Rect;
  pixelsPerMetre: number;
}

export interface BuildCityChunksRequest {
  id: number;
  type: "buildCityChunks";
  source: CitySourceV2Roads;
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  sceneBoundsM: Rect;
  pixelsPerMetre: number;
  keys: ChunkKey[];
}

export interface GenerateInitialRoadNetworkRequest {
  id: number;
  type: "generateInitialRoadNetwork";
  input: RoadGenerationInput;
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
}

export type GenerateRoadNetworkRequest = GenerateInitialRoadNetworkRequest;

/** Extend by adding an interface with its own `type` literal and unioning it here. */
export type WorkerRequest = PingRequest | BuildTerrainChunkRequest | BuildCityChunksRequest | GenerateInitialRoadNetworkRequest;

export interface BuildTerrainChunkResult {
  sourceRevision: number;
  key: ChunkKey;
  chunkId: string;
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  boundsM: Rect;
  landTriangleCount: number;
  waterTriangleCount: number;
}

export interface BuildCityChunksResult {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  chunks: CityChunkBuild[];
  counters: {
    requested: number;
    built: number;
    vertexCount: number;
    triangleCount: number;
    bytes: number;
    compiledRoutes: number;
    compiledSegments: number;
    markingTriangleCount: number;
  };
}

export interface GenerateInitialRoadNetworkResult {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  roads: RoadSource;
  diagnostics: RoadGenerationDiagnostics;
  config: {
    layout: RoadLayout;
    hubMode: HubMode;
  };
}

export interface WorkerSuccess {
  id: number;
  ok: true;
  result: unknown;
  /**
   * WHY: SharedArrayBuffer is unavailable (crossOriginIsolated false), so transferring
   * ArrayBuffers is the only zero-copy path for mesh data leaving the worker.
   */
  transfer?: ArrayBuffer[];
}

export interface WorkerFailure {
  id: number;
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;

/** Never throws: a failing handler becomes a failure response the client can reject on. */
export function handleRequest(request: WorkerRequest): WorkerResponse {
  try {
    switch (request.type) {
      case "ping":
        return { id: request.id, ok: true, result: request.payload };
      case "buildTerrainChunk": {
        const build = buildTerrainChunk(
          request.source,
          request.key,
          request.sceneBoundsM,
          request.pixelsPerMetre
        );
        const result: BuildTerrainChunkResult = {
          sourceRevision: request.sourceRevision,
          key: build.key,
          chunkId: build.id,
          vertices: build.mesh.vertices,
          indices: build.mesh.indices,
          vertexCount: build.mesh.vertexCount,
          triangleCount: build.mesh.triangleCount,
          boundsM: build.boundsM,
          landTriangleCount: build.landTriangleCount,
          waterTriangleCount: build.waterTriangleCount
        };
        return {
          id: request.id,
          ok: true,
          result,
          transfer: [result.vertices.buffer as ArrayBuffer, result.indices.buffer as ArrayBuffer]
        };
      }
      case "buildCityChunks": {
        const batch = buildCityChunks(
          request.source,
          request.keys,
          request.sceneBoundsM,
          request.pixelsPerMetre
        );
        const result: BuildCityChunksResult = {
          sourceRevision: request.sourceRevision,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          chunks: batch.chunks,
          counters: {
            requested: request.keys.length,
            built: batch.chunks.length,
            vertexCount: batch.chunks.reduce((sum, chunk) => sum + chunk.mesh.vertexCount, 0),
            triangleCount: batch.chunks.reduce((sum, chunk) => sum + chunk.mesh.triangleCount, 0),
            bytes: batch.chunks.reduce(
              (sum, chunk) => sum + chunk.mesh.vertices.byteLength + chunk.mesh.indices.byteLength,
              0
            ),
            compiledRoutes: batch.compiledRoutes,
            compiledSegments: batch.compiledSegments,
            markingTriangleCount: batch.markingTriangleCount
          }
        };
        const transfer: ArrayBuffer[] = [];
        for (const chunk of result.chunks) {
          transfer.push(chunk.mesh.vertices.buffer as ArrayBuffer, chunk.mesh.indices.buffer as ArrayBuffer);
        }
        return { id: request.id, ok: true, result, transfer };
      }
      case "generateInitialRoadNetwork": {
        const generated = generateInitialRoadNetwork(request.input);
        const result: GenerateInitialRoadNetworkResult = {
          sourceRevision: request.sourceRevision,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          roads: generated.roads,
          diagnostics: generated.diagnostics,
          config: {
            layout: request.input.layout ?? "european",
            hubMode: request.input.hubMode ?? "single-centre"
          }
        };
        return { id: request.id, ok: true, result };
      }
      default:
        throw new Error(`unknown request type: ${String((request as WorkerRequest).type)}`);
    }
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
