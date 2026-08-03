import {
  CAMERA_ZOOM_MODE,
  CITY_SCHEMA_VERSION,
  FLAG_CITY,
  FLAG_ENABLED,
  GENERATOR_VERSION,
  MODULE_ID,
  WEATHER,
  type CameraZoomMode,
  type Weather
} from "../constants.js";
import type { CameraState } from "../core/camera.js";
import { chunksCovering, chunkId, type ChunkKey } from "../core/gen/chunks.js";
import { buildTerrainChunk } from "../core/gen/terrain-chunk.js";
import {
  coastalLand,
  normalizeCitySeed,
  normalizeRing,
  rectangleLand,
  validateTerrain,
  type CityStateV2,
  type CoastEdge,
  type TerrainMode
} from "../core/gen/terrain.js";
import { emptyMesh, type MeshBuffers } from "../core/geom/mesh.js";
import type { Rect, Ring, Vec2 } from "../core/geom/types.js";
import {
  BANK_COUNT,
  CITY_BANK,
  CITY_SURFACES,
  DEFAULT_DISTRICT_PALETTE,
  packPalette,
  type Material
} from "../core/palette.js";
import { WEATHER_PRESETS, type LookDials } from "../render/look-dials.js";
import {
  CityRenderer,
  type ChunkGeometry,
  type LeanCalibrationPoint
} from "../render/city-renderer.js";
import { FrameQualityController } from "../render/frame-quality.js";
import { WorkerClient } from "../worker/client.js";
import type { BuildTerrainChunkResult } from "../worker/protocol.js";
import {
  deleteGeneratedWalls,
  isSceneEnabled,
  loadCityState,
  saveCityState,
  setSceneEnabledFlag,
  type CityLoadResult,
  type SaveExpectation
} from "./documents.js";
import {
  TerrainActionQueue,
  TerrainSession,
  terrainBuildIsCurrent
} from "./terrain-session.js";

const DEFAULT_CAMERA_HEIGHT_M = 500;
const WEATHER_SORT_LAYER = 990;
const SUPPORTED_DIAGONAL_M = 1500;

export interface RebuildResult {
  full: true;
  chunks: number;
  triangles: number;
  bytes: number;
  ms: number;
  stale: boolean;
  degraded?: boolean;
}

interface TerrainChunkRecord {
  id: string;
  mesh: MeshBuffers;
  boundsM: Rect;
  landTriangleCount: number;
  waterTriangleCount: number;
  bytes: number;
}

const session = new TerrainSession();
const terrainActions = new TerrainActionQueue();
const frameQuality = new FrameQualityController();
const chunks = new Map<string, TerrainChunkRecord>();
let cityRenderer: CityRenderer | null = null;
let tickerCallback: (() => void) | null = null;
let workerClient: WorkerClient | null = null;
let workerUnavailable = false;
let workerWarned = false;
const cityListeners = new Set<() => void>();
let layerCityListener: (() => void) | null = null;
let draftCancelListener: (() => void) | null = null;
let localWriteRevision: number | null = null;
let localEnabledWrite: boolean | null = null;
let lastBuild: RebuildResult | null = null;

let cameraHeightM = DEFAULT_CAMERA_HEIGHT_M;
let cameraZoomMode: CameraZoomMode = CAMERA_ZOOM_MODE.DOLLY;
let leanOverride: number | null = null;
const leanCalibrationPoints: LeanCalibrationPoint[] = [];
let renderScale = 1;
let antialias = true;
let antialiasFactor = 1.5;
let bloomEnabled = true;
let bloomStrength = 1;
let rainStrength = 1;
let weather: Weather = WEATHER.RAIN;

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

function gridMetres(): number {
  const distance = Number(canvas?.dimensions?.distance);
  return Number.isFinite(distance) && distance > 0 ? distance : 1;
}

export function configuredPixelsPerMetre(size: number, distance: number): number {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 1;
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 1;
  return safeSize / safeDistance;
}

