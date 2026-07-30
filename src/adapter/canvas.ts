import { MODULE_ID } from "../constants.js";
import type { CameraState } from "../core/camera.js";
import {
  buildCity,
  cityBounds,
  demoCity,
  type CityBuild,
  type CityParams
} from "../core/gen/demo-city.js";
import { totalWallLength, wallSegmentsFromBlocks } from "../core/gen/walls.js";
import { nextZoneId, zoneAt, type Zone, type ZoneParams } from "../core/gen/zones.js";
import { emptyMesh } from "../core/geom/mesh.js";
import { normalizeRect, type Rect, type Vec2 } from "../core/geom/types.js";
import {
  insertRoad,
  moveNode,
  nearestEdge,
  nearestNode,
  removeRoad,
  toggleSidewalks
} from "../core/graph/edit.js";
import type { RoadGraph, RoadNode } from "../core/graph/road-graph.js";
import { History } from "../core/history.js";
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
/**
 * Wall CRUD is a document round trip per edit, so a stroke-by-stroke rebuild makes
 * drawing feel like it stutters. Coalescing means one rebuild per pause instead.
 */
const WALL_SYNC_DELAY_MS = 400;

let cityRenderer: CityRenderer | null = null;
let tickerCallback: (() => void) | null = null;
let currentCity: CityParams | null = null;
let currentBounds: Rect | null = null;
let lastBuild: CityBuild | null = null;
let cityListener: (() => void) | null = null;
let autoWalls = true;
let wallTimer: ReturnType<typeof setTimeout> | null = null;

const history = new History<CityParams>();

const emptyBuild = (): CityBuild => ({
  mesh: emptyMesh(),
  surfaces: { road: [], sidewalk: [], blocks: [] },
  buildingCount: 0,
  blockCount: 0
});

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

export function pixelsPerMetre(): number {
  const d = canvas.dimensions;
  const distance = d.distance > 0 ? d.distance : 1;
  return d.size / distance;
}

function sceneCentre(): Vec2 {
  const d = canvas.dimensions;
  return {
    x: d.sceneRect.x + d.sceneRect.width / 2,
    y: d.sceneRect.y + d.sceneRect.height / 2
  };
}

function requireCity(): CityParams {
  if (currentCity === null) throw new Error("No city loaded.");
  return currentCity;
}

function regenerate(): CityBuild {
  const city = requireCity();
  if (currentBounds === null) {
    lastBuild = emptyBuild();
    return lastBuild;
  }
  const started = performance.now();
  const build = buildCity(city, currentBounds, pixelsPerMetre());
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
  currentCity = stored
    ? { graph: stored.graph, base: stored.base, zones: stored.zones }
    : demoCity(sceneCentre(), canvas.dimensions.size);
  currentBounds = cityBounds(currentCity, BOUNDS_MARGIN_GRID * canvas.dimensions.size);
  history.clear();

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

  cityListener?.();
  console.log(`${MODULE_ID} | mounted on scene "${canvas.scene?.name}"`);
}

export function unmount(): void {
  if (cityRenderer === null) return;

  if (wallTimer !== null) {
    clearTimeout(wallTimer);
    wallTimer = null;
  }
  if (tickerCallback !== null) {
    canvas.app?.ticker?.remove(tickerCallback);
    tickerCallback = null;
  }
  cityRenderer.display.parent?.removeChild(cityRenderer.display);
  cityRenderer.destroy();
  cityRenderer = null;
  currentCity = null;
  currentBounds = null;
  lastBuild = null;
  history.clear();

  cityListener?.();
  console.log(`${MODULE_ID} | unmounted`);
}

export async function setSceneEnabled(enabled: boolean): Promise<void> {
  await setSceneEnabledFlag(enabled);
  if (!enabled) {
    unmount();
    return;
  }
  if (loadCityState() === null) {
    await saveCityState(demoCity(sceneCentre(), canvas.dimensions.size));
  }
  mount();
}

