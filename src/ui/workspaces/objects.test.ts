import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { WorkspaceContext } from "./types.js";

type ObjectCategoryFixture = "buildings" | "places" | "props" | "pois";
interface ObjectSelectionFixture {
  ids: string[];
  kind: "building" | "place" | null;
}
interface ObjectErrorFixture {
  label: string;
  message: string;
  affectedIds: string[];
}
type WorkspaceContextFixture = {
  rerender: Mock<WorkspaceContext["rerender"]>;
  run: Mock<WorkspaceContext["run"]>;
};

const adapterMocks = vi.hoisted(() => ({
  cityLoadStatus: vi.fn(() => ({ kind: "supported" })),
  deleteObject: vi.fn(() => Promise.resolve({ full: true })),
  editObjectProperties: vi.fn(() => Promise.resolve({ full: true })),
  getArchitectureSource: vi.fn(),
  isSceneEnabled: vi.fn(() => true),
  rerollObjectAppearance: vi.fn(() => Promise.resolve({ full: true })),
  setObjectLocked: vi.fn(() => Promise.resolve({ full: true }))
}));
const stateMocks = vi.hoisted(() => ({
  OBJECT_TOOL: { SELECT: "select", PLACE: "place", SITE: "site" },
  canvasTool: vi.fn<() => string | null>(() => "select"),
  currentObjectCategory: vi.fn<() => ObjectCategoryFixture>(() => "buildings"),
  currentPendingOperation: vi.fn<() => string | null>(() => null),
  setCanvasTool: vi.fn(),
  setObjectCategory: vi.fn(),
  setObjectStagingClearListener: vi.fn()
}));
const objectLayerMocks = vi.hoisted(() => ({
  cancelObjectPlacement: vi.fn(),
  clearObjectSelection: vi.fn(),
  configureObjectPlacement: vi.fn(),
  finishObjectPlacement: vi.fn(() => Promise.resolve(true)),
  getObjectError: vi.fn<() => ObjectErrorFixture | null>(() => null),
  getObjectSelection: vi.fn<() => ObjectSelectionFixture>(() => ({ ids: [], kind: null })),
  objectInspector: vi.fn<() => unknown>(() => null),
  setObjectsWorkspaceBridge: vi.fn()
}));

vi.mock("../../adapter/canvas.js", () => adapterMocks);
vi.mock("../editor-state.js", () => stateMocks);
vi.mock("../objects-layer.js", () => objectLayerMocks);

import { BUILDING_GRAMMARS } from "../../core/gen/building-registry.js";
import { LANDMARK_GRAMMARS } from "../../core/gen/landmark-registry.js";
import {
  architecturePreview,
  architecturePreviewCacheSize,
  architecturePreviewSVG,
  clearArchitecturePreviewCache
} from "../architecture-preview.js";
import {
  clearObjectsWorkspaceState,
  objectCatalogueEntries,
  objectCatalogueGroupNames,
  objectsWorkspace,
  objectsWorkspaceCatalogueHTML
} from "./objects.js";

const architecture = {
  buildings: [
    {
      id: "building-a",
      kind: "building",
      label: "Shopfront",
      grammarId: "narrow-shopfront",
      visualUse: "commercial",
      heightM: 30,
      paletteId: null,
      protection: "generated",
      origin: "manual"
    },
    {
      id: "building-b",
      kind: "building",
      label: "Residential slab",
      grammarId: "residential-slab",
      visualUse: "residential",
      heightM: 24,
      paletteId: "corporate",
      protection: "generated",
      origin: "manual"
    }
  ],
  places: [
    {
      id: "place-a",
      kind: "place",
      label: "Hero Tower",
      landmarkGrammarId: "hero-tower-plaza",
      paletteId: null,
      protection: "generated",
      origin: "manual"
    }
  ]
};

type FakeControl = {
  disabled: boolean;
  listener?: (event: Event) => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
};

