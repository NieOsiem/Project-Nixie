import { describe, expect, it } from "vitest";
import { rectangleLand, type CitySourceV2 } from "../core/gen/terrain.js";
import { VERTEX_FLOATS } from "../core/geom/mesh.js";
import {
  type BuildTerrainChunkRequest,
  type BuildTerrainChunkResult,
  handleRequest,
  type WorkerRequest,
  type WorkerSuccess
} from "./protocol.js";

const TERRAIN_SOURCE: CitySourceV2 = {
  origin: { x: 5000, y: 4000 },
  citySeed: "protocol-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null },
  terrain: { land: rectangleLand({ x: -96, y: -96, width: 192, height: 192 }), urbanFootprint: null }
};

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

describe("handleRequest buildTerrainChunk", () => {
  const request: BuildTerrainChunkRequest = {
    id: 21,
    type: "buildTerrainChunk",
    source: TERRAIN_SOURCE,
    sourceRevision: 14,
    key: { cx: 0, cy: 0 },
    sceneBoundsM: { x: -128, y: -128, width: 256, height: 256 },
    pixelsPerMetre: 25
  };
  const response = handleRequest(request) as WorkerSuccess;
  const result = response.result as BuildTerrainChunkResult;

  it("echoes the source revision and chunk identity", () => {
    expect(response.ok).toBe(true);
    expect(response.id).toBe(request.id);
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.chunkId).toBe("0,0");
    expect(result.key).toEqual(request.key);
  });

  it("returns a consistent flat terrain mesh", () => {
    expect(result.vertexCount).toBeGreaterThan(0);
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.vertices.length).toBe(result.vertexCount * VERTEX_FLOATS);
    expect(result.indices.length).toBe(result.triangleCount * 3);
    expect(result.indices.reduce((max, i) => Math.max(max, i), 0)).toBeLessThan(result.vertexCount);
    expect(result.landTriangleCount).toBeGreaterThan(0);
    expect(result.waterTriangleCount).toBeGreaterThan(0);
  });

  it("transfers exactly the independent vertex and index buffers", () => {
    expect(response.transfer).toEqual([result.vertices.buffer, result.indices.buffer]);
    expect(response.transfer).toHaveLength(2);
    expect(new Set(response.transfer!).size).toBe(2);
    for (const buffer of response.transfer!) expect(buffer).toBeInstanceOf(ArrayBuffer);
  });
});
