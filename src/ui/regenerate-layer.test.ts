import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RegenerationBlocker } from "../core/gen/regeneration-plan.js";
type BlockerFixture = RegenerationBlocker;
type SelectionFixture = { kind: "block" | "district"; ids: string[]; revision: number | null } | null;

const cityListenerState = vi.hoisted(() => ({
  listener: null as (() => void) | null
}));
const selectionListenerState = vi.hoisted(() => ({
  listener: null as (() => void) | null
}));
const stateMocks = vi.hoisted(() => ({
  canvasTool: vi.fn<() => string | null>(() => "block"),
  clearRegenerationSelection: vi.fn(),
  editorLayerActivated: vi.fn(),
  editorLayerDeactivated: vi.fn(),
  getRegenerationSelection: vi.fn<() => SelectionFixture>(() => null),
  isPendingOperation: vi.fn(() => false),
  notifyEditorInteraction: vi.fn(),
  selectRegenerationTarget: vi.fn(),
  setRegenerationSelectionListener: vi.fn((listener: () => void) => {
    selectionListenerState.listener = listener;
  })
}));
const adapterMocks = vi.hoisted(() => ({
  addCityListener: vi.fn((listener: () => void) => {
    cityListenerState.listener = listener;
    return () => {
      if (cityListenerState.listener === listener) cityListenerState.listener = null;
    };
  }),
  getArchitecturePlanView: vi.fn<() => unknown>(() => null),
  getCity: vi.fn<() => unknown>(() => null),
  getDistrictPlanView: vi.fn<() => unknown>(() => null),
  isSceneEnabled: vi.fn(() => false),
  metresToWorld: vi.fn((point: { x: number; y: number }) => ({ ...point })),
  worldToMetres: vi.fn((point: { x: number; y: number }) => ({ ...point }))
}));

vi.mock("../adapter/canvas.js", async (importOriginal) => ({
  ...await importOriginal(),
  ...adapterMocks
}));
vi.mock("./editor-state.js", async (importOriginal) => ({
  ...await importOriginal(),
  ...stateMocks,
  LAYER_REGENERATE: "nixie-regenerate",
  REGENERATE_TOOL: { BLOCK: "block", DISTRICT: "district" }
}));

import {
  blockerGeometryId,
  clearRegenerationBlockers,
  describeRegenerationBlockers,
  getRegenerationBlockers,
  regenerateBlockAt,
  regenerateDistrictAt,
  regenerateLayerClass,
  regenerationProtectionSummary,
  regenerationSeedSummary,
  regenerationSelectionKey,
  regenerationTargetOverlays,
  setRegenerationBlockers
} from "./regenerate-layer.js";

const districtPlan = {
  blocks: [
    {
      id: "block-a",
      zoningFace: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      districtFragments: [
        { id: "frag-a1", blockId: "block-a", districtId: "north", buildable: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]] },
        { id: "frag-a2", blockId: "block-a", districtId: "west", buildable: [[{ x: 12, y: 12 }, { x: 88, y: 12 }, { x: 88, y: 88 }, { x: 12, y: 88 }]] }
      ]
    },
    {
      id: "block-unzoned",
      zoningFace: [{ x: 200, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 100 }, { x: 200, y: 100 }],
      districtFragments: []
    }
  ]
};
const city = {
  revision: 4,
  source: {
    districts: [
      { id: "north", polygon: [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 50 }, { x: 0, y: 50 }] },
      { id: "west", polygon: [{ x: 0, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 100 }, { x: 0, y: 100 }] }
    ],
    regeneration: {
      partialSeeds: [
        { targetKind: "block", targetId: "block-a", seed: "older", order: 1 },
        { targetKind: "block", targetId: "block-a", seed: "newest", order: 5 },
        { targetKind: "district", targetId: "north", seed: "district-seed", order: 2 }
      ]
    }
  }
};
const plan = {
  buildings: [
    {
      id: "building-protected",
      protection: "explicit",
      sitePolygon: [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 }]
    },
    {
      id: "building-outside",
      protection: "explicit",
      sitePolygon: [{ x: 500, y: 500 }, { x: 520, y: 500 }, { x: 520, y: 520 }, { x: 500, y: 520 }]
    }
  ],
  landmarks: [
    {
      id: "landmark-reserved",
      origin: "generated",
      masses: [],
      sitePolygon: [{ x: 50, y: 50 }, { x: 70, y: 50 }, { x: 70, y: 70 }, { x: 50, y: 70 }]
    },
    {
      id: "landmark-reserved-outside",
      origin: "generated",
      masses: [],
      sitePolygon: [{ x: 600, y: 600 }, { x: 620, y: 600 }, { x: 620, y: 620 }, { x: 600, y: 620 }]
    }
  ]
};

