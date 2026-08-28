import { describe, expect, it } from "vitest";
import { GENERATOR_VERSION } from "../../constants.js";
import {
  CHUNK_CACHE_FORMAT_VERSION,
  CITY_CACHE_FLAG,
  CITY_CACHE_SCHEMA_VERSION,
  PLAN_CACHE_FORMAT_VERSION,
  checksumBytes,
  decodeCityCacheManifest,
  validateCityCacheManifest,
  type CacheArtifactRef,
  type CacheChunkArtifactEntry,
  type CityCacheManifestV1
} from "./city-cache.js";

function artifact(path = "scenes/scene-a/slot-0/plan.json.gz"): CacheArtifactRef {
  return { path, byteLength: 128, checksum: "811c9dc5" };
}

function chunk(
  chunkId: string,
  path = `scenes/scene-a/slot-0/chunk-${chunkId.replace(",", "-")}.bin.gz`
): CacheChunkArtifactEntry {
  return {
    chunkId,
    ref: artifact(path),
    bounds: { x: -32, y: 64, width: 256, height: 256 },
    counts: { vertexCount: 42, triangleCount: 14 }
  };
}

function manifest(): CityCacheManifestV1 {
  return {
    kind: "project-nixie-city-cache",
    cacheSchemaVersion: CITY_CACHE_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    cityRevision: 7,
    structuralInput: { terrain: "terrain-signature", roads: "roads-signature", districts: "districts-signature", generation: "generation-signature" },
    slot: 0,
    plan: { formatVersion: PLAN_CACHE_FORMAT_VERSION, artifact: artifact() }
  };
}

function expectInvalid(value: unknown): void {
  expect(validateCityCacheManifest(value)).not.toEqual([]);
  expect(decodeCityCacheManifest(value)).toBeNull();
}

