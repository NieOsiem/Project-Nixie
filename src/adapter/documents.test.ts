import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_SCHEMA_VERSION, FLAG_CITY, GENERATOR_VERSION, MODULE_ID } from "../constants.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CityStateV3 } from "../core/gen/city.js";
import { cityFlagIdentity, clearCityState, loadCityState, saveCityState } from "./documents.js";

let stored: unknown;
let setFlag: ReturnType<typeof vi.fn>;
let unsetFlag: ReturnType<typeof vi.fn>;

function installScene(flag: unknown, write: (value: unknown) => Promise<void> = async (value) => {
  stored = value;
}): void {
  stored = flag;
  setFlag = vi.fn(async (_module: string, key: string, value: unknown) => {
    if (key === FLAG_CITY) await write(value);
  });
  unsetFlag = vi.fn(async (_module: string, key: string) => {
    if (key === FLAG_CITY) stored = undefined;
  });
  vi.stubGlobal("canvas", {
    scene: {
      getFlag: (module: string, key: string) => (module === MODULE_ID && key === FLAG_CITY ? stored : undefined),
      setFlag,
      unsetFlag
    }
  });
  vi.stubGlobal("game", { user: { isGM: true } });
}

function schemaOne(revision = 1): Record<string, unknown> {
  return {
    kind: "city-generator-2",
    schemaVersion: 1,
    generatorVersion: 8,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "phase1-seed",
      generation: { terrainMode: "rectangle", coastEdge: null },
      terrain: {
        land: [
          { x: -100, y: -80 },
          { x: 100, y: -80 },
          { x: 100, y: 80 },
          { x: -100, y: 80 }
        ],
        urbanFootprint: null
      }
    }
  };
}

function schemaTwo(revision = 4): Record<string, unknown> {
  return {
    kind: "city-generator-2",
    schemaVersion: 2,
    generatorVersion: 9,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "phase2-seed",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
      terrain: {
        land: [
          { x: -100, y: -80 },
          { x: 100, y: -80 },
          { x: 100, y: 80 },
          { x: -100, y: 80 }
        ],
        urbanFootprint: null
      },
      roads: { nodes: [], routes: [], edges: [] }
    }
  };
}

function state(revision = 1, roads: CityStateV3["source"]["roads"] = { nodes: [], routes: [], edges: [] }): CityStateV3 {
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "phase1-seed",
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
      roads: structuredClone(roads),
      districts: []
    }
  };
}

