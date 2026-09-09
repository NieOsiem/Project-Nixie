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
  bulkDeleteObjects: vi.fn(() => Promise.resolve({ full: true })),
  bulkEditObjects: vi.fn(() => Promise.resolve({ full: true })),
  bulkSetObjectsLocked: vi.fn(() => Promise.resolve({ full: true })),
  cityLoadStatus: vi.fn(() => ({ kind: "supported" })),
  deleteObject: vi.fn(() => Promise.resolve({ full: true })),
  editObjectProperties: vi.fn(() => Promise.resolve({ full: true })),
  getArchitecturePlanView: vi.fn<() => unknown>(() => null),
  getArchitectureSource: vi.fn(),
  getCity: vi.fn(() => ({ revision: 4 })),
  getRouteEditStatus: vi.fn<() => unknown>(() => null),
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
  getObjectRouteFeedback: vi.fn<() => unknown>(() => null),
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
      id: "building-c",
      kind: "building",
      label: "Twin shopfront",
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
  adapterMocks.getArchitecturePlanView.mockReturnValue(null);
  adapterMocks.getArchitectureSource.mockReturnValue(architecture);
  adapterMocks.getCity.mockReturnValue({ revision: 4 });
  adapterMocks.getRouteEditStatus.mockReturnValue(null);
  adapterMocks.isSceneEnabled.mockReturnValue(true);
  adapterMocks.bulkDeleteObjects.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.bulkEditObjects.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.bulkSetObjectsLocked.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.editObjectProperties.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.deleteObject.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.rerollObjectAppearance.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.setObjectLocked.mockImplementation(() => Promise.resolve({ full: true }));
  stateMocks.canvasTool.mockReturnValue("select");
  stateMocks.currentObjectCategory.mockReturnValue("buildings");
  stateMocks.currentPendingOperation.mockReturnValue(null);
  objectLayerMocks.getObjectSelection.mockReturnValue({ ids: [], kind: null });
  objectLayerMocks.getObjectRouteFeedback.mockReturnValue(null);
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
describe("Objects workspace bulk editing", () => {
  const mixedSelection = { ids: ["building-a", "building-b"], kind: "building" as const };
  const derivedPlanView = () => ({
    buildings: [{
      id: "derived-1",
      kind: "building",
      grammarId: "narrow-shopfront",
      visualUse: "commercial",
      heightM: 30,
      paletteId: null,
      protection: "none",
      sitePolygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 12 }, { x: 0, y: 12 }],
      placement: { centre: { x: 5, y: 6 }, rotationRad: 0, widthM: 10, depthM: 12 }
    }],
    landmarks: []
  });

  function multiTray(ids: string[], kind: "building" | "place" = "building"): string {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids, kind });
    return objectsWorkspace().renderTray();
  }

  it("renders shared fields with Multiple for mixed values and keeps gizmos and reroll disabled", () => {
    const html = multiTray(mixedSelection.ids);
    expect(html).toContain('data-panel="objects-multi"');
    expect(html).toContain("2 buildings selected");
    expect(html).toContain(">Multiple</option>");
    expect(html).toContain(">Multiple</output>");
    expect(html).toContain('value="multiple" selected');
    expect(html).toContain("transform gizmos are disabled");
    expect(html).not.toContain('data-action="object-reroll"');
    expect(html).not.toContain('data-action="object-site"');
    expect(html).not.toContain("lasso");
    expect(html).not.toContain("Drag-box");
  });

  it("offers no height edit for disjoint grammar ranges until a shared preset is staged", () => {
    adapterMocks.getArchitectureSource.mockReturnValue({
      ...architecture,
      buildings: architecture.buildings.map((building) => ({
        ...building,
        grammarId: building.id === "building-a" ? "corporate-chamfered-tower" : "street-kiosk"
      }))
    });
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    const module = objectsWorkspace();
    expect(module.renderTray()).not.toContain('data-field="object-height"');
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-grammar"]', "garage-unit");
    expect(module.renderTray()).toContain('data-field="object-height"');
  });

  it("discards staged bulk edits on Reset without committing them", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-height"]', "40");
    module.onAction("object-reset", {} as HTMLElement, ctx);
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).not.toHaveBeenCalled();
    expect(module.renderTray()).toContain(">Multiple</output>");
  });

  it("applies only explicitly staged shared fields with the captured revision in one bulk call", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-palette"]', "corporate");
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).toHaveBeenCalledTimes(1);
    expect(adapterMocks.bulkEditObjects).toHaveBeenCalledWith(["building-a", "building-b"], { paletteId: "corporate" }, 4);
    expect(adapterMocks.editObjectProperties).not.toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledTimes(1);
  });

  it("stages shared fields for same-value selections and never includes untouched mixed fields", () => {
    const html = multiTray(["building-a", "building-c"]);
    expect(html).toContain('value="narrow-shopfront" selected');
    expect(html).toContain('value="commercial" selected');
    expect(html).not.toContain(">Multiple</option>");
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    objectsWorkspace().onRender(root, ctx);
    triggerControl(controls, '[data-field="object-use"]', "entertainment");
    objectsWorkspace().onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).toHaveBeenCalledWith(["building-a", "building-c"], { visualUse: "entertainment" }, 4);
  });

  it("discloses promotion of derived objects to protected persistent records before Apply", () => {
    adapterMocks.getArchitecturePlanView.mockReturnValue(derivedPlanView());
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a", "derived-1"], kind: "building" });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-height"]', "40");
    const html = module.renderTray();
    expect(html).toContain("promote these derived buildings to protected persistent records");
    expect(html).toContain("derived-1");
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).toHaveBeenCalledWith(["building-a", "derived-1"], { heightM: 40 }, 4);
  });

  it("discloses protected sparse overrides for palette-only derived edits without promotion", () => {
    adapterMocks.getArchitecturePlanView.mockReturnValue(derivedPlanView());
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a", "derived-1"], kind: "building" });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-palette"]', "corporate");
    const html = module.renderTray();
    expect(html).toContain("protected manual-edit overrides");
    expect(html).not.toContain("promote these derived");
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).toHaveBeenCalledWith(["building-a", "derived-1"], { paletteId: "corporate" }, 4);
  });

  it("keeps bulk delete persistent-only and deletes the whole eligible selection once", () => {
    adapterMocks.getArchitecturePlanView.mockReturnValue(derivedPlanView());
    const module = objectsWorkspace();
    const ctx = fakeContext();
    expect(multiTray(["building-a", "derived-1"])).toContain('data-action="object-delete" disabled');
    expect(multiTray(["building-a", "derived-1"])).toContain("persistent-only");
    module.onAction("object-delete", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkDeleteObjects).not.toHaveBeenCalled();

    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    expect(module.renderTray()).not.toContain('data-action="object-delete" disabled');
    module.onAction("object-delete", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkDeleteObjects).toHaveBeenCalledTimes(1);
    expect(adapterMocks.bulkDeleteObjects).toHaveBeenCalledWith(["building-a", "building-b"], 4);
  });

  it("locks the whole selection through one call with the explicit protection statement", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    const module = objectsWorkspace();
    const html = module.renderTray();
    expect(html).toContain("Lock all");
    expect(html).toContain("Protection is never changed silently");
    const ctx = fakeContext();
    module.onAction("object-lock", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkSetObjectsLocked).toHaveBeenCalledTimes(1);
    expect(adapterMocks.bulkSetObjectsLocked).toHaveBeenCalledWith(["building-a", "building-b"], true, 4);
  });

  it("lists every rejected id and reason durably when the whole selection is rejected", async () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    adapterMocks.bulkSetObjectsLocked.mockRejectedValueOnce(Object.assign(new Error("Bulk architecture action rejected"), {
      blockers: [{ id: "building-b", kind: "building", reason: "The architecture object is locked." }]
    }));
    const module = objectsWorkspace();
    const ctx = fakeContext();
    module.onAction("object-lock", {} as HTMLElement, ctx);
    const runCall = ctx.run.mock.calls[0]!;
    // The tracked promise records blockers before the runner's promise rejects,
    // so awaiting that exact rejection is the deterministic flush signal.
    await expect(runCall[1] as Promise<unknown>).rejects.toThrow("Bulk architecture action rejected");
    const html = module.renderTray();
    expect(html).toContain("Bulk action rejected for the whole selection");
    expect(html).toContain("building-b");
    expect(html).toContain("The architecture object is locked.");
  });

  it("drops stale bulk drafts when the selection or category changes", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    const module = objectsWorkspace();
    const { root, controls } = fakeInspectorRoot();
    const ctx = fakeContext();
    module.onRender(root, ctx);
    triggerControl(controls, '[data-field="object-height"]', "40");
    expect(module.renderTray()).toContain('value="40"');

    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    expect(module.renderTray()).toContain('data-panel="objects-inspector"');
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).not.toHaveBeenCalled();

    triggerControl(controls, '[data-field="object-height"]', "42");
    module.onAction("object-category", { dataset: { category: "places" } } as unknown as HTMLElement, ctx);
    objectLayerMocks.getObjectSelection.mockReturnValue({ ...mixedSelection });
    module.onAction("object-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.bulkEditObjects).not.toHaveBeenCalled();
  });

  it("surfaces live route warnings and committed trim, removal, and disconnection durably", () => {
    objectLayerMocks.getObjectSelection.mockReturnValue({ ids: ["building-a"], kind: "building" });
    objectLayerMocks.getObjectRouteFeedback.mockReturnValue({
      kind: "building",
      targetId: "building-a",
      provisional: true,
      conflicts: [{ edgeId: "edge-1", kind: "road", reason: "crosses the corridor", blockedArcM: [], processable: true }],
      blockers: [{ id: "edge-9", kind: "road", reason: "edge is locked" }]
    });
    adapterMocks.getRouteEditStatus.mockReturnValue({
      conflicts: [],
      blockers: [],
      trimmedEdgeIds: ["edge-3"],
      removedEdgeIds: ["edge-4"],
      disconnectedVehicleNetwork: true
    });
    const html = objectsWorkspace().renderTray();
    expect(html).toContain('data-panel="objects-route-status"');
    expect(html).toContain("Route preview: road edges");
    expect(html).toContain("edge-1");
    expect(html).toContain("Locked road edges block this edit");
    expect(html).toContain("edge-9");
    expect(html).toContain("Committed route trim: edge-3");
    expect(html).toContain("Committed route removal: edge-4");
    expect(html).toContain("warning, not a rejection");
  });
});
