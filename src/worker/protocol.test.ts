import { describe, expect, it } from "vitest";
import { chunkMarginM } from "../core/gen/chunked.js";
import { chunkRect, type ChunkKey } from "../core/gen/chunks.js";
import { cityBounds, demoCity } from "../core/gen/demo-city.js";
import { VERTEX_FLOATS } from "../core/geom/mesh.js";
import {
  handleRequest,
  type BuildChunkRequest,
  type BuildChunkResult,
  type WorkerRequest,
  type WorkerSuccess
} from "./protocol.js";

const PPM = 25;
const KEY: ChunkKey = { cx: -1, cy: -1 };

function buildChunkRequest(id = 1, key: ChunkKey = KEY): BuildChunkRequest {
  const params = demoCity({ x: 5000, y: 4000 });
  return {
    id,
    type: "buildChunk",
    params,
    key,
    cityBoundsM: cityBounds(params, chunkMarginM(params))!,
    pixelsPerMetre: PPM
  };
}

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

describe("handleRequest buildChunk", () => {
  const response = handleRequest(buildChunkRequest(7)) as WorkerSuccess;
  const result = response.result as BuildChunkResult;

  it("succeeds and echoes the request id and chunk identity", () => {
    expect(response.ok).toBe(true);
    expect(response.id).toBe(7);
    expect(result.key).toEqual(KEY);
    expect(result.chunkId).toBe("-1,-1");
  });

  it("returns a non-empty, internally consistent mesh", () => {
    expect(result.vertexCount).toBeGreaterThan(0);
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.indices.length).toBe(result.triangleCount * 3);
    expect(result.vertices.length).toBe(result.vertexCount * VERTEX_FLOATS);
    expect(result.indices.reduce((max, i) => (i > max ? i : max), 0)).toBeLessThan(
      result.vertexCount
    );
  });

  it("returns bounds in metres covering at least the chunk rect", () => {
    const rect = chunkRect(KEY);
    expect(result.boundsM.x).toBeLessThanOrEqual(rect.x);
    expect(result.boundsM.y).toBeLessThanOrEqual(rect.y);
    expect(result.boundsM.x + result.boundsM.width).toBeGreaterThanOrEqual(rect.x + rect.width);
    expect(result.boundsM.y + result.boundsM.height).toBeGreaterThanOrEqual(rect.y + rect.height);
    expect(Number.isFinite(result.boundsM.width)).toBe(true);
    expect(Number.isFinite(result.boundsM.height)).toBe(true);
  });

  it("returns an internally consistent neon mesh", () => {
    expect(result.neonIndices.length).toBe(result.neonTriangleCount * 3);
    expect(result.neonVertices.length).toBe(result.neonVertexCount * VERTEX_FLOATS);
    expect(result.neonIndices.reduce((max, i) => (i > max ? i : max), 0)).toBeLessThanOrEqual(
      Math.max(0, result.neonVertexCount - 1)
    );
  });

  it("declares exactly the four mesh ArrayBuffers as transferables", () => {
    expect(response.transfer).toEqual([
      result.vertices.buffer,
      result.indices.buffer,
      result.neonVertices.buffer,
      result.neonIndices.buffer
    ]);
    expect(response.transfer).toHaveLength(4);
    for (const buffer of response.transfer!) expect(buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("gives every transferable its own buffer, or postMessage would throw on the duplicate", () => {
    expect(new Set(response.transfer!).size).toBe(response.transfer!.length);
  });

  it("drops the surfaces and buildings the renderer does not need", () => {
    expect(result).not.toHaveProperty("surfaces");
    expect(result).not.toHaveProperty("buildings");
    expect(result.buildingCount).toBeGreaterThan(0);
  });

  it("turns malformed params into a failure response instead of throwing", () => {
    const bogus = { ...buildChunkRequest(9), params: {} } as unknown as WorkerRequest;
    const failure = handleRequest(bogus);
    expect(failure.ok).toBe(false);
    expect(failure.id).toBe(9);
    expect(!failure.ok && failure.error.length).toBeGreaterThan(0);
  });
});
