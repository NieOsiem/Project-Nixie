import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MultiPolygon, Ring } from "../core/geom/types.js";

type CityViewFixture = {
  revision: number;
  source: {
    terrain: {
      land: Ring;
      urbanFootprint: Ring;
    };
  };
};

type PlanViewFixture = {
  buildings: Array<{
    id: string;
    sourceId: string | null;
    protection?: "none" | "manual-edit" | "explicit";
    sitePolygon: Ring;
  }>;
  landmarks: Array<{
    id: string;
    sourceId: string | null;
    protection?: "none" | "manual-edit" | "explicit";
    sitePolygon: Ring;
  }>;
  routeOccupancy: {
    all: MultiPolygon;
  };
};

const cityListenerState = vi.hoisted(() => ({
  listener: null as (() => void) | null
}));
const stateMocks = vi.hoisted(() => ({
  canvasTool: vi.fn<() => string | null>(() => "select"),
  editorLayerActivated: vi.fn(),
  editorLayerDeactivated: vi.fn(),
  notifyEditorInteraction: vi.fn(),
  setCanvasTool: vi.fn<(next: string | null) => void>(),
  setEditorActionError: vi.fn(),
  clearEditorActionError: vi.fn()
}));
const adapterMocks = vi.hoisted(() => ({
  addCityListener: vi.fn((listener: () => void) => {
    cityListenerState.listener = listener;
    return () => {
      if (cityListenerState.listener === listener) cityListenerState.listener = null;
    };
  }),
  editSitePolygon: vi.fn(() => Promise.resolve({ full: true })),
  getArchitecturePlanView: vi.fn<() => PlanViewFixture | null>(() => null),
  getCity: vi.fn<() => CityViewFixture | null>(() => null),
  isSceneEnabled: vi.fn(() => false),
  metresToWorld: vi.fn((point: { x: number; y: number }) => ({ ...point })),
  placeBuilding: vi.fn(() => Promise.resolve({ full: true })),
  placePlace: vi.fn(() => Promise.resolve({ full: true })),
  transformObject: vi.fn(() => Promise.resolve({ full: true })),
  worldToMetres: vi.fn((point: { x: number; y: number }) => ({ ...point }))
}));

vi.mock("../adapter/canvas.js", async (importOriginal) => ({
  ...await importOriginal(),
  ...adapterMocks
}));
vi.mock("./editor-state.js", async (importOriginal) => ({
  ...await importOriginal(),
  ...stateMocks,
  LAYER_OBJECTS: "nixie-objects",
  OBJECT_TOOL: { SELECT: "select", PLACE: "place", SITE: "site" }
}));

import {
  architectureObjectAt,
  clearObjectError,
  clearObjectSelection,
  configureObjectPlacement,
  finishObjectPlacement,
  getObjectError,
  getObjectSelection,
  hasObjectDraft,
  objectsLayerClass,
  objectPlacementPreview,
  setObjectsWorkspaceBridge,
  transformObjectSelection
} from "./objects-layer.js";

const city: CityViewFixture = {
  revision: 1,
  source: {
    terrain: {
      land: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      urbanFootprint: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
    }
  }
};
const plan: PlanViewFixture = {
  buildings: [
    { id: "building-a", sourceId: "building-a", sitePolygon: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] },
    { id: "building-b", sourceId: null, sitePolygon: [{ x: 50, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 30 }, { x: 50, y: 30 }] }
  ],
  landmarks: [{ id: "place-a", sourceId: "place-a", sitePolygon: [{ x: 10, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 70 }, { x: 10, y: 70 }] }],
  routeOccupancy: { all: [] }
};

