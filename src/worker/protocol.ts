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
import type { Rect, Vec2 } from "../core/geom/types.js";
import type { CitySourceV2 } from "../core/gen/terrain.js";
import { coastalLand, normalizeCitySeed, rectangleLand, type CoastEdge } from "../core/gen/terrain.js";
import type { CitySourceV2 as CitySourceV2Roads, RoadLayout, HubMode, RoadSource } from "../core/gen/city.js";
import type { CitySourceV4, DistrictOpenSpaceProfile, DistrictSource } from "../core/gen/city.js";
import { validateCitySourceV4 } from "../core/gen/city.js";
import type { DistrictTypeId } from "../core/gen/district-registry.js";
import { buildDistrictPlan, type DistrictPlan } from "../core/gen/district-plan.js";
import { assignLandmarkCompatibleDistrictTypes, generateInitialDistricts } from "../core/gen/district-generator.js";
import {
  buildCompleteCityPlan,
  reserveMajorLandmarkSites,
  validateCompleteCityPlan,
  type CompleteCityPlan
} from "../core/gen/complete-city-plan.js";
import {
  buildCompleteCityChunks,
  openCompleteCityChunkBatch,
  type CompleteChunkBatch,
  type CompleteChunkBuild
} from "../core/gen/complete-city-chunk.js";

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

export interface BuildDistrictPlanRequest {
  id: number;
  type: "buildDistrictPlan";
  source: CitySourceV4;
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
}

export interface GenerateInitialDistrictsRequest {
  id: number;
  type: "generateInitialDistricts";
  source: CitySourceV4;
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
}

/**
 * Staged full-generation configuration. The Worker composes the complete revision-1 source
 * candidate from these settings (terrain -> initial roads -> initial districts -> plan), so
 * no existing source is required. Identity uses an absent-generation token instead of a
 * source revision because full generation starts from the absent state.
 */
export interface CompleteCityStaging {
  origin: Vec2;
  sceneBoundsM: Rect;
  citySeed: string;
  terrainMode: "rectangle" | "coastal";
  coastEdge: CoastEdge | null;
  roadLayout: RoadLayout;
  hubMode: HubMode;
  districtPool: DistrictTypeId[];
  openSpaceProfile: DistrictOpenSpaceProfile;
}

export interface GenerateCompleteCityPlanRequest {
  id: number;
  type: "generateCompleteCityPlan";
  staging: CompleteCityStaging;
  absentGenerationToken: number | string;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
}

export interface BuildCompleteCityPlanRequest {
  id: number;
  type: "buildCompleteCityPlan";
  source: CitySourceV4;
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
}

export interface BuildCompleteCityChunksRequest {
  id: number;
  type: "buildCompleteCityChunks";
  source: CitySourceV4;
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
  plan: CompleteCityPlan;
  sceneBoundsM: Rect;
  pixelsPerMetre: number;
  keys: ChunkKey[];
}

export type GenerateRoadNetworkRequest = GenerateInitialRoadNetworkRequest;

/** Extend by adding an interface with its own `type` literal and unioning it here. */
export type WorkerRequest = PingRequest | BuildTerrainChunkRequest | BuildCityChunksRequest | GenerateInitialRoadNetworkRequest | BuildDistrictPlanRequest | GenerateInitialDistrictsRequest | GenerateCompleteCityPlanRequest | BuildCompleteCityPlanRequest | BuildCompleteCityChunksRequest;

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

export interface BuildDistrictPlanResult {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  plan: DistrictPlan;
}

export interface GenerateInitialDistrictsResult {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  districts: DistrictSource[];
}

export interface CompleteCityPlanCounts {
  districtCount: number;
  blockCount: number;
  parcelCount: number;
  openSpaceCount: number;
  buildingCount: number;
  massCount: number;
  landmarkCount: number;
}

export interface GenerateCompleteCityPlanResult {
  sourceRevision: number;
  absentGenerationToken: number | string;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
  candidate: CitySourceV4;
  plan: CompleteCityPlan;
  counts: CompleteCityPlanCounts;
  validation: string[];
}

