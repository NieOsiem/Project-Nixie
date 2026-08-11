import { handleWorkerMessage, type WorkerMessage, type WorkerRequest } from "./protocol.js";

// WHY: tsconfig ships lib "DOM" but not "WebWorker", so `self` types as a Window and its
// postMessage signature is the wrong one. Narrow to the shape actually used.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerMessage, transfer: Transferable[]) => void;
};

const sink = {
  post(message: WorkerMessage, transfer?: ArrayBuffer[]): void {
    ctx.postMessage(message, transfer ?? []);
  }
};

ctx.onmessage = (event) => {
  handleWorkerMessage(sink, event.data).catch((err) => {
    ctx.postMessage(
      { id: event.data.id, ok: false, error: err instanceof Error ? err.message : String(err) },
      []
    );
  });
};
