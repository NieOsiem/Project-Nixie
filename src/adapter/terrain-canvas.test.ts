import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_CITY, FLAG_ENABLED } from "../constants.js";
import { DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "../core/gen/district-registry.js";
import type { CityStateV3, DistrictSource } from "../core/gen/city.js";
import { BANK_SIZE, BASE_BANK, builtinPalette, packPalette, paletteBanks } from "../core/palette.js";
import { rectangleLand } from "../core/gen/terrain.js";
import type { Ring } from "../core/geom/types.js";
import { TerrainSession } from "./terrain-session.js";
import {
  handleWorkerMessage,
  type WorkerMessage,
  type WorkerRequest
} from "../worker/protocol.js";
import {
  addCityListener,
  clearConfirmationFor,
  configuredPixelsPerMetre,
  cancelTerrainDraft,
  createDistrict,
  deleteRoadJunction,
  deleteRoads,
  districtDiagnostics,
  enabledFlagChanged,
  fillDistrict,
  generateDistricts,
  generateNewSeed,
  generationPreflight,
  generationState,
  getCity,
  getDistrictPlanView,
  getDistrictSelection,
  getRoadSelection,
  mergeDistricts,
  mount,
  randomizeEntireCity,
  reclassifyRoad,
  rebuildGeometry,
  renameRoad,
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
  setRoadCurvePreset,
  setRoadDraftCancelListener,
  setRoadLocked,
  splitDistrict,
  startFullGeneration,
  stats,
  undo,
  unmount,
  updateDistricts,
  type ClearConfirmation
} from "./terrain-canvas.js";

/** Every CityRenderer the adapter constructs, with the palettes it was handed. */
const rendererState = vi.hoisted(() => ({
  instances: [] as Array<{ paletteUpdates: Uint8Array[] }>
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
    setChunk(_chunk: unknown): void {}
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
  /** Number of complete-plan builds the worker has served (for reuse assertions). */
  planBuilds = 0;
  /** Test hook: mutate a response before it is dispatched to the adapter. */
  tamper: ((request: WorkerRequest, message: WorkerMessage) => void) | null = null;

  constructor(_url: string, _options?: unknown) {}

  postMessage(message: WorkerRequest): void {
    if (message.type === "buildCompleteCityPlan") this.planBuilds += 1;
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

function state(): CityStateV3 {
  return {
    kind: "city-generator-2",
    schemaVersion: 3,
    generatorVersion: 11,
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
      districts: []
    }
  };
}

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

function bulkRoadState(): CityStateV3 {
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
  let saved: CityStateV3 | undefined;
  let saveError: Error | null;
  let wallCreateError: Error | null;
  let wallDocuments: Array<{ id: string }>;
  let worker: FakeWorker;

  // WHY: the adapter constructs `new Worker(...)`; stubbing the global with an instance
  // would throw "not a constructor", so the stub is a factory returning the shared fake.
  function workerFactory(): FakeWorker {
    return worker;
  }

  function setupScene(initial: CityStateV3 | undefined): void {
    unmount();
    saved = initial;
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
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV3): Promise<CityStateV3> => {
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
    expect(saved!.source.roads.edges.map((edge: CityStateV3["source"]["roads"]["edges"][number]) => [edge.id, edge.classId, edge.name])).toEqual([
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
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV3): Promise<CityStateV3> => {
        if (saveError !== null) throw saveError;
        saved = structuredClone(value);
        return saved as CityStateV3;
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
  });

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
  });

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
  });

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
});

describe("district palette texture", () => {
  let saved: CityStateV3 | undefined;
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
  function paletteState(): CityStateV3 {
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

  function setupMountedScene(initial: CityStateV3): void {
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
        setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV3): Promise<CityStateV3> => {
          if (saveError !== null) throw saveError;
          saved = structuredClone(value);
          return saved as CityStateV3;
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
    const zoneBanks = [...paletteBanks(ids()).values()].sort((a, b) => a - b);
    expect(zoneBanks).toEqual([2, 3, 4, 5, 6, 7]);
    const initialRegions = zoneBanks.map((bank) => bankRegion(initial, bank));
    expect(new Set(initialRegions).size).toBe(6);
    // The sorted rule puts residential-mega at bank 7.
    expect(bankRegion(initial, 7)).toBe(bankRegion(packPalette([builtinPalette("residential-mega").materials]), 0));

    // A structural edit swapping residential-mega for corporate must refresh the SAME texture.
    await updateDistricts(["mega"], { paletteId: "corporate" });
    expect(rendererState.instances).toHaveLength(1);
    expect(renderer.paletteUpdates.length).toBeGreaterThanOrEqual(2);
    const latest = renderer.paletteUpdates[renderer.paletteUpdates.length - 1]!;
    expect(latest).not.toEqual(initial);

    // Sorted ids are now commercial, corporate, entertainment, industrial-heavy, industrial-light,
    // night-market, so corporate owns bank 3 and night-market moves to bank 7.
    expect(bankRegion(latest, 3)).toBe(bankRegion(packPalette([builtinPalette("corporate").materials]), 0));
    expect(bankRegion(latest, 7)).toBe(bankRegion(packPalette([builtinPalette("night-market").materials]), 0));
    const latestRegions = [...paletteBanks(getCity()!.source.districts.map((district) => district.paletteId)).values()].map(
      (bank) => bankRegion(latest, bank)
    );
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

    // Palette texture: one shared texture refreshed so its bank mapping matches the
    // sorted source palettes (corporate owns bank 3, night-market moves to bank 7).
    expect(renderer.paletteUpdates.length).toBeGreaterThanOrEqual(2);
    const latest = renderer.paletteUpdates[renderer.paletteUpdates.length - 1]!;
    expect(bankRegion(latest, 3)).toBe(bankRegion(packPalette([builtinPalette("corporate").materials]), 0));
    expect(bankRegion(latest, 7)).toBe(bankRegion(packPalette([builtinPalette("night-market").materials]), 0));
    const latestRegions = [...paletteBanks(getCity()!.source.districts.map((district) => district.paletteId)).values()].map(
      (bank) => bankRegion(latest, bank)
    );
    expect(new Set(latestRegions).size).toBe(6);
  }, 120_000);
});
