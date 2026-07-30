import { MODULE_ID } from "./constants.js";
import {
  autoWallsEnabled,
  buildWalls,
  clearWalls,
  getCity,
  getGraph,
  getRenderer,
  isSceneEnabled,
  rebuildGeometry,
  redo,
  registerHooks,
  removeEdge,
  reseedBase,
  resetCity,
  setAutoWalls,
  setBaseParams,
  setSceneEnabled,
  setZoneParams,
  stats,
  undo
} from "./adapter/canvas.js";
import { registerSceneControls } from "./ui/controls.js";
import { LAYER_NAME, nixieLayerClass } from "./ui/nixie-layer.js";

// KeyboardManager.MODIFIER_KEYS values, identical in v12 and v14. Hardcoded because the
// class moved namespace between the two and the strings did not.
const CONTROL = "Control";
const SHIFT = "Shift";

function registerKeybindings(): void {
  // Returning false lets the press fall through to core's own Ctrl+Z, which no-ops for a
  // non-PlaceablesLayer anyway.
  const whenEditing = (action: () => Promise<unknown>) => (): boolean => {
    if (canvas?.activeLayer?.options?.name !== LAYER_NAME) return false;
    void action();
    return true;
  };

  game.keybindings.register(MODULE_ID, "undo", {
    name: "Nixie: Undo Edit",
    editable: [{ key: "KeyZ", modifiers: [CONTROL] }],
    restricted: true,
    onDown: whenEditing(undo)
  });
  game.keybindings.register(MODULE_ID, "redo", {
    name: "Nixie: Redo Edit",
    editable: [{ key: "KeyZ", modifiers: [CONTROL, SHIFT] }],
    restricted: true,
    onDown: whenEditing(redo)
  });
}

Hooks.once("init", () => {
  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: nixieLayerClass(), group: "interface" };
  registerSceneControls();
  registerKeybindings();
  registerHooks();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    enable: () => setSceneEnabled(true),
    disable: () => setSceneEnabled(false),
    isEnabled: () => isSceneEnabled(),
    stats,

    buildWalls,
    clearWalls,
    removeEdge,
    resetCity,
    getGraph,
    getCity,
    rebuild: () => rebuildGeometry(),

    undo,
    redo,
    reseedBase,
    setZoneParams,
    setBaseParams,
    setAutoWalls,
    autoWallsEnabled,

    setRenderScale: (value: number) => {
      const r = getRenderer();
      if (r) r.renderScale = value;
      return r?.renderScale ?? null;
    },
    setCameraHeight: (metres: number) => {
      const r = getRenderer();
      if (r) r.cameraHeightMetres = metres;
      return r?.cameraHeightMetres ?? null;
    }
  };

  console.log(`${MODULE_ID} | initialised`);
});
