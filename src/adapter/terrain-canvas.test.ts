import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_CITY, FLAG_ENABLED } from "../constants.js";
import { DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "../core/gen/district-registry.js";
import { allocateManualId, allocateManualLineage, type CityStateV4, type DistrictSource, type PlacementFrame } from "../core/gen/city.js";
import { buildCompleteCityPlan, derivePaletteBanks, type CompleteCityPlan } from "../core/gen/complete-city-plan.js";
import { PLAN_CACHE_FORMAT_VERSION, type CityCacheManifestV1 } from "../core/gen/city-cache.js";
import type { CachedCompleteChunkRecord } from "../core/gen/complete-city-chunk-cache.js";
import { BANK_SIZE, BASE_BANK, builtinPalette, packPalette } from "../core/palette.js";
import { rectangleLand } from "../core/gen/terrain.js";
import { ringArea, type Ring } from "../core/geom/types.js";
import { TerrainSession } from "./terrain-session.js";
import {
  handleWorkerMessage,
  type WorkerMessage,
  type WorkerRequest
} from "../worker/protocol.js";
import {
  addCityListener,
  commitArchitectureCandidate,
  clearConfirmationFor,
  configuredPixelsPerMetre,
  cancelTerrainDraft,
  createDistrict,
  deleteObject,
  deleteRoadJunction,
  deleteRoads,
  districtDiagnostics,
  editObjectProperties,
  editSitePolygon,
  enabledFlagChanged,
  fillDistrict,
  generateDistricts,
  generateNewSeed,
  generationPreflight,
  generationState,
  getArchitectureSource,
  getCity,
  getDistrictPlanView,
  getDistrictSelection,
  getRoadSelection,
  mergeDistricts,
  mount,
  placeBuilding,
  placePlace,
  randomizeEntireCity,
  redo,
  reclassifyRoad,
  rebuildGeometry,
  replaceUrbanFootprint,
  renameRoad,
  rerollObjectAppearance,
  retryDistrictPlan,
  retryFullGeneration,
  retryGeneratedWalls,
  retryGeometry,
  roadClearanceBlockers,
  sceneBoundsFromPixels,
  selectDistrict,
  selectRoad,
  selectRoadNode,
  setDistrictDraftCancelListener,
  setObjectLocked,
  setRoadCurvePreset,
  setRoadDraftCancelListener,
  setRoadLocked,
  splitDistrict,
  startFullGeneration,
  stats,
  transformObject,
  undo,
  unmount,
  updateDistricts,
  type BuildingPlacementInput,
  type ClearConfirmation,
  type PlacePlacementInput
} from "./terrain-canvas.js";

/** Every CityRenderer the adapter constructs, with the palettes it was handed. */
const rendererState = vi.hoisted(() => ({
  instances: [] as Array<{ paletteUpdates: Uint8Array[] }>,
  setChunkError: null as Error | null
}));

const cacheState = vi.hoisted(() => ({
  load: vi.fn<(city: CityStateV4) => Promise<{ plan: CompleteCityPlan; manifest: CityCacheManifestV1 } | null>>(),
  publish: vi.fn<(city: CityStateV4, plan: CompleteCityPlan) => Promise<CityCacheManifestV1>>(),
  loadChunks: vi.fn<(
    city: CityStateV4,
    plan: CompleteCityPlan,
    boundsM: { x: number; y: number; width: number; height: number },
    pixelsPerMetre: number,
    expectedChunkIds: readonly string[],
    onRecord?: (record: CachedCompleteChunkRecord) => void
  ) => Promise<{ records: CachedCompleteChunkRecord[]; missingChunkIds: string[]; manifest: CityCacheManifestV1 } | null>>(),
  publishChunks: vi.fn<(
    city: CityStateV4,
    plan: CompleteCityPlan,
    boundsM: { x: number; y: number; width: number; height: number },
    pixelsPerMetre: number,
    records: readonly CachedCompleteChunkRecord[]
  ) => Promise<CityCacheManifestV1>>()
}));

vi.mock("./city-cache.js", () => ({
  loadCachedCompleteChunks: cacheState.loadChunks,
  loadCachedCompletePlan: cacheState.load,
  publishCompleteChunkCache: cacheState.publishChunks,
  publishCompletePlanCache: cacheState.publish
}));

// WHY: the adapter constructs CityRenderer at mount once canvas.app.renderer exists; the
// fake records every palette upload so tests can prove one shared texture is refreshed.
vi.mock("../render/city-renderer.js", () => {
  interface FakeStageObject {
    parent: { removeChild(child: unknown): void } | null;
    alpha: number;
    elevation: number;
    sortLayer: number;
    sort: number;
  }

  class FakeCityRenderer {
    display: FakeStageObject = { parent: null, alpha: 1, elevation: 0, sortLayer: 0, sort: 0 };
    overlay: FakeStageObject = { parent: null, alpha: 1, elevation: 0, sortLayer: 0, sort: 0 };
    weather: FakeStageObject = { parent: null, alpha: 1, elevation: 0, sortLayer: 0, sort: 0 };
    lookDials: Record<string, number> = {};
    rainStrength = 0;
    cameraHeightMetres = 500;
    cameraZoomMode = "dolly";
    pixelsPerMetre = 1;
    leanOverride: number | null = null;
    renderScale = 1;
    supersample = 1.5;
    bloomEnabled = true;
    bloomStrength = 1;
    paletteUpdates: Uint8Array[] = [];

    constructor(_renderer: unknown, _buffers: unknown, palette: Uint8Array, _options: unknown) {
      this.paletteUpdates.push(palette);
      rendererState.instances.push(this);
    }

    clearChunks(): void {}
    setChunk(_chunk: unknown): void {
      if (rendererState.setChunkError !== null) throw rendererState.setChunkError;
    }
    updatePalette(palette: Uint8Array): void {
      this.paletteUpdates.push(palette);
    }
    markContentDirty(): void {}
    stats(): Record<string, unknown> { return {}; }
    leanCalibrationPoint(): { leanStrength: number } {
      return { leanStrength: this.leanOverride ?? 0 };
    }
    update(): void {}
    animate(): void {}
    destroy(): void {}
  }
  return { CityRenderer: FakeCityRenderer };
});

/** WHY: the adapter builds plans and chunks only in the worker; the fake runs the real
 * worker entry so it stays in lockstep with the progressive chunk executor. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  terminate = vi.fn();
  /** Number of complete-plan and complete-chunk builds served. */
  planBuilds = 0;
  chunkBuilds = 0;
  chunkRequests: string[][] = [];
  /** Test hook: mutate a response before it is dispatched to the adapter. */
  tamper: ((request: WorkerRequest, message: WorkerMessage) => void) | null = null;

  constructor(_url: string, _options?: unknown) {}

  postMessage(message: WorkerRequest): void {
    if (message.type === "buildCompleteCityPlan") this.planBuilds += 1;
    if (message.type === "buildCompleteCityChunks") this.chunkBuilds += 1;
    if (message.type === "buildCompleteCityChunks") {
      this.chunkRequests.push(message.keys.map((key) => `${key.cx},${key.cy}`));
    }
    queueMicrotask(() => {
      void handleWorkerMessage(
        {
          post: (item) => {
            this.tamper?.(message, item);
            this.onmessage?.({ data: item });
          }
        },
        message
      );
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cacheManifest(city: CityStateV4, plan: CompleteCityPlan, byteLength = 321): CityCacheManifestV1 {
  return {
    kind: "project-nixie-city-cache",
    cacheSchemaVersion: 1,
    generatorVersion: 12,
    cityRevision: city.revision,
    structuralInput: plan.structuralInput,
    slot: 0,
    plan: {
      formatVersion: PLAN_CACHE_FORMAT_VERSION,
      artifact: {
        path: `complete-city-plan/${city.revision}/slot-0/plan.json.gz`,
        byteLength,
        checksum: "1234abcd"
      }
    }
  };
}

function cachedChunk(id: string): CachedCompleteChunkRecord {
  const mesh = {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    vertexCount: 0,
    triangleCount: 0
  };
  return {
    id,
    mesh,
    detail: { ...mesh },
    neon: { ...mesh },
    boundsM: { x: 0, y: 0, width: 128, height: 128 },
    boundsPx: { x: 0, y: 0, width: 128, height: 128 },
    landTriangleCount: 0,
    waterTriangleCount: 0,
    markingTriangleCount: 0,
    openSpaceTriangleCount: 0,
    buildingCount: 0,
    landmarkCount: 0,
    openSpaceCount: 0,
    bytes: 0
  };
}

beforeEach(() => {
  cacheState.load.mockReset().mockResolvedValue(null);
  cacheState.publish.mockReset().mockImplementation(async (city, plan) => cacheManifest(city, plan));
  cacheState.loadChunks.mockReset().mockResolvedValue(null);
  cacheState.publishChunks.mockReset().mockImplementation(async (city, plan) => cacheManifest(city, plan));
  rendererState.setChunkError = null;
});

function state(): CityStateV4 {
  return {
    kind: "city-generator-2",
    schemaVersion: 4,
    generatorVersion: 12,
    revision: 1,
    source: {
      origin: { x: 500, y: 400 },
      citySeed: "adapter-fixture",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
      terrain: {
        land: [
          { x: -100, y: -80 },
          { x: 100, y: -80 },
          { x: 100, y: 80 },
          { x: -100, y: 80 }
        ],
        urbanFootprint: null
      },
      roads: { nodes: [], routes: [], edges: [] },
      districts: [],
      architecture: { buildings: [], places: [], overrides: [] }
    }
  };
}

describe("complete plan cache pipeline", () => {
  let saved: CityStateV4;
  let worker: FakeWorker;

  function workerFactory(): FakeWorker {
    return worker;
  }

  function setupScene(): void {
    const scene = {
      get walls(): unknown[] { return []; },
      getFlag: (_module: string, flag: string): unknown =>
        flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? saved : undefined,
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV4): Promise<CityStateV4> => {
        saved = structuredClone(value);
        return saved;
      }),
      unsetFlag: vi.fn(async (): Promise<void> => undefined),
      deleteEmbeddedDocuments: vi.fn(async (): Promise<unknown[]> => []),
      createEmbeddedDocuments: vi.fn(async (): Promise<unknown[]> => [])
    };
    vi.stubGlobal("canvas", {
      ready: true,
      dimensions: {
        sceneRect: { x: 400, y: 320, width: 200, height: 160 },
        size: 1,
        distance: 1
      },
      scene,
      app: undefined
    });
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
    vi.stubGlobal("CONST", { EDGE_SENSE_TYPES: { LIMITED: 1 }, WALL_MOVEMENT_TYPES: { NORMAL: 1 } });
    vi.stubGlobal("document", { baseURI: "http://test.local/" });
    vi.stubGlobal("Worker", workerFactory);
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    saved = state();
    worker = new FakeWorker("worker-url");
    setupScene();
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses a cached plan on mount, skips plan generation, builds chunks, and does not republish", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    cacheState.load.mockResolvedValue({
      plan,
      manifest: cacheManifest(saved, plan, 777)
    });

    mount();

    await vi.waitFor(() => expect(worker.chunkBuilds).toBeGreaterThan(0), { timeout: 15_000 });
    expect(worker.planBuilds).toBe(0);
    expect(cacheState.publish).not.toHaveBeenCalled();
    expect(stats()?.planCache).toEqual(expect.objectContaining({
      status: "hit",
      revision: 1,
      bytes: 777
    }));
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 1 }));
  }, 120_000);

  it("builds and publishes after a cache miss", async () => {
    mount();

    await vi.waitFor(() => expect(cacheState.publish).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(worker.planBuilds).toBe(1);
    expect(worker.chunkBuilds).toBeGreaterThan(0);
    expect(cacheState.publish).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      expect.objectContaining({ sourceRevision: 1 })
    );
    expect(stats()?.planCache).toEqual(expect.objectContaining({
      status: "published",
      revision: 1,
      bytes: 321
    }));
  }, 120_000);

  it("restamps and republishes a reused metadata plan so the next load hits", async () => {
    saved = bulkRoadState();
    mount();
    await vi.waitFor(() => expect(cacheState.publish).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    const initialPlanBuilds = worker.planBuilds;
    const initialPlan = cacheState.publish.mock.calls[0]![1];
    cacheState.publish.mockClear();

    await renameRoad("Renamed", false, ["edge-a"]);

    await vi.waitFor(() => expect(cacheState.publish).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(worker.planBuilds).toBe(initialPlanBuilds);
    const republishedPlan = cacheState.publish.mock.calls[0]![1];
    expect(republishedPlan).toMatchObject({
      sourceRevision: 2,
      buildToken: initialPlan.buildToken
    });
    expect(republishedPlan.actionToken).not.toBe(initialPlan.actionToken);

    unmount();
    cacheState.load.mockResolvedValue({
      plan: republishedPlan,
      manifest: cacheManifest(saved, republishedPlan, 456)
    });
    cacheState.publish.mockClear();
    const chunksBeforeReload = worker.chunkBuilds;
    mount();

    await vi.waitFor(() => expect(worker.chunkBuilds).toBeGreaterThan(chunksBeforeReload), { timeout: 15_000 });
    expect(worker.planBuilds).toBe(initialPlanBuilds);
    expect(cacheState.publish).not.toHaveBeenCalled();
    expect(stats()?.planCache).toEqual(expect.objectContaining({
      status: "hit",
      revision: 2,
      bytes: 456
    }));
  }, 120_000);

  it("falls back to generation when cache loading fails", async () => {
    cacheState.load.mockRejectedValue(new Error("corrupt compressed cache"));

    mount();

    await vi.waitFor(() => expect(worker.chunkBuilds).toBeGreaterThan(0), { timeout: 15_000 });
    expect(worker.planBuilds).toBe(1);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 1 }));
    await vi.waitFor(() => expect(cacheState.publish).toHaveBeenCalledTimes(1), { timeout: 15_000 });
  }, 120_000);

  it("keeps generated geometry usable and diagnoses a cache upload failure", async () => {
    cacheState.publish.mockRejectedValue(new Error("cache upload denied"));

    mount();

    await vi.waitFor(() => {
      expect(stats()?.planCache).toEqual(expect.objectContaining({
        status: "error",
        revision: 1,
        reason: "cache upload denied"
      }));
    }, { timeout: 15_000 });
    expect(worker.planBuilds).toBe(1);
    expect(worker.chunkBuilds).toBeGreaterThan(0);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 1 }));
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subsystem: "plan-cache",
        message: "cache upload denied",
        revision: 1
      })
    ]));
  }, 120_000);

  it("does not generate or publish a stale cache after the source revision changes", async () => {
    let resolveFirstLoad!: (value: null) => void;
    cacheState.load
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstLoad = resolve;
      }))
      .mockResolvedValue(null);

    mount();
    await vi.waitFor(() => expect(cacheState.load).toHaveBeenCalledTimes(1));

    unmount();
    saved = { ...saved, revision: 2 };
    mount();
    resolveFirstLoad(null);

    await vi.waitFor(() => expect(cacheState.publish).toHaveBeenCalled(), { timeout: 15_000 });
    expect(cacheState.publish.mock.calls.map(([city]) => city.revision)).toEqual([2]);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 2 }));
  }, 120_000);

  it("installs a full chunk-cache hit without constructing a Worker", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    cacheState.load.mockResolvedValue({ plan, manifest: cacheManifest(saved, plan) });
    cacheState.loadChunks.mockImplementation(async (city, _plan, _bounds, _ppm, expectedIds, onRecord) => {
      const records = expectedIds.map(cachedChunk);
      for (const record of records) onRecord?.(record);
      return { records, missingChunkIds: [], manifest: cacheManifest(city, plan) };
    });
    vi.stubGlobal("Worker", class {
      constructor() {
        throw new Error("Worker unavailable");
      }
    });

    mount();

    await vi.waitFor(() => expect(stats()?.chunkCache).toEqual(expect.objectContaining({
      status: "hit",
      loaded: 4,
      generated: 0
    })), { timeout: 15_000 });
    expect(worker.chunkBuilds).toBe(0);
    expect(cacheState.publishChunks).not.toHaveBeenCalled();
  }, 120_000);

  it("aborts a cached hit when renderer installation fails before publishing the record", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    cacheState.load.mockResolvedValue({ plan, manifest: cacheManifest(saved, plan) });
    cacheState.loadChunks.mockImplementation(async (city, _plan, _bounds, _ppm, expectedIds, onRecord) => {
      const records = expectedIds.map(cachedChunk);
      for (const record of records) onRecord?.(record);
      return { records, missingChunkIds: [], manifest: cacheManifest(city, plan) };
    });
    Object.assign(canvas, {
      app: {
        renderer: {},
        ticker: { add: vi.fn(), remove: vi.fn() }
      },
      primary: {
        constructor: { BACKGROUND_ELEVATION: 0 },
        addChild: vi.fn(),
        sortDirty: false
      }
    });
    vi.stubGlobal("PIXI", { UPDATE_PRIORITY: { HIGH: 1 } });
    rendererState.setChunkError = new Error("renderer rejected cached geometry");

    mount();

    await vi.waitFor(() => expect(districtDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subsystem: "geometry",
        message: expect.stringContaining("renderer rejected cached geometry"),
        revision: 1
      })
    ])), { timeout: 15_000 });
    expect(worker.chunkBuilds).toBe(0);
    expect(stats()?.chunkCache).toBeNull();
    expect(cacheState.publishChunks).not.toHaveBeenCalled();
  }, 120_000);

  it("retains cached chunks, requests only misses, and republishes the full batch", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    let expectedIds: readonly string[] = [];
    cacheState.load.mockResolvedValue({ plan, manifest: cacheManifest(saved, plan) });
    cacheState.loadChunks.mockImplementation(async (city, _plan, _bounds, _ppm, ids, onRecord) => {
      expectedIds = [...ids];
      const record = cachedChunk(ids[0]!);
      onRecord?.(record);
      return {
        records: [record],
        missingChunkIds: ids.slice(1),
        manifest: cacheManifest(city, plan)
      };
    });

    mount();

    await vi.waitFor(() => expect(cacheState.publishChunks).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(worker.chunkRequests).toEqual([expectedIds.slice(1)]);
    expect(cacheState.publishChunks.mock.calls[0]![4].map((record) => record.id)).toEqual(expectedIds);
    expect(stats()?.chunkCache).toEqual(expect.objectContaining({
      status: "published",
      loaded: 1,
      generated: expectedIds.length - 1
    }));
    expect(stats()?.roadBuild).toEqual(expect.objectContaining({
      requested: expectedIds.length - 1,
      built: expectedIds.length - 1
    }));
  }, 120_000);

  it("falls back from a corrupt chunk cache and keeps publication failure non-fatal", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    cacheState.load.mockResolvedValue({ plan, manifest: cacheManifest(saved, plan) });
    cacheState.loadChunks.mockRejectedValue(new Error("corrupt chunk cache"));
    cacheState.publishChunks.mockRejectedValue(new Error("chunk upload denied"));

    mount();

    await vi.waitFor(() => expect(stats()?.chunkCache).toEqual(expect.objectContaining({
      status: "error",
      loaded: 0,
      reason: "chunk upload denied"
    })), { timeout: 15_000 });
    expect(worker.chunkBuilds).toBe(1);
    expect(stats()?.lastBuild).toEqual(expect.objectContaining({ full: true, stale: false }));
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "chunk upload denied",
        revision: 1
      })
    ]));
  }, 120_000);

  it("regenerates and republishes when Scene pixels-per-metre does not match", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    cacheState.load.mockResolvedValue({ plan, manifest: cacheManifest(saved, plan) });
    Object.assign(canvas.dimensions, { size: 2 });

    mount();

    await vi.waitFor(() => expect(cacheState.publishChunks).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(cacheState.loadChunks).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 }),
      plan,
      expect.any(Object),
      2,
      expect.any(Array),
      expect.any(Function)
    );
    expect(worker.chunkBuilds).toBe(1);
    expect(cacheState.publishChunks.mock.calls[0]![3]).toBe(2);
    expect(stats()?.chunkCache).toEqual(expect.objectContaining({
      status: "published",
      loaded: 0
    }));
  }, 120_000);

  it("rejects progressive cached records after the install epoch becomes stale", async () => {
    const plan = buildCompleteCityPlan(saved.source, saved.revision);
    cacheState.load.mockResolvedValue({ plan, manifest: cacheManifest(saved, plan) });
    cacheState.loadChunks.mockImplementation(async (city, _plan, _bounds, _ppm, ids, onRecord) => {
      const records = ids.map(cachedChunk);
      onRecord?.(records[0]!);
      unmount();
      for (const record of records.slice(1)) onRecord?.(record);
      return { records, missingChunkIds: [], manifest: cacheManifest(city, plan) };
    });

    mount();

    await vi.waitFor(() => {
      expect(cacheState.loadChunks).toHaveBeenCalledTimes(1);
      expect(stats()).toBeNull();
    });
    expect(worker.chunkBuilds).toBe(0);
    expect(cacheState.publishChunks).not.toHaveBeenCalled();
  }, 120_000);
});


