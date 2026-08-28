import { describe, expect, it } from "vitest";
import { CHUNK_CACHE_FORMAT_VERSION } from "./city-cache.js";
import {
  CompleteCityChunkCacheArtifactError,
  decodeCompleteCityChunk,
  encodeCompleteCityChunk,
  type CachedCompleteChunkRecord
} from "./complete-city-chunk-cache.js";
import type { MeshBuffers } from "../geom/mesh.js";

const HEADER_BYTES = 36;

function triangleMesh(seed: number): MeshBuffers {
  const vertices = new Float32Array(33);
  for (let i = 0; i < vertices.length; i++) vertices[i] = seed + i / 4;
  return {
    vertices,
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1
  };
}

function record(): CachedCompleteChunkRecord {
  const mesh = triangleMesh(1);
  const detail = triangleMesh(20);
  const neon = triangleMesh(40);
  return {
    id: "chunk-東京",
    mesh,
    detail,
    neon,
    boundsM: { x: -32.5, y: 16.25, width: 80, height: 96 },
    boundsPx: { x: 125.5, y: -400, width: 1600, height: 1920 },
    landTriangleCount: 11,
    waterTriangleCount: 12,
    markingTriangleCount: 13,
    openSpaceTriangleCount: 14,
    buildingCount: 15,
    landmarkCount: 16,
    openSpaceCount: 17,
    bytes: mesh.vertices.byteLength + mesh.indices.byteLength +
      detail.vertices.byteLength + detail.indices.byteLength +
      neon.vertices.byteLength + neon.indices.byteLength
  };
}

function expectArtifactError(action: () => unknown): void {
  expect(action).toThrow(CompleteCityChunkCacheArtifactError);
  expect(action).toThrow(/^Invalid complete-city chunk cache artifact:/);
}

function metadataFrom(bytes: Uint8Array): Record<string, unknown> {
  const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const length = header.getUint32(8, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length))) as Record<string, unknown>;
}

function replaceMetadata(bytes: Uint8Array, metadata: unknown): Uint8Array {
  const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const oldLength = header.getUint32(8, true);
  const oldStorageLength = Math.ceil(oldLength / 4) * 4;
  const raw = bytes.subarray(HEADER_BYTES + oldStorageLength);
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const storageLength = Math.ceil(encoded.length / 4) * 4;
  const replacement = new Uint8Array(HEADER_BYTES + storageLength + raw.length);
  replacement.set(bytes.subarray(0, HEADER_BYTES));
  new DataView(replacement.buffer).setUint32(8, encoded.length, true);
  replacement.set(encoded, HEADER_BYTES);
  replacement.set(raw, HEADER_BYTES + storageLength);
  return replacement;
}

function allBuffers(decoded: CachedCompleteChunkRecord): ArrayBufferLike[] {
  return [
    decoded.mesh.vertices.buffer,
    decoded.mesh.indices.buffer,
    decoded.detail.vertices.buffer,
    decoded.detail.indices.buffer,
    decoded.neon.vertices.buffer,
    decoded.neon.indices.buffer
  ];
}