const selection = (kind: "block" | "district", ids: string[], revision: number | null = 4) => ({ kind, ids, revision });

class Graphics {
  static instances: Graphics[] = [];
  readonly fills: Array<{ color: number; alpha?: number }> = [];
  readonly lineStyles: Array<{ width: number; color: number; alpha: number }> = [];
  holes = 0;
  eventMode = "none";
  constructor() { Graphics.instances.push(this); }
  clear(): void {
    this.fills.length = 0;
    this.lineStyles.length = 0;
    this.holes = 0;
  }
  beginFill(color: number, alpha?: number): void { this.fills.push({ color, alpha }); }
  endFill(): void {}
  lineStyle(style: { width: number; color: number; alpha: number }): void { this.lineStyles.push(style); }
  moveTo(): void {}
  lineTo(): void {}
  beginHole(): void { this.holes += 1; }
  endHole(): void {}
}
class InteractionLayer {
  active = true;
  visible = true;
  addChild<T>(child: T): T { return child; }
  async _draw(): Promise<void> {}
  async _tearDown(): Promise<void> {}
}

interface LayerInstance {
  _draw(): Promise<void>;
  _tearDown(): Promise<void>;
  _onClickLeft(event: unknown): void;
  refresh(): void;
}

function clickEvent(x: number, y: number, shiftKey = false): unknown {
  return { getLocalPosition: () => ({ x, y }), shiftKey };
}

async function drawLayer(): Promise<{ layer: LayerInstance; graphics: Graphics[] }> {
  const LayerClass = regenerateLayerClass() as unknown as new () => LayerInstance;
  const layer = new LayerClass();
  await layer._draw();
  return { layer, graphics: Graphics.instances.slice(-6) };
}

beforeEach(() => {
  vi.clearAllMocks();
  cityListenerState.listener = null;
  selectionListenerState.listener = null;
  Graphics.instances.length = 0;
  adapterMocks.getCity.mockReturnValue(city);
  adapterMocks.getDistrictPlanView.mockReturnValue(districtPlan);
  adapterMocks.getArchitecturePlanView.mockReturnValue(plan);
  adapterMocks.isSceneEnabled.mockReturnValue(true);
  adapterMocks.metresToWorld.mockImplementation((point: { x: number; y: number }) => ({ ...point }));
  adapterMocks.worldToMetres.mockImplementation((point: { x: number; y: number }) => ({ ...point }));
  stateMocks.canvasTool.mockReturnValue("block");
  stateMocks.getRegenerationSelection.mockReturnValue(null);
  stateMocks.isPendingOperation.mockReturnValue(false);
  vi.stubGlobal("foundry", { canvas: { layers: { InteractionLayer } } });
  vi.stubGlobal("PIXI", { Graphics });
  vi.stubGlobal("canvas", { stage: {}, dimensions: { size: 100, sceneRect: { x: -500, y: -500, width: 1500, height: 1500 } } });
  clearRegenerationBlockers();
});

afterEach(() => {
  clearRegenerationBlockers();
  vi.unstubAllGlobals();
});

describe("regeneration hit testing", () => {
  it("selects only zoned complete blocks under the point", () => {
    expect(regenerateBlockAt({ x: 50, y: 50 }, districtPlan)).toBe("block-a");
    expect(regenerateBlockAt({ x: 250, y: 50 }, districtPlan)).toBeNull();
    expect(regenerateBlockAt({ x: 150, y: 50 }, districtPlan)).toBeNull();
  });

  it("finds the district whose authored polygon contains the point", () => {
    expect(regenerateDistrictAt({ x: 10, y: 10 }, city)).toBe("north");
    expect(regenerateDistrictAt({ x: 10, y: 60 }, city)).toBe("west");
    expect(regenerateDistrictAt({ x: 400, y: 400 }, city)).toBeNull();
  });
});

