import {
  adjustLeanAtCurrentZoom,
  cityLoadStatus,
  clearRoadSelection,
  clearLeanCalibration,
  createCoastalTerrain,
  createRectangleTerrain,
  appendRoad,
  deleteRoadJunction,
  deleteRoads,
  currentWeather,
  deleteUrbanFootprint,
  getCity,
  getLeanCalibrationReport,
  getRoadSelection,
  generateRoads,
  isSceneEnabled,
  lookDials,
  moveTerrainVertex,
  moveRoadNode,
  rebuildGeometry,
  redo,
  registerHooks,
  replaceLand,
  replaceUrbanFootprint,
  renameRoad,
  reclassifyRoad,
  roadInspector,
  setRoadLocked,
  setRoadCurvePreset,
  setRoadGridSnap,
  selectRoad,
  selectRoadNode,
  weldRoadNodes,
  saveLeanCalibrationPoint,
  setLeanAtCurrentZoom,
  setLookDials,
  setSceneEnabled,
  stats,
  undo
} from "./adapter/canvas.js";
import {
  MODULE_ID,
  SETTING_CAMERA_HEIGHT,
  SETTING_CAMERA_ZOOM_MODE,
  SETTING_RAIN_STRENGTH,
  SETTING_RENDER_SCALE,
  SETTING_WEATHER,
  type CameraZoomMode,
  type Weather
} from "./constants.js";
import { WEATHER_PRESETS } from "./render/look-dials.js";
import { registerSettings, setSettingValue, settingValue } from "./settings.js";
import { registerSceneControls } from "./ui/controls.js";
import { LAYER_NAME, nixieLayerClass } from "./ui/nixie-layer.js";
import { registerRoadSceneControls } from "./ui/road-controls.js";
import { ROAD_LAYER_NAME, roadLayerClass } from "./ui/road-layer.js";
import { openRoadApp } from "./ui/road-app.js";
import { openTerrainApp } from "./ui/terrain-app.js";

const CONTROL = "Control";
const SHIFT = "Shift";

function registerKeybindings(): void {
  const whenEditing = (action: () => Promise<unknown>) => (): boolean => {
    if (![LAYER_NAME, ROAD_LAYER_NAME].includes(canvas?.activeLayer?.options?.name)) return false;
    void action();
    return true;
  };
  game.keybindings.register(MODULE_ID, "undo", {
    name: "Nixie: Undo Terrain Edit",
    editable: [{ key: "KeyZ", modifiers: [CONTROL] }],
    restricted: true,
    onDown: whenEditing(undo)
  });
  game.keybindings.register(MODULE_ID, "redo", {
    name: "Nixie: Redo Terrain Edit",
    editable: [{ key: "KeyZ", modifiers: [CONTROL, SHIFT] }],
    restricted: true,
    onDown: whenEditing(redo)
  });
}

Hooks.once("init", () => {
  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: nixieLayerClass(), group: "interface" };
  CONFIG.Canvas.layers[ROAD_LAYER_NAME] = { layerClass: roadLayerClass(), group: "interface" };
  registerSettings();
  registerSceneControls();
  registerRoadSceneControls();
  registerKeybindings();
  registerHooks();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    enable: () => setSceneEnabled(true),
    disable: () => setSceneEnabled(false),
    isEnabled: () => isSceneEnabled(),
    cityStatus: cityLoadStatus,
    stats,
    getCity,
    rebuild: rebuildGeometry,
    createRectangle: createRectangleTerrain,
    createCoastal: createCoastalTerrain,
    replaceLand,
    replaceUrbanFootprint,
    generateRoads,
    appendRoad,
    getRoadSelection,
    clearRoadSelection,
    roadInspector,
    moveRoadNode,
    weldRoadNodes,
    deleteRoadJunction,
    renameRoad,
    reclassifyRoad,
    setRoadLocked,
    setRoadCurvePreset,
    setRoadGridSnap,
    selectRoad,
    selectRoadNode,
    deleteRoads,
    moveTerrainVertex,
    deleteUrbanFootprint,
    undo,
    redo,
    openTerrainApp,
    openRoadApp,
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
    setRain: async (strength: number) => {
      await setSettingValue(SETTING_RAIN_STRENGTH, strength);
      return settingValue<number>(SETTING_RAIN_STRENGTH);
    },
    setWeather: async (preset: Weather) => {
      await setSettingValue(SETTING_WEATHER, preset);
      return settingValue<Weather>(SETTING_WEATHER);
    },
    weather: currentWeather,
    weatherPresets: () => WEATHER_PRESETS,
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
