/**
 * Wire format between the main thread and the generation worker.
 *
 * Pure: no `self`, no `postMessage`, no DOM. The worker entry owns the messaging so this
 * dispatcher stays testable under plain node.
 */

import { buildTerrainChunk } from "../core/gen/terrain-chunk.js";
import type { ChunkKey } from "../core/gen/chunks.js";
import type { Rect } from "../core/geom/types.js";
import type { CitySourceV2 } from "../core/gen/terrain.js";

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

/** Extend by adding an interface with its own `type` literal and unioning it here. */
export type WorkerRequest = PingRequest | BuildTerrainChunkRequest;

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
