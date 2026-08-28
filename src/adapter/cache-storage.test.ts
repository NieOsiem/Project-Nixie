import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CITY_CACHE_STORAGE_ROOT,
  cityCacheSlotPath,
  ensureCityCacheStorage,
  fetchCacheAsset,
  gunzipBytes,
  gzipBytes,
  uploadCacheAsset
} from "./cache-storage.js";

const createDirectory = vi.fn();
const upload = vi.fn();

beforeEach(() => {
  createDirectory.mockReset();
  createDirectory.mockResolvedValue({});
  upload.mockReset();
  vi.stubGlobal("FilePicker", { createDirectory, upload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("city cache storage paths", () => {
  it("creates the top-level root, nested Scene storage, and both bounded slots in parent-first order", async () => {
    expect(CITY_CACHE_STORAGE_ROOT).toBe("project-nixie-cache");
    await expect(ensureCityCacheStorage("scene-1")).resolves.toEqual([
      "city-cache/scene-1/slot-0",
      "city-cache/scene-1/slot-1"
    ]);
    expect(createDirectory.mock.calls).toEqual([
      ["data", "project-nixie-cache"],
      ["data", "project-nixie-cache/city-cache"],
      ["data", "project-nixie-cache/city-cache/scene-1"],
      ["data", "project-nixie-cache/city-cache/scene-1/slot-0"],
      ["data", "project-nixie-cache/city-cache/scene-1/slot-1"]
    ]);
  });

  it("continues after an already-existing root but rejects other directory failures", async () => {
    createDirectory
      .mockRejectedValueOnce(new Error("EEXIST: directory already exists"))
      .mockResolvedValue({});
    await expect(ensureCityCacheStorage("scene-1")).resolves.toEqual([
      "city-cache/scene-1/slot-0",
      "city-cache/scene-1/slot-1"
    ]);
    expect(createDirectory.mock.calls).toEqual([
      ["data", "project-nixie-cache"],
      ["data", "project-nixie-cache/city-cache"],
      ["data", "project-nixie-cache/city-cache/scene-1"],
      ["data", "project-nixie-cache/city-cache/scene-1/slot-0"],
      ["data", "project-nixie-cache/city-cache/scene-1/slot-1"]
    ]);

    createDirectory.mockReset();
    createDirectory.mockRejectedValue(new Error("Permission denied"));
    await expect(ensureCityCacheStorage("scene-1")).rejects.toThrow("Permission denied");
    expect(createDirectory).toHaveBeenCalledTimes(1);
  });

  it("rejects traversal in Scene ids and asset paths before accessing Foundry or fetch", async () => {
    expect(() => cityCacheSlotPath("../outside", 0)).toThrow(/path segment/);
    expect(() => cityCacheSlotPath("Scene One", 0)).toThrow(/URL-safe/);
    await expect(uploadCacheAsset("scene-1", 0, "../plan.json.gz", new Uint8Array())).rejects.toThrow(/path segment/);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchCacheAsset("city-cache/%2e%2e/plan.json.gz", 0)).rejects.toThrow(/traversal/);
    await expect(fetchCacheAsset("../city-cache/plan.json.gz", 0)).rejects.toThrow();
    expect(createDirectory).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cache asset upload", () => {
  it("uploads a File through generic Data storage and returns a URL-safe relative path", async () => {
    const expected = "city-cache/scene-1/slot-1/plan-data.json.gz";
    upload.mockResolvedValue({ path: `project-nixie-cache/${expected}` });

    await expect(uploadCacheAsset(
      "scene-1",
      1,
      "plan-data.json.gz",
      Uint8Array.of(3, 1, 4),
      "application/gzip"
    )).resolves.toBe(expected);

    expect(upload).toHaveBeenCalledTimes(1);
    const [source, directory, file, body, options] = upload.mock.calls[0]!;
    expect(source).toBe("data");
    expect(directory).toBe("project-nixie-cache/city-cache/scene-1/slot-1");
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: "plan-data.json.gz", type: "application/gzip", size: 3 });
    expect(body).toEqual({});
    expect(options).toEqual({ notify: false });
    await expect(file.arrayBuffer()).resolves.toEqual(Uint8Array.of(3, 1, 4).buffer);
  });

  it("propagates upload failures and rejects malformed or mismatched returned paths", async () => {
    upload.mockRejectedValueOnce(new Error("Upload denied"));
    await expect(uploadCacheAsset("scene-1", 0, "plan.gz", Uint8Array.of(1))).rejects.toThrow("Upload denied");

    upload.mockResolvedValueOnce({});
    await expect(uploadCacheAsset("scene-1", 0, "plan.gz", Uint8Array.of(1))).rejects.toThrow(/unexpected path/);
    upload.mockResolvedValueOnce({ path: "modules/project-nixie/storage/city-cache/scene-1/slot-0/plan.gz" });
    await expect(uploadCacheAsset("scene-1", 0, "plan.gz", Uint8Array.of(1))).rejects.toThrow(/unexpected path/);

    upload.mockResolvedValueOnce({ path: "project-nixie-cache/city-cache/other/slot-0/plan.gz" });
    await expect(uploadCacheAsset("scene-1", 0, "plan.gz", Uint8Array.of(1))).rejects.toThrow(/unexpected path/);
  });
});

describe("cache asset fetch", () => {
  it("fetches with same-origin credentials and enforces the declared byte length", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.of(8, 9, 10).buffer
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCacheAsset("city-cache/scene-1/slot-0/plan.gz", 3)).resolves.toEqual(Uint8Array.of(8, 9, 10));
    expect(fetchMock).toHaveBeenCalledWith(
      "project-nixie-cache/city-cache/scene-1/slot-0/plan.gz",
      { credentials: "same-origin" }
    );

    await expect(fetchCacheAsset("city-cache/scene-1/slot-0/plan.gz", 2)).rejects.toThrow(/length mismatch/);
  });

  it("rejects unsuccessful HTTP responses without reading their bodies", async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, arrayBuffer }));
    await expect(fetchCacheAsset("city-cache/scene-1/slot-0/missing.gz", 0)).rejects.toThrow(/HTTP 404/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("gzip byte helpers", () => {
  it("round-trips arbitrary bytes through browser compression streams", async () => {
    const input = new TextEncoder().encode("Project Nixie city cache \0 with unicode: 雨");
    const compressed = await gzipBytes(input);
    expect(compressed.byteLength).toBeGreaterThan(0);
    await expect(gunzipBytes(compressed)).resolves.toEqual(input);
  });
});
