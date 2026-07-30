import {
  autoWallsEnabled,
  buildWalls,
  isMounted,
  redo,
  reseedBase,
  resetCity,
  setAutoWalls,
  undo
} from "../adapter/canvas.js";
import { DEFAULT_ROAD_CLASS, ROAD_CLASSES } from "../core/gen/demo-city.js";
import { LAYER_NAME, TOOL } from "./nixie-layer.js";

interface NixieTool {
  name: string;
  title: string;
  icon: string;
  button?: boolean;
  toggle?: boolean;
  isActive?: () => boolean;
  onSelect?: (active: boolean) => void;
}

/** Report failures instead of leaving a rejected promise in the console. */
function run(label: string, action: () => Promise<unknown>): void {
  if (!isMounted()) {
    ui.notifications?.warn("Nixie: enable the city on this scene first.");
    return;
  }
  void action().catch((err) => {
    console.error(`${LAYER_NAME} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${err.message}`);
  });
}

/** Label and icon per road class. Widths come from the class itself, so they never drift. */
const ROAD_UI: Record<string, { label: string; icon: string }> = {
  highway: { label: "Highway", icon: "fa-solid fa-road-bridge" },
  arterial: { label: "Arterial", icon: "fa-solid fa-road" },
  street: { label: "Street", icon: "fa-solid fa-road-barrier" },
  narrow: { label: "Narrow Road", icon: "fa-solid fa-grip-lines" },
  lane: { label: "Lane", icon: "fa-solid fa-grip-lines-vertical" },
  alley: { label: "Alley", icon: "fa-solid fa-minus" }
};

/** One draw tool per road class, named after the class so the layer can dispatch on it. */
function roadTools(): NixieTool[] {
  return ROAD_CLASSES.map((c) => {
    const ui = ROAD_UI[c.id] ?? { label: c.id, icon: "fa-solid fa-road" };
    const pavement = c.sidewalkM > 0 ? `+ ${c.sidewalkM} m walkways` : "no walkway";
    return {
      name: c.id,
      title: `Draw ${ui.label} — ${c.widthM} m ${pavement}`,
      icon: ui.icon
    };
  });
}

function tools(): NixieTool[] {
  return [
    ...roadTools(),
    {
      name: TOOL.EDIT,
      title: "Edit Junctions — drag to move, drop on another to weld",
      icon: "fa-solid fa-arrows-up-down-left-right"
    },
    { name: TOOL.WALKWAY, title: "Toggle a Road's Walkways", icon: "fa-solid fa-shoe-prints" },
    { name: TOOL.ZONE, title: "Zone — drag to add, click to reseed", icon: "fa-solid fa-vector-square" },
    { name: TOOL.ERASE, title: "Erase Road or Zone", icon: "fa-solid fa-eraser" },
    {
      name: "autoWalls",
      title: "Rebuild Walls Automatically",
      icon: "fa-solid fa-block-brick",
      toggle: true,
      isActive: autoWallsEnabled,
      onSelect: (active) => setAutoWalls(active)
    },
    {
      name: "reseed",
      title: "Reseed Unzoned Buildings",
      icon: "fa-solid fa-dice",
      button: true,
      onSelect: () => run("reseed", reseedBase)
    },
    {
      name: "undo",
      title: "Undo",
      icon: "fa-solid fa-rotate-left",
      button: true,
      onSelect: () =>
        run("undo", async () => {
          if (!(await undo())) ui.notifications?.info("Nixie: nothing to undo.");
        })
    },
    {
      name: "redo",
      title: "Redo",
      icon: "fa-solid fa-rotate-right",
      button: true,
      onSelect: () =>
        run("redo", async () => {
          if (!(await redo())) ui.notifications?.info("Nixie: nothing to redo.");
        })
    },
    {
      name: "walls",
      title: "Rebuild Walls Now",
      icon: "fa-solid fa-bars",
      button: true,
      onSelect: () => run("wall rebuild", buildWalls)
    },
    {
      name: "reset",
      title: "Reset to Demo City",
      icon: "fa-solid fa-trash-arrow-up",
      button: true,
      onSelect: () => run("reset", resetCity)
    }
  ];
}

const CONTROL_TITLE = "Nixie City";
const CONTROL_ICON = "fa-solid fa-city";

/**
 * v12 hands the hook an array of controls with array-valued `tools`; v13 and v14 hand it
 * a record of records and expect the control to activate its own layer. Both shapes come
 * off the same definitions.
 */
export function registerSceneControls(): void {
  Hooks.on("getSceneControlButtons", (controls: any) => {
    if (!game.user?.isGM) return;
    const defs = tools();

    // The overlay draws differently per tool (grab handles fatten under the edit tool),
    // so every tool change has to redraw it, not just every city change.
    const select = (t: NixieTool) => (active: boolean) => {
      t.onSelect?.(active);
      canvas[LAYER_NAME]?.refresh();
    };

    if (Array.isArray(controls)) {
      controls.push({
        name: LAYER_NAME,
        title: CONTROL_TITLE,
        layer: LAYER_NAME,
        icon: CONTROL_ICON,
        visible: true,
        activeTool: DEFAULT_ROAD_CLASS,
        tools: defs.map((t) => ({
          name: t.name,
          title: t.title,
          icon: t.icon,
          button: t.button ?? false,
          toggle: t.toggle ?? false,
          active: t.isActive?.() ?? false,
          onClick: select(t)
        }))
      });
      return;
    }

    const toolRecord: Record<string, unknown> = {};
    defs.forEach((t, order) => {
      toolRecord[t.name] = {
        name: t.name,
        order,
        title: t.title,
        icon: t.icon,
        button: t.button ?? false,
        toggle: t.toggle ?? false,
        active: t.isActive?.() ?? false,
        onChange: (_event: Event, active: boolean) => select(t)(active)
      };
    });

    controls[LAYER_NAME] = {
      name: LAYER_NAME,
      order: Object.keys(controls).length,
      title: CONTROL_TITLE,
      layer: LAYER_NAME,
      icon: CONTROL_ICON,
      visible: true,
      activeTool: DEFAULT_ROAD_CLASS,
      onChange: (_event: Event, active: boolean) => {
        if (active) canvas[LAYER_NAME]?.activate();
      },
      tools: toolRecord
    };
  });
}
