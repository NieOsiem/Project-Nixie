import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_SCHEMA_VERSION, FLAG_CITY, GENERATOR_VERSION, MODULE_ID } from "../constants.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CityStateV3 } from "../core/gen/city.js";
import { CITY_CACHE_FLAG } from "../core/gen/city-cache.js";
import { rectangleLand } from "../core/gen/terrain.js";
import { loadCityState, replaceGeneratedWalls, saveCityState } from "./documents.js";

let stored: unknown;
let cacheStored: unknown;
let setFlag: ReturnType<typeof vi.fn>;
let unsetFlag: ReturnType<typeof vi.fn>;

function installScene(flag: unknown, cache: unknown = undefined): void {
  stored = flag;
  cacheStored = cache;
  setFlag = vi.fn(async (module: string, key: string, value: unknown) => {
    if (module !== MODULE_ID) return;
    if (key === FLAG_CITY) stored = value;
    else if (key === CITY_CACHE_FLAG) cacheStored = value;
  });
  unsetFlag = vi.fn(async (module: string, key: string) => {
    if (module !== MODULE_ID) return;
    if (key === FLAG_CITY) stored = undefined;
    else if (key === CITY_CACHE_FLAG) cacheStored = undefined;
  });
  vi.stubGlobal("canvas", {
    scene: {
      getFlag: (module: string, key: string) => {
        if (module !== MODULE_ID) return undefined;
        if (key === FLAG_CITY) return stored;
        if (key === CITY_CACHE_FLAG) return cacheStored;
        return undefined;
      },
      setFlag,
      unsetFlag
    }
  });
  vi.stubGlobal("game", { user: { isGM: true } });
}

function schema2(revision = 3): Record<string, unknown> {
  return {
    kind: "city-generator-2",
    schemaVersion: 2,
    generatorVersion: 9,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "documents-phase3",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
      terrain: { land: rectangleLand({ x: -100, y: -80, width: 200, height: 160 }), urbanFootprint: null },
      roads: { nodes: [], routes: [], edges: [] }
    }
  };
}

function schema3(revision = 1): CityStateV3 {
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "documents-phase3",
      generation: {
        terrainMode: "rectangle",
        coastEdge: null,
        roadLayout: "european",
        hubMode: "single-centre",
        districtPool: [...DISTRICT_TYPE_IDS],
        openSpaceProfile: "medium"
      },
      terrain: { land: rectangleLand({ x: -100, y: -80, width: 200, height: 160 }), urbanFootprint: null },
      roads: { nodes: [], routes: [], edges: [] },
      districts: []
    }
  };
}

