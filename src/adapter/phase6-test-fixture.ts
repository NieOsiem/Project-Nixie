import { expect, vi, type Mock } from "vitest";
import { CITY_SCHEMA_VERSION, FLAG_CITY, FLAG_ENABLED, GENERATOR_VERSION } from "../constants.js";
import { validateCitySourceV5, type CitySourceV5, type CityStateV5 } from "../core/gen/city.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import { generateInitialDistricts } from "../core/gen/district-generator.js";
import { generateInitialRoadNetwork } from "../core/gen/road-generator.js";
import type { CachedCompleteChunkRecord } from "../core/gen/complete-city-chunk-cache.js";
import type { CompleteCityPlan } from "../core/gen/complete-city-plan.js";
import { PLAN_CACHE_FORMAT_VERSION, type CityCacheManifestV1 } from "../core/gen/city-cache.js";
import { chunkId, chunksCovering } from "../core/gen/chunks.js";
import { rectRing, ringBounds, type Rect } from "../core/geom/types.js";
import type { ChunkGeometry } from "../render/chunk-culling.js";
import { handleWorkerMessage, type WorkerMessage, type WorkerRequest } from "../worker/protocol.js";
import { mount, registerHooks, stats, unmount } from "./terrain-canvas.js";

/**
 * Shared Phase 6 adapter fixture: the real Worker protocol (via `handleWorkerMessage`)
 * against a recording renderer fake, so regeneration/bulk tests exercise the actual
 * adapter pipeline instead of a mocked adapter. Test files MUST import this module
 * before "./terrain-canvas.js" so the vi.mock registrations below apply to the adapter's
 * imports. Nothing here fakes planning, chunk building, or semantic decisions.
 */

/** The one deterministic fixture city: a small grid with several districts and blocks. */
const PHASE6_CITY_SEED = "phase6-adapter-fixture";
const PHASE6_LAND = { x: 0, y: 0, width: 384, height: 256 };

export interface Phase6Renderer {
  /** Chunk ids pushed by `setChunk`, in install order (shared across remounts). */
  readonly sets: string[];
  /** Number of `clearChunks` calls (full-set wipes; scoped installs never clear). */
  readonly clears: number;
  /** Latest installed geometry per chunk id. */
  readonly latest: Map<string, ChunkGeometry>;
}

export interface Phase6Scene {
  getFlag: (module: string, flag: string) => unknown;
  setFlag: Mock<(module: string, flag: string, value: CityStateV5) => Promise<CityStateV5>>;
  unsetFlag: Mock<(module: string, flag: string) => Promise<void>>;
  createEmbeddedDocuments: Mock<(type: string, data: Array<Record<string, unknown>>) => Promise<unknown[]>>;
  deleteEmbeddedDocuments: Mock<(type: string, ids: string[]) => Promise<unknown[]>>;
  readonly walls: Array<{ id: string }>;
  storedSnapshot(): CityStateV5 | undefined;
  setStored(state: CityStateV5 | undefined): void;
}

interface PlanRequest {
  request: WorkerRequest;
  run: () => void;
}

export class Phase6Worker {
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

  #delayArmed = false;
  #parked: PlanRequest[] = [];
  #delayWaiters: Array<() => void> = [];

  /** Park the next `buildCompleteCityPlan` response until `releasePlan`. */
  delayNextPlan(): void {
    this.#delayArmed = true;
  }

  get parkedPlanCount(): number {
    return this.#parked.length;
  }

  /** Resolves once a plan request is parked (or immediately when one already is). */
  // WHY: stored-resolver promises need the executor form; Promise.withResolvers requires lib es2024, and this project pins es2022.
  whenPlanDelayed(): Promise<void> {
    if (this.#parked.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#delayWaiters.push(resolve);
    });
  }

  releasePlan(): void {
    const parked = this.#parked.shift();
    if (parked === undefined) return;
    queueMicrotask(parked.run);
  }

  releaseAllPlans(): void {
    while (this.#parked.length > 0) this.releasePlan();
  }

  postMessage(message: WorkerRequest): void {
    const post = (item: WorkerMessage): void => {
      this.tamper?.(message, item);
      this.onmessage?.({ data: item });
    };
    if (message.type === "buildCompleteCityPlan") {
      this.planBuilds += 1;
      const run = (): void => {
        void handleWorkerMessage({ post }, message);
      };
      if (this.#delayArmed) {
        this.#delayArmed = false;
        this.#parked.push({ request: message, run });
        const waiters = this.#delayWaiters;
        this.#delayWaiters = [];
        queueMicrotask(() => {
          for (const waiter of waiters) waiter();
        });
        return;
      }
      queueMicrotask(run);
      return;
    }
    if (message.type === "buildCompleteCityChunks") {
      this.chunkBuilds += 1;
      this.chunkRequests.push(message.keys.map((key) => `${key.cx},${key.cy}`));
    }
    queueMicrotask(() => {
      void handleWorkerMessage({ post }, message);
    });
  }
}

