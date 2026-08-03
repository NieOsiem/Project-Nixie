import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSceneControls } from "./controls.js";
import { registerRoadSceneControls } from "./road-controls.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function registrations(): Array<(controls: any) => void> {
  const callbacks: Array<(controls: any) => void> = [];
  vi.stubGlobal("Hooks", {
    on: (_name: string, callback: (controls: any) => void) => callbacks.push(callback)
  });
  vi.stubGlobal("game", { user: { isGM: true } });
  vi.stubGlobal("canvas", { scene: { getFlag: () => false }, nixie: {}, "nixie-roads": {} });
  registerSceneControls();
  registerRoadSceneControls();
  return callbacks;
}

describe("City Generator scene controls", () => {
  it("keeps the Phase 1 terrain group intact and adds a separate road group in v12", () => {
    const controls: any[] = [];
    for (const register of registrations()) register(controls);

    expect(controls.map((control) => [control.name, control.title, control.layer])).toEqual([
      ["nixie", "Nixie Terrain", "nixie"],
      ["nixie-roads", "Nixie Roads", "nixie-roads"]
    ]);
    expect(controls[0].activeTool).toBe("land-draw");
    expect(controls[0].tools.map((tool: any) => tool.name)).toEqual([
      "enabled",
      "land-draw",
      "footprint-draw",
      "land-edit",
      "footprint-edit",
      "finish",
      "cancel",
      "undo",
      "redo",
      "terrain"
    ]);
    expect(controls[1].activeTool).toBe("road-select");
    expect(controls[1].tools.map((tool: any) => tool.name)).toEqual([
      "road-draw",
      "road-select",
      "road-edit",
      "finish",
      "cancel",
      "undo",
      "redo",
      "roads"
    ]);
  });

  it("registers both independent layer groups in v14", () => {
    const controls: Record<string, any> = {};
    for (const register of registrations()) register(controls);

    expect(controls.nixie.title).toBe("Nixie Terrain");
    expect(controls.nixie.layer).toBe("nixie");
    expect(controls["nixie-roads"].title).toBe("Nixie Roads");
    expect(controls["nixie-roads"].layer).toBe("nixie-roads");
  });
});
