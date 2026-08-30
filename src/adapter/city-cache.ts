import { FLAG_CITY, GENERATOR_VERSION, MODULE_ID } from "../constants.js";
import {
  CHUNK_CACHE_FORMAT_VERSION,
  CITY_CACHE_FLAG,
  CITY_CACHE_SCHEMA_VERSION,
  PLAN_CACHE_FORMAT_VERSION,
  checksumBytes,
  decodeCityCacheManifest,
  type CacheChunkArtifactEntry,
  type CachePlanDescriptorV1,
  type CacheSlot,
  type CityCacheManifestV1
} from "../core/gen/city-cache.js";
import {
  decodeCompleteCityChunk,
  encodeCompleteCityChunk,
  type CachedCompleteChunkRecord
} from "../core/gen/complete-city-chunk-cache.js";
import {
  assertCompleteCityPlanCacheIdentity,
  decodeCompleteCityPlan,
  encodeCompleteCityPlan
} from "../core/gen/complete-city-plan-cache.js";
import {
  completeCityStructuralInput,
  type CompleteCityPlan
} from "../core/gen/complete-city-plan.js";
import { CHUNK_SIZE_M } from "../core/gen/chunks.js";
import type { Rect } from "../core/geom/types.js";
import {
  validateCityStateV4,
  type CityStateV4
} from "../core/gen/city.js";
import type { StructuralInputSignature } from "../core/gen/district-plan.js";
import {
  cityCacheSlotPath,
  fetchCacheAsset,
  gunzipBytes,
  gzipBytes,
  uploadCacheAsset
} from "./cache-storage.js";

const SIGNATURE_KEYS = ["terrain", "roads", "districts", "generation", "architecture", "schemaVersion", "generatorVersion"] as const;
const CHUNK_IO_CONCURRENCY = 6;
const SIGNATURE_ENCODER = new TextEncoder();

class ChunkRecordCallbackError {
  constructor(readonly original: unknown) {}
}
interface CacheScene {
  id: string;
  getFlag(moduleId: string, flag: string): unknown;
  setFlag(moduleId: string, flag: string, value: unknown): Promise<unknown>;
  unsetFlag(moduleId: string, flag: string): Promise<unknown>;
}


function activeScene(): CacheScene {
  const scene = canvas?.scene;
  if (!scene) throw new Error("No active scene.");
  if (typeof scene.id !== "string" || scene.id.length === 0) {
    throw new Error("The active Scene has no id.");
  }
  return scene;
}

function requireGM(): void {
  if (!game.user?.isGM) throw new Error("Only a GM may modify the city cache.");
}

function requireWritableScene(): CacheScene {
  requireGM();
  return activeScene();
}