function fakeInspectorRoot(): { root: HTMLElement; controls: Map<string, FakeControl> } {
  const controls = new Map<string, FakeControl>();
  const root = {
    querySelector(selector: string): FakeControl {
      const existing = controls.get(selector);
      if (existing !== undefined) return existing;
      const control: FakeControl = {
        disabled: false,
        addEventListener(type: string, listener: (event: Event) => void): void {
          if (type === "change" || type === "input") control.listener = listener;
        }
      };
      controls.set(selector, control);
      return control;
    }
  };
  return { root: root as unknown as HTMLElement, controls };
}

function triggerControl(controls: Map<string, FakeControl>, selector: string, value: string): void {
  const control = controls.get(selector);
  if (control?.listener !== undefined) control.listener({ target: { value } } as unknown as Event);
}

function fakeContext(): WorkspaceContextFixture {
  return { rerender: vi.fn<WorkspaceContext["rerender"]>(), run: vi.fn<WorkspaceContext["run"]>() };
}


beforeEach(() => {
  vi.clearAllMocks();
  clearObjectsWorkspaceState();
  adapterMocks.cityLoadStatus.mockReturnValue({ kind: "supported" });
  adapterMocks.getArchitectureSource.mockReturnValue(architecture);
  adapterMocks.isSceneEnabled.mockReturnValue(true);
  adapterMocks.editObjectProperties.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.deleteObject.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.rerollObjectAppearance.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.setObjectLocked.mockImplementation(() => Promise.resolve({ full: true }));
  stateMocks.canvasTool.mockReturnValue("select");
  stateMocks.currentObjectCategory.mockReturnValue("buildings");
  stateMocks.currentPendingOperation.mockReturnValue(null);
  objectLayerMocks.getObjectSelection.mockReturnValue({ ids: [], kind: null });
  objectLayerMocks.objectInspector.mockReturnValue(null);
  objectLayerMocks.getObjectError.mockReturnValue(null);
});

