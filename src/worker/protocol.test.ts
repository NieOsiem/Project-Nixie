import { describe, expect, it } from "vitest";
import { rectangleLand, type CitySourceV2 } from "../core/gen/terrain.js";
import { VERTEX_FLOATS } from "../core/geom/mesh.js";
import { rectRing, ringCentroid, type Ring, type Vec2 } from "../core/geom/types.js";
import {
  type BuildCityChunksRequest,
  type BuildCityChunksResult,
  type BuildTerrainChunkRequest,
  type BuildTerrainChunkResult,
  type BuildCompleteCityChunksRequest,
  type BuildCompleteCityChunksResult,
  type BuildCompleteCityChunksSummary,
  type BuildCompleteCityPlanRequest,
  type BuildCompleteCityPlanResult,
  type CompleteCityChunkProgress,
  type GenerateCompleteCityPlanRequest,
  type GenerateCompleteCityPlanResult,
  type GenerateInitialRoadNetworkRequest,
  type GenerateInitialRoadNetworkResult,
  type BuildDistrictPlanRequest,
  type BuildDistrictPlanResult,
  type GenerateInitialDistrictsRequest,
  type GenerateInitialDistrictsResult,
  handleRequest,
  handleWorkerMessage,
  type OpenCompleteCityChunkBatch,
  type WorkerMessage,
  type WorkerSink,
  type WorkerProgress,
  type WorkerRequest,
  type WorkerSuccess
} from "./protocol.js";
import type { CitySourceV2 as CitySourceV2Roads, CitySourceV3 } from "../core/gen/city.js";
import { validateCitySourceV3 } from "../core/gen/city.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictCompatibilityTag } from "../core/gen/district-registry.js";
import { LANDMARK_GRAMMAR_REGISTRY, type LandmarkGrammarId } from "../core/gen/landmark-registry.js";
import { buildDistrictPlan } from "../core/gen/district-plan.js";
import { assignLandmarkCompatibleDistrictTypes, generateInitialDistricts } from "../core/gen/district-generator.js";
import { buildCompleteCityPlan, reserveMajorLandmarkSites, validateCompleteCityPlan } from "../core/gen/complete-city-plan.js";
import type { ChunkKey } from "../core/gen/chunks.js";
import {
  buildCompleteCityChunks,
  openCompleteCityChunkBatch,
  type CompleteChunkBatch,
  type CompleteChunkBuild
} from "../core/gen/complete-city-chunk.js";

function pointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const crosses = a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function landmarkCompatible(grammarId: LandmarkGrammarId, districtTags: readonly DistrictCompatibilityTag[]): boolean {
  const grammar = LANDMARK_GRAMMAR_REGISTRY.get(grammarId);
  if (!grammar) return false;
  return grammar.compatibilityTags.some((tag) => districtTags.includes(tag));
}

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

const DISTRICT_SOURCE: CitySourceV3 = {
  origin: { x: 5000, y: 4000 },
  citySeed: "protocol-district-fixture",
  generation: {
    terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre",
    districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium"
  },
  terrain: { land: rectangleLand({ x: -96, y: -96, width: 192, height: 192 }), urbanFootprint: null },
  roads: structuredClone(CITY_SOURCE.roads),
  districts: []
};

/**
 * A 200×200 grid-cross city with two district halves — the canonical small fixture that
 * validates as a complete plan (landmarks skip because the reserved sites are too small).
 */
