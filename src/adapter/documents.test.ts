import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_SCHEMA_VERSION, FLAG_CITY, GENERATOR_VERSION, MODULE_ID } from "../constants.js";
import type { CityStateV2 } from "../core/gen/city.js";
import { loadCityState, saveCityState } from "./documents.js";

let stored: unknown;
let setFlag: ReturnType<typeof vi.fn>;

function installScene(flag: unknown, write: (value: unknown) => Promise<void> = async (value) => {
  stored = value;
}): void {
  stored = flag;
  setFlag = vi.fn(async (_module: string, key: string, value: unknown) => {
    if (key === FLAG_CITY) await write(value);
  });
  (globalThis as any).canvas = {
    scene: {
      getFlag: (module: string, key: string) => (module === MODULE_ID && key === FLAG_CITY ? stored : undefined),
      setFlag
    }
  };
  (globalThis as any).game = { user: { isGM: true } };
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

function state(revision = 1, roads: CityStateV2["source"]["roads"] = { nodes: [], routes: [], edges: [] }): CityStateV2 {
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
        hubMode: "single-centre"
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
      roads: structuredClone(roads)
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
  delete (globalThis as any).canvas;
  delete (globalThis as any).game;
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

  it("migrates schema 1 in memory without writing and adds empty roads", () => {
    const raw = schemaOne(7);
    installScene(raw);
    const result = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    expect(result.kind).toBe("supported");
    if (result.kind === "supported") {
      const source = raw.source as any;
      expect(result.state.schemaVersion).toBe(2);
      expect(result.state.generatorVersion).toBe(9);
      expect(result.state.revision).toBe(7);
      expect(result.state.source.origin).toEqual(source.origin);
      expect(result.state.source.citySeed).toBe(source.citySeed);
      expect(result.state.source.terrain).toEqual(source.terrain);
      expect(result.state.source.roads).toEqual({ nodes: [], routes: [], edges: [] });
      expect(result.migratedFrom).toEqual({ schemaVersion: 1, generatorVersion: 8, revision: 7 });
    }
  });

  it("round-trips schema 2 road fields and IDs", () => {
    const raw = state(3, roads);
    installScene(raw);
    const result = loadCityState();
    expect(result).toEqual({ kind: "supported", state: raw });
  });

  it("rejects future schemas and unsupported generators without writing", () => {
    const future = { ...state(), schemaVersion: 3 };
    installScene(future);
    expect(loadCityState()).toEqual({ kind: "unsupported", raw: future, schemaVersion: 3 });

    const unsupported = { ...state(), generatorVersion: 10 };
    installScene(unsupported);
    expect(loadCityState()).toEqual({
      kind: "unsupported",
      raw: unsupported,
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: 10
    });
  });

  it("keeps malformed recognized data distinct", () => {
    const metadata = { ...state(), schemaVersion: "2" };
    installScene(metadata);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw: metadata });

    const malformed = state(1, roads);
    (malformed.source.roads.edges[0] as any).classId = "unknown";
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

  it("writes schema 2 revision plus one on the first edit to migrated schema 1", async () => {
    const raw = schemaOne(4);
    installScene(raw);
    const candidate = state(5, roads);
    await expect(
      saveCityState(candidate, { kind: "migrated-schema-1", revision: 4 })
    ).resolves.toEqual(candidate);
    expect(stored).toEqual(candidate);
  });

  it("does not let schema-1 and schema-2 expectations satisfy each other", async () => {
    const migrated = schemaOne(4);
    installScene(migrated);
    await expect(saveCityState(state(5), 4)).rejects.toThrow(/revision/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(migrated);

    const current = state(4);
    installScene(current);
    await expect(
      saveCityState(state(5), { kind: "migrated-schema-1", revision: 4 })
    ).rejects.toThrow(/migrated/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(current);
  });

  it("rejects stale migration writes and leaves raw schema 1 untouched", async () => {
    const raw = schemaOne(4);
    installScene(raw);
    await expect(saveCityState(state(5), 3)).rejects.toThrow(/revision/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(raw);
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