describe("Objects workspace catalogue", () => {
  it("derives the complete building and place breadth from registries", () => {
    const buildings = objectCatalogueEntries("buildings");
    const places = objectCatalogueEntries("places");
    expect(buildings.map((entry) => entry.id)).toEqual(BUILDING_GRAMMARS.map((entry) => entry.id));
    expect(places.map((entry) => entry.id)).toEqual(LANDMARK_GRAMMARS.map((entry) => entry.id));
    expect(objectCatalogueGroupNames("buildings").length).toBeGreaterThan(1);
    expect(objectCatalogueGroupNames("places")).toEqual(expect.arrayContaining(["Towers & Spires", "Infrastructure & Utility"]));
  });

  it("caches normalized silhouettes and renders labeled SVG", () => {
    clearArchitecturePreviewCache();
    const first = architecturePreview("building", BUILDING_GRAMMARS[0]!);
    expect(architecturePreview("building", BUILDING_GRAMMARS[0]!)).toBe(first);
    expect(first.polygons.length).toBeGreaterThan(0);
    const svg = architecturePreviewSVG("place", LANDMARK_GRAMMARS[0]!);
    expect(svg).toContain("<svg");
    expect(svg).toContain("role=\"img\"");
    expect(svg).toContain("aria-label=");
    expect(svg).not.toContain("<script");
    expect(architecturePreviewCacheSize()).toBe(2);
  });

  it("renders one accessible shape group at a time and keeps each category's group in session state", () => {
    const buildingGroups = objectCatalogueGroupNames("buildings");
    const buildingEntries = objectCatalogueEntries("buildings");
    const firstBuilding = buildingEntries.find((entry) => entry.group === buildingGroups[0])!;
    const secondBuilding = buildingEntries.find((entry) => entry.group === buildingGroups[1])!;
    const initial = objectsWorkspaceCatalogueHTML("buildings");
    expect(initial).toContain('data-field="object-catalogue-group"');
    expect(initial).toContain('aria-label="Choose building shape family"');
    expect((initial.match(/data-catalogue-group=/g) ?? []).length).toBe(1);
    expect(initial).toContain(`data-catalogue-group="${buildingGroups[0]}"`);
    expect(initial).toContain(`data-object-id="${firstBuilding.id}"`);
    expect(initial).not.toContain(`data-object-id="${secondBuilding.id}"`);

    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-catalogue-group"]', buildingGroups[1]!);
    expect(module.renderTray()).toContain(`data-catalogue-group="${buildingGroups[1]}"`);
    expect(module.renderTray()).not.toContain(`data-object-id="${firstBuilding.id}"`);

    stateMocks.currentObjectCategory.mockReturnValue("places");
    const placeGroups = objectCatalogueGroupNames("places");
    expect(module.renderTray()).toContain(`data-catalogue-group="${placeGroups[0]!.replaceAll("&", "&#38;")}"`);
    triggerControl(controls, '[data-field="object-catalogue-group"]', placeGroups[1]!);
    expect(module.renderTray()).toContain(`data-catalogue-group="${placeGroups[1]!.replaceAll("&", "&#38;")}"`);
    stateMocks.currentObjectCategory.mockReturnValue("buildings");
    expect(module.renderTray()).toContain(`data-catalogue-group="${buildingGroups[1]}"`);
  });

  it("marks the selected catalogue preset active and exposes an explicit placement confirmation", () => {
    const entry = objectCatalogueEntries("buildings")[0]!;
    const module = objectsWorkspace();
    const ctx = fakeContext();
    module.onAction("object-preset", { dataset: { objectKind: entry.kind, objectId: entry.id } } as unknown as HTMLElement, ctx);
    stateMocks.canvasTool.mockReturnValue("place");
    const html = module.renderShelf() + module.renderTray();
    expect(html).toContain(`data-object-id="${entry.id}"`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Preset active:");
    expect(html).toContain('data-action="object-place-confirm"');
    expect(html).toContain("Double-click the canvas or Place here to confirm");
    expect(objectLayerMocks.configureObjectPlacement).toHaveBeenCalled();
    expect(stateMocks.setCanvasTool.mock.invocationCallOrder[0]).toBeLessThan(objectLayerMocks.configureObjectPlacement.mock.invocationCallOrder[0]!);

    module.onAction("object-place-confirm", {} as HTMLElement, ctx);
    expect(objectLayerMocks.finishObjectPlacement).toHaveBeenCalledOnce();
  });

  it("renders active and disabled category controls accessibly", () => {
    const shelf = objectsWorkspace().renderShelf();
    expect(shelf).toContain('data-category="buildings"');
    expect(shelf).toContain('data-category="places"');
    expect(shelf).toContain('data-category="props" disabled');
    expect(shelf).toContain("Phase 7");
    expect(shelf).toContain("Phase 8");
    const catalogue = objectsWorkspaceCatalogueHTML("buildings");
    expect(catalogue).toContain('data-panel="objects-catalogue"');
    expect(catalogue).toContain("nixie-architecture-preview");
    expect(catalogue).toContain('aria-label=');
  });
});

describe("Objects workspace selection and inspector workflows", () => {
  it("filters building presets by site frame, area, and aspect while limiting uses", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    objectLayerMocks.objectInspector.mockReturnValue({
      id: "building-a",
      kind: "building",
      derived: false,
      locked: false,
      plan: {
        id: "building-a",
        kind: "building",
        grammarId: "narrow-shopfront",
        visualUse: "commercial",
        heightM: 30,
        paletteId: null,
        placement: { centre: { x: 20, y: 20 }, rotationRad: 0, widthM: 12, depthM: 20 },
        sitePolygon: [{ x: 14, y: 10 }, { x: 26, y: 10 }, { x: 26, y: 30 }, { x: 14, y: 30 }]
      }
    });
    const html = objectsWorkspace().renderTray();
    expect(html).toContain('value="narrow-shopfront" selected');
    expect(html).toContain('value="residential-slab"');
    expect(html).not.toContain('value="civic-pavilion"');
    expect(html).toContain('value="commercial" selected');
    expect(html).not.toContain('value="residential"');
    expect(html).toContain('value="corporate"');
  });

  it("normalizes staged use and height when a compatible preset changes", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    objectLayerMocks.objectInspector.mockReturnValue({
      id: "building-a",
      kind: "building",
      derived: true,
      locked: false,
      plan: {
        id: "building-a",
        kind: "building",
        grammarId: "narrow-shopfront",
        visualUse: "commercial",
        heightM: 10,
        paletteId: null
      }
    });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-grammar"]', "residential-slab");
    const html = module.renderTray();
    expect(html).toContain('value="residential-slab" selected');
    expect(html).toContain('value="residential" selected');
    expect(html).toContain('min="30" max="170" step="1" value="30" data-field="object-height"');
    expect(ctx.rerender).toHaveBeenCalled();
  });

  it("anchors the derived draft on the actual grammar and applies height-only edits as such", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    objectLayerMocks.objectInspector.mockReturnValue({
      id: "building-a",
      kind: "building",
      derived: true,
      locked: false,
      plan: {
        id: "building-a",
        kind: "building",
        grammarId: "residential-slab",
        visualUse: "residential",
        heightM: 44,
        paletteId: null,
        areaM2: 120,
        placement: { centre: { x: 20, y: 20 }, rotationRad: 0.4, widthM: 9, depthM: 16 },
        sitePolygon: [{ x: 14, y: 10 }, { x: 26, y: 10 }, { x: 26, y: 30 }, { x: 14, y: 30 }]
      }
    });
    const module = objectsWorkspace();
    const html = module.renderTray();
    expect(html).toContain('value="residential-slab" selected');
    expect(html).toContain('value="residential" selected');
    expect(html).not.toContain('value="commercial" selected');
    expect(html).toContain('min="30" max="170" step="1" value="44" data-field="object-height"');

    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-height"]', "50");
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.editObjectProperties).toHaveBeenCalledTimes(1);
    expect(adapterMocks.editObjectProperties).toHaveBeenCalledWith("building-a", { heightM: 50 });
  });

  it("renders a same-kind multi-selection as summary-only and blocks mutations", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a", "building-b"], kind: "building" });
    const module = objectsWorkspace();
    const html = module.renderTray();
    expect(html).toContain('data-panel="objects-multi"');
    expect(html).toContain("2 buildings selected");
    expect(html).toContain("Summary only");
    expect(html).toContain("transform gizmos are disabled");

    const ctx = fakeContext();
    for (const action of ["object-apply", "object-reset", "object-lock", "object-reroll", "object-delete", "object-site"]) {
      module.onAction(action, {} as HTMLElement, ctx);
    }
    expect(adapterMocks.editObjectProperties).not.toHaveBeenCalled();
    expect(adapterMocks.setObjectLocked).not.toHaveBeenCalled();
    expect(adapterMocks.rerollObjectAppearance).not.toHaveBeenCalled();
    expect(adapterMocks.deleteObject).not.toHaveBeenCalled();
    expect(ctx.run).not.toHaveBeenCalled();
  });

  it("stages inspector fields and applies one combined patch through the workspace runner", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-grammar"]', "civic-pavilion");
    triggerControl(controls, '[data-field="object-use"]', "commercial");
    triggerControl(controls, '[data-field="object-height"]', "42");
    triggerControl(controls, '[data-field="object-palette"]', "corporate");
    expect(module.renderTray()).toContain('value="civic-pavilion" selected');
    expect(module.renderTray()).toContain('value="commercial" selected');
    expect(module.renderTray()).toContain('value="42"');

    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.editObjectProperties).toHaveBeenCalledWith("building-a", {
      grammarId: "civic-pavilion",
      heightM: 42,
      paletteId: "corporate"
    });
    expect(ctx.run).toHaveBeenCalledWith("object changes", expect.any(Promise), expect.any(Function));
    const run = ctx.run.mock.calls[0]!;
    run[2]!();
    expect(module.renderTray()).not.toContain('value="civic-pavilion" selected');
  });

  it("retains the selected inspector while a change is pending and disables controls", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-height"]', "48");
    stateMocks.currentPendingOperation.mockReturnValue("object changes");
    const html = module.renderTray();
    expect(html).toContain('data-panel="objects-inspector"');
    expect(html).toContain('data-status-kind="pending"');
    expect(html).toContain('data-field="object-height" disabled');
    for (const field of ["object-grammar", "object-use", "object-height", "object-palette"]) {
      expect(html).toContain(`data-field="${field}"`);
      expect(html).toMatch(new RegExp(`data-field="${field}"[^>]*\\bdisabled\\b`));
    }
    for (const action of ["object-apply", "object-reset", "object-lock", "object-reroll", "object-delete"]) {
      expect(html).toMatch(new RegExp(`data-action="${action}"[^>]*\\bdisabled\\b`));
    }
    expect(html).toContain('data-action="object-apply" disabled');
    expect(html).toContain("applying the object change");
  });

  it("shows a durable site error with affected-object status cues", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: [], kind: null });
    objectLayerMocks.getObjectError.mockReturnValue({
      label: "site edit",
      message: "Polygon intersects a road",
      affectedIds: ["building-a"]
    });
    const html = objectsWorkspace().renderTray();
    expect(html).toContain('data-panel="objects-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Polygon intersects a road");
    expect(html).toContain("Affected objects: building-a");
  });

  it("clears inspector staging when changing category or leaving the placement tool", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-grammar"]', "civic-pavilion");
    expect(module.renderTray()).toContain('value="civic-pavilion" selected');

    module.onAction("object-category", { dataset: { category: "places" } } as unknown as HTMLElement, ctx);
    expect(objectLayerMocks.cancelObjectPlacement).toHaveBeenCalled();
    expect(stateMocks.setObjectCategory).toHaveBeenCalledWith("places");
    expect(stateMocks.setCanvasTool).toHaveBeenCalledWith("select");
    expect(module.renderTray()).not.toContain('value="civic-pavilion" selected');

    module.onAction("tool", { dataset: { tool: "select" } } as unknown as HTMLElement, ctx);
    expect(objectLayerMocks.cancelObjectPlacement).toHaveBeenCalledTimes(2);
    expect(stateMocks.setCanvasTool).toHaveBeenLastCalledWith("select");
  });
  it("clears an incompatible selection and renders the destination catalogue on category change", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    const module = objectsWorkspace();
    expect(module.renderTray()).toContain('data-panel="objects-inspector"');
    const ctx = fakeContext();
    module.onAction("object-category", { dataset: { category: "places" } } as unknown as HTMLElement, ctx);
    expect(objectLayerMocks.cancelObjectPlacement).toHaveBeenCalledOnce();
    expect(objectLayerMocks.clearObjectSelection).toHaveBeenCalledOnce();
    expect(stateMocks.setObjectCategory).toHaveBeenCalledWith("places");
    expect(stateMocks.setCanvasTool).toHaveBeenCalledWith("select");
    expect(ctx.rerender).toHaveBeenCalledOnce();

    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: [], kind: null });
    stateMocks.currentObjectCategory.mockReturnValue("places");
    const tray = module.renderTray();
    expect(tray).toContain('data-panel="objects-catalogue"');
    expect(tray).toContain("<h3>Places</h3>");
    expect(tray).not.toContain('data-panel="objects-inspector"');
    expect(tray).not.toContain('data-panel="objects-multi"');

    const selectionsCleared = objectLayerMocks.clearObjectSelection.mock.calls.length;
    const rerenders = ctx.rerender.mock.calls.length;
    module.onAction("object-category", { dataset: { category: "places" } } as unknown as HTMLElement, ctx);
    expect(objectLayerMocks.clearObjectSelection).toHaveBeenCalledTimes(selectionsCleared);
    expect(stateMocks.setObjectCategory).toHaveBeenCalledTimes(1);
    expect(ctx.rerender).toHaveBeenCalledTimes(rerenders);
  });
});
