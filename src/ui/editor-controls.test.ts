import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEditorSceneControls } from "./editor-controls.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function registrations(): Array<(controls: unknown[] | Record<string, unknown>) => void> {
  const callbacks: Array<(controls: unknown[] | Record<string, unknown>) => void> = [];
  vi.stubGlobal("Hooks", {
    on: (_name: string, callback: (controls: unknown[] | Record<string, unknown>) => void) => callbacks.push(callback)
  });
  vi.stubGlobal("game", { user: { isGM: true } });
  vi.stubGlobal("canvas", { ready: true, nixie: {}, "nixie-roads": {} });
  registerEditorSceneControls();
  return callbacks;
}

describe("Nixie editor scene control", () => {
  it("registers one control group with a single editor toggle in v12", () => {
    const controls: any[] = [];
    for (const register of registrations()) register(controls);

    expect(controls.map((control) => [control.name, control.title, control.layer])).toEqual([
      ["nixie-editor", "Nixie Editor", "nixie"]
    ]);
    expect(controls[0].activeTool).toBe("editor-mode");
    expect(controls[0].tools.map((tool: any) => tool.name)).toEqual(["editor-mode"]);
    expect(controls[0].tools[0].toggle).toBe(true);
    expect(controls[0].tools[0].active).toBe(false);
  });

  it("registers one control group in v14", () => {
    const controls: Record<string, any> = {};
    for (const register of registrations()) register(controls);

    expect(Object.keys(controls)).toEqual(["nixie-editor"]);
    expect(controls["nixie-editor"].layer).toBe("nixie");
    expect(controls["nixie-editor"].tools["editor-mode"].toggle).toBe(true);
    expect(controls["nixie-editor"].tools["editor-mode"].active).toBe(false);
  });
});