function sameStructuralInput(a: StructuralInputSignature, b: StructuralInputSignature): boolean {
  for (const key of SIGNATURE_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function readManifest(scene: CacheScene): CityCacheManifestV1 | null {
  try {
    return decodeCityCacheManifest(scene.getFlag(MODULE_ID, CITY_CACHE_FLAG));
  } catch {
    return null;
  }
}

function assertCurrentCity(
  scene: CacheScene,
  expectedCity: CityStateV4,
  expectedStructuralInput: StructuralInputSignature
): void {
  if (canvas?.scene !== scene) throw new Error("The active Scene changed during city cache publication.");

  const currentRaw = scene.getFlag(MODULE_ID, FLAG_CITY);
  let problems: string[];
  try {
    problems = validateCityStateV4(currentRaw);
  } catch {
    throw new Error("The active Scene city is not a supported City Generator state.");
  }
  if (problems.length > 0) {
    throw new Error("The active Scene city is not a supported City Generator state.");
  }

  const current = currentRaw as CityStateV4;
  if (current.revision !== expectedCity.revision) {
    throw new Error("The authoritative city revision changed during city cache publication.");
  }

  const currentStructuralInput = completeCityStructuralInput(current.source);
  for (const key of SIGNATURE_KEYS) {
    if (currentStructuralInput[key] !== expectedStructuralInput[key]) {
      throw new Error(`The authoritative city ${key} signature changed during city cache publication.`);
    }
  }
}

function planAssetFilename(
  cityRevision: number,
  structuralInput: StructuralInputSignature,
  checksum: string
): string {
  const sourceSignature = checksumBytes(SIGNATURE_ENCODER.encode(JSON.stringify(
    SIGNATURE_KEYS.map((key) => structuralInput[key])
  )));
  return `plan-r${cityRevision}-${sourceSignature}-${checksum}.plan-cache.json`;
}

function expectedPlanPath(
  sceneId: string,
  slot: CacheSlot,
  city: CityStateV4,
  structuralInput: StructuralInputSignature,
  checksum: string
): string {
  return `${cityCacheSlotPath(sceneId, slot)}/${planAssetFilename(city.revision, structuralInput, checksum)}`;
}

function manifestMatchesPlan(
  manifest: CityCacheManifestV1,
  sceneId: string,
  city: CityStateV4,
  structuralInput: StructuralInputSignature
): boolean {
  return manifest.cityRevision === city.revision &&
    sameStructuralInput(manifest.structuralInput, structuralInput) &&
    manifest.plan.artifact.path === expectedPlanPath(
      sceneId,
      manifest.slot,
      city,
      structuralInput,
      manifest.plan.artifact.checksum
    );
}

function samePlanDescriptor(a: CachePlanDescriptorV1, b: CachePlanDescriptorV1): boolean {
  return a.formatVersion === b.formatVersion &&
    a.artifact.path === b.artifact.path &&
    a.artifact.byteLength === b.artifact.byteLength &&
    a.artifact.checksum === b.artifact.checksum;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameRectWithinFloatRoundTrip(a: Rect, b: Rect): boolean {
  const withinTolerance = (left: number, right: number): boolean => {
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= Number.EPSILON * 32 * scale;
  };
  return withinTolerance(a.x, b.x) &&
    withinTolerance(a.y, b.y) &&
    withinTolerance(a.width, b.width) &&
    withinTolerance(a.height, b.height);
}

function validateRect(rect: Rect, label: string): void {
  if (typeof rect !== "object" || rect === null ||
    !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) || rect.width < 0 ||
    !Number.isFinite(rect.height) || rect.height < 0) {
    throw new Error(`${label} must be a finite rectangle with non-negative dimensions.`);
  }
}

function sortedUniqueChunkIds(chunkIds: readonly string[]): string[] {
  if (!Array.isArray(chunkIds)) throw new Error("Expected chunk ids must be an array.");
  const seen = new Set<string>();
  for (const chunkId of chunkIds) {
    if (typeof chunkId !== "string" || chunkId.trim().length === 0) {
      throw new Error("Expected chunk ids must be non-empty text.");
    }
    if (seen.has(chunkId)) throw new Error(`Expected chunk id "${chunkId}" is duplicated.`);
    seen.add(chunkId);
  }
  return [...chunkIds].sort();
}

function chunkEntryCounts(record: CachedCompleteChunkRecord): { vertexCount: number; triangleCount: number } {
  return {
    vertexCount: record.mesh.vertexCount,
    triangleCount: record.mesh.triangleCount
  };
}

function recordMatchesEntry(
  record: CachedCompleteChunkRecord,
  entry: CacheChunkArtifactEntry,
  origin: { x: number; y: number },
  pixelsPerMetre: number
): boolean {
  const expectedCounts = chunkEntryCounts(record);
  const expectedBoundsPx = {
    x: origin.x + record.boundsM.x * pixelsPerMetre,
    y: origin.y + record.boundsM.y * pixelsPerMetre,
    width: record.boundsM.width * pixelsPerMetre,
    height: record.boundsM.height * pixelsPerMetre
  };
  return record.id === entry.chunkId &&
    sameRect(record.boundsM, entry.bounds) &&
    sameRectWithinFloatRoundTrip(record.boundsPx, expectedBoundsPx) &&
    expectedCounts.vertexCount === entry.counts.vertexCount &&
    expectedCounts.triangleCount === entry.counts.triangleCount;
}

async function mapBounded<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        failure = error;
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    () => worker()
  );
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

function chunkEntryPathMatches(
  sceneId: string,
  slot: CacheSlot,
  geometrySignature: string,
  entry: CacheChunkArtifactEntry
): boolean {
  const namespace = `${cityCacheSlotPath(sceneId, slot)}/chunk-${geometrySignature}-`;
  if (!entry.ref.path.startsWith(namespace)) return false;
  const tail = entry.ref.path.slice(namespace.length);
  const checksumSuffix = `-${entry.ref.checksum}.chunk-cache.json`;
  if (!tail.endsWith(checksumSuffix)) return false;
  const identityParts = tail.slice(0, -checksumSuffix.length).split("-");
  return identityParts.length === 2 &&
    /^[0-9a-z]+$/.test(identityParts[0]!) &&
    /^[0-9a-f]{8}$/.test(identityParts[1]!);
}

function currentManifestMatches(
  scene: CacheScene,
  expected: CityCacheManifestV1,
  city: CityStateV4,
  structuralInput: StructuralInputSignature,
  expectedGeometrySignature?: string
): boolean {
  const current = readManifest(scene);
  if (current === null ||
    !manifestMatchesPlan(current, scene.id, city, structuralInput) ||
    current.slot !== expected.slot ||
    !samePlanDescriptor(current.plan, expected.plan)) {
    return false;
  }
  return expectedGeometrySignature === undefined ||
    current.chunks?.sceneGeometrySignature === expectedGeometrySignature;
}

export function chunkSceneGeometrySignature(
  city: CityStateV4,
  plan: CompleteCityPlan,
  boundsM: Rect,
  pixelsPerMetre: number,
  chunkIds: readonly string[]
): string {
  validateRect(boundsM, "Scene bounds");
  if (!Number.isFinite(city.source.origin.x) || !Number.isFinite(city.source.origin.y)) {
    throw new Error("City origin must be finite.");
  }
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) {
    throw new Error("Pixels per metre must be positive.");
  }
  if ((typeof plan.buildToken !== "string" && typeof plan.buildToken !== "number") ||
    (typeof plan.buildToken === "string" && plan.buildToken.length === 0) ||
    (typeof plan.buildToken === "number" && !Number.isFinite(plan.buildToken))) {
    throw new Error("Plan build token must be finite or non-empty text.");
  }
  const expectedChunkIds = sortedUniqueChunkIds(chunkIds);
  const material = JSON.stringify([
    CHUNK_CACHE_FORMAT_VERSION,
    CHUNK_SIZE_M,
    SIGNATURE_KEYS.map((key) => plan.structuralInput[key]),
    typeof plan.buildToken,
    plan.buildToken,
    city.source.origin.x,
    city.source.origin.y,
    boundsM.x,
    boundsM.y,
    boundsM.width,
    boundsM.height,
    pixelsPerMetre,
    expectedChunkIds
  ]);
  const primary = checksumBytes(SIGNATURE_ENCODER.encode(material));
  const secondary = checksumBytes(SIGNATURE_ENCODER.encode(`complete-city-chunks:${material}`));
  return `g${CHUNK_CACHE_FORMAT_VERSION}-${primary}-${secondary}`;
}