export function pixelsPerMetre(): number {
  const size = Number(canvas?.dimensions?.size);
  return configuredPixelsPerMetre(size, gridMetres());
}

function sceneCentre(): Vec2 {
  const scene = canvas.dimensions.sceneRect;
  return { x: scene.x + scene.width / 2, y: scene.y + scene.height / 2 };
}

function cityOrigin(): Vec2 {
  return session.current?.source.origin ?? sceneCentre();
}

export function worldToMetres(point: Vec2): Vec2 {
  const origin = cityOrigin();
  const ppm = pixelsPerMetre();
  return { x: (point.x - origin.x) / ppm, y: (point.y - origin.y) / ppm };
}

export function metresToWorld(point: Vec2): Vec2 {
  const origin = cityOrigin();
  const ppm = pixelsPerMetre();
  return { x: origin.x + point.x * ppm, y: origin.y + point.y * ppm };
}

export function sceneBoundsFromPixels(scene: Rect, origin: Vec2, ppm: number): Rect {
  if (!Number.isFinite(ppm) || ppm <= 0) throw new Error("Pixels per metre must be positive.");
  return {
    x: (scene.x - origin.x) / ppm,
    y: (scene.y - origin.y) / ppm,
    width: scene.width / ppm,
    height: scene.height / ppm
  };
}

function sceneBoundsM(origin = cityOrigin()): Rect {
  const scene = canvas.dimensions.sceneRect;
  return sceneBoundsFromPixels(scene, origin, pixelsPerMetre());
}

function rectToWorld(rect: Rect, origin: Vec2, ppm: number): Rect {
  return {
    x: origin.x + rect.x * ppm,
    y: origin.y + rect.y * ppm,
    width: rect.width * ppm,
    height: rect.height * ppm
  };
}

function terrainPalette(): Uint8Array {
  const banks: Material[][] = Array.from({ length: BANK_COUNT }, () =>
    DEFAULT_DISTRICT_PALETTE.materials
  );
  banks[CITY_BANK] = CITY_SURFACES;
  return packPalette(banks);
}

function notifyCityChanged(): void {
  for (const listener of cityListeners) listener();
}

export function setCityListener(listener: (() => void) | null): void {
  if (layerCityListener !== null) cityListeners.delete(layerCityListener);
  layerCityListener = listener;
  if (listener !== null) cityListeners.add(listener);
}

export function addCityListener(listener: () => void): () => void {
  cityListeners.add(listener);
  return () => cityListeners.delete(listener);
}

export function setTerrainDraftCancelListener(listener: (() => void) | null): void {
  draftCancelListener = listener;
}

export function cancelTerrainDraft(): void {
  draftCancelListener?.();
}

export function cityLoadStatus(): CityLoadResult {
  return session.status;
}

export function getCity(): CityStateV2 | null {
  return session.current;
}

export const canUndo = (): boolean => session.canUndo;
export const canRedo = (): boolean => session.canRedo;
export const isMounted = (): boolean => cityRenderer !== null;

