import type { CacheSlot } from "../core/gen/city-cache.js";

export const CACHE_MODULE_ID = "project-nixie";
export const CITY_CACHE_STORAGE_ROOT = "project-nixie-cache";
export const CITY_CACHE_STORAGE_DIRECTORY = "city-cache";

const URL_SAFE_SEGMENT = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/;
const PLAIN_URL_SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const ALREADY_EXISTS = /\b(?:already exists?|EEXIST|file exists?)\b/i;

function safePathSegment(value: string, label: string): string {
  if (!PLAIN_URL_SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a URL-safe path segment.`);
  }
  return value;
}

function assertSlot(slot: number): asserts slot is CacheSlot {
  if (slot !== 0 && slot !== 1) throw new Error("Cache slot must be 0 or 1.");
}

function assertRelativeCachePath(path: string): void {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
    throw new Error("Cache asset path must be relative to cache storage.");
  }

  const segments = path.split("/");
  if (segments[0] !== CITY_CACHE_STORAGE_DIRECTORY) {
    throw new Error("Cache asset path must be inside the city-cache directory.");
  }
  for (const segment of segments) {
    if (!URL_SAFE_SEGMENT.test(segment)) throw new Error("Cache asset path is not URL-safe.");
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Cache asset path contains an invalid escape sequence.");
    }
    if (!decoded || decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) {
      throw new Error("Cache asset path contains a traversal segment.");
    }
  }
}

function isAlreadyExistingDirectory(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "EEXIST") return true;
    if ("message" in error && typeof error.message === "string" && ALREADY_EXISTS.test(error.message)) return true;
    if ("error" in error && typeof error.error === "string" && ALREADY_EXISTS.test(error.error)) return true;
  }
  return typeof error === "string" && ALREADY_EXISTS.test(error);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await FilePicker.createDirectory("data", path);
  } catch (error) {
    if (!isAlreadyExistingDirectory(error)) throw error;
  }
}

export function cityCacheSlotPath(sceneId: string, slot: CacheSlot): string {
  assertSlot(slot);
  return `${CITY_CACHE_STORAGE_DIRECTORY}/${safePathSegment(sceneId, "Scene id")}/slot-${slot}`;
}

/** Ensure the bounded pair of cache slots for one Scene, returning storage-relative paths. */
export async function ensureCityCacheStorage(sceneId: string): Promise<readonly [string, string]> {
  const sceneDirectory = `${CITY_CACHE_STORAGE_DIRECTORY}/${safePathSegment(sceneId, "Scene id")}`;
  const slots = [`${sceneDirectory}/slot-0`, `${sceneDirectory}/slot-1`] as const;
  await ensureDirectory(CITY_CACHE_STORAGE_ROOT);
  await ensureDirectory(`${CITY_CACHE_STORAGE_ROOT}/${CITY_CACHE_STORAGE_DIRECTORY}`);
  await ensureDirectory(`${CITY_CACHE_STORAGE_ROOT}/${sceneDirectory}`);
  await ensureDirectory(`${CITY_CACHE_STORAGE_ROOT}/${slots[0]}`);
  await ensureDirectory(`${CITY_CACHE_STORAGE_ROOT}/${slots[1]}`);
  return slots;
}

function filePart(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return new Uint8Array(bytes).buffer;
}

/** Upload an asset into one of the two overwrite-only slots and return its storage-relative path. */
export async function uploadCacheAsset(
  sceneId: string,
  slot: CacheSlot,
  filename: string,
  bytes: Uint8Array,
  type = "application/octet-stream"
): Promise<string> {
  assertSlot(slot);
  const safeFilename = safePathSegment(filename, "Asset filename");
  const slots = await ensureCityCacheStorage(sceneId);
  const directory = slots[slot];
  const relativePath = `${directory}/${safeFilename}`;
  const expectedPath = `${CITY_CACHE_STORAGE_ROOT}/${relativePath}`;
  const file = new File([filePart(bytes)], safeFilename, { type });
  const response: unknown = await FilePicker.upload(
    "data",
    `${CITY_CACHE_STORAGE_ROOT}/${directory}`,
    file,
    {},
    { notify: false }
  );
  const uploadedPath = typeof response === "object" && response !== null && "path" in response
    ? response.path
    : undefined;
  if (uploadedPath !== expectedPath) {
    throw new Error(`Cache upload returned an unexpected path: ${String(uploadedPath)}.`);
  }
  return relativePath;
}

/** Fetch one cache asset. Callers treat any rejection as a cache miss. */
export async function fetchCacheAsset(path: string, expectedByteLength: number): Promise<Uint8Array> {
  assertRelativeCachePath(path);
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0) {
    throw new Error("Expected byte length must be a non-negative safe integer.");
  }

  const response = await fetch(`${CITY_CACHE_STORAGE_ROOT}/${path}`, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Cache asset request failed with HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expectedByteLength) {
    throw new Error(`Cache asset length mismatch: expected ${expectedByteLength}, received ${bytes.byteLength}.`);
  }
  return bytes;
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const output = new Blob([filePart(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const output = new Blob([filePart(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(output).arrayBuffer());
}
