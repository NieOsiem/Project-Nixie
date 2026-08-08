import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_CITY, FLAG_ENABLED } from "../constants.js";
import type { CityStateV2 } from "../core/gen/city.js";
import { rectangleLand } from "../core/gen/terrain.js";
import { TerrainSession } from "./terrain-session.js";
import {
  configuredPixelsPerMetre,
  chunkCoverageComplete,
  deleteRoadJunction,
  deleteRoads,
  enabledFlagChanged,
  getRoadSelection,
  mount,
  reclassifyRoad,
  renameRoad,
  roadClearanceBlockers,
  sceneBoundsFromPixels,
  selectRoad,
  selectRoadNode,
  setRoadCurvePreset,
  setRoadLocked,
  unmount
} from "./terrain-canvas.js";

function state(): CityStateV2 {
  return {
    kind: "city-generator-2",
    schemaVersion: 2,
    generatorVersion: 9,
    revision: 1,
    source: {
      origin: { x: 500, y: 400 },
      citySeed: "scale-fixture",
      generation: { terrainMode: "custom", coastEdge: null, roadLayout: "european", hubMode: "single-centre" },
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

describe("terrain Scene scale mapping", () => {
  it("detects external Scene enable changes in nested update data", () => {
    expect(enabledFlagChanged({ flags: { "project-nixie": { enabled: true } } })).toBe(true);
    expect(enabledFlagChanged({ flags: { "project-nixie": { city: {} } } })).toBe(false);
  });

  it("uses numeric grid distance as metres per square", () => {
    expect(configuredPixelsPerMetre(100, 2)).toBe(50);
    expect(configuredPixelsPerMetre(70, 5)).toBe(14);
  });

  it("changes derived Scene bounds without mutating persisted metre geometry", () => {
    const city = state();
    const before = structuredClone(city.source);
    const scene = { x: 0, y: 0, width: 1000, height: 800 };
    expect(sceneBoundsFromPixels(scene, city.source.origin, 50)).toEqual({
      x: -10,
      y: -8,
      width: 20,
      height: 16
    });
    expect(sceneBoundsFromPixels(scene, city.source.origin, 25)).toEqual({
      x: -20,
      y: -16,
      width: 40,
      height: 32
    });
    expect(city.source).toEqual(before);
  });

  it("creates an exact Rectangle ring from converted Scene bounds", () => {
    const bounds = sceneBoundsFromPixels({ x: 100, y: 200, width: 800, height: 600 }, { x: 500, y: 500 }, 20);
    expect(rectangleLand(bounds)).toEqual([
      { x: -20, y: -15 },
      { x: 20, y: -15 },
      { x: 20, y: 15 },
      { x: -20, y: 15 }
    ]);
  });

  it("invalidates same-revision render work without changing source state", () => {
    const city = state();
    const session = new TerrainSession();
    session.reset({ kind: "supported", state: city });
    const before = session.current;
    const epoch = session.buildEpoch;
    session.invalidateRenderInputs();
    expect(session.current).toEqual(before);
    expect(session.buildEpoch).toBe(epoch + 1);
  });
});

describe("road clearance containment", () => {
  const scene = { x: 0, y: 0, width: 100, height: 100 };
  const road = {
    nodes: [
      { id: "left", x: 0, y: 50 },
      { id: "right", x: 100, y: 50 }
    ],
    routes: [{ id: "route", curvePreset: "standard" as const }],
    edges: [{ id: "road-edge", a: "left", b: "right", routeId: "route", classId: "street" as const, name: null, locked: false, origin: "authored" as const }]
  };

  it("rejects a narrow concave water notch between coarse centreline samples", () => {
    const land = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
      { x: 50, y: 40 },
      { x: 49, y: 40 },
      { x: 49, y: 100 },
      { x: 0, y: 100 }
    ];
    expect(roadClearanceBlockers(road, land, scene)).toEqual(["road-edge"]);
  });

  it("allows a corridor that only terminates at a land Scene edge", () => {
    const land = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 }
    ];
    expect(roadClearanceBlockers(road, land, scene)).toEqual([]);
  });

  it("rejects an internal endpoint cap that spills into water near a footprint boundary", () => {
    const internal = {
      ...road,
      nodes: [
        { id: "inside", x: 20, y: 50 },
        { id: "endpoint", x: 40, y: 50 }
      ],
      edges: [{ id: "road-edge", a: "inside", b: "endpoint", routeId: "route", classId: "street" as const, name: null, locked: false, origin: "authored" as const }]
    };
    const land = [
      { x: 0, y: 0 },
      { x: 45, y: 0 },
      { x: 45, y: 100 },
      { x: 0, y: 100 }
    ];
    expect(roadClearanceBlockers(internal, land, scene)).toEqual(["road-edge"]);
  });
});