function mountRenderer(): void {
  if (cityRenderer !== null || session.current === null) return;
  if (!canvas?.ready || !canvas.app?.renderer || !canvas.primary) return;

  cityRenderer = new CityRenderer(canvas.app.renderer, emptyMesh(), terrainPalette(), {
    pixelsPerMetre: pixelsPerMetre(),
    cameraHeightMetres: cameraHeightM,
    cameraZoomMode
  });
  cityRenderer.clearChunks();
  cityRenderer.renderScale = renderScale;
  cityRenderer.supersample = antialias ? antialiasFactor : 1;
  cityRenderer.leanOverride = leanOverride;
  cityRenderer.bloomEnabled = bloomEnabled;
  cityRenderer.bloomStrength = bloomStrength;
  applyWeather();
  frameQuality.reset();

  cityRenderer.display.elevation = canvas.primary.constructor.BACKGROUND_ELEVATION ?? 0;
  cityRenderer.display.sortLayer = 0;
  cityRenderer.display.sort = 0;
  canvas.primary.addChild(cityRenderer.display);

  cityRenderer.overlay.elevation = 0;
  cityRenderer.overlay.sortLayer = 900;
  cityRenderer.overlay.sort = 0;
  canvas.primary.addChild(cityRenderer.overlay);

  cityRenderer.weather.elevation = 0;
  cityRenderer.weather.sortLayer = WEATHER_SORT_LAYER;
  cityRenderer.weather.sort = 0;
  canvas.primary.addChild(cityRenderer.weather);
  canvas.primary.sortDirty = true;

  tickerCallback = () => {
    const renderer = cityRenderer;
    if (renderer === null) return;
    const camera = readCamera();
    const now = performance.now();
    renderer.update(camera, frameQuality.sample(camera, now));
    renderer.animate(now);
  };
  canvas.app.ticker.add(tickerCallback, null, PIXI.UPDATE_PRIORITY.HIGH);
}

function unmountRenderer(): void {
  if (tickerCallback !== null) {
    canvas.app?.ticker?.remove(tickerCallback);
    tickerCallback = null;
  }
  workerClient?.terminate();
  workerClient = null;
  workerUnavailable = false;
  if (cityRenderer !== null) {
    cityRenderer.display.parent?.removeChild(cityRenderer.display);
    cityRenderer.overlay.parent?.removeChild(cityRenderer.overlay);
    cityRenderer.weather.parent?.removeChild(cityRenderer.weather);
    cityRenderer.destroy();
  }
  cityRenderer = null;
  chunks.clear();
  frameQuality.reset();
}

export function mount(): void {
  if (!canvas?.ready) return;
  unmountRenderer();
  session.reset(loadCityState());
  if (session.current !== null) {
    mountRenderer();
    void rebuildGeometry().catch((error) =>
      console.error(`${MODULE_ID} | terrain rebuild failed`, error)
    );
  }
  notifyCityChanged();
}

export function unmount(): void {
  unmountRenderer();
  session.reset({ kind: "absent" });
  localWriteRevision = null;
  draftCancelListener?.();
  notifyCityChanged();
}

export async function setSceneEnabled(enabled: boolean): Promise<void> {
  localEnabledWrite = enabled;
  try {
    await setSceneEnabledFlag(enabled);
  } finally {
    localEnabledWrite = null;
  }
  if (!enabled) {
    unmount();
    return;
  }
  mount();
}

function newState(seed: string, mode: TerrainMode, edge: CoastEdge | null): CityStateV2 {
  const origin = sceneCentre();
  const bounds = sceneBoundsM(origin);
  const citySeed = normalizeCitySeed(seed);
  const land = mode === "coastal" ? coastalLand(bounds, citySeed, edge!) : rectangleLand(bounds);
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision: 1,
    source: {
      origin,
      citySeed,
      generation: { terrainMode: mode, coastEdge: edge },
      terrain: { land, urbanFootprint: null }
    }
  };
}

function generatedCandidate(seed: string, mode: TerrainMode, edge: CoastEdge | null): CityStateV2 {
  const current = session.current;
  if (current === null) return newState(seed, mode, edge);
  const bounds = sceneBoundsM(current.source.origin);
  const citySeed = normalizeCitySeed(seed);
  const land = mode === "coastal" ? coastalLand(bounds, citySeed, edge!) : rectangleLand(bounds);
  return {
    ...current,
    revision: current.revision + 1,
    source: {
      ...current.source,
      citySeed,
      generation: { terrainMode: mode, coastEdge: edge },
      terrain: { ...current.source.terrain, land }
    }
  };
}

