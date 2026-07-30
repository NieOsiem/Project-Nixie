import { MODULE_ID } from "../constants.js";
import type {
  BuildChunkRequest,
  BuildChunkResult,
  WorkerRequest,
  WorkerResponse
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
}

export class WorkerClient {
  #worker: Worker | null;
  #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(url: string = workerUrl()) {
    const worker = new Worker(url, { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.#settle(event.data);
    worker.onerror = (event) => this.#rejectAll(new Error(event.message || "worker error"));
    worker.onmessageerror = () => this.#rejectAll(new Error("worker message was not readable"));
    this.#worker = worker;
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  request(body: RequestBody): Promise<unknown> {
    const worker = this.#worker;
    if (!worker) return Promise.reject(new Error("worker terminated"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...body, id });
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  buildChunk(body: Omit<BuildChunkRequest, "id" | "type">): Promise<BuildChunkResult> {
    return this.request({ ...body, type: "buildChunk" }) as Promise<BuildChunkResult>;
  }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#rejectAll(new Error("worker terminated"));
  }

  #settle(response: WorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  #rejectAll(reason: Error): void {
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }
}
