import {
  MODULE_ID,
  SETTING_CAMERA_HEIGHT,
  SETTING_CAMERA_ZOOM_MODE,
  SETTING_RENDER_SCALE,
  type CameraZoomMode
} from "./constants.js";
import {
  adjustLeanAtCurrentZoom,
  autoWallsEnabled,
  buildWalls,
  clearLeanCalibration,
  clearWalls,
  commitDistrictPalette,
  getCity,
  getGraph,
  getLeanCalibrationReport,
  isSceneEnabled,
  listDistricts,
  lookDials,
  rebuildGeometry,
  redo,
  registerHooks,
  removeEdge,
  reseedBase,
  resetCity,
  saveLeanCalibrationPoint,
  setAutoWalls,
  setBaseParams,
  setLeanAtCurrentZoom,
  setLookDials,
  setSceneEnabled,
  setZoneParams,
  stats,
  undo
} from "./adapter/canvas.js";
import { PALETTE_PRESETS, normalizePalette, type DistrictPalette } from "./core/palette.js";
import { registerSettings, setSettingValue, settingValue } from "./settings.js";
import { registerSceneControls } from "./ui/controls.js";
import { LAYER_NAME, nixieLayerClass } from "./ui/nixie-layer.js";
import { openPaletteApp } from "./ui/palette-app.js";

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
  registerSettings();
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

    listDistricts,
    palettePresets: () => PALETTE_PRESETS,
    setDistrictPalette: (id: string, palette: Partial<DistrictPalette>) =>
      commitDistrictPalette(id, normalizePalette(palette)),
    openPaletteApp,

    // Through the settings, not the renderer, so the console and the settings sheet cannot
    // disagree about what the dial is currently set to.
    setRenderScale: async (value: number) => {
      await setSettingValue(SETTING_RENDER_SCALE, value);
      return settingValue<number>(SETTING_RENDER_SCALE);
    },
    setCameraHeight: async (metres: number) => {
      await setSettingValue(SETTING_CAMERA_HEIGHT, metres);
      return settingValue<number>(SETTING_CAMERA_HEIGHT);
    },
    setCameraZoomMode: async (mode: CameraZoomMode) => {
      await setSettingValue(SETTING_CAMERA_ZOOM_MODE, mode);
      return settingValue<CameraZoomMode>(SETTING_CAMERA_ZOOM_MODE);
    },

    lookDials,
    setLookDials,

    setLeanAtCurrentZoom,
    adjustLeanAtCurrentZoom,
    saveLeanCalibrationPoint,
    getLeanCalibrationReport,
    clearLeanCalibration
  };

  console.log(`${MODULE_ID} | initialised`);
});