/* -------------------------------------------- */
/*  Editing                                     */
/* -------------------------------------------- */

/** Push the current params onto the undo stack, then apply the replacement. */
async function commit(next: CityParams): Promise<CityBuild> {
  if (currentCity !== null) history.push(currentCity);
  return apply(next);
}

async function apply(next: CityParams): Promise<CityBuild> {
  currentCity = next;
  currentBounds = cityBounds(next, BOUNDS_MARGIN_GRID * canvas.dimensions.size);
  await saveCityState(next);
  const build = rebuildGeometry();
  cityListener?.();
  scheduleWallSync();
  return build;
}

function scheduleWallSync(): void {
  if (!autoWalls || lastBuild === null) return;
  if (wallTimer !== null) clearTimeout(wallTimer);
  wallTimer = setTimeout(() => {
    wallTimer = null;
    void buildWalls().catch((err) => console.error(`${MODULE_ID} | wall sync failed`, err));
  }, WALL_SYNC_DELAY_MS);
}

/**
 * Fuse radius for a drawn endpoint. Grid snapping puts candidate points half a square
 * apart (vertices plus centres), so staying under that keeps a deliberately chosen
 * neighbouring point from being swallowed by the node next to it.
 */
export function snapRadiusPx(): number {
  return canvas.dimensions.size * 0.4;
}

/** Erase should hit anywhere on a road, not just within a hair of its centreline. */
function eraseReachPx(graph: RoadGraph): number {
  const ppm = pixelsPerMetre();
  const widest = graph.classes.reduce(
    (max, c) => Math.max(max, (c.widthM / 2 + c.sidewalkM) * ppm),
    0
  );
  return Math.max(snapRadiusPx(), widest);
}

export function snapWorldPoint(p: Vec2): Vec2 {
  const modes = CONST.GRID_SNAPPING_MODES;
  const snapped = canvas.grid.getSnappedPoint(p, {
    mode: modes.VERTEX | modes.CENTER,
    resolution: 1
  });
  return { x: snapped.x, y: snapped.y };
}

export async function drawRoad(from: Vec2, to: Vec2, classId: string): Promise<CityBuild | null> {
  const city = requireCity();
  const graph = insertRoad(city.graph, from, to, classId, { snapPx: snapRadiusPx() });
  if (graph === city.graph) return null;
  return commit({ ...city, graph });
}

/** Delete whatever the click landed on: a road first, else the zone underneath. */
export async function eraseAt(p: Vec2): Promise<"road" | "zone" | null> {
  const city = requireCity();

  const edge = nearestEdge(city.graph, p, eraseReachPx(city.graph));
  if (edge !== null) {
    await commit({ ...city, graph: removeRoad(city.graph, edge.id) });
    return "road";
  }

  const zone = zoneAt(city.zones, p);
  if (zone !== null) {
    await commit({ ...city, zones: city.zones.filter((z) => z.id !== zone.id) });
    return "zone";
  }
  return null;
}

/** The junction under the cursor, for the edit tool's grab test. */
export function junctionAt(p: Vec2): RoadNode | null {
  const city = currentCity;
  return city === null ? null : nearestNode(city.graph, p, snapRadiusPx());
}

/** Drag a junction somewhere else. Dropping it on another junction welds the two. */
export async function moveJunction(nodeId: string, to: Vec2): Promise<CityBuild | null> {
  const city = requireCity();
  const graph = moveNode(city.graph, nodeId, to, { snapPx: snapRadiusPx() });
  if (graph === city.graph) return null;
  return commit({ ...city, graph });
}

/** Flip the pavement on the road under the cursor. */
export async function toggleWalkwayAt(p: Vec2): Promise<boolean> {
  const city = requireCity();
  const edge = nearestEdge(city.graph, p, eraseReachPx(city.graph));
  if (edge === null) return false;
  await commit({ ...city, graph: toggleSidewalks(city.graph, edge.id) });
  return true;
}

