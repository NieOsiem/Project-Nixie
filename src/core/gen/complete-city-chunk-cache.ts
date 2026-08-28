import { CHUNK_CACHE_FORMAT_VERSION } from "./city-cache.js";
import { VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import type { Rect } from "../geom/types.js";

const MAGIC = new Uint8Array([0x4e, 0x58, 0x43, 0x43]); // "NXCC"
const HEADER_BYTES = 36;
const ARRAY_COUNT = 6;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ARTIFACT_ERROR_PREFIX = "Invalid complete-city chunk cache artifact";

/** A corrupt or incompatible cached complete-city chunk. Callers must treat it as a cache miss. */
export class CompleteCityChunkCacheArtifactError extends Error {
  constructor(detail: string) {
    super(`${ARTIFACT_ERROR_PREFIX}: ${detail}`);
    this.name = "CompleteCityChunkCacheArtifactError";
  }
}

export interface CachedCompleteChunkRecord {
  id: string;
  mesh: MeshBuffers;
  detail: MeshBuffers;
  neon: MeshBuffers;
  boundsM: Rect;
  boundsPx: Rect;
  landTriangleCount: number;
  waterTriangleCount: number;
  markingTriangleCount: number;
  openSpaceTriangleCount: number;
  buildingCount: number;
  landmarkCount: number;
  openSpaceCount: number;
  /** Total bytes occupied by the six raw typed-array buffers. */
  bytes: number;
}

interface MeshMetadata {
  vertexCount: number;
  triangleCount: number;
}

interface ChunkMetadata {
  id: string;
  mesh: MeshMetadata;
  detail: MeshMetadata;
  neon: MeshMetadata;
  boundsM: Rect;
  boundsPx: Rect;
  landTriangleCount: number;
  waterTriangleCount: number;
  markingTriangleCount: number;
  openSpaceTriangleCount: number;
  buildingCount: number;
  landmarkCount: number;
  openSpaceCount: number;
  bytes: number;
}

const EMPTY_MESH: MeshBuffers = {
  vertices: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0
};

function invalid(detail: string): never {
  throw new CompleteCityChunkCacheArtifactError(detail);
}


function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateRect(value: unknown, field: string): asserts value is Rect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} is not a rectangle`);
  }
  const rectangle = value as Record<string, unknown>;
  if (!hasExactKeys(rectangle, ["x", "y", "width", "height"])) {
    invalid(`${field} is not a rectangle`);
  }
  const { x, y, width, height } = rectangle;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))) {
    invalid(`${field} must contain finite numbers`);
  }
  if ((width as number) < 0 || (height as number) < 0) {
    invalid(`${field} dimensions must not be negative`);
  }
}

function validateMesh(value: unknown, field: string): asserts value is MeshBuffers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} is not a mesh`);
  }
  const mesh = value as Record<string, unknown>;
  if (!(mesh.vertices instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
    invalid(`${field} buffers have the wrong typed-array kinds`);
  }
  if (!isCount(mesh.vertexCount) || !isCount(mesh.triangleCount)) {
    invalid(`${field} counts must be non-negative safe integers`);
  }
  if (mesh.vertices.length % VERTEX_FLOATS !== 0) {
    invalid(`${field} vertices do not use the ${VERTEX_FLOATS}-float vertex layout`);
  }
  if (mesh.indices.length % 3 !== 0) invalid(`${field} indices do not form triangles`);
  if (mesh.vertexCount !== mesh.vertices.length / VERTEX_FLOATS) {
    invalid(`${field} vertex count does not match its buffer`);
  }
  if (mesh.triangleCount !== mesh.indices.length / 3) {
    invalid(`${field} triangle count does not match its buffer`);
  }
}

const METADATA_KEYS = [
  "id",
  "mesh",
  "detail",
  "neon",
  "boundsM",
  "boundsPx",
  "landTriangleCount",
  "waterTriangleCount",
  "markingTriangleCount",
  "openSpaceTriangleCount",
  "buildingCount",
  "landmarkCount",
  "openSpaceCount",
  "bytes"
] as const;
const MESH_METADATA_KEYS = ["vertexCount", "triangleCount"] as const;
const RECORD_COUNT_KEYS = [
  "landTriangleCount",
  "waterTriangleCount",
  "markingTriangleCount",
  "openSpaceTriangleCount",
  "buildingCount",
  "landmarkCount",
  "openSpaceCount",
  "bytes"
] as const;

function validateMetadata(value: unknown): asserts value is ChunkMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("metadata shape is invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (!hasExactKeys(metadata, METADATA_KEYS)) invalid("metadata shape is invalid");
  if (typeof metadata.id !== "string" || metadata.id.trim().length === 0) {
    invalid("metadata id must be non-empty text");
  }
  validateRect(metadata.boundsM, "metadata boundsM");
  validateRect(metadata.boundsPx, "metadata boundsPx");

  for (const name of ["mesh", "detail", "neon"] as const) {
    const candidate = metadata[name];
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      invalid(`metadata ${name} counts are invalid`);
    }
    const mesh = candidate as Record<string, unknown>;
    if (!hasExactKeys(mesh, MESH_METADATA_KEYS) ||
      !isCount(mesh.vertexCount) || !isCount(mesh.triangleCount)) {
      invalid(`metadata ${name} counts are invalid`);
    }
  }
  for (const name of RECORD_COUNT_KEYS) {
    if (!isCount(metadata[name])) invalid(`metadata ${name} must be a non-negative safe integer`);
  }
}