const roads = {
  nodes: [
    { id: "n-a", x: -10, y: 0 },
    { id: "n-b", x: 10, y: 0 }
  ],
  routes: [{ id: "r-a", curvePreset: "standard" as const }],
  edges: [
    {
      id: "e-a",
      a: "n-a",
      b: "n-b",
      routeId: "r-a",
      classId: "street" as const,
      name: "Main",
      locked: true,
      origin: "authored" as const
    }
  ]
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadCityState", () => {
  it("classifies an undefined flag as absent", () => {
    installScene(undefined);
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("keeps non-2.0 flags legacy without interpreting a graph", () => {
    const raw = { formatVersion: 4, graph: { nodes: [{ id: "old" }] } };
    installScene(raw);
    expect(loadCityState()).toEqual({ kind: "legacy", raw });
  });

  it("classifies schema 1 / generator 8 as obsolete-precomplete without decoding or writing", () => {
    const raw = schemaOne(7);
    installScene(raw);
    const result = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "obsolete-precomplete",
      raw,
      schemaVersion: 1,
      generatorVersion: 8,
      revision: 7
    });
  });

  it("classifies schema 2 / generator 9 as obsolete-precomplete without decoding or writing", () => {
    const raw = schemaTwo(9);
    installScene(raw);
    const result = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "obsolete-precomplete",
      raw,
      schemaVersion: 2,
      generatorVersion: 9,
      revision: 9
    });
  });

  it("classifies schema 3 / generator 10 as obsolete-precomplete and preserves raw data", () => {
    const raw = { ...state(3, roads), generatorVersion: 10 };
    installScene(raw);
    const result = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "obsolete-precomplete",
      raw,
      schemaVersion: 3,
      generatorVersion: 10,
      revision: 3
    });
  });

  it("keeps obsolete raw data untouched even when its payload is not current-schema decodable", () => {
    const raw = { ...schemaOne(2), source: { land: "garbage" } };
    installScene(raw);
    const result = loadCityState();
    expect(result).toEqual({
      kind: "obsolete-precomplete",
      raw,
      schemaVersion: 1,
      generatorVersion: 8,
      revision: 2
    });
  });

  it("round-trips schema 3 road fields and IDs", () => {
    const raw = state(3, roads);
    installScene(raw);
    const result = loadCityState();
    expect(result).toEqual({ kind: "supported", state: raw, raw });
  });

  it("rejects future schemas and unknown generator versions without writing", () => {
    const future = { ...state(), schemaVersion: 4 };
    installScene(future);
    expect(loadCityState()).toEqual({ kind: "unsupported", raw: future, schemaVersion: 4 });

    const futureGenerator = { ...state(), generatorVersion: 12 };
    installScene(futureGenerator);
    expect(loadCityState()).toEqual({
      kind: "unsupported",
      raw: futureGenerator,
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: 12
    });

    const unknownSchemaOneGenerator = { ...schemaOne(), generatorVersion: 7 };
    installScene(unknownSchemaOneGenerator);
    expect(loadCityState()).toEqual({
      kind: "unsupported",
      raw: unknownSchemaOneGenerator,
      schemaVersion: 1,
      generatorVersion: 7
    });
  });

  it("keeps malformed recognized data distinct", () => {
    const metadata = { ...state(), schemaVersion: "2" };
    installScene(metadata);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw: metadata });

    const malformed = {
      ...state(1, roads),
      source: {
        ...state(1, roads).source,
        roads: { ...roads, edges: [{ ...roads.edges[0], classId: "unknown" }] }
      }
    };
    installScene(malformed);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw: malformed });
  });

  it("rejects duplicate IDs, missing references, invalid lock/name, and invalid geometry", () => {
    const cases = [
      () => ({ ...state(1, roads), source: { ...state(1, roads).source, roads: { ...roads, nodes: [...roads.nodes, roads.nodes[0]] } } }),
      () => ({ ...state(1, roads), source: { ...state(1, roads).source, roads: { ...roads, edges: [{ ...roads.edges[0], a: "missing" }] } } }),
      () => ({ ...state(1, roads), source: { ...state(1, roads).source, roads: { ...roads, edges: [{ ...roads.edges[0], locked: "yes" }] } } }),
      () => ({ ...state(1, roads), source: { ...state(1, roads).source, roads: { ...roads, edges: [{ ...roads.edges[0], name: 42 }] } } }),
      () => ({ ...state(1, roads), source: { ...state(1, roads).source, origin: { x: Number.NaN, y: 0 } } })
    ];
    for (const make of cases) {
      const raw = make();
      installScene(raw);
      expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    }
  });

  it("rejects a persisted crossing without an explicit shared junction", () => {
    const raw = state(1, {
      nodes: [
        { id: "west", x: -20, y: 0 },
        { id: "east", x: 20, y: 0 },
        { id: "north", x: 0, y: -20 },
        { id: "south", x: 0, y: 20 }
      ],
      routes: [
        { id: "horizontal", curvePreset: "standard" },
        { id: "vertical", curvePreset: "standard" }
      ],
      edges: [
        { id: "h", a: "west", b: "east", routeId: "horizontal", classId: "street", name: null, locked: false, origin: "authored" },
        { id: "v", a: "north", b: "south", routeId: "vertical", classId: "street", name: null, locked: false, origin: "authored" }
      ]
    });
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
  });
});

