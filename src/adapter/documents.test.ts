import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_SCHEMA_VERSION, FLAG_CITY, GENERATOR_VERSION, MODULE_ID } from "../constants.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CityStateV3, CityStateV4 } from "../core/gen/city.js";
import { CITY_CACHE_FLAG } from "../core/gen/city-cache.js";
import { cityFlagIdentity, clearCityState, loadCityState, saveCityState } from "./documents.js";

let stored: unknown;
let cacheStored: unknown;
let setFlag: ReturnType<typeof vi.fn>;
let unsetFlag: ReturnType<typeof vi.fn>;

function installScene(
  flag: unknown,
  write: (value: unknown) => Promise<void> = async (value) => {
    stored = value;
  },
  cache: unknown = undefined
): void {
  stored = flag;
  cacheStored = cache;
  setFlag = vi.fn(async (module: string, key: string, value: unknown) => {
    if (module !== MODULE_ID) return;
    if (key === FLAG_CITY) await write(value);
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

function state(revision = 1, roads: CityStateV4["source"]["roads"] = { nodes: [], routes: [], edges: [] }): CityStateV4 {
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
      districts: [],
      architecture: { buildings: [], places: [], overrides: [] }
    }
  };
}

const architectureSite = [
  { x: -10, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 }
];

function stateWithArchitecture(revision = 1): CityStateV4 {
  const current = state(revision);
  current.source.architecture = {
    buildings: [{
      id: "building-1",
      lineage: "lineage/building-1",
      origin: "generated",
      protection: "none",
      seed: "seed/building-1",
      appearanceSeed: "appearance/building-1",
      grammarId: "residential-slab",
      visualUse: "residential",
      heightM: 32,
      paletteId: "corporate",
      sitePolygon: architectureSite.map((point) => ({ ...point })),
      placement: { centre: { x: 0, y: 0 }, rotationRad: 0, widthM: 10, depthM: 10 },
      districtId: null,
      blockId: null
    }],
    places: [{
      id: "place-1",
      lineage: "lineage/place-1",
      origin: "authored",
      protection: "explicit",
      seed: "seed/place-1",
      appearanceSeed: "appearance/place-1",
      landmarkGrammarId: "hero-tower-plaza",
      paletteId: "corporate",
      sitePolygon: architectureSite.map((point) => ({ ...point })),
      placement: { centre: { x: 0, y: 0 }, rotationRad: 0, widthM: 10, depthM: 10 },
      districtId: null,
      blockId: null
    }],
    overrides: [{
      targetKind: "building",
      targetId: "building-1",
      lineage: "lineage/override-1",
      protection: "manual-edit",
      snapshotSitePolygon: architectureSite.map((point) => ({ ...point }))
    }]
  };
  return current;
}

function setRecordField(target: object, field: string, value: unknown): void {
  (target as Record<string, unknown>)[field] = value;
}

function removeRecordField(target: object, field: string): void {
  delete (target as Record<string, unknown>)[field];
}

function stateV3(revision = 1, roads: CityStateV3["source"]["roads"] = { nodes: [], routes: [], edges: [] }): CityStateV3 {
  const current = state(revision, roads);
  const { architecture: _architecture, ...source } = current.source;
  return {
    ...current,
    schemaVersion: 3,
    generatorVersion: 11,
    source
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

const malformedArchitectureCases = [
  {
    name: "invalid building origin",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "origin", "imported")
  },
  {
    name: "invalid place protection",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "protection", "locked")
  },
  {
    name: "missing building lineage",
    mutate: (raw: CityStateV4) => removeRecordField(raw.source.architecture.buildings[0]!, "lineage")
  },
  {
    name: "empty place lineage",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "lineage", "")
  },
  {
    name: "missing override lineage",
    mutate: (raw: CityStateV4) => removeRecordField(raw.source.architecture.overrides[0]!, "lineage")
  },
  {
    name: "unknown building grammar",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "grammarId", "unknown-grammar")
  },
  {
    name: "unknown building visual use",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "visualUse", "unknown-use")
  },
  {
    name: "unknown place grammar",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "landmarkGrammarId", "unknown-landmark")
  },
  {
    name: "unknown override palette",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "paletteId", "unknown-palette")
  },
  {
    name: "degenerate building site",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "sitePolygon", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])
  },
  {
    name: "disconnected place site",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "sitePolygon", [
      [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
      [{ x: 20, y: 20 }, { x: 25, y: 20 }, { x: 25, y: 25 }],
      [{ x: 40, y: 40 }, { x: 45, y: 40 }, { x: 45, y: 45 }]
    ])
  },
  {
    name: "hole-like override snapshot",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "snapshotSitePolygon", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 10, y: 10 },
      { x: 0, y: 20 },
      { x: 10, y: 10 }
    ])
  },
  {
    name: "nonfinite building height",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "heightM", Number.NaN)
  },
  {
    name: "negative place frame width",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!.placement, "widthM", -1)
  },
  {
    name: "malformed override target",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "targetKind", "district")
  },
  {
    name: "malformed override snapshot",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "snapshotSitePolygon", "not-a-ring")
  },
  {
    name: "override non-whitelisted field",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "notes", "not persisted")
  },
  {
    name: "invalid place origin",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "origin", "imported")
  },
  {
    name: "invalid building protection",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "protection", "locked")
  },
  {
    name: "empty building lineage",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "lineage", "")
  },
  {
    name: "missing place lineage",
    mutate: (raw: CityStateV4) => removeRecordField(raw.source.architecture.places[0]!, "lineage")
  },
  {
    name: "empty override lineage",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "lineage", "")
  },
  {
    name: "unknown building palette",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "paletteId", "unknown-palette")
  },
  {
    name: "unknown place palette",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "paletteId", "unknown-palette")
  },
  {
    name: "invalid override protection",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "protection", "locked")
  },
  {
    name: "malformed override target id",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "targetId", "")
  },
  {
    name: "nonfinite building frame centre",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!.placement.centre, "x", Number.POSITIVE_INFINITY)
  },
  {
    name: "nonfinite place frame rotation",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!.placement, "rotationRad", Number.POSITIVE_INFINITY)
  },
  {
    name: "zero building frame depth",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!.placement, "depthM", 0)
  },
  {
    name: "negative building height",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "heightM", -1)
  },
  {
    name: "empty building appearance seed",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "appearanceSeed", "")
  },
  {
    name: "empty place seed",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "seed", "")
  },
  {
    name: "zero building frame width",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!.placement, "widthM", 0)
  },
  {
    name: "nonfinite building frame rotation",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!.placement, "rotationRad", Number.NEGATIVE_INFINITY)
  },
  {
    name: "nonfinite place frame centre",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!.placement.centre, "y", Number.NaN)
  },
  {
    name: "empty override appearance seed",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.overrides[0]!, "appearanceSeed", "")
  },
  {
    name: "empty building id",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "id", "")
  },
  {
    name: "empty place id",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "id", "")
  },
  {
    name: "empty building seed",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "seed", "")
  },
  {
    name: "missing place appearance seed",
    mutate: (raw: CityStateV4) => removeRecordField(raw.source.architecture.places[0]!, "appearanceSeed")
  },
  {
    name: "unknown building field",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "notes", "not persisted")
  },
  {
    name: "unknown place field",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "notes", "not persisted")
  },
  {
    name: "incompatible building grammar and visual use",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "visualUse", "industrial")
  },
  {
    name: "invalid building district id",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "districtId", "")
  },
  {
    name: "invalid place block id",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "blockId", "")
  },
  {
    name: "duplicate architecture object id",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "id", "building-1")
  },
  {
    name: "duplicate architecture lineage",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "lineage", "lineage/building-1")
  },
  {
    name: "duplicate architecture override target",
    mutate: (raw: CityStateV4) => raw.source.architecture.overrides.push({
      targetKind: "building",
      targetId: "building-1",
      lineage: "lineage/override-2",
      protection: "manual-edit",
      snapshotSitePolygon: architectureSite.map((point) => ({ ...point }))
    })
  },
  {
    name: "finite building frame extending beyond its site",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.buildings[0]!, "placement", {
      centre: { x: 8, y: 0 },
      rotationRad: 0,
      widthM: 10,
      depthM: 10
    })
  },
  {
    name: "finite place frame extending beyond its site",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture.places[0]!, "placement", {
      centre: { x: 8, y: 0 },
      rotationRad: 0,
      widthM: 10,
      depthM: 10
    })
  },
  {
    name: "unknown architecture source field",
    mutate: (raw: CityStateV4) => setRecordField(raw.source.architecture, "notes", "not persisted")
  },
] satisfies ReadonlyArray<{
  name: string;
  mutate: (raw: CityStateV4) => void;
}>;

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
    const raw = { ...stateV3(3, roads), generatorVersion: 10 };
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
    const raw = stateV3(3, roads);
    installScene(raw);
    const result = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "supported", state: state(3, roads), raw });
  });
  it("persists a migrated V4 state only after a successful guarded edit", async () => {
    const raw = stateV3(4, roads);
    installScene(raw);
    const loaded = loadCityState();
    expect(setFlag).not.toHaveBeenCalled();
    if (loaded.kind !== "supported") throw new Error("expected supported migrated state");
    const candidate = {
      ...loaded.state,
      revision: 5,
      source: { ...loaded.state.source, citySeed: "edited-after-migration" }
    };
    await expect(saveCityState(candidate, 4)).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toEqual(candidate);
    expect(candidate.schemaVersion).toBe(4);
    expect(candidate.generatorVersion).toBe(12);
  });
  it("loads native schema 4 / generator 12 states with mandatory architecture arrays", () => {
    const raw = state(3, roads);
    installScene(raw);
    expect(loadCityState()).toEqual({ kind: "supported", state: raw, raw });
    expect(setFlag).not.toHaveBeenCalled();
  });

  it.each(["buildings", "places", "overrides"] as const)("refuses a native architecture envelope missing the %s array without writing", (missing) => {
    const raw = state(3, roads);
    delete (raw.source.architecture as unknown as Record<string, unknown>)[missing];
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("loads valid building, place, and override records before applying rejection cases", () => {
    const raw = stateWithArchitecture(3);
    installScene(raw);
    expect(loadCityState()).toEqual({ kind: "supported", state: raw, raw });
    expect(setFlag).not.toHaveBeenCalled();
  });

  it.each(malformedArchitectureCases)("refuses malformed architecture $name without writing", ({ mutate }) => {
    const raw = stateWithArchitecture(3);
    mutate(raw);
    installScene(raw);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    expect(setFlag).not.toHaveBeenCalled();
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(raw);
  });

  it("rejects future schemas and unknown generator versions without writing", () => {
    const future = { ...state(), schemaVersion: 5 };
    installScene(future);
    expect(loadCityState()).toEqual({ kind: "unsupported", raw: future, schemaVersion: 5 });

    const futureGenerator = { ...state(), generatorVersion: 13 };
    installScene(futureGenerator);
    expect(loadCityState()).toEqual({
      kind: "unsupported",
      raw: futureGenerator,
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: 13
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
  it("creates an absent city without touching an existing cache manifest", async () => {
    const cache = { slot: 0 };
    installScene(undefined, undefined, cache);
    const candidate = state();
    await expect(saveCityState(candidate, "absent")).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledWith(MODULE_ID, FLAG_CITY, candidate);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toEqual(candidate);
    expect(cacheStored).toBe(cache);
  });

  it("writes the guarded revision plus one without touching the cache manifest", async () => {
    const current = state(4, roads);
    const cache = { slot: 1 };
    installScene(current, undefined, cache);
    const candidate = state(5, roads);
    await expect(saveCityState(candidate, 4)).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledWith(MODULE_ID, FLAG_CITY, candidate);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toEqual(candidate);
    expect(cacheStored).toBe(cache);
  });

  it("guards a revision-1 save against an existing supported Scene", async () => {
    const current = state(4, roads);
    installScene(current);
    await expect(saveCityState(state(1), "absent")).rejects.toThrow(/creation|appeared/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(current);
  });

  it("rejects a direct save over legacy data; legacy replacement needs the clear first", async () => {
    const legacy = { formatVersion: 4, label: "old" };
    installScene(legacy);
    await expect(saveCityState(state(), "absent")).rejects.toThrow(/creation/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(legacy);
    // WHY: exercise the removed "legacy" expectation at runtime; the type no longer permits it.
    await expect(saveCityState(state(), "legacy" as unknown as "absent")).rejects.toThrow(/creation/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(legacy);
  });

  it("replaces legacy data only through identity-pinned clear then a revision-1 absent save", async () => {
    const legacy = { formatVersion: 4, label: "old" };
    installScene(legacy);
    await clearCityState({ kind: "legacy", identity: cityFlagIdentity(legacy) });
    expect(loadCityState()).toEqual({ kind: "absent" });
    const candidate = state();
    await expect(saveCityState(candidate, "absent")).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toEqual(candidate);
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

    const rawSchemaThree = { ...stateV3(4), generatorVersion: 10 };
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

  it.each(malformedArchitectureCases)("refuses malformed architecture saveCandidate $name without writing", async ({ mutate }) => {
    const candidate = stateWithArchitecture();
    mutate(candidate);
    installScene(undefined);
    await expect(saveCityState(candidate, "absent")).rejects.toThrow(/invalid city/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBeUndefined();
  });

  it.each(["buildings", "places", "overrides"] as const)("refuses saveCandidate with a missing architecture %s array without writing", async (missing) => {
    const candidate = stateWithArchitecture();
    delete (candidate.source.architecture as unknown as Record<string, unknown>)[missing];
    installScene(undefined);
    await expect(saveCityState(candidate, "absent")).rejects.toThrow(/invalid city/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBeUndefined();
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
  it("removes an orphaned cache when the authoritative city is already absent", async () => {
    const cache = { slot: 0 };
    installScene(undefined, undefined, cache);
    await clearCityState("absent");
    expect(unsetFlag.mock.calls).toEqual([[MODULE_ID, CITY_CACHE_FLAG]]);
    expect(cacheStored).toBeUndefined();
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("clears legacy data and its cache only with a matching confirmation", async () => {
    const legacy = { formatVersion: 4 };
    const cache = { slot: 0 };
    installScene(legacy, undefined, cache);
    await expect(clearCityState("absent")).rejects.toThrow(/appeared/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(legacy);
    expect(cacheStored).toBe(cache);

    await clearCityState({ kind: "legacy", identity: cityFlagIdentity(legacy) });
    expect(unsetFlag.mock.calls).toEqual([
      [MODULE_ID, FLAG_CITY],
      [MODULE_ID, CITY_CACHE_FLAG]
    ]);
    expect(cacheStored).toBeUndefined();
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("clears obsolete-precomplete flags and their cache only at the confirmed revision", async () => {
    const raw = schemaOne(6);
    const cache = { slot: 1 };
    installScene(raw, undefined, cache);
    await expect(clearCityState({ kind: "obsolete-precomplete", revision: 5, identity: cityFlagIdentity(raw) })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(raw);
    expect(cacheStored).toBe(cache);

    await clearCityState({ kind: "obsolete-precomplete", revision: 6, identity: cityFlagIdentity(raw) });
    expect(unsetFlag.mock.calls).toEqual([
      [MODULE_ID, FLAG_CITY],
      [MODULE_ID, CITY_CACHE_FLAG]
    ]);
    expect(cacheStored).toBeUndefined();
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("clears supported cities and their cache only at the exact revision", async () => {
    const current = state(7, roads);
    const cache = { slot: 0 };
    installScene(current, undefined, cache);
    await expect(clearCityState({ kind: "supported", revision: 6, identity: cityFlagIdentity(current) })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(current);
    expect(cacheStored).toBe(cache);

    await clearCityState({ kind: "supported", revision: 7, identity: cityFlagIdentity(current) });
    expect(unsetFlag.mock.calls).toEqual([
      [MODULE_ID, FLAG_CITY],
      [MODULE_ID, CITY_CACHE_FLAG]
    ]);
    expect(cacheStored).toBeUndefined();
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("rejects a different legacy payload without clearing either flag", async () => {
    const legacyA = { formatVersion: 4, label: "A" };
    const cache = { slot: 1 };
    installScene(legacyA, undefined, cache);
    const pin = { kind: "legacy" as const, identity: cityFlagIdentity(legacyA) };
    // The legacy payload is replaced while the confirmation is pending.
    const legacyB = { formatVersion: 4, label: "B", graph: { nodes: [] } };
    installScene(legacyB, undefined, cache);
    await expect(clearCityState(pin)).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(legacyB);
    expect(cacheStored).toBe(cache);
  });

  it("rejects a different supported source without clearing either flag", async () => {
    const cityA = state(7, roads);
    const cache = { slot: 0 };
    installScene(cityA, undefined, cache);
    const pin = { kind: "supported" as const, revision: 7, identity: cityFlagIdentity(cityA) };
    // A different city is written at the same revision while the confirmation is pending.
    const cityB = { ...state(7, roads), source: { ...state(7, roads).source, citySeed: "different-source" } };
    installScene(cityB, undefined, cache);
    await expect(clearCityState(pin)).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(cityB);
    expect(cacheStored).toBe(cache);
  });

  it("never clears caches alongside unsupported or malformed city flags", async () => {
    const cache = { slot: 1 };
    const unsupported = { ...state(), generatorVersion: 13 };
    installScene(unsupported, undefined, cache);
    await expect(clearCityState({ kind: "legacy", identity: "x" })).rejects.toThrow(/changed/i);
    await expect(clearCityState({ kind: "supported", revision: 1, identity: "x" })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(unsupported);
    expect(cacheStored).toBe(cache);

    const malformed = { ...state(), source: { ...state().source, roads: { nodes: [], routes: [{ id: "orphan", curvePreset: "tight" }], edges: [] } } };
    installScene(malformed, undefined, cache);
    await expect(clearCityState({ kind: "legacy", identity: "x" })).rejects.toThrow(/changed/i);
    expect(unsetFlag).not.toHaveBeenCalled();
    expect(stored).toBe(malformed);
    expect(cacheStored).toBe(cache);
  });
});