export async function createZone(rect: Rect, params?: Partial<ZoneParams>): Promise<Zone | null> {
  const city = requireCity();
  const area = normalizeRect(rect);
  const min = canvas.dimensions.size;
  if (area.width < min || area.height < min) return null;

  const zone: Zone = {
    ...city.base,
    ...params,
    id: nextZoneId(city.zones),
    rect: area,
    seed: params?.seed ?? randomSeed()
  };
  await commit({ ...city, zones: [...city.zones, zone] });
  return zone;
}

export async function reseedZoneAt(p: Vec2): Promise<Zone | null> {
  const city = requireCity();
  const zone = zoneAt(city.zones, p);
  if (zone === null) return null;
  const reseeded: Zone = { ...zone, seed: randomSeed() };
  await commit({
    ...city,
    zones: city.zones.map((z) => (z.id === zone.id ? reseeded : z))
  });
  return reseeded;
}

/** Reseed the params governing everything no zone covers. */
export async function reseedBase(): Promise<number> {
  const city = requireCity();
  const seed = randomSeed();
  await commit({ ...city, base: { ...city.base, seed } });
  return seed;
}

export async function setZoneParams(zoneId: string, params: Partial<ZoneParams>): Promise<Zone> {
  const city = requireCity();
  const zone = city.zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error(`No zone "${zoneId}". Known: ${city.zones.map((z) => z.id).join(", ")}`);
  const updated: Zone = { ...zone, ...params };
  await commit({ ...city, zones: city.zones.map((z) => (z.id === zoneId ? updated : z)) });
  return updated;
}

export async function setBaseParams(params: Partial<ZoneParams>): Promise<ZoneParams> {
  const city = requireCity();
  const base = { ...city.base, ...params };
  await commit({ ...city, base });
  return base;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export async function undo(): Promise<boolean> {
  const city = requireCity();
  const previous = history.undo(city);
  if (previous === null) return false;
  await apply(previous);
  return true;
}

export async function redo(): Promise<boolean> {
  const city = requireCity();
  const next = history.redo(city);
  if (next === null) return false;
  await apply(next);
  return true;
}

export const canUndo = (): boolean => history.canUndo;
export const canRedo = (): boolean => history.canRedo;

export function setAutoWalls(enabled: boolean): boolean {
  autoWalls = enabled;
  if (enabled) scheduleWallSync();
  return autoWalls;
}

export const autoWallsEnabled = (): boolean => autoWalls;

/** The editor layer redraws its overlay through this rather than polling every frame. */
export function setCityListener(listener: (() => void) | null): void {
  cityListener = listener;
}

/* -------------------------------------------- */
/*  Build and query                             */
/* -------------------------------------------- */

/** Rebuild geometry from the in-memory params and push it to the renderer. */
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

/** Remove a road by id and bring geometry and walls back into agreement. */
export async function removeEdge(edgeId: string): Promise<CityBuild> {
  const city = requireCity();
  const graph = removeRoad(city.graph, edgeId);
  if (graph === city.graph) {
    throw new Error(`No edge "${edgeId}". Known: ${city.graph.edges.map((e) => e.id).join(", ")}`);
  }
  return commit({ ...city, graph });
}

export async function resetCity(): Promise<CityBuild> {
  return commit(demoCity(sceneCentre(), canvas.dimensions.size));
}

export function getCity(): CityParams | null {
  return currentCity;
}

export function getGraph(): RoadGraph | null {
  return currentCity?.graph ?? null;
}

export const isMounted = (): boolean => cityRenderer !== null;

export function stats(): Record<string, unknown> | null {
  if (cityRenderer === null) return null;
  return {
    ...cityRenderer.stats(),
    buildings: lastBuild?.buildingCount ?? 0,
    blocks: lastBuild?.blockCount ?? 0,
    nodes: currentCity?.graph.nodes.length ?? 0,
    edges: currentCity?.graph.edges.length ?? 0,
    zones: currentCity?.zones.length ?? 0,
    undoDepth: history.depth,
    autoWalls,
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
