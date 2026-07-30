/**
 * Wire format between the main thread and the generation worker.
 *
 * Pure: no `self`, no `postMessage`, no DOM. The worker entry owns the messaging so this
 * dispatcher stays testable under plain node.
 */

export interface PingRequest {
  id: number;
  type: "ping";
  payload: unknown;
}

/** Extend by adding an interface with its own `type` literal and unioning it here. */
export type WorkerRequest = PingRequest;

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