class Graphics {
  static instances: Graphics[] = [];
  readonly fills: Array<{ color: number; alpha?: number }> = [];
  readonly lineStyles: unknown[] = [];
  moveCalls = 0;
  eventMode = "none";
  constructor() { Graphics.instances.push(this); }
  clear(): void {
    this.fills.length = 0;
    this.lineStyles.length = 0;
    this.moveCalls = 0;
  }
  beginFill(color: number, alpha?: number): void { this.fills.push({ color, alpha }); }
  endFill(): void {}
  lineStyle(style: unknown): void { this.lineStyles.push(style); }
  moveTo(): void { this.moveCalls += 1; }
  lineTo(): void {}
}
class InteractionLayer {
  active = true;
  visible = true;
  addChild<T>(child: T): T { return child; }
  async _draw(): Promise<void> {}
  async _tearDown(): Promise<void> {}
}

function event(x: number, y: number, shiftKey = false): { getLocalPosition: () => { x: number; y: number }; shiftKey: boolean } {
  return { getLocalPosition: () => ({ x, y }), shiftKey };
}

beforeEach(() => {
  vi.clearAllMocks();
  cityListenerState.listener = null;
  Graphics.instances.length = 0;
  adapterMocks.getCity.mockReturnValue(city);
  adapterMocks.getArchitecturePlanView.mockReturnValue(plan);
  adapterMocks.isSceneEnabled.mockReturnValue(true);
  adapterMocks.editSitePolygon.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.placeBuilding.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.placePlace.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.transformObject.mockImplementation(() => Promise.resolve({ full: true }));
  adapterMocks.metresToWorld.mockImplementation((point: { x: number; y: number }) => ({ ...point }));
  adapterMocks.worldToMetres.mockImplementation((point: { x: number; y: number }) => ({ ...point }));
  stateMocks.setCanvasTool.mockImplementation((next: string | null) => { stateMocks.canvasTool.mockReturnValue(next); });
  stateMocks.canvasTool.mockReturnValue("select");
  vi.stubGlobal("foundry", { canvas: { layers: { InteractionLayer } } });
  vi.stubGlobal("InteractionLayer", InteractionLayer);
  vi.stubGlobal("PIXI", { Graphics });
  vi.stubGlobal("canvas", { stage: {}, dimensions: { size: 100 }, mouseInteractionManager: { options: {} } });
  vi.stubGlobal("Hooks", { on: vi.fn(() => "hook"), off: vi.fn() });
  vi.stubGlobal("ui", { notifications: { error: vi.fn(), warn: vi.fn() } });
  setObjectsWorkspaceBridge(null);
  clearObjectError();
  clearObjectSelection();
});

afterEach(() => {
  setObjectsWorkspaceBridge(null);
  vi.unstubAllGlobals();
});