describe("saveCityState", () => {
  it("creates an absent city at revision 1", async () => {
    installScene(undefined);
    const candidate = state();
    await expect(saveCityState(candidate, "absent")).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toEqual(candidate);
  });

  it("writes the guarded revision plus one over a supported city", async () => {
    const current = state(4, roads);
    installScene(current);
    const candidate = state(5, roads);
    await expect(saveCityState(candidate, 4)).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toEqual(candidate);
  });

  it("guards a revision-1 save against an existing supported Scene", async () => {
    const current = state(4, roads);
    installScene(current);
    await expect(saveCityState(state(1), "absent")).rejects.toThrow(/creation|appeared/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(current);
  });

  it("refuses every save against an obsolete-precomplete flag and leaves raw data untouched", async () => {
    const rawSchemaOne = schemaOne(4);
    installScene(rawSchemaOne);
    await expect(saveCityState(state(1), "absent")).rejects.toThrow(/creation/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(rawSchemaOne);

    const rawSchemaTwo = schemaTwo(4);
    installScene(rawSchemaTwo);
    await expect(saveCityState(state(5), 4)).rejects.toThrow(/revision/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(rawSchemaTwo);
    expect(rawSchemaTwo.schemaVersion).toBe(2);
    expect(rawSchemaTwo.generatorVersion).toBe(9);

    const rawSchemaThree = { ...state(4), generatorVersion: 10 };
    installScene(rawSchemaThree);
    await expect(saveCityState(state(5), 4)).rejects.toThrow(/revision/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(rawSchemaThree);
    expect(stored).toEqual(expect.objectContaining({ generatorVersion: 10 }));
  });

  it("rejects malformed or unsupported flags without writing", async () => {
    for (const raw of [{ ...state(), schemaVersion: 3 }, { ...state(), source: { ...state().source, roads: { nodes: [], routes: [{ id: "orphan", curvePreset: "tight" }], edges: [] } } }]) {
      installScene(raw);
      await expect(saveCityState(state(), "absent")).rejects.toThrow();
      expect(setFlag).not.toHaveBeenCalled();
      expect(stored).toBe(raw);
    }
  });

  it("does not hide a failed Scene write", async () => {
    installScene(undefined, async () => {
      throw new Error("write failed");
    });
    await expect(saveCityState(state(), "absent")).rejects.toThrow("write failed");
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toBeUndefined();
  });
});

describe("clearCityState", () => {
  it("is an idempotent no-op when the Scene is already absent", async () => {
    installScene(undefined);
    await clearCityState("absent");
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("clears legacy data only with a matching confirmation", async () => {
    const legacy = { formatVersion: 4 };
    installScene(legacy);
    await expect(clearCityState("absent")).rejects.toThrow(/appeared/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(legacy);

    await clearCityState({ kind: "legacy", identity: cityFlagIdentity(legacy) });
    expect(unsetFlag).toHaveBeenCalledWith(MODULE_ID, FLAG_CITY);
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("clears obsolete-precomplete flags only at the confirmed revision", async () => {
    const raw = schemaOne(6);
    installScene(raw);
    await expect(clearCityState({ kind: "obsolete-precomplete", revision: 5, identity: cityFlagIdentity(raw) })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(raw);

    await clearCityState({ kind: "obsolete-precomplete", revision: 6, identity: cityFlagIdentity(raw) });
    expect(unsetFlag).toHaveBeenCalledWith(MODULE_ID, FLAG_CITY);
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("clears supported cities only at the exact revision", async () => {
    const current = state(7, roads);
    installScene(current);
    await expect(clearCityState({ kind: "supported", revision: 6, identity: cityFlagIdentity(current) })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(current);

    await clearCityState({ kind: "supported", revision: 7, identity: cityFlagIdentity(current) });
    expect(unsetFlag).toHaveBeenCalledWith(MODULE_ID, FLAG_CITY);
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("rejects a different legacy payload with the same confirmation kind", async () => {
    const legacyA = { formatVersion: 4, label: "A" };
    installScene(legacyA);
    const pin = { kind: "legacy" as const, identity: cityFlagIdentity(legacyA) };
    // The legacy payload is replaced while the confirmation is pending.
    const legacyB = { formatVersion: 4, label: "B", graph: { nodes: [] } };
    installScene(legacyB);
    await expect(clearCityState(pin)).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(legacyB);
  });

  it("rejects a different supported source at the same confirmed revision", async () => {
    const cityA = state(7, roads);
    installScene(cityA);
    const pin = { kind: "supported" as const, revision: 7, identity: cityFlagIdentity(cityA) };
    // A different city is written at the same revision while the confirmation is pending.
    const cityB = { ...state(7, roads), source: { ...state(7, roads).source, citySeed: "different-source" } };
    installScene(cityB);
    await expect(clearCityState(pin)).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(cityB);
  });

  it("never clears unsupported or malformed flags", async () => {
    const unsupported = { ...state(), generatorVersion: 12 };
    installScene(unsupported);
    await expect(clearCityState({ kind: "legacy", identity: "x" })).rejects.toThrow(/changed/i);
    await expect(clearCityState({ kind: "supported", revision: 1, identity: "x" })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(unsupported);

    const malformed = { ...state(), source: { ...state().source, roads: { nodes: [], routes: [{ id: "orphan", curvePreset: "tight" }], edges: [] } } };
    installScene(malformed);
    await expect(clearCityState({ kind: "legacy", identity: "x" })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(malformed);
  });
});
