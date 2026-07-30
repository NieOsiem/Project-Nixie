import { MODULE_ID } from "../constants.js";
import type { CameraState } from "../core/camera.js";
import {
  buildCity,
  demoGraph,
  graphBounds,
  lotOptionsFromMetres,
  type CityBuild
} from "../core/gen/demo-city.js";
import { totalWallLength, wallSegmentsFromBlocks } from "../core/gen/walls.js";
import type { Rect } from "../core/geom/types.js";
import type { RoadGraph } from "../core/graph/road-graph.js";
import { DEFAULT_MATERIALS, packPalette } from "../core/palette.js";
import { CityRenderer } from "../render/city-renderer.js";
import {
  isSceneEnabled,
  loadCityState,
  replaceGeneratedWalls,
  saveCityState,
  setSceneEnabledFlag,
  deleteGeneratedWalls,
  generatedWallIds
} from "./documents.js";

// Screen-space lean is height/(camHeight-height) times the on-screen distance from the
// pivot, independent of zoom. 900 m puts a 130 m tower at ~0.18, which matches the
// reference art; drop it toward 400 for a much harder lean.
const DEFAULT_CAMERA_HEIGHT_M = 900;
/** One metre of slack collapses junction-disc arcs without visibly moving a wall. */
const WALL_TOLERANCE_M = 1;
const BOUNDS_MARGIN_GRID = 10;

let cityRenderer: CityRenderer | null = null;
let tickerCallback: (() => void) | null = null;
let currentGraph: RoadGraph | null = null;
let currentBounds: Rect | null = null;
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

function sceneCentre(): { x: number; y: number } {
  const d = canvas.dimensions;
  return {
    x: d.sceneRect.x + d.sceneRect.width / 2,
    y: d.sceneRect.y + d.sceneRect.height / 2
  };
}

function regenerate(): CityBuild {
  if (currentGraph === null || currentBounds === null) throw new Error("No city loaded.");
  const ppm = pixelsPerMetre();
  const started = performance.now();
  const build = buildCity(currentGraph, currentBounds, ppm, lotOptionsFromMetres(ppm));
  lastBuild = build;
  console.log(
    `${MODULE_ID} | ${build.buildingCount} buildings in ${build.blockCount} blocks ` +
      `(${build.mesh.triangleCount} tris) in ${(performance.now() - started).toFixed(1)}ms`
  );
  return build;
}

export function mount(): void {
  if (cityRenderer !== null) return;
  if (!canvas?.ready || !canvas.app?.renderer || !canvas.primary) return;

  const stored = loadCityState();
  currentGraph = stored?.graph ?? demoGraph(sceneCentre(), canvas.dimensions.size);
  currentBounds = graphBounds(currentGraph, BOUNDS_MARGIN_GRID * canvas.dimensions.size);

  cityRenderer = new CityRenderer(
    canvas.app.renderer,
    regenerate().mesh,
    packPalette(DEFAULT_MATERIALS),
    { pixelsPerMetre: pixelsPerMetre(), cameraHeightMetres: DEFAULT_CAMERA_HEIGHT_M }
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
  currentGraph = null;
  currentBounds = null;
  lastBuild = null;

  console.log(`${MODULE_ID} | unmounted`);
}

export async function setSceneEnabled(enabled: boolean): Promise<void> {
  await setSceneEnabledFlag(enabled);
  if (!enabled) {
    unmount();
    return;
  }
  if (loadCityState() === null) {
    await saveCityState(demoGraph(sceneCentre(), canvas.dimensions.size));
  }
  mount();
}

/** Rebuild geometry from the in-memory graph and push it to the renderer. */
export function rebuildGeometry(): CityBuild {
  const build = regenerate();
  cityRenderer?.setGeometry(build.mesh);
  return build;
}

export async function buildWalls(): Promise<{ created: number; deleted: number }> {
  if (lastBuild === null) throw new Error("No city loaded.");
  const tolerance = WALL_TOLERANCE_M * pixelsPerMetre();
  const segments = wallSegmentsFromBlocks(lastBuild.surfaces.blocks, { tolerancePx: tolerance });
  const result = await replaceGeneratedWalls(segments);
  console.log(
    `${MODULE_ID} | ${result.created} walls (${Math.round(totalWallLength(segments) / pixelsPerMetre())}m), ` +
      `replaced ${result.deleted}`
  );
  return result;
}

export async function clearWalls(): Promise<number> {
  return deleteGeneratedWalls();
}

/** Remove a road and bring geometry and walls back into agreement. */
export async function removeEdge(edgeId: string): Promise<CityBuild> {
  if (currentGraph === null) throw new Error("No city loaded.");
  const remaining = currentGraph.edges.filter((e) => e.id !== edgeId);
  if (remaining.length === currentGraph.edges.length) {
    throw new Error(`No edge "${edgeId}". Known: ${currentGraph.edges.map((e) => e.id).join(", ")}`);
  }

  currentGraph = { ...currentGraph, edges: remaining };
  await saveCityState(currentGraph);
  const build = rebuildGeometry();
  await buildWalls();
  return build;
}

export async function resetCity(): Promise<CityBuild> {
  currentGraph = demoGraph(sceneCentre(), canvas.dimensions.size);
  currentBounds = graphBounds(currentGraph, BOUNDS_MARGIN_GRID * canvas.dimensions.size);
  await saveCityState(currentGraph);
  const build = rebuildGeometry();
  await buildWalls();
  return build;
}

export function getGraph(): RoadGraph | null {
  return currentGraph;
}

export function stats(): Record<string, unknown> | null {
  if (cityRenderer === null) return null;
  return {
    ...cityRenderer.stats(),
    buildings: lastBuild?.buildingCount ?? 0,
    blocks: lastBuild?.blockCount ?? 0,
    edges: currentGraph?.edges.length ?? 0,
    generatedWalls: generatedWallIds().length
  };
}

export function getRenderer(): CityRenderer | null {
  return cityRenderer;
}

export { isSceneEnabled };

export function registerHooks(): void {
  Hooks.on("canvasReady", () => {
    unmount();
    if (isSceneEnabled()) mount();
  });
  Hooks.on("canvasTearDown", () => unmount());
}