describe("terrain Scene scale mapping", () => {
  it("cancels terrain, road, and district drafts together", () => {
    const calls: string[] = [];
    setDistrictDraftCancelListener(() => calls.push("district"));
    setRoadDraftCancelListener(() => calls.push("road"));
    cancelTerrainDraft();
    setDistrictDraftCancelListener(null);
    setRoadDraftCancelListener(null);
    expect(calls).toEqual(["road", "district"]);
  });

  it("detects external Scene enable changes in nested update data", () => {
    expect(enabledFlagChanged({ flags: { "project-nixie": { enabled: true } } })).toBe(true);
    expect(enabledFlagChanged({ flags: { "project-nixie": { city: {} } } })).toBe(false);
  });

  it("uses numeric grid distance as metres per square", () => {
    expect(configuredPixelsPerMetre(100, 2)).toBe(50);
    expect(configuredPixelsPerMetre(70, 5)).toBe(14);
  });

  it("changes derived Scene bounds without mutating persisted metre geometry", () => {
    const city = state();
    const before = structuredClone(city.source);
    const scene = { x: 0, y: 0, width: 1000, height: 800 };
    expect(sceneBoundsFromPixels(scene, city.source.origin, 50)).toEqual({
      x: -10,
      y: -8,
      width: 20,
      height: 16
    });
    expect(sceneBoundsFromPixels(scene, city.source.origin, 25)).toEqual({
      x: -20,
      y: -16,
      width: 40,
      height: 32
    });
    expect(city.source).toEqual(before);
  });

  it("creates an exact Rectangle ring from converted Scene bounds", () => {
    const bounds = sceneBoundsFromPixels({ x: 100, y: 200, width: 800, height: 600 }, { x: 500, y: 500 }, 20);
    expect(rectangleLand(bounds)).toEqual([
      { x: -20, y: -15 },
      { x: 20, y: -15 },
      { x: 20, y: 15 },
      { x: -20, y: 15 }
    ]);
  });

  it("invalidates same-revision render work without changing source state", () => {
    const city = state();
    const session = new TerrainSession();
    session.reset({ kind: "supported", state: city });
    const before = session.current;
    const epoch = session.buildEpoch;
    session.invalidateRenderInputs();
    expect(session.current).toEqual(before);
    expect(session.buildEpoch).toBe(epoch + 1);
  });
});

describe("road clearance containment", () => {
  const scene = { x: 0, y: 0, width: 100, height: 100 };
  const road = {
    nodes: [
      { id: "left", x: 0, y: 50 },
      { id: "right", x: 100, y: 50 }
    ],
    routes: [{ id: "route", curvePreset: "standard" as const }],
    edges: [{ id: "road-edge", a: "left", b: "right", routeId: "route", classId: "street" as const, name: null, locked: false, origin: "authored" as const }]
  };

  it("rejects a narrow concave water notch between coarse centreline samples", () => {
    const land = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
      { x: 50, y: 40 },
      { x: 49, y: 40 },
      { x: 49, y: 100 },
      { x: 0, y: 100 }
    ];
    expect(roadClearanceBlockers(road, land, scene)).toEqual(["road-edge"]);
  });

  it("allows a corridor that only terminates at a land Scene edge", () => {
    const land = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 }
    ];
    expect(roadClearanceBlockers(road, land, scene)).toEqual([]);
  });

  it("rejects an internal endpoint cap that spills into water near a footprint boundary", () => {
    const internal = {
      ...road,
      nodes: [
        { id: "inside", x: 20, y: 50 },
        { id: "endpoint", x: 40, y: 50 }
      ],
      edges: [{ id: "road-edge", a: "inside", b: "endpoint", routeId: "route", classId: "street" as const, name: null, locked: false, origin: "authored" as const }]
    };
    const land = [
      { x: 0, y: 0 },
      { x: 45, y: 0 },
      { x: 45, y: 100 },
      { x: 0, y: 100 }
    ];
    expect(roadClearanceBlockers(internal, land, scene)).toEqual(["road-edge"]);
  });
});