const COMPLETE_SOURCE: CitySourceV3 = {
  origin: { x: 700, y: 300 },
  citySeed: "protocol-complete-cross",
  generation: {
    terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre",
    districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium"
  },
  terrain: { land: rectRing({ x: 0, y: 0, width: 200, height: 200 }), urbanFootprint: null },
  roads: {
    nodes: [
      { id: "n", x: 100, y: 0 },
      { id: "w", x: 0, y: 100 },
      { id: "c", x: 100, y: 100 },
      { id: "e", x: 200, y: 100 },
      { id: "s", x: 100, y: 200 }
    ],
    routes: [{ id: "horizontal", curvePreset: "standard" }, { id: "vertical", curvePreset: "standard" }],
    edges: [
      { id: "north", a: "n", b: "c", routeId: "vertical", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "west", a: "w", b: "c", routeId: "horizontal", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "east", a: "c", b: "e", routeId: "horizontal", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "south", a: "c", b: "s", routeId: "vertical", classId: "street", name: null, locked: false, origin: "authored" }
    ]
  },
  districts: [
    { id: "west", polygon: rectRing({ x: 0, y: 0, width: 100, height: 200 }), seed: "west-seed", typeId: "mixed-use-centre", paletteId: DISTRICT_PALETTE_IDS[2]!, origin: "generated", locked: false, openSpaceOverride: null },
    { id: "east", polygon: rectRing({ x: 100, y: 0, width: 100, height: 200 }), seed: "east-seed", typeId: "dense-residential", paletteId: DISTRICT_PALETTE_IDS[4]!, origin: "generated", locked: false, openSpaceOverride: null }
  ]
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

  it("carries the source revision identity on a failure response", () => {
    const response = handleRequest({ ...request, id: 22, pixelsPerMetre: 0 });
    expect(response).toEqual({
      id: 22,
      ok: false,
      error: "Pixels per metre must be positive and finite.",
      sourceRevision: 14
    });
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

  it("carries revision and token identity on a failure response", () => {
    const response = handleRequest({ ...request, id: 72, pixelsPerMetre: 0 });
    expect(response).toEqual({
      id: 72,
      ok: false,
      error: "Pixels per metre must be positive and finite.",
      sourceRevision: 9,
      actionToken: "action-3",
      buildToken: 42
    });
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
      error: "Road generation requires a non-empty mask.",
      sourceRevision: 17,
      actionToken: "roads-action-4",
      buildToken: 99
    });
  });
});

describe("handleRequest buildDistrictPlan", () => {
  const request: BuildDistrictPlanRequest = {
    id: 91,
    type: "buildDistrictPlan",
    source: DISTRICT_SOURCE,
    sourceRevision: 12,
    actionToken: "district-action-2",
    buildToken: "epoch-7"
  };

  it("echoes revision and action/build tokens", () => {
    const response = handleRequest(request) as WorkerSuccess;
    expect(response.ok).toBe(true);
    const result = response.result as BuildDistrictPlanResult;
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.plan.blocks.length).toBeGreaterThan(0);
    expect(result.plan).toEqual(buildDistrictPlan(DISTRICT_SOURCE));
    expect(response.transfer).toBeUndefined();
  });
});

describe("handleRequest generateInitialDistricts", () => {
  const request: GenerateInitialDistrictsRequest = {
    id: 92,
    type: "generateInitialDistricts",
    source: DISTRICT_SOURCE,
    sourceRevision: 12,
    actionToken: "district-generation-3",
    buildToken: "epoch-8"
  };

  it("echoes stale-work tokens and matches fallback generation", () => {
    const response = handleRequest(request) as WorkerSuccess;
    expect(response.ok).toBe(true);
    const result = response.result as GenerateInitialDistrictsResult;
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.districts).toEqual(generateInitialDistricts(DISTRICT_SOURCE));
    expect(response.transfer).toBeUndefined();
  });
});

