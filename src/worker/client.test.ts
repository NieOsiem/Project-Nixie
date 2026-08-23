import { describe, expect, it, vi } from "vitest";
import { rectRing } from "../core/geom/types.js";
import { buildCompleteCityPlan } from "../core/gen/complete-city-plan.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CitySourceV3 } from "../core/gen/city.js";
import { WorkerClient } from "./client.js";
import { handleRequest, type BuildCompleteCityChunksSummary, type CompleteCityChunkProgress, type WorkerMessage, type WorkerRequest } from "./protocol.js";

/** Compact 200×200 grid-cross city: cheap to plan and enough for transfer-shaped fixtures. */
const SOURCE: CitySourceV3 = {
  origin: { x: 700, y: 300 },
  citySeed: "client-complete-fixture",
  generation: {
    terrainMode: "rectangle",
    coastEdge: null,
    roadLayout: "grid",
    hubMode: "single-centre",
    districtPool: [...DISTRICT_TYPE_IDS],
    openSpaceProfile: "medium"
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
const PLAN = buildCompleteCityPlan(SOURCE, 12, 5);

/**
 * Controllable fake Worker: the test drives `deliver` manually, so progress ordering and
 * post-settle stragglers are deterministic. `auto` runs the real pure dispatcher instead.
 *
 * `WorkerClient` constructs `new Worker(url)` itself, so the instance it gets is captured
 * from the constructor (the test never creates a stray one of its own).
 */
const fakeInstances: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  terminate = vi.fn();
  posted: { message: WorkerRequest; transfer?: Transferable[] }[] = [];
  auto: boolean;

  constructor(_url: string, _options?: unknown) {
    this.auto = false;
    fakeInstances.push(this);
  }

  postMessage(message: WorkerRequest, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
    if (this.auto) {
      const response = handleRequest(message);
      queueMicrotask(() => this.onmessage?.({ data: response }));
    }
  }

  deliver(message: WorkerMessage): void {
    this.onmessage?.({ data: message });
  }
}

function clientWithFake(auto = false): { client: WorkerClient; fake: FakeWorker } {
  fakeInstances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  const client = new WorkerClient("fake://worker");
  const fake = fakeInstances[0];
  if (fake === undefined) throw new Error("WorkerClient did not construct a Worker");
  fake.auto = auto;
  return { client, fake };
}

const mesh = (triangleCount: number) => {
  const vertices = new Float32Array(triangleCount * 3 * 11);
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount * 3; i++) indices[i] = i;
  return { vertices, indices, vertexCount: triangleCount * 3, triangleCount };
};

const chunk = (id: string, triangleCount = 1) => ({
  key: { cx: 0, cy: 0 },
  id,
  boundsM: { x: 0, y: 0, width: 128, height: 128 },
  boundsPx: { x: 0, y: 0, width: 256, height: 256 },
  mesh: mesh(triangleCount),
  detail: mesh(0),
  neon: mesh(0),
  surfaces: {
    water: [], exposedLand: [], vehicleCarriageway: [], vehicleSidewalk: [],
    nonVehicleRoute: [], markings: [], laneMarkings: [], crossings: [], kerbs: [],
    gutters: [], curbHighlights: [], drains: [], repairs: [], repairHighlights: []
  },
  buildingIds: [],
  landmarkIds: [],
  connectors: [],
  buildingCount: 0,
  landmarkCount: 0,
  connectorCount: 0,
  openSpaceCount: 0,
  waterTriangleCount: 0,
  exposedLandTriangleCount: 0,
  vehicleTriangleCount: 0,
  sidewalkTriangleCount: 0,
  nonVehicleTriangleCount: 0,
  markingTriangleCount: 0,
  openSpaceTriangleCount: 0
});

const chunkBody = () => ({
  source: SOURCE,
  sourceRevision: 12,
  actionToken: "client-action",
  buildToken: "client-build",
  epoch: 5,
  plan: PLAN,
  sceneBoundsM: { x: 0, y: 0, width: 200, height: 200 },
  pixelsPerMetre: 2,
  keys: [{ cx: 0, cy: 0 }]
});