function bulkRoadState(): CityStateV4 {
  const city = state();
  city.source.roads = {
    nodes: [
      { id: "a0", x: -70, y: -40 },
      { id: "a1", x: -20, y: -40 },
      { id: "a2", x: 30, y: -40 },
      { id: "b0", x: -70, y: 30 },
      { id: "b1", x: -20, y: 30 },
      { id: "b2", x: 30, y: 30 }
    ],
    routes: [
      { id: "route-a", curvePreset: "standard" },
      { id: "route-b", curvePreset: "tight" }
    ],
    edges: [
      { id: "edge-a", a: "a0", b: "a1", routeId: "route-a", classId: "street", name: "A", locked: false, origin: "authored" },
      { id: "edge-b", a: "a1", b: "a2", routeId: "route-a", classId: "street", name: "A", locked: false, origin: "authored" },
      { id: "edge-c", a: "b0", b: "b1", routeId: "route-b", classId: "narrow", name: "C", locked: false, origin: "authored" },
      { id: "edge-d", a: "b1", b: "b2", routeId: "route-b", classId: "narrow", name: "C", locked: false, origin: "authored" }
    ]
  };
  return city;
}

describe("road bulk mutation selection", () => {
  let saved: CityStateV4 | undefined;
  let saveError: Error | null;
  let wallCreateError: Error | null;
  let wallDocuments: Array<{ id: string }>;
  let worker: FakeWorker;

  // WHY: the adapter constructs `new Worker(...)`; stubbing the global with an instance
  // would throw "not a constructor", so the stub is a factory returning the shared fake.
  function workerFactory(): FakeWorker {
    return worker;
  }

  function setupScene(initial: unknown): void {
    unmount();
    saved = initial as CityStateV4 | undefined;
    mount();
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    saveError = null;
    wallCreateError = null;
    wallDocuments = [];
    worker = new FakeWorker("worker-url");
    const scene = {
      get walls(): Array<{ id: string }> { return wallDocuments; },
      getFlag: (_module: string, flag: string): unknown => flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? saved : undefined,
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV4): Promise<CityStateV4> => {
        if (saveError !== null) throw saveError;
        saved = structuredClone(value);
        return saved;
      }),
      unsetFlag: vi.fn(async (_module: string, _flag: string): Promise<void> => {
        saved = undefined;
      }),
      deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
        wallDocuments = wallDocuments.filter((wall) => !ids.includes(wall.id));
        return [];
      }),
      createEmbeddedDocuments: vi.fn(async (_type: string, data: Array<Record<string, unknown>>) => {
        if (wallCreateError !== null) throw wallCreateError;
        const created = data.map((value, index) => ({
          id: `wall-${index}`,
          ...value,
          getFlag: () => undefined
        }));
        wallDocuments.push(...created);
        return created;
      })
    };
    vi.stubGlobal("canvas", {
      ready: true,
      dimensions: { sceneRect: { x: 400, y: 320, width: 200, height: 160 }, size: 1, distance: 1 },
      scene,
      app: undefined
    });
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
    vi.stubGlobal("CONST", { EDGE_SENSE_TYPES: { LIMITED: 1 }, WALL_MOVEMENT_TYPES: { NORMAL: 1 } });
    vi.stubGlobal("document", { baseURI: "http://test.local/" });
    vi.stubGlobal("Worker", workerFactory);
    setupScene(bulkRoadState());
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies class and name to exactly the selected edges with a multi-selection", async () => {
    await reclassifyRoad("arterial", true, ["edge-a", "edge-c"]);
    await renameRoad("Boulevard", true, ["edge-a", "edge-c"]);
    expect(saved?.revision).toBe(3);
    expect(saved!.source.roads.edges.map((edge: CityStateV4["source"]["roads"]["edges"][number]) => [edge.id, edge.classId, edge.name])).toEqual([
      ["edge-a", "arterial", "Boulevard"],
      ["edge-b", "street", "A"],
      ["edge-c", "arterial", "Boulevard"],
      ["edge-d", "narrow", "C"]
    ]);
  }, 120_000);

  it("commits district geometry and rebuilds the complete plan in the same action", async () => {
    await createDistrict([
      { x: -90, y: -70 },
      { x: -70, y: -70 },
      { x: -70, y: -50 },
      { x: -90, y: -50 }
    ], "corporate-core");
    expect(saved?.revision).toBe(2);
    expect(saved!.source.districts).toHaveLength(1);
    expect(saved!.source.districts[0]!.paletteId).toBe("corporate");
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 2 }));
    await expect(undo()).resolves.toBe(true);
    expect(saved?.source.districts).toHaveLength(0);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 3 }));
  }, 120_000);

  it("rejects Fill with more than one selected district before planning", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "night-market");
    const ids = saved!.source.districts.map((district) => district.id);
    selectDistrict(ids[0]!);
    selectDistrict(ids[1]!, true);
    await expect(fillDistrict({ x: 0, y: 0 }, "corporate-core")).rejects.toThrow("Fill requires zero or one selected district.");
  }, 120_000);

  it("rejects Split unless the requested district is the sole selection", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "night-market");
    const ids = saved!.source.districts.map((district) => district.id);
    selectDistrict(ids[0]!);
    selectDistrict(ids[1]!, true);
    await expect(splitDistrict(ids[0]!, [{ x: -80, y: -80 }, { x: -80, y: -40 }])).rejects.toThrow("Split requires exactly one selected district.");
  }, 120_000);

  it("rejects repeat initial generation without replacing existing districts", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    const before = structuredClone(saved);
    await expect(generateDistricts({ districtPool: ["corporate-core"], openSpaceProfile: "medium" })).rejects.toThrow("requires an empty district source");
    expect(saved).toEqual(before);
  }, 120_000);

  it("preserves the selected merge participants when persistence fails", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -70, y: -70 }, { x: -50, y: -70 }, { x: -50, y: -50 }, { x: -70, y: -50 }
    ], "night-market");
    const ids = saved!.source.districts.map((district) => district.id);
    selectDistrict(ids[0]!);
    selectDistrict(ids[1]!, true);
    saveError = new Error("save failed");
    await expect(mergeDistricts(ids, ids[0]!)).rejects.toThrow("save failed");
    expect(getDistrictSelection()).toEqual([...ids].sort());
  }, 120_000);

  it("retains a degraded wall diagnostic while editing and clears it after Retry succeeds", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    wallCreateError = new Error("wall creation failed");
    await expect(retryGeneratedWalls()).rejects.toThrow("wall creation failed");
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ subsystem: "walls", retry: "walls", message: "wall creation failed" })]));
    const revision = saved?.revision;
    wallCreateError = null;
    await expect(retryGeneratedWalls()).resolves.toBeUndefined();
    expect(saved?.revision).toBe(revision);
    expect(districtDiagnostics().some((entry) => entry.subsystem === "walls")).toBe(false);
    expect(wallDocuments.length).toBeGreaterThan(0);
  }, 120_000);

  it("persists a revision-bound render diagnostic when install fails after a committed edit", async () => {
    let tampered = false;
    worker.tamper = (request, response) => {
      if (request.type === "buildCompleteCityChunks" && request.sourceRevision === 2 && !tampered && response.ok === true && "progress" in response && isRecord(response.result)) {
        response.result = { ...response.result, sourceRevision: 999 };
        tampered = true;
      }
    };
    const result = await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    expect(tampered).toBe(true);
    // The committed source is authoritative even though presentation failed.
    expect(saved?.revision).toBe(2);
    expect(saved!.source.districts).toHaveLength(1);
    // The returned result is degraded, and the failed install is not stored as a build.
    expect(result).toMatchObject({ full: true, degraded: true, chunks: 0 });
    expect(stats()?.lastBuild).not.toEqual(expect.objectContaining({ degraded: true }));
    // Post-save render copy, distinct from a structural-before-save rejection.
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subsystem: "geometry",
        retry: "geometry",
        revision: 2,
        message: expect.stringContaining("The city was saved, but final presentation failed")
      })
    ]));
  }, 120_000);

  it("clears the render diagnostic only after a matching geometry retry installs the chunks", async () => {
    worker.tamper = (request, response) => {
      if (request.type === "buildCompleteCityChunks" && request.sourceRevision === 2 && response.ok === true && "progress" in response && isRecord(response.result)) {
        response.result = { ...response.result, sourceRevision: 999 };
      }
    };
    const failed = await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    expect(failed.degraded).toBe(true);
    expect(districtDiagnostics().some((entry) => entry.retry === "geometry")).toBe(true);
    const buildsBefore = worker.planBuilds;
    // A still-failing retry reinstalls nothing and keeps the diagnostic.
    await expect(retryGeometry()).rejects.toThrow();
    expect(districtDiagnostics().some((entry) => entry.retry === "geometry")).toBe(true);
    worker.tamper = null;
    const retried = await retryGeometry();
    expect(retried.degraded).not.toBe(true);
    expect(retried.stale).toBe(false);
    expect(stats()?.lastBuild).toEqual(retried);
    expect(saved?.revision).toBe(2);
    expect(districtDiagnostics().some((entry) => entry.retry === "geometry")).toBe(false);
    // The retry reinstalled the plan's chunks without rebuilding the plan.
    expect(worker.planBuilds).toBe(buildsBefore);
  }, 120_000);

  it("rejects an install whose accepted progress does not match the worker summary", async () => {
    worker.tamper = (request, response) => {
      if (request.type === "buildCompleteCityChunks" && request.sourceRevision === 2 && response.ok === true && !("progress" in response) && isRecord(response.result) && isRecord(response.result.counters)) {
        const built = response.result.counters.built;
        response.result = { ...response.result, counters: { ...response.result.counters, built: typeof built === "number" ? built + 1 : built } };
      }
    };
    const result = await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    // Incomplete progress cannot report success: the batch fails degraded instead.
    expect(result).toMatchObject({ full: true, degraded: true, chunks: 0 });
    expect(saved?.revision).toBe(2);
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subsystem: "geometry", retry: "geometry", revision: 2 })
    ]));
    worker.tamper = null;
    const retried = await retryGeometry();
    expect(retried.degraded).not.toBe(true);
    expect(districtDiagnostics().some((entry) => entry.retry === "geometry")).toBe(false);
  }, 120_000);

  it("keeps additive selection within the district object type across district identities", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -30, y: -70 }, { x: -10, y: -70 }, { x: -10, y: -50 }, { x: -30, y: -50 }
    ], "night-market");
    const corporate = saved!.source.districts.filter((district) => district.typeId === "corporate-core");
    const market = saved!.source.districts.find((district) => district.typeId === "night-market")!;
    selectDistrict(corporate[0]!.id);
    selectDistrict(corporate[1]!.id, true);
    expect(getDistrictSelection()).toEqual(corporate.map((district) => district.id).sort());
    selectDistrict(market.id, true);
    expect(getDistrictSelection()).toEqual([...corporate.map((district) => district.id), market.id].sort());
  }, 120_000);

  it("applies a curve preset to every route represented by the selected edges", async () => {
    await setRoadCurvePreset("broad", ["edge-a", "edge-c"]);
    expect(saved?.revision).toBe(2);
    expect(saved!.source.roads.routes).toEqual([
      { id: "route-a", curvePreset: "broad" },
      { id: "route-b", curvePreset: "broad" }
    ]);
  }, 120_000);

  it("rejects duplicate or stale selections before saving", async () => {
    const before = structuredClone(saved);
    await expect(setRoadLocked(true, ["edge-a", "edge-a"])).rejects.toThrow("Road selection is stale");
    await expect(setRoadLocked(true, ["missing"])).rejects.toThrow("Road selection is stale");
    expect(saved).toEqual(before);
  });

  it("keeps a selected edge across a metadata-only commit", async () => {
    selectRoad("edge-a");
    await setRoadLocked(true);
    expect(getRoadSelection().edgeIds).toEqual(["edge-a"]);
  }, 120_000);

  it("keeps a selected edge across a full rebuild commit", async () => {
    selectRoad("edge-a");
    await setRoadCurvePreset("broad", ["edge-a"]);
    expect(getRoadSelection().edgeIds).toEqual(["edge-a"]);
  }, 120_000);

  it("drops deleted roads from the selection", async () => {
    selectRoad("edge-a");
    selectRoad("edge-b", true);
    await deleteRoads(["edge-a"]);
    expect(getRoadSelection().edgeIds).toEqual(["edge-b"]);
  }, 120_000);

  it("drops deleted junctions from the selection", async () => {
    selectRoadNode("a1");
    await deleteRoadJunction("a1");
    expect(getRoadSelection().nodeIds).toEqual([]);
  }, 120_000);

  it("keeps only the latest revision's plan across rapid commits", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "night-market");
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: saved?.revision }));
    const view = getDistrictPlanView();
    const fragmentIds = new Set((view?.blocks ?? []).flatMap((block) => block.districtFragments.map((fragment) => fragment.districtId)));
    expect(fragmentIds.size).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("makes Fill wait for the current plan and target a road-defined block", async () => {
    // No commit has published a plan yet; Fill must rebuild and await it itself.
    await fillDistrict({ x: -45, y: 0 }, "night-market");
    expect(saved?.source.districts).toHaveLength(1);
  }, 120_000);

  it("rejects structural commits without a worker and leaves the flag untouched", async () => {
    // Re-mount with no worker so no stale client from the initial mount survives.
    vi.stubGlobal("Worker", undefined);
    unmount();
    mount();
    const before = structuredClone(saved);
    await expect(createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core")).rejects.toThrow(/worker is unavailable/);
    expect(saved).toEqual(before);
    const complete = stats()?.completePlan;
    expect(isRecord(complete) ? complete.revision : null).not.toBe(2);
  }, 120_000);

  it("restores the plan when Retry succeeds after the worker returns", async () => {
    vi.stubGlobal("Worker", undefined);
    unmount();
    mount();
    await expect(fillDistrict({ x: -45, y: 0 }, "night-market")).rejects.toThrow(/unavailable/);
    expect(districtDiagnostics().some((entry) => entry.retry === "plan")).toBe(true);
    vi.stubGlobal("Worker", workerFactory);
    await retryDistrictPlan();
    expect(getDistrictPlanView()).not.toBeNull();
    expect(districtDiagnostics().some((entry) => entry.retry === "plan")).toBe(false);
  }, 120_000);
});

