import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CITY_SCHEMA_VERSION,
  FLAG_CITY,
  GENERATOR_VERSION,
  MODULE_ID
} from "../constants.js";
import {
  CHUNK_CACHE_FORMAT_VERSION,
  CITY_CACHE_FLAG,
  CITY_CACHE_SCHEMA_VERSION,
  PLAN_CACHE_FORMAT_VERSION,
  checksumBytes,
  type CacheSlot,
  type CityCacheManifestV1
} from "../core/gen/city-cache.js";
import {
  encodeCompleteCityChunk,
  type CachedCompleteChunkRecord
} from "../core/gen/complete-city-chunk-cache.js";
import { encodeCompleteCityPlan } from "../core/gen/complete-city-plan-cache.js";
import {
  completeCityStructuralInput,
  type CompleteCityPlan
} from "../core/gen/complete-city-plan.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CityStateV3 } from "../core/gen/city.js";

const storage = vi.hoisted(() => ({
  fetchCacheAsset: vi.fn(),
  gunzipBytes: vi.fn(),
  gzipBytes: vi.fn(),
  uploadCacheAsset: vi.fn()
}));

vi.mock("./cache-storage.js", () => ({
  ...storage,
  cityCacheSlotPath: (sceneId: string, slot: CacheSlot): string => `city-cache/${sceneId}/slot-${slot}`
}));

import {
  chunkSceneGeometrySignature,
  clearCityCache,
  loadCachedCompleteChunks,
  loadCachedCompletePlan,
  loadCityCacheManifest,
  publishCompleteChunkCache,
  publishCompletePlanCache
} from "./city-cache.js";

interface MockScene {
  id: string;
  getFlag(moduleId: string, flag: string): unknown;
  setFlag(moduleId: string, flag: string, value: unknown): Promise<unknown>;
  unsetFlag(moduleId: string, flag: string): Promise<unknown>;
}

let cityFlag: unknown;
let cacheFlag: unknown;
let scene: MockScene;
let setFlag: Mock;
let unsetFlag: Mock;