describe("regeneration seed and protection summaries", () => {
  it("summarizes persisted partial seeds with newest order winning and Multiple for distinct values", () => {
    expect(regenerationSeedSummary(city, selection("block", ["block-a"])).display).toBe("newest");
    expect(regenerationSeedSummary(city, selection("district", ["north"])).display).toBe("district-seed");
    expect(regenerationSeedSummary(city, selection("block", ["block-a", "block-ghost"])).display).toBe("newest");
    expect(regenerationSeedSummary(city, null).display).toBeNull();
    const mixed = {
      ...city,
      source: {
        ...city.source,
        regeneration: {
          partialSeeds: [
            { targetKind: "block", targetId: "b1", seed: "seed-1", order: 1 },
            { targetKind: "block", targetId: "b2", seed: "seed-2", order: 2 }
          ]
        }
      }
    };
    const summary = regenerationSeedSummary(mixed, selection("block", ["b1", "b2"]));
    expect(summary.display).toBe("Multiple");
    expect(summary.values).toEqual(["seed-1", "seed-2"]);
  });

  it("shows Multiple for a single block whose fragments span differently seeded districts", () => {
    const chronology = {
      ...city,
      source: {
        ...city.source,
        regeneration: {
          partialSeeds: [
            { targetKind: "block", targetId: "block-a", seed: "old-block", order: 1 },
            { targetKind: "district", targetId: "north", seed: "new-district", order: 9 }
          ]
        }
      }
    };
    const summary = regenerationSeedSummary(chronology, selection("block", ["block-a"]), districtPlan);
    // Fragment in "north" follows the newer district seed; the "west" fragment still
    // follows the block's own record — no unified winner may be invented.
    expect(summary.display).toBe("Multiple");
    expect([...summary.values].sort()).toEqual(["new-district", "old-block"]);
    expect(summary.overriddenIds).toEqual(["block-a"]);
    expect(summary.unseededFragments).toBe(0);
  });

  it("shows Multiple for a district target when a newer block event covers only part of it", () => {
    const splitPlan = {
      blocks: [
        { id: "block-a", zoningFace: districtPlan.blocks[0]!.zoningFace, districtFragments: [{ id: "frag-a1", blockId: "block-a", districtId: "north", buildable: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]] }] },
        { id: "block-c", zoningFace: [{ x: 300, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 100 }, { x: 300, y: 100 }], districtFragments: [{ id: "frag-c1", blockId: "block-c", districtId: "north", buildable: [[{ x: 310, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 90 }, { x: 310, y: 90 }]] }] }
      ]
    };
    const chronology = {
      ...city,
      source: {
        ...city.source,
        regeneration: {
          partialSeeds: [
            { targetKind: "district", targetId: "north", seed: "district-seed", order: 2 },
            { targetKind: "block", targetId: "block-a", seed: "newest", order: 5 }
          ]
        }
      }
    };
    const summary = regenerationSeedSummary(chronology, selection("district", ["north"]), splitPlan);
    expect(summary.display).toBe("Multiple");
    expect([...summary.values].sort()).toEqual(["district-seed", "newest"]);
    expect(summary.overriddenIds).toEqual(["north"]);
    expect(summary.unseededFragments).toBe(0);
  });
  it("marks fragments without any applicable record as unseeded while seeded fragments keep their seed", () => {
    const partialPlan = {
      blocks: [
        { id: "block-a", zoningFace: districtPlan.blocks[0]!.zoningFace, districtFragments: [{ id: "frag-a1", blockId: "block-a", districtId: "north", buildable: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]] }] },
        { id: "block-d", zoningFace: [{ x: 400, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 100 }, { x: 400, y: 100 }], districtFragments: [{ id: "frag-d1", blockId: "block-d", districtId: "south", buildable: [[{ x: 410, y: 10 }, { x: 490, y: 10 }, { x: 490, y: 90 }, { x: 410, y: 90 }]] }] }
      ]
    };
    const summary = regenerationSeedSummary(city, selection("block", ["block-a", "block-d"]), partialPlan);
    // block-a's fragment resolves to its own newest record; block-d's fragment has no
    // block record and its district "south" has no district record either.
    expect(summary.display).toBe("newest");
    expect(summary.unseededFragments).toBe(1);
    expect(summary.overriddenIds).toEqual([]);
  });


  it("keeps the block record effective when it is newer than the district event", () => {
    const summary = regenerationSeedSummary(city, selection("block", ["block-a"]), districtPlan);
    expect(summary.display).toBe("newest");
    expect(summary.overriddenIds).toEqual([]);
  });

  it("presents Multiple when different newer district events control different blocks", () => {
    const plan2 = {
      blocks: [
        { id: "block-a", zoningFace: districtPlan.blocks[0]!.zoningFace, districtFragments: [{ id: "frag-a1", blockId: "block-a", districtId: "north", buildable: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]] }] },
        {
          id: "block-b",
          zoningFace: [{ x: 300, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 100 }, { x: 300, y: 100 }],
          districtFragments: [{ id: "frag-b1", blockId: "block-b", districtId: "west", buildable: [[{ x: 310, y: 10 }, { x: 390, y: 10 }, { x: 390, y: 90 }, { x: 310, y: 90 }]] }]
        }
      ]
    };
    const chronology = {
      ...city,
      source: {
        ...city.source,
        regeneration: {
          partialSeeds: [
            { targetKind: "block", targetId: "block-a", seed: "old-a", order: 1 },
            { targetKind: "block", targetId: "block-b", seed: "old-b", order: 2 },
            { targetKind: "district", targetId: "north", seed: "north-new", order: 8 },
            { targetKind: "district", targetId: "west", seed: "west-new", order: 9 }
          ]
        }
      }
    };
    const summary = regenerationSeedSummary(chronology, selection("block", ["block-a", "block-b"]), plan2);
    expect(summary.display).toBe("Multiple");
    expect(summary.overriddenIds).toEqual(["block-a", "block-b"]);
  });

  it("adds nothing from fragments with a null districtId", () => {
    const unzonedPlan = {
      blocks: [{
        id: "block-a",
        zoningFace: districtPlan.blocks[0]!.zoningFace,
        districtFragments: [{ id: "frag-u", blockId: "block-a", districtId: null, buildable: [[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }]] }]
      }]
    };
    const summary = regenerationSeedSummary(city, selection("block", ["block-a"]), unzonedPlan);
    expect(summary.display).toBe("newest");
    expect(summary.overriddenIds).toEqual([]);
  });

  it("counts protected objects and reserved procedural sites inside the final target", () => {
    const overlays = regenerationTargetOverlays(selection("block", ["block-a"]), districtPlan, city);
    const summary = regenerationProtectionSummary(plan, overlays.final);
    expect(summary.protectedIds).toEqual(["building-protected"]);
    expect(summary.reservedIds).toEqual(["landmark-reserved"]);
  });

  it("maps override blockers to their target geometry and keeps target blockers geometry-free", () => {
    expect(blockerGeometryId({ id: "building:abc", kind: "override", reason: "r" })).toBe("abc");
    expect(blockerGeometryId({ id: "abc", kind: "building", reason: "r" })).toBe("abc");
    expect(blockerGeometryId({ id: "seed", kind: "seed", reason: "r" })).toBeNull();
    expect(describeRegenerationBlockers([{ id: "abc", kind: "place", reason: "locked" }])).toEqual([
      { id: "abc", kind: "place", reason: "locked", geometryId: "abc" }
    ]);
  });
});