function validateCandidate(candidate: CityStateV2): void {
  const result = validateTerrain(candidate.source.terrain);
  if (!result.ok) throw new Error(result.reason);
  const bounds = sceneBoundsM(candidate.source.origin);
  const ppm = pixelsPerMetre();
  for (const key of chunksCovering(bounds)) {
    const build = buildTerrainChunk(candidate.source, key, bounds, ppm);
    if (
      build.mesh.vertices.some((value) => !Number.isFinite(value)) ||
      build.mesh.indices.length !== build.mesh.triangleCount * 3
    ) {
      throw new Error(`Terrain preflight failed in chunk ${build.id}.`);
    }
  }
}

function warnLargeScene(candidate: CityStateV2): void {
  const bounds = sceneBoundsM(candidate.source.origin);
  if (Math.hypot(bounds.width, bounds.height) <= SUPPORTED_DIAGONAL_M) return;
  ui.notifications?.warn(
    `Nixie: this Scene exceeds the supported ${SUPPORTED_DIAGONAL_M} m diagonal; later automatic coverage and performance are not guaranteed.`
  );
}

async function guardedSave(
  candidate: CityStateV2,
  expectation: SaveExpectation
): Promise<CityStateV2> {
  validateCandidate(candidate);
  localWriteRevision = candidate.revision;
  try {
    return await saveCityState(candidate, expectation);
  } finally {
    localWriteRevision = null;
  }
}

async function rebuildAfterCommit(): Promise<RebuildResult> {
  mountRenderer();
  try {
    return await rebuildGeometry();
  } catch (error) {
    console.error(`${MODULE_ID} | committed terrain could not render`, error);
    ui.notifications?.error(
      `Nixie: terrain was saved, but presentation failed — ${error instanceof Error ? error.message : String(error)}`
    );
    return {
      full: true,
      chunks: 0,
      triangles: 0,
      bytes: 0,
      ms: 0,
      stale: false,
      degraded: true
    };
  }
}

async function createGeneratedTerrain(
  seed: string,
  mode: "rectangle" | "coastal",
  edge: CoastEdge | null,
  replaceLegacy: boolean
): Promise<RebuildResult> {
  if (!isSceneEnabled()) throw new Error("Enable Nixie on this Scene before creating terrain.");
  const status = session.status;
  if (status.kind === "unsupported" || status.kind === "malformed") {
    throw new Error("This City Generator 2.0 state is not editable by this module version.");
  }
  if (status.kind === "legacy" && !replaceLegacy) {
    throw new Error("Replacing legacy City Generator 1.0 data requires confirmation.");
  }

  const candidate = generatedCandidate(seed, mode, edge);
  warnLargeScene(candidate);
  if (status.kind === "supported") {
    const saved = await guardedSave(candidate, status.state.revision);
    session.publishCommit(saved);
  } else {
    const expected: SaveExpectation = status.kind === "legacy" ? "legacy" : "absent";
    const saved = await guardedSave(candidate, expected);
    session.publishCreation(saved);
    if (status.kind === "legacy") {
      try {
        await deleteGeneratedWalls();
      } catch (error) {
        console.error(`${MODULE_ID} | legacy wall cleanup failed`, error);
        ui.notifications?.warn("Nixie: the 2.0 terrain was saved, but legacy Nixie wall cleanup failed.");
      }
    }
  }
  cancelTerrainDraft();
  notifyCityChanged();
  return rebuildAfterCommit();
}

export function createRectangleTerrain(seed: string): Promise<RebuildResult> {
  return terrainActions.run(() => createGeneratedTerrain(seed, "rectangle", null, false));
}

export function createCoastalTerrain(
  seed: string,
  edge: CoastEdge
): Promise<RebuildResult> {
  return terrainActions.run(() => createGeneratedTerrain(seed, "coastal", edge, false));
}

export function replaceLegacyWithRectangleTerrain(seed: string): Promise<RebuildResult> {
  return terrainActions.run(() => createGeneratedTerrain(seed, "rectangle", null, true));
}