export function loadCityCacheManifest(): CityCacheManifestV1 | null {
  try {
    return readManifest(activeScene());
  } catch {
    return null;
  }
}

export async function loadCachedCompletePlan(
  city: CityStateV4
): Promise<{ plan: CompleteCityPlan; manifest: CityCacheManifestV1 } | null> {
  try {
    const scene = activeScene();
    const structuralInput = completeCityStructuralInput(city.source);
    assertCurrentCity(scene, city, structuralInput);

    const manifest = readManifest(scene);
    if (manifest === null ||
      !manifestMatchesPlan(manifest, scene.id, city, structuralInput)) {
      return null;
    }

    const compressed = await fetchCacheAsset(
      manifest.plan.artifact.path,
      manifest.plan.artifact.byteLength
    );
    if (checksumBytes(compressed) !== manifest.plan.artifact.checksum) return null;

    const encoded = await gunzipBytes(compressed);
    const plan = decodeCompleteCityPlan(encoded);
    assertCompleteCityPlanCacheIdentity(plan, {
      sourceRevision: city.revision,
      structuralInput
    });
    assertCurrentCity(scene, city, structuralInput);
    return { plan, manifest };
  } catch {
    return null;
  }
}

export async function publishCompletePlanCache(
  city: CityStateV4,
  plan: CompleteCityPlan
): Promise<CityCacheManifestV1> {
  const scene = requireWritableScene();
  const cityProblems = validateCityStateV4(city);
  if (cityProblems.length > 0) throw new Error(`Cannot cache an unsupported city: ${cityProblems.join(" ")}`);

  const structuralInput = completeCityStructuralInput(city.source);
  assertCurrentCity(scene, city, structuralInput);

  const encoded = encodeCompleteCityPlan(plan);
  const decodedPlan = decodeCompleteCityPlan(encoded);
  assertCompleteCityPlanCacheIdentity(decodedPlan, {
    sourceRevision: city.revision,
    structuralInput
  });

  const currentManifest = readManifest(scene);
  if (currentManifest !== null && manifestMatchesPlan(
    currentManifest,
    scene.id,
    city,
    structuralInput
  )) {
    const cached = await loadCachedCompletePlan(city);
    if (cached !== null) {
      requireGM();
      return cached.manifest;
    }
  }

  const compressed = await gzipBytes(encoded);
  if (compressed.byteLength === 0) throw new Error("Compressed city plan cache artifact is empty.");
  const checksum = checksumBytes(compressed);
  const slot: CacheSlot = currentManifest === null ? 0 : currentManifest.slot === 0 ? 1 : 0;
  const filename = planAssetFilename(city.revision, structuralInput, checksum);
  const path = await uploadCacheAsset(
    scene.id,
    slot,
    filename,
    compressed,
    "application/gzip"
  );
  if (path !== expectedPlanPath(scene.id, slot, city, structuralInput, checksum)) {
    throw new Error("City cache upload returned an unexpected artifact path.");
  }

  const concurrentlyPublished = readManifest(scene);
  if (concurrentlyPublished !== null && manifestMatchesPlan(
    concurrentlyPublished,
    scene.id,
    city,
    structuralInput
  )) {
    const cached = await loadCachedCompletePlan(city);
    if (cached !== null) {
      requireGM();
      return cached.manifest;
    }
  }

  const manifest: CityCacheManifestV1 = {
    kind: "project-nixie-city-cache",
    cacheSchemaVersion: CITY_CACHE_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    cityRevision: city.revision,
    structuralInput: { ...structuralInput },
    slot,
    plan: {
      formatVersion: PLAN_CACHE_FORMAT_VERSION,
      artifact: {
        path,
        byteLength: compressed.byteLength,
        checksum
      }
    }
  };

  assertCurrentCity(scene, city, structuralInput);
  requireGM();
  await scene.setFlag(MODULE_ID, CITY_CACHE_FLAG, manifest);
  return manifest;
}

