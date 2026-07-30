import type { CameraState, Rect } from "../core/camera.js";
import { CityRenderer } from "../render/city-renderer.js";

export const MODULE_ID = "project-nixie";
const FLAG_ENABLED = "enabled";

let cityRenderer: CityRenderer | null = null;
let tickerCallback: (() => void) | null = null;

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

function demoRect(): Rect {
  const d = canvas.dimensions;
  return {
    x: d.sceneRect.x + d.sceneRect.width / 2 - d.size * 5,
    y: d.sceneRect.y + d.sceneRect.height / 2 - d.size * 3,
    width: d.size * 10,
    height: d.size * 6
  };
}

export function isEnabledForScene(): boolean {
  return canvas?.scene?.getFlag(MODULE_ID, FLAG_ENABLED) === true;
}

export function mount(): void {
  if (cityRenderer !== null) return;
  if (!canvas?.ready || !canvas.app?.renderer || !canvas.primary) return;

  cityRenderer = new CityRenderer(canvas.app.renderer, demoRect());

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

  console.log(`${MODULE_ID} | unmounted`);
}

export async function setSceneEnabled(enabled: boolean): Promise<void> {
  if (!canvas?.scene) throw new Error("No active scene.");
  await canvas.scene.setFlag(MODULE_ID, FLAG_ENABLED, enabled);
  if (enabled) mount();
  else unmount();
}

export function stats(): Record<string, unknown> | null {
  return cityRenderer?.stats() ?? null;
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
