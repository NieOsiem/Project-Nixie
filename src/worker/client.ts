import { MODULE_ID } from "../constants.js";
import type {
  BuildCityChunksRequest,
  BuildCityChunksResult,
  BuildTerrainChunkRequest,
  BuildTerrainChunkResult,
  BuildDistrictPlanRequest,
  BuildDistrictPlanResult,
  BuildCompleteCityPlanRequest,
  BuildCompleteCityPlanResult,
  BuildCompleteCityChunksRequest,
  BuildCompleteCityChunksSummary,
  CompleteCityChunkProgress,
  GenerateInitialDistrictsRequest,
  GenerateInitialDistrictsResult,
  GenerateInitialRoadNetworkRequest,
  GenerateInitialRoadNetworkResult,
  GenerateCompleteCityPlanRequest,
  GenerateCompleteCityPlanResult,
  WorkerMessage,
  WorkerRequest
} from "./protocol.js";

/** A request with the id stripped — `WorkerClient` assigns it. Distributes over the union. */
export type RequestBody<T extends WorkerRequest = WorkerRequest> = T extends T
  ? Omit<T, "id">
  : never;

export function workerUrl(): string {
  // WHY: resolved against the page (/game) rather than the origin, so a server
  // ROUTE_PREFIX is picked up without reading a Foundry global.
  return new URL(`modules/${MODULE_ID}/dist/nixie-worker.mjs`, document.baseURI).href;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: CompleteCityChunkProgress) => void;
}

export class WorkerClient {
  #worker: Worker | null;
  #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(url: string = workerUrl()) {
    const worker = new Worker(url, { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => this.#settle(event.data);
    worker.onerror = (event) => this.#rejectAll(new Error(event.message || "worker error"));
    worker.onmessageerror = () => this.#rejectAll(new Error("worker message was not readable"));
    this.#worker = worker;
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  request(body: RequestBody, onProgress?: (progress: CompleteCityChunkProgress) => void): Promise<unknown> {
    const worker = this.#worker;
    if (!worker) return Promise.reject(new Error("worker terminated"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress });
      try {
        worker.postMessage({ ...body, id });
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  buildTerrainChunk(
    body: Omit<BuildTerrainChunkRequest, "id" | "type">
  ): Promise<BuildTerrainChunkResult> {
    return this.request({ ...body, type: "buildTerrainChunk" }) as Promise<BuildTerrainChunkResult>;
  }

  buildCityChunks(
    body: Omit<BuildCityChunksRequest, "id" | "type">
  ): Promise<BuildCityChunksResult> {
    return this.request({ ...body, type: "buildCityChunks" }) as Promise<BuildCityChunksResult>;
  }

  generateInitialRoadNetwork(
    body: Omit<GenerateInitialRoadNetworkRequest, "id" | "type">
  ): Promise<GenerateInitialRoadNetworkResult> {
    return this.request({ ...body, type: "generateInitialRoadNetwork" }) as Promise<GenerateInitialRoadNetworkResult>;
  }

  buildDistrictPlan(
    body: Omit<BuildDistrictPlanRequest, "id" | "type">
  ): Promise<BuildDistrictPlanResult> {
    return this.request({ ...body, type: "buildDistrictPlan" }) as Promise<BuildDistrictPlanResult>;
  }

  generateInitialDistricts(
    body: Omit<GenerateInitialDistrictsRequest, "id" | "type">
  ): Promise<GenerateInitialDistrictsResult> {
    return this.request({ ...body, type: "generateInitialDistricts" }) as Promise<GenerateInitialDistrictsResult>;
  }

  /** Full generation: Worker composes the revision-1 source candidate and its complete plan. */
  generateCompleteCityPlan(
    body: Omit<GenerateCompleteCityPlanRequest, "id" | "type">
  ): Promise<GenerateCompleteCityPlanResult> {
    return this.request({ ...body, type: "generateCompleteCityPlan" }) as Promise<GenerateCompleteCityPlanResult>;
  }

  /** Ordinary structural edit: candidate source in, validated complete plan out. */
  buildCompleteCityPlan(
    body: Omit<BuildCompleteCityPlanRequest, "id" | "type">
  ): Promise<BuildCompleteCityPlanResult> {
    return this.request({ ...body, type: "buildCompleteCityPlan" }) as Promise<BuildCompleteCityPlanResult>;
  }

  /** Progressive final chunks. Each chunk arrives as `onProgress`; the promise resolves with the final summary. */
  buildCompleteCityChunks(
    body: Omit<BuildCompleteCityChunksRequest, "id" | "type">,
    onProgress?: (progress: CompleteCityChunkProgress) => void
  ): Promise<BuildCompleteCityChunksSummary> {
    return this.request({ ...body, type: "buildCompleteCityChunks" }, onProgress) as Promise<BuildCompleteCityChunksSummary>;
  }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectAll(new Error("worker terminated"));
  }

  #settle(message: WorkerMessage): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    // WHY: progress remains pending until its final summary; stragglers after settlement are ignored.
    if (message.ok && "progress" in message && message.progress === true) {
      try {
        pending.onProgress?.(message.result);
      } catch (err) {
        // WHY: leaving a failed install callback pending lets the final summary falsely report success.
        this.#pending.delete(message.id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  #rejectAll(reason: Error): void {
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }
}
