import { describe, expect, it } from "vitest";
import {
  ROUTE_CLASSES,
  allocateManualId,
  allocateManualLineage,
  validateCityStateV3,
  validateCityStateV4,
  validateRoadSource,
  type CityStateV3,
  type CityStateV4
} from "./city.js";
import { DISTRICT_TYPE_IDS } from "./district-registry.js";
import { rectangleLand } from "./terrain.js";

function state(generatorVersion: number, revision = 1): CityStateV4 {
  return {
    kind: "city-generator-2",
    schemaVersion: 4,
    generatorVersion: generatorVersion as CityStateV4["generatorVersion"],
    revision,
    source: {
      origin: { x: 12, y: 34 },
      citySeed: "model-fixture",
      generation: {
        terrainMode: "rectangle",
        coastEdge: null,
        roadLayout: "european",
        hubMode: "single-centre",
        districtPool: [...DISTRICT_TYPE_IDS],
        openSpaceProfile: "medium"
      },
      terrain: { land: rectangleLand({ x: 0, y: 0, width: 100, height: 80 }), urbanFootprint: null },
      roads: { nodes: [], routes: [], edges: [] },
      districts: [],
      architecture: { buildings: [], places: [], overrides: [] }
    }
  };
}

function legacyState(generatorVersion: number): CityStateV3 {
  const current = state(12);
  const { architecture: _architecture, ...source } = current.source;
  return {
    ...current,
    schemaVersion: 3,
    generatorVersion: generatorVersion as CityStateV3["generatorVersion"],
    source
  };
}
type ArchitectureBuilding = CityStateV4["source"]["architecture"]["buildings"][number];
type ArchitecturePlace = CityStateV4["source"]["architecture"]["places"][number];
type ArchitectureOverride = CityStateV4["source"]["architecture"]["overrides"][number];

const architectureSite = [
  { x: -10, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 }
];

function architectureBuilding(overrides: Partial<ArchitectureBuilding> = {}): ArchitectureBuilding {
  return {
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
    blockId: null,
    ...overrides
  };
}

function architecturePlace(overrides: Partial<ArchitecturePlace> = {}): ArchitecturePlace {
  return {
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
    blockId: null,
    ...overrides
  };
}

function architectureOverride(overrides: Partial<ArchitectureOverride> = {}): ArchitectureOverride {
  return {
    targetKind: "building",
    targetId: "building-1",
    lineage: "lineage/override-1",
    protection: "manual-edit",
    snapshotSitePolygon: architectureSite.map((point) => ({ ...point })),
    ...overrides
  };
}

function setArchitectureField(target: object, field: string, value: unknown): void {
  (target as Record<string, unknown>)[field] = value;
}

function removeArchitectureField(target: object, field: string): void {
  delete (target as Record<string, unknown>)[field];
}

function architectureState(): CityStateV4 {
  const current = state(12);
  current.source.architecture = {
    buildings: [architectureBuilding()],
    places: [architecturePlace()],
    overrides: [architectureOverride()]
  };
  return current;
}

