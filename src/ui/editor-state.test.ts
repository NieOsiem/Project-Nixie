import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canvasTool,
  closeEditor,
  currentCurvePreset,
  currentHubMode,
  currentObjectCategory,
  currentRoadClass,
  currentRoadLayout,
  currentWorkspace,
  editorLayerActivated,
  editorLayerDeactivated,
  isEditorOpen,
  openEditor,
  ownedLayerName,
  ROAD_TOOL,
  setCanvasTool,
  setEditorController,
  setObjectCategory,
  setWorkspace,
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
  const tokensActivate = vi.fn();
  vi.stubGlobal("canvas", {
    ready: true,
    nixie: { active: false, activate: nixieActivate, refresh: vi.fn() },
    "nixie-roads": { active: false, activate: roadsActivate, refresh: vi.fn() },
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
});