describe("handleRequest generateCompleteCityPlan", () => {
  // Small enough for the deterministic full-generation pipeline to run fast while still
  // reserving major landmark sites before roads.
  const staging = {
    origin: { x: 700, y: 300 },
    sceneBoundsM: { x: 0, y: 0, width: 400, height: 300 },
    citySeed: "protocol-full-generation",
    terrainMode: "rectangle" as const,
    coastEdge: null,
    roadLayout: "european" as const,
    hubMode: "single-centre" as const,
    districtPool: [...DISTRICT_TYPE_IDS],
    openSpaceProfile: "medium" as const
  };
  const request: GenerateCompleteCityPlanRequest = {
    id: 101,
    type: "generateCompleteCityPlan",
    staging,
    absentGenerationToken: "absent-9",
    actionToken: "full-generation-action",
    buildToken: "full-generation-build",
    epoch: 4
  };

  it("composes a revision-1 candidate source and complete plan matching the pure core output", () => {
    const response = handleRequest(request) as WorkerSuccess;
    expect(response.ok).toBe(true);
    const result = response.result as GenerateCompleteCityPlanResult;
    expect(result.sourceRevision).toBe(1);
    expect(result.absentGenerationToken).toBe(request.absentGenerationToken);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.epoch).toBe(request.epoch);
    expect(result.candidate.citySeed).toBe(staging.citySeed);
    expect(result.candidate.origin).toEqual(staging.origin);
    expect(result.candidate.roads.edges.length).toBeGreaterThan(0);
    expect(result.candidate.districts.length).toBeGreaterThan(0);
    expect(result.plan.sourceRevision).toBe(1);
    expect(result.plan.epoch).toBe(request.epoch);
    // The handler must reproduce the pure core composition exactly: reservations derive
    // from terrain+seed (roads don't matter), so replaying them on the candidate yields the
    // same plan, and the reported validation is exactly the pure validators' verdict.
    const replayReservations = reserveMajorLandmarkSites(result.candidate);
    const replay = assignLandmarkCompatibleDistrictTypes(
      result.candidate.districts,
      replayReservations.map((reservation) => ({ grammarId: reservation.grammarId, sitePolygon: reservation.sitePolygon })),
      staging.districtPool,
      `${result.candidate.citySeed}/landmarks/v3/district-assignment`
    );
    const expectedPlan = buildCompleteCityPlan(result.candidate, 1, request.epoch, replayReservations);
    if (replay.warnings.length > 0) expectedPlan.diagnostics.warnings.push(...replay.warnings);
    expect(result.plan).toEqual(expectedPlan);
    expect(validateCompleteCityPlan(result.plan)).toEqual([]);
    expect(validateCitySourceV3(result.candidate)).toEqual([]);
    expect(result.validation).toEqual([]);
    expect(result.counts.districtCount).toBe(result.candidate.districts.length);
    expect(result.counts.blockCount).toBeGreaterThan(0);
    expect(result.counts.parcelCount).toBeGreaterThan(0);
    expect(response.transfer).toBeUndefined();
    // Landmark compatibility is fixed at the source: every district that holds a reserved
    // site centroid carries a compatible type when the pool permits; an unresolvable
    // multi-site conflict keeps deterministic contrast and is reported as a warning.
    for (const landmark of result.plan.landmarks) {
      const centroid = ringCentroid(landmark.sitePolygon);
      const holding = result.candidate.districts.find((candidate) => pointInRing(centroid, candidate.polygon));
      if (holding === undefined) continue;
      const definition = DISTRICT_TYPE_REGISTRY.get(holding.typeId)!;
      const compatible = landmarkCompatible(landmark.landmarkGrammarId, definition.compatibilityTags);
      const warned = replay.warnings.some((warning) => warning.includes(`District "${holding.id}"`));
      expect(compatible || warned, landmark.id).toBe(true);
    }
  }, 120_000);

  it("is deterministic and request-scoped", () => {
    const first = handleRequest(request) as WorkerSuccess;
    const second = handleRequest({ ...request, id: request.id + 1 }) as WorkerSuccess;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const a = first.result as GenerateCompleteCityPlanResult;
    const b = second.result as GenerateCompleteCityPlanResult;
    expect(b.candidate).toEqual(a.candidate);
    expect(b.plan).toEqual(a.plan);
    expect(b.counts).toEqual(a.counts);
    expect(b.validation).toEqual(a.validation);
  }, 120_000);

  it("returns a failure response for invalid staging", () => {
    const response = handleRequest({
      ...request,
      id: request.id + 2,
      staging: { ...staging, terrainMode: "coastal", coastEdge: null }
    });
    expect(response).toEqual({
      id: request.id + 2,
      ok: false,
      error: "Coastal full generation requires a coast edge.",
      absentGenerationToken: "absent-9",
      actionToken: "full-generation-action",
      buildToken: "full-generation-build",
      epoch: 4
    });
  });
});

