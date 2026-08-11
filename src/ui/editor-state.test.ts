import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratePresetId, TerrainMode } from "./editor-state.js";
import {
  applyGeneratePreset,
  canvasTool,
  clearEditorActionError,
  closeEditor,
  currentCoastEdge,
  currentCurvePreset,
  currentDistrictPalette,
  currentDistrictPool,
  currentEditorActionError,
  currentHubMode,
  currentObjectCategory,
  currentOpenSpaceProfile,
  currentRoadClass,
  currentRoadLayout,
  currentSeed,
  currentTerrainMode,
  currentWorkspace,
  districtSnapOptions,
  DISTRICT_TYPE_IDS,
  DISTRICT_TOOL,
  editorLayerActivated,
  editorLayerDeactivated,
  GENERATE_PRESETS,
  isEditorOpen,
  notifyEditorInteraction,
  openEditor,
  ownedLayerName,
  ROAD_TOOL,
  setCanvasTool,
  setCoastEdge,
  setDistrictPool,
  setDistrictSnapOptions,
  setDistrictPalette,
  setDistrictType,
  setEditorActionError,
  setEditorController,
  setHubMode,
  setObjectCategory,
  setOpenSpaceProfile,
  setRoadLayout,
  setSeed,
  setTerrainMode,
  setWorkspace,
  TERRAIN_MODES,
  TOOL
} from "./editor-state.js";

const PREFS_KEY = "project-nixie:editor-prefs-v2";

function stubSessionStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  });
}

function stubCanvas(): { nixieActivate: ReturnType<typeof vi.fn>; tokensActivate: ReturnType<typeof vi.fn> } {
  const nixieActivate = vi.fn();
  const roadsActivate = vi.fn();
  const districtsActivate = vi.fn();
  const tokensActivate = vi.fn();
  vi.stubGlobal("canvas", {
    ready: true,
    nixie: { active: false, activate: nixieActivate, refresh: vi.fn() },
    "nixie-roads": { active: false, activate: roadsActivate, refresh: vi.fn() },
    "nixie-districts": { active: false, activate: districtsActivate, refresh: vi.fn() },
    tokens: { active: false, activate: tokensActivate }
  });
  return { nixieActivate, tokensActivate };
}

let controller: { onOpen: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn>; onStateChanged: ReturnType<typeof vi.fn> };

beforeEach(() => {
  stubSessionStorage();
  stubCanvas();
  controller = { onOpen: vi.fn(), onClose: vi.fn(), onStateChanged: vi.fn() };
  setEditorController(controller);
});

afterEach(() => {
  if (isEditorOpen()) closeEditor({ restoreDefaultLayer: false });
  setDistrictSnapOptions({ districtVertices: true, roadJunctions: true, blockBoundaries: true, foundryGrid: false });
  setDistrictType(DISTRICT_TYPE_IDS[0]);
  setTerrainMode("rectangle");
  setCoastEdge("west");
  setDistrictPool(DISTRICT_TYPE_IDS);
  setOpenSpaceProfile("medium");
  setSeed("nixie-2");
  setRoadLayout("european");
  setHubMode("single-centre");
  setEditorController(null);
  vi.unstubAllGlobals();
});