export function replaceLegacyWithCoastalTerrain(
  seed: string,
  edge: CoastEdge
): Promise<RebuildResult> {
  return terrainActions.run(() => createGeneratedTerrain(seed, "coastal", edge, true));
}

async function commitSource(source: CityStateV2["source"]): Promise<RebuildResult> {
  const current = session.current;
  if (current === null) throw new Error("Create a City Generator 2.0 terrain first.");
  const candidate: CityStateV2 = { ...current, revision: current.revision + 1, source };
  const saved = await guardedSave(candidate, current.revision);
  session.publishCommit(saved);
  cancelTerrainDraft();
  notifyCityChanged();
  return rebuildAfterCommit();
}

export function replaceLand(ring: Ring): Promise<RebuildResult> {
  return terrainActions.run(() => {
    const current = session.current;
    if (current === null) throw new Error("Create a 2.0 terrain first.");
    return commitSource({
      ...current.source,
      generation: { terrainMode: "custom", coastEdge: null },
      terrain: { ...current.source.terrain, land: normalizeRing(ring) }
    });
  });
}

export function replaceUrbanFootprint(ring: Ring): Promise<RebuildResult> {
  return terrainActions.run(() => {
    const current = session.current;
    if (current === null) throw new Error("Create a 2.0 terrain first.");
    return commitSource({
      ...current.source,
      terrain: { ...current.source.terrain, urbanFootprint: normalizeRing(ring) }
    });
  });
}

export function moveTerrainVertex(
  target: "land" | "urbanFootprint",
  index: number,
  to: Vec2
): Promise<RebuildResult> {
  return terrainActions.run(() => {
    const current = session.current;
    if (current === null) throw new Error("Create a 2.0 terrain first.");
    const ring = current.source.terrain[target];
    if (ring === null) throw new Error("The urban footprint does not exist.");
    if (!Number.isInteger(index) || index < 0 || index >= ring.length) {
      throw new Error("Terrain vertex no longer exists; retry the edit.");
    }
    const moved = ring.map((point, candidate) =>
      candidate === index ? { x: to.x, y: to.y } : point
    );
    const source = {
      ...current.source,
      generation:
        target === "land"
          ? ({ terrainMode: "custom", coastEdge: null } as const)
          : current.source.generation,
      terrain: { ...current.source.terrain, [target]: normalizeRing(moved) }
    };
    return commitSource(source);
  });
}

export function deleteUrbanFootprint(): Promise<RebuildResult> {
  return terrainActions.run(() => {
    const current = session.current;
    if (current === null) throw new Error("Create a 2.0 terrain first.");
    if (current.source.terrain.urbanFootprint === null) {
      throw new Error("There is no urban footprint to delete.");
    }
    return commitSource({
      ...current.source,
      terrain: { ...current.source.terrain, urbanFootprint: null }
    });
  });
}

async function applyHistory(direction: "undo" | "redo"): Promise<boolean> {
  const current = session.current;
  const target = direction === "undo" ? session.undoTarget : session.redoTarget;
  if (current === null || target === null) return false;
  const saved = await guardedSave(target, current.revision);
  if (direction === "undo") session.publishUndo(saved);
  else session.publishRedo(saved);
  cancelTerrainDraft();
  notifyCityChanged();
  await rebuildAfterCommit();
  return true;
}

export function undo(): Promise<boolean> {
  return terrainActions.run(() => applyHistory("undo"));
}

export function redo(): Promise<boolean> {
  return terrainActions.run(() => applyHistory("redo"));
}

function ensureWorker(): WorkerClient | null {
  if (workerClient !== null || workerUnavailable) return workerClient;
  try {
    workerClient = new WorkerClient();
  } catch (error) {
    workerUnavailable = true;
    noteWorkerFailure(error);
  }
  return workerClient;
}

function noteWorkerFailure(error: unknown): void {
  if (workerWarned) return;
  workerWarned = true;
  console.warn(`${MODULE_ID} | terrain worker unusable, falling back to the main thread`, error);
}