describe("full generation", () => {
  let saved: unknown;
  let wallDocuments: Array<{ id: string }>;
  let saveError: Error | null;
  let worker: FakeWorker;

  // WHY: the adapter constructs `new Worker(...)`; the stub must be a constructor-like
  // factory returning the shared fake (see the road describe).
  function workerFactory(): FakeWorker {
    return worker;
  }

  function setupScene(initial: unknown): void {
    unmount();
    saved = initial;
    mount();
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    wallDocuments = [];
    saveError = null;
    worker = new FakeWorker("worker-url");
    const scene = {
      get walls(): Array<{ id: string }> { return wallDocuments; },
      getFlag: (_module: string, flag: string): unknown => flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? saved : undefined,
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV4): Promise<CityStateV4> => {
        if (saveError !== null) throw saveError;
        saved = structuredClone(value);
        return saved as CityStateV4;
      }),
      unsetFlag: vi.fn(async (_module: string, _flag: string): Promise<void> => {
        saved = undefined;
      }),
      deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
        wallDocuments = wallDocuments.filter((wall) => !ids.includes(wall.id));
        return [];
      }),
      createEmbeddedDocuments: vi.fn(async (_type: string, data: Array<Record<string, unknown>>) => {
        const created = data.map((value, index) => ({
          id: `wall-${index}`,
          ...value,
          getFlag: () => undefined
        }));
        wallDocuments.push(...created);
        return created;
      })
    };
    vi.stubGlobal("canvas", {
      ready: true,
      dimensions: { sceneRect: { x: 400, y: 320, width: 200, height: 160 }, size: 1, distance: 1 },
      scene,
      app: undefined
    });
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
    vi.stubGlobal("CONST", { EDGE_SENSE_TYPES: { LIMITED: 1 }, WALL_MOVEMENT_TYPES: { NORMAL: 1 } });
    vi.stubGlobal("document", { baseURI: "http://test.local/" });
    vi.stubGlobal("Worker", workerFactory);
    setupScene(undefined);
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // WHY: the UI pins the confirmation from the pre-dialog preflight; tests mirror that by
  // defaulting to the live Scene's preflight-derived confirmation (kind + revision + exact
  // raw identity), so a same-kind payload swap is pinned the same way a user would confirm.
  const staging = (seed: string, confirmation?: ClearConfirmation) => ({
    terrainMode: "rectangle" as const,
    coastEdge: null,
    citySeed: seed,
    roadLayout: "european" as const,
    hubMode: "single-centre" as const,
    districtPool: [...DISTRICT_TYPE_IDS],
    openSpaceProfile: "medium" as const,
    randomize: false,
    confirmation: confirmation ?? clearConfirmationFor(generationPreflight())
  });

  it("preflights absent, legacy, obsolete-precomplete, supported, and unreplaceable states cheaply", () => {
    setupScene(undefined);
    expect(generationPreflight()).toMatchObject({ kind: "absent", replaceable: true });
    setupScene({ formatVersion: 4 });
    expect(generationPreflight()).toMatchObject({ kind: "legacy", replaceable: true });
    setupScene({ kind: "city-generator-2", schemaVersion: 3, generatorVersion: 10, revision: 6 });
    expect(generationPreflight()).toMatchObject({ kind: "obsolete-precomplete", replaceable: true, revision: 6 });
    setupScene(bulkRoadState());
    expect(generationPreflight()).toMatchObject({ kind: "supported", replaceable: true, revision: 1 });
    setupScene({ kind: "city-generator-2", schemaVersion: 99, generatorVersion: 11, revision: 1 });
    expect(generationPreflight()).toMatchObject({ kind: "unsupported", replaceable: false });
    setupScene({ kind: "city-generator-2", schemaVersion: 3, generatorVersion: 11, revision: "broken" });
    expect(generationPreflight()).toMatchObject({ kind: "malformed", replaceable: false });
  }, 30_000);

  it("reports GM authority in the preflight", () => {
    setupScene(undefined);
    expect(generationPreflight().gm).toBe(true);
    vi.stubGlobal("game", { user: { isGM: false } });
    expect(generationPreflight().gm).toBe(false);
  });

  it("rejects a non-GM start before claiming, enqueueing, or clearing", async () => {
    setupScene(bulkRoadState());
    vi.stubGlobal("game", { user: { isGM: false } });
    const before = structuredClone(saved);
    await expect(startFullGeneration(staging("non-gm"))).rejects.toThrow(/Only a GM/);
    expect(saved).toEqual(before);
    expect(generationState().active).toBe(false);
    expect(generationState().phase).toBe("idle");
  }, 30_000);

  it("rejects non-GM retries and new-seed generation without claiming", async () => {
    vi.stubGlobal("Worker", undefined);
    await startFullGeneration(staging("gm-retry"));
    expect(generationState().phase).toBe("failed");
    const before = structuredClone(saved);
    vi.stubGlobal("game", { user: { isGM: false } });
    vi.stubGlobal("Worker", workerFactory);
    await expect(retryFullGeneration()).rejects.toThrow(/Only a GM/);
    await expect(generateNewSeed()).rejects.toThrow(/Only a GM/);
    expect(saved).toEqual(before);
    expect(generationState().active).toBe(false);
  });

  it("generates a complete city end to end on an absent Scene", async () => {
    const result = await startFullGeneration(staging("full-city-seed"));
    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe("complete");
    expect(result.state.sourceRevision).toBe(1);
    const city = getCity();
    expect(city).not.toBeNull();
    expect(city!.source.citySeed).toBe("full-city-seed");
    expect(city!.source.districts.length).toBeGreaterThan(0);
    expect(city!.source.roads.edges.length).toBeGreaterThan(0);
    expect(saved).toEqual(city);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 1 }));
    await vi.waitFor(() => expect(wallDocuments.length).toBeGreaterThan(0), { timeout: 5000 });
  }, 120_000);

  it("clears legacy data before full generation", async () => {
    setupScene({ formatVersion: 4 });
    const result = await startFullGeneration(staging("legacy-replace"));
    expect(result.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("legacy-replace");
    expect(saved).toEqual(getCity());
  }, 120_000);

  it("clears obsolete-precomplete flags before full generation", async () => {
    setupScene({ kind: "city-generator-2", schemaVersion: 3, generatorVersion: 10, revision: 6 });
    const result = await startFullGeneration(staging("obsolete-replace"));
    expect(result.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("obsolete-replace");
  }, 120_000);

  it("replaces a supported city at its exact revision", async () => {
    setupScene(bulkRoadState());
    const result = await startFullGeneration(staging("supported-replace"));
    expect(result.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("supported-replace");
    expect(getCity()?.revision).toBe(1);
  }, 120_000);

  it("rejects invalid staged settings before claiming, enqueueing, or clearing", async () => {
    const before = structuredClone(saved);
    const beforeState = generationState();
    // WHY: the seed is normalized before validation, so a blank non-random seed throws
    // synchronously rather than rejecting; either way nothing is claimed or cleared.
    expect(() => startFullGeneration(staging("   "))).toThrow(/must not be empty/);
    await expect(startFullGeneration({ ...staging("pool"), districtPool: [] })).rejects.toThrow(/at least one district type/);
    await expect(startFullGeneration({ ...staging("coast"), terrainMode: "coastal", coastEdge: null })).rejects.toThrow(/coast edge/);
    await expect(startFullGeneration({ ...staging("coast-edge"), terrainMode: "rectangle", coastEdge: "west" })).rejects.toThrow(/only applies to coastal/);
    expect(saved).toEqual(before);
    // The pre-call state (whatever it was) is untouched: no claim, no clear, no failure.
    expect(generationState()).toEqual(beforeState);
  });

  it("rejects a stale pre-dialog confirmation without clearing", async () => {
    setupScene(bulkRoadState());
    const pinned = clearConfirmationFor(generationPreflight());
    expect(pinned).toMatchObject({ kind: "supported", revision: 1 });
    if (typeof pinned !== "string") expect(pinned.identity.length).toBeGreaterThan(0);
    // The Scene moves past the confirmed revision while the dialogs are open.
    setupScene({ ...bulkRoadState(), revision: 2 });
    const before = structuredClone(saved);
    await expect(startFullGeneration(staging("stale-pin", pinned))).rejects.toThrow(/Scene changed while you confirmed/);
    expect(saved).toEqual(before);
    expect(generationPreflight()).toMatchObject({ kind: "supported", revision: 2 });
    expect(generationState().active).toBe(false);
    expect(generationState().phase).toBe("idle");
  }, 120_000);

  it("rejects a retry when the Scene moved past the confirmed operation", async () => {
    vi.stubGlobal("Worker", undefined);
    await startFullGeneration(staging("moved-on"));
    expect(generationState().phase).toBe("failed");
    // A different city appears before the retry; it was not authorized by the operation.
    setupScene(bulkRoadState());
    vi.stubGlobal("Worker", workerFactory);
    await expect(retryFullGeneration()).rejects.toThrow(/fresh confirmation/);
    expect(saved).toEqual(bulkRoadState());
    expect(generationState().active).toBe(false);
    expect(generationState().phase).toBe("idle");
  }, 120_000);

  it("retries an installing-phase failure while the Scene is still the revision it created", async () => {
    let tampered = false;
    worker.tamper = (request, response) => {
      if (request.type === "buildCompleteCityChunks" && !tampered && response.ok === true && "progress" in response && isRecord(response.result)) {
        response.result = { ...response.result, sourceRevision: 999 };
        tampered = true;
      }
    };
    const failed = await startFullGeneration(staging("install-retry"));
    expect(failed.ok).toBe(false);
    expect(generationState().failure).toMatchObject({ phase: "installing", component: "chunks" });
    // The Scene is still exactly the revision this confirmed operation created, so the
    // same-operation retry clears without fresh confirmations.
    expect(generationPreflight()).toMatchObject({ kind: "supported", revision: 1 });
    const retried = await retryFullGeneration();
    expect(retried.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("install-retry");
    expect(getCity()?.revision).toBe(1);
  }, 120_000);

  it("reports the operation epoch equal to the published session epoch", async () => {
    const result = await startFullGeneration(staging("epoch-equality"));
    expect(result.ok).toBe(true);
    const buildEpoch = stats()?.buildEpoch;
    expect(typeof buildEpoch).toBe("number");
    expect(result.state.epoch).toBe(buildEpoch);
    // Post-clear epochs are positive; a pre-clear capture would collide with the session
    // epoch seen before the operation started.
    expect(result.state.epoch).toBeGreaterThan(0);
  }, 120_000);

  it("clears old selections and scene state immediately after the confirmed clear", async () => {
    setupScene(bulkRoadState());
    selectRoad("edge-a");
    selectRoadNode("a0");
    const snapshots: Array<{ roads: number; nodes: number; districts: number; kind: string }> = [];
    const remove = addCityListener(() => {
      const selection = getRoadSelection();
      snapshots.push({
        roads: selection.edgeIds.length,
        nodes: selection.nodeIds.length,
        districts: getDistrictSelection().length,
        kind: generationPreflight().kind
      });
    });
    try {
      const result = await startFullGeneration(staging("cleared-visuals"));
      expect(result.ok).toBe(true);
    } finally {
      remove();
    }
    expect(snapshots.some((s) => s.kind === "supported" && (s.roads > 0 || s.nodes > 0))).toBe(true);
    expect(snapshots.some((s) => s.kind === "absent" && s.roads === 0 && s.nodes === 0 && s.districts === 0)).toBe(true);
    expect(getRoadSelection().edgeIds).toEqual([]);
    expect(getRoadSelection().nodeIds).toEqual([]);
    expect(getDistrictSelection()).toEqual([]);
  }, 120_000);

  it("refuses to start on unreplaceable Scene state without touching the flag", async () => {
    setupScene({ kind: "city-generator-2", schemaVersion: 99, generatorVersion: 11, revision: 1 });
    const before = structuredClone(saved);
    await expect(startFullGeneration(staging("never", { kind: "supported", revision: 1, identity: "unused" }))).rejects.toThrow(/cannot replace/i);
    expect(saved).toEqual(before);
    expect(generationState().active).toBe(false);
  });

  it("refuses a second start while one is already in progress", async () => {
    const first = startFullGeneration(staging("in-flight"));
    await expect(startFullGeneration(staging("second"))).rejects.toThrow(/already in progress/i);
    await expect(first).resolves.toMatchObject({ ok: true });
  }, 120_000);

  it("leaves an absent flag and a durable failure state when planning fails", async () => {
    vi.stubGlobal("Worker", undefined);
    const result = await startFullGeneration(staging("doomed"));
    expect(result.ok).toBe(false);
    const state = generationState();
    expect(state.phase).toBe("failed");
    expect(state.failure).toMatchObject({ phase: "planning", component: "generation" });
    expect(state.canRetrySameSeed).toBe(true);
    expect(state.canGenerateNewSeed).toBe(true);
    expect(generationPreflight()).toMatchObject({ kind: "absent" });
    expect(getCity()).toBeNull();
  }, 120_000);

  it("retries the failed generation with the exact same seed", async () => {
    vi.stubGlobal("Worker", undefined);
    await startFullGeneration(staging("same-seed"));
    expect(generationState().phase).toBe("failed");
    vi.stubGlobal("Worker", workerFactory);
    const result = await retryFullGeneration();
    expect(result.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("same-seed");
  }, 120_000);

  it("generates a new seed on retry", async () => {
    vi.stubGlobal("Worker", undefined);
    await startFullGeneration(staging("old-seed"));
    vi.stubGlobal("Worker", workerFactory);
    const result = await generateNewSeed("brand-new-seed");
    expect(result.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("brand-new-seed");
  }, 120_000);

  it("rolls a random seed when requested", async () => {
    vi.stubGlobal("Worker", undefined);
    await startFullGeneration(staging("fixed-seed"));
    vi.stubGlobal("Worker", workerFactory);
    const result = await randomizeEntireCity(staging("ignored-seed"));
    expect(result.ok).toBe(true);
    expect(getCity()?.source.citySeed).not.toBe("ignored-seed");
    expect(getCity()?.source.citySeed.length).toBeGreaterThan(0);
  }, 120_000);

  it("rolls a fresh non-empty seed for a blank staged seed via randomizeEntireCity", async () => {
    const result = await randomizeEntireCity(staging("   "));
    expect(result.ok).toBe(true);
    const seed = getCity()?.source.citySeed ?? "";
    expect(seed.trim().length).toBeGreaterThan(0);
    expect(seed.trim()).not.toBe("");
  }, 120_000);

  it("stores no stale chunk records or progress when the session moves during progressive install", async () => {
    let bumped = false;
    const observedProgress: number[] = [];
    const remove = addCityListener(() => {
      const progress = generationState().progress;
      if (progress !== null && progress.total > 0) observedProgress.push(progress.index);
    });
    worker.tamper = (request, response) => {
      if (request.type === "buildCompleteCityChunks" && !bumped && response.ok === true && "progress" in response && isRecord(response.result)) {
        bumped = true;
        // WHY: simulate the session moving past the install identity mid-stream (e.g. a
        // canvas remount while chunks are still arriving): the session epoch bumps and
        // the saved revision-1 city stays current, so geometry recovery stays available.
        mount();
      }
    };
    try {
      const result = await startFullGeneration(staging("stale-session"));
      expect(result.ok).toBe(false);
      expect(generationState().failure).toMatchObject({ phase: "installing", component: "chunks" });
      expect(generationState().canRetryGeometry).toBe(true);
    } finally {
      remove();
      worker.tamper = null;
    }
    // The session moved before the first chunk landed, so no onProgress update was stored.
    expect(observedProgress).toEqual([]);
  }, 120_000);

  it("rejects retries when there is no failed generation", async () => {
    const result = await startFullGeneration(staging("clean-run"));
    expect(result.ok).toBe(true);
    await expect(retryFullGeneration()).rejects.toThrow(/no failed full generation/);
    await expect(generateNewSeed()).rejects.toThrow(/no failed full generation/);
  }, 120_000);

  it("reports a revision-1 save failure with component save and a durable retry", async () => {
    saveError = new Error("save failed");
    const result = await startFullGeneration(staging("save-doomed"));
    expect(result.ok).toBe(false);
    expect(generationState().failure).toMatchObject({ phase: "saving", component: "save" });
    expect(generationState().canRetrySameSeed).toBe(true);
    // The clear already happened, so no city flag is left behind.
    expect(generationPreflight()).toMatchObject({ kind: "absent" });
    saveError = null;
    const retried = await retryFullGeneration();
    expect(retried.ok).toBe(true);
    expect(getCity()?.source.citySeed).toBe("save-doomed");
  }, 120_000);

  it("installs final chunks progressively and publishes progress", async () => {
    const phases: string[] = [];
    const remove = addCityListener(() => {
      const state = generationState();
      phases.push(`${state.phase}:${state.progress?.total ?? 0}`);
    });
    try {
      const result = await startFullGeneration(staging("progressive"));
      expect(result.ok).toBe(true);
      expect(phases).toEqual(expect.arrayContaining([expect.stringMatching(/^installing:/)]));
      expect(phases.some((entry) => /^installing:[1-9]/.test(entry))).toBe(true);
      expect(generationState().phase).toBe("complete");
    } finally {
      remove();
    }
  }, 120_000);

  it("installs nothing from a stale full-generation result", async () => {
    worker.tamper = (request, response) => {
      if (request.type === "generateCompleteCityPlan" && response.ok === true && isRecord(response.result)) {
        response.result = { ...response.result, actionToken: "tampered" };
      }
    };
    await expect(startFullGeneration(staging("stale-plan"))).resolves.toMatchObject({ ok: false });
    expect(generationState().failure?.component).toBe("generation");
    // The clear happened, so the flag is absent — nothing stale was installed.
    expect(generationPreflight()).toMatchObject({ kind: "absent" });
  }, 120_000);

  it("isolates a stale chunk progress batch without corrupting the chunk set", async () => {
    let tampered = false;
    worker.tamper = (request, response) => {
      if (request.type === "buildCompleteCityChunks" && !tampered && response.ok === true && "progress" in response && isRecord(response.result)) {
        response.result = { ...response.result, sourceRevision: 999 };
        tampered = true;
      }
    };
    const result = await startFullGeneration(staging("stale-chunks"));
    expect(result.ok).toBe(false);
    expect(generationState().failure).toMatchObject({ phase: "installing", component: "chunks" });
    expect(generationState().canRetryGeometry).toBe(true);
  }, 120_000);

  it("keeps the operation state across an editor round-trip", async () => {
    vi.stubGlobal("Worker", undefined);
    await startFullGeneration(staging("durable-failure"));
    expect(generationState().phase).toBe("failed");
    unmount();
    mount();
    expect(generationState().phase).toBe("failed");
    expect(generationState().canRetrySameSeed).toBe(true);
    vi.stubGlobal("Worker", workerFactory);
    const result = await retryFullGeneration();
    expect(result.ok).toBe(true);
  }, 120_000);

  it("reuses the current semantic plan on rebuild and only reinstalls chunks", async () => {
    const result = await startFullGeneration(staging("scale-stable"));
    expect(result.ok).toBe(true);
    const buildsBefore = worker.planBuilds;
    const rebuild = await rebuildGeometry();
    expect(rebuild.chunks).toBeGreaterThanOrEqual(0);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 1 }));
    expect(worker.planBuilds).toBe(buildsBefore);
  }, 120_000);

  it("reuses the current plan for metadata-only edits and rebuilds it for structural edits", async () => {
    await startFullGeneration(staging("edit-reuse"));
    const complete = stats()?.completePlan;
    if (!isRecord(complete)) throw new Error("expected a published complete plan");
    const buildToken = String(complete.buildToken);
    const buildsAfterGeneration = worker.planBuilds;
    await renameRoad("Renamed", false, [getCity()!.source.roads.edges[0]!.id]);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ buildToken }));
    expect(worker.planBuilds).toBe(buildsAfterGeneration);
    await setRoadCurvePreset("broad", [getCity()!.source.roads.edges[0]!.id]);
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: 3 }));
    expect(worker.planBuilds).toBeGreaterThan(buildsAfterGeneration);
  }, 120_000);
  describe("architecture actions", () => {
    const buildingSite: Ring = [
      { x: -12, y: -12 },
      { x: 12, y: -12 },
      { x: 12, y: 12 },
      { x: -12, y: 12 }
    ];
    const buildingPlacement: PlacementFrame = {
      centre: { x: 0, y: 0 },
      rotationRad: 0,
      widthM: 12,
      depthM: 12
    };
    const placeSite: Ring = [
      { x: -95, y: 15 },
      { x: -25, y: 15 },
      { x: -25, y: 65 },
      { x: -95, y: 65 }
    ];
    const placePlacement: PlacementFrame = {
      centre: { x: -60, y: 40 },
      rotationRad: 0,
      widthM: 30,
      depthM: 20
    };

    function buildingInput(overrides: Partial<BuildingPlacementInput> = {}): BuildingPlacementInput {
      return {
        grammarId: "narrow-shopfront",
        visualUse: "commercial",
        heightM: 30,
        paletteId: "corporate",
        placement: structuredClone(buildingPlacement),
        sitePolygon: structuredClone(buildingSite),
        ...overrides
      };
    }

    function placeInput(overrides: Partial<PlacePlacementInput> = {}): PlacePlacementInput {
      return {
        landmarkGrammarId: "hero-tower-plaza",
        paletteId: "corporate",
        placement: structuredClone(placePlacement),
        sitePolygon: structuredClone(placeSite),
        ...overrides
      };
    }

    async function settleMountedPlan(): Promise<void> {
      await vi.waitFor(() => {
        if (!isRecord(stats()?.completePlan)) throw new Error("expected a complete plan after mount");
      }, { timeout: 15_000 });
    }

    async function generatedCity(seed = "architecture-generated"): Promise<CityStateV4> {
      const result = await startFullGeneration(staging(seed));
      expect(result.ok).toBe(true);
      const city = getCity();
      if (city === null) throw new Error("expected generated city");
      return city;
    }

    function generatedBuilding(): {
      city: CityStateV4;
      plan: CompleteCityPlan;
      building: CompleteCityPlan["buildings"][number];
    } {
      const city = getCity();
      if (city === null) throw new Error("expected current city");
      const plan = buildCompleteCityPlan(city.source, city.revision);
      const building = plan.buildings.find((candidate) => {
        if (candidate.sourceId !== null || candidate.placement === undefined || candidate.sitePolygon.length !== 4) return false;
        const footprintArea = candidate.placement.widthM * candidate.placement.depthM;
        return Math.abs(ringArea(candidate.sitePolygon)) + footprintArea * 1e-6 >= footprintArea;
      });
      if (building === undefined) throw new Error("expected a generated building with a placement frame");
      return { city, plan, building };
    }

    it("places authored buildings and places with deterministic identities and manual-edit protection", async () => {
      setupScene(state());
      await settleMountedPlan();
      const planBuildsBeforeBuilding = worker.planBuilds;
      const chunkBuildsBeforeBuilding = worker.chunkBuilds;
      const fullChunkCount = Math.max(...worker.chunkRequests.map((request) => request.length));

      await placeBuilding(buildingInput());
      expect(worker.planBuilds).toBe(planBuildsBeforeBuilding);
      expect(worker.chunkBuilds).toBe(chunkBuildsBeforeBuilding + 1);
      expect(worker.chunkRequests.at(-1)!.length).toBeGreaterThan(0);
      expect(worker.chunkRequests.at(-1)!.length).toBeLessThanOrEqual(fullChunkCount);
      const afterBuilding = getArchitectureSource();
      expect(afterBuilding).not.toBeNull();
      const building = afterBuilding!.buildings[0]!;
      expect(building).toMatchObject({
        origin: "authored",
        protection: "manual-edit",
        grammarId: "narrow-shopfront",
        visualUse: "commercial",
        heightM: 30,
        paletteId: "corporate",
        sitePolygon: buildingSite,
        placement: buildingPlacement,
        districtId: null,
        blockId: null
      });
      expect(building.id).toMatch(/^m_bldg_[0-9a-f]{8}$/);
      expect(building.lineage).toMatch(/^manual\/bldg\/1\/0\/[0-9a-f]{8}$/);
      expect(building.lineage).toBe(allocateManualLineage(
        "bldg",
        1,
        0,
        "narrow-shopfront",
        "commercial",
        30,
        "corporate",
        buildingPlacement,
        buildingSite
      ));
      expect(building.id).toBe(allocateManualId("bldg", 1, 0, building.lineage));
      expect(building.seed).toBe(`adapter-fixture/architecture/${building.lineage}/geometry`);
      expect(building.appearanceSeed).toBe(`adapter-fixture/architecture/${building.lineage}/appearance`);

      await placePlace(placeInput());
      expect(worker.chunkRequests.at(-1)!.length).toBeGreaterThan(0);
      expect(worker.chunkRequests.at(-1)!.length).toBeLessThanOrEqual(fullChunkCount);
      const afterPlace = getArchitectureSource();
      expect(afterPlace).not.toBeNull();
      const place = afterPlace!.places[0]!;
      expect(place).toMatchObject({
        origin: "authored",
        protection: "manual-edit",
        landmarkGrammarId: "hero-tower-plaza",
        paletteId: "corporate",
        sitePolygon: placeSite,
        placement: placePlacement,
        districtId: null,
        blockId: null
      });
      expect(place.id).toMatch(/^m_plc_[0-9a-f]{8}$/);
      expect(place.lineage).toMatch(/^manual\/plc\/2\/0\/[0-9a-f]{8}$/);
      expect(place.lineage).toBe(allocateManualLineage(
        "plc",
        2,
        0,
        "hero-tower-plaza",
        "corporate",
        placePlacement,
        placeSite
      ));
      expect(place.id).toBe(allocateManualId("plc", 2, 0, place.lineage));
      expect(place.seed).toBe(`adapter-fixture/architecture/${place.lineage}/geometry`);

      expect(place.appearanceSeed).toBe(`adapter-fixture/architecture/${place.lineage}/appearance`);
    }, 120_000);
    it("rebuilds only affected block chunks for authored placement and type edits", async () => {
      Object.assign(canvas.dimensions.sceneRect, { x: 200, y: 100, width: 600, height: 600 });
      setupScene(state());
      await settleMountedPlan();
      await vi.waitFor(() => {
        expect(cacheState.publishChunks).toHaveBeenCalled();
      }, { timeout: 15_000 });
      const fullChunkCount = Math.max(...worker.chunkRequests.map((request) => request.length));
      const planBuilds = worker.planBuilds;
      const chunkBuilds = worker.chunkBuilds;
      cacheState.publishChunks.mockClear();
      const site: Ring = [
        { x: 28, y: 28 },
        { x: 52, y: 28 },
        { x: 52, y: 52 },
        { x: 28, y: 52 }
      ];
      const placement: PlacementFrame = {
        ...buildingPlacement,
        centre: { x: 40, y: 40 }
      };

      const placed = await placeBuilding(buildingInput({ placement, sitePolygon: site }));
      expect(worker.planBuilds).toBe(planBuilds);
      expect(worker.chunkBuilds).toBe(chunkBuilds + 1);
      expect(worker.chunkRequests.at(-1)!.length).toBeGreaterThan(0);
      expect(worker.chunkRequests.at(-1)!.length).toBeLessThan(fullChunkCount);
      expect(placed.chunks).toBe(worker.chunkRequests.at(-1)!.length);

      const id = getArchitectureSource()!.buildings[0]!.id;
      const chunksBeforeTypeEdit = worker.chunkBuilds;
      const edited = await editObjectProperties(id, { grammarId: "residential-slab", visualUse: "residential", heightM: 30 });
      expect(worker.planBuilds).toBe(planBuilds);
      expect(worker.chunkBuilds).toBe(chunksBeforeTypeEdit + 1);
      expect(worker.chunkRequests.at(-1)!.length).toBeGreaterThan(0);
      expect(worker.chunkRequests.at(-1)!.length).toBeLessThan(fullChunkCount);
      expect(edited.chunks).toBe(worker.chunkRequests.at(-1)!.length);
      expect(cacheState.publishChunks).not.toHaveBeenCalled();
    }, 120_000);

    it("rejects invalid authored placement before writing the Scene flag", async () => {
      setupScene(state());
      await settleMountedPlan();
      const before = structuredClone(getCity());
      const setFlag = vi.mocked(canvas.scene.setFlag);

      await expect(placeBuilding(buildingInput({
        placement: { ...buildingPlacement, widthM: 0 }
      }))).rejects.toThrow(/placement widthM/i);
      expect(setFlag).not.toHaveBeenCalled();
      expect(getCity()).toEqual(before);
    }, 30_000);
    it("keeps manual identity deterministic across failed actions, rerolls, and reload", async () => {
      setupScene(state());
      await settleMountedPlan();
      const firstInput = buildingInput();
      const firstLineage = allocateManualLineage(
        "bldg",
        1,
        0,
        firstInput.grammarId,
        firstInput.visualUse,
        firstInput.heightM,
        firstInput.paletteId,
        firstInput.placement,
        firstInput.sitePolygon
      );
      await expect(placeBuilding(buildingInput({
        placement: { ...buildingPlacement, widthM: 0 }
      }))).rejects.toThrow(/placement widthM/i);
      await placeBuilding(firstInput);
      const first = getArchitectureSource()!.buildings[0]!;
      expect(first.lineage).toBe(firstLineage);
      expect(first.id).toBe(allocateManualId("bldg", 1, 0, firstLineage));

      await rerollObjectAppearance(first.id);
      const reloaded = structuredClone(saved) as CityStateV4;
      setupScene(reloaded);
      await settleMountedPlan();
      expect(getArchitectureSource()).toEqual(reloaded.source.architecture);

      const secondSite: Ring = [
        { x: 38, y: -20 },
        { x: 62, y: -20 },
        { x: 62, y: 4 },
        { x: 38, y: 4 }
      ];
      const secondPlacement: PlacementFrame = {
        centre: { x: 50, y: -8 },
        rotationRad: 0,
        widthM: 12,
        depthM: 12
      };
      const secondInput = buildingInput({ placement: secondPlacement, sitePolygon: secondSite });
      await placeBuilding(secondInput);
      const current = getCity()!;
      const second = getArchitectureSource()!.buildings.find((candidate) => candidate.id !== first.id)!;
      const secondLineage = allocateManualLineage(
        "bldg",
        current.revision - 1,
        1,
        secondInput.grammarId,
        secondInput.visualUse,
        secondInput.heightM,
        secondInput.paletteId,
        secondInput.placement,
        secondInput.sitePolygon
      );
      expect(second.lineage).toBe(secondLineage);
      expect(second.id).toBe(allocateManualId("bldg", current.revision - 1, 1, secondLineage, new Set([first.id])));
    }, 120_000);

    it("promotes substantial generated edits while preserving identity, seeds, palette, and consuming overrides", async () => {
      await generatedCity();
      const { building } = generatedBuilding();

      await editObjectProperties(building.id, { paletteId: "corporate" });
      const cosmetic = getArchitectureSource();
      expect(cosmetic).not.toBeNull();
      expect(cosmetic!.buildings).toHaveLength(0);
      expect(cosmetic!.overrides).toHaveLength(1);

      const planBuildsBeforeType = worker.planBuilds;
      const chunkBuildsBeforeType = worker.chunkBuilds;
      const fullChunkCount = Math.max(...worker.chunkRequests.map((request) => request.length));
      await editObjectProperties(building.id, { grammarId: building.grammarId, visualUse: building.visualUse, heightM: building.heightM });
      expect(worker.planBuilds).toBe(planBuildsBeforeType);
      expect(worker.chunkBuilds).toBe(chunkBuildsBeforeType + 1);
      expect(worker.chunkRequests.at(-1)!.length).toBeGreaterThan(0);
      expect(worker.chunkRequests.at(-1)!.length).toBeLessThanOrEqual(fullChunkCount);
      const promoted = getArchitectureSource();
      expect(promoted).not.toBeNull();
      expect(promoted!.overrides).toHaveLength(0);
      const persistent = promoted!.buildings.find((candidate) => candidate.id === building.id);
      expect(persistent).toMatchObject({
        id: building.id,
        lineage: building.lineage,
        origin: "generated",
        protection: "manual-edit",
        seed: building.seed,
        appearanceSeed: building.appearanceSeed,
        grammarId: building.grammarId,
        visualUse: building.visualUse,
        heightM: building.heightM,
        paletteId: "corporate",
        sitePolygon: building.sitePolygon,
        placement: building.placement,
        districtId: building.districtId,
        blockId: building.blockId
      });
    }, 120_000);
    it("clears stale associations when spatially promoting a derived object", async () => {
      await generatedCity("architecture-spatial-promotion");
      const { building } = generatedBuilding();

      await editSitePolygon(building.id, structuredClone(building.sitePolygon));
      const persistent = getArchitectureSource()!.buildings.find((candidate) => candidate.id === building.id);
      expect(persistent).toMatchObject({
        districtId: null,
        blockId: null,
        protection: "manual-edit",
        sitePolygon: building.sitePolygon,
        placement: building.placement
      });
    }, 120_000);

    it("stores a sparse derived palette override without promotion", async () => {
      await generatedCity("architecture-palette");
      const { building } = generatedBuilding();
      const planBuilds = worker.planBuilds;
      const chunkBuilds = worker.chunkBuilds;
      const fullChunkCount = Math.max(...worker.chunkRequests.map((request) => request.length));

      const result = await editObjectProperties(building.id, { paletteId: "corporate" });
      expect(worker.planBuilds).toBe(planBuilds);
      expect(worker.chunkBuilds).toBe(chunkBuilds + 1);
      expect(worker.chunkRequests.at(-1)!.length).toBeGreaterThan(0);
      expect(worker.chunkRequests.at(-1)!.length).toBeLessThan(fullChunkCount);
      expect(result.chunks).toBe(worker.chunkRequests.at(-1)!.length);
      const architecture = getArchitectureSource();
      expect(architecture).not.toBeNull();
      expect(architecture!.buildings).toHaveLength(0);
      expect(architecture!.places).toHaveLength(0);
      expect(architecture!.overrides).toHaveLength(1);
      const override = architecture!.overrides[0]!;
      expect(override).toMatchObject({
        targetKind: "building",
        targetId: building.id,
        lineage: building.lineage,
        protection: "manual-edit",
        snapshotSitePolygon: building.sitePolygon,
        paletteId: "corporate"
      });
      expect(override.appearanceSeed).toBeUndefined();
      expect(Object.keys(override).sort()).toEqual([
        "lineage",
        "paletteId",
        "protection",
        "snapshotSitePolygon",
        "targetId",
        "targetKind"
      ]);
    }, 120_000);
    it("promotes protected derived overrides before structural placement can orphan them", async () => {
      setupScene(state());
      await settleMountedPlan();
      const cityBefore = getCity()!;
      const plan = buildCompleteCityPlan(cityBefore.source, cityBefore.revision);
      const building = plan.buildings.find((candidate) =>
        candidate.sourceId === null
        && candidate.placement !== undefined
        && candidate.sitePolygon.length === 4
        && Math.hypot(candidate.placement.centre.x, candidate.placement.centre.y) > 100
      );
      if (building?.placement === undefined) throw new Error("expected a distant generated building");
      await editObjectProperties(building.id, { paletteId: "corporate" });

      await placeBuilding(buildingInput());

      const city = getCity()!;
      const architecture = city.source.architecture;
      expect(architecture.overrides).toEqual([]);
      expect(architecture.buildings).toHaveLength(2);
      expect(architecture.buildings.find((candidate) => candidate.id === building.id)).toMatchObject({
        lineage: building.lineage,
        origin: "generated",
        protection: "manual-edit",
        paletteId: "corporate",
        sitePolygon: building.sitePolygon,
        placement: building.placement
      });
      const rebuilt = buildCompleteCityPlan(city.source, city.revision);
      expect(rebuilt.buildings.find((candidate) => candidate.id === building.id)).toMatchObject({
        paletteId: "corporate",
        protection: "manual-edit"
      });
    }, 120_000);
    it("rejects overrides targeting persistent architecture objects", async () => {
      setupScene(state());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      const architecture = getArchitectureSource()!;
      const before = structuredClone(architecture);
      const authored = architecture.buildings[0]!;
      await expect(commitArchitectureCandidate({
        ...architecture,
        overrides: [{
          targetKind: "building",
          targetId: authored.id,
          lineage: authored.lineage,
          protection: "manual-edit",
          snapshotSitePolygon: structuredClone(authored.sitePolygon)
        }]
      })).rejects.toThrow(/derived objects only/i);
      expect(getArchitectureSource()).toEqual(before);
    }, 120_000);
    it("rejects a protected override whose target site no longer matches before saving", async () => {
      await generatedCity("architecture-protected-override");
      const { building } = generatedBuilding();
      await rerollObjectAppearance(building.id);
      await setObjectLocked(building.id, true);

      const before = structuredClone(getCity());
      const beforePlan = stats()?.completePlan;
      const beforeDepth = stats()?.undoDepth;
      const setFlag = vi.mocked(canvas.scene.setFlag);
      const writesBefore = setFlag.mock.calls.length;
      const architecture = getArchitectureSource()!;
      expect(architecture.overrides).toHaveLength(1);
      expect(architecture.overrides[0]).toMatchObject({
        targetId: building.id,
        protection: "explicit",
        lineage: building.lineage
      });
      const stale = structuredClone(architecture);
      stale.overrides[0]!.snapshotSitePolygon = stale.overrides[0]!.snapshotSitePolygon.map((point) => ({
        x: point.x + 1,
        y: point.y
      }));

      await expect(commitArchitectureCandidate(stale)).rejects.toThrow(/Protected architecture override/i);
      expect(setFlag).toHaveBeenCalledTimes(writesBefore);
      expect(getCity()).toEqual(before);
      expect(saved).toEqual(before);
      expect(getArchitectureSource()).toEqual(architecture);
      expect(stats()).toEqual(expect.objectContaining({
        revision: before!.revision,
        undoDepth: beforeDepth,
        completePlan: beforePlan
      }));
    }, 120_000);

    it("updates a persistent palette in its source without masking it with an override", async () => {
      setupScene(state());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      const building = getArchitectureSource()!.buildings[0]!;
      const beforeRevision = getCity()!.revision;

      await editObjectProperties(building.id, { paletteId: "commercial" });

      const architecture = getArchitectureSource()!;
      expect(architecture.buildings).toHaveLength(1);
      expect(architecture.buildings[0]).toMatchObject({
        id: building.id,
        paletteId: "commercial",
        protection: "manual-edit"
      });
      expect(architecture.overrides).toEqual([]);
      expect(getCity()!.revision).toBe(beforeRevision + 1);
    }, 120_000);

    it("rejects a terrain candidate that invalidates an unlocked persistent site before saving", async () => {
      setupScene(state());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      const before = structuredClone(getCity());
      const beforePlan = stats()?.completePlan;
      const setFlag = vi.mocked(canvas.scene.setFlag);
      const writesBefore = setFlag.mock.calls.length;

      await expect(replaceUrbanFootprint([
        { x: -100, y: -80 },
        { x: -20, y: -80 },
        { x: -20, y: 80 },
        { x: -100, y: 80 }
      ])).rejects.toThrow(/urban footprint/i);
      expect(setFlag).toHaveBeenCalledTimes(writesBefore);
      expect(getCity()).toEqual(before);
      expect(saved).toEqual(before);
      expect(getArchitectureSource()!.buildings).toHaveLength(1);
      expect(stats()).toEqual(expect.objectContaining({
        revision: before!.revision,
        undoDepth: 1,
        completePlan: beforePlan
      }));
    }, 120_000);

    it("rolls back an invalid transform without changing source, history, selection, or render state", async () => {
      setupScene(bulkRoadState());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      selectRoad("edge-a");
      const id = getArchitectureSource()!.buildings[0]!.id;
      const before = structuredClone(getCity())!;
      const beforePlan = structuredClone(stats()?.completePlan);
      const beforeBuild = structuredClone(stats()?.lastBuild);
      const beforeSelection = getRoadSelection();
      const buildsBefore = worker.planBuilds;
      const setFlag = vi.mocked(canvas.scene.setFlag);
      const writesBefore = setFlag.mock.calls.length;

      await expect(transformObject(id, {
        placement: { ...buildingPlacement, widthM: 0 }
      })).rejects.toThrow(/placement widthM/i);

      expect(setFlag).toHaveBeenCalledTimes(writesBefore);
      expect(getCity()).toEqual(before);
      expect(saved).toEqual(before);
      expect(getRoadSelection()).toEqual(beforeSelection);
      expect(worker.planBuilds).toBe(buildsBefore);
      expect(stats()).toEqual(expect.objectContaining({
        revision: before.revision,
        undoDepth: 1,
        completePlan: beforePlan,
        lastBuild: beforeBuild,
        roadSelection: beforeSelection
      }));
    }, 120_000);


    it("rerolls appearance without changing derived geometry", async () => {
      await generatedCity("architecture-reroll");
      const before = generatedBuilding();

      await rerollObjectAppearance(before.building.id);
      const architecture = getArchitectureSource();
      expect(architecture).not.toBeNull();
      expect(architecture!.buildings).toHaveLength(0);
      expect(architecture!.overrides).toHaveLength(1);
      const override = architecture!.overrides[0]!;
      expect(override).toMatchObject({
        targetKind: "building",
        targetId: before.building.id,
        lineage: before.building.lineage,
        protection: "manual-edit",
        snapshotSitePolygon: before.building.sitePolygon
      });
      expect(override.appearanceSeed).toEqual(expect.any(String));

      const after = generatedBuilding();
      expect(after.building.sitePolygon).toEqual(before.building.sitePolygon);
      expect(after.building.placement).toEqual(before.building.placement);
      expect(after.building.seed).toBe(before.building.seed);
      expect(after.building.appearanceSeed).not.toBe(before.building.appearanceSeed);
    }, 120_000);

    it("retains derived and persistent locks until explicitly unlocked", async () => {
      await generatedCity("architecture-locks");
      const { building } = generatedBuilding();

      await setObjectLocked(building.id, true);
      let architecture = getArchitectureSource();
      expect(architecture!.overrides).toHaveLength(1);
      expect(architecture!.overrides[0]).toMatchObject({
        targetId: building.id,
        protection: "explicit",
        lineage: building.lineage
      });
      await expect(editObjectProperties(building.id, { paletteId: "corporate" })).rejects.toThrow(/locked/i);
      expect(getArchitectureSource()).toEqual(architecture);

      await setObjectLocked(building.id, false);
      architecture = getArchitectureSource();
      expect(architecture!.overrides[0]).toMatchObject({ targetId: building.id, protection: "none" });
      await editObjectProperties(building.id, { paletteId: "corporate" });
      expect(getArchitectureSource()!.overrides[0]).toMatchObject({ targetId: building.id, protection: "manual-edit", paletteId: "corporate" });
      setupScene(state());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      const authored = getArchitectureSource()!.buildings[0]!;
      await setObjectLocked(authored.id, true);
      architecture = getArchitectureSource();
      expect(architecture!.buildings.find((candidate) => candidate.id === authored.id)).toMatchObject({ protection: "explicit" });
      await expect(rerollObjectAppearance(authored.id)).rejects.toThrow(/locked/i);
      await setObjectLocked(authored.id, false);
      await editObjectProperties(authored.id, { heightM: 31 });
      expect(getArchitectureSource()!.buildings.find((candidate) => candidate.id === authored.id)).toMatchObject({
        protection: "manual-edit",
        heightM: 31
      });
      await rerollObjectAppearance(authored.id);
      expect(getArchitectureSource()!.buildings.find((candidate) => candidate.id === authored.id)).toMatchObject({
        protection: "manual-edit",
        heightM: 31
      });
    }, 120_000);

    it("validates site edits before saving and applies valid persistent site edits", async () => {
      setupScene(state());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      const id = getArchitectureSource()!.buildings[0]!.id;
      const setFlag = vi.mocked(canvas.scene.setFlag);
      const writesBefore = setFlag.mock.calls.length;
      const before = structuredClone(getArchitectureSource());

      await expect(editSitePolygon(id, [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 0, y: 1 }
      ])).rejects.toThrow(/sitePolygon|ring/i);
      expect(setFlag).toHaveBeenCalledTimes(writesBefore);
      expect(getArchitectureSource()).toEqual(before);

      const nextSite: Ring = [
        { x: -14, y: -14 },
        { x: 14, y: -14 },
        { x: 14, y: 14 },
        { x: -14, y: 14 }
      ];
      await editSitePolygon(id, nextSite);
      expect(getArchitectureSource()!.buildings.find((building) => building.id === id)).toMatchObject({
        sitePolygon: nextSite,
        protection: "manual-edit"
      });
    }, 120_000);

    it("transforms an authored object and updates its site geometry", async () => {
      setupScene(state());
      await settleMountedPlan();
      await placeBuilding(buildingInput());
      const id = getArchitectureSource()!.buildings[0]!.id;
      const nextPlacement: PlacementFrame = {
        centre: { x: 4, y: 3 },
        rotationRad: 0,
        widthM: 10,
        depthM: 12
      };

      await transformObject(id, { placement: nextPlacement });
      const transformed = getArchitectureSource()!.buildings.find((building) => building.id === id);
      expect(transformed).toMatchObject({ protection: "manual-edit", placement: nextPlacement });
      expect(transformed?.sitePolygon).not.toEqual(buildingSite);
      expect(transformed?.sitePolygon).toHaveLength(buildingSite.length);
    }, 120_000);

    it("deletes persistent objects while rejecting deletion of derived objects", async () => {
      setupScene(state());
      await settleMountedPlan();
      await placePlace(placeInput());
      const placeId = getArchitectureSource()!.places[0]!.id;
      await deleteObject(placeId);
      expect(getArchitectureSource()!.places).toHaveLength(0);

      await generatedCity("architecture-delete");
      const { building } = generatedBuilding();
      await expect(deleteObject(building.id)).rejects.toThrow(/cannot be deleted/i);
      expect(getArchitectureSource()!.buildings).toHaveLength(0);
    }, 120_000);

    it("undoes and redoes exactly one architecture placement action", async () => {
      setupScene(state());
      await settleMountedPlan();
      const baseline = structuredClone(getArchitectureSource());
      await placeBuilding(buildingInput());
      const placed = structuredClone(getArchitectureSource());

      await expect(undo()).resolves.toBe(true);
      expect(getArchitectureSource()).toEqual(baseline);
      await expect(undo()).resolves.toBe(false);
      await expect(redo()).resolves.toBe(true);
      expect(getArchitectureSource()).toEqual(placed);
      await expect(redo()).resolves.toBe(false);
    }, 120_000);

    it("clears architecture, overrides, history, caches, and stale epochs on full randomize", async () => {
      await generatedCity("architecture-randomize-source");
      const generated = generatedBuilding();
      const persistentBefore = generated.building;
      const overrideBefore = generated.plan.buildings.find((candidate) =>
        candidate.id !== persistentBefore.id && candidate.sourceId === null
      );
      if (overrideBefore === undefined) throw new Error("expected a second generated building for the randomize fixture");
      await editObjectProperties(persistentBefore.id, { heightM: persistentBefore.heightM });
      await editObjectProperties(overrideBefore.id, { paletteId: "corporate" });

      const before = getCity()!;
      expect(before.source.architecture.buildings).toHaveLength(1);
      expect(before.source.architecture.overrides[0]).toMatchObject({
        targetKind: "building",
        targetId: overrideBefore.id,
        protection: "manual-edit"
      });
      const beforeDepth = stats()?.undoDepth;
      expect(beforeDepth).toBeGreaterThan(0);
      await vi.waitFor(() => {
        const current = stats();
        if (!isRecord(current) || !isRecord(current.planCache) || current.planCache.revision !== before.revision) {
          throw new Error("expected the pre-randomize plan cache to be published");
        }
        if (!isRecord(current.chunkCache) || current.chunkCache.revision !== before.revision) {
          throw new Error("expected the pre-randomize chunk cache to be published");
        }
      }, { timeout: 15_000 });
      const beforeEpoch = stats()!.buildEpoch as number;

      const firstConfirmation = clearConfirmationFor(generationPreflight());
      const first = await randomizeEntireCity(staging("architecture-randomize", firstConfirmation));
      expect(first.ok).toBe(true);
      expect(first.state.epoch).toBeGreaterThan(beforeEpoch);
      const randomized = getCity()!;
      expect(randomized.revision).toBe(1);
      expect(randomized.source.architecture).toEqual({ buildings: [], places: [], overrides: [] });
      expect(saved).toEqual(randomized);
      expect(stats()).toEqual(expect.objectContaining({
        revision: 1,
        undoDepth: 0,
        canRedo: false,
        buildEpoch: first.state.epoch,
        completePlan: expect.objectContaining({ revision: 1 }),
        planCache: expect.objectContaining({ revision: 1 }),
        chunkCache: expect.objectContaining({ revision: 1 })
      }));
      await expect(undo()).resolves.toBe(false);
      await expect(redo()).resolves.toBe(false);

      const target = generatedBuilding().building;
      await editObjectProperties(target.id, { paletteId: "corporate" });
      await vi.waitFor(() => {
        const current = stats();
        if (!isRecord(current) || !isRecord(current.chunkCache) || current.chunkCache.revision !== getCity()?.revision) {
          throw new Error("expected the post-randomize override cache to be published");
        }
      }, { timeout: 15_000 });
      const planPublishesBeforeStale = cacheState.publish.mock.calls.length;
      const chunkPublishesBeforeStale = cacheState.publishChunks.mock.calls.length;
      worker.tamper = (request, message) => {
        if (request.type === "generateCompleteCityPlan" && message.ok && isRecord(message.result)) {
          message.result.sourceRevision = -1;
        }
      };
      const staleConfirmation = clearConfirmationFor(generationPreflight());
      const stale = await randomizeEntireCity(staging("architecture-stale", staleConfirmation));
      expect(stale.ok).toBe(false);
      expect(stale.state.epoch).toBeGreaterThan(first.state.epoch);
      expect(generationState().epoch).toBe(stale.state.epoch);
      expect(getCity()).toBeNull();
      expect(saved).toBeUndefined();
      expect(stats()).toBeNull();
      expect(cacheState.publish.mock.calls.length).toBe(planPublishesBeforeStale);
      expect(cacheState.publishChunks.mock.calls.length).toBe(chunkPublishesBeforeStale);
    }, 120_000);
  });
});

