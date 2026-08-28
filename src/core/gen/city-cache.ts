import { GENERATOR_VERSION } from "../../constants.js";
import type { StructuralInputSignature } from "./district-plan.js";

export const CITY_CACHE_SCHEMA_VERSION = 1;
export const PLAN_CACHE_FORMAT_VERSION = 1;
export const CHUNK_CACHE_FORMAT_VERSION = 1;
export const CITY_CACHE_FLAG = "city-cache";

export type CacheSlot = 0 | 1;

export interface CacheArtifactRef {
  /** Path relative to modules/project-nixie/storage. */
  path: string;
  byteLength: number;
  /** Lower-case FNV-1a checksum produced by checksumBytes. */
  checksum: string;
}

export interface CachePlanDescriptorV1 {
  formatVersion: typeof PLAN_CACHE_FORMAT_VERSION;
  artifact: CacheArtifactRef;
}

export interface CacheChunkBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CacheChunkCounts {
  vertexCount: number;
  triangleCount: number;
}

export interface CacheChunkArtifactEntry {
  chunkId: string;
  ref: CacheArtifactRef;
  bounds: CacheChunkBounds;
  counts: CacheChunkCounts;
}

/** Reserved by schema V1 so Phase 2 can publish chunk artifacts without changing the manifest schema. */
export interface CacheChunkDescriptorV1 {
  formatVersion: typeof CHUNK_CACHE_FORMAT_VERSION;
  sceneGeometrySignature: string;
  entries: CacheChunkArtifactEntry[];
}

/**
 * An expendable cache index. This is never authoritative city state: failure to decode
 * it, or failure to verify any referenced artifact, is only a cache miss.
 */
export interface CityCacheManifestV1 {
  kind: "project-nixie-city-cache";
  cacheSchemaVersion: typeof CITY_CACHE_SCHEMA_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  cityRevision: number;
  structuralInput: StructuralInputSignature;
  slot: CacheSlot;
  plan: CachePlanDescriptorV1;
  chunks?: CacheChunkDescriptorV1;
}

const ARTIFACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const CHECKSUM = /^[0-9a-f]{8}$/;
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

