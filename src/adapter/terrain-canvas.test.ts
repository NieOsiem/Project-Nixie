import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_CITY, FLAG_ENABLED } from "../constants.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CityStateV3 } from "../core/gen/city.js";
import { rectangleLand } from "../core/gen/terrain.js";
import { TerrainSession } from "./terrain-session.js";
import { handleRequest, type WorkerRequest } from "../worker/protocol.js";
import {
  configuredPixelsPerMetre,
  chunkCoverageComplete,
  cancelTerrainDraft,
  createDistrict,
  deleteRoadJunction,
  deleteRoads,
  districtDiagnostics,
  enabledFlagChanged,
  getRoadSelection,
  getDistrictSelection,
  getDistrictPlanView,
  fillDistrict,
  generateDistricts,
  mergeDistricts,
  mount,
  reclassifyRoad,
  renameRoad,
  retryDistrictPlan,
  retryGeneratedWalls,
  roadClearanceBlockers,
  sceneBoundsFromPixels,
  selectRoad,
  selectRoadNode,
  selectDistrict,
  setRoadCurvePreset,
  setRoadLocked,
  setDistrictDraftCancelListener,
  splitDistrict,
  setRoadDraftCancelListener,
  stats,
  undo,
  unmount
} from "./terrain-canvas.js";