export interface BuildCompleteCityPlanResult {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
  plan: CompleteCityPlan;
  validation: string[];
}

export interface CompleteCityChunkCounters {
  requested: number;
  built: number;
  vertexCount: number;
  triangleCount: number;
  bytes: number;
  markingTriangleCount: number;
  buildingCount: number;
  landmarkCount: number;
  openSpaceCount: number;
}

export interface BuildCompleteCityChunksResult {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
  chunks: CompleteChunkBuild[];
  counters: CompleteCityChunkCounters;
}

/** The final summary posted after every chunk progress message; what the client resolves with. */
export interface BuildCompleteCityChunksSummary {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
  counters: CompleteCityChunkCounters;
}

/** One chunk delivered progressively before the final summary. */
export interface CompleteCityChunkProgress {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
  index: number;
  total: number;
  chunk: CompleteChunkBuild;
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

/** Request-scoped progress: more messages for the same id may follow before the settle. */
export interface WorkerProgress {
  id: number;
  ok: true;
  progress: true;
  result: CompleteCityChunkProgress;
  transfer?: ArrayBuffer[];
}

/** Identity echoed back on failure responses so the caller can attribute the failure. */
export interface WorkerFailureIdentity {
  sourceRevision?: number;
  absentGenerationToken?: number | string;
  actionToken?: number | string;
  buildToken?: number | string;
  epoch?: number;
}

export interface WorkerFailure extends WorkerFailureIdentity {
  id: number;
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;

/** Everything the worker may post for one request id, in order: progress..., settle. */
export type WorkerMessage = WorkerResponse | WorkerProgress;

/** The identity fields applicable to a request's failure response, mirroring its success result. */
function failureIdentity(request: WorkerRequest): WorkerFailureIdentity {
  switch (request.type) {
    case "ping":
      return {};
    case "buildTerrainChunk":
      return { sourceRevision: request.sourceRevision };
    case "buildCityChunks":
    case "generateInitialRoadNetwork":
    case "buildDistrictPlan":
    case "generateInitialDistricts":
      return {
        sourceRevision: request.sourceRevision,
        actionToken: request.actionToken,
        buildToken: request.buildToken
      };
    case "generateCompleteCityPlan":
      return {
        absentGenerationToken: request.absentGenerationToken,
        actionToken: request.actionToken,
        buildToken: request.buildToken,
        epoch: request.epoch
      };
    case "buildCompleteCityPlan":
    case "buildCompleteCityChunks":
      return {
        sourceRevision: request.sourceRevision,
        actionToken: request.actionToken,
        buildToken: request.buildToken,
        epoch: request.epoch
      };
    default:
      // Unknown request type: no identity fields apply.
      return {};
  }
}

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
      case "buildDistrictPlan": {
        const plan = buildDistrictPlan(request.source);
        const result: BuildDistrictPlanResult = {
          sourceRevision: request.sourceRevision,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          plan
        };
        return { id: request.id, ok: true, result };
      }
      case "generateInitialDistricts": {
        const result: GenerateInitialDistrictsResult = {
          sourceRevision: request.sourceRevision,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          districts: generateInitialDistricts(request.source)
        };
        return { id: request.id, ok: true, result };
      }
      case "generateCompleteCityPlan": {
        const { staging } = request;
        if (staging.terrainMode === "coastal" && staging.coastEdge === null) {
          throw new Error("Coastal full generation requires a coast edge.");
        }
        const citySeed = normalizeCitySeed(staging.citySeed);
        const land =
          staging.terrainMode === "coastal"
            ? coastalLand(staging.sceneBoundsM, citySeed, staging.coastEdge!)
            : rectangleLand(staging.sceneBoundsM);
        const source: CitySourceV4 = {
          origin: staging.origin,
          citySeed,
          generation: {
            terrainMode: staging.terrainMode,
            coastEdge: staging.coastEdge,
            roadLayout: staging.roadLayout,
            hubMode: staging.hubMode,
            districtPool: [...staging.districtPool],
            openSpaceProfile: staging.openSpaceProfile
          },
          terrain: { land, urbanFootprint: null },
          roads: { nodes: [], routes: [], edges: [] },
          districts: [],
          architecture: { buildings: [], places: [], overrides: [] }
        };
        // Major landmark sites are reserved before local roads so ordinary road occupancy
        // never claims them; the same reservations feed the plan verbatim.
        const reservedSites = reserveMajorLandmarkSites(source);
        const generated = generateInitialRoadNetwork({
          citySeed,
          mask: land,
          land,
          layout: staging.roadLayout,
          hubMode: staging.hubMode,
          sceneBounds: staging.sceneBoundsM,
          reservedSites: reservedSites.map((reservation) => reservation.sitePolygon)
        });
        source.roads = generated.roads;
        source.districts = generateInitialDistricts(source);
        // Landmark compatibility at the source: every district holding a reserved site gets
        // a type whose compatibility tags satisfy the contained reservations, so full
        // generation does not degrade every tag mismatch into deterministic contrast.
        const assignment = assignLandmarkCompatibleDistrictTypes(
          source.districts,
          reservedSites.map((reservation) => ({ grammarId: reservation.grammarId, sitePolygon: reservation.sitePolygon })),
          staging.districtPool,
          `${citySeed}/landmarks/v3/district-assignment`
        );
        source.districts = assignment.districts;
        const plan = buildCompleteCityPlan(source, 1, request.epoch, reservedSites);
        // Unresolvable multi-site conflicts keep deterministic contrast; surface them on
        // the plan's diagnostics so the adapter can report them without a new wire field.
        if (assignment.warnings.length > 0) plan.diagnostics.warnings.push(...assignment.warnings);
        const result: GenerateCompleteCityPlanResult = {
          sourceRevision: 1,
          absentGenerationToken: request.absentGenerationToken,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          epoch: request.epoch,
          candidate: source,
          plan,
          counts: {
            districtCount: source.districts.length,
            blockCount: plan.diagnostics.blockCount,
            parcelCount: plan.diagnostics.parcelCount,
            openSpaceCount: plan.diagnostics.openSpaceCount,
            buildingCount: plan.diagnostics.buildingCount,
            massCount: plan.diagnostics.massCount,
            landmarkCount: plan.diagnostics.landmarkCount
          },
          validation: [...validateCitySourceV4(source), ...validateCompleteCityPlan(plan)]
        };
        return { id: request.id, ok: true, result };
      }
      case "buildCompleteCityPlan": {
        const plan = buildCompleteCityPlan(request.source, request.sourceRevision, request.epoch);
        const result: BuildCompleteCityPlanResult = {
          sourceRevision: request.sourceRevision,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          epoch: request.epoch,
          plan,
          validation: validateCompleteCityPlan(plan)
        };
        return { id: request.id, ok: true, result };
      }
      case "buildCompleteCityChunks": {
        const batch = buildCompleteCityChunks(
          request.source,
          request.plan,
          request.keys,
          request.sceneBoundsM,
          request.pixelsPerMetre
        );
        const result: BuildCompleteCityChunksResult = {
          sourceRevision: request.sourceRevision,
          actionToken: request.actionToken,
          buildToken: request.buildToken,
          epoch: request.epoch,
          chunks: batch.chunks,
          counters: {
            requested: request.keys.length,
            built: batch.chunks.length,
            vertexCount: batch.vertexCount,
            triangleCount: batch.triangleCount,
            bytes: batch.bytes,
            markingTriangleCount: batch.markingTriangleCount,
            buildingCount: batch.buildingCount,
            landmarkCount: batch.landmarkCount,
            openSpaceCount: batch.openSpaceCount
          }
        };
        const transfer: ArrayBuffer[] = [];
        for (const chunk of result.chunks) {
          transfer.push(
            chunk.mesh.vertices.buffer as ArrayBuffer,
            chunk.mesh.indices.buffer as ArrayBuffer,
            chunk.detail.vertices.buffer as ArrayBuffer,
            chunk.detail.indices.buffer as ArrayBuffer,
            chunk.neon.vertices.buffer as ArrayBuffer,
            chunk.neon.indices.buffer as ArrayBuffer
          );
        }
        return { id: request.id, ok: true, result, transfer };
      }
      default:
        throw new Error(`unknown request type: ${String((request as WorkerRequest).type)}`);
    }
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...failureIdentity(request)
    };
  }
}