export async function loadCachedCompleteChunks(
  city: CityStateV4,
  plan: CompleteCityPlan,
  boundsM: Rect,
  pixelsPerMetre: number,
  expectedChunkIds: readonly string[],
  onRecord?: (record: CachedCompleteChunkRecord) => void
): Promise<{
  records: CachedCompleteChunkRecord[];
  missingChunkIds: string[];
  manifest: CityCacheManifestV1;
} | null> {
  const uniqueChunkIds = sortedUniqueChunkIds(expectedChunkIds);

  try {
    const geometrySignature = chunkSceneGeometrySignature(
      city,
      plan,
      boundsM,
      pixelsPerMetre,
      uniqueChunkIds
    );
    const scene = activeScene();
    const structuralInput = completeCityStructuralInput(city.source);
    assertCompleteCityPlanCacheIdentity(plan, {
      sourceRevision: city.revision,
      structuralInput
    });
    assertCurrentCity(scene, city, structuralInput);

    const manifest = readManifest(scene);
    if (manifest === null ||
      !manifestMatchesPlan(manifest, scene.id, city, structuralInput) ||
      manifest.chunks === undefined ||
      manifest.chunks.sceneGeometrySignature !== geometrySignature) {
      return null;
    }

    const entriesById = new Map(
      manifest.chunks.entries.map((entry) => [entry.chunkId, entry] as const)
    );
    if (entriesById.size !== uniqueChunkIds.length ||
      uniqueChunkIds.some((chunkId) => !entriesById.has(chunkId))) {
      return null;
    }

    const entries = expectedChunkIds.map((chunkId) => entriesById.get(chunkId)!);
    const loaded = await mapBounded(entries, CHUNK_IO_CONCURRENCY, async (entry) => {
      let record: CachedCompleteChunkRecord;
      try {
        if (!chunkEntryPathMatches(scene.id, manifest.slot, geometrySignature, entry)) return null;
        const bytes = await fetchCacheAsset(entry.ref.path, entry.ref.byteLength);
        if (bytes.byteLength !== entry.ref.byteLength ||
          checksumBytes(bytes) !== entry.ref.checksum) return null;
        record = decodeCompleteCityChunk(bytes);
        if (!recordMatchesEntry(record, entry, city.source.origin, pixelsPerMetre)) return null;
      } catch {
        return null;
      }
      try {
        onRecord?.(record);
      } catch (error) {
        throw new ChunkRecordCallbackError(error);
      }
      return record;
    });

    assertCurrentCity(scene, city, structuralInput);
    if (!currentManifestMatches(scene, manifest, city, structuralInput, geometrySignature)) return null;

    const records: CachedCompleteChunkRecord[] = [];
    const missingChunkIds: string[] = [];
    for (let index = 0; index < loaded.length; index++) {
      const record = loaded[index];
      if (record === null || record === undefined) missingChunkIds.push(expectedChunkIds[index]!);
      else records.push(record);
    }
    return { records, missingChunkIds, manifest };
  } catch (error) {
    if (error instanceof ChunkRecordCallbackError) throw error.original;
    return null;
  }
}