/** WHY: the adapter builds the plan only in the worker; the fake executes the real protocol dispatcher. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  terminate = vi.fn();

  constructor(_url: string, _options?: unknown) {}

  postMessage(message: WorkerRequest): void {
    queueMicrotask(() => {
      const response = handleRequest(message);
      this.onmessage?.({ data: response });
    });
  }
}

function state(): CityStateV3 {
  return {
    kind: "city-generator-2",
    schemaVersion: 3,
    generatorVersion: 10,
    revision: 1,
    source: {
      origin: { x: 500, y: 400 },
      citySeed: "scale-fixture",
      generation: { terrainMode: "custom", coastEdge: null, roadLayout: "european", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
      terrain: {
        land: [
          { x: -100, y: -80 },
          { x: 100, y: -80 },
          { x: 100, y: 80 },
          { x: -100, y: 80 }
        ],
        urbanFootprint: null
      },
      roads: { nodes: [], routes: [], edges: [] },
      districts: []
    }
  };
}

describe("terrain Scene scale mapping", () => {
  it("cancels terrain, road, and district drafts together", () => {
    const calls: string[] = [];
    setDistrictDraftCancelListener(() => calls.push("district"));
    setRoadDraftCancelListener(() => calls.push("road"));
    cancelTerrainDraft();
    setDistrictDraftCancelListener(null);
    setRoadDraftCancelListener(null);
    expect(calls).toEqual(["road", "district"]);
  });

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

function bulkRoadState(): CityStateV3 {
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
  let saved: CityStateV3;
  let saveError: Error | null;
  let wallCreateError: Error | null;
  let wallDocuments: any[];

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    saved = bulkRoadState();
    saveError = null;
    wallCreateError = null;
    wallDocuments = [];
    const scene = {
      get walls(): any[] { return wallDocuments; },
      getFlag: (_module: string, flag: string): unknown => flag === FLAG_ENABLED ? true : flag === FLAG_CITY ? saved : undefined,
      setFlag: vi.fn(async (_module: string, _flag: string, value: CityStateV3): Promise<CityStateV3> => {
        if (saveError !== null) throw saveError;
        saved = structuredClone(value);
        return saved;
      }),
      deleteEmbeddedDocuments: vi.fn(async (_type: string, ids: string[]) => {
        wallDocuments = wallDocuments.filter((wall) => !ids.includes(wall.id));
        return [];
      }),
      createEmbeddedDocuments: vi.fn(async (_type: string, data: any[]) => {
        if (wallCreateError !== null) throw wallCreateError;
        const created = data.map((value, index) => ({
          id: `wall-${index}`,
          ...value,
          getFlag: (module: string, flag: string) => value.flags?.[module]?.[flag]
        }));
        wallDocuments.push(...created);
        return created;
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
    vi.stubGlobal("CONST", { EDGE_SENSE_TYPES: { LIMITED: 1 }, WALL_MOVEMENT_TYPES: { NORMAL: 1 } });
    vi.stubGlobal("document", { baseURI: "http://test.local/" });
    vi.stubGlobal("Worker", FakeWorker);
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
    expect(saved.source.roads.edges.map((edge: CityStateV3["source"]["roads"]["edges"][number]) => [edge.id, edge.classId, edge.name])).toEqual([
      ["edge-a", "arterial", "Boulevard"],
      ["edge-b", "street", "A"],
      ["edge-c", "arterial", "Boulevard"],
      ["edge-d", "narrow", "C"]
    ]);
  });

  it("commits district geometry without replacing terrain chunk state", async () => {
    await createDistrict([
      { x: -70, y: -20 },
      { x: -20, y: -20 },
      { x: -20, y: 20 },
      { x: -70, y: 20 }
    ], "corporate-core", "night-market");
    expect(saved.revision).toBe(2);
    expect(saved.source.districts).toHaveLength(1);
    expect(saved.source.districts[0]!.paletteId).toBe("night-market");
    expect(stats()?.lastBuild).toBeNull();
    await expect(undo()).resolves.toBe(true);
    expect(saved.source.districts).toHaveLength(0);
    expect(stats()?.lastBuild).toBeNull();
  });

  it("rejects Fill with more than one selected district before planning", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "night-market");
    const ids = saved.source.districts.map((district) => district.id);
    selectDistrict(ids[0]!);
    selectDistrict(ids[1]!, true);
    await expect(fillDistrict({ x: 0, y: 0 }, "corporate-core")).rejects.toThrow("Fill requires zero or one selected district.");
  });

  it("rejects Split unless the requested district is the sole selection", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "night-market");
    const ids = saved.source.districts.map((district) => district.id);
    selectDistrict(ids[0]!);
    selectDistrict(ids[1]!, true);
    await expect(splitDistrict(ids[0]!, [{ x: -80, y: -80 }, { x: -80, y: -40 }])).rejects.toThrow("Split requires exactly one selected district.");
  });

  it("rejects repeat initial generation without replacing existing districts", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    const before = structuredClone(saved);
    await expect(generateDistricts({ districtPool: ["corporate-core"], openSpaceProfile: "medium" })).rejects.toThrow("requires an empty district source");
    expect(saved).toEqual(before);
  });

  it("preserves the selected merge participants when persistence fails", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -70, y: -70 }, { x: -50, y: -70 }, { x: -50, y: -50 }, { x: -70, y: -50 }
    ], "night-market");
    const ids = saved.source.districts.map((district) => district.id);
    selectDistrict(ids[0]!);
    selectDistrict(ids[1]!, true);
    saveError = new Error("save failed");
    await expect(mergeDistricts(ids, ids[0]!)).rejects.toThrow("save failed");
    expect(getDistrictSelection()).toEqual([...ids].sort());
  });

  it("retains a degraded wall diagnostic while editing and clears it after Retry succeeds", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    wallCreateError = new Error("wall creation failed");
    await expect(retryGeneratedWalls()).rejects.toThrow("wall creation failed");
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ subsystem: "walls", retry: "walls", message: "wall creation failed" })]));
    const revision = saved.revision;
    wallCreateError = null;
    await expect(retryGeneratedWalls()).resolves.toBeUndefined();
    expect(saved.revision).toBe(revision);
    expect(districtDiagnostics().some((entry) => entry.subsystem === "walls")).toBe(false);
    expect(wallDocuments.length).toBeGreaterThan(0);
  });

  it("keeps additive selection within the district object type across district identities", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -30, y: -70 }, { x: -10, y: -70 }, { x: -10, y: -50 }, { x: -30, y: -50 }
    ], "night-market");
    const corporate = saved.source.districts.filter((district) => district.typeId === "corporate-core");
    const market = saved.source.districts.find((district) => district.typeId === "night-market")!;
    selectDistrict(corporate[0]!.id);
    selectDistrict(corporate[1]!.id, true);
    expect(getDistrictSelection()).toEqual(corporate.map((district) => district.id).sort());
    selectDistrict(market.id, true);
    expect(getDistrictSelection()).toEqual([...corporate.map((district) => district.id), market.id].sort());
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

  it("publishes the district plan asynchronously after a district commit", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await vi.waitFor(() => {
      expect(stats()).toEqual(expect.objectContaining({
        districtPlan: expect.objectContaining({ revision: saved.revision })
      }));
    });
    expect(getDistrictPlanView()).not.toBeNull();
  });

  it("keeps only the latest revision's plan across rapid commits", async () => {
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    await createDistrict([
      { x: -60, y: -70 }, { x: -40, y: -70 }, { x: -40, y: -50 }, { x: -60, y: -50 }
    ], "night-market");
    await vi.waitFor(() => {
      expect(stats()).toEqual(expect.objectContaining({
        districtPlan: expect.objectContaining({ revision: saved.revision })
      }));
    });
    const view = getDistrictPlanView();
    const fragmentIds = new Set((view?.blocks ?? []).flatMap((block) => block.districtFragments.map((fragment) => fragment.districtId)));
    expect(fragmentIds.size).toBeGreaterThanOrEqual(2);
  });

  it("makes Fill wait for the current plan and target a road-defined block", async () => {
    // No commit has requested a plan yet; Fill must request and await it itself.
    await fillDistrict({ x: -45, y: 0 }, "night-market");
    expect(saved.source.districts).toHaveLength(1);
  });

  it("degrades plan builds without freezing the UI thread when the worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    expect(districtDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subsystem: "districts", retry: "plan" })
    ]));
    await expect(fillDistrict({ x: 0, y: 0 }, "corporate-core")).rejects.toThrow("unavailable");
  });

  it("restores the plan when Retry succeeds after the worker returns", async () => {
    vi.stubGlobal("Worker", undefined);
    await createDistrict([
      { x: -90, y: -70 }, { x: -70, y: -70 }, { x: -70, y: -50 }, { x: -90, y: -50 }
    ], "corporate-core");
    expect(districtDiagnostics().some((entry) => entry.retry === "plan")).toBe(true);
    vi.stubGlobal("Worker", FakeWorker);
    await retryDistrictPlan();
    expect(getDistrictPlanView()).not.toBeNull();
    expect(districtDiagnostics().some((entry) => entry.retry === "plan")).toBe(false);
  });
});