describe("object geometry and interaction", () => {
  it("builds a rotated frame around the requested centre and rejects an out-of-bounds ghost", () => {
    const valid = objectPlacementPreview({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 }, { x: 50, y: 50 }, city, { ...plan, buildings: [], landmarks: [] });
    expect(valid.valid).toBe(true);
    expect(valid.frame.centre).toEqual({ x: 50, y: 50 });
    const invalid = objectPlacementPreview({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 }, { x: -10, y: -10 }, city, { ...plan, buildings: [], landmarks: [] });
    expect(invalid.valid).toBe(false);
    expect(invalid.color).toBe(0xff6b75);
  });
  it("treats a null urban footprint as no placement restriction", () => {
    const unrestricted = {
      ...city,
      source: {
        ...city.source,
        terrain: { ...city.source.terrain, urbanFootprint: null }
      }
    };
    const preview = objectPlacementPreview(
      { kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 },
      { x: 50, y: 50 },
      unrestricted,
      { ...plan, buildings: [], landmarks: [] }
    );
    expect(preview.valid).toBe(true);
  });
  it("allows replaceable derived overlap but rejects persistent, protected, and road occupancy overlap", () => {
    const config = { kind: "building" as const, grammarId: "narrow-shopfront" as const, visualUse: "commercial" as const, heightM: 30, widthM: 20, depthM: 20 };
    const derived = objectPlacementPreview(config, { x: 60, y: 20 }, city, plan);
    expect(derived.valid).toBe(true);

    const derivedLandmark = objectPlacementPreview(config, { x: 20, y: 60 }, city, {
      ...plan,
      buildings: [],
      landmarks: [{ ...plan.landmarks[0]!, sourceId: null }]
    });
    expect(derivedLandmark).toMatchObject({ valid: false, reason: 'The placement overlaps place "place-a".' });

    const persistent = objectPlacementPreview(config, { x: 60, y: 20 }, city, {
      ...plan,
      buildings: [{ ...plan.buildings[1]!, sourceId: "building-b", protection: "manual-edit" }]
    });
    expect(persistent).toMatchObject({ valid: false, reason: 'The placement overlaps building "building-b".' });

    const protectedDerived = objectPlacementPreview(config, { x: 60, y: 20 }, city, {
      ...plan,
      buildings: [{ ...plan.buildings[1]!, sourceId: null, protection: "explicit" }]
    });
    expect(protectedDerived).toMatchObject({ valid: false, reason: 'The placement overlaps building "building-b".' });

    const road = objectPlacementPreview(config, { x: 60, y: 20 }, city, {
      ...plan,
      buildings: [],
      landmarks: [],
      routeOccupancy: { all: [[[
        { x: 50, y: 10 },
        { x: 70, y: 10 },
        { x: 70, y: 30 },
        { x: 50, y: 30 }
      ]]] }
    });
    expect(road).toMatchObject({ valid: false, reason: "The placement overlaps road occupancy." });
  });

  it("allows placement in a buildable island enclosed by road occupancy", () => {
    const config = { kind: "building" as const, grammarId: "narrow-shopfront" as const, visualUse: "commercial" as const, heightM: 30, widthM: 20, depthM: 20 };
    const roadRing: MultiPolygon = [[
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      [{ x: 30, y: 30 }, { x: 30, y: 70 }, { x: 70, y: 70 }, { x: 70, y: 30 }]
    ]];
    const enclosedPlan = { ...plan, buildings: [], landmarks: [], routeOccupancy: { all: roadRing } };

    expect(objectPlacementPreview(config, { x: 50, y: 50 }, city, enclosedPlan)).toMatchObject({
      valid: true,
      reason: null
    });
    expect(objectPlacementPreview(config, { x: 20, y: 50 }, city, enclosedPlan)).toMatchObject({
      valid: false,
      reason: "The placement overlaps road occupancy."
    });
  });

  it("uses bounded site hit tests and never crosses object kinds", () => {
    expect(architectureObjectAt({ x: 20, y: 20 }, plan)).toEqual({ id: "building-a", kind: "building" });
    expect(architectureObjectAt({ x: 20, y: 20 }, plan, "place")).toBeNull();
    expect(architectureObjectAt({ x: 90, y: 90 }, plan)).toBeNull();
  });

  it("selects one kind with Shift, switches kind without Shift, and clears on teardown", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    layer._onClickLeft(event(20, 20));
    expect(getObjectSelection()).toEqual({ ids: ["building-a"], kind: "building" });
    expect(hasObjectDraft()).toBe(false);
    layer._onClickLeft(event(60, 20, true));
    expect(getObjectSelection()).toEqual({ ids: ["building-a", "building-b"], kind: "building" });
    layer._onClickLeft(event(20, 60));
    expect(getObjectSelection()).toEqual({ ids: ["place-a"], kind: "place" });
    await layer._tearDown({});
    expect(getObjectSelection()).toEqual({ ids: [], kind: null });
  });
  it("cancels only real drafts and notifies exactly once without redrawing site rings", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    const refresh = vi.spyOn(layer, "refresh");
    refresh.mockClear();
    stateMocks.notifyEditorInteraction.mockClear();

    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30 });
    refresh.mockClear();
    stateMocks.notifyEditorInteraction.mockClear();
    layer.cancelDraft();
    expect(refresh).not.toHaveBeenCalled();
    expect(stateMocks.notifyEditorInteraction).toHaveBeenCalledOnce();
    layer.cancelDraft();
    expect(refresh).not.toHaveBeenCalled();
    expect(stateMocks.notifyEditorInteraction).toHaveBeenCalledOnce();
    await layer._tearDown({});
  });
  it("cancels right-click through one Select transition without reentrant redraw or notification", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });
    layer._onMouseMove(event(250, 300));
    expect(hasObjectDraft()).toBe(true);

    const refresh = vi.spyOn(layer, "refresh");
    refresh.mockClear();
    const preview = Graphics.instances[2]!;
    const previewClear = vi.spyOn(preview, "clear");
    previewClear.mockClear();
    stateMocks.notifyEditorInteraction.mockClear();
    stateMocks.notifyEditorInteraction.mockImplementation(() => {
      // This is the shell's synchronous transition callback. It may cancel
      // the layer, but must not cause the right-click handler to re-enter.
      layer.cancelDraft(true, false);
    });
    stateMocks.setCanvasTool.mockImplementation((next: string | null) => {
      stateMocks.canvasTool.mockReturnValue(next);
      stateMocks.notifyEditorInteraction();
    });

    layer._onClickRight(event(250, 300));

    expect(stateMocks.setCanvasTool).toHaveBeenCalledTimes(1);
    expect(stateMocks.setCanvasTool).toHaveBeenCalledWith("select");
    expect(stateMocks.notifyEditorInteraction).toHaveBeenCalledTimes(1);
    expect(previewClear).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(hasObjectDraft()).toBe(false);
    stateMocks.canvasTool.mockReturnValue("place");
    layer._onClickLeft(event(250, 300));
    expect(adapterMocks.placeBuilding).not.toHaveBeenCalled();
    await layer._tearDown({});
  });
  it("batches authored base sites and redraws only highlights for selection changes", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    const base = Graphics.instances[0]!;
    const highlights = Graphics.instances[1]!;
    const baseFills = base.fills.map((fill) => ({ ...fill }));
    const baseClear = vi.spyOn(base, "clear");
    const highlightsClear = vi.spyOn(highlights, "clear");
    baseClear.mockClear();
    highlightsClear.mockClear();

    layer.refresh();
    expect(baseClear).not.toHaveBeenCalled();
    expect(highlightsClear).not.toHaveBeenCalled();
    expect(base.fills).toEqual(baseFills);

    layer._onClickLeft(event(20, 20));
    expect(baseClear).not.toHaveBeenCalled();
    expect(highlightsClear).toHaveBeenCalledOnce();
    expect(base.fills).toEqual(baseFills);
    expect(highlights.fills.some((fill) => fill.color === 0x74ffa8)).toBe(true);

    const nextPlan: PlanViewFixture = {
      ...plan,
      buildings: [...plan.buildings, { id: "building-c", sourceId: null, sitePolygon: [{ x: 80, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 20 }, { x: 80, y: 20 }] }]
    };
    adapterMocks.getArchitecturePlanView.mockReturnValue(nextPlan);
    baseClear.mockClear();
    highlightsClear.mockClear();
    layer.refresh();
    expect(baseClear).toHaveBeenCalledOnce();
    expect(highlightsClear).toHaveBeenCalledOnce();
    expect(base.fills).toHaveLength(2);
    expect(base.moveCalls).toBe(4);
    expect(highlights.fills.some((fill) => fill.color === 0x74ffa8)).toBe(true);
    await layer._tearDown({});
  });

  it("redraws only highlights when an affected-object error changes", async () => {
    const run = vi.fn();
    setObjectsWorkspaceBridge({ run });
    adapterMocks.editSitePolygon.mockRejectedValueOnce(new Error("Polygon intersects a road"));
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    const base = Graphics.instances[0]!;
    const highlights = Graphics.instances[1]!;
    const baseClear = vi.spyOn(base, "clear");
    const highlightsClear = vi.spyOn(highlights, "clear");
    baseClear.mockClear();
    highlightsClear.mockClear();
    stateMocks.canvasTool.mockReturnValue("site");
    layer._onDragLeftStart(event(20, 20));
    layer._onDragLeftDrop(event(30, 30));
    const siteRun = run.mock.calls[0]!;
    await expect(siteRun[1]).rejects.toThrow("Polygon intersects a road");
    highlightsClear.mockClear();
    layer.refresh();
    expect(baseClear).not.toHaveBeenCalled();
    expect(highlightsClear).toHaveBeenCalledTimes(1);
    expect(highlights.fills.some((fill) => fill.color === 0xff6b75)).toBe(true);
    await layer._tearDown({});
  });

  it("clears base, highlights, and preview on deactivation and teardown", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    const base = Graphics.instances[0]!;
    const highlights = Graphics.instances[1]!;
    const preview = Graphics.instances[2]!;
    const baseClear = vi.spyOn(base, "clear");
    const highlightsClear = vi.spyOn(highlights, "clear");
    const previewClear = vi.spyOn(preview, "clear");
    baseClear.mockClear();
    highlightsClear.mockClear();
    previewClear.mockClear();

    layer._deactivate();
    expect(baseClear).toHaveBeenCalledOnce();
    expect(highlightsClear).toHaveBeenCalledOnce();
    expect(previewClear).toHaveBeenCalledOnce();

    await layer._tearDown({});
    expect(baseClear).toHaveBeenCalledTimes(2);
    expect(highlightsClear).toHaveBeenCalledTimes(2);
    expect(previewClear).toHaveBeenCalledTimes(2);
  });
  it("commits a valid ghost through the workspace runner and keeps repeated placement active", async () => {
    const run = vi.fn();
    setObjectsWorkspaceBridge({ run });
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });

    layer._onClickLeft2(event(50, 50));
    expect(adapterMocks.placeBuilding).toHaveBeenCalledWith(expect.objectContaining({
      grammarId: "narrow-shopfront",
      placement: expect.objectContaining({ centre: { x: 50, y: 50 } })
    }));
    expect(run).toHaveBeenCalledWith("object placement", expect.any(Promise), expect.any(Function));
    const firstRun = run.mock.calls[0]!;
    await firstRun[1];
    firstRun[2]();
    expect(hasObjectDraft()).toBe(true);

    layer._onClickLeft2(event(80, 80));
    expect(adapterMocks.placeBuilding).toHaveBeenCalledTimes(2);
    expect(adapterMocks.placeBuilding).toHaveBeenLastCalledWith(expect.objectContaining({
      grammarId: "narrow-shopfront",
      placement: expect.objectContaining({ centre: { x: 80, y: 80 } })
    }));
    expect(hasObjectDraft()).toBe(true);
    await layer._tearDown({});
  });
  it("allows button and canvas placement retries after an adapter rejection", async () => {
    const run = vi.fn();
    setObjectsWorkspaceBridge({ run });
    adapterMocks.placeBuilding.mockRejectedValueOnce(new Error("Semantic placement conflict"));
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });
    layer._onMouseMove(event(85, 85));

    expect(await finishObjectPlacement()).toBe(true);
    const rejected = run.mock.calls[0]!;
    await expect(rejected[1]).rejects.toThrow("Semantic placement conflict");
    expect(getObjectError()).toMatchObject({ label: "object placement", message: "Semantic placement conflict" });

    expect(await finishObjectPlacement()).toBe(true);
    expect(adapterMocks.placeBuilding).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    await layer._tearDown({});
  });


  it("uses the world-to-metre path for placement and metre-to-world drawing", async () => {
    adapterMocks.worldToMetres.mockImplementation((point: { x: number; y: number }) => ({ x: point.x / 10, y: point.y / 10 }));
    adapterMocks.metresToWorld.mockImplementation((point: { x: number; y: number }) => ({ x: point.x * 10, y: point.y * 10 }));
    const run = vi.fn();
    setObjectsWorkspaceBridge({ run });
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });
    layer._onMouseMove(event(500, 500));
    layer._onClickLeft2(event(500, 500));
    expect(adapterMocks.worldToMetres).toHaveBeenCalledWith({ x: 500, y: 500 });
    expect(adapterMocks.metresToWorld).toHaveBeenCalled();
    expect(adapterMocks.placeBuilding).toHaveBeenCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ centre: { x: 50, y: 50 } })
    }));
    await layer._tearDown({});
  });

  it("moves a placement preview through drag without committing the origin", async () => {
    const run = vi.fn();
    setObjectsWorkspaceBridge({ run });
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });

    layer._onClickLeft(event(40, 40));
    layer._onDragLeftStart(event(40, 40));
    layer._onDragLeftMove(event(85, 85));
    layer._onDragLeftDrop(event(85, 85));
    expect(adapterMocks.placeBuilding).not.toHaveBeenCalled();

    expect(await finishObjectPlacement()).toBe(true);
    expect(adapterMocks.placeBuilding).toHaveBeenCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ centre: { x: 85, y: 85 } })
    }));
    await layer._tearDown({});
  });

  it("selects through right-click in select mode and cancels placement/site drafts", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("select");
    layer._onClickRight(event(20, 20));
    expect(getObjectSelection()).toEqual({ ids: ["building-a"], kind: "building" });

    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });
    layer._onMouseMove(event(50, 50));
    expect(hasObjectDraft()).toBe(true);
    layer._onClickRight(event(50, 50));
    expect(hasObjectDraft()).toBe(false);

    stateMocks.canvasTool.mockReturnValue("site");
    layer._onDragLeftStart(event(20, 20));
    expect(hasObjectDraft()).toBe(true);
    layer._onDragRightCancel();
    expect(hasObjectDraft()).toBe(false);
    await layer._tearDown({});
  });

  it("rejects transforms for multi-selection instead of mutating a single object", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    layer._onClickLeft(event(20, 20));
    layer._onClickLeft(event(60, 20, true));
    expect(getObjectSelection()).toEqual({ ids: ["building-a", "building-b"], kind: "building" });
    expect(transformObjectSelection({ centre: { x: 50, y: 50 }, rotationRad: 0, widthM: 20, depthM: 20 })).toBe(false);
    expect(adapterMocks.transformObject).not.toHaveBeenCalled();
    await layer._tearDown({});
  });

  it("retains a rejected site edit as a durable affected-object highlight", async () => {
    const run = vi.fn();
    setObjectsWorkspaceBridge({ run });
    adapterMocks.editSitePolygon.mockRejectedValueOnce(new Error("Polygon intersects a road"));
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("site");
    layer._onDragLeftStart(event(20, 20));
    layer._onDragLeftDrop(event(30, 30));
    const siteRun = run.mock.calls[0]!;
    await expect(siteRun[1]).rejects.toThrow("Polygon intersects a road");
    expect(getObjectError()).toEqual({
      label: "site edit",
      message: "Polygon intersects a road",
      affectedIds: ["building-a"]
    });
    layer.refresh();
    expect(Graphics.instances[1]!.fills.some((fill) => fill.color === 0xff6b75)).toBe(true);
    await layer._tearDown({});
  });


  it("reports the exact invalid placement reason and clears it on valid movement or cancellation", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });

    layer._onClickLeft2(event(-10, -10));
    expect(adapterMocks.placeBuilding).not.toHaveBeenCalled();
    expect(getObjectError()).toEqual({
      label: "object placement",
      message: "The placement must lie inside land.",
      affectedIds: []
    });

    layer._onMouseMove(event(50, 50));
    expect(getObjectError()).toBeNull();
    layer._onClickLeft2(event(-10, -10));
    expect(getObjectError()).not.toBeNull();
    layer._onClickRight(event(-10, -10));
    expect(getObjectError()).toBeNull();
    await layer._tearDown({});
  });

  it("clears an object error when a city revision replaces its affected candidate", async () => {
    const Layer = objectsLayerClass();
    const layer = new Layer();
    await layer._draw({});
    stateMocks.canvasTool.mockReturnValue("place");
    configureObjectPlacement({ kind: "building", grammarId: "narrow-shopfront", visualUse: "commercial", heightM: 30, widthM: 20, depthM: 20 });
    layer._onClickLeft2(event(-10, -10));
    expect(getObjectError()).not.toBeNull();

    adapterMocks.getCity.mockReturnValue({ ...city, revision: 2 });
    cityListenerState.listener?.();
    expect(getObjectError()).toBeNull();
    await layer._tearDown({});
  });
});