const rendererState = vi.hoisted(() => ({
  sets: [] as string[],
  clears: 0,
  latest: new Map<string, unknown>(),
  instances: [] as Array<{ paletteUpdates: Uint8Array[] }>,
  setChunkError: null as Error | null
}));

const cacheState = vi.hoisted(() => ({
  load: vi.fn<(city: CityStateV5) => Promise<{ plan: CompleteCityPlan; manifest: CityCacheManifestV1 } | null>>(),
  publish: vi.fn<(city: CityStateV5, plan: CompleteCityPlan) => Promise<CityCacheManifestV1>>(),
  loadChunks: vi.fn<(
    city: CityStateV5,
    plan: CompleteCityPlan,
    boundsM: Rect,
    pixelsPerMetre: number,
    expectedChunkIds: readonly string[],
    onRecord?: (record: CachedCompleteChunkRecord) => void
  ) => Promise<{ records: CachedCompleteChunkRecord[]; missingChunkIds: string[]; manifest: CityCacheManifestV1 } | null>>(),
  publishChunks: vi.fn<(
    city: CityStateV5,
    plan: CompleteCityPlan,
    boundsM: Rect,
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
// fake records every chunk add/clear and palette upload so tests can prove scoped
// installation and shared-texture behaviour against the real install path.
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

    clearChunks(): void {
      rendererState.clears += 1;
    }

    setChunk(chunk: { id: string }): void {
      if (rendererState.setChunkError !== null) throw rendererState.setChunkError;
      rendererState.sets.push(chunk.id);
      rendererState.latest.set(chunk.id, chunk);
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

/** Live view over the shared renderer tracking; stays valid across remounts. */
export const phase6Renderer: Phase6Renderer = {
  get sets(): string[] {
    return rendererState.sets;
  },
  get clears(): number {
    return rendererState.clears;
  },
  get latest(): Map<string, ChunkGeometry> {
    return rendererState.latest as Map<string, ChunkGeometry>;
  }
};

/** Direct access to the mocked city-cache module for seeding or asserting cache traffic. */
export const phase6CacheState = cacheState;

/** Reset the shared mocks to their neutral defaults; called by `mountPhase6Fixture`. */
function resetPhase6Mocks(): void {
  cacheState.load.mockReset().mockResolvedValue(null);
  cacheState.publish.mockReset().mockImplementation(async (city, plan) => phase6CacheManifest(city, plan));
  cacheState.loadChunks.mockReset().mockResolvedValue(null);
  cacheState.publishChunks.mockReset().mockImplementation(async (city, plan) => phase6CacheManifest(city, plan));
  rendererState.sets.length = 0;
  rendererState.clears = 0;
  rendererState.latest.clear();
  rendererState.instances.length = 0;
  rendererState.setChunkError = null;
}

export function phase6CacheManifest(city: CityStateV5, plan: CompleteCityPlan, byteLength = 321): CityCacheManifestV1 {
  return {
    kind: "project-nixie-city-cache",
    cacheSchemaVersion: 1,
    generatorVersion: 13,
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

/**
 * Deterministic small grid city: five districts, 19 blocks, 141 planned buildings,
 * 8 landmarks — enough protected-content surface for regeneration preflights while
 * every plan build stays in the low seconds. The land rect is chunk-aligned so the
 * derived scene bounds cover exactly six 128 m chunks.
 */
export function phase6Source(): CitySourceV5 {
  const land = rectRing(PHASE6_LAND);
  const source: CitySourceV5 = {
    origin: { x: 0, y: 0 },
    citySeed: PHASE6_CITY_SEED,
    generation: {
      terrainMode: "rectangle",
      coastEdge: null,
      roadLayout: "grid",
      hubMode: "single-centre",
      districtPool: [...DISTRICT_TYPE_IDS],
      openSpaceProfile: "medium"
    },
    terrain: { land, urbanFootprint: null },
    roads: { nodes: [], routes: [], edges: [] },
    districts: [],
    architecture: { buildings: [], places: [], overrides: [] },
    regeneration: { partialSeeds: [] }
  };
  source.roads = generateInitialRoadNetwork({
    citySeed: source.citySeed,
    mask: land,
    land,
    layout: source.generation.roadLayout,
    hubMode: source.generation.hubMode,
    sceneBounds: PHASE6_LAND
  }).roads;
  source.districts = generateInitialDistricts(source);
  const problems = validateCitySourceV5(source);
  if (problems.length > 0) throw new Error(`phase6Source produced an invalid city source: ${problems.join(" ")}`);
  return source;
}

function phase6State(source: CitySourceV5): CityStateV5 {
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision: 1,
    source
  };
}

function phase6SceneRect(source: CitySourceV5): Rect {
  const bounds = ringBounds(source.terrain.land);
  return {
    x: source.origin.x + bounds.x,
    y: source.origin.y + bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function createPhase6Scene(initial: CityStateV5 | undefined): Phase6Scene {
  let stored = initial === undefined ? undefined : structuredClone(initial);
  let wallDocuments: Array<{ id: string }> = [];
  const scene: Phase6Scene = {
    get walls(): Array<{ id: string }> {
      return wallDocuments;
    },
    getFlag: (_module: string, flag: string): unknown =>
      flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? stored : undefined,
    setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV5): Promise<CityStateV5> => {
      stored = structuredClone(value);
      return stored;
    }),
    unsetFlag: vi.fn(async (_module: string, _flag: string): Promise<void> => {
      stored = undefined;
    }),
    deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]): Promise<unknown[]> => {
      wallDocuments = wallDocuments.filter((wall) => !ids.includes(wall.id));
      return [];
    }),
    createEmbeddedDocuments: vi.fn(async (_type: string, data: Array<Record<string, unknown>>): Promise<unknown[]> => {
      const created = data.map((value, index) => ({
        id: `wall-${index}`,
        ...value,
        getFlag: () => undefined
      }));
      wallDocuments.push(...created);
      return created;
    }),
    storedSnapshot(): CityStateV5 | undefined {
      return stored === undefined ? undefined : structuredClone(stored);
    },
    setStored(state: CityStateV5 | undefined): void {
      stored = state === undefined ? undefined : structuredClone(state);
    }
  };
  return scene;
}

export interface Phase6Fixture {
  worker: Phase6Worker;
  renderer: Phase6Renderer;
  getStored(): CityStateV5 | undefined;
  setStored(state: CityStateV5 | undefined): void;
  scene: Phase6Scene;
  dispose(): void;
}

/**
 * Mounts the real adapter pipeline against the fixture Scene: stubs the Foundry
 * globals (including a Hooks registry — `Hooks.call(name, ...args)` dispatches),
 * registers the adapter hooks, mounts, and waits until the initial plan is published,
 * every scene chunk is installed, and the debounced wall rebuild has settled.
 * With no source the Scene is absent and no settle wait runs.
 */
export async function mountPhase6Fixture(source?: CitySourceV5): Promise<Phase6Fixture> {
  resetPhase6Mocks();
  const worker = new Phase6Worker();
  const state = source === undefined ? undefined : phase6State(source);
  const scene = createPhase6Scene(state);
  const hooks = new Map<string, Array<(...args: unknown[]) => void>>();

  vi.stubGlobal("canvas", {
    ready: true,
    dimensions: {
      sceneRect: state === undefined ? { x: 400, y: 320, width: 200, height: 160 } : phase6SceneRect(state.source),
      size: 1,
      distance: 1
    },
    scene,
    stage: { scale: { x: 1 } },
    app: {
      renderer: { screen: { width: 1920, height: 1080 } },
      ticker: { add: vi.fn(), remove: vi.fn() }
    },
    primary: {
      constructor: { BACKGROUND_ELEVATION: 0 },
      addChild: vi.fn(),
      sortDirty: false
    }
  });
  vi.stubGlobal("PIXI", { UPDATE_PRIORITY: { HIGH: 1 } });
  vi.stubGlobal("game", { user: { isGM: true } });
  vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
  vi.stubGlobal("CONST", { EDGE_SENSE_TYPES: { LIMITED: 1 }, WALL_MOVEMENT_TYPES: { NORMAL: 1 } });
  vi.stubGlobal("document", { baseURI: "http://test.local/" });
  vi.stubGlobal("Hooks", {
    on: (name: string, callback: (...args: unknown[]) => void): void => {
      const list = hooks.get(name) ?? [];
      list.push(callback);
      hooks.set(name, list);
    },
    call: (name: string, ...args: unknown[]): void => {
      for (const callback of hooks.get(name) ?? []) callback(...args);
    }
  });
  // WHY: the adapter constructs `new Worker(...)`; the stub must be a constructor-like
  // function returning the shared fake (an arrow would throw "not a constructor").
  vi.stubGlobal("Worker", function phase6WorkerFactory(): Phase6Worker {
    return worker;
  });

  try {
    registerHooks();
    mount();

    if (state !== undefined) {
      // WHY: the initial build publishes its plan before chunk installs stream in, and
      // `lastBuild` survives fixture remounts (adapter module state is never reset), so a
      // previous test's full/stale-free result satisfied the old `lastBuild` wait while
      // `chunkBuilds` increments the moment a request is merely POSTED. Mounts resolved
      // with a single chunk installed and scoped-rebuild baselines measured 1 instead of 6.
      // Gate on the CURRENT source's entire expected chunk set actually installed.
      const expectedChunkIds = chunksCovering(ringBounds(state.source.terrain.land)).map(chunkId);
      await vi.waitFor(() => {
        expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision: state.revision }));
        for (const id of expectedChunkIds) {
          expect(phase6Renderer.latest.has(id), `chunk "${id}" was never installed at mount`).toBe(true);
        }
      }, { timeout: 60_000 });
      // The wall rebuild is debounced ~400 ms behind the geometry install; wait it out so
      // wall-document call counts are quiescent before a test starts asserting deltas.
      await vi.waitFor(() => {
        const walls: unknown = stats()?.generatedWalls;
        if (walls === null || walls === undefined) throw new Error("the mount never scheduled its wall rebuild");
        if (typeof walls !== "object" || !("created" in walls)) throw new Error("unexpected generatedWalls shape");
        const created: unknown = walls.created;
        if (typeof created !== "number" || created <= 0) throw new Error("the mount wall rebuild has not settled yet");
        expect(walls).toEqual(expect.objectContaining({ stale: false }));
      }, { timeout: 30_000 });
    }
  } catch (error) {
    // WHY: a mount that throws or times out must not leak the stubbed globals and the
    // mounted adapter into subsequent tests — tear down exactly as dispose would.
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    throw error;
  }

  return {
    worker,
    renderer: phase6Renderer,
    getStored: () => scene.storedSnapshot(),
    setStored: (next) => scene.setStored(next),
    scene,
    dispose(): void {
      unmount();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  };
}

interface Phase6MeshSource {
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
}

function hashArray(values: ArrayLike<number>, seed: number): number {
  let hash = seed | 0;
  for (let index = 0; index < values.length; index++) {
    hash = Math.imul(hash ^ values[index]!, 2654435761) | 0;
    hash = Math.imul((hash << 13) | (hash >>> 19), 1597334677) | 0;
  }
  return hash | 0;
}

/**
 * Stable content hash of a chunk geometry's mesh layers. Deterministic builds of the
 * same source produce identical signatures, so tests can compare semantic geometry
 * across build tokens without comparing plan identity.
 */
export function phase6MeshSignature(geometry: {
  mesh: Phase6MeshSource;
  detail?: Phase6MeshSource | null;
  neon?: Phase6MeshSource | null;
}): string {
  const layer = (source: Phase6MeshSource | null | undefined, seed: number): string =>
    source === undefined || source === null
      ? "null"
      : `${hashArray(source.vertices, seed)}:${hashArray(source.indices, seed ^ 0x9e3779b9)}`;
  return [
    layer(geometry.mesh, 2166136261),
    layer(geometry.detail, 2654435761),
    layer(geometry.neon, 40503)
  ].join("|");
}