function recordFromResult(result: BuildTerrainChunkResult): TerrainChunkRecord {
  return {
    id: result.chunkId,
    mesh: {
      vertices: result.vertices,
      indices: result.indices,
      vertexCount: result.vertexCount,
      triangleCount: result.triangleCount
    },
    boundsM: result.boundsM,
    landTriangleCount: result.landTriangleCount,
    waterTriangleCount: result.waterTriangleCount,
    bytes: result.vertices.byteLength + result.indices.byteLength
  };
}

async function buildOne(
  client: WorkerClient | null,
  city: CityStateV2,
  key: ChunkKey,
  bounds: Rect,
  ppm: number
): Promise<TerrainChunkRecord> {
  if (client !== null) {
    try {
      const result = await client.buildTerrainChunk({
          source: city.source,
          sourceRevision: city.revision,
          key,
          sceneBoundsM: bounds,
          pixelsPerMetre: ppm
        });
      if (result.sourceRevision !== city.revision) {
        throw new Error(`Worker returned stale revision ${result.sourceRevision}.`);
      }
      return recordFromResult(result);
    } catch (error) {
      noteWorkerFailure(error);
      if (client === workerClient) {
        workerClient.terminate();
        workerClient = null;
        workerUnavailable = true;
      }
    }
  }
  const build = buildTerrainChunk(city.source, key, bounds, ppm);
  return {
    id: build.id,
    mesh: build.mesh,
    boundsM: build.boundsM,
    landTriangleCount: build.landTriangleCount,
    waterTriangleCount: build.waterTriangleCount,
    bytes: build.mesh.vertices.byteLength + build.mesh.indices.byteLength
  };
}

function chunkGeometry(
  city: CityStateV2,
  record: TerrainChunkRecord,
  ppm: number
): ChunkGeometry {
  return {
    id: record.id,
    mesh: record.mesh,
    boundsPx: rectToWorld(record.boundsM, city.source.origin, ppm)
  };
}

export async function rebuildGeometry(): Promise<RebuildResult> {
  const city = session.current;
  if (city === null) throw new Error("No supported City Generator 2.0 state is loaded.");
  mountRenderer();
  const renderer = cityRenderer;
  if (renderer === null) throw new Error("The city renderer is unavailable.");

  const started = performance.now();
  const epoch = session.buildEpoch;
  const revision = city.revision;
  const ppm = pixelsPerMetre();
  const bounds = sceneBoundsM(city.source.origin);
  const keys = chunksCovering(bounds);
  renderer.pixelsPerMetre = ppm;
  const live = new Set(keys.map(chunkId));
  for (const id of [...chunks.keys()]) {
    if (live.has(id)) continue;
    chunks.delete(id);
    renderer.removeChunk(id);
  }

  const client = ensureWorker();
  let installed = 0;
  await Promise.all(
    keys.map(async (key) => {
      const record = await buildOne(client, city, key, bounds, ppm);
      const current = session.current;
      if (!terrainBuildIsCurrent(revision, epoch, current?.revision ?? null, session.buildEpoch)) {
        return;
      }
      chunks.set(record.id, record);
      renderer.setChunk(chunkGeometry(city, record, ppm));
      frameQuality.reset();
      installed++;
    })
  );

  const stale = !terrainBuildIsCurrent(
    revision,
    epoch,
    session.current?.revision ?? null,
    session.buildEpoch
  );
  const result: RebuildResult = {
    full: true,
    chunks: installed,
    triangles: [...chunks.values()].reduce((sum, chunk) => sum + chunk.mesh.triangleCount, 0),
    bytes: [...chunks.values()].reduce((sum, chunk) => sum + chunk.bytes, 0),
    ms: performance.now() - started,
    stale
  };
  lastBuild = result;
  console.log(
    `${MODULE_ID} | terrain rebuild — ${installed}/${keys.length} chunks, ${result.triangles} triangles, ${result.bytes} bytes in ${result.ms.toFixed(1)}ms${stale ? " — superseded" : ""}`
  );
  return result;
}

