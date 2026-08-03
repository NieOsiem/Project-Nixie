import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRoadTool, ROAD_LAYER_NAME, ROAD_TOOL } from "./road-layer.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dedicated road interaction layer", () => {
  it("uses the road layer name when activating a road tool", () => {
    const activate = vi.fn();
    vi.stubGlobal("canvas", { [ROAD_LAYER_NAME]: { activate } });
    activateRoadTool(ROAD_TOOL.DRAW);
    expect(activate).toHaveBeenCalledWith({ tool: ROAD_TOOL.DRAW });
  });

  it("falls back to the controls initializer when a layer API is unavailable", () => {
    const initialize = vi.fn();
    vi.stubGlobal("canvas", { [ROAD_LAYER_NAME]: {} });
    vi.stubGlobal("ui", { controls: { initialize } });
    activateRoadTool(ROAD_TOOL.SELECT);
    expect(initialize).toHaveBeenCalledWith({ layer: ROAD_LAYER_NAME, tool: ROAD_TOOL.SELECT });
  });
});