const invalidArchitectureCases = [
  {
    name: "an empty building id",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "id", ""),
    expected: "Persistent building id must be non-empty text."
  },
  {
    name: "an empty place id",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "id", ""),
    expected: "Persistent place id must be non-empty text."
  },
  {
    name: "an invalid building origin",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "origin", "imported"),
    expected: "Persistent building origin is invalid."
  },
  {
    name: "an invalid place origin",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "origin", "imported"),
    expected: "Persistent place origin is invalid."
  },
  {
    name: "an invalid building protection",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "protection", "locked"),
    expected: "Persistent building protection is invalid."
  },
  {
    name: "an invalid place protection",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "protection", "locked"),
    expected: "Persistent place protection is invalid."
  },
  {
    name: "a missing building lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => removeArchitectureField(architecture.buildings[0]!, "lineage"),
    expected: "Persistent building lineage must be non-empty stable text."
  },
  {
    name: "an empty building lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "lineage", ""),
    expected: "Persistent building lineage must be non-empty stable text."
  },
  {
    name: "a missing place lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => removeArchitectureField(architecture.places[0]!, "lineage"),
    expected: "Persistent place lineage must be non-empty stable text."
  },
  {
    name: "an empty place lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "lineage", ""),
    expected: "Persistent place lineage must be non-empty stable text."
  },
  {
    name: "a missing override lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => removeArchitectureField(architecture.overrides[0]!, "lineage"),
    expected: "Architecture override lineage must be non-empty stable text."
  },
  {
    name: "an empty override lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "lineage", ""),
    expected: "Architecture override lineage must be non-empty stable text."
  },
  {
    name: "an empty building seed",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "seed", ""),
    expected: "Persistent building seed must be non-empty text."
  },
  {
    name: "a missing place appearance seed",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => removeArchitectureField(architecture.places[0]!, "appearanceSeed"),
    expected: "Persistent place appearanceSeed must be non-empty text."
  },
  {
    name: "an unknown building field",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "notes", "not persisted"),
    expected: 'Persistent building source has unknown field "notes".'
  },
  {
    name: "an unknown place field",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "notes", "not persisted"),
    expected: 'Persistent place source has unknown field "notes".'
  },
  {
    name: "an incompatible building grammar and visual use",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "visualUse", "industrial"),
    expected: 'Building grammar "residential-slab" does not support visual use "industrial".'
  },
  {
    name: "an invalid building district id",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "districtId", ""),
    expected: "Persistent building districtId must be non-empty text or null."
  },
  {
    name: "an invalid place block id",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "blockId", ""),
    expected: "Persistent place blockId must be non-empty text or null."
  },
  {
    name: "a duplicate architecture object id",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "id", "building-1"),
    expected: 'Duplicate architecture object id "building-1".'
  },
  {
    name: "a duplicate architecture lineage",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "lineage", "lineage/building-1"),
    expected: 'Duplicate architecture lineage "lineage/building-1".'
  },
  {
    name: "a duplicate architecture override target",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => architecture.overrides.push(architectureOverride({ lineage: "lineage/override-2" })),
    expected: 'Duplicate architecture override target "building:building-1".'
  },
  {
    name: "an unknown building grammar",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "grammarId", "unknown-grammar"),
    expected: "Unknown building grammar"
  },
  {
    name: "an unknown building visual use",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "visualUse", "unknown-use"),
    expected: "Unknown building visual use"
  },
  {
    name: "an unknown place grammar",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "landmarkGrammarId", "unknown-landmark"),
    expected: "Unknown landmark grammar"
  },
  {
    name: "an unknown building palette",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "paletteId", "unknown-palette"),
    expected: "Persistent building paletteId must be a known palette id"
  },
  {
    name: "an unknown place palette",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "paletteId", "unknown-palette"),
    expected: "Persistent place paletteId must be a known palette id"
  },
  {
    name: "a malformed override target kind",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "targetKind", "district"),
    expected: "Architecture override targetKind is invalid."
  },
  {
    name: "a malformed override target id",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "targetId", ""),
    expected: "Architecture override targetId must be non-empty text."
  },
  {
    name: "an invalid override protection",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "protection", "locked"),
    expected: "Architecture override protection is invalid."
  },
  {
    name: "an unknown override palette",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "paletteId", "unknown-palette"),
    expected: "Architecture override paletteId must be a known palette id"
  },
  {
    name: "an override non-whitelisted field",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "notes", "not persisted"),
    expected: 'Architecture override has unknown field "notes".'
  },
  {
    name: "an empty override appearance seed",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "appearanceSeed", ""),
    expected: "Architecture override appearanceSeed must be non-empty text when present."
  },
  {
    name: "a non-ring override snapshot",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "snapshotSitePolygon", "not-a-ring"),
    expected: "Architecture override snapshotSitePolygon must be a ring."
  }
] satisfies ReadonlyArray<{
  name: string;
  mutate: (architecture: CityStateV4["source"]["architecture"]) => void;
  expected: string;
}>;

