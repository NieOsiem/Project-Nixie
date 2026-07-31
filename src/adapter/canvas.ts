import { MODULE_ID } from "../constants.js";
import type { CameraState } from "../core/camera.js";
import { buildChunk, chunkMarginM, cityChunks } from "../core/gen/chunked.js";
import { chunkId, chunksCovering, type ChunkKey } from "../core/gen/chunks.js";
import {
  cityBounds,
  cityPaletteBanks,
  cityToPixels,
  demoCity,
  metresToPixels,
  pixelsToMetres,
  rectToPixels,
  type CityParams
} from "../core/gen/demo-city.js";
import { buildRoadSurfaces } from "../core/gen/roads.js";
import { totalWallLength, wallSegmentsFromBlocks } from "../core/gen/walls.js";
import {
  nextZoneBank,
  nextZoneId,
  zoneAt,
  type Zone,
  type ZoneParams
} from "../core/gen/zones.js";
import { emptyMesh, type MeshBuffers } from "../core/geom/mesh.js";
import {
  normalizeRect,
  ringBounds,
  type MultiPolygon,
  type Rect,
  type Vec2
} from "../core/geom/types.js";
import {
  insertRoad,
  moveNode,
  nearestEdge,
  nearestNode,
  removeRoad,
  snapToGraph,
  toggleSidewalks
} from "../core/graph/edit.js";
import {
  incidentEdges,
  nodeMap,
  type RoadEdge,
  type RoadGraph,
  type RoadNode
} from "../core/graph/road-graph.js";
import { History } from "../core/history.js";
import {
  BASE_BANK,
  normalizePalette,
  packPalette,
  type DistrictPalette,
  type Material
} from "../core/palette.js";
import { CityRenderer, type ChunkGeometry } from "../render/city-renderer.js";
import { WorkerClient } from "../worker/client.js";
import type { BuildChunkResult } from "../worker/protocol.js";
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
// pivot, independent of zoom. 500 m puts a 130 m tower at ~0.35; drop it toward 350 for a
// harder lean, raise it toward 2000 for near-flat. Overridden by the world setting.
const DEFAULT_CAMERA_HEIGHT_M = 500;
/** One metre of slack collapses junction-disc arcs without visibly moving a wall. */
const WALL_TOLERANCE_M = 1;
/** Ten grid squares on the 2 m/square scene contract. Metres, so a regrid cannot move it. */
const BOUNDS_MARGIN_M = 20;
/**
 * Wall CRUD is a document round trip per edit, so a stroke-by-stroke rebuild makes
 * drawing feel like it stutters. Coalescing means one rebuild per pause instead.
 */
const WALL_SYNC_DELAY_MS = 400;

export interface RebuildResult {
  /** False means only the chunks a dirty rect reached were rebuilt. */
  full: boolean;
  /** How many chunks were regenerated, not how many the city has. */
  chunks: number;
  buildings: number;
  ms: number;
}

/** The slice of a chunk build the adapter keeps. `ChunkBuild` and a worker result both fit. */
interface ChunkRecord {
  id: string;
  mesh: MeshBuffers;
  neon: MeshBuffers;
  boundsM: Rect;
  buildingCount: number;
}

let cityRenderer: CityRenderer | null = null;
let tickerCallback: (() => void) | null = null;
let currentCity: CityParams | null = null;
/** City extent in metres. Chunk generation clamps to it, so a change invalidates every chunk. */
let currentBounds: Rect | null = null;
let cityListener: (() => void) | null = null;
let autoWalls = true;
let wallTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Look dials. Held here rather than read from `game.settings` so this module never imports
 * the settings module, which imports this one — `settings.ts` pushes values in instead.
 * All four tolerate being set before a renderer exists.
 */
let cameraHeightM = DEFAULT_CAMERA_HEIGHT_M;
let renderScale = 1;
let bloomEnabled = true;
let bloomStrength = 1;

/** Unsaved palette being dragged in the editor. Cleared on commit or cancel. */
let palettePreview: { id: string; palette: DistrictPalette } | null = null;

let workerClient: WorkerClient | null = null;
/** Latched: a Worker that could not be constructed once will not construct on a retry either. */
let workerUnavailable = false;
let workerWarned = false;
/** Bumped whenever the params change, so a build issued against the old ones is discardable. */
let buildEpoch = 0;
/** False while a full rebuild is in flight or was superseded — the chunk set may have holes. */
let chunkSetComplete = false;