function city(revision = 7): CityStateV3 {
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "adapter-city-cache",
      generation: {
        terrainMode: "rectangle",
        coastEdge: null,
        roadLayout: "european",
        hubMode: "single-centre",
        districtPool: [...DISTRICT_TYPE_IDS],
        openSpaceProfile: "medium"
      },
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

function planFor(source: CityStateV3): CompleteCityPlan {
  const structuralInput = completeCityStructuralInput(source.source);
  return {
    sourceRevision: source.revision,
    actionToken: "cache-action",
    buildToken: "cache-build",
    epoch: 3,
    openSpaceProfile: source.source.generation.openSpaceProfile,
    structuralInput,
    districtPlan: {
      revisionInputs: { ...structuralInput },
      blocks: [],
      developmentCells: [],
      openSpaceIntents: [],
      unzoned: [],
      wallCells: [],
      diagnostics: {
        faceCount: 0,
        blockCount: 0,
        fragmentCount: 0,
        developmentCellCount: 0,
        discardedFaceCount: 0,
        discardedCellCount: 0,
        warnings: []
      }
    },
    routeOccupancy: { vehicle: [], nonVehicle: [], all: [] },
    carriageway: [],
    paletteBanks: [],
    parcels: [],
    openSpaces: [],
    buildings: [],
    landmarks: [],
    diagnostics: {
      blockCount: 0,
      fragmentCount: 0,
      parcelCount: 0,
      openSpaceCount: 0,
      buildingCount: 0,
      massCount: 0,
      landmarkCount: 0,
      landmarkSkipped: [],
      warnings: []
    }
  };
}

function planFilenameFor(source: CityStateV3, compressed: Uint8Array): string {
  const structuralInput = completeCityStructuralInput(source.source);
  const sourceSignature = checksumBytes(new TextEncoder().encode(JSON.stringify([
    structuralInput.terrain,
    structuralInput.roads,
    structuralInput.districts,
    structuralInput.generation
  ])));
  return `plan-r${source.revision}-${sourceSignature}-${checksumBytes(compressed)}.plan-cache.json`;
}

function manifestFor(
  source: CityStateV3,
  compressed: Uint8Array,
  slot: CacheSlot = 0
): CityCacheManifestV1 {
  return {
    kind: "project-nixie-city-cache",
    cacheSchemaVersion: CITY_CACHE_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    cityRevision: source.revision,
    structuralInput: completeCityStructuralInput(source.source),
    slot,
    plan: {
      formatVersion: PLAN_CACHE_FORMAT_VERSION,
      artifact: {
        path: `city-cache/scene-1/slot-${slot}/${planFilenameFor(source, compressed)}`,
        byteLength: compressed.byteLength,
        checksum: checksumBytes(compressed)
      }
    }
  };
}

const SCENE_BOUNDS_M = { x: -50, y: -40, width: 100, height: 80 };
const PIXELS_PER_METRE = 2;

function chunkRecord(id: string, x: number): CachedCompleteChunkRecord {
  const mesh = {
    vertices: new Float32Array(33),
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1
  };
  const empty = {
    vertices: new Float32Array(),
    indices: new Uint32Array(),
    vertexCount: 0,
    triangleCount: 0
  };
  const boundsM = { x, y: -4, width: 8, height: 8 };
  return {
    id,
    mesh,
    detail: empty,
    neon: empty,
    boundsM,
    boundsPx: {
      x: 5000 + boundsM.x * PIXELS_PER_METRE,
      y: 4000 + boundsM.y * PIXELS_PER_METRE,
      width: boundsM.width * PIXELS_PER_METRE,
      height: boundsM.height * PIXELS_PER_METRE
    },
    landTriangleCount: 1,
    waterTriangleCount: 0,
    markingTriangleCount: 0,
    openSpaceTriangleCount: 0,
    buildingCount: 1,
    landmarkCount: 0,
    openSpaceCount: 0,
    bytes: mesh.vertices.byteLength + mesh.indices.byteLength
  };
}

function manifestWithChunks(
  source: CityStateV3,
  plan: CompleteCityPlan,
  planBytes: Uint8Array,
  records: readonly CachedCompleteChunkRecord[]
): { manifest: CityCacheManifestV1; assets: Map<string, Uint8Array> } {
  const geometrySignature = chunkSceneGeometrySignature(
    source,
    plan,
    SCENE_BOUNDS_M,
    PIXELS_PER_METRE,
    records.map((record) => record.id)
  );
  const assets = new Map<string, Uint8Array>();
  const entries = records.map((record, index) => {
    const bytes = encodeCompleteCityChunk(record);
    const checksum = checksumBytes(bytes);
    const idChecksum = checksumBytes(new TextEncoder().encode(record.id));
    const filename = `chunk-${geometrySignature}-${index.toString(36)}-${idChecksum}-${checksum}.chunk-cache.json`;
    const path = `city-cache/scene-1/slot-0/${filename}`;
    assets.set(path, bytes);
    return {
      chunkId: record.id,
      ref: { path, byteLength: bytes.byteLength, checksum },
      bounds: { ...record.boundsM },
      counts: {
        vertexCount: record.mesh.vertexCount,
        triangleCount: record.mesh.triangleCount
      }
    };
  });
  return {
    manifest: {
      ...manifestFor(source, planBytes),
      chunks: {
        formatVersion: CHUNK_CACHE_FORMAT_VERSION,
        sceneGeometrySignature: geometrySignature,
        entries
      }
    },
    assets
  };
}

function install(currentCity: CityStateV3 = city(), manifest: unknown = undefined): void {
  cityFlag = currentCity;
  cacheFlag = manifest;
  setFlag = vi.fn(async (_moduleId: string, flag: string, value: unknown): Promise<unknown> => {
    if (flag === CITY_CACHE_FLAG) cacheFlag = structuredClone(value);
    return value;
  });
  unsetFlag = vi.fn(async (_moduleId: string, flag: string): Promise<unknown> => {
    if (flag === CITY_CACHE_FLAG) cacheFlag = undefined;
    return undefined;
  });
  scene = {
    id: "scene-1",
    getFlag: (_moduleId: string, flag: string): unknown => flag === FLAG_CITY ? cityFlag : cacheFlag,
    setFlag,
    unsetFlag
  };
  vi.stubGlobal("canvas", { scene });
  vi.stubGlobal("game", { user: { isGM: true } });
}

beforeEach(() => {
  storage.fetchCacheAsset.mockReset();
  storage.gunzipBytes.mockReset();
  storage.gzipBytes.mockReset();
  storage.uploadCacheAsset.mockReset();
  storage.gunzipBytes.mockImplementation(async (bytes: Uint8Array): Promise<Uint8Array> => bytes);
  storage.gzipBytes.mockImplementation(async (bytes: Uint8Array): Promise<Uint8Array> => bytes);
  storage.uploadCacheAsset.mockImplementation(async (
    sceneId: string,
    slot: CacheSlot,
    filename: string
  ): Promise<string> => `city-cache/${sceneId}/slot-${slot}/${filename}`);
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("city cache manifest loading", () => {
  it("returns null for no active Scene, no manifest, a throwing flag read, and malformed data", () => {
    vi.stubGlobal("canvas", { scene: null });
    expect(loadCityCacheManifest()).toBeNull();

    install();
    expect(loadCityCacheManifest()).toBeNull();

    scene.getFlag = (): unknown => { throw new Error("flag read failed"); };
    expect(loadCityCacheManifest()).toBeNull();

    install(city(), { kind: "wrong", extra: true });
    expect(loadCityCacheManifest()).toBeNull();
  });

  it("returns a detached, strictly decoded manifest", () => {
    const source = city();
    const bytes = encodeCompleteCityPlan(planFor(source));
    const stored = manifestFor(source, bytes);
    install(source, stored);

    const loaded = loadCityCacheManifest();
    expect(loaded).toEqual(stored);
    expect(loaded).not.toBe(stored);
  });
});

describe("complete plan cache loading", () => {
  it("treats absent, malformed, stale-revision, and each stale structural signature as misses before fetch", async () => {
    const source = city();
    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();

    cacheFlag = { kind: "malformed" };
    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();

    const bytes = encodeCompleteCityPlan(planFor(source));
    cacheFlag = { ...manifestFor(source, bytes), cityRevision: source.revision + 1 };
    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();

    for (const key of ["terrain", "roads", "districts", "generation"] as const) {
      const stale = manifestFor(source, bytes);
      stale.structuralInput[key] = `${stale.structuralInput[key]}-stale`;
      cacheFlag = stale;
      await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
    }
    expect(storage.fetchCacheAsset).not.toHaveBeenCalled();
  });

  it("loads exact compressed bytes through checksum, gzip, JSON, validation, and identity", async () => {
    const source = city();
    const plan = planFor(source);
    const bytes = encodeCompleteCityPlan(plan);
    const manifest = manifestFor(source, bytes, 1);
    install(source, manifest);
    storage.fetchCacheAsset.mockResolvedValue(bytes);

    await expect(loadCachedCompletePlan(source)).resolves.toEqual({ plan, manifest });
    expect(storage.fetchCacheAsset).toHaveBeenCalledWith(manifest.plan.artifact.path, bytes.byteLength);
    expect(storage.gunzipBytes).toHaveBeenCalledWith(bytes);
  });

  it("rejects legacy shared and cross-scene plan refs before fetch", async () => {
    const source = city();
    const bytes = encodeCompleteCityPlan(planFor(source));
    const legacy = manifestFor(source, bytes);
    legacy.plan.artifact.path = "city-cache/scene-1/slot-0/plan.json.gz";
    install(source, legacy);
    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();

    const crossScene = manifestFor(source, bytes);
    crossScene.plan.artifact.path = crossScene.plan.artifact.path.replace(
      "city-cache/scene-1/",
      "city-cache/scene-other/"
    );
    install(source, crossScene);
    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
    expect(storage.fetchCacheAsset).not.toHaveBeenCalled();
  });

  it.each([
    ["fetch", new Error("HTTP 404")],
    ["declared length", new Error("length mismatch")]
  ])("converts a %s failure to null", async (_boundary, error) => {
    const source = city();
    const bytes = encodeCompleteCityPlan(planFor(source));
    install(source, manifestFor(source, bytes));
    storage.fetchCacheAsset.mockRejectedValue(error);

    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
    expect(storage.gunzipBytes).not.toHaveBeenCalled();
  });

  it("rejects checksum corruption before gzip", async () => {
    const source = city();
    const bytes = encodeCompleteCityPlan(planFor(source));
    install(source, manifestFor(source, bytes));
    storage.fetchCacheAsset.mockResolvedValue(Uint8Array.of(1, 2, 3));

    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
    expect(storage.gunzipBytes).not.toHaveBeenCalled();
  });

  it("converts gzip failure to null", async () => {
    const source = city();
    const compressed = Uint8Array.of(1, 2, 3);
    install(source, manifestFor(source, compressed));
    storage.fetchCacheAsset.mockResolvedValue(compressed);
    storage.gunzipBytes.mockRejectedValue(new Error("invalid gzip"));

    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
  });

  it.each([
    ["JSON", new TextEncoder().encode("{")],
    ["validation", new TextEncoder().encode(JSON.stringify({ sourceRevision: 7 }))]
  ])("converts %s corruption to null", async (_boundary, encoded) => {
    const source = city();
    install(source, manifestFor(source, encoded));
    storage.fetchCacheAsset.mockResolvedValue(encoded);

    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
  });

  it("converts decoded plan identity corruption to null", async () => {
    const source = city();
    const stalePlan = { ...planFor(source), sourceRevision: source.revision + 1 };
    const encoded = encodeCompleteCityPlan(stalePlan);
    install(source, manifestFor(source, encoded));
    storage.fetchCacheAsset.mockResolvedValue(encoded);

    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
  });

  it("returns null when the Scene or authoritative city changes during fetch", async () => {
    const source = city();
    const encoded = encodeCompleteCityPlan(planFor(source));
    install(source, manifestFor(source, encoded));
    storage.fetchCacheAsset.mockImplementation(async (): Promise<Uint8Array> => {
      cityFlag = { ...source, revision: source.revision + 1 };
      return encoded;
    });

    await expect(loadCachedCompletePlan(source)).resolves.toBeNull();
  });
});

describe("complete plan cache publication", () => {
  it("uses slot zero without a valid manifest and publishes a relative compressed artifact ref", async () => {
    const source = city();
    const plan = planFor(source);
    const encoded = encodeCompleteCityPlan(plan);

    const published = await publishCompletePlanCache(source, plan);

    const filename = planFilenameFor(source, encoded);
    expect(storage.uploadCacheAsset).toHaveBeenCalledWith(
      "scene-1",
      0,
      filename,
      encoded,
      "application/gzip"
    );
    expect(published).toMatchObject({
      cityRevision: source.revision,
      slot: 0,
      plan: {
        artifact: {
          path: `city-cache/scene-1/slot-0/${filename}`,
          byteLength: encoded.byteLength
        }
      }
    });
    expect(published.plan.artifact.checksum).toBe(checksumBytes(encoded));
    expect(setFlag).toHaveBeenCalledWith(MODULE_ID, CITY_CACHE_FLAG, published);
  });

  it.each([
    [0, 1],
    [1, 0]
  ] as const)("rotates from active slot %s to inactive slot %s", async (active, inactive) => {

    const source = city();
    const plan = planFor(source);
    const encoded = encodeCompleteCityPlan(plan);
    const stale = manifestFor({ ...source, revision: source.revision + 1 }, Uint8Array.of(9), active);
    install(source, stale);

    const published = await publishCompletePlanCache(source, plan);
    expect(published.slot).toBe(inactive);
    expect(storage.uploadCacheAsset).toHaveBeenCalledWith(
      "scene-1",
      inactive,
      planFilenameFor(source, encoded),
      encoded,
      "application/gzip"
    );
  });
  it("keeps concurrent plan artifacts distinct through revision/signature/content-qualified refs", async () => {
    const source = city();
    const requestedPlan = planFor(source);
    const requestedBytes = encodeCompleteCityPlan(requestedPlan);
    const concurrentPlan = {
      ...requestedPlan,
      actionToken: "concurrent-action",
      buildToken: "concurrent-build"
    };
    const concurrentBytes = encodeCompleteCityPlan(concurrentPlan);
    const concurrentManifest = manifestFor(source, concurrentBytes, 1);
    let uploadedFilename = "";
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      uploadedFilename = filename;
      cacheFlag = concurrentManifest;
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    storage.fetchCacheAsset.mockResolvedValue(concurrentBytes);

    await expect(publishCompletePlanCache(source, requestedPlan)).resolves.toEqual(concurrentManifest);

    expect(uploadedFilename).toBe(planFilenameFor(source, requestedBytes));
    expect(uploadedFilename).not.toBe(planFilenameFor(source, concurrentBytes));
    expect(concurrentManifest.plan.artifact.path).toContain(planFilenameFor(source, concurrentBytes));
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("preserves a matching plan and its chunk manifest without upload or flag rotation", async () => {
    const source = city();
    const plan = planFor(source);
    const encoded = encodeCompleteCityPlan(plan);
    const matching: CityCacheManifestV1 = {
      ...manifestFor(source, encoded, 1),
      chunks: {
        formatVersion: CHUNK_CACHE_FORMAT_VERSION,
        sceneGeometrySignature: "geometry-signature",
        entries: []
      }
    };
    install(source, matching);
    storage.fetchCacheAsset.mockResolvedValue(encoded);

    await expect(publishCompletePlanCache(source, plan)).resolves.toEqual(matching);
    expect(storage.uploadCacheAsset).not.toHaveBeenCalled();
    expect(setFlag).not.toHaveBeenCalled();
    expect(cacheFlag).toBe(matching);
  });

  it("repairs a matching manifest whose referenced artifact is missing", async () => {
    const source = city();
    const plan = planFor(source);
    const encoded = encodeCompleteCityPlan(plan);
    install(source, manifestFor(source, encoded, 0));
    storage.fetchCacheAsset.mockRejectedValue(new Error("HTTP 404"));

    const repaired = await publishCompletePlanCache(source, plan);

    expect(repaired.slot).toBe(1);
    expect(storage.uploadCacheAsset).toHaveBeenCalledWith(
      "scene-1",
      1,
      planFilenameFor(source, encoded),
      encoded,
      "application/gzip"
    );
    expect(setFlag).toHaveBeenCalledWith(MODULE_ID, CITY_CACHE_FLAG, repaired);
  });

  it("repairs a matching manifest whose referenced artifact fails checksum verification", async () => {
    const source = city();
    const plan = planFor(source);
    const encoded = encodeCompleteCityPlan(plan);
    install(source, manifestFor(source, encoded, 1));
    storage.fetchCacheAsset.mockResolvedValue(Uint8Array.of(0, 1, 2));

    const repaired = await publishCompletePlanCache(source, plan);

    expect(repaired.slot).toBe(0);
    expect(storage.gunzipBytes).not.toHaveBeenCalled();
    expect(storage.uploadCacheAsset).toHaveBeenCalledWith(
      "scene-1",
      0,
      planFilenameFor(source, encoded),
      encoded,
      "application/gzip"
    );
    expect(setFlag).toHaveBeenCalledWith(MODULE_ID, CITY_CACHE_FLAG, repaired);
  });

  it.each([
    ["terrain", (current: CityStateV3): void => { current.source.terrain.land[0]!.x += 1; }],
    ["roads", (current: CityStateV3): void => { current.source.roads.routes.push({ id: "route-new", curvePreset: "standard" }); }],
    ["districts", (current: CityStateV3): void => {
      current.source.districts.push({
        id: "district-new",
        polygon: [{ x: -90, y: -70 }, { x: -10, y: -70 }, { x: -10, y: 70 }, { x: -90, y: 70 }],
        seed: "district-seed",
        typeId: "heavy-industrial",
        paletteId: "industrial",
        origin: "authored",
        locked: false,
        openSpaceOverride: null
      });
    }],
    ["generation", (current: CityStateV3): void => { current.source.generation.openSpaceProfile = "high"; }]
  ] as const)("rejects a stale %s signature after upload and before setFlag", async (_key, mutate) => {
    const source = city();
    const plan = planFor(source);
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      const changed = structuredClone(source);
      mutate(changed);
      cityFlag = changed;
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });

    await expect(publishCompletePlanCache(source, plan)).rejects.toThrow(/authoritative city|supported City Generator/);
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("rejects a stale revision and active Scene replacement after upload before setFlag", async () => {
    const source = city();
    const plan = planFor(source);
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      cityFlag = { ...source, revision: source.revision + 1 };
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    await expect(publishCompletePlanCache(source, plan)).rejects.toThrow(/revision changed/);
    expect(setFlag).not.toHaveBeenCalled();

    install(source);
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      vi.stubGlobal("canvas", { scene: { ...scene, id: "scene-2" } });
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    await expect(publishCompletePlanCache(source, plan)).rejects.toThrow(/active Scene changed/);
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("rejects non-GM publication before compression/upload and rechecks authority before setFlag", async () => {
    const source = city();
    const plan = planFor(source);
    vi.stubGlobal("game", { user: { isGM: false } });
    await expect(publishCompletePlanCache(source, plan)).rejects.toThrow(/Only a GM/);
    expect(storage.gzipBytes).not.toHaveBeenCalled();
    expect(storage.uploadCacheAsset).not.toHaveBeenCalled();

    install(source);
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      vi.stubGlobal("game", { user: { isGM: false } });
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    await expect(publishCompletePlanCache(source, plan)).rejects.toThrow(/Only a GM/);
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("leaves the existing manifest untouched when upload fails", async () => {
    const source = city();
    const existing = manifestFor({ ...source, revision: source.revision + 1 }, Uint8Array.of(4), 0);
    install(source, existing);
    storage.uploadCacheAsset.mockRejectedValue(new Error("upload denied"));

    await expect(publishCompletePlanCache(source, planFor(source))).rejects.toThrow("upload denied");
    expect(setFlag).not.toHaveBeenCalled();
    expect(cacheFlag).toBe(existing);
  });
});

describe("complete chunk cache signatures and loading", () => {
  it("binds geometry inputs and the exact sorted unique expected set", () => {
    const source = city();
    const plan = planFor(source);
    const first = chunkSceneGeometrySignature(source, plan, SCENE_BOUNDS_M, PIXELS_PER_METRE, ["1,0", "0,0"]);
    expect(chunkSceneGeometrySignature(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      ["0,0", "1,0"]
    )).toBe(first);
    expect(chunkSceneGeometrySignature(
      source,
      { ...plan, buildToken: "other-build" },
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      ["0,0", "1,0"]
    )).not.toBe(first);
    expect(chunkSceneGeometrySignature(
      source,
      plan,
      { ...SCENE_BOUNDS_M, width: 101 },
      PIXELS_PER_METRE,
      ["0,0", "1,0"]
    )).not.toBe(first);
    expect(() => chunkSceneGeometrySignature(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      ["0,0", "0,0"]
    )).toThrow(/duplicated/);
  });

  it("loads a full hit and reports each validated record progressively", async () => {
    const source = city();
    const plan = planFor(source);
    const planBytes = encodeCompleteCityPlan(plan);
    const records = [chunkRecord("0,0", 0), chunkRecord("1,0", 8)];
    const cached = manifestWithChunks(source, plan, planBytes, records);
    install(source, cached.manifest);
    storage.fetchCacheAsset.mockImplementation(async (path: string): Promise<Uint8Array> => cached.assets.get(path)!);
    const onRecord = vi.fn();

    const loaded = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      records.map((record) => record.id),
      onRecord
    );

    expect(loaded?.records.map((record) => record.id)).toEqual(["0,0", "1,0"]);
    expect(loaded?.missingChunkIds).toEqual([]);
    expect(onRecord.mock.calls.map(([record]) => (record as CachedCompleteChunkRecord).id).sort()).toEqual(["0,0", "1,0"]);
  });

  it("propagates progressive callback exceptions instead of converting them to cache misses", async () => {
    const source = city();
    const plan = planFor(source);
    const record = chunkRecord("0,0", 0);
    const cached = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), [record]);
    install(source, cached.manifest);
    storage.fetchCacheAsset.mockImplementation(async (path: string): Promise<Uint8Array> => cached.assets.get(path)!);
    const callbackFailure = new Error("renderer installation failed");

    await expect(loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [record.id],
      () => { throw callbackFailure; }
    )).rejects.toBe(callbackFailure);
  });

  it("rejects cross-scene and old-geometry chunk paths before fetching them", async () => {
    const source = city();
    const plan = planFor(source);
    const records = [chunkRecord("0,0", 0), chunkRecord("1,0", 8)];
    const cached = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), records);
    const entries = cached.manifest.chunks!.entries;
    entries[0]!.ref.path = entries[0]!.ref.path.replace("city-cache/scene-1/", "city-cache/scene-other/");
    entries[1]!.ref.path = entries[1]!.ref.path.replace(
      cached.manifest.chunks!.sceneGeometrySignature,
      "g1-old-geometry"
    );
    install(source, cached.manifest);

    const loaded = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      records.map((record) => record.id)
    );

    expect(loaded?.records).toEqual([]);
    expect(loaded?.missingChunkIds).toEqual(["0,0", "1,0"]);
    expect(storage.fetchCacheAsset).not.toHaveBeenCalled();
  });

  it("returns null for absent/mismatched descriptors and non-exact manifest entry sets", async () => {
    const source = city();
    const plan = planFor(source);
    const planBytes = encodeCompleteCityPlan(plan);
    const record = chunkRecord("0,0", 0);
    install(source, manifestFor(source, planBytes));
    await expect(loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [record.id]
    )).resolves.toBeNull();

    const cached = manifestWithChunks(source, plan, planBytes, [record]);
    install(source, {
      ...cached.manifest,
      chunks: { ...cached.manifest.chunks!, sceneGeometrySignature: "wrong-geometry" }
    });
    await expect(loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [record.id]
    )).resolves.toBeNull();

    const expectedIds = ["0,0", "1,0"];
    install(source, {
      ...cached.manifest,
      chunks: {
        ...cached.manifest.chunks!,
        sceneGeometrySignature: chunkSceneGeometrySignature(
          source,
          plan,
          SCENE_BOUNDS_M,
          PIXELS_PER_METRE,
          expectedIds
        )
      }
    });
    await expect(loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      expectedIds
    )).resolves.toBeNull();
    expect(storage.fetchCacheAsset).not.toHaveBeenCalled();
  });

  it("keeps valid records while reporting individually missing and corrupt assets", async () => {
    const source = city();
    const plan = planFor(source);
    const records = [
      chunkRecord("0,0", 0),
      chunkRecord("1,0", 8),
      chunkRecord("2,0", 16)
    ];
    const cached = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), records);
    install(source, cached.manifest);
    const entries = cached.manifest.chunks!.entries;
    storage.fetchCacheAsset.mockImplementation(async (path: string): Promise<Uint8Array> => {
      if (path === entries[1]!.ref.path) throw new Error("missing");
      const bytes = cached.assets.get(path)!;
      if (path !== entries[2]!.ref.path) return bytes;
      const corrupt = bytes.slice();
      corrupt[0] = corrupt[0]! ^ 0xff;
      return corrupt;
    });

    const loaded = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      records.map((record) => record.id)
    );

    expect(loaded?.records.map((record) => record.id)).toEqual(["0,0"]);
    expect(loaded?.missingChunkIds).toEqual(["1,0", "2,0"]);
  });

  it("rejects decoded id, bounds, and primary mesh count mismatches per entry", async () => {
    const source = city();
    const plan = planFor(source);
    const records = [
      chunkRecord("0,0", 0),
      chunkRecord("1,0", 8),
      chunkRecord("2,0", 16)
    ];
    const cached = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), records);
    const entries = cached.manifest.chunks!.entries;
    const wrongIdBytes = encodeCompleteCityChunk(chunkRecord("wrong-id", 0));
    cached.assets.set(entries[0]!.ref.path, wrongIdBytes);
    entries[0]!.ref.byteLength = wrongIdBytes.byteLength;
    entries[0]!.ref.checksum = checksumBytes(wrongIdBytes);
    entries[1]!.bounds.x += 1;
    entries[2]!.counts.triangleCount += 1;
    install(source, cached.manifest);
    storage.fetchCacheAsset.mockImplementation(async (path: string): Promise<Uint8Array> => cached.assets.get(path)!);

    const loaded = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      records.map((record) => record.id)
    );

    expect(loaded?.records).toEqual([]);
    expect(loaded?.missingChunkIds).toEqual(["0,0", "1,0", "2,0"]);
  });

  it("accepts metre-to-pixel round-trip drift but rejects material pixel-bounds differences", async () => {
    const source = city();
    const plan = planFor(source);
    const drifted = chunkRecord("0,0", 0);
    drifted.boundsPx.x += 2e-12;
    const driftedCache = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), [drifted]);
    install(source, driftedCache.manifest);
    storage.fetchCacheAsset.mockImplementation(
      async (path: string): Promise<Uint8Array> => driftedCache.assets.get(path)!
    );

    const accepted = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [drifted.id]
    );
    expect(accepted?.records.map((record) => record.id)).toEqual([drifted.id]);
    expect(accepted?.missingChunkIds).toEqual([]);

    const materiallyWrong = chunkRecord("0,0", 0);
    materiallyWrong.boundsPx.x += 1e-6;
    const wrongCache = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), [materiallyWrong]);
    install(source, wrongCache.manifest);
    storage.fetchCacheAsset.mockImplementation(
      async (path: string): Promise<Uint8Array> => wrongCache.assets.get(path)!
    );

    const rejected = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [materiallyWrong.id]
    );
    expect(rejected?.records).toEqual([]);
    expect(rejected?.missingChunkIds).toEqual([materiallyWrong.id]);
  });

  it("bounds concurrent chunk fetches", async () => {
    const source = city();
    const plan = planFor(source);
    const records = Array.from({ length: 12 }, (_, index) => chunkRecord(`${index},0`, index * 8));
    const cached = manifestWithChunks(source, plan, encodeCompleteCityPlan(plan), records);
    install(source, cached.manifest);
    let active = 0;
    let maximumActive = 0;
    let releaseFetches!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetches = resolve; });
    storage.fetchCacheAsset.mockImplementation(async (path: string): Promise<Uint8Array> => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (active === 1) queueMicrotask(releaseFetches);
      await fetchGate;
      active--;
      return cached.assets.get(path)!;
    });

    const loaded = await loadCachedCompleteChunks(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      records.map((record) => record.id)
    );

    expect(loaded?.records).toHaveLength(records.length);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(6);
  });
});