const invalidArchitectureGeometryCases = [
  {
    name: "a degenerate building site",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "sitePolygon", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]),
    expected: "Ring area must exceed"
  },
  {
    name: "a disconnected place site",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "sitePolygon", [
      [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
      [{ x: 20, y: 20 }, { x: 25, y: 20 }, { x: 25, y: 25 }],
      [{ x: 40, y: 40 }, { x: 45, y: 40 }, { x: 45, y: 45 }]
    ]),
    expected: "Ring vertices must have finite coordinates"
  },
  {
    name: "a finite building frame extending beyond its site",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "placement", {
      centre: { x: 8, y: 0 },
      rotationRad: 0,
      widthM: 10,
      depthM: 10
    }),
    expected: "Persistent building placement frame footprint must be contained within sitePolygon."
  },
  {
    name: "a finite place frame extending beyond its site",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!, "placement", {
      centre: { x: 8, y: 0 },
      rotationRad: 0,
      widthM: 10,
      depthM: 10
    }),
    expected: "Persistent place placement frame footprint must be contained within sitePolygon."
  },
  {
    name: "a hole-like override snapshot",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.overrides[0]!, "snapshotSitePolygon", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 10, y: 10 },
      { x: 0, y: 20 },
      { x: 10, y: 10 }
    ]),
    expected: "Ring repeats a vertex."
  }
] satisfies ReadonlyArray<{
  name: string;
  mutate: (architecture: CityStateV4["source"]["architecture"]) => void;
  expected: string;
}>;

const invalidArchitectureMetricCases = [
  {
    name: "a nonfinite building height",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "heightM", Number.NaN),
    expected: "Persistent building heightM must be finite and positive."
  },
  {
    name: "a negative place height-free frame width",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!.placement, "widthM", -1),
    expected: "Persistent place: Placement widthM must be finite and positive."
  },
  {
    name: "a nonfinite building frame centre",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!.placement.centre, "x", Number.POSITIVE_INFINITY),
    expected: "Persistent building: Placement centre must have finite x/y."
  },
  {
    name: "a nonfinite place frame rotation",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!.placement, "rotationRad", Number.POSITIVE_INFINITY),
    expected: "Persistent place: Placement rotationRad must be finite."
  },
  {
    name: "a zero building frame depth",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!.placement, "depthM", 0),
    expected: "Persistent building: Placement depthM must be finite and positive."
  },
  {
    name: "a negative place height-free frame depth",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!.placement, "depthM", -1),
    expected: "Persistent place: Placement depthM must be finite and positive."
  },
  {
    name: "a zero building frame width",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!.placement, "widthM", 0),
    expected: "Persistent building: Placement widthM must be finite and positive."
  },
  {
    name: "a nonfinite building frame rotation",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!.placement, "rotationRad", Number.NEGATIVE_INFINITY),
    expected: "Persistent building: Placement rotationRad must be finite."
  },
  {
    name: "a nonfinite place frame centre",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.places[0]!.placement.centre, "y", Number.NaN),
    expected: "Persistent place: Placement centre must have finite x/y."
  },
  {
    name: "a negative building height",
    mutate: (architecture: CityStateV4["source"]["architecture"]) => setArchitectureField(architecture.buildings[0]!, "heightM", -1),
    expected: "Persistent building heightM must be finite and positive."
  }
] satisfies ReadonlyArray<{
  name: string;
  mutate: (architecture: CityStateV4["source"]["architecture"]) => void;
  expected: string;
}>;