/** Where a worker message is posted; the real worker posts to `self`, tests record. */
export interface WorkerSink {
  post(message: WorkerMessage, transfer?: ArrayBuffer[]): void;
}

/** The batch factory `handleWorkerMessage` drains; injectable so tests can instrument. */
export type OpenCompleteCityChunkBatch = typeof openCompleteCityChunkBatch;

/**
 * The worker entry: dispatches every request to the pure `handleRequest`, except
 * `buildCompleteCityChunks`, which is executed incrementally — the plan is validated and
 * the shared city surfaces compiled once up front, then each key is built and its progress
 * posted (with that chunk's own transfer list) before the next key is built. Only summary
 * counters and identity accumulate; the final success is posted only after every progress
 * message, and a mid-stream failure posts a failure instead. The sink owns the messaging,
 * so this stays pure and testable under plain node.
 */
export async function handleWorkerMessage(
  sink: WorkerSink,
  request: WorkerRequest,
  openBatch: OpenCompleteCityChunkBatch = openCompleteCityChunkBatch
): Promise<void> {
  if (request.type !== "buildCompleteCityChunks") {
    const response = handleRequest(request);
    sink.post(response, response.ok && response.transfer ? response.transfer : undefined);
    return;
  }
  const identity = {
    sourceRevision: request.sourceRevision,
    actionToken: request.actionToken,
    buildToken: request.buildToken,
    epoch: request.epoch
  };
  const total = request.keys.length;
  const counters: CompleteCityChunkCounters = {
    requested: total,
    built: 0,
    vertexCount: 0,
    triangleCount: 0,
    bytes: 0,
    markingTriangleCount: 0,
    buildingCount: 0,
    landmarkCount: 0,
    openSpaceCount: 0
  };
  // Validation happens before any chunk is built or any progress posted: a bad plan or
  // source must fail the request before its first progress message.
  let batch: CompleteChunkBatch;
  try {
    batch = openBatch(
      request.source,
      request.plan,
      request.keys,
      request.sceneBoundsM,
      request.pixelsPerMetre
    );
  } catch (err) {
    sink.post({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err), ...identity });
    return;
  }
  let index = 0;
  try {
    while (batch.remaining > 0) {
      const chunk = batch.buildNext();
      counters.built += 1;
      counters.vertexCount += chunk.mesh.vertexCount + chunk.detail.vertexCount + chunk.neon.vertexCount;
      counters.triangleCount += chunk.mesh.triangleCount + chunk.detail.triangleCount + chunk.neon.triangleCount;
      counters.bytes +=
        chunk.mesh.vertices.byteLength + chunk.mesh.indices.byteLength +
        chunk.detail.vertices.byteLength + chunk.detail.indices.byteLength +
        chunk.neon.vertices.byteLength + chunk.neon.indices.byteLength;
      counters.markingTriangleCount += chunk.markingTriangleCount;
      counters.buildingCount += chunk.buildingCount;
      counters.landmarkCount += chunk.landmarkCount;
      counters.openSpaceCount += chunk.openSpaceCount;
      sink.post(
        {
          id: request.id,
          ok: true,
          progress: true,
          result: { ...identity, index, total, chunk }
        },
        [
          chunk.mesh.vertices.buffer as ArrayBuffer,
          chunk.mesh.indices.buffer as ArrayBuffer,
          chunk.detail.vertices.buffer as ArrayBuffer,
          chunk.detail.indices.buffer as ArrayBuffer,
          chunk.neon.vertices.buffer as ArrayBuffer,
          chunk.neon.indices.buffer as ArrayBuffer
        ]
      );
      index += 1;
      // WHY: yield to the event loop so the main thread drains this chunk's progress before
      // the next chunk is built; a synchronous loop queues every message and the UI only
      // sees the first one after the whole city is built.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    sink.post({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err), ...identity });
    return;
  }
  sink.post({
    id: request.id,
    ok: true,
    result: { ...identity, counters } satisfies BuildCompleteCityChunksSummary
  });
}