export async function publishCompleteChunkCache(
  city: CityStateV4,
  plan: CompleteCityPlan,
  boundsM: Rect,
  pixelsPerMetre: number,
  records: readonly CachedCompleteChunkRecord[]
): Promise<CityCacheManifestV1> {
  const scene = requireWritableScene();
  const cityProblems = validateCityStateV4(city);
  if (cityProblems.length > 0) throw new Error(`Cannot cache an unsupported city: ${cityProblems.join(" ")}`);

  const structuralInput = completeCityStructuralInput(city.source);
  assertCurrentCity(scene, city, structuralInput);
  const sortedRecords = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const geometrySignature = chunkSceneGeometrySignature(
    city,
    plan,
    boundsM,
    pixelsPerMetre,
    sortedRecords.map((record) => record.id)
  );

  // The plan is the stable root of the cache manifest. Ensure its artifact is readable
  // before placing immutable chunk artifacts alongside its active slot.
  const planManifest = await publishCompletePlanCache(city, plan);
  assertCurrentCity(scene, city, structuralInput);
  if (!currentManifestMatches(scene, planManifest, city, structuralInput)) {
    throw new Error("The active plan cache manifest changed before chunk publication.");
  }

  const prepared = sortedRecords.map((record, index) => {
    const bytes = encodeCompleteCityChunk(record);
    const decoded = decodeCompleteCityChunk(bytes);
    const counts = chunkEntryCounts(decoded);
    const checksum = checksumBytes(bytes);
    const idChecksum = checksumBytes(SIGNATURE_ENCODER.encode(record.id));
    const filename = `chunk-${geometrySignature}-${index.toString(36)}-${idChecksum}-${checksum}.chunk-cache.json`;
    return {
      bytes,
      filename,
      entry: {
        chunkId: decoded.id,
        ref: {
          path: `${cityCacheSlotPath(scene.id, planManifest.slot)}/${filename}`,
          byteLength: bytes.byteLength,
          checksum
        },
        bounds: { ...decoded.boundsM },
        counts
      } satisfies CacheChunkArtifactEntry
    };
  });

  const entries = await mapBounded(prepared, CHUNK_IO_CONCURRENCY, async (artifact) => {
    const path = await uploadCacheAsset(
      scene.id,
      planManifest.slot,
      artifact.filename,
      artifact.bytes,
      "application/octet-stream"
    );
    if (path !== artifact.entry.ref.path) {
      throw new Error("City chunk cache upload returned an unexpected artifact path.");
    }
    return artifact.entry;
  });

  assertCurrentCity(scene, city, structuralInput);
  if (!currentManifestMatches(scene, planManifest, city, structuralInput)) {
    throw new Error("The active plan cache manifest changed during chunk publication.");
  }
  requireGM();

  const manifest: CityCacheManifestV1 = {
    kind: planManifest.kind,
    cacheSchemaVersion: planManifest.cacheSchemaVersion,
    generatorVersion: planManifest.generatorVersion,
    cityRevision: planManifest.cityRevision,
    structuralInput: { ...planManifest.structuralInput },
    slot: planManifest.slot,
    plan: {
      formatVersion: planManifest.plan.formatVersion,
      artifact: { ...planManifest.plan.artifact }
    },
    chunks: {
      formatVersion: CHUNK_CACHE_FORMAT_VERSION,
      sceneGeometrySignature: geometrySignature,
      entries
    }
  };
  await scene.setFlag(MODULE_ID, CITY_CACHE_FLAG, manifest);
  return manifest;
}

export async function clearCityCache(): Promise<void> {
  const scene = requireWritableScene();
  await scene.unsetFlag(MODULE_ID, CITY_CACHE_FLAG);
}
