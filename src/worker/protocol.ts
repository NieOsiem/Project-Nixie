/**
 * Wire format between the main thread and the generation worker.
 *
 * Pure: no `self`, no `postMessage`, no DOM. The worker entry owns the messaging so this
 * dispatcher stays testable under plain node.
 */

import { buildChunk } from "../core/gen/chunked.js";
import type { ChunkKey } from "../core/gen/chunks.js";
import type { CityParams } from "../core/gen/demo-city.js";
import type { Rect } from "../core/geom/types.js";

export interface PingRequest {
  id: number;
  type: "ping";
  payload: unknown;
}

export interface BuildChunkRequest {
  id: number;
  type: "buildChunk";
  params: CityParams;
  key: ChunkKey;
  cityBoundsM: Rect;
  pixelsPerMetre: number;
}

/** Extend by adding an interface with its own `type` literal and unioning it here. */
export type WorkerRequest = PingRequest | BuildChunkRequest;

/**
 * The renderer's slice of `ChunkBuild`. `surfaces` and `buildings` are deliberately dropped:
 * they are large and only the whole-city wall pass consumes them.
 */
export interface BuildChunkResult {
  key: ChunkKey;
  chunkId: string;
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  detailVertices: Float32Array;
  detailIndices: Uint32Array;
  detailVertexCount: number;
  detailTriangleCount: number;
  neonVertices: Float32Array;
  neonIndices: Uint32Array;
  neonVertexCount: number;
  neonTriangleCount: number;
  boundsM: Rect;
  buildingCount: number;
  carCount: number;
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
      case "buildChunk": {
        const build = buildChunk(
          request.params,
          request.key,
          request.cityBoundsM,
          request.pixelsPerMetre
        );
        const result: BuildChunkResult = {
          key: build.key,
          chunkId: build.id,
          vertices: build.mesh.vertices,
          indices: build.mesh.indices,
          vertexCount: build.mesh.vertexCount,
          triangleCount: build.mesh.triangleCount,
          detailVertices: build.detail.vertices,
          detailIndices: build.detail.indices,
          detailVertexCount: build.detail.vertexCount,
          detailTriangleCount: build.detail.triangleCount,
          neonVertices: build.neon.vertices,
          neonIndices: build.neon.indices,
          neonVertexCount: build.neon.vertexCount,
          neonTriangleCount: build.neon.triangleCount,
          boundsM: build.boundsM,
          buildingCount: build.buildingCount,
          carCount: build.carCount
        };
        return {
          id: request.id,
          ok: true,
          result,
          // WHY: TypedArray.buffer widens to ArrayBufferLike; SharedArrayBuffer is unavailable here.
          // All six are exact-sized allocations, so no two share a buffer and one list is legal.
          transfer: [
            result.vertices.buffer as ArrayBuffer,
            result.indices.buffer as ArrayBuffer,
            result.detailVertices.buffer as ArrayBuffer,
            result.detailIndices.buffer as ArrayBuffer,
            result.neonVertices.buffer as ArrayBuffer,
            result.neonIndices.buffer as ArrayBuffer
          ]
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