describe("regeneration target overlays", () => {
  it("builds block emphasis from zoning faces and the final target from fragment buildables", () => {
    const overlays = regenerationTargetOverlays(selection("block", ["block-a"]), districtPlan, city);
    expect(overlays.emphasis).toEqual([[districtPlan.blocks[0]!.zoningFace]]);
    expect(overlays.final).toHaveLength(2);
    expect(regenerationSelectionKey(selection("block", ["block-a"]))).toContain("block-a");
  });

  it("expands a district target to its fragments across blocks and keeps its authored polygon as emphasis", () => {
    const overlays = regenerationTargetOverlays(selection("district", ["north"]), districtPlan, city);
    expect(overlays.emphasis).toEqual([[city.source.districts[0]!.polygon]]);
    expect(overlays.final).toEqual([[districtPlan.blocks[0]!.districtFragments[0]!.buildable[0]]]);
    expect(regenerationTargetOverlays(selection("district", ["ghost"]), districtPlan, city).final).toEqual([]);
    expect(regenerationTargetOverlays(selection("block", ["missing"]), districtPlan, city).final).toEqual([]);
  });
});

describe("regenerate layer interaction", () => {
  it("registers with the shared editor state on activation and teardown", async () => {
    const { layer } = await drawLayer();
    expect(stateMocks.editorLayerDeactivated).not.toHaveBeenCalled();
    expect(selectionListenerState.listener).toBeTypeOf("function");
    await layer._tearDown();
    expect(stateMocks.editorLayerDeactivated).toHaveBeenCalledWith("nixie-regenerate");
    expect(cityListenerState.listener).toBeNull();
  });

  it("commits block selection with additive Shift and captured revision", async () => {
    const { layer } = await drawLayer();
    layer._onClickLeft(clickEvent(50, 50));
    expect(stateMocks.selectRegenerationTarget).toHaveBeenCalledWith("block", "block-a", false, 4);
    layer._onClickLeft(clickEvent(50, 50, true));
    expect(stateMocks.selectRegenerationTarget).toHaveBeenLastCalledWith("block", "block-a", true, 4);
  });

  it("forces singular district selection regardless of Shift", async () => {
    stateMocks.canvasTool.mockReturnValue("district");
    const { layer } = await drawLayer();
    layer._onClickLeft(clickEvent(10, 10, true));
    expect(stateMocks.selectRegenerationTarget).toHaveBeenCalledWith("district", "north", false, 4);
  });

  it("clears the selection when clicking empty space and refuses input while pending", async () => {
    const { layer } = await drawLayer();
    layer._onClickLeft(clickEvent(500, 500));
    expect(stateMocks.clearRegenerationSelection).toHaveBeenCalled();
    stateMocks.isPendingOperation.mockReturnValue(true);
    stateMocks.clearRegenerationSelection.mockClear();
    layer._onClickLeft(clickEvent(50, 50));
    expect(stateMocks.selectRegenerationTarget).not.toHaveBeenCalled();
    expect(stateMocks.clearRegenerationSelection).not.toHaveBeenCalled();
  });

  it("redraws selection-driven overlays only when selection or city state changes", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    const { layer, graphics } = await drawLayer();
    const base = graphics[0]!;
    const dim = graphics[1]!;
    const target = graphics[2]!;
    const marks = graphics[3]!;
    const dimFills = dim.fills.length;
    const targetFills = target.fills.length;
    const markLines = marks.lineStyles.length;
    expect(dimFills).toBeGreaterThan(0);
    expect(dim.holes).toBe(2);
    expect(targetFills).toBeGreaterThan(0);
    expect(markLines).toBeGreaterThan(0);
    layer.refresh();
    expect(dim.fills.length).toBe(dimFills);
    selectionListenerState.listener?.();
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a", "block-unzoned"]));
    layer.refresh();
    expect(dim.fills.length).toBe(dimFills);
    expect(base.fills.length).toBe(0);
  });

  it("clears overlays when the scene is unavailable", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    const { layer, graphics } = await drawLayer();
    const dim = graphics[1]!;
    expect(dim.fills.length).toBeGreaterThan(0);
    adapterMocks.isSceneEnabled.mockReturnValue(false);
    layer.refresh();
    expect(dim.fills.length).toBe(0);
  });
});