function normalizedMesh(value: MeshBuffers | null | undefined, field: string): MeshBuffers {
  const mesh = value ?? EMPTY_MESH;
  validateMesh(mesh, field);
  return mesh;
}

function rawBufferBytes(meshes: readonly MeshBuffers[]): number {
  return meshes.reduce((sum, mesh) => sum + mesh.vertices.byteLength + mesh.indices.byteLength, 0);
}

function paddedLength(length: number): number {
  return Math.ceil(length / 4) * 4;
}

function copyTypedArray(target: Uint8Array, offset: number, source: Float32Array | Uint32Array): number {
  target.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength), offset);
  return offset + source.byteLength;
}

/** Encode one renderer-ready complete-city chunk as a strict, little-endian binary artifact. */
export function encodeCompleteCityChunk(record: CachedCompleteChunkRecord): Uint8Array {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    invalid("record is not an object");
  }
  if (typeof record.id !== "string" || record.id.trim().length === 0) invalid("record id must be non-empty text");

  const mesh = normalizedMesh(record.mesh, "mesh");
  // Runtime normalization keeps older nullable renderer records safe at this boundary.
  const detail = normalizedMesh(record.detail, "detail");
  const neon = normalizedMesh(record.neon, "neon");
  validateRect(record.boundsM, "boundsM");
  validateRect(record.boundsPx, "boundsPx");
  for (const name of RECORD_COUNT_KEYS.slice(0, -1)) {
    if (!isCount(record[name])) invalid(`${name} must be a non-negative safe integer`);
  }

  const meshes = [mesh, detail, neon] as const;
  const bytes = rawBufferBytes(meshes);
  if (!isCount(record.bytes) || record.bytes !== bytes) invalid("bytes does not match the six raw buffers");

  const metadata: ChunkMetadata = {
    id: record.id,
    mesh: { vertexCount: mesh.vertexCount, triangleCount: mesh.triangleCount },
    detail: { vertexCount: detail.vertexCount, triangleCount: detail.triangleCount },
    neon: { vertexCount: neon.vertexCount, triangleCount: neon.triangleCount },
    boundsM: record.boundsM,
    boundsPx: record.boundsPx,
    landTriangleCount: record.landTriangleCount,
    waterTriangleCount: record.waterTriangleCount,
    markingTriangleCount: record.markingTriangleCount,
    openSpaceTriangleCount: record.openSpaceTriangleCount,
    buildingCount: record.buildingCount,
    landmarkCount: record.landmarkCount,
    openSpaceCount: record.openSpaceCount,
    bytes
  };

  let metadataBytes: Uint8Array;
  try {
    metadataBytes = UTF8_ENCODER.encode(JSON.stringify(metadata));
  } catch {
    invalid("metadata could not be encoded");
  }
  if (metadataBytes.byteLength > 0xffff_ffff) invalid("metadata is too large");

  const arrayLengths = [
    mesh.vertices.byteLength,
    mesh.indices.byteLength,
    detail.vertices.byteLength,
    detail.indices.byteLength,
    neon.vertices.byteLength,
    neon.indices.byteLength
  ];
  if (arrayLengths.some((length) => length > 0xffff_ffff)) invalid("a raw buffer is too large");

  const metadataStorageBytes = paddedLength(metadataBytes.byteLength);
  const artifactLength = HEADER_BYTES + metadataStorageBytes + bytes;
  if (!Number.isSafeInteger(artifactLength)) invalid("artifact length overflow");

  let artifact: Uint8Array;
  try {
    artifact = new Uint8Array(artifactLength);
  } catch {
    invalid("artifact is too large");
  }
  artifact.set(MAGIC, 0);
  const header = new DataView(artifact.buffer);
  header.setUint32(4, CHUNK_CACHE_FORMAT_VERSION, true);
  header.setUint32(8, metadataBytes.byteLength, true);
  for (let i = 0; i < ARRAY_COUNT; i++) header.setUint32(12 + i * 4, arrayLengths[i]!, true);
  artifact.set(metadataBytes, HEADER_BYTES);

  let offset = HEADER_BYTES + metadataStorageBytes;
  offset = copyTypedArray(artifact, offset, mesh.vertices);
  offset = copyTypedArray(artifact, offset, mesh.indices);
  offset = copyTypedArray(artifact, offset, detail.vertices);
  offset = copyTypedArray(artifact, offset, detail.indices);
  offset = copyTypedArray(artifact, offset, neon.vertices);
  copyTypedArray(artifact, offset, neon.indices);
  return artifact;
}

