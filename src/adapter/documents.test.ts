import { afterEach, describe, expect, it, vi } from "vitest";
import { CITY_FORMAT_VERSION, FLAG_CITY, MODULE_ID } from "../constants.js";
import { ROAD_CLASSES } from "../core/gen/demo-city.js";
import { DEFAULT_ZONE_PARAMS } from "../core/gen/zones.js";
import { BANK_SIZE, DEFAULT_DISTRICT_PALETTE, FIRST_ZONE_BANK } from "../core/palette.js";
import { loadCityState } from "./documents.js";

/**
 * A stub scene, not Foundry. It exists only to hand `loadCityState` a stored flag, which
 * is the one thing the migration path cannot be tested without.
 */
const storeCity = (city: unknown): void => {
  (globalThis as any).canvas = {
    scene: {
      getFlag: (module: string, key: string) =>
        module === MODULE_ID && key === FLAG_CITY ? city : undefined
    }
  };
};

afterEach(() => {
  delete (globalThis as any).canvas;
  vi.restoreAllMocks();
});

/** Shape of the user's real stored city: metres, `origin`, zones without banks. */
const formatThreeCity = () => ({
  formatVersion: 3,
  generatorVersion: 2,
  origin: { x: 5000, y: 4000 },
  graph: {
    nodes: [
      { id: "A", x: -80, y: -52 },
      { id: "B", x: 0, y: -52 },
      { id: "E", x: 0, y: 0 }
    ],
    edges: [
      { id: "AB", a: "A", b: "B", classId: "street" },
      { id: "BE", a: "B", b: "E", classId: "arterial", sidewalks: false }
    ],
    classes: [{ id: "street", widthM: 1, sidewalkM: 0 }]
  },
  base: { seed: 12, lotSizeM: 30, gapM: 5, minHeightM: 6, maxHeightM: 120 },
  zones: [
    { id: "z1", seed: 77, rect: { x: -100, y: -60, width: 90, height: 120 }, lotSizeM: 18, gapM: 3, minHeightM: 20, maxHeightM: 90 },
    { id: "z2", seed: 78, rect: { x: 20, y: -60, width: 90, height: 120 }, lotSizeM: 40, gapM: 6, minHeightM: 4, maxHeightM: 40 }
  ]
});

describe("loadCityState", () => {
  it("returns nothing when the scene has no city", () => {
    storeCity(undefined);
    expect(loadCityState()).toBeNull();
  });

  it("keeps a format-3 city intact through the migration", () => {
    const stored = formatThreeCity();
    storeCity(stored);
    const city = loadCityState()!;

    expect(city).not.toBeNull();
    expect(city.formatVersion).toBe(CITY_FORMAT_VERSION);
    expect(city.origin).toEqual(stored.origin);

    // The geometry is the thing worth protecting: same nodes, same edges, same positions.
    expect(city.graph.nodes).toEqual(stored.graph.nodes);
    expect(city.graph.edges).toEqual(stored.graph.edges);
    expect(city.zones).toHaveLength(stored.zones.length);
    for (const [i, zone] of city.zones.entries()) {
      const before = stored.zones[i]!;
      expect(zone.id).toBe(before.id);
      expect(zone.rect).toEqual(before.rect);
      expect(zone.seed).toBe(before.seed);
      expect(zone.lotSizeM).toBe(before.lotSizeM);
      expect(zone.minHeightM).toBe(before.minHeightM);
      expect(zone.maxHeightM).toBe(before.maxHeightM);
    }
    expect(city.base.seed).toBe(stored.base.seed);
    expect(city.base.lotSizeM).toBe(stored.base.lotSizeM);
  });

  it("gives a migrated city distinct banks and full palettes", () => {
    storeCity(formatThreeCity());
    const city = loadCityState()!;

    const banks = city.zones.map((z) => z.bank);
    expect(banks).toEqual([FIRST_ZONE_BANK, FIRST_ZONE_BANK + 1]);
    expect(new Set(banks).size).toBe(banks.length);
    expect(city.base.palette.materials).toHaveLength(BANK_SIZE);
    for (const zone of city.zones) expect(zone.palette.materials).toHaveLength(BANK_SIZE);
    expect(city.base.palette.name).toBe(DEFAULT_DISTRICT_PALETTE.name);
  });

  it("still adopts the current road classes on a migrated city", () => {
    storeCity(formatThreeCity());
    expect(loadCityState()!.graph.classes).toEqual(ROAD_CLASSES);
  });

  it("keeps a format-4 city's stored banks rather than renumbering them", () => {
    const stored = { ...formatThreeCity(), formatVersion: CITY_FORMAT_VERSION };
    stored.zones[0]!.id = "z1";
    (stored.zones[0] as any).bank = 11;
    (stored.zones[1] as any).bank = 5;
    storeCity(stored);
    expect(loadCityState()!.zones.map((z) => z.bank)).toEqual([11, 5]);
  });

  it("preserves a stored per-road parked-car toggle", () => {
    const stored = { ...formatThreeCity(), formatVersion: CITY_FORMAT_VERSION };
    (stored.graph.edges[0] as any).parkedCars = false;
    storeCity(stored);
    expect(loadCityState()!.graph.edges[0]!.parkedCars).toBe(false);
  });

  it("pads a short or half-written stored palette up to a full bank", () => {
    const stored: any = { ...formatThreeCity(), formatVersion: CITY_FORMAT_VERSION };
    stored.base.palette = { name: "Half", materials: DEFAULT_DISTRICT_PALETTE.materials.slice(0, 3) };
    stored.zones[0].bank = FIRST_ZONE_BANK;
    stored.zones[1].bank = FIRST_ZONE_BANK + 1;
    storeCity(stored);

    const city = loadCityState()!;
    expect(city.base.palette.name).toBe("Half");
    expect(city.base.palette.materials).toHaveLength(BANK_SIZE);
    expect(city.base.palette.materials[7]).toEqual(DEFAULT_DISTRICT_PALETTE.materials[7]);
  });

  it("fills missing zone params from the defaults", () => {
    const stored: any = { ...formatThreeCity(), formatVersion: CITY_FORMAT_VERSION, base: { seed: 3 } };
    storeCity(stored);
    expect(loadCityState()!.base.lotSizeM).toBe(DEFAULT_ZONE_PARAMS.lotSizeM);
  });

  it("still warns and ignores a format older than 3", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storeCity({ ...formatThreeCity(), formatVersion: 2 });
    expect(loadCityState()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still warns and ignores an unrecognised future format", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storeCity({ ...formatThreeCity(), formatVersion: 99 });
    expect(loadCityState()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