describe("editor open/close lifecycle", () => {
  it("opens at the Terrain workspace, activates its layer, and notifies the controller", () => {
    openEditor();
    expect(isEditorOpen()).toBe(true);
    expect(currentWorkspace()).toBe("terrain");
    expect(ownedLayerName()).toBe("nixie");
    expect(controller.onOpen).toHaveBeenCalledOnce();
  });

  it("closes, deactivates the owned layer, restores the default layer, and saves prefs", () => {
    openEditor();
    closeEditor();
    expect(isEditorOpen()).toBe(false);
    expect(ownedLayerName()).toBeNull();
    expect(controller.onClose).toHaveBeenCalledOnce();
  });

  it("refuses to open while the canvas is not ready", () => {
    const warn = vi.fn();
    vi.stubGlobal("ui", { notifications: { warn } });
    vi.stubGlobal("canvas", { ready: false, nixie: {}, tokens: {} });
    openEditor();
    expect(isEditorOpen()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("workspace switching", () => {
  it("switches the owned layer and notifies the controller", () => {
    openEditor();
    setWorkspace("roads");
    expect(currentWorkspace()).toBe("roads");
    expect(ownedLayerName()).toBe("nixie-roads");
    expect(controller.onStateChanged).toHaveBeenCalled();
  });

  it("activates the district layer and resets to a district tool", () => {
    openEditor();
    setWorkspace("districts");
    expect(currentWorkspace()).toBe("districts");
    expect(ownedLayerName()).toBe("nixie-districts");
    expect(canvasTool()).toBe(DISTRICT_TOOL.SELECT);
  });

  it("keeps district snapping preferences session-scoped and independent", () => {
    openEditor();
    setDistrictSnapOptions({ foundryGrid: true, roadJunctions: false });
    expect(districtSnapOptions()).toMatchObject({ foundryGrid: true, roadJunctions: false, districtVertices: true });
    closeEditor();
    expect(JSON.parse(sessionStorage.getItem(PREFS_KEY)!)).not.toHaveProperty("districtSnap");
    openEditor();
    expect(districtSnapOptions()).toMatchObject({ foundryGrid: true, roadJunctions: false, districtVertices: true });
  });

  it("tracks the selected palette independently and resets to a type default when type changes", () => {
    setDistrictType("night-market");
    expect(currentDistrictPalette()).toBe("night-market");
    setDistrictPalette("corporate");
    expect(currentDistrictPalette()).toBe("corporate");
    setDistrictType("waterfront");
    expect(currentDistrictPalette()).toBe("waterfront");
  });

  it("resets an incompatible tool when switching workspace", () => {
    openEditor();
    setCanvasTool(TOOL.LAND_DRAW);
    setWorkspace("roads");
    expect(canvasTool()).toBe(ROAD_TOOL.SELECT);
  });

  it("clears the layer when switching to a workspace without canvas tools", () => {
    const deactivate = vi.fn();
    vi.stubGlobal("canvas", {
      ready: true,
      nixie: { active: true, activate: vi.fn(), refresh: vi.fn(), deactivate },
      "nixie-roads": { active: false, activate: vi.fn(), refresh: vi.fn() },
      tokens: { active: false, activate: vi.fn() }
    });
    openEditor();
    setWorkspace("generate");
    expect(ownedLayerName()).toBeNull();
    expect(deactivate).toHaveBeenCalled();
  });
});

describe("layer activation hooks", () => {
  it("opens the editor when the Nixie layer activates", () => {
    editorLayerActivated("nixie");
    expect(isEditorOpen()).toBe(true);
    expect(currentWorkspace()).toBe("terrain");
  });

  it("adopts the layer's workspace when activated while open on the other layer", () => {
    openEditor();
    setWorkspace("roads");
    editorLayerActivated("nixie");
    expect(currentWorkspace()).toBe("terrain");
    expect(ownedLayerName()).toBe("nixie");
  });

  it("closes the editor when its owned layer is deactivated externally", async () => {
    openEditor();
    editorLayerDeactivated("nixie");
    expect(isEditorOpen()).toBe(true);
    await Promise.resolve();
    expect(isEditorOpen()).toBe(false);
  });

  it("does not close when a workspace switch deactivates the old layer", async () => {
    openEditor();
    setWorkspace("roads");
    editorLayerDeactivated("nixie");
    await Promise.resolve();
    expect(isEditorOpen()).toBe(true);
    expect(currentWorkspace()).toBe("roads");
  });
});

describe("session preferences", () => {
  it("restores the last workspace and tool from session storage", () => {
    openEditor();
    setCanvasTool(TOOL.FOOTPRINT_DRAW);
    setWorkspace("roads");
    setCanvasTool(ROAD_TOOL.DRAW);
    closeEditor();
    openEditor();
    expect(currentWorkspace()).toBe("roads");
    expect(canvasTool()).toBe(ROAD_TOOL.DRAW);
    expect(ownedLayerName()).toBe("nixie-roads");
  });

  it("ignores malformed persisted preferences", () => {
    sessionStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ workspace: "bogus", tool: "nope", objectCategory: "wat", roadClass: "wat", curvePreset: "wat", roadLayout: "wat", hubMode: "wat" })
    );
    openEditor();
    expect(currentWorkspace()).toBe("terrain");
    expect(canvasTool()).toBe(TOOL.LAND_EDIT);
    expect(currentObjectCategory()).toBe("buildings");
    expect(currentRoadClass()).toBe("street");
    expect(currentCurvePreset()).toBe("standard");
    expect(currentRoadLayout()).toBe("european");
    expect(currentHubMode()).toBe("single-centre");
  });

  it("persists object category and form preferences across a session", () => {
    openEditor();
    setObjectCategory("props");
    closeEditor();
    openEditor();
    expect(currentObjectCategory()).toBe("props");
  });

  it("notifies the controller on canvas draft interaction", () => {
    openEditor();
    notifyEditorInteraction();
    expect(controller.onStateChanged).toHaveBeenCalled();
  });

  it("retains action failures with affected ids until cleared", () => {
    openEditor();
    setEditorActionError("district edit", Object.assign(new Error("Locked district"), { affectedIds: ["d-1"] }));
    expect(currentEditorActionError()).toEqual({ label: "district edit", message: "Locked district", affectedIds: ["d-1"] });
    clearEditorActionError();
    expect(currentEditorActionError()).toBeNull();
  });
});

describe("Generate staging (Phase 4)", () => {
  it("exposes the built-in Full City and Coastal presets with stable ids and labels", () => {
    expect(GENERATE_PRESETS).toEqual([
      { id: "full-city", label: "Full City" },
      { id: "coastal", label: "Coastal" }
    ]);
  });

  it("stages the terrain mode, rejects unknown values, and keeps it out of prefs", () => {
    openEditor();
    setWorkspace("generate");
    expect(currentTerrainMode()).toBe("rectangle");
    setTerrainMode("coastal");
    expect(currentTerrainMode()).toBe("coastal");
    setTerrainMode("custom");
    expect(currentTerrainMode()).toBe("custom");
    // Runtime-boundary probe: the setter must ignore out-of-union values.
    setTerrainMode("bogus" as unknown as TerrainMode);
    expect(currentTerrainMode()).toBe("custom");
    expect(TERRAIN_MODES).toEqual(["rectangle", "coastal", "custom"]);
    expect(JSON.parse(sessionStorage.getItem(PREFS_KEY)!)).not.toHaveProperty("terrainMode");
  });

  it("applies the Full City preset as complete valid staging without altering the seed", () => {
    setSeed("hand-picked-seed");
    setTerrainMode("custom");
    setCoastEdge("east");
    setRoadLayout("grid");
    setHubMode("multiple-hubs");
    setDistrictPool(["old-city"]);
    setOpenSpaceProfile("none");
    expect(applyGeneratePreset("full-city")).toBe(true);
    expect(currentTerrainMode()).toBe("rectangle");
    expect(currentCoastEdge()).toBe("east");
    expect(currentRoadLayout()).toBe("european");
    expect(currentHubMode()).toBe("single-centre");
    expect(currentDistrictPool()).toEqual([...DISTRICT_TYPE_IDS]);
    expect(currentOpenSpaceProfile()).toBe("medium");
    expect(currentSeed()).toBe("hand-picked-seed");
  });

  it("applies the Coastal preset with coastal terrain, preserving the staged coast edge", () => {
    setCoastEdge("north");
    setRoadLayout("mixed");
    setHubMode("multiple-hubs");
    setDistrictPool(["old-city"]);
    setOpenSpaceProfile("none");
    expect(applyGeneratePreset("coastal")).toBe(true);
    expect(currentTerrainMode()).toBe("coastal");
    expect(currentCoastEdge()).toBe("north");
    expect(currentRoadLayout()).toBe("european");
    expect(currentHubMode()).toBe("single-centre");
    expect(currentDistrictPool()).toEqual([...DISTRICT_TYPE_IDS]);
    expect(currentOpenSpaceProfile()).toBe("medium");
    expect(currentSeed()).toBe("nixie-2");
  });

  it("rejects an unknown preset id without changing staged settings", () => {
    setTerrainMode("coastal");
    setDistrictPool(["old-city"]);
    // Runtime-boundary probe: unknown preset ids must be rejected without staging changes.
    expect(applyGeneratePreset("bogus" as unknown as GeneratePresetId)).toBe(false);
    expect(currentTerrainMode()).toBe("coastal");
    expect(currentDistrictPool()).toEqual(["old-city"]);
  });

  it("keeps staged Generate fields out of persisted editor prefs", () => {
    openEditor();
    setWorkspace("generate");
    applyGeneratePreset("coastal");
    setTerrainMode("custom");
    setCoastEdge("east");
    setDistrictPool(["old-city", "waterfront"]);
    setOpenSpaceProfile("low");
    setSeed("hand-picked-seed");
    const persisted = JSON.parse(sessionStorage.getItem(PREFS_KEY)!) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("terrainMode");
    expect(persisted).not.toHaveProperty("coastEdge");
    expect(persisted).not.toHaveProperty("districtPool");
    expect(persisted).not.toHaveProperty("openSpaceProfile");
    expect(persisted).not.toHaveProperty("seed");
  });

  it("retains staged Generate settings across workspace switches and editor close", () => {
    openEditor();
    setWorkspace("generate");
    setTerrainMode("coastal");
    applyGeneratePreset("coastal");
    setWorkspace("terrain");
    expect(currentTerrainMode()).toBe("coastal");
    expect(currentSeed()).toBe("nixie-2");
    setWorkspace("generate");
    expect(currentTerrainMode()).toBe("coastal");
    expect(currentCoastEdge()).toBe("west");
    closeEditor();
    expect(currentTerrainMode()).toBe("coastal");
    openEditor();
    expect(currentTerrainMode()).toBe("coastal");
  });

  it("starts each browser session with default Generate staging", async () => {
    openEditor();
    setTerrainMode("coastal");
    setCoastEdge("east");
    setDistrictPool(["old-city"]);
    setOpenSpaceProfile("high");
    setSeed("session-seed");
    // Test-only: a fresh module instance simulates a new browser session; a static import
    // would keep reusing the mutated instance, so the module boundary must be exercised.
    vi.resetModules();
    const fresh = await import("./editor-state.js");
    expect(fresh.currentTerrainMode()).toBe("rectangle");
    expect(fresh.currentCoastEdge()).toBe("west");
    expect(fresh.currentDistrictPool()).toEqual([...fresh.DISTRICT_TYPE_IDS]);
    expect(fresh.currentOpenSpaceProfile()).toBe("medium");
    expect(fresh.currentSeed()).toBe("nixie-2");
    expect(fresh.currentRoadLayout()).toBe("european");
    expect(fresh.currentHubMode()).toBe("single-centre");
  });
});
