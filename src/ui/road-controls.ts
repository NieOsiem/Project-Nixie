import { isSceneEnabled, redo, undo } from "../adapter/canvas.js";
import { cancelRoadDraft, finishRoadDraft, ROAD_LAYER_NAME, ROAD_TOOL } from "./road-layer.js";
import { openRoadApp } from "./road-app.js";

interface RoadToolDefinition {
  name: string;
  title: string;
  icon: string;
  button?: boolean;
  onSelect?: () => void;
}

function run(label: string, action: () => Promise<unknown>): void {
  if (!isSceneEnabled()) {
    ui.notifications?.warn("Nixie: create or enable a 2.0 terrain first.");
    return;
  }
  void action().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ROAD_LAYER_NAME} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
  });
}

function tools(): RoadToolDefinition[] {
  return [
    { name: ROAD_TOOL.DRAW, title: "Draw a road or route", icon: "fa-solid fa-route" },
    { name: ROAD_TOOL.SELECT, title: "Select roads", icon: "fa-solid fa-arrow-pointer" },
    { name: ROAD_TOOL.EDIT, title: "Move road junctions and anchors", icon: "fa-solid fa-bezier-curve" },
    {
      name: "finish",
      title: "Finish the current road",
      icon: "fa-solid fa-check",
      button: true,
      onSelect: () => {
        void finishRoadDraft();
      }
    },
    {
      name: "cancel",
      title: "Cancel the current road",
      icon: "fa-solid fa-xmark",
      button: true,
      onSelect: cancelRoadDraft
    },
    {
      name: "undo",
      title: "Undo road edit",
      icon: "fa-solid fa-rotate-left",
      button: true,
      onSelect: () => run("undo", undo)
    },
    {
      name: "redo",
      title: "Redo road edit",
      icon: "fa-solid fa-rotate-right",
      button: true,
      onSelect: () => run("redo", redo)
    },
    {
      name: "roads",
      title: "Open Roads workspace",
      icon: "fa-solid fa-road",
      button: true,
      onSelect: openRoadApp
    }
  ];
}

const CONTROL_TITLE = "Nixie Roads";
const CONTROL_ICON = "fa-solid fa-road";

export function registerRoadSceneControls(): void {
  Hooks.on("getSceneControlButtons", (controls: any) => {
    if (!game.user?.isGM) return;
    const defs = tools();
    const select = (tool: RoadToolDefinition) => () => {
      tool.onSelect?.();
      canvas[ROAD_LAYER_NAME]?.refresh();
    };

    if (Array.isArray(controls)) {
      controls.push({
        name: ROAD_LAYER_NAME,
        title: CONTROL_TITLE,
        layer: ROAD_LAYER_NAME,
        icon: CONTROL_ICON,
        visible: true,
        activeTool: ROAD_TOOL.SELECT,
        tools: defs.map((tool) => ({
          name: tool.name,
          title: tool.title,
          icon: tool.icon,
          button: tool.button ?? false,
          toggle: false,
          active: false,
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
        toggle: false,
        active: false,
        onChange: () => select(tool)()
      };
    });
    controls[ROAD_LAYER_NAME] = {
      name: ROAD_LAYER_NAME,
      order: Object.keys(controls).length,
      title: CONTROL_TITLE,
      layer: ROAD_LAYER_NAME,
      icon: CONTROL_ICON,
      visible: true,
      activeTool: ROAD_TOOL.SELECT,
      onChange: (_event: Event, active: boolean) => {
        if (active) canvas[ROAD_LAYER_NAME]?.activate();
      },
      tools: toolRecord
    };
  });
}
