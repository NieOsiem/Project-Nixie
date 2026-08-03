import { isSceneEnabled, redo, setSceneEnabled, undo } from "../adapter/canvas.js";
import { cancelTerrainDraft, finishTerrainDraft, LAYER_NAME, TOOL } from "./nixie-layer.js";
import { openTerrainApp } from "./terrain-app.js";

interface NixieTool {
  name: string;
  title: string;
  icon: string;
  button?: boolean;
  toggle?: boolean;
  isActive?: () => boolean;
  onSelect?: (active: boolean) => void;
}

function run(label: string, action: () => Promise<unknown>): void {
  if (!isSceneEnabled()) {
    ui.notifications?.warn("Nixie: create or enable a 2.0 terrain first.");
    return;
  }
  void action().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LAYER_NAME} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
  });
}

function tools(): NixieTool[] {
  return [
    {
      name: "enabled",
      title: "Enable Nixie terrain on this Scene",
      icon: "fa-solid fa-power-off",
      toggle: true,
      isActive: isSceneEnabled,
      onSelect: (active) => {
        void setSceneEnabled(active)
          .then(() => {
            if (active) openTerrainApp();
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            ui.notifications?.error(`Nixie: enable change failed — ${message}`);
          });
      }
    },
    { name: TOOL.LAND_DRAW, title: "Draw or replace the land boundary", icon: "fa-solid fa-draw-polygon" },
    { name: TOOL.FOOTPRINT_DRAW, title: "Draw or replace the urban footprint", icon: "fa-solid fa-vector-square" },
    { name: TOOL.LAND_EDIT, title: "Drag land vertices", icon: "fa-solid fa-pen-to-square" },
    { name: TOOL.FOOTPRINT_EDIT, title: "Drag urban-footprint vertices", icon: "fa-solid fa-arrows-up-down-left-right" },
    {
      name: "finish",
      title: "Finish the current boundary draft",
      icon: "fa-solid fa-check",
      button: true,
      onSelect: () => {
        void finishTerrainDraft();
      }
    },
    {
      name: "cancel",
      title: "Cancel the current boundary draft",
      icon: "fa-solid fa-xmark",
      button: true,
      onSelect: () => cancelTerrainDraft()
    },
    {
      name: "undo",
      title: "Undo terrain edit",
      icon: "fa-solid fa-rotate-left",
      button: true,
      onSelect: () => run("undo", undo)
    },
    {
      name: "redo",
      title: "Redo terrain edit",
      icon: "fa-solid fa-rotate-right",
      button: true,
      onSelect: () => run("redo", redo)
    },
    {
      name: "terrain",
      title: "Open Terrain workspace",
      icon: "fa-solid fa-water",
      button: true,
      onSelect: () => openTerrainApp()
    }
  ];
}

const CONTROL_TITLE = "Nixie Terrain";
const CONTROL_ICON = "fa-solid fa-water";

export function registerSceneControls(): void {
  Hooks.on("getSceneControlButtons", (controls: any) => {
    if (!game.user?.isGM) return;
    const defs = tools();
    const select = (tool: NixieTool) => (active: boolean) => {
      tool.onSelect?.(active);
      canvas[LAYER_NAME]?.refresh();
    };

    if (Array.isArray(controls)) {
      controls.push({
        name: LAYER_NAME,
        title: CONTROL_TITLE,
        layer: LAYER_NAME,
        icon: CONTROL_ICON,
        visible: true,
        activeTool: TOOL.LAND_DRAW,
        tools: defs.map((tool) => ({
          name: tool.name,
          title: tool.title,
          icon: tool.icon,
          button: tool.button ?? false,
          toggle: tool.toggle ?? false,
          active: tool.isActive?.() ?? false,
          onClick: select(tool)
        }))
      });
      return;
    }

    const toolRecord: Record<string, unknown> = {};
    defs.forEach((tool, order) => {
      toolRecord[tool.name] = {
        name: tool.name,
        order,
        title: tool.title,
        icon: tool.icon,
        button: tool.button ?? false,
        toggle: tool.toggle ?? false,
        active: tool.isActive?.() ?? false,
        onChange: (_event: Event, active: boolean) => select(tool)(active)
      };
    });
    controls[LAYER_NAME] = {
      name: LAYER_NAME,
      order: Object.keys(controls).length,
      title: CONTROL_TITLE,
      layer: LAYER_NAME,
      icon: CONTROL_ICON,
      visible: true,
      activeTool: TOOL.LAND_DRAW,
      onChange: (_event: Event, active: boolean) => {
        if (active) canvas[LAYER_NAME]?.activate();
      },
      tools: toolRecord
    };
  });
}