describe("complete city chunk cache codec", () => {
  it("round-trips all meshes and metadata through one retained artifact buffer", () => {
    const source = record();
    const encoded = encodeCompleteCityChunk(source);
    const decoded = decodeCompleteCityChunk(encoded);

    expect(decoded).toEqual(source);
    expect(Array.from(decoded.mesh.vertices)).toEqual(Array.from(source.mesh.vertices));
    expect(Array.from(decoded.mesh.indices)).toEqual(Array.from(source.mesh.indices));
    expect(Array.from(decoded.detail.vertices)).toEqual(Array.from(source.detail.vertices));
    expect(Array.from(decoded.detail.indices)).toEqual(Array.from(source.detail.indices));
    expect(Array.from(decoded.neon.vertices)).toEqual(Array.from(source.neon.vertices));
    expect(Array.from(decoded.neon.indices)).toEqual(Array.from(source.neon.indices));
    expect(new Set(allBuffers(decoded))).toEqual(new Set([encoded.buffer]));
  });

  it("round-trips empty meshes and normalizes absent optional tiers to empty meshes", () => {
    const empty: MeshBuffers = {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      vertexCount: 0,
      triangleCount: 0
    };
    const allEmpty: CachedCompleteChunkRecord = {
      ...record(),
      mesh: empty,
      detail: empty,
      neon: empty,
      bytes: 0
    };
    expect(decodeCompleteCityChunk(encodeCompleteCityChunk(allEmpty))).toEqual(allEmpty);

    const withAbsentTiers = {
      ...record(),
      detail: null,
      neon: undefined,
      bytes: record().mesh.vertices.byteLength + record().mesh.indices.byteLength
    } as unknown as CachedCompleteChunkRecord;
    const decoded = decodeCompleteCityChunk(encodeCompleteCityChunk(withAbsentTiers));
    expect(decoded.detail).toEqual(empty);
    expect(decoded.neon).toEqual(empty);
  });

  it("uses the reserved chunk format version in the little-endian header", () => {
    const encoded = encodeCompleteCityChunk(record());
    const header = new DataView(encoded.buffer, encoded.byteOffset, HEADER_BYTES);
    expect(Array.from(encoded.subarray(0, 4))).toEqual([0x4e, 0x58, 0x43, 0x43]);
    expect(header.getUint32(4, true)).toBe(CHUNK_CACHE_FORMAT_VERSION);
  });

  it("safely decodes a non-zero, unaligned Uint8Array view with one normalized backing buffer", () => {
    const encoded = encodeCompleteCityChunk(record());
    const container = new Uint8Array(encoded.length + 2);
    container.set(encoded, 1);
    const decoded = decodeCompleteCityChunk(container.subarray(1, 1 + encoded.length));
    const buffers = allBuffers(decoded);

    expect(decoded).toEqual(record());
    expect(new Set(buffers).size).toBe(1);
    expect(buffers[0]).not.toBe(container.buffer);
  });

  it("rejects bad magic and unsupported versions", () => {
    const badMagic = encodeCompleteCityChunk(record());
    badMagic[0] = badMagic[0]! ^ 0xff;
    expectArtifactError(() => decodeCompleteCityChunk(badMagic));

    const badVersion = encodeCompleteCityChunk(record());
    new DataView(badVersion.buffer).setUint32(4, CHUNK_CACHE_FORMAT_VERSION + 1, true);
    expectArtifactError(() => decodeCompleteCityChunk(badVersion));
  });

  it("rejects fatal metadata UTF-8 and malformed JSON", () => {
    const badUtf8 = encodeCompleteCityChunk(record());
    badUtf8[HEADER_BYTES] = 0xc3;
    badUtf8[HEADER_BYTES + 1] = 0x28;
    expectArtifactError(() => decodeCompleteCityChunk(badUtf8));

    const badJson = encodeCompleteCityChunk(record());
    badJson[HEADER_BYTES] = 0x21;
    expectArtifactError(() => decodeCompleteCityChunk(badJson));
  });

  it("rejects header, metadata, and payload truncation plus trailing bytes", () => {
    const encoded = encodeCompleteCityChunk(record());
    expectArtifactError(() => decodeCompleteCityChunk(encoded.subarray(0, HEADER_BYTES - 1)));
    expectArtifactError(() => decodeCompleteCityChunk(encoded.subarray(0, HEADER_BYTES + 4)));
    expectArtifactError(() => decodeCompleteCityChunk(encoded.subarray(0, encoded.length - 1)));

    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);
    expectArtifactError(() => decodeCompleteCityChunk(trailing));
  });

  it("rejects overflowing and unaligned raw buffer lengths", () => {
    const overflow = encodeCompleteCityChunk(record());
    const overflowHeader = new DataView(overflow.buffer);
    for (let i = 0; i < 6; i++) overflowHeader.setUint32(12 + i * 4, 0xffff_fffc, true);
    expectArtifactError(() => decodeCompleteCityChunk(overflow));

    const unaligned = encodeCompleteCityChunk(record());
    new DataView(unaligned.buffer).setUint32(12, 131, true);
    expectArtifactError(() => decodeCompleteCityChunk(unaligned));
  });

  it("rejects vertices outside the 11-float layout and non-triangle indices", () => {
    const badVertices = encodeCompleteCityChunk(record());
    const vertexHeader = new DataView(badVertices.buffer);
    vertexHeader.setUint32(12, 128, true);
    vertexHeader.setUint32(16, 16, true);
    expectArtifactError(() => decodeCompleteCityChunk(badVertices));

    const badIndices = encodeCompleteCityChunk(record());
    const indexHeader = new DataView(badIndices.buffer);
    indexHeader.setUint32(16, 8, true);
    indexHeader.setUint32(20, 136, true);
    expectArtifactError(() => decodeCompleteCityChunk(badIndices));
  });

  it("rejects declared mesh counts that disagree with raw buffers", () => {
    const encoded = encodeCompleteCityChunk(record());
    const metadata = metadataFrom(encoded);
    metadata.mesh = { ...(metadata.mesh as Record<string, unknown>), vertexCount: 4 };
    expectArtifactError(() => decodeCompleteCityChunk(replaceMetadata(encoded, metadata)));
  });

  it.each([
    ["empty id", (metadata: Record<string, unknown>) => { metadata.id = ""; }],
    ["invalid metre bounds", (metadata: Record<string, unknown>) => {
      metadata.boundsM = { x: 0, y: 0, width: -1, height: 1 };
    }],
    ["invalid pixel bounds", (metadata: Record<string, unknown>) => {
      metadata.boundsPx = { x: 0, y: "bad", width: 1, height: 1 };
    }],
    ["negative triangle count", (metadata: Record<string, unknown>) => { metadata.waterTriangleCount = -1; }],
    ["fractional object count", (metadata: Record<string, unknown>) => { metadata.buildingCount = 1.5; }],
    ["wrong raw byte count", (metadata: Record<string, unknown>) => { metadata.bytes = 0; }]
  ])("rejects invalid metadata: %s", (_description, mutate) => {
    const encoded = encodeCompleteCityChunk(record());
    const metadata = metadataFrom(encoded);
    mutate(metadata);
    expectArtifactError(() => decodeCompleteCityChunk(replaceMetadata(encoded, metadata)));
  });
});
