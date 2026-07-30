import { describe, expect, it } from "vitest";
import { handleRequest, type WorkerRequest } from "./protocol.js";

describe("handleRequest", () => {
  it("echoes a ping payload and its id", () => {
    expect(handleRequest({ id: 3, type: "ping", payload: { hello: "nixie" } })).toEqual({
      id: 3,
      ok: true,
      result: { hello: "nixie" }
    });
  });

  it("echoes the id of every request", () => {
    for (const id of [0, 1, 999]) {
      const response = handleRequest({ id, type: "ping", payload: null });
      expect(response.id).toBe(id);
    }
  });

  it("declares no transferables for a request that produces none", () => {
    const response = handleRequest({ id: 1, type: "ping", payload: null });
    expect(response.ok && response.transfer).toBeUndefined();
  });

  it("passes an ArrayBuffer payload through untouched", () => {
    const buffer = new ArrayBuffer(8);
    const response = handleRequest({ id: 1, type: "ping", payload: buffer });
    expect(response.ok && response.result).toBe(buffer);
  });

  it("turns a thrown handler into a failure response instead of throwing", () => {
    const bogus = { id: 42, type: "not-a-real-type" } as unknown as WorkerRequest;
    const response = handleRequest(bogus);
    expect(response).toEqual({
      id: 42,
      ok: false,
      error: "unknown request type: not-a-real-type"
    });
  });

  it("is pure — no self or postMessage reference", () => {
    expect(handleRequest.toString()).not.toMatch(/\bself\b|postMessage/);
  });
});