describe("City Generator 2.0 generator-12 model", () => {
  it("accepts a valid empty architecture envelope in schema 4", () => {
    const current = state(12);
    expect(current.schemaVersion).toBe(4);
    expect(current.generatorVersion).toBe(12);
    expect(validateCityStateV4(current)).toEqual([]);
  });

  it("retains explicit schema-3/generator-11 validation for migration input", () => {
    expect(validateCityStateV3(legacyState(11))).toEqual([]);
    expect(validateCityStateV4(legacyState(11))).toEqual([
      "Unsupported city schema version.",
      "Unsupported city generator version.",
      "City architecture source is required for schema 4."
    ]);
  });

  it("rejects obsolete generator-11 and future generator-13 schema-4 states", () => {
    expect(validateCityStateV4(state(11))).toEqual(["Unsupported city generator version."]);
    expect(validateCityStateV4(state(13))).toEqual(["Unsupported city generator version."]);
  });

  it.each(invalidArchitectureCases)("$name", ({ mutate, expected }) => {
    const current = architectureState();
    mutate(current.source.architecture);
    expect(validateCityStateV4(current)).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it.each(invalidArchitectureGeometryCases)("$name", ({ mutate, expected }) => {
    const current = architectureState();
    mutate(current.source.architecture);
    expect(validateCityStateV4(current)).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it.each(invalidArchitectureMetricCases)("$name", ({ mutate, expected }) => {
    const current = architectureState();
    mutate(current.source.architecture);
    expect(validateCityStateV4(current)).toEqual(expect.arrayContaining([expect.stringContaining(expected)]));
  });

  it("allocates stable, collision-safe manual IDs and lineages for buildings and places", () => {
    const frame = { centre: { x: 10, y: 20 }, rotationRad: 0.25, widthM: 16, depthM: 24 };
    const buildingLineage = allocateManualLineage("bldg", 4, 2, "residential-slab", frame);
    const placeLineage = allocateManualLineage("plc", 4, 2, "hero-tower-plaza", frame);
    expect(buildingLineage).toBe(allocateManualLineage("bldg", 4, 2, "residential-slab", frame));
    expect(buildingLineage).not.toBe(placeLineage);
    expect(allocateManualId("bldg", 4, 2, buildingLineage)).toMatch(/^m_bldg_[0-9a-f]{8}$/u);
    expect(allocateManualId("plc", 4, 2, placeLineage)).toMatch(/^m_plc_[0-9a-f]{8}$/u);
    const used = new Set([allocateManualId("bldg", 4, 2, buildingLineage)]);
    expect(allocateManualId("bldg", 4, 2, buildingLineage, used)).toMatch(/^m_bldg_[0-9a-f]{8}_1$/u);
  });

  it("has the complete stable route-class registry with monotonic widths and navigable minimums", () => {
    expect(ROUTE_CLASSES.map((routeClass) => routeClass.id)).toEqual([
      "highway", "arterial", "street", "narrow", "lane", "alley", "pedestrian-path", "park-path", "plaza-route", "public-passage", "waterfront-promenade", "cycleway"
    ]);

    const vehicleClasses = ROUTE_CLASSES.filter((c) => c.vehicle);
    const vehicleOrder = ["highway", "arterial", "street", "narrow", "lane", "alley"] as const;
    expect(vehicleClasses.map((c) => c.id)).toEqual(vehicleOrder);

    // Monotonic carriageway widths
    for (let i = 0; i + 1 < vehicleClasses.length; i++) {
      expect(vehicleClasses[i]!.widthM).toBeGreaterThan(vehicleClasses[i + 1]!.widthM);
    }

    // Monotonic sidewalk widths
    for (let i = 0; i + 1 < vehicleClasses.length; i++) {
      expect(vehicleClasses[i]!.sidewalkM).toBeGreaterThanOrEqual(vehicleClasses[i + 1]!.sidewalkM);
    }

    // Navigable minimums for vehicles (at least 2.5m even in alleys)
    for (const cls of vehicleClasses) {
      expect(cls.widthM).toBeGreaterThanOrEqual(2.5);
      expect(cls.sidewalkM).toBeGreaterThanOrEqual(0);
      expect(cls.surface).toBe("vehicle");
    }

    // Non-vehicle classes
    const nonVehicleClasses = ROUTE_CLASSES.filter((c) => !c.vehicle);
    for (const cls of nonVehicleClasses) {
      expect(cls.surface).toBe("non-vehicle");
      expect(cls.sidewalkM).toBe(0);
      expect(cls.centreMarking).toBe(false);
      expect(cls.widthM).toBeGreaterThan(0);
    }
  });

  it("rejects broken references and malformed fields", () => {
    expect(validateRoadSource({ nodes: [{ id: "a", x: 0, y: 0 }], routes: [{ id: "r", curvePreset: "standard" }], edges: [{ id: "e", a: "a", b: "b", routeId: "r", classId: "street", name: 1, locked: false, origin: "authored" }] })).toEqual(expect.arrayContaining([expect.stringContaining("unknown node"), expect.stringContaining("name")]));
  });
});

