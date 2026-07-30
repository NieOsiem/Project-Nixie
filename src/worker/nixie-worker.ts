import { handleRequest, type WorkerRequest } from "./protocol.js";

// WHY: tsconfig ships lib "DOM" but not "WebWorker", so `self` types as a Window and its
// postMessage signature is the wrong one. Narrow to the shape actually used.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

ctx.onmessage = (event) => {
  const response = handleRequest(event.data);
  ctx.postMessage(response, response.ok && response.transfer ? response.transfer : []);
};