describe("city cache manifest", () => {
  it("exports the stable shared constants", () => {
    expect(CITY_CACHE_SCHEMA_VERSION).toBe(1);
    expect(PLAN_CACHE_FORMAT_VERSION).toBe(1);
    expect(CHUNK_CACHE_FORMAT_VERSION).toBe(1);
    expect(CITY_CACHE_FLAG).toBe("city-cache");
  });

  it("strictly decodes a valid V1 plan manifest into a detached value", () => {
    const raw = manifest();
    const decoded = decodeCityCacheManifest(raw);

    expect(validateCityCacheManifest(raw)).toEqual([]);
    expect(decoded).toEqual(raw);
    expect(decoded).not.toBe(raw);
    expect(decoded?.structuralInput).not.toBe(raw.structuralInput);
    expect(decoded?.plan.artifact).not.toBe(raw.plan.artifact);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a primitive", "manifest"],
    ["an unknown kind", { ...manifest(), kind: "other-cache" }],
    ["an unsupported cache schema", { ...manifest(), cacheSchemaVersion: 2 }],
    ["an unsupported generator", { ...manifest(), generatorVersion: GENERATOR_VERSION + 1 }],
    ["a non-numeric generator", { ...manifest(), generatorVersion: String(GENERATOR_VERSION) }],
    ["revision zero", { ...manifest(), cityRevision: 0 }],
    ["a fractional revision", { ...manifest(), cityRevision: 1.5 }],
    ["an unsafe revision", { ...manifest(), cityRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ["an unknown slot", { ...manifest(), slot: 2 }],
    ["a string slot", { ...manifest(), slot: "0" }],
    ["an unknown top-level key", { ...manifest(), authoritative: true }]
  ])("rejects %s", (_label, value) => {
    expectInvalid(value);
  });

  it("rejects every missing required top-level field", () => {
    for (const key of ["kind", "cacheSchemaVersion", "generatorVersion", "cityRevision", "structuralInput", "slot", "plan"] as const) {
      const value = { ...manifest() } as Record<string, unknown>;
      delete value[key];
      expectInvalid(value);
    }
  });

  it("rejects non-plain object input", () => {
    const inherited = Object.create(manifest()) as unknown;
    expectInvalid(inherited);
  });

  it("rejects malformed structural signatures", () => {
    expectInvalid({ ...manifest(), structuralInput: null });
    expectInvalid({ ...manifest(), structuralInput: [] });
    expectInvalid({ ...manifest(), structuralInput: { ...manifest().structuralInput, extra: "signature" } });

    for (const key of ["terrain", "roads", "districts", "generation"] as const) {
      const missing = { ...manifest().structuralInput } as Record<string, unknown>;
      delete missing[key];
      expectInvalid({ ...manifest(), structuralInput: missing });
      expectInvalid({ ...manifest(), structuralInput: { ...manifest().structuralInput, [key]: "   " } });
      expectInvalid({ ...manifest(), structuralInput: { ...manifest().structuralInput, [key]: 12 } });
    }
  });

  it("rejects malformed plan descriptors and unsupported plan formats", () => {
    expectInvalid({ ...manifest(), plan: null });
    expectInvalid({ ...manifest(), plan: [] });
    expectInvalid({ ...manifest(), plan: { artifact: artifact() } });
    expectInvalid({ ...manifest(), plan: { formatVersion: PLAN_CACHE_FORMAT_VERSION } });
    expectInvalid({ ...manifest(), plan: { ...manifest().plan, extra: true } });
    expectInvalid({ ...manifest(), plan: { ...manifest().plan, formatVersion: PLAN_CACHE_FORMAT_VERSION + 1 } });
  });

  it.each([
    "",
    "   ",
    "/absolute/plan.json.gz",
    "../plan.json.gz",
    "scene/../plan.json.gz",
    "scene/./plan.json.gz",
    "scene//plan.json.gz",
    "scene\\plan.json.gz",
    "https://example.invalid/plan.json.gz",
    "scene/plan.json.gz?revision=1",
    "scene/%2e%2e/plan.json.gz"
  ])("rejects unsafe artifact path %j", (path) => {
    const value = manifest();
    value.plan.artifact.path = path;
    expectInvalid(value);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "128", null])(
    "rejects artifact byte length %j",
    (byteLength) => {
      const value = manifest();
      value.plan.artifact.byteLength = byteLength as number;
      expectInvalid(value);
    }
  );

  it.each(["", "ABCDEF12", "1234567", "123456789", "zzzzzzzz", 12345678, null])(
    "rejects artifact checksum %j",
    (checksum) => {
      const value = manifest();
      value.plan.artifact.checksum = checksum as string;
      expectInvalid(value);
    }
  );

  it("rejects malformed artifact ref shapes", () => {
    expectInvalid({ ...manifest(), plan: { formatVersion: PLAN_CACHE_FORMAT_VERSION, artifact: null } });
    expectInvalid({ ...manifest(), plan: { formatVersion: PLAN_CACHE_FORMAT_VERSION, artifact: [] } });
    expectInvalid({ ...manifest(), plan: { formatVersion: PLAN_CACHE_FORMAT_VERSION, artifact: { ...artifact(), extra: true } } });
    for (const key of ["path", "byteLength", "checksum"] as const) {
      const ref = { ...artifact() } as Record<string, unknown>;
      delete ref[key];
      expectInvalid({ ...manifest(), plan: { formatVersion: PLAN_CACHE_FORMAT_VERSION, artifact: ref } });
    }
  });

  it("decodes the optional Phase 2 chunk descriptor", () => {
    const raw: CityCacheManifestV1 = {
      ...manifest(),
      slot: 1,
      chunks: {
        formatVersion: CHUNK_CACHE_FORMAT_VERSION,
        sceneGeometrySignature: "scene-geometry-v1",
        entries: [chunk("-1,0"), chunk("0,0")]
      }
    };

    const decoded = decodeCityCacheManifest(raw);
    expect(validateCityCacheManifest(raw)).toEqual([]);
    expect(decoded).toEqual(raw);
    expect(decoded?.chunks).not.toBe(raw.chunks);
    expect(decoded?.chunks?.entries).not.toBe(raw.chunks!.entries);
    expect(decoded?.chunks?.entries[0]).not.toBe(raw.chunks!.entries[0]);
    expect(decoded?.chunks?.entries[0]?.ref).not.toBe(raw.chunks!.entries[0]?.ref);
  });

  it("rejects malformed chunk descriptors and unsupported chunk formats", () => {
    expectInvalid({ ...manifest(), chunks: null });
    expectInvalid({ ...manifest(), chunks: [] });
    expectInvalid({ ...manifest(), chunks: { formatVersion: 1, sceneGeometrySignature: "geometry" } });
    expectInvalid({ ...manifest(), chunks: { formatVersion: 1, entries: [] } });
    expectInvalid({ ...manifest(), chunks: { formatVersion: 1, sceneGeometrySignature: "geometry", entries: [], extra: true } });
    expectInvalid({ ...manifest(), chunks: { formatVersion: 2, sceneGeometrySignature: "geometry", entries: [] } });
    expectInvalid({ ...manifest(), chunks: { formatVersion: 1, sceneGeometrySignature: "   ", entries: [] } });
    expectInvalid({ ...manifest(), chunks: { formatVersion: 1, sceneGeometrySignature: "geometry", entries: {} } });
  });

  it("rejects malformed chunk entry shapes and identities", () => {
    const descriptor = (entries: unknown[]) => ({ formatVersion: 1, sceneGeometrySignature: "geometry", entries });
    expectInvalid({ ...manifest(), chunks: descriptor([null]) });
    expectInvalid({ ...manifest(), chunks: descriptor([{ ...chunk("0,0"), extra: true }]) });
    expectInvalid({ ...manifest(), chunks: descriptor([{ ...chunk("0,0"), chunkId: " " }]) });

    for (const key of ["chunkId", "ref", "bounds", "counts"] as const) {
      const entry = { ...chunk("0,0") } as Record<string, unknown>;
      delete entry[key];
      expectInvalid({ ...manifest(), chunks: descriptor([entry]) });
    }

    expectInvalid({ ...manifest(), chunks: descriptor([chunk("0,0"), chunk("0,0", "scenes/scene-a/slot-0/other.bin.gz")]) });
    expectInvalid({ ...manifest(), chunks: descriptor([chunk("0,0"), chunk("1,0", chunk("0,0").ref.path)]) });
    expectInvalid({ ...manifest(), chunks: descriptor([chunk("0,0", manifest().plan.artifact.path)]) });
  });

  it("applies artifact validation to chunk refs", () => {
    const entry = chunk("0,0");
    entry.ref = { path: "../chunk.bin.gz", byteLength: 0, checksum: "not-a-sum" };
    expectInvalid({
      ...manifest(),
      chunks: { formatVersion: CHUNK_CACHE_FORMAT_VERSION, sceneGeometrySignature: "geometry", entries: [entry] }
    });
  });

  it("rejects malformed chunk bounds", () => {
    const descriptor = (bounds: unknown) => ({
      formatVersion: 1,
      sceneGeometrySignature: "geometry",
      entries: [{ ...chunk("0,0"), bounds }]
    });
    expectInvalid({ ...manifest(), chunks: descriptor(null) });
    expectInvalid({ ...manifest(), chunks: descriptor({ x: 0, y: 0, width: 1 }) });
    expectInvalid({ ...manifest(), chunks: descriptor({ x: 0, y: 0, width: 1, height: 1, z: 0 }) });
    for (const bounds of [
      { x: Infinity, y: 0, width: 1, height: 1 },
      { x: 0, y: NaN, width: 1, height: 1 },
      { x: 0, y: 0, width: -1, height: 1 },
      { x: 0, y: 0, width: 1, height: -1 },
      { x: 0, y: 0, width: "1", height: 1 }
    ]) {
      expectInvalid({ ...manifest(), chunks: descriptor(bounds) });
    }
  });

  it("rejects malformed chunk counts", () => {
    const descriptor = (counts: unknown) => ({
      formatVersion: 1,
      sceneGeometrySignature: "geometry",
      entries: [{ ...chunk("0,0"), counts }]
    });
    expectInvalid({ ...manifest(), chunks: descriptor(null) });
    expectInvalid({ ...manifest(), chunks: descriptor({ vertexCount: 1 }) });
    expectInvalid({ ...manifest(), chunks: descriptor({ vertexCount: 1, triangleCount: 1, lineCount: 0 }) });
    for (const counts of [
      { vertexCount: -1, triangleCount: 0 },
      { vertexCount: 0.5, triangleCount: 0 },
      { vertexCount: 0, triangleCount: Infinity },
      { vertexCount: 0, triangleCount: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expectInvalid({ ...manifest(), chunks: descriptor(counts) });
    }
  });

  it("treats unreadable input as a cache miss instead of throwing", () => {
    const unreadable = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("corrupt proxy");
      }
    });

    expect(validateCityCacheManifest(unreadable)).toEqual(["City cache manifest could not be inspected."]);
    expect(decodeCityCacheManifest(unreadable)).toBeNull();
  });
});

describe("checksumBytes", () => {
  it("matches stable FNV-1a byte vectors", () => {
    expect(checksumBytes(new Uint8Array())).toBe("811c9dc5");
    expect(checksumBytes(new TextEncoder().encode("foobar"))).toBe("bf9cf968");
    expect(checksumBytes(new Uint8Array([0, 255, 1, 128]))).toBe("5d866489");
  });

  it("is deterministic, byte-sensitive, and respects Uint8Array views", () => {
    const bytes = new Uint8Array([99, 0, 255, 1, 128, 77]);
    const view = bytes.subarray(1, 5);
    const first = checksumBytes(view);

    expect(checksumBytes(view)).toBe(first);
    expect(first).toBe(checksumBytes(new Uint8Array([0, 255, 1, 128])));
    expect(checksumBytes(new Uint8Array([0, 255, 1, 129]))).not.toBe(first);
  });
});