describe("district palette texture", () => {
  let saved: CityStateV4 | undefined;
  let saveError: Error | null;
  let wallDocuments: Array<{ id: string }>;
  let worker: FakeWorker;

  function workerFactory(): FakeWorker {
    return worker;
  }

  const rect = (x: number, y: number, width: number, height: number): Ring => [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height }
  ];

  const zone = (id: string, x: number, y: number, typeId: DistrictTypeId): DistrictSource => ({
    id,
    polygon: rect(x, y, 60, 40),
    seed: `${id}-seed`,
    typeId,
    paletteId: DISTRICT_TYPE_REGISTRY.get(typeId)!.defaultPaletteId,
    origin: "generated",
    locked: false,
    openSpaceOverride: null
  });

  // Commercial, entertainment, industrial-heavy/light, night-market, residential-mega:
  // six 60 x 40 m districts in two rows, all inside the 200 x 160 m land mask.
  function paletteState(): CityStateV4 {
    const city = state();
    city.source.districts = [
      zone("commercial", -90, -70, "commercial-highrise"),
      zone("entertainment", -30, -70, "entertainment-strip"),
      zone("heavy", 30, -70, "heavy-industrial"),
      zone("light", -90, -10, "light-industrial"),
      zone("market", -30, -10, "night-market"),
      zone("mega", 30, -10, "residential-megablocks")
    ];
    return city;
  }

  function setupMountedScene(initial: CityStateV4): void {
    rendererState.instances.length = 0;
    saved = initial;
    vi.stubGlobal("PIXI", { UPDATE_PRIORITY: { HIGH: 2 } });
    vi.stubGlobal("canvas", {
      ready: true,
      dimensions: { sceneRect: { x: 400, y: 320, width: 200, height: 160 }, size: 1, distance: 1 },
      scene: {
        get walls(): Array<{ id: string }> { return wallDocuments; },
        getFlag: (_module: string, flag: string): unknown =>
          flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? saved : undefined,
        setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV4): Promise<CityStateV4> => {
          if (saveError !== null) throw saveError;
          saved = structuredClone(value);
          return saved as CityStateV4;
        }),
        unsetFlag: vi.fn(async (_module: string, _flag: string): Promise<void> => {
          saved = undefined;
        }),
        deleteEmbeddedDocuments: vi.fn(async () => []),
        createEmbeddedDocuments: vi.fn(async () => [])
      },
      app: {
        renderer: { screen: { width: 200, height: 160 } },
        ticker: { add: vi.fn(), remove: vi.fn() }
      },
      primary: {
        addChild: vi.fn(),
        sortDirty: false,
        constructor: { BACKGROUND_ELEVATION: 0 }
      },
      stage: { scale: { x: 1, y: 1 } }
    });
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
    vi.stubGlobal("CONST", { EDGE_SENSE_TYPES: { LIMITED: 1 }, WALL_MOVEMENT_TYPES: { NORMAL: 1 } });
    vi.stubGlobal("document", { baseURI: "http://test.local/" });
    vi.stubGlobal("Worker", workerFactory);
    mount();
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    wallDocuments = [];
    saveError = null;
    worker = new FakeWorker("worker-url");
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const bankRegion = (packed: Uint8Array, bank: number): string =>
    [...packed.slice(bank * BANK_SIZE * 4, (bank + 1) * BANK_SIZE * 4)].join(",");

  it("packs six distinct built-ins into distinct banks and refreshes the one shared texture on city change", async () => {
    setupMountedScene(paletteState());
    // mount() constructs the renderer with the source-derived palette: one instance, one texture.
    expect(rendererState.instances).toHaveLength(1);
    const renderer = rendererState.instances[0]!;
    const initial = renderer.paletteUpdates[0]!;

    const ids = () => getCity()!.source.districts.map((district) => district.paletteId);
    expect(new Set(ids())).toEqual(
      new Set(["commercial", "entertainment", "industrial-heavy", "industrial-light", "night-market", "residential-mega"])
    );
    const bankByPalette = new Map(derivePaletteBanks().map((entry) => [entry.paletteId, entry.bank]));
    const zoneBanks = ids().map((id) => bankByPalette.get(id)!).sort((a, b) => a - b);
    expect(new Set(zoneBanks).size).toBe(6);
    const initialRegions = zoneBanks.map((bank) => bankRegion(initial, bank));
    expect(new Set(initialRegions).size).toBe(6);
    const residentialBank = bankByPalette.get("residential-mega")!;
    expect(bankRegion(initial, residentialBank)).toBe(bankRegion(packPalette([builtinPalette("residential-mega").materials]), 0));

    // A structural district edit changes material-bank references, not the stable texture layout.
    await updateDistricts(["mega"], { paletteId: "corporate" });
    expect(rendererState.instances).toHaveLength(1);
    expect(renderer.paletteUpdates.length).toBeGreaterThanOrEqual(2);
    const latest = renderer.paletteUpdates[renderer.paletteUpdates.length - 1]!;
    expect(latest).toEqual(initial);

    const corporateBank = bankByPalette.get("corporate")!;
    const nightMarketBank = bankByPalette.get("night-market")!;
    expect(bankRegion(latest, corporateBank)).toBe(bankRegion(packPalette([builtinPalette("corporate").materials]), 0));
    expect(bankRegion(latest, nightMarketBank)).toBe(bankRegion(packPalette([builtinPalette("night-market").materials]), 0));
    const latestRegions = getCity()!.source.districts.map((district) => bankRegion(latest, bankByPalette.get(district.paletteId)!));
    expect(new Set(latestRegions).size).toBe(6);
    // The shared city bank and the unzoned bank 1 survive the refresh untouched.
    expect(latest.slice(0, BANK_SIZE * 4)).toEqual(initial.slice(0, BANK_SIZE * 4));
    expect(bankRegion(latest, BASE_BANK)).toBe(bankRegion(initial, BASE_BANK));
  }, 120_000);

  it("rebuilds the complete plan exactly once for a palette-only district update so source, plan, and texture agree", async () => {
    setupMountedScene(paletteState());
    const renderer = rendererState.instances[0]!;
    // WHY: mount() starts the baseline plan build asynchronously; wait for it so the
    // build count below proves the palette edit itself rebuilt exactly once.
    await vi.waitFor(() => {
      if (!isRecord(stats()?.completePlan)) throw new Error("expected a published complete plan after mount");
    }, { timeout: 15_000 });
    const buildsBefore = worker.planBuilds;
    const baseline = stats()?.completePlan;
    const baselineSignature = isRecord(baseline) ? baseline.structuralInput : null;
    expect(isRecord(baselineSignature)).toBe(true);
    const baselineDistricts = (baselineSignature as Record<string, unknown>).districts;
    expect(typeof baselineDistricts).toBe("string");

    await updateDistricts(["mega"], { paletteId: "corporate" });

    // Source: the palette-only patch landed on the district.
    expect(getCity()!.source.districts.find((district) => district.id === "mega")?.paletteId).toBe("corporate");

    // Plan: rebuilt once through the worker (never reused) and published with a
    // palette-inclusive structural signature that no longer matches the stale banks.
    expect(worker.planBuilds).toBe(buildsBefore + 1);
    const published = stats()?.completePlan;
    expect(isRecord(published) ? published.revision : null).toBe(2);
    const publishedSignature = isRecord(published) ? published.structuralInput : null;
    expect(isRecord(publishedSignature)).toBe(true);
    expect((publishedSignature as Record<string, unknown>).districts).not.toBe(baselineDistricts);

    // Palette texture: the registry-wide bank mapping remains fixed while rebuilt
    // chunks switch the edited district's material references to the corporate bank.
    expect(renderer.paletteUpdates.length).toBeGreaterThanOrEqual(2);
    const latest = renderer.paletteUpdates[renderer.paletteUpdates.length - 1]!;
    const bankByPalette = new Map(derivePaletteBanks().map((entry) => [entry.paletteId, entry.bank]));
    expect(bankRegion(latest, bankByPalette.get("corporate")!)).toBe(bankRegion(packPalette([builtinPalette("corporate").materials]), 0));
    expect(bankRegion(latest, bankByPalette.get("night-market")!)).toBe(bankRegion(packPalette([builtinPalette("night-market").materials]), 0));
    const latestRegions = getCity()!.source.districts.map((district) => bankRegion(latest, bankByPalette.get(district.paletteId)!));
    expect(new Set(latestRegions).size).toBe(6);
  }, 120_000);
});
