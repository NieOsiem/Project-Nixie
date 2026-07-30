import { MODULE_ID } from "./constants.js";
import {
  buildWalls,
  clearWalls,
  getGraph,
  getRenderer,
  isSceneEnabled,
  rebuildGeometry,
  registerHooks,
  removeEdge,
  resetCity,
  setSceneEnabled,
  stats
} from "./adapter/canvas.js";

Hooks.once("init", () => {
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
    rebuild: () => rebuildGeometry(),

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