describe("road install coverage", () => {
  it("requires every visible chunk before allowing a dirty-only install", () => {
    const scene = { x: 0, y: 0, width: 256, height: 128 };
    expect(chunkCoverageComplete(["0,0", "1,0"], scene)).toBe(true);
    expect(chunkCoverageComplete(["0,0"], scene)).toBe(false);
  });
});

function bulkRoadState(): CityStateV2 {
  const city = state();
  city.source.roads = {
    nodes: [
      { id: "a0", x: -70, y: -40 },
      { id: "a1", x: -20, y: -40 },
      { id: "a2", x: 30, y: -40 },
      { id: "b0", x: -70, y: 30 },
      { id: "b1", x: -20, y: 30 },
      { id: "b2", x: 30, y: 30 }
    ],
    routes: [
      { id: "route-a", curvePreset: "standard" },
      { id: "route-b", curvePreset: "tight" }
    ],
    edges: [
      { id: "edge-a", a: "a0", b: "a1", routeId: "route-a", classId: "street", name: "A", locked: false, origin: "authored" },
      { id: "edge-b", a: "a1", b: "a2", routeId: "route-a", classId: "street", name: "A", locked: false, origin: "authored" },
      { id: "edge-c", a: "b0", b: "b1", routeId: "route-b", classId: "narrow", name: "C", locked: false, origin: "authored" },
      { id: "edge-d", a: "b1", b: "b2", routeId: "route-b", classId: "narrow", name: "C", locked: false, origin: "authored" }
    ]
  };
  return city;
}

describe("road bulk mutation selection", () => {
  let saved: CityStateV2;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    saved = bulkRoadState();
    const scene = {
      getFlag: (_module: string, flag: string): unknown => flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? saved : undefined,
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV2): Promise<CityStateV2> => {
        saved = structuredClone(value);
        return saved;
      })
    };
    vi.stubGlobal("canvas", {
      ready: true,
      dimensions: { sceneRect: { x: 400, y: 320, width: 200, height: 160 }, size: 1, distance: 1 },
      scene,
      app: undefined
    });
    vi.stubGlobal("game", { user: { isGM: true } });
    vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
    mount();
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("applies class and name to exactly the selected edges with a multi-selection", async () => {
    await reclassifyRoad("arterial", true, ["edge-a", "edge-c"]);
    await renameRoad("Boulevard", true, ["edge-a", "edge-c"]);
    expect(saved.revision).toBe(3);
    expect(saved.source.roads.edges.map((edge) => [edge.id, edge.classId, edge.name])).toEqual([
      ["edge-a", "arterial", "Boulevard"],
      ["edge-b", "street", "A"],
      ["edge-c", "arterial", "Boulevard"],
      ["edge-d", "narrow", "C"]
    ]);
  });

  it("applies a curve preset to every route represented by the selected edges", async () => {
    await setRoadCurvePreset("broad", ["edge-a", "edge-c"]);
    expect(saved.revision).toBe(2);
    expect(saved.source.roads.routes).toEqual([
      { id: "route-a", curvePreset: "broad" },
      { id: "route-b", curvePreset: "broad" }
    ]);
  });

  it("rejects duplicate or stale selections before saving", async () => {
    const before = structuredClone(saved);
    await expect(setRoadLocked(true, ["edge-a", "edge-a"])).rejects.toThrow("Road selection is stale");
    await expect(setRoadLocked(true, ["missing"])).rejects.toThrow("Road selection is stale");
    expect(saved).toEqual(before);
  });

  it("keeps a selected edge across a metadata-only commit", async () => {
    selectRoad("edge-a");
    await setRoadLocked(true);
    expect(getRoadSelection().edgeIds).toEqual(["edge-a"]);
  });

  it("keeps a selected edge across a full rebuild commit", async () => {
    selectRoad("edge-a");
    await setRoadCurvePreset("broad", ["edge-a"]);
    expect(getRoadSelection().edgeIds).toEqual(["edge-a"]);
  });

  it("drops deleted roads from the selection", async () => {
    selectRoad("edge-a");
    selectRoad("edge-b", true);
    await deleteRoads(["edge-a"]);
    expect(getRoadSelection().edgeIds).toEqual(["edge-b"]);
  });

  it("drops deleted junctions from the selection", async () => {
    selectRoadNode("a1");
    await deleteRoadJunction("a1");
    expect(getRoadSelection().nodeIds).toEqual([]);
  });
});