describe("handleRequest buildCompleteCityPlan", () => {
  const request: BuildCompleteCityPlanRequest = {
    id: 102,
    type: "buildCompleteCityPlan",
    source: COMPLETE_SOURCE,
    sourceRevision: 12,
    actionToken: "complete-edit-action",
    buildToken: "complete-edit-build",
    epoch: 5
  };

  it("matches the pure core plan and echoes revision/action/build/epoch identity", () => {
    const response = handleRequest(request) as WorkerSuccess;
    expect(response.ok).toBe(true);
    const result = response.result as BuildCompleteCityPlanResult;
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.epoch).toBe(request.epoch);
    expect(result.plan).toEqual(buildCompleteCityPlan(COMPLETE_SOURCE, request.sourceRevision, request.epoch));
    expect(validateCompleteCityPlan(result.plan)).toEqual([]);
    expect(result.validation).toEqual([]);
    expect(response.transfer).toBeUndefined();
  }, 120_000);

  it("carries revision, token and epoch identity on a failure response", () => {
    const response = handleRequest({ ...request, id: 105, sourceRevision: 0 });
    expect(response).toEqual({
      id: 105,
      ok: false,
      error: "Complete plan source revision must be a positive integer.",
      sourceRevision: 0,
      actionToken: "complete-edit-action",
      buildToken: "complete-edit-build",
      epoch: 5
    });
  });
});

describe("handleRequest buildCompleteCityChunks", () => {
  const sceneBoundsM = { x: 0, y: 0, width: 200, height: 200 };
  const plan = buildCompleteCityPlan(COMPLETE_SOURCE, 12, 5);
  const request: BuildCompleteCityChunksRequest = {
    id: 103,
    type: "buildCompleteCityChunks",
    source: COMPLETE_SOURCE,
    sourceRevision: 12,
    actionToken: "complete-chunks-action",
    buildToken: "complete-chunks-build",
    epoch: 5,
    plan,
    sceneBoundsM,
    pixelsPerMetre: 2,
    keys: [{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }]
  };

  it("matches core chunk output and transfers mesh/detail/neon buffers exactly once", () => {
    const response = handleRequest(request) as WorkerSuccess;
    expect(response.ok).toBe(true);
    const result = response.result as BuildCompleteCityChunksResult;
    expect(result.sourceRevision).toBe(request.sourceRevision);
    expect(result.actionToken).toBe(request.actionToken);
    expect(result.buildToken).toBe(request.buildToken);
    expect(result.epoch).toBe(request.epoch);
    const core = buildCompleteCityChunks(COMPLETE_SOURCE, plan, request.keys, sceneBoundsM, request.pixelsPerMetre);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(core.chunks.map((chunk) => chunk.id));
    expect(result.counters.requested).toBe(request.keys.length);
    expect(result.counters.built).toBe(core.chunks.length);
    expect(result.counters.vertexCount).toBe(core.vertexCount);
    expect(result.counters.triangleCount).toBe(core.triangleCount);
    expect(result.counters.bytes).toBe(core.bytes);
    expect(result.counters.markingTriangleCount).toBe(core.markingTriangleCount);
    expect(result.counters.buildingCount).toBe(core.buildingCount);
    expect(result.counters.landmarkCount).toBe(core.landmarkCount);
    expect(result.counters.openSpaceCount).toBe(core.openSpaceCount);
    const expected = result.chunks.flatMap((chunk) => [
      chunk.mesh.vertices.buffer,
      chunk.mesh.indices.buffer,
      chunk.detail.vertices.buffer,
      chunk.detail.indices.buffer,
      chunk.neon.vertices.buffer,
      chunk.neon.indices.buffer
    ]);
    expect(response.transfer).toEqual(expected);
    expect(response.transfer).toHaveLength(result.chunks.length * 6);
    expect(new Set(response.transfer!).size).toBe(response.transfer!.length);
  }, 120_000);

  it("returns a failure response when the plan is invalid", () => {
    const broken = { ...plan, parcels: [] };
    const response = handleRequest({
      ...request,
      id: request.id + 1,
      plan: broken
    });
    expect(response).toEqual({
      id: request.id + 1,
      ok: false,
      error: expect.stringMatching(/invalid/i),
      sourceRevision: 12,
      actionToken: "complete-chunks-action",
      buildToken: "complete-chunks-build",
      epoch: 5
    });
  });
});