export function setCameraHeightM(metres: number): number {
  cameraHeightM = Math.max(50, metres);
  if (cityRenderer !== null) cityRenderer.cameraHeightMetres = cameraHeightM;
  return cameraHeightM;
}

export function setCameraZoomMode(mode: CameraZoomMode): CameraZoomMode {
  cameraZoomMode = mode;
  if (cityRenderer !== null) cityRenderer.cameraZoomMode = cameraZoomMode;
  return cameraZoomMode;
}

export function setLeanAtCurrentZoom(value: number | null): LeanCalibrationPoint {
  if (cityRenderer === null) throw new Error("No city renderer is mounted.");
  leanOverride = value;
  cityRenderer.leanOverride = value;
  return cityRenderer.leanCalibrationPoint();
}

export function adjustLeanAtCurrentZoom(delta: number): LeanCalibrationPoint {
  if (!Number.isFinite(delta)) throw new Error("Lean adjustment must be finite.");
  if (cityRenderer === null) throw new Error("No city renderer is mounted.");
  return setLeanAtCurrentZoom(cityRenderer.leanCalibrationPoint().leanStrength + delta);
}

export function saveLeanCalibrationPoint(): LeanCalibrationPoint {
  if (cityRenderer === null) throw new Error("No city renderer is mounted.");
  const point = cityRenderer.leanCalibrationPoint();
  leanCalibrationPoints.push(point);
  return point;
}

export function getLeanCalibrationReport(): {
  current: LeanCalibrationPoint | null;
  points: LeanCalibrationPoint[];
} {
  return {
    current: cityRenderer?.leanCalibrationPoint() ?? null,
    points: leanCalibrationPoints.map((point) => ({ ...point }))
  };
}

export function clearLeanCalibration(): void {
  leanCalibrationPoints.length = 0;
  leanOverride = null;
  if (cityRenderer !== null) cityRenderer.leanOverride = null;
}

export function setRenderScale(value: number): number {
  renderScale = Math.min(1, Math.max(0.25, value));
  if (cityRenderer !== null) cityRenderer.renderScale = renderScale;
  return renderScale;
}

export function setAntialias(enabled: boolean, factor?: number): void {
  antialias = enabled;
  if (factor !== undefined) antialiasFactor = Math.min(2, Math.max(1.25, factor));
  if (cityRenderer !== null) cityRenderer.supersample = antialias ? antialiasFactor : 1;
}

export function setBloom(enabled: boolean, strength?: number): void {
  bloomEnabled = enabled;
  if (strength !== undefined) bloomStrength = Math.max(0, strength);
  if (cityRenderer === null) return;
  cityRenderer.bloomEnabled = bloomEnabled;
  cityRenderer.bloomStrength = bloomStrength;
}

export function setRain(strength: number): void {
  rainStrength = strength;
  pushRainStrength();
}

export function setWeather(next: Weather): void {
  weather = WEATHER_PRESETS[next] === undefined ? WEATHER.RAIN : next;
  applyWeather();
}

export function currentWeather(): Weather {
  return weather;
}

function applyWeather(): void {
  if (cityRenderer === null) return;
  Object.assign(cityRenderer.lookDials, WEATHER_PRESETS[weather].dials);
  cityRenderer.markContentDirty();
  pushRainStrength();
}

function pushRainStrength(): void {
  if (cityRenderer !== null) {
    cityRenderer.rainStrength = rainStrength * WEATHER_PRESETS[weather].strength;
  }
}