function normalizeArtifact(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) invalid("input is not a Uint8Array");
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset % 4 === 0) return bytes;
  // One whole-artifact copy is required when typed-array view alignment cannot be proven.
  return bytes.slice();
}

/** Decode one complete-city chunk, retaining one artifact buffer behind all six typed-array views. */
export function decodeCompleteCityChunk(bytes: Uint8Array): CachedCompleteChunkRecord {
  const artifact = normalizeArtifact(bytes);
  if (artifact.byteLength < HEADER_BYTES) invalid("header is truncated");
  for (let i = 0; i < MAGIC.length; i++) {
    if (artifact[i] !== MAGIC[i]) invalid("magic does not match");
  }

  const header = new DataView(artifact.buffer, artifact.byteOffset, HEADER_BYTES);
  const version = header.getUint32(4, true);
  if (version !== CHUNK_CACHE_FORMAT_VERSION) invalid(`unsupported format version ${version}`);

  const metadataLength = header.getUint32(8, true);
  const metadataStorageBytes = paddedLength(metadataLength);
  const arrayLengths = Array.from({ length: ARRAY_COUNT }, (_, i) => header.getUint32(12 + i * 4, true));
  if (arrayLengths.some((length) => length % 4 !== 0)) invalid("raw buffer length is not 4-byte aligned");

  const rawBytes = arrayLengths.reduce((sum, length) => sum + length, 0);
  const expectedLength = HEADER_BYTES + metadataStorageBytes + rawBytes;
  if (!Number.isSafeInteger(expectedLength)) invalid("artifact length overflow");
  if (expectedLength > artifact.byteLength) invalid("artifact is truncated");
  if (expectedLength < artifact.byteLength) invalid("artifact has trailing bytes");

  const metadataEnd = HEADER_BYTES + metadataLength;
  for (let i = metadataEnd; i < HEADER_BYTES + metadataStorageBytes; i++) {
    if (artifact[i] !== 0) invalid("metadata padding is not zero");
  }

  let metadataText: string;
  try {
    metadataText = UTF8_DECODER.decode(artifact.subarray(HEADER_BYTES, metadataEnd));
  } catch {
    invalid("metadata is not valid UTF-8");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText) as unknown;
  } catch {
    invalid("metadata is not valid JSON");
  }
  validateMetadata(metadata);

  const floatLengths = [arrayLengths[0]!, arrayLengths[2]!, arrayLengths[4]!];
  const indexLengths = [arrayLengths[1]!, arrayLengths[3]!, arrayLengths[5]!];
  for (let i = 0; i < 3; i++) {
    if (floatLengths[i]! / 4 % VERTEX_FLOATS !== 0) {
      invalid(`${["mesh", "detail", "neon"][i]} vertices do not use the ${VERTEX_FLOATS}-float vertex layout`);
    }
    if (indexLengths[i]! / 4 % 3 !== 0) {
      invalid(`${["mesh", "detail", "neon"][i]} indices do not form triangles`);
    }
  }
  if (metadata.bytes !== rawBytes) invalid("metadata bytes does not match the six raw buffers");

  const meshMetadata = [metadata.mesh, metadata.detail, metadata.neon];
  for (let i = 0; i < 3; i++) {
    if (meshMetadata[i]!.vertexCount !== floatLengths[i]! / (4 * VERTEX_FLOATS) ||
      meshMetadata[i]!.triangleCount !== indexLengths[i]! / 12) {
      invalid(`${["mesh", "detail", "neon"][i]} declared counts do not match its buffers`);
    }
  }

  const backing = artifact.buffer as ArrayBuffer;
  let offset = artifact.byteOffset + HEADER_BYTES + metadataStorageBytes;
  const decodedMeshes: MeshBuffers[] = [];
  for (let i = 0; i < 3; i++) {
    const vertices = new Float32Array(backing, offset, floatLengths[i]! / 4);
    offset += floatLengths[i]!;
    const indices = new Uint32Array(backing, offset, indexLengths[i]! / 4);
    offset += indexLengths[i]!;
    decodedMeshes.push({
      vertices,
      indices,
      vertexCount: meshMetadata[i]!.vertexCount,
      triangleCount: meshMetadata[i]!.triangleCount
    });
  }

  return {
    id: metadata.id,
    mesh: decodedMeshes[0]!,
    detail: decodedMeshes[1]!,
    neon: decodedMeshes[2]!,
    boundsM: metadata.boundsM,
    boundsPx: metadata.boundsPx,
    landTriangleCount: metadata.landTriangleCount,
    waterTriangleCount: metadata.waterTriangleCount,
    markingTriangleCount: metadata.markingTriangleCount,
    openSpaceTriangleCount: metadata.openSpaceTriangleCount,
    buildingCount: metadata.buildingCount,
    landmarkCount: metadata.landmarkCount,
    openSpaceCount: metadata.openSpaceCount,
    bytes: metadata.bytes
  };
}
