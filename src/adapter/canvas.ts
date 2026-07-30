import type { CameraState } from "../core/camera.js";
import {
  buildCity,
  demoGraph,
  graphBounds,
  lotOptionsFromMetres,
  type CityBuild
} from "../core/gen/demo-city.js";
import { DEFAULT_MATERIALS, packPalette } from "../core/palette.js";
import { CityRenderer } from "../render/city-renderer.js";

export const MODULE_ID = "project-nixie";
const FLAG_ENABLED = "enabled";
// Screen-space lean is height/(camHeight-height) times the on-screen distance from the
// pivot, independent of zoom. 900 m puts a 130 m tower at ~0.18, which matches the
// reference art; drop it toward 400 for a much harder lean.
const DEFAULT_CAMERA_HEIGHT_M = 900;

let cityRenderer: CityRenderer | null = null;
let tickerCallback: (() => void) | null = null;
let lastBuild: CityBuild | null = null;

function readCamera(): CameraState {
  return {
    stageX: canvas.stage.position.x,
    stageY: canvas.stage.position.y,
    pivotX: canvas.stage.pivot.x,
    pivotY: canvas.stage.pivot.y,
    scale: canvas.stage.scale.x,
    screenWidth: canvas.app.renderer.screen.width,
    screenHeight: canvas.app.renderer.screen.height
  };
}

function pixelsPerMetre(): number {
  const d = canvas.dimensions;
  const distance = d.distance > 0 ? d.distance : 1;
  return d.size / distance;
}

function buildDemoCity(): CityBuild {
  const d = canvas.dimensions;
  const origin = {
    x: d.sceneRect.x + d.sceneRect.width / 2,
    y: d.sceneRect.y + d.sceneRect.height / 2
  };
  const ppm = pixelsPerMetre();
  const graph = demoGraph(origin, d.size);
  return buildCity(graph, graphBounds(graph, 10 * d.size), ppm, lotOptionsFromMetres(ppm));
}

export function isEnabledForScene(): boolean {
  return canvas?.scene?.getFlag(MODULE_ID, FLAG_ENABLED) === true;
}

export function mount(): void {
  if (cityRenderer !== null) return;
  if (!canvas?.ready || !canvas.app?.renderer || !canvas.primary) return;

  const started = performance.now();
  lastBuild = buildDemoCity();
  const generateMS = performance.now() - started;

  cityRenderer = new CityRenderer(
    canvas.app.renderer,
    lastBuild.mesh,
    packPalette(DEFAULT_MATERIALS),
    { pixelsPerMetre: pixelsPerMetre(), cameraHeightMetres: DEFAULT_CAMERA_HEIGHT_M }
  );
  console.log(
    `${MODULE_ID} | generated ${lastBuild.buildingCount} buildings in ${lastBuild.blockCount} blocks ` +
      `(${lastBuild.mesh.triangleCount} tris) in ${generateMS.toFixed(1)}ms`
  );

  // PrimaryCanvasGroup orders children by elevation, then sortLayer/sort/zIndex.
  // Same comparator in v12 and v14, so this placement is generation-stable.
  cityRenderer.display.elevation = canvas.primary.constructor.BACKGROUND_ELEVATION ?? 0;
  cityRenderer.display.sortLayer = 0;
  cityRenderer.display.sort = 0;
  canvas.primary.addChild(cityRenderer.display);
  canvas.primary.sortDirty = true;

  // HIGH outruns PIXI.Application's own render, which sits at LOW; the offscreen
  // target is therefore current by the time the stage is drawn.
  tickerCallback = () => cityRenderer?.update(readCamera());
  canvas.app.ticker.add(tickerCallback, null, PIXI.UPDATE_PRIORITY.HIGH);

  console.log(`${MODULE_ID} | mounted on scene "${canvas.scene?.name}"`);
}

export function unmount(): void {
  if (cityRenderer === null) return;

  if (tickerCallback !== null) {
    canvas.app?.ticker?.remove(tickerCallback);
    tickerCallback = null;
  }
  cityRenderer.display.parent?.removeChild(cityRenderer.display);
  cityRenderer.destroy();
  cityRenderer = null;
  lastBuild = null;

  console.log(`${MODULE_ID} | unmounted`);
}

export async function setSceneEnabled(enabled: boolean): Promise<void> {
  if (!canvas?.scene) throw new Error("No active scene.");
  await canvas.scene.setFlag(MODULE_ID, FLAG_ENABLED, enabled);
  if (enabled) mount();
  else unmount();
}

export function stats(): Record<string, unknown> | null {
  if (cityRenderer === null) return null;
  return {
    ...cityRenderer.stats(),
    buildings: lastBuild?.buildingCount ?? 0,
    blocks: lastBuild?.blockCount ?? 0
  };
}

export function getRenderer(): CityRenderer | null {
  return cityRenderer;
}

export function registerHooks(): void {
  Hooks.on("canvasReady", () => {
    unmount();
    if (isEnabledForScene()) mount();
  });
  Hooks.on("canvasTearDown", () => unmount());
}