export function setLookDials(partial: Partial<LookDials>): LookDials {
  if (cityRenderer === null) throw new Error("No city renderer is mounted.");
  const dials = cityRenderer.lookDials as unknown as Record<string, number>;
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in dials)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Look dial "${key}" must be a finite number.`);
    }
  }
  for (const [key, value] of Object.entries(partial)) {
    if (key in dials && typeof value === "number") dials[key] = value;
  }
  cityRenderer.markContentDirty();
  return { ...cityRenderer.lookDials };
}

export function lookDials(): LookDials | null {
  return cityRenderer === null ? null : { ...cityRenderer.lookDials };
}

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

export function getRenderer(): CityRenderer | null {
  return cityRenderer;
}

export function stats(): Record<string, unknown> | null {
  const city = session.current;
  if (city === null) return null;
  return {
    ...cityRenderer?.stats(),
    revision: city.revision,
    generatorVersion: city.generatorVersion,
    terrainMode: city.source.generation.terrainMode,
    coastEdge: city.source.generation.coastEdge,
    citySeed: city.source.citySeed,
    landVertices: city.source.terrain.land.length,
    urbanFootprintVertices: city.source.terrain.urbanFootprint?.length ?? 0,
    buildEpoch: session.buildEpoch,
    undoDepth: session.historyDepth,
    canRedo: session.canRedo,
    worker: workerClient !== null,
    lastBuild
  };
}

function flagChanged(changes: any): boolean {
  const hasProperty =
    typeof foundry === "undefined" ? undefined : foundry.utils?.hasProperty;
  return (
    hasProperty?.(changes, `flags.${MODULE_ID}.${FLAG_CITY}`) === true ||
    changes?.flags?.[MODULE_ID]?.[FLAG_CITY] !== undefined
  );
}

export function enabledFlagChanged(changes: any): boolean {
  const hasProperty =
    typeof foundry === "undefined" ? undefined : foundry.utils?.hasProperty;
  return (
    hasProperty?.(changes, `flags.${MODULE_ID}.${FLAG_ENABLED}`) === true ||
    changes?.flags?.[MODULE_ID]?.[FLAG_ENABLED] !== undefined
  );
}

function scaleOrBoundsChanged(changes: any): boolean {
  return (
    "width" in changes ||
    "height" in changes ||
    "padding" in changes ||
    "grid" in changes ||
    Object.keys(changes).some((key) => key.startsWith("grid."))
  );
}

function handleExternalFlagChange(): void {
  const result = loadCityState();
  if (result.kind === "supported" && result.state.revision === localWriteRevision) return;
  if (result.kind !== "supported") {
    session.reset(result);
    unmountRenderer();
    cancelTerrainDraft();
    notifyCityChanged();
    ui.notifications?.warn("Nixie: the Scene city flag is no longer a supported 2.0 state; editing was disabled.");
    return;
  }
  if (!session.adoptExternal(result)) return;
  cancelTerrainDraft();
  notifyCityChanged();
  ui.notifications?.warn("Nixie: a newer Scene revision was loaded; local history and drafts were cleared.");
  unmountRenderer();
  mountRenderer();
  void rebuildGeometry().catch((error) =>
    console.error(`${MODULE_ID} | external terrain rebuild failed`, error)
  );
}

export function registerHooks(): void {
  Hooks.on("canvasReady", () => {
    unmount();
    if (isSceneEnabled()) mount();
  });
  Hooks.on("canvasTearDown", () => unmount());
  Hooks.on("updateScene", (scene: any, changes: any) => {
    if (scene !== canvas?.scene) return;
    if (enabledFlagChanged(changes)) {
      const enabled = isSceneEnabled();
      if (enabled === localEnabledWrite) return;
      if (enabled) mount();
      else unmount();
      return;
    }
    if (!isSceneEnabled()) return;
    if (flagChanged(changes)) handleExternalFlagChange();
    if (session.current !== null && scaleOrBoundsChanged(changes)) {
      session.invalidateRenderInputs();
      cancelTerrainDraft();
      notifyCityChanged();
      void rebuildGeometry().catch((error) =>
        console.error(`${MODULE_ID} | Scene scale terrain rebuild failed`, error)
      );
    }
  });
}

export { isSceneEnabled };
