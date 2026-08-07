import { closeEditor, isEditorOpen, LAYER_NIXIE, openEditor } from "./editor-state.js";

const CONTROL_NAME = "nixie-editor";
const CONTROL_TITLE = "Nixie Editor";
const CONTROL_ICON = "fa-solid fa-city";
const TOOL_NAME = "editor-mode";
const TOOL_TITLE = "Toggle Nixie Editor Mode";
const TOOL_ICON = "fa-solid fa-pen-ruler";

function toggleDefinition(): Record<string, unknown> {
  return {
    name: TOOL_NAME,
    title: TOOL_TITLE,
    icon: TOOL_ICON,
    toggle: true,
    active: isEditorOpen(),
    onClick: (active: boolean) => {
      if (active) openEditor();
      else closeEditor({ restoreDefaultLayer: true });
    },
    onChange: (_event: Event, active: boolean) => {
      if (active) openEditor();
      else closeEditor({ restoreDefaultLayer: true });
    }
  };
}

export function registerEditorSceneControls(): void {
  Hooks.on("getSceneControlButtons", (controls: unknown[] | Record<string, unknown>) => {
    if (!game.user?.isGM) return;

    if (Array.isArray(controls)) {
      controls.push({
        name: CONTROL_NAME,
        title: CONTROL_TITLE,
        layer: LAYER_NIXIE,
        icon: CONTROL_ICON,
        visible: true,
        activeTool: TOOL_NAME,
        tools: [toggleDefinition()]
      });
      return;
    }

    controls[CONTROL_NAME] = {
      name: CONTROL_NAME,
      order: Object.keys(controls).length,
      title: CONTROL_TITLE,
      layer: LAYER_NIXIE,
      icon: CONTROL_ICON,
      visible: true,
      activeTool: TOOL_NAME,
      onChange: (_event: Event, active: boolean) => {
        if (active) canvas?.[LAYER_NIXIE]?.activate();
      },
      tools: { [TOOL_NAME]: toggleDefinition() }
    };
  });
}