const chunks = new Map<string, ChunkRecord>();
const history = new History<CityParams>();

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

/** Metres per grid square — the scene's own `distance`. */
function gridMetres(): number {
  const distance = canvas.dimensions.distance;
  return distance > 0 ? distance : 1;
}

export function pixelsPerMetre(): number {
  return canvas.dimensions.size / gridMetres();
}

function sceneCentre(): Vec2 {
  const d = canvas.dimensions;
  return {
    x: d.sceneRect.x + d.sceneRect.width / 2,
    y: d.sceneRect.y + d.sceneRect.height / 2
  };
}

/** Where city metre coordinate (0, 0) sits, in scene world pixels. */
function cityOrigin(): Vec2 {
  return currentCity?.origin ?? sceneCentre();
}

/** World pixels in, city metres out. Every pointer coordinate crosses this on its way in. */
export function worldToMetres(p: Vec2): Vec2 {
  return pixelsToMetres(p, cityOrigin(), pixelsPerMetre());
}

export function metresToWorld(p: Vec2): Vec2 {
  return metresToPixels(p, cityOrigin(), pixelsPerMetre());
}

function requireCity(): CityParams {
  if (currentCity === null) throw new Error("No city loaded.");
  return currentCity;
}

export function mount(): void {
  if (cityRenderer !== null) return;
  if (!canvas?.ready || !canvas.app?.renderer || !canvas.primary) return;

  const stored = loadCityState();
  currentCity = stored
    ? { origin: stored.origin, graph: stored.graph, base: stored.base, zones: stored.zones }
    : demoCity(sceneCentre());
  currentBounds = cityBounds(currentCity, BOUNDS_MARGIN_M);
  history.clear();

  cityRenderer = new CityRenderer(
    canvas.app.renderer,
    emptyMesh(),
    packPalette(paletteBanks(currentCity)),
    { pixelsPerMetre: pixelsPerMetre(), cameraHeightMetres: cameraHeightM }
  );
  cityRenderer.renderScale = renderScale;
  cityRenderer.bloomEnabled = bloomEnabled;
  cityRenderer.bloomStrength = bloomStrength;
  // WHY: the constructor installs an empty whole-city chunk. Chunked builds own the
  // renderer's chunk set now, and nothing else drops that placeholder any more.
  cityRenderer.clearChunks();
  void rebuildGeometry().catch((err) => console.error(`${MODULE_ID} | rebuild failed`, err));

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
  workerClient?.terminate();
  workerClient = null;
  cityRenderer.display.parent?.removeChild(cityRenderer.display);
  cityRenderer.destroy();
  cityRenderer = null;
  currentCity = null;
  currentBounds = null;
  // Discards builds still in flight, which would otherwise refill `chunks` after the clear.
  buildEpoch++;
  chunkSetComplete = false;
  chunks.clear();
  history.clear();
  palettePreview = null;

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
    await saveCityState(demoCity(sceneCentre()));
  }
  mount();
}

/* -------------------------------------------- */
/*  Editing                                     */
/* -------------------------------------------- */

/**
 * Push the current params onto the undo stack, then apply the replacement.
 *
 * `dirtyM` is the metre-space rect the edit disturbed; null forces a full rebuild.
 */
async function commit(next: CityParams, dirtyM: Rect | null = null): Promise<RebuildResult> {
  if (currentCity !== null) history.push(currentCity);
  return apply(next, dirtyM);
}

async function apply(next: CityParams, dirtyM: Rect | null = null): Promise<RebuildResult> {
  const previousBounds = currentBounds;
  currentCity = next;
  currentBounds = cityBounds(next, BOUNDS_MARGIN_M);
  buildEpoch++;
  await saveCityState(next);
  // WHY: an incremental pass only touches chunks already in the set, so it cannot fill the
  // holes a superseded full rebuild left behind.
  const incremental =
    chunkSetComplete && dirtyM !== null && sameRect(previousBounds, currentBounds);
  // Ahead of the rebuild: the overlay draws from the params, which are already current.
  cityListener?.();
  scheduleWallSync();
  return incremental ? rebuildDirty(dirtyM) : rebuildAll();
}

