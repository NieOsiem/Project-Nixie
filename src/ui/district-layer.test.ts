import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  addCityListener: vi.fn(() => () => {}),
  getCity: vi.fn((): any => null),
  getDistrictPlanView: vi.fn((): any => null),
  getDistrictSelection: vi.fn((): string[] => []),
  isSceneEnabled: vi.fn(() => false),
  setDistrictDraftCancelListener: vi.fn(),
  setDistrictsPresentation: vi.fn()
}));

vi.mock("../adapter/canvas.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapter/canvas.js")>(),
  ...adapterMocks
}));

import { districtCellOrientationCue, districtDrawPreview, districtHatchSegments, districtLayerClass, districtMergePreview, districtOverlayData, districtSnapTarget, districtSplitPreview, DISTRICT_SNAP_TARGET_COLOR } from "./district-layer.js";

beforeEach(() => {
  adapterMocks.getCity.mockReturnValue(null);
  adapterMocks.getDistrictPlanView.mockReturnValue(null);
  adapterMocks.getDistrictSelection.mockReturnValue([]);
  adapterMocks.isSceneEnabled.mockReturnValue(false);
});

afterEach(() => vi.unstubAllGlobals());

describe("District overlay data", () => {
  it("uses effective block fragments for tint while retaining the full zoning boundary", () => {
    const city = { source: { districts: [{ id: "d1", polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] } };
    const plan = { blocks: [{ districtFragments: [{ districtId: "d1", buildable: [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]] }] }] };
    const overlay = districtOverlayData(city, plan);
    expect(overlay.boundaries).toHaveLength(1);
    expect(overlay.fills).toEqual([{ id: "d1", polygon: [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]] }]);
  });

  it("retains hole rings in effective fragments for the renderer path", () => {
    const ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const hole = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }];
    const overlay = districtOverlayData({ source: { districts: [] } }, { blocks: [{ districtFragments: [{ districtId: "d1", buildable: [[ring, hole]] }] }] });
    expect(overlay.fills[0]?.polygon).toEqual([ring, hole]);
  });

  it("previews draw subtraction and the incoming result", () => {
    const existing = [{ id: "old", polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }];
    const incoming = [{ x: 5, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 10 }, { x: 5, y: 10 }];
    const preview = districtDrawPreview(existing, incoming);
    expect(preview.valid).toBe(true);
    expect(preview.locked).toBe(false);
    expect(preview.result.map((entry) => entry.id)).toEqual(["old", "__district-draft__"]);
    expect(preview.result[0]?.polygon[0]).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }, { x: 0, y: 10 }]);
  });

  it("previews split as two result polygons and marks locked/invalid geometry red", () => {
    const district = { id: "old", polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
    const split = districtSplitPreview(district, [{ x: 5, y: -1 }, { x: 5, y: 11 }]);
    expect(split.valid).toBe(true);
    expect(split.result).toHaveLength(2);
    const locked = districtSplitPreview({ ...district, locked: true }, [{ x: 5, y: -1 }, { x: 5, y: 11 }]);
    expect(locked.locked).toBe(true);
    expect(locked.color).toBe(0xff6b75);
    expect(districtDrawPreview([], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).color).toBe(0xff6b75);
    expect(districtSplitPreview(district, [{ x: 5, y: -1 }, { x: 5, y: 11 }], 2)).toMatchObject({ valid: false, reason: "Split requires exactly one selected district." });
  });

  it("previews merge union and reports a locked participant as red", () => {
    const districts = [
      { id: "a", polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
      { id: "b", polygon: [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }] }
    ];
    const merged = districtMergePreview(districts, ["a", "b"], "a");
    expect(merged.valid).toBe(true);
    expect(merged.result).toHaveLength(1);
    expect(merged.result[0]?.id).toBe("a");
    const locked = districtMergePreview([{ ...districts[0], locked: true }, districts[1]], ["a", "b"], "a");
    expect(locked.locked).toBe(true);
    expect(locked.color).toBe(0xff6b75);
    expect(locked.result).toEqual(merged.result);
  });

  it("returns the active snap target only within reach", () => {
    const target = { x: 10, y: 10 };
    expect(districtSnapTarget({ x: 11, y: 10 }, [target], 2)).toEqual(target);
    expect(districtSnapTarget({ x: 13, y: 10 }, [target], 2)).toBeNull();
    expect(DISTRICT_SNAP_TARGET_COLOR).toBe(0xffc94a);
  });

  it("draws a deterministic local orientation cue for each valid development cell", () => {
    const cell = { polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }], rotationRad: Math.PI / 4 };
    expect(districtCellOrientationCue(cell)).toEqual(districtCellOrientationCue(cell));
    expect(districtCellOrientationCue(cell)).toEqual({
      start: { x: 8.585786437626904, y: 3.585786437626905 },
      end: { x: 11.414213562373096, y: 6.414213562373095 }
    });
    expect(districtCellOrientationCue({ polygon: [] })).toBeNull();
  });

  it("clips large-scene hatching by polygon edges instead of sampling the enclosed pixel area", () => {
    const source = [[{ x: 0, y: 0 }, { x: 120_000, y: 0 }, { x: 120_000, y: 80_000 }, { x: 0, y: 80_000 }]];
    const segments = districtHatchSegments(source, 32);
    expect(segments.length).toBeGreaterThan(6_200);
    expect(segments.length).toBeLessThanOrEqual(6_251);
  });

  it("uses even-odd hatch spans to preserve holes", () => {
    const outer = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const hole = [{ x: 35, y: 30 }, { x: 65, y: 30 }, { x: 65, y: 70 }, { x: 35, y: 70 }];
    const diagonal = districtHatchSegments([outer, hole], 10).filter((segment) => Math.abs(segment.start.x - segment.start.y) < 1e-9);
    expect(diagonal).toEqual([
      { start: { x: 0, y: 0 }, end: { x: 35, y: 35 } },
      { start: { x: 65, y: 65 }, end: { x: 100, y: 100 } }
    ]);
    expect(districtHatchSegments([], 10)).toEqual([]);
    expect(districtHatchSegments([outer], 0)).toEqual([]);
  });

  it("coalesces repeated overlay refresh requests and yields one paint before rendering", async () => {
    class InteractionLayer {
      active = true;
      visible = true;
      addChild<T>(child: T): T { return child; }
      async _draw(): Promise<void> {}
      async _tearDown(): Promise<void> {}
    }
    class Graphics {
      eventMode = "none";
      clear(): void {}
    }
    class Container {
      eventMode = "none";
    }
    const frames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("foundry", { canvas: { layers: { InteractionLayer } } });
    vi.stubGlobal("canvas", {});
    vi.stubGlobal("PIXI", { Container, Graphics });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const Layer = districtLayerClass();
    const layer = new Layer();
    await layer._draw({});
    layer.refresh();
    layer.refresh();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    frames[0]!(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    await layer._tearDown({});
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
  });

  it("renders the base overlay before structural work and cancels stale planning", async () => {
    class InteractionLayer {
      active = true;
      visible = true;
      addChild<T>(child: T): T { return child; }
      async _draw(): Promise<void> {}
      async _tearDown(): Promise<void> {}
    }
    class Graphics {
      eventMode = "none";
      clear = vi.fn();
      destroy(): void {}
    }
    class Container {
      eventMode = "none";
      addChild<T>(child: T): T { return child; }
    }
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    adapterMocks.getCity.mockReturnValue({ revision: 1, source: { districts: [], roads: { nodes: [] } } });
    adapterMocks.getDistrictPlanView.mockReturnValue({ blocks: [], developmentCells: [], unzoned: [], openSpaceIntents: [] });
    adapterMocks.isSceneEnabled.mockReturnValue(true);
    vi.stubGlobal("foundry", { canvas: { layers: { InteractionLayer } } });
    vi.stubGlobal("canvas", { dimensions: { size: 100 }, stage: { scale: { x: 1 } } });
    vi.stubGlobal("PIXI", { Container, Graphics });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const Layer = districtLayerClass();
    const layer = new Layer();
    await layer._draw({});
    frames.get(1)!(0);
    frames.delete(1);
    expect(adapterMocks.getDistrictPlanView).not.toHaveBeenCalled();
    frames.get(2)!(16);
    frames.delete(2);
    expect(adapterMocks.getDistrictPlanView).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
    frames.get(3)!(32);
    frames.delete(3);
    expect(adapterMocks.getDistrictPlanView).toHaveBeenCalledOnce();
    frames.get(4)!(48);
    frames.delete(4);
    frames.get(5)!(64);
    frames.delete(5);
    expect(frames.has(6)).toBe(true);
    (globalThis as any).canvas.stage.scale.x = 2;
    frames.get(6)!(80);
    frames.delete(6);
    expect(frames.has(7)).toBe(true);
    await layer._tearDown({});
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
  });
});