describe("regenerate layer blocker presentation", () => {
  it("draws red outlines, cross markers, and hatch strokes for geometry blockers", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    const { layer, graphics } = await drawLayer();
    const blockersGraphic = graphics[4]!;
    expect(blockersGraphic.lineStyles.length).toBe(0);
    setRegenerationBlockers([
      { id: "building-protected", kind: "building", reason: "locked" },
      { id: "seed", kind: "seed", reason: "invalid" }
    ] as BlockerFixture[]);
    layer.refresh();
    expect(blockersGraphic.lineStyles.length).toBeGreaterThan(0);
    const redLines = blockersGraphic.lineStyles.filter((style) => style.color === 0xff6b75);
    expect(redLines.length).toBeGreaterThanOrEqual(2);
    expect(getRegenerationBlockers()).toHaveLength(2);
    clearRegenerationBlockers();
    layer.refresh();
    expect(blockersGraphic.lineStyles.length).toBe(0);
  });

  it("keeps blockers cleared from an empty selection overlay", async () => {
    const { layer, graphics } = await drawLayer();
    setRegenerationBlockers([{ id: "abc", kind: "building", reason: "locked" }] as BlockerFixture[]);
    layer.refresh();
    expect(graphics[4]!.lineStyles.length).toBe(0);
  });
});