const progressFor = (requestId: number, index: number, total: number, payload: CompleteCityChunkProgress["chunk"]): WorkerMessage => ({
  id: requestId,
  ok: true,
  progress: true,
  result: {
    sourceRevision: 12,
    actionToken: "client-action",
    buildToken: "client-build",
    epoch: 5,
    index,
    total,
    chunk: payload
  }
});

const summaryFor = (requestId: number, counters: BuildCompleteCityChunksSummary["counters"]): WorkerMessage => ({
  id: requestId,
  ok: true,
  result: { sourceRevision: 12, actionToken: "client-action", buildToken: "client-build", epoch: 5, counters }
});

describe("WorkerClient", () => {
  it("forwards chunk progress in order and resolves with the final summary", async () => {
    const { client, fake } = clientWithFake();
    const seen: string[] = [];
    const pending = client.buildCompleteCityChunks(
      { ...chunkBody(), keys: [{ cx: 0, cy: 0 }, { cx: 1, cy: 0 }] },
      (progress) => seen.push(progress.chunk.id)
    );
    const request = fake.posted[0]!.message as { id: number; type: string };
    expect(request.type).toBe("buildCompleteCityChunks");
    expect(request.id).toBeGreaterThan(0);

    fake.deliver(progressFor(request.id, 0, 2, chunk("0,0")));
    fake.deliver(progressFor(request.id, 1, 2, chunk("1,0")));
    fake.deliver(summaryFor(request.id, { requested: 2, built: 2, vertexCount: 6, triangleCount: 2, bytes: 264, markingTriangleCount: 0, buildingCount: 1, landmarkCount: 0, openSpaceCount: 0 }));

    const summary = (await pending) as BuildCompleteCityChunksSummary;
    expect(seen).toEqual(["0,0", "1,0"]);
    expect(summary.counters.built).toBe(2);
    expect(client.inFlight).toBe(0);
  });

  it("ignores progress after the request has settled", async () => {
    const { client, fake } = clientWithFake();
    const seen: string[] = [];
    const pending = client.buildCompleteCityChunks(
      chunkBody(),
      (progress) => seen.push(progress.chunk.id)
    );
    const request = fake.posted[0]!.message as { id: number };
    fake.deliver(summaryFor(request.id, { requested: 1, built: 1, vertexCount: 3, triangleCount: 1, bytes: 132, markingTriangleCount: 0, buildingCount: 0, landmarkCount: 0, openSpaceCount: 0 }));
    await pending;
    fake.deliver(progressFor(request.id, 0, 1, chunk("late")));
    expect(seen).toEqual([]);
    expect(client.inFlight).toBe(0);
  });

  it("rejects with the failure message and drops the request", async () => {
    const { client, fake } = clientWithFake();
    const pending = client.buildCompleteCityPlan({
      source: SOURCE,
      sourceRevision: 12,
      actionToken: "client-action",
      buildToken: "client-build",
      epoch: 5
    });
    const request = fake.posted[0]!.message as { id: number };
    fake.deliver({ id: request.id, ok: false, error: "plan failed" });
    await expect(pending).rejects.toThrow("plan failed");
    expect(client.inFlight).toBe(0);
  });

  it("rejects every in-flight request on terminate and ignores late progress", async () => {
    const { client, fake } = clientWithFake();
    const seen: string[] = [];
    const pending = client.buildCompleteCityChunks(
      chunkBody(),
      (progress) => seen.push(progress.chunk.id)
    );
    const request = fake.posted[0]!.message as { id: number };
    client.terminate();
    fake.deliver(progressFor(request.id, 0, 1, chunk("after-terminate")));
    await expect(pending).rejects.toThrow("worker terminated");
    expect(seen).toEqual([]);
    expect(client.inFlight).toBe(0);
    expect(fake.terminate).toHaveBeenCalled();
  });

  it("still routes legacy requests through the pure dispatcher", async () => {
    const { client } = clientWithFake(true);
    const result = await client.buildTerrainChunk({
      source: {
        origin: { x: 5000, y: 4000 },
        citySeed: "client-legacy",
        generation: { terrainMode: "rectangle", coastEdge: null },
        terrain: { land: [{ x: -96, y: -96 }, { x: 96, y: -96 }, { x: 96, y: 96 }, { x: -96, y: 96 }], urbanFootprint: null }
      },
      sourceRevision: 3,
      key: { cx: 0, cy: 0 },
      sceneBoundsM: { x: -128, y: -128, width: 256, height: 256 },
      pixelsPerMetre: 25
    });
    expect(result.sourceRevision).toBe(3);
    expect(result.chunkId).toBe("0,0");
    expect(result.vertexCount).toBeGreaterThan(0);
    expect(client.inFlight).toBe(0);
  });

  it("rejects after termination when a new request arrives", async () => {
    const { client } = clientWithFake();
    client.terminate();
    await expect(
      client.buildCompleteCityPlan({
        source: SOURCE,
        sourceRevision: 12,
        actionToken: "client-action",
        buildToken: "client-build",
        epoch: 5
      })
    ).rejects.toThrow("worker terminated");
  });

  it("ignores progress for a request id it never issued", async () => {
    const { client, fake } = clientWithFake();
    const seen: string[] = [];
    client.buildCompleteCityChunks(chunkBody(), (progress) => seen.push(progress.chunk.id));
    fake.deliver(progressFor(999, 0, 1, chunk("ghost")));
    expect(seen).toEqual([]);
    expect(client.inFlight).toBe(1);
  });

  it("settles a mid-stream failure and ignores progress that arrives after it", async () => {
    const { client, fake } = clientWithFake();
    const seen: string[] = [];
    const pending = client.buildCompleteCityChunks(
      chunkBody(),
      (progress) => seen.push(progress.chunk.id)
    );
    const request = fake.posted[0]!.message as { id: number };
    fake.deliver(progressFor(request.id, 0, 1, chunk("0,0")));
    fake.deliver({ id: request.id, ok: false, error: "mid-stream failure" });
    await expect(pending).rejects.toThrow("mid-stream failure");
    fake.deliver(progressFor(request.id, 0, 1, chunk("late")));
    expect(seen).toEqual(["0,0"]);
    expect(client.inFlight).toBe(0);
  });

  it("rejects once when the progress callback throws and ignores later messages", async () => {
    const { client, fake } = clientWithFake();
    const seen: string[] = [];
    const pending = client.buildCompleteCityChunks(
      chunkBody(),
      (progress) => {
        seen.push(progress.chunk.id);
        if (progress.chunk.id === "0,0") throw new Error("callback exploded");
      }
    );
    const request = fake.posted[0]!.message as { id: number };
    fake.deliver(progressFor(request.id, 0, 1, chunk("0,0")));
    await expect(pending).rejects.toThrow("callback exploded");
    expect(seen).toEqual(["0,0"]);
    expect(client.inFlight).toBe(0);
    // The dropped entry ignores later progress and the final summary for the same id.
    fake.deliver(progressFor(request.id, 0, 1, chunk("late")));
    fake.deliver(summaryFor(request.id, { requested: 1, built: 1, vertexCount: 3, triangleCount: 1, bytes: 132, markingTriangleCount: 0, buildingCount: 0, landmarkCount: 0, openSpaceCount: 0 }));
    expect(seen).toEqual(["0,0"]);
    expect(client.inFlight).toBe(0);
  });

  it("turns a non-Error callback throw into an Error rejection", async () => {
    const { client, fake } = clientWithFake();
    const pending = client.buildCompleteCityChunks(
      chunkBody(),
      () => {
        throw "plain-string-boom";
      }
    );
    const request = fake.posted[0]!.message as { id: number };
    fake.deliver(progressFor(request.id, 0, 1, chunk("0,0")));
    await expect(pending).rejects.toThrow("plain-string-boom");
    expect(client.inFlight).toBe(0);
  });
});