describe("complete chunk cache publication", () => {
  it("uploads bounded immutable geometry-qualified raw artifacts before one manifest replacement", async () => {
    const source = city();
    const plan = planFor(source);
    const planBytes = encodeCompleteCityPlan(plan);
    const existing = manifestFor(source, planBytes);
    const records = Array.from({ length: 10 }, (_, index) => chunkRecord(`${index},0`, index * 8));
    install(source, existing);
    storage.fetchCacheAsset.mockResolvedValue(planBytes);
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseUploads!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUploads = resolve; });
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      events.push(`upload:${filename}`);
      if (active === 1) queueMicrotask(releaseUploads);
      await uploadGate;
      active--;
      events.push(`uploaded:${filename}`);
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    scene.setFlag = vi.fn(async (_moduleId: string, flag: string, value: unknown): Promise<unknown> => {
      events.push(`set:${flag}`);
      cacheFlag = structuredClone(value);
      return value;
    });

    const published = await publishCompleteChunkCache(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      records
    );

    const filenames = storage.uploadCacheAsset.mock.calls.map((call) => call[2] as string);
    expect(filenames).toHaveLength(records.length);
    expect(filenames.every((filename) =>
      /^[A-Za-z0-9._-]+\.chunk-cache\.json$/.test(filename) &&
      filename.includes(published.chunks!.sceneGeometrySignature)
    )).toBe(true);
    expect(events.at(-1)).toBe(`set:${CITY_CACHE_FLAG}`);
    expect(events.filter((event) => event.startsWith("uploaded:"))).toHaveLength(records.length);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(6);
    expect(published.slot).toBe(existing.slot);
    expect(published.plan).toEqual(existing.plan);
  });

  it("rejects stale authoritative city and plan manifests after upload", async () => {
    const source = city();
    const plan = planFor(source);
    const planBytes = encodeCompleteCityPlan(plan);
    const existing = manifestFor(source, planBytes);
    const record = chunkRecord("0,0", 0);

    install(source, existing);
    storage.fetchCacheAsset.mockResolvedValue(planBytes);
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      cityFlag = city(source.revision + 1);
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    await expect(publishCompleteChunkCache(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [record]
    )).rejects.toThrow(/revision changed/);
    expect(setFlag).not.toHaveBeenCalled();

    install(source, existing);
    storage.fetchCacheAsset.mockResolvedValue(planBytes);
    storage.uploadCacheAsset.mockImplementation(async (
      sceneId: string,
      slot: CacheSlot,
      filename: string
    ): Promise<string> => {
      cacheFlag = {
        ...existing,
        plan: {
          ...existing.plan,
          artifact: { ...existing.plan.artifact, checksum: "00000000" }
        }
      };
      return `city-cache/${sceneId}/slot-${slot}/${filename}`;
    });
    await expect(publishCompleteChunkCache(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [record]
    )).rejects.toThrow(/plan cache manifest changed/);
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("leaves the old manifest intact when any chunk upload fails", async () => {
    const source = city();
    const plan = planFor(source);
    const planBytes = encodeCompleteCityPlan(plan);
    const existing = manifestFor(source, planBytes);
    install(source, existing);
    storage.fetchCacheAsset.mockResolvedValue(planBytes);
    storage.uploadCacheAsset.mockRejectedValue(new Error("chunk upload denied"));

    await expect(publishCompleteChunkCache(
      source,
      plan,
      SCENE_BOUNDS_M,
      PIXELS_PER_METRE,
      [chunkRecord("0,0", 0)]
    )).rejects.toThrow("chunk upload denied");
    expect(setFlag).not.toHaveBeenCalled();
    expect(cacheFlag).toBe(existing);
  });
});

describe("city cache clear", () => {
  it("clears only the cache flag for a GM", async () => {
    const source = city();
    install(source, manifestFor(source, encodeCompleteCityPlan(planFor(source))));

    await expect(clearCityCache()).resolves.toBeUndefined();
    expect(unsetFlag).toHaveBeenCalledWith(MODULE_ID, CITY_CACHE_FLAG);
    expect(cacheFlag).toBeUndefined();
    expect(cityFlag).toBe(source);
  });

  it("rejects non-GM clear without touching the cache flag", async () => {
    const source = city();
    const existing = manifestFor(source, encodeCompleteCityPlan(planFor(source)));
    install(source, existing);
    vi.stubGlobal("game", { user: { isGM: false } });

    await expect(clearCityCache()).rejects.toThrow(/Only a GM/);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(cacheFlag).toBe(existing);
  });
});