function scheduleWallSync(): void {
  if (!autoWalls || currentCity === null) return;
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
export function snapRadiusM(): number {
  return gridMetres() * 0.4;
}

/** Erase should hit anywhere on a road, not just within a hair of its centreline. */
function eraseReachM(graph: RoadGraph): number {
  const widest = graph.classes.reduce((max, c) => Math.max(max, c.widthM / 2 + c.sidewalkM), 0);
  return Math.max(snapRadiusM(), widest);
}

/** Foundry's grid snap is a pixel-space call, so this stays pixels in, pixels out. */
export function snapWorldPoint(p: Vec2): Vec2 {
  const modes = CONST.GRID_SNAPPING_MODES;
  const snapped = canvas.grid.getSnappedPoint(p, {
    mode: modes.VERTEX | modes.CENTER,
    resolution: 1
  });
  return { x: snapped.x, y: snapped.y };
}

/** Grid snap, then fuse to whatever road or junction is already within reach. */
export function snapRoadPoint(p: Vec2): Vec2 {
  const snapped = snapWorldPoint(p);
  const city = currentCity;
  if (city === null) return snapped;
  return metresToWorld(snapToGraph(city.graph, worldToMetres(snapped), snapRadiusM()));
}

export async function drawRoad(
  from: Vec2,
  to: Vec2,
  classId: string
): Promise<RebuildResult | null> {
  const city = requireCity();
  const a = worldToMetres(from);
  const b = worldToMetres(to);
  const graph = insertRoad(city.graph, a, b, classId, { snapM: snapRadiusM() });
  if (graph === city.graph) return null;
  // insertRoad only splits roads *along* the drawn segment, so its box covers every change.
  return commit({ ...city, graph }, ringBounds([a, b]));
}

/** Delete whatever the click landed on: a road first, else the zone underneath. */
export async function eraseAt(p: Vec2): Promise<"road" | "zone" | null> {
  const city = requireCity();
  const at = worldToMetres(p);

  const edge = nearestEdge(city.graph, at, eraseReachM(city.graph));
  if (edge !== null) {
    await commit({ ...city, graph: removeRoad(city.graph, edge.id) }, edgeRect(city.graph, edge));
    return "road";
  }

  const zone = zoneAt(city.zones, at);
  if (zone !== null) {
    await commit({ ...city, zones: city.zones.filter((z) => z.id !== zone.id) }, zone.rect);
    return "zone";
  }
  return null;
}

/** The junction under the cursor, for the edit tool's grab test. Its position is metres. */
export function junctionAt(p: Vec2): RoadNode | null {
  const city = currentCity;
  return city === null ? null : nearestNode(city.graph, worldToMetres(p), snapRadiusM());
}

/** Drag a junction somewhere else. Dropping it on another junction welds the two. */
export async function moveJunction(nodeId: string, to: Vec2): Promise<RebuildResult | null> {
  const city = requireCity();
  const at = worldToMetres(to);
  const graph = moveNode(city.graph, nodeId, at, { snapM: snapRadiusM() });
  if (graph === city.graph) return null;
  return commit({ ...city, graph }, junctionRect(city.graph, nodeId, at));
}

/** Flip the pavement on the road under the cursor. */
export async function toggleWalkwayAt(p: Vec2): Promise<boolean> {
  const city = requireCity();
  const edge = nearestEdge(city.graph, worldToMetres(p), eraseReachM(city.graph));
  if (edge === null) return false;
  await commit(
    { ...city, graph: toggleSidewalks(city.graph, edge.id) },
    edgeRect(city.graph, edge)
  );
  return true;
}

/** `rect` arrives in world pixels from the drag; the zone stores it in metres. */
export async function createZone(rect: Rect, params?: Partial<ZoneParams>): Promise<Zone | null> {
  const city = requireCity();
  const topLeft = worldToMetres({ x: rect.x, y: rect.y });
  const ppm = pixelsPerMetre();
  const area = normalizeRect({
    ...topLeft,
    width: rect.width / ppm,
    height: rect.height / ppm
  });
  const min = gridMetres();
  if (area.width < min || area.height < min) return null;

  const zone: Zone = {
    ...city.base,
    ...params,
    id: nextZoneId(city.zones),
    bank: nextZoneBank(city.zones),
    rect: area,
    seed: params?.seed ?? randomSeed()
  };
  await commit({ ...city, zones: [...city.zones, zone] }, area);
  return zone;
}

export async function reseedZoneAt(p: Vec2): Promise<Zone | null> {
  const city = requireCity();
  const zone = zoneAt(city.zones, worldToMetres(p));
  if (zone === null) return null;
  const reseeded: Zone = { ...zone, seed: randomSeed() };
  await commit(
    { ...city, zones: city.zones.map((z) => (z.id === zone.id ? reseeded : z)) },
    zone.rect
  );
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
/*  Palette and look                            */
/* -------------------------------------------- */

export interface DistrictRef {
  /** "base" for the unzoned remainder, otherwise the zone id. */
  id: string;
  label: string;
  bank: number;
  palette: DistrictPalette;
}

const BASE_DISTRICT = "base";

export function listDistricts(): DistrictRef[] {
  const city = currentCity;
  if (city === null) return [];
  return [
    { id: BASE_DISTRICT, label: "Unzoned City", bank: BASE_BANK, palette: city.base.palette },
    ...city.zones.map((z) => ({
      id: z.id,
      label: `Zone ${z.id}`,
      bank: z.bank,
      palette: z.palette
    }))
  ];
}

function districtBank(city: CityParams, id: string): number | null {
  if (id === BASE_DISTRICT) return BASE_BANK;
  return city.zones.find((z) => z.id === id)?.bank ?? null;
}

/** City banks with any live preview substituted in. */
function paletteBanks(city: CityParams): Material[][] {
  const banks = cityPaletteBanks(city);
  if (palettePreview !== null) {
    const bank = districtBank(city, palettePreview.id);
    if (bank !== null) banks[bank] = normalizePalette(palettePreview.palette).materials;
  }
  return banks;
}

function pushPalette(): void {
  if (currentCity === null || cityRenderer === null) return;
  cityRenderer.updatePalette(packPalette(paletteBanks(currentCity)));
}

/** Retint without persisting. One texture upload; no geometry is touched. */
export function previewDistrictPalette(id: string, palette: DistrictPalette): void {
  palettePreview = { id, palette };
  pushPalette();
}

export function cancelPalettePreview(): void {
  if (palettePreview === null) return;
  palettePreview = null;
  pushPalette();
}

/**
 * WHY no rebuild: vertices carry a material *index*, and a palette edit changes only the
 * colours that index resolves to. Reassigning a district's bank would need one; recolouring
 * it never does. That is what the bank layout buys.
 */
export async function commitDistrictPalette(id: string, palette: DistrictPalette): Promise<void> {
  const city = requireCity();
  const next = normalizePalette(palette);
  const updated: CityParams =
    id === BASE_DISTRICT
      ? { ...city, base: { ...city.base, palette: next } }
      : { ...city, zones: city.zones.map((z) => (z.id === id ? { ...z, palette: next } : z)) };

  palettePreview = null;
  history.push(city);
  currentCity = updated;
  await saveCityState(updated);
  pushPalette();
  cityListener?.();
}

export function setCameraHeightM(metres: number): number {
  cameraHeightM = Math.max(50, metres);
  if (cityRenderer !== null) cityRenderer.cameraHeightMetres = cameraHeightM;
  return cameraHeightM;
}

export function setRenderScale(value: number): number {
  renderScale = Math.min(1, Math.max(0.25, value));
  if (cityRenderer !== null) cityRenderer.renderScale = renderScale;
  return renderScale;
}

export function setBloom(enabled: boolean, strength?: number): void {
  bloomEnabled = enabled;
  if (strength !== undefined) bloomStrength = Math.max(0, strength);
  if (cityRenderer === null) return;
  cityRenderer.bloomEnabled = bloomEnabled;
  cityRenderer.bloomStrength = bloomStrength;
}

/**
 * Foundry's fog overlay sits above our render target, so its default grey mutes an already
 * low-contrast palette into mud. These lean the explored tint violet and darken the
 * unexplored one instead. Canonical paths since v12; the flat `fogExploredColor` alias is
 * deprecated and gone in v14 (`common/documents/scene.mjs:185`).
 */
export async function applyRecommendedFog(): Promise<void> {
  const scene = canvas?.scene;
  if (!scene) throw new Error("No active scene.");
  if (!game.user?.isGM) throw new Error("Only a GM may modify scene documents.");
  await scene.update({
    "fog.colors.explored": "#2a1f42",
    "fog.colors.unexplored": "#07060d",
    backgroundColor: "#07060d"
  });
}

/* -------------------------------------------- */
/*  Build and query                             */
/* -------------------------------------------- */

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Bounding box of an edge's two endpoints, in metres. */
function edgeRect(graph: RoadGraph, edge: RoadEdge): Rect | null {
  const nodes = nodeMap(graph);
  const a = nodes.get(edge.a);
  const b = nodes.get(edge.b);
  return a !== undefined && b !== undefined ? ringBounds([a, b]) : null;
}

/** Everything a junction drag disturbs: both positions and the far end of every road on it. */
function junctionRect(graph: RoadGraph, nodeId: string, toM: Vec2): Rect | null {
  const nodes = nodeMap(graph);
  const from = nodes.get(nodeId);
  if (from === undefined) return null;
  const points: Vec2[] = [from, toM];
  for (const edge of incidentEdges(graph, nodeId)) {
    const other = nodes.get(edge.a === nodeId ? edge.b : edge.a);
    if (other !== undefined) points.push(other);
  }
  return ringBounds(points);
}

function chunkGeometry(city: CityParams, build: ChunkRecord, ppm: number): ChunkGeometry {
  return {
    id: build.id,
    mesh: build.mesh,
    neon: build.neon,
    boundsPx: rectToPixels(build.boundsM, city.origin, ppm)
  };
}

function ensureWorker(): WorkerClient | null {
  if (workerClient !== null || workerUnavailable) return workerClient;
  try {
    workerClient = new WorkerClient();
  } catch (err) {
    workerUnavailable = true;
    noteWorkerFailure(err);
  }
  return workerClient;
}

/** WHY: a broken worker fails once per chunk — ~70 identical lines say nothing the first did not. */
function noteWorkerFailure(err: unknown): void {
  if (workerWarned) return;
  workerWarned = true;
  console.warn(`${MODULE_ID} | generation worker unusable, falling back to the main thread`, err);
}

function chunkRecord(result: BuildChunkResult): ChunkRecord {
  return {
    id: result.chunkId,
    mesh: {
      vertices: result.vertices,
      indices: result.indices,
      vertexCount: result.vertexCount,
      triangleCount: result.triangleCount
    },
    neon: {
      vertices: result.neonVertices,
      indices: result.neonIndices,
      vertexCount: result.neonVertexCount,
      triangleCount: result.neonTriangleCount
    },
    boundsM: result.boundsM,
    buildingCount: result.buildingCount
  };
}

/** Never rejects on the worker's account: a failed request is retried here, synchronously. */
async function buildOne(
  client: WorkerClient | null,
  city: CityParams,
  key: ChunkKey,
  bounds: Rect,
  ppm: number
): Promise<{ record: ChunkRecord; fellBack: boolean }> {
  if (client !== null) {
    try {
      const result = await client.buildChunk({
        params: city,
        key,
        cityBoundsM: bounds,
        pixelsPerMetre: ppm
      });
      return { record: chunkRecord(result), fellBack: false };
    } catch (err) {
      noteWorkerFailure(err);
    }
  }
  return { record: buildChunk(city, key, bounds, ppm), fellBack: client !== null };
}

function buildSource(client: WorkerClient | null, fallbacks: number): string {
  if (client === null) return "main thread";
  return fallbacks === 0 ? "worker" : `worker (${fallbacks} on main thread)`;
}

/** Issue every chunk at once and push each to the renderer as it lands. */
async function runBuilds(
  city: CityParams,
  keys: ChunkKey[],
  bounds: Rect,
  ppm: number,
  epoch: number,
  full: boolean,
  started: number
): Promise<RebuildResult> {
  const client = ensureWorker();
  let rebuilt = 0;
  let fallbacks = 0;

  await Promise.all(
    keys.map(async (key) => {
      const outcome = await buildOne(client, city, key, bounds, ppm);
      if (outcome.fellBack) fallbacks++;
      // WHY: the params moved on while this was in flight. Dropping it is what keeps a slow
      // chunk of an old graph from landing on top of a newer one.
      if (epoch !== buildEpoch) return;
      chunks.set(outcome.record.id, outcome.record);
      cityRenderer?.setChunk(chunkGeometry(city, outcome.record, ppm));
      rebuilt++;
    })
  );

  const stale = epoch !== buildEpoch;
  if (full && !stale) chunkSetComplete = true;
  return report(full, rebuilt, started, buildSource(client, fallbacks), stale);
}

function totalBuildings(): number {
  let count = 0;
  for (const build of chunks.values()) count += build.buildingCount;
  return count;
}

function report(
  full: boolean,
  rebuilt: number,
  started: number,
  source: string,
  stale: boolean
): RebuildResult {
  const ms = performance.now() - started;
  const buildings = totalBuildings();
  console.log(
    `${MODULE_ID} | ${full ? "FULL" : "INCREMENTAL"} rebuild — regenerated ${rebuilt} of ` +
      `${chunks.size} chunks in ${ms.toFixed(1)}ms (${buildings} buildings) via ${source}` +
      (stale ? " — superseded" : "")
  );
  return { full, chunks: rebuilt, buildings, ms };
}

async function rebuildAll(): Promise<RebuildResult> {
  const city = requireCity();
  const bounds = currentBounds;
  const started = performance.now();
  const epoch = buildEpoch;
  const ppm = pixelsPerMetre();
  const keys = bounds === null ? [] : cityChunks(bounds);

  chunkSetComplete = false;
  // Overwriting the surviving chunks is not enough — one the city no longer covers would
  // otherwise stay on screen for ever.
  const live = new Set(keys.map(chunkId));
  for (const id of [...chunks.keys()]) {
    if (live.has(id)) continue;
    chunks.delete(id);
    cityRenderer?.removeChunk(id);
  }

  if (bounds === null) return report(true, 0, started, "main thread", false);
  return runBuilds(city, keys, bounds, ppm, epoch, true, started);
}

/** Regenerate only the chunks a disturbed metre-space rect can reach. */
async function rebuildDirty(dirtyM: Rect): Promise<RebuildResult> {
  const city = requireCity();
  const bounds = currentBounds;
  if (bounds === null) return rebuildAll();

  const started = performance.now();
  const epoch = buildEpoch;
  const ppm = pixelsPerMetre();
  const margin = chunkMarginM(city);
  const grown: Rect = {
    x: dirtyM.x - margin,
    y: dirtyM.y - margin,
    width: dirtyM.width + margin * 2,
    height: dirtyM.height + margin * 2
  };

  // The bounds are unchanged on this path, so the live set is already the whole city
  // grid — a key outside it is off the city, not a chunk waiting to be made.
  const keys = chunksCovering(grown).filter((key) => chunks.has(chunkId(key)));
  return runBuilds(city, keys, bounds, ppm, epoch, false, started);
}

/** Rebuild every chunk from the in-memory params and push them to the renderer. */
export function rebuildGeometry(): Promise<RebuildResult> {
  return rebuildAll();
}

/**
 * WHY: chunk surfaces are clipped to their chunk rect, so a block ring is cut at every
 * seam. Walls emitted from those would blind vision along invisible chunk boundaries.
 */
function cityBlocks(city: CityParams, boundsM: Rect, ppm: number): MultiPolygon {
  const px = cityToPixels(city, ppm);
  return buildRoadSurfaces(px.graph, rectToPixels(boundsM, city.origin, ppm), ppm).blocks;
}

export async function buildWalls(): Promise<{ created: number; deleted: number }> {
  const city = requireCity();
  const ppm = pixelsPerMetre();
  const blocks = currentBounds === null ? [] : cityBlocks(city, currentBounds, ppm);
  const segments = wallSegmentsFromBlocks(blocks, { tolerancePx: WALL_TOLERANCE_M * ppm });
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
export async function removeEdge(edgeId: string): Promise<RebuildResult> {
  const city = requireCity();
  const edge = city.graph.edges.find((e) => e.id === edgeId);
  if (edge === undefined) {
    throw new Error(`No edge "${edgeId}". Known: ${city.graph.edges.map((e) => e.id).join(", ")}`);
  }
  return commit({ ...city, graph: removeRoad(city.graph, edgeId) }, edgeRect(city.graph, edge));
}

export async function resetCity(): Promise<RebuildResult> {
  return commit(demoCity(sceneCentre()));
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
    chunksBuilt: chunks.size,
    buildings: totalBuildings(),
    nodes: currentCity?.graph.nodes.length ?? 0,
    edges: currentCity?.graph.edges.length ?? 0,
    zones: currentCity?.zones.length ?? 0,
    undoDepth: history.depth,
    worker: workerClient !== null,
    autoWalls,
    districts: currentCity === null ? 0 : currentCity.zones.length + 1,
    palettePreview: palettePreview?.id ?? null,
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