function validDistrict(): CityStateV3["source"]["districts"][number] {
  return {
    id: "d-matrix",
    polygon: [{ x: -90, y: -70 }, { x: -10, y: -70 }, { x: -10, y: 70 }, { x: -90, y: 70 }],
    seed: "district-seed",
    typeId: "corporate-core",
    paletteId: "corporate",
    origin: "authored",
    locked: false,
    openSpaceOverride: {
      rate: 0.2,
      categoryWeights: { park: 1, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
      sizeWeights: { pocket: 1, small: 0, large: 0, "whole-block": 0 }
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 3 Scene persistence", () => {
  it("classifies schema 2 / generator 9 as obsolete-precomplete without an open-time write", () => {
    const raw = schema2(7);
    installScene(raw);
    const result = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "obsolete-precomplete",
      raw,
      schemaVersion: 2,
      generatorVersion: 9,
      revision: 7
    });
  });

  it("refuses a schema-3 save over an obsolete schema-2 flag and leaves it untouched", async () => {
    const raw = schema2(4);
    installScene(raw);
    await expect(saveCityState(schema3(5), 4)).rejects.toThrow(/revision/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(raw);
    expect(raw.schemaVersion).toBe(2);
    expect(raw.generatorVersion).toBe(9);
  });

  it("preserves the plan cache across an ordinary schema-3 save", async () => {
    const current = schema3(4);
    const cache = { slot: 1 };
    installScene(current, cache);
    const candidate = schema3(5);
    await expect(saveCityState(candidate, 4)).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledOnce();
    expect(setFlag).toHaveBeenCalledWith(MODULE_ID, FLAG_CITY, candidate);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toEqual(candidate);
    expect(cacheStored).toBe(cache);
  });

  it("round-trips district source fields without persisting derived objects", () => {
    const state = schema3();
    state.source.generation.openSpaceProfile = "none";
    state.source.districts = [{
      id: "d-authored",
      polygon: [{ x: -90, y: -70 }, { x: -10, y: -70 }, { x: -10, y: 70 }, { x: -90, y: 70 }],
      seed: "district-seed",
      typeId: "corporate-core",
      paletteId: "corporate",
      origin: "authored",
      locked: true,
      openSpaceOverride: {
        rate: 0.2,
        categoryWeights: { park: 1, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
        sizeWeights: { pocket: 1, small: 0, large: 0, "whole-block": 0 }
      }
    }];
    installScene(state);
    const result = loadCityState();
    expect(result).toEqual({ kind: "supported", state, raw: state });
    expect(Object.keys(state.source)).not.toEqual(expect.arrayContaining(["blocks", "developmentCells", "openSpaceIntents", "wallCells"]));
  });

  it("rejects non-normalized open-space tables in current schema data", () => {
    const state = schema3();
    state.source.districts = [{
      id: "d-nonnormalized",
      polygon: [{ x: -90, y: -70 }, { x: -10, y: -70 }, { x: -10, y: 70 }, { x: -90, y: 70 }],
      seed: "district-seed",
      typeId: "corporate-core",
      paletteId: "corporate",
      origin: "authored",
      locked: false,
      openSpaceOverride: {
        rate: 0.2,
        categoryWeights: { park: 2, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
        sizeWeights: { pocket: 1, small: 0, large: 0, "whole-block": 0 }
      }
    }];
    installScene(state);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw: state });
  });

  it.each([
    ["type enum", (district: Record<string, unknown>) => { district.typeId = "not-a-district"; }],
    ["ring", (district: Record<string, unknown>) => { district.polygon = [{ x: -90, y: -70 }, { x: -10, y: -70 }]; }],
    ["seed", (district: Record<string, unknown>) => { district.seed = ""; }],
    ["lock", (district: Record<string, unknown>) => { district.locked = "yes"; }],
    ["origin", (district: Record<string, unknown>) => { district.origin = "generated-by-user"; }],
    ["all-zero category weights", (district: Record<string, unknown>) => {
      const override = district.openSpaceOverride as Record<string, unknown>;
      override.categoryWeights = { park: 0, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 };
    }],
    ["all-zero size weights", (district: Record<string, unknown>) => {
      const override = district.openSpaceOverride as Record<string, unknown>;
      override.sizeWeights = { pocket: 0, small: 0, large: 0, "whole-block": 0 };
    }],
    ["missing category weights", (district: Record<string, unknown>) => {
      delete (district.openSpaceOverride as Record<string, unknown>).categoryWeights;
    }]
  ])("rejects malformed district %s without overwriting the Scene flag", (_name, mutate) => {
    const raw = schema3();
    raw.source.districts = [validDistrict()];
    mutate(raw.source.districts[0] as unknown as Record<string, unknown>);
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("rejects duplicate district-pool ids without overwriting the Scene flag", () => {
    const raw = schema3();
    raw.source.generation.districtPool = [DISTRICT_TYPE_IDS[0]!, DISTRICT_TYPE_IDS[0]!];
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("refuses malformed district identity data without overwriting the Scene flag", () => {
    const raw = schema3();
    raw.source.districts.push({ ...raw.source.districts[0]!, id: "" });
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("rejects unknown code-owned district palettes", () => {
    const raw = schema3();
    raw.source.districts.push({
      id: "d-unknown-palette",
      polygon: [{ x: -90, y: -70 }, { x: -10, y: -70 }, { x: -10, y: 70 }, { x: -90, y: 70 }],
      seed: "district-seed",
      typeId: "corporate-core",
      paletteId: "not-a-registry-palette",
      origin: "authored",
      locked: false,
      openSpaceOverride: null
    });
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
  });

  it("replaces only Nixie-owned walls and uses the documented wall senses", async () => {
    const authored = { id: "authored", getFlag: () => false };
    const generated = { id: "generated", getFlag: () => true };
    const deleteEmbeddedDocuments = vi.fn(async (_type: string, _ids: string[]) => undefined);
    const createEmbeddedDocuments = vi.fn(async (_type: string, data: any[]) => data);
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("CONST", { WALL_SENSE_TYPES: { LIMITED: "limited" }, WALL_MOVEMENT_TYPES: { NORMAL: "normal" } });
    vi.stubGlobal("canvas", { scene: { walls: [authored, generated], deleteEmbeddedDocuments, createEmbeddedDocuments } });
    await replaceGeneratedWalls([{ x1: 1, y1: 2, x2: 3, y2: 4 }]);
    expect(deleteEmbeddedDocuments).toHaveBeenCalledWith("Wall", ["generated"]);
    expect(createEmbeddedDocuments).toHaveBeenCalledWith("Wall", [{
      c: [1, 2, 3, 4], sight: "limited", light: "limited", sound: "limited", move: "normal",
      flags: { [MODULE_ID]: { generated: true } }
    }]);
    expect(authored.id).toBe("authored");
  });

  it("propagates deletion and creation failures without touching authored walls", async () => {
    const authored = { id: "authored", getFlag: () => false };
    const generated = { id: "generated", getFlag: () => true };
    vi.stubGlobal("game", { user: { isGM: true } });
    const deletionFailure = vi.fn(async () => { throw new Error("delete failed"); });
    vi.stubGlobal("canvas", { scene: { walls: [authored, generated], deleteEmbeddedDocuments: deletionFailure, createEmbeddedDocuments: vi.fn() } });
    await expect(replaceGeneratedWalls([{ x1: 1, y1: 2, x2: 3, y2: 4 }])).rejects.toThrow("delete failed");
    expect(authored.id).toBe("authored");

    const creationFailure = vi.fn(async () => { throw new Error("create failed"); });
    vi.stubGlobal("canvas", { scene: { walls: [authored, generated], deleteEmbeddedDocuments: vi.fn(async () => undefined), createEmbeddedDocuments: creationFailure } });
    vi.stubGlobal("CONST", { WALL_SENSE_TYPES: { LIMITED: "limited" }, WALL_MOVEMENT_TYPES: { NORMAL: "normal" } });
    await expect(replaceGeneratedWalls([{ x1: 1, y1: 2, x2: 3, y2: 4 }])).rejects.toThrow("create failed");
    expect(authored.id).toBe("authored");
  });

  it("does not create stale walls and removes a replacement superseded during creation", async () => {
    const generated = { id: "generated", getFlag: () => true };
    const deleteEmbeddedDocuments = vi.fn(async () => undefined);
    const createEmbeddedDocuments = vi.fn(async () => [{ id: "replacement" }]);
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("CONST", { WALL_SENSE_TYPES: { LIMITED: "limited" }, WALL_MOVEMENT_TYPES: { NORMAL: "normal" } });
    vi.stubGlobal("canvas", { scene: { walls: [generated], deleteEmbeddedDocuments, createEmbeddedDocuments } });

    let checks = 0;
    await replaceGeneratedWalls([{ x1: 1, y1: 2, x2: 3, y2: 4 }], () => ++checks < 2);
    expect(createEmbeddedDocuments).not.toHaveBeenCalled();

    checks = 0;
    await replaceGeneratedWalls([{ x1: 1, y1: 2, x2: 3, y2: 4 }], () => ++checks < 3);
    expect(createEmbeddedDocuments).toHaveBeenCalledOnce();
    expect(deleteEmbeddedDocuments).toHaveBeenLastCalledWith("Wall", ["replacement"]);
  });
});