describe("handleWorkerMessage buildCompleteCityChunks", () => {
  const sceneBoundsM = { x: 0, y: 0, width: 200, height: 200 };
  const plan = buildCompleteCityPlan(COMPLETE_SOURCE, 12, 5);
  const keys: ChunkKey[] = [{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }, { cx: 0, cy: 1 }];
  const request: BuildCompleteCityChunksRequest = {
    id: 104,
    type: "buildCompleteCityChunks",
    source: COMPLETE_SOURCE,
    sourceRevision: 12,
    actionToken: "progress-action",
    buildToken: "progress-build",
    epoch: 6,
    plan,
    sceneBoundsM,
    pixelsPerMetre: 2,
    keys
  };

  interface SinkRecord {
    message: WorkerMessage;
    transfer?: ArrayBuffer[];
  }

  function recordingSink(): WorkerSink & { records: SinkRecord[]; nextPost: () => Promise<void> } {
    const records: SinkRecord[] = [];
    let waiter: (() => void) | null = null;
    return {
      records,
      post(message: WorkerMessage, transfer?: ArrayBuffer[]): void {
        records.push({ message, transfer });
        waiter?.();
        waiter = null;
      },
      nextPost(): Promise<void> {
        if (records.length > 0) return Promise.resolve();
        return new Promise((resolve) => {
          waiter = resolve;
        });
      }
    };
  }

  /** WHY: wrap the batch the executor drains so tests can observe how far it has built. */
  function tracedBatch(built: string[]): OpenCompleteCityChunkBatch {
    return (source, plan_, keys_, sceneBoundsM_, pixelsPerMetre_) => {
      const inner = openCompleteCityChunkBatch(source, plan_, keys_, sceneBoundsM_, pixelsPerMetre_);
      return {
        get remaining(): number {
          return inner.remaining;
        },
        buildNext(): CompleteChunkBuild {
          const chunk = inner.buildNext();
          built.push(chunk.id);
          return chunk;
        }
      };
    };
  }

  it("posts the first chunk's progress before a later chunk is built", async () => {
    const sink = recordingSink();
    const built: string[] = [];
    const pending = handleWorkerMessage(sink, request, tracedBatch(built));
    await sink.nextPost();
    // Exactly one message posted and one key built while the executor is suspended between
    // chunks; a synchronous full-batch build would have posted everything by now.
    expect(sink.records).toHaveLength(1);
    expect(built).toEqual(["0,0"]);
    expect(sink.records[0]!.message).toMatchObject({ id: request.id, ok: true });
    await pending;
    expect(built).toEqual(keys.map((key) => `${key.cx},${key.cy}`));
    expect(sink.records).toHaveLength(keys.length + 1);
  });

  it("posts one progress message per chunk in stable key order with request-scoped identity", async () => {
    const sink = recordingSink();
    await handleWorkerMessage(sink, request);
    for (const [index, record] of sink.records.slice(0, keys.length).entries()) {
      const message = record.message;
      if (!("progress" in message)) throw new Error("expected a progress message");
      const payload: CompleteCityChunkProgress = message.result;
      expect(message.ok).toBe(true);
      expect(message.id).toBe(request.id);
      expect(payload.sourceRevision).toBe(request.sourceRevision);
      expect(payload.actionToken).toBe(request.actionToken);
      expect(payload.buildToken).toBe(request.buildToken);
      expect(payload.epoch).toBe(request.epoch);
      expect(payload.index).toBe(index);
      expect(payload.total).toBe(keys.length);
      expect(payload.chunk.id).toBe(`${keys[index]!.cx},${keys[index]!.cy}`);
      // Each progress message transfers exactly that chunk's own six buffers, once.
      expect(record.transfer).toEqual([
        payload.chunk.mesh.vertices.buffer,
        payload.chunk.mesh.indices.buffer,
        payload.chunk.detail.vertices.buffer,
        payload.chunk.detail.indices.buffer,
        payload.chunk.neon.vertices.buffer,
        payload.chunk.neon.indices.buffer
      ]);
    }
  });

  it("transfers every chunk buffer exactly once across all progress messages", async () => {
    const sink = recordingSink();
    await handleWorkerMessage(sink, request);
    const all = sink.records.flatMap((record) => record.transfer ?? []);
    expect(all).toHaveLength(keys.length * 6);
    expect(new Set(all).size).toBe(all.length);
    for (const buffer of all) expect(buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("keeps the peak retained chunk payload bounded to the current batch", async () => {
    const sink = recordingSink();
    const built: string[] = [];
    const pending = handleWorkerMessage(sink, request, tracedBatch(built));
    await sink.nextPost();
    // Only the first key has been built and delivered; nothing aggregates the full batch.
    expect(built).toEqual(["0,0"]);
    const payload = (sink.records[0]!.message as WorkerProgress).result;
    expect(payload.chunk.id).toBe("0,0");
    expect("chunks" in payload).toBe(false);
    await pending;
  });

  it("settles a mid-stream build failure with a failure and no final success", async () => {
    const sink = recordingSink();
    const chunk0 = buildCompleteCityChunks(COMPLETE_SOURCE, plan, [keys[0]!], sceneBoundsM, request.pixelsPerMetre).chunks[0]!;
    let left = 2;
    const failing: CompleteChunkBatch = {
      get remaining(): number {
        return left;
      },
      buildNext(): CompleteChunkBuild {
        left -= 1;
        if (left === 0) throw new Error("chunk build exploded");
        return chunk0;
      }
    };
    await handleWorkerMessage(sink, request, () => failing);
    expect(sink.records).toHaveLength(2);
    expect("progress" in sink.records[0]!.message).toBe(true);
    const failure = sink.records[1]!.message;
    expect(failure).toEqual({
      id: request.id,
      ok: false,
      error: "chunk build exploded",
      sourceRevision: 12,
      actionToken: "progress-action",
      buildToken: "progress-build",
      epoch: 6
    });
    expect(sink.records[1]!.transfer).toBeUndefined();
  });

  it("rejects an invalid plan before any progress is posted", async () => {
    const sink = recordingSink();
    await handleWorkerMessage(sink, { ...request, plan: { ...plan, parcels: [] } });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.message).toEqual({
      id: request.id,
      ok: false,
      error: expect.stringMatching(/invalid/i),
      sourceRevision: 12,
      actionToken: "progress-action",
      buildToken: "progress-build",
      epoch: 6
    });
    expect(sink.records[0]!.transfer).toBeUndefined();
  });

  it("posts a final summary equal to the core full-batch aggregate with no chunk geometry", async () => {
    const sink = recordingSink();
    await handleWorkerMessage(sink, request);
    const summary = sink.records[sink.records.length - 1]!.message;
    expect(summary).toMatchObject({ id: request.id, ok: true });
    expect("progress" in summary).toBe(false);
    expect(sink.records[sink.records.length - 1]!.transfer).toBeUndefined();
    const core = buildCompleteCityChunks(COMPLETE_SOURCE, plan, keys, sceneBoundsM, request.pixelsPerMetre);
    const payload = (summary as WorkerSuccess).result as BuildCompleteCityChunksSummary;
    expect(payload.sourceRevision).toBe(request.sourceRevision);
    expect(payload.actionToken).toBe(request.actionToken);
    expect(payload.buildToken).toBe(request.buildToken);
    expect(payload.epoch).toBe(request.epoch);
    expect(payload.counters).toEqual({
      requested: keys.length,
      built: core.chunks.length,
      vertexCount: core.vertexCount,
      triangleCount: core.triangleCount,
      bytes: core.bytes,
      markingTriangleCount: core.markingTriangleCount,
      buildingCount: core.buildingCount,
      landmarkCount: core.landmarkCount,
      openSpaceCount: core.openSpaceCount
    });
    expect("chunks" in payload).toBe(false);
  });

  it("routes non-chunk requests through the pure dispatcher", async () => {
    const sink = recordingSink();
    await handleWorkerMessage(sink, { id: 7, type: "ping", payload: "pong" });
    expect(sink.records.map((record) => record.message)).toEqual([{ id: 7, ok: true, result: "pong" }]);
  });
});
