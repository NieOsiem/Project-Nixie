import { describe, expect, it } from "vitest";
import { rectangleLand, type CitySourceV2 } from "../core/gen/terrain.js";
import { VERTEX_FLOATS } from "../core/geom/mesh.js";
import {
  type BuildCityChunksRequest,
  type BuildCityChunksResult,
  type BuildTerrainChunkRequest,
  type BuildTerrainChunkResult,
  type GenerateInitialRoadNetworkRequest,
  type GenerateInitialRoadNetworkResult,
  handleRequest,
  type WorkerRequest,
  type WorkerSuccess
} from "./protocol.js";
import type { CitySourceV2 as CitySourceV2Roads } from "../core/gen/city.js";

const TERRAIN_SOURCE: CitySourceV2 = {
  origin: { x: 5000, y: 4000 },
  citySeed: "protocol-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null },
  terrain: { land: rectangleLand({ x: -96, y: -96, width: 192, height: 192 }), urbanFootprint: null }
};

const CITY_SOURCE: CitySourceV2Roads = {
  origin: { x: 5000, y: 4000 },
  citySeed: "protocol-city-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
  terrain: { land: rectangleLand({ x: -96, y: -96, width: 192, height: 192 }), urbanFootprint: null },
  roads: {
    nodes: [{ id: "a", x: -96, y: 0 }, { id: "b", x: 96, y: 0 }],
    routes: [{ id: "r", curvePreset: "standard" }],
    edges: [{ id: "e", a: "a", b: "b", routeId: "r", classId: "street", name: null, locked: false, origin: "authored" }]
  }
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

describe("handleRequest buildCityChunks", () => {
  const request: BuildCityChunksRequest = {
    id: 71,
    type: "buildCityChunks",
    source: CITY_SOURCE,
    sourceRevision: 9,
    actionToken: "action-3",
    buildToken: 42,
    sceneBoundsM: { x: -96, y: -96, width: 192, height: 192 },
    pixelsPerMetre: 2,
    keys: [{ cx: -1, cy: -1 }, { cx: 0, cy: -1 }, { cx: -1, cy: 0 }, { cx: 0, cy: 0 }]
  };

  it("echoes revision, action, build token and requested chunk identities", () => {
    const response = handleRequest(request) as WorkerSuccess;
    expect(response.ok).toBe(true);
    const result = response.result as BuildCityChunksResult;
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(request.keys.map((key) => `${key.cx},${key.cy}`));
    expect(result.counters.requested).toBe(request.keys.length);
    expect(result.counters.markingTriangleCount).toBe(
      result.chunks.reduce((sum, chunk) => sum + chunk.markingTriangleCount, 0)
    );
  });

  it("transfers every chunk vertex and index buffer and no unrelated buffer", () => {
    const response = handleRequest(request) as WorkerSuccess;
    const result = response.result as BuildCityChunksResult;
    const expected = result.chunks.flatMap((chunk) => [chunk.mesh.vertices.buffer, chunk.mesh.indices.buffer]);
    expect(response.transfer).toEqual(expected);
    expect(response.transfer).toHaveLength(result.chunks.length * 2);
    expect(new Set(response.transfer!).size).toBe(response.transfer!.length);
  });
});

describe("handleRequest generateInitialRoadNetwork", () => {
  const request: GenerateInitialRoadNetworkRequest = {
    id: 81,
    type: "generateInitialRoadNetwork",
    input: {
      citySeed: "phase2-generator-fixture",
      mask: rectangleLand({ x: -100, y: -80, width: 200, height: 160 }),
      land: rectangleLand({ x: -100, y: -80, width: 200, height: 160 }),
      layout: "mixed",
      hubMode: "single-centre",
      sceneBounds: { x: -100, y: -80, width: 200, height: 160 }
    },
    sourceRevision: 17,
    actionToken: "roads-action-4",
    buildToken: 99
  };

  it("returns deterministic final roads, diagnostics, config and echoed identities", () => {
    const first = handleRequest(request) as WorkerSuccess;
    const second = handleRequest({ ...request, id: request.id + 1 }) as WorkerSuccess;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const result = first.result as GenerateInitialRoadNetworkResult;
    const repeat = second.result as GenerateInitialRoadNetworkResult;
    expect(result).toEqual(repeat);
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.config).toEqual({ layout: "mixed", hubMode: "single-centre" });
    expect(result.roads.edges.length).toBeGreaterThan(0);
    expect(result.diagnostics.layout).toBe(result.config.layout);
    expect(result.diagnostics.hubMode).toBe(result.config.hubMode);
    expect(first.transfer).toBeUndefined();
  });

  it("returns a failure response when generation rejects the input", () => {
    const response = handleRequest({
      ...request,
      id: 82,
      input: { ...request.input, mask: [] }
    });
    expect(response).toEqual({
      id: 82,
      ok: false,
      error: "Road generation requires a non-empty mask."
    });
  });
});