type UnknownRecord = Record<string, unknown>;

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[],
  problems: string[]
): UnknownRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${label} must be an object.`);
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    problems.push(`${label} must be a plain object.`);
    return null;
  }
  const record = value as UnknownRecord;
  const expected = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) problems.push(`${label} has unknown key "${key}".`);
  }
  for (const key of required) {
    if (!hasOwn(record, key)) problems.push(`${label} is missing "${key}".`);
  }
  return record;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateArtifactRef(value: unknown, label: string, problems: string[]): void {
  const ref = exactRecord(value, label, ["path", "byteLength", "checksum"], [], problems);
  if (!ref) return;
  if (typeof ref.path !== "string" || !ARTIFACT_PATH.test(ref.path)) {
    problems.push(`${label}.path must be a safe path relative to modules/project-nixie/storage.`);
  }
  if (!positiveInteger(ref.byteLength)) problems.push(`${label}.byteLength must be a positive safe integer.`);
  if (typeof ref.checksum !== "string" || !CHECKSUM.test(ref.checksum)) {
    problems.push(`${label}.checksum must be an eight-character lower-case hexadecimal checksum.`);
  }
}

function validateStructuralInput(value: unknown, problems: string[]): void {
  const signature = exactRecord(
    value,
    "Cache manifest structuralInput",
    ["terrain", "roads", "districts", "generation"],
    [],
    problems
  );
  if (!signature) return;
  for (const key of ["terrain", "roads", "districts", "generation"] as const) {
    if (!nonEmptyText(signature[key])) problems.push(`Cache manifest structuralInput.${key} must be non-empty text.`);
  }
}

function validatePlan(value: unknown, problems: string[]): void {
  const plan = exactRecord(value, "Cache manifest plan", ["formatVersion", "artifact"], [], problems);
  if (!plan) return;
  if (plan.formatVersion !== PLAN_CACHE_FORMAT_VERSION) problems.push("Unsupported plan cache format version.");
  validateArtifactRef(plan.artifact, "Cache manifest plan artifact", problems);
}

function validateBounds(value: unknown, label: string, problems: string[]): void {
  const bounds = exactRecord(value, label, ["x", "y", "width", "height"], [], problems);
  if (!bounds) return;
  if (typeof bounds.x !== "number" || !Number.isFinite(bounds.x)) problems.push(`${label}.x must be finite.`);
  if (typeof bounds.y !== "number" || !Number.isFinite(bounds.y)) problems.push(`${label}.y must be finite.`);
  if (typeof bounds.width !== "number" || !Number.isFinite(bounds.width) || bounds.width < 0) {
    problems.push(`${label}.width must be finite and non-negative.`);
  }
  if (typeof bounds.height !== "number" || !Number.isFinite(bounds.height) || bounds.height < 0) {
    problems.push(`${label}.height must be finite and non-negative.`);
  }
}

function validateCounts(value: unknown, label: string, problems: string[]): void {
  const counts = exactRecord(value, label, ["vertexCount", "triangleCount"], [], problems);
  if (!counts) return;
  if (!nonNegativeCount(counts.vertexCount)) problems.push(`${label}.vertexCount must be a non-negative safe integer.`);
  if (!nonNegativeCount(counts.triangleCount)) problems.push(`${label}.triangleCount must be a non-negative safe integer.`);
}

function validateChunks(value: unknown, problems: string[]): void {
  const chunks = exactRecord(
    value,
    "Cache manifest chunks",
    ["formatVersion", "sceneGeometrySignature", "entries"],
    [],
    problems
  );
  if (!chunks) return;
  if (chunks.formatVersion !== CHUNK_CACHE_FORMAT_VERSION) problems.push("Unsupported chunk cache format version.");
  if (!nonEmptyText(chunks.sceneGeometrySignature)) {
    problems.push("Cache manifest chunks.sceneGeometrySignature must be non-empty text.");
  }
  if (!Array.isArray(chunks.entries)) {
    problems.push("Cache manifest chunks.entries must be an array.");
    return;
  }

  const chunkIds = new Set<string>();
  const artifactPaths = new Set<string>();
  for (let index = 0; index < chunks.entries.length; index++) {
    const label = `Cache manifest chunks.entries[${index}]`;
    const entry = exactRecord(chunks.entries[index], label, ["chunkId", "ref", "bounds", "counts"], [], problems);
    if (!entry) continue;
    if (!nonEmptyText(entry.chunkId)) {
      problems.push(`${label}.chunkId must be non-empty text.`);
    } else if (chunkIds.has(entry.chunkId)) {
      problems.push(`${label}.chunkId must be unique.`);
    } else {
      chunkIds.add(entry.chunkId);
    }
    validateArtifactRef(entry.ref, `${label}.ref`, problems);
    if (typeof entry.ref === "object" && entry.ref !== null && !Array.isArray(entry.ref)) {
      const path = (entry.ref as UnknownRecord).path;
      if (typeof path === "string" && ARTIFACT_PATH.test(path)) {
        if (artifactPaths.has(path)) problems.push(`${label}.ref.path must be unique.`);
        else artifactPaths.add(path);
      }
    }
    validateBounds(entry.bounds, `${label}.bounds`, problems);
    validateCounts(entry.counts, `${label}.counts`, problems);
  }
}

function validateManifest(value: unknown): string[] {
  const problems: string[] = [];
  const manifest = exactRecord(
    value,
    "City cache manifest",
    ["kind", "cacheSchemaVersion", "generatorVersion", "cityRevision", "structuralInput", "slot", "plan"],
    ["chunks"],
    problems
  );
  if (!manifest) return problems;

  if (manifest.kind !== "project-nixie-city-cache") problems.push("Invalid city cache manifest kind.");
  if (manifest.cacheSchemaVersion !== CITY_CACHE_SCHEMA_VERSION) problems.push("Unsupported city cache schema version.");
  if (manifest.generatorVersion !== GENERATOR_VERSION) problems.push("Unsupported city cache generator version.");
  if (!positiveInteger(manifest.cityRevision)) problems.push("City cache manifest cityRevision must be a positive safe integer.");
  if (manifest.slot !== 0 && manifest.slot !== 1) problems.push("City cache manifest slot must be 0 or 1.");
  validateStructuralInput(manifest.structuralInput, problems);
  validatePlan(manifest.plan, problems);
  if (hasOwn(manifest, "chunks")) validateChunks(manifest.chunks, problems);

  const plan = manifest.plan;
  const chunks = manifest.chunks;
  if (
    typeof plan === "object" && plan !== null && !Array.isArray(plan) &&
    typeof (plan as UnknownRecord).artifact === "object" && (plan as UnknownRecord).artifact !== null &&
    typeof chunks === "object" && chunks !== null && !Array.isArray(chunks) && Array.isArray((chunks as UnknownRecord).entries)
  ) {
    const planPath = ((plan as UnknownRecord).artifact as UnknownRecord).path;
    if (typeof planPath === "string") {
      for (const entry of (chunks as UnknownRecord).entries as unknown[]) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const ref = (entry as UnknownRecord).ref;
        if (typeof ref === "object" && ref !== null && !Array.isArray(ref) && (ref as UnknownRecord).path === planPath) {
          problems.push("Plan and chunk artifacts must use distinct paths.");
        }
      }
    }
  }
  return problems;
}

/** Strictly validates unknown manifest input without treating corruption as an authoritative-city error. */
export function validateCityCacheManifest(value: unknown): string[] {
  try {
    return validateManifest(value);
  } catch {
    return ["City cache manifest could not be inspected."];
  }
}

/** Returns a detached manifest value, or null for every malformed, unsupported, or unreadable cache manifest. */
export function decodeCityCacheManifest(value: unknown): CityCacheManifestV1 | null {
  if (validateCityCacheManifest(value).length > 0) return null;
  try {
    const manifest = value as CityCacheManifestV1;
    const decoded: CityCacheManifestV1 = {
      kind: manifest.kind,
      cacheSchemaVersion: manifest.cacheSchemaVersion,
      generatorVersion: manifest.generatorVersion,
      cityRevision: manifest.cityRevision,
      structuralInput: { ...manifest.structuralInput },
      slot: manifest.slot,
      plan: { formatVersion: manifest.plan.formatVersion, artifact: { ...manifest.plan.artifact } }
    };
    if (manifest.chunks) {
      decoded.chunks = {
        formatVersion: manifest.chunks.formatVersion,
        sceneGeometrySignature: manifest.chunks.sceneGeometrySignature,
        entries: manifest.chunks.entries.map((entry) => ({
          chunkId: entry.chunkId,
          ref: { ...entry.ref },
          bounds: { ...entry.bounds },
          counts: { ...entry.counts }
        }))
      };
    }
    return decoded;
  } catch {
    return null;
  }
}

/** Allocation-free over the input bytes; intended for corruption detection, not security. */
export function checksumBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index++) {
    hash = Math.imul(hash ^ bytes[index]!, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
