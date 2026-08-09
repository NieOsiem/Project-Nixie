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
import {
  buildCityChunksSync,
  type CityChunkBuild
} from "../core/gen/city-chunk.js";
import {
  coastalLand,
  normalizeCitySeed,
  normalizeRing,
  rectangleLand,
  validateTerrain,
  type CoastEdge,
  type TerrainMode
} from "../core/gen/terrain.js";
import {
  ROUTE_CLASS_REGISTRY,
  validateCitySourceV3,
  type CitySourceV3,
  type CityStateV3,
  type DistrictOpenSpaceProfile,
  type DistrictSource,
  type RoadCurvePreset,
  type RoadOrigin,
  type RouteClassId
} from "../core/gen/city.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "../core/gen/district-registry.js";
import { buildDistrictPlan, type DistrictPlan } from "../core/gen/district-plan.js";
import { districtGenerationAvailability, generateInitialDistricts } from "../core/gen/district-generator.js";
import {
  districtDeleteCandidate,
  districtDrawCandidate,
  districtFillCandidate,
  districtMergeCandidate,
  districtMoveVertexCandidate,
  reconcileDistrictsForRoadEdit,
  districtSplitCandidate,
  districtUpdateCandidate,
  type DistrictUpdatePatch
} from "../core/gen/district-edit.js";
import {
  generateInitialRoadNetwork,
  type GeneratedRoadNetwork,
  type RoadGenerationInput,
  type RoadGenerationDiagnostics
} from "../core/gen/road-generator.js";
import {
  appendRoute,
  deleteEdges,
  deleteJunction,
  moveNode,
  validateRouteTopology,
  weldNodes
} from "../core/graph/topology.js";
import { compileRouteNetwork } from "../core/graph/compiler.js";
import { difference, intersection, ringAsMulti } from "../core/geom/boolean.js";
import { emptyMesh, type MeshBuffers } from "../core/geom/mesh.js";
import { rectRing, ringArea, type Rect, type Ring, type Vec2 } from "../core/geom/types.js";
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
import type { BuildCityChunksResult } from "../worker/protocol.js";
import {
  deleteGeneratedWalls,
  isSceneEnabled,
  loadCityState,
  saveCityState,
  setSceneEnabledFlag,
  type CityLoadResult,
  type SaveExpectation
} from "./documents.js";
import { replaceGeneratedWalls } from "./documents.js";
import { WallReplacementScheduler, wallSegmentsForPlan } from "./generated-walls.js";
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
  markingTriangleCount: number;
  bytes: number;
}

export interface RoadSelection {
  edgeIds: string[];
  nodeIds: string[];
}

export interface RoadInspector {
  edgeIds: string[];
  classId: RouteClassId | "multiple";
  name: string | null | "multiple";
  locked: boolean | "multiple";
  origin: RoadOrigin | "multiple";
  curvePreset: RoadCurvePreset | "multiple";
  routeIds: string[];
}

export interface RoadBuildStats {
  requested: number;
  built: number;
  compiledRoutes: number;
  compiledSegments: number;
  markingTriangleCount: number;
  totalTriangles: number;
  totalBytes: number;
  roundTripMs: number;
  workerMode: "worker" | "fallback";
  dirty: boolean;
  scope: "none" | "dirty" | "all";
}

export interface DistrictInspector {
  districtIds: string[];
  typeId: DistrictTypeId | "multiple";
  paletteId: string | "multiple";
  seed: string | "multiple";
  locked: boolean | "multiple";
  openSpaceOverride: DistrictSource["openSpaceOverride"] | "multiple";
}

export interface DistrictSnapOptions {
  districtVertices: boolean;
  roadJunctions: boolean;
  blockBoundaries: boolean;
  foundryGrid: boolean;
}

export interface InitialGenerationStats {
  planningRoundTripMs: number;
  workerMode: "worker" | "fallback";
  diagnostics: RoadGenerationDiagnostics;
  nodes: number;
  edges: number;
  routes: number;
}

const session = new TerrainSession();
const terrainActions = new TerrainActionQueue();
const frameQuality = new FrameQualityController();
const chunks = new Map<string, TerrainChunkRecord>();
let cityRenderer: CityRenderer | null = null;
let districtEditorPresentation = false;
let tickerCallback: (() => void) | null = null;
let workerClient: WorkerClient | null = null;
let workerUnavailable = false;
let workerWarned = false;
const cityListeners = new Set<() => void>();
let layerCityListener: (() => void) | null = null;
let draftCancelListener: (() => void) | null = null;
let roadDraftCancelListener: (() => void) | null = null;
let localWriteRevision: number | null = null;
let localEnabledWrite: boolean | null = null;
let lastBuild: RebuildResult | null = null;
let lastRoadBuild: RoadBuildStats | null = null;
let lastInitialGeneration: InitialGenerationStats | null = null;
let roadSelection: RoadSelection = { edgeIds: [], nodeIds: [] };
let roadSnapToFoundryGrid = false;
let roadActionSequence = 0;
let districtActionSequence = 0;
let districtPlan: DistrictPlan | null = null;
let districtPlanRevision: number | null = null;
let districtPlanEpoch: number | null = null;
let districtPlanRoundTripMs = 0;
let districtPlanWorkerMode: "worker" | "fallback" = "fallback";
let preflightPlan: { revision: number; plan: DistrictPlan; roundTripMs: number; workerMode: "worker" | "fallback" } | null = null;
let districtSelection: string[] = [];
let districtDraftCancelListener: (() => void) | null = null;
let districtSnapOptionsState = {
  districtVertices: true,
  roadJunctions: true,
  blockBoundaries: true,
  foundryGrid: false
};
let wallDiagnostic: { kind: "degraded"; reason: string; revision: number } | null = null;
let wallNotifyRevision: number | null = null;
let lastWallBuild: { scheduled: number; created: number; deleted: number; ms: number; stale: boolean; degraded?: boolean } | null = null;
const wallScheduler = new WallReplacementScheduler();

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

function applyDistrictEditorPresentation(): void {
  if (cityRenderer === null) return;
  const alpha = districtEditorPresentation ? 0.48 : 1;
  cityRenderer.display.alpha = alpha;
  cityRenderer.overlay.alpha = alpha;
  cityRenderer.weather.alpha = alpha;
}

export function setDistrictsPresentation(active: boolean): void {
  districtEditorPresentation = active;
  applyDistrictEditorPresentation();
}

function cancelScheduledWalls(): void {
  wallScheduler.cancel();
}

async function installGeneratedWalls(city: CityStateV3, plan: DistrictPlan, sourceRevision: number, sourceEpoch: number, replacementToken: number): Promise<void> {
  const started = performance.now();
  if (replacementToken !== wallScheduler.token || !terrainBuildIsCurrent(sourceRevision, sourceEpoch, session.current?.revision ?? null, session.buildEpoch)) {
    if (replacementToken === wallScheduler.token) lastWallBuild = { scheduled: sourceRevision, created: 0, deleted: 0, ms: 0, stale: true };
    return;
  }
  try {
    const segments = wallSegmentsForPlan(plan, city.source.origin, pixelsPerMetre());
    const result = await replaceGeneratedWalls(segments, () => replacementToken === wallScheduler.token && terrainBuildIsCurrent(sourceRevision, sourceEpoch, session.current?.revision ?? null, session.buildEpoch));
    if (replacementToken !== wallScheduler.token || !terrainBuildIsCurrent(sourceRevision, sourceEpoch, session.current?.revision ?? null, session.buildEpoch)) {
      if (replacementToken === wallScheduler.token) lastWallBuild = { scheduled: sourceRevision, created: 0, deleted: 0, ms: performance.now() - started, stale: true };
      if (replacementToken === wallScheduler.token) {
        const latest = session.current;
        if (latest !== null && districtPlan !== null && districtPlanRevision === latest.revision && districtPlanEpoch === session.buildEpoch) {
          scheduleGeneratedWallRebuild(latest, districtPlan);
        } else {
          wallDiagnostic = { kind: "degraded", reason: "Generated walls were superseded before the latest plan was available.", revision: latest?.revision ?? sourceRevision };
        }
      } else if (session.current === null) {
        wallDiagnostic = { kind: "degraded", reason: "Generated walls were superseded before the latest plan was available.", revision: sourceRevision };
      }
      return;
    }
    wallDiagnostic = null;
    wallNotifyRevision = null;
    lastWallBuild = { scheduled: sourceRevision, created: result.created, deleted: result.deleted, ms: performance.now() - started, stale: false };
  } catch (error) {
    if (replacementToken !== wallScheduler.token) return;
    const reason = error instanceof Error ? error.message : String(error);
    wallDiagnostic = { kind: "degraded", reason, revision: sourceRevision };
    lastWallBuild = { scheduled: sourceRevision, created: 0, deleted: 0, ms: performance.now() - started, stale: false, degraded: true };
    if (wallNotifyRevision !== sourceRevision) {
      wallNotifyRevision = sourceRevision;
      ui.notifications?.warn(`Nixie: generated walls degraded — ${reason}`);
    }
  }
}

function scheduleGeneratedWallRebuild(city: CityStateV3, plan: DistrictPlan, immediate = false): void {
  const sourceRevision = city.revision;
  const sourceEpoch = session.buildEpoch;
  lastWallBuild = { scheduled: sourceRevision, created: 0, deleted: 0, ms: 0, stale: false };
  const task = (token: number): Promise<void> => installGeneratedWalls(city, plan, sourceRevision, sourceEpoch, token);
  if (immediate) void wallScheduler.runNow(task);
  else wallScheduler.schedule(task, 400);
}

function scheduleCurrentPlanWalls(): void {
  const city = session.current;
  if (city === null || districtPlan === null || districtPlanRevision !== city.revision || districtPlanEpoch !== session.buildEpoch) return;
  scheduleGeneratedWallRebuild(city, districtPlan);
}

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

function publishPreflightPlan(revision: number): DistrictPlan | null {
  if (preflightPlan === null || preflightPlan.revision !== revision) return null;
  districtPlan = preflightPlan.plan;
  districtPlanRevision = revision;
  districtPlanEpoch = session.buildEpoch;
  districtPlanRoundTripMs = preflightPlan.roundTripMs;
  districtPlanWorkerMode = preflightPlan.workerMode;
  const published = preflightPlan.plan;
  preflightPlan = null;
  if (wallDiagnostic?.reason.startsWith("Generated walls were superseded") && wallDiagnostic.revision === revision && session.current !== null) {
    wallDiagnostic = null;
    scheduleGeneratedWallRebuild(session.current, published);
  }
  return published;
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

export function setRoadDraftCancelListener(listener: (() => void) | null): void {
  roadDraftCancelListener = listener;
}

export function cancelRoadDraft(): void {
  roadDraftCancelListener?.();
}

export function cancelTerrainDraft(): void {
  draftCancelListener?.();
  cancelRoadDraft();
  districtDraftCancelListener?.();
}

export function cityLoadStatus(): CityLoadResult {
  return session.status;
}

export function getCity(): CityStateV3 | null {
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
  applyDistrictEditorPresentation();

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
  roadSelection = { edgeIds: [], nodeIds: [] };
  if (session.current !== null) {
    mountRenderer();
    void rebuildGeometry().then(() => scheduleCurrentPlanWalls()).catch((error) =>
      console.error(`${MODULE_ID} | terrain rebuild failed`, error)
    );
  }
  notifyCityChanged();
}

export function unmount(): void {
  unmountRenderer();
  session.reset({ kind: "absent" });
  cancelTerrainDraft();
  districtPlan = null;
  districtPlanRevision = null;
  districtPlanEpoch = null;
  districtSelection = [];
  districtDraftCancelListener = null;
  cancelScheduledWalls();
  wallDiagnostic = null;
  localWriteRevision = null;
  roadSelection = { edgeIds: [], nodeIds: [] };
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

function newState(seed: string, mode: TerrainMode, edge: CoastEdge | null): CityStateV3 {
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
      generation: {
        terrainMode: mode,
        coastEdge: edge,
        roadLayout: "european",
        hubMode: "single-centre",
        districtPool: [...DISTRICT_TYPE_IDS],
        openSpaceProfile: "medium"
      },
      terrain: { land, urbanFootprint: null },
      roads: { nodes: [], routes: [], edges: [] },
      districts: []
    }
  };
}

function generatedCandidate(seed: string, mode: TerrainMode, edge: CoastEdge | null): CityStateV3 {
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
      generation: {
        ...current.source.generation,
        terrainMode: mode,
        coastEdge: edge
      },
      terrain: { ...current.source.terrain, land }
    }
  };
}

const ROAD_CLEARANCE_AREA_EPSILON = 1e-7;

function edgeQuad(a: Vec2, b: Vec2, halfWidth: number): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0 || halfWidth <= 0) return [];
  const nx = (-dy / length) * halfWidth;
  const ny = (dx / length) * halfWidth;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny }
  ];
}

function nodeDisc(center: Vec2, radius: number, count = 24): Ring {
  if (radius <= 0) return [];
  const ring: Ring = [];
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    ring.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  return ring;
}

function multiArea(multi: ReturnType<typeof ringAsMulti>): number {
  return multi.reduce(
    (total, polygon) => total + polygon.reduce((area, ring, index) => area + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0),
    0
  );
}

export function roadClearanceBlockers(
  roads: CitySourceV3["roads"],
  land: Ring,
  sceneBounds: Rect
): string[] {
  const scene = ringAsMulti(rectRing(sceneBounds));
  const water = difference(scene, [ringAsMulti(normalizeRing(land))]);
  if (water.length === 0) return [];
  const network = compileRouteNetwork(roads);
  const blocked = new Set<string>();
  for (const segment of network.segments) {
    const corridor = edgeQuad(segment.a, segment.b, segment.clearanceM);
    const parts = corridor.length >= 3 ? [corridor] : [];
    const aDisc = nodeDisc(segment.a, segment.clearanceM);
    const bDisc = nodeDisc(segment.b, segment.clearanceM);
    if (aDisc.length >= 3) parts.push(aDisc);
    if (bDisc.length >= 3) parts.push(bDisc);
    for (const part of parts) {
      const overlap = intersection(water, ringAsMulti(part));
      if (multiArea(overlap) > ROAD_CLEARANCE_AREA_EPSILON) {
        blocked.add(segment.edgeId);
        break;
      }
    }
  }
  return [...blocked].sort((left, right) => left.localeCompare(right));
}

function validateCandidate(candidate: CityStateV3, geometryPrebuilt = false): void {
  const sourceProblems = validateCitySourceV3(candidate.source);
  if (sourceProblems.length > 0) throw new Error(sourceProblems.join(" "));
  const result = validateTerrain(candidate.source.terrain);
  if (!result.ok) throw new Error(result.reason);
  const topology = validateRouteTopology(candidate.source.roads);
  if (!topology.ok) throw new Error(topology.problems.join(" "));
  const compiled = topology.ok ? compileRouteNetwork(candidate.source.roads) : null;
  if (compiled !== null) {
    const blockers = roadClearanceBlockers(candidate.source.roads, candidate.source.terrain.land, sceneBoundsM(candidate.source.origin));
    if (blockers.length > 0) throw new Error(`Roads ${blockers.join(", ")} cross water or leave the land mask.`);
  }
  if (!geometryPrebuilt) {
    const bounds = sceneBoundsM(candidate.source.origin);
    const ppm = pixelsPerMetre();
    const builds = buildCityChunksSync(candidate.source, chunksCovering(bounds), bounds, ppm).chunks;
    for (const build of builds) {
      if (
        build.mesh.vertices.some((value) => !Number.isFinite(value)) ||
        build.mesh.indices.length !== build.mesh.triangleCount * 3
      ) {
        throw new Error(`Terrain preflight failed in chunk ${build.id}.`);
      }
    }
  }
}

function warnLargeScene(candidate: CityStateV3): void {
  const bounds = sceneBoundsM(candidate.source.origin);
  if (Math.hypot(bounds.width, bounds.height) <= SUPPORTED_DIAGONAL_M) return;
  ui.notifications?.warn(
    `Nixie: this Scene exceeds the supported ${SUPPORTED_DIAGONAL_M} m diagonal; later automatic coverage and performance are not guaranteed.`
  );
}

async function guardedSave(
  candidate: CityStateV3,
  expectation: SaveExpectation,
  geometryPrebuilt = false,
  suppliedPlan: DistrictPlan | null = null,
  skipPlan = false
): Promise<CityStateV3> {
  validateCandidate(candidate, geometryPrebuilt);
  if (!skipPlan) {
    const current = session.current;
    const statusBeforePlan = session.status;
    const creating = current === null && (statusBeforePlan.kind === "absent" || statusBeforePlan.kind === "legacy") && candidate.revision === 1;
    if (!creating && (current === null || current.revision + 1 !== candidate.revision)) {
      throw new Error("City revision changed before district planning; retry from the current Scene.");
    }
    const planned = suppliedPlan === null
      ? await buildPlanForCity(candidate, ++districtActionSequence, session.buildEpoch)
      : { plan: suppliedPlan, roundTripMs: 0, workerMode: districtPlanWorkerMode };
    const currentAfterPlan = session.current;
    const statusAfterPlan = session.status;
    if (creating) {
      if (currentAfterPlan !== null || statusAfterPlan.kind !== statusBeforePlan.kind) {
        throw new Error("District planning was superseded by newer Scene state.");
      }
    } else if (currentAfterPlan?.revision !== candidate.revision - 1) {
      throw new Error("District planning was superseded by newer Scene state.");
    }
    preflightPlan = { revision: candidate.revision, ...planned };
  } else {
    preflightPlan = null;
  }
  const status = session.status;
  const saveExpectation =
    status.kind === "supported" && status.migratedFrom !== undefined
      ? status.migratedFrom.schemaVersion === 1
        ? { kind: "migrated-schema-1" as const, revision: status.migratedFrom.revision }
        : { kind: "migrated-schema-2" as const, revision: status.migratedFrom.revision }
      : expectation;
  localWriteRevision = candidate.revision;
  try {
    return await saveCityState(candidate, saveExpectation);
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
    const plan = publishPreflightPlan(saved.revision);
    if (plan !== null) scheduleGeneratedWallRebuild(saved, plan);
  } else {
    const expected: SaveExpectation = status.kind === "legacy" ? "legacy" : "absent";
    const saved = await guardedSave(candidate, expected);
    session.publishCreation(saved);
    const plan = publishPreflightPlan(saved.revision);
    if (plan !== null) scheduleGeneratedWallRebuild(saved, plan);
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

async function commitSource(source: CityStateV3["source"], wallRelevant = true, geometryPrebuilt = false): Promise<RebuildResult> {
  const current = session.current;
  if (current === null) throw new Error("Create a City Generator 2.0 terrain first.");
  const candidate: CityStateV3 = { ...current, revision: current.revision + 1, source };
  const saved = await guardedSave(candidate, current.revision, geometryPrebuilt);
  session.publishCommit(saved);
  const districtIds = new Set(saved.source.districts.map((district) => district.id));
  districtSelection = districtSelection.filter((id) => districtIds.has(id));
  const plan = publishPreflightPlan(saved.revision);
  if (wallRelevant && plan !== null) scheduleGeneratedWallRebuild(saved, plan);
  cancelTerrainDraft();
  notifyCityChanged();
  if (!wallRelevant) {
    const currentBuild = lastBuild;
    return currentBuild === null
      ? { full: true, chunks: 0, triangles: 0, bytes: 0, ms: 0, stale: false }
      : { ...currentBuild, ms: 0, stale: false };
  }
  return rebuildAfterCommit();
}

function nextRoadSequence(): number {
  roadActionSequence += 1;
  return roadActionSequence;
}

function validateRoadEdgeSelection(
  source: CitySourceV3["roads"],
  edgeIds: readonly string[]
): Set<string> {
  if (edgeIds.length === 0) throw new Error("Select at least one road segment.");
  const selected = new Set(edgeIds);
  const existing = new Set(source.edges.map((edge) => edge.id));
  if (selected.size !== edgeIds.length || edgeIds.some((id) => !existing.has(id))) {
    throw new Error("Road selection is stale; select the roads again.");
  }
  return selected;
}

/** Keep the selection across commits, dropping any road or junction the commit removed. */
function pruneRoadSelection(selection: RoadSelection, source: CitySourceV3["roads"]): RoadSelection {
  const edgeIds = new Set(source.edges.map((edge) => edge.id));
  const nodeIds = new Set(source.nodes.map((node) => node.id));
  return {
    edgeIds: selection.edgeIds.filter((id) => edgeIds.has(id)),
    nodeIds: selection.nodeIds.filter((id) => nodeIds.has(id))
  };
}

function roadEdgesForSelection(
  source: CitySourceV3["roads"],
  edgeIds: readonly string[],
  contiguousName: boolean
): Set<string> {
  const selected = new Set(edgeIds);
  if (!contiguousName || selected.size === 0) return selected;
  if (selected.size !== 1) throw new Error("Contiguous same-name edits require one selected segment.");
  const first = source.edges.find((edge) => selected.has(edge.id));
  if (!first) return selected;
  const name = first.name;
  const nodes = new Map(source.nodes.map((node) => [node.id, node]));
  const connected = new Set<string>(selected);
  const queue = [...selected];
  while (queue.length > 0) {
    const edgeId = queue.shift()!;
    const edge = source.edges.find((candidate) => candidate.id === edgeId);
    if (!edge || edge.name !== name) continue;
    for (const candidate of source.edges) {
      if (candidate.name !== name || connected.has(candidate.id)) continue;
      const shares = candidate.routeId === edge.routeId && (candidate.a === edge.a || candidate.a === edge.b || candidate.b === edge.a || candidate.b === edge.b);
      if (shares && nodes.has(candidate.a) && nodes.has(candidate.b)) {
        connected.add(candidate.id);
        queue.push(candidate.id);
      }
    }
  }
  return connected;
}

function dirtyRoadKeys(before: CitySourceV3["roads"], after: CitySourceV3["roads"], sceneBounds: Rect): ChunkKey[] {
  const oldRoutes = new Map(before.routes.map((route) => [route.id, route.curvePreset]));
  const newRoutes = new Map(after.routes.map((route) => [route.id, route.curvePreset]));
  const changedRoutes = new Set<string>();
  for (const [id, preset] of oldRoutes) if (newRoutes.get(id) !== preset) changedRoutes.add(id);
  for (const [id, preset] of newRoutes) if (oldRoutes.get(id) !== preset) changedRoutes.add(id);
  const oldEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const newEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const changedEdges = new Set<string>();
  for (const [id, edge] of oldEdges) if (JSON.stringify(edge) !== JSON.stringify(newEdges.get(id))) changedEdges.add(id);
  for (const id of newEdges.keys()) if (!oldEdges.has(id)) changedEdges.add(id);
  const oldNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const changedNodes = new Set<string>();
  for (const [id, node] of oldNodes) if (JSON.stringify(node) !== JSON.stringify(newNodes.get(id))) changedNodes.add(id);
  for (const id of newNodes.keys()) if (!oldNodes.has(id)) changedNodes.add(id);
  for (const edge of [...before.edges, ...after.edges]) {
    if (!changedNodes.has(edge.a) && !changedNodes.has(edge.b)) continue;
    changedEdges.add(edge.id);
    changedRoutes.add(edge.routeId);
  }
  const oldNetwork = compileRouteNetwork(before);
  const newNetwork = compileRouteNetwork(after);
  const segments = [...oldNetwork.segments, ...newNetwork.segments].filter((segment) => changedEdges.has(segment.edgeId) || changedRoutes.has(segment.routeId));
  if (segments.length === 0) return chunksCovering(sceneBounds);
  const margin = Math.max(16, oldNetwork.maxClearanceM, newNetwork.maxClearanceM) + 26;
  const x0 = Math.max(sceneBounds.x, Math.min(...segments.flatMap((segment) => [segment.a.x, segment.b.x])) - margin);
  const y0 = Math.max(sceneBounds.y, Math.min(...segments.flatMap((segment) => [segment.a.y, segment.b.y])) - margin);
  const x1 = Math.min(sceneBounds.x + sceneBounds.width, Math.max(...segments.flatMap((segment) => [segment.a.x, segment.b.x])) + margin);
  const y1 = Math.min(sceneBounds.y + sceneBounds.height, Math.max(...segments.flatMap((segment) => [segment.a.y, segment.b.y])) + margin);
  if (x1 <= x0 || y1 <= y0) return chunksCovering(sceneBounds);
  return chunksCovering({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

export function chunkCoverageComplete(availableChunkIds: readonly string[], sceneBounds: Rect): boolean {
  const available = new Set(availableChunkIds);
  return chunksCovering(sceneBounds).every((key) => available.has(chunkId(key)));
}

async function preflightCity(candidate: CityStateV3, token: number, keysOverride?: ChunkKey[]): Promise<{ batch: Awaited<ReturnType<typeof buildBatch>>; keys: ChunkKey[] }> {
  const bounds = sceneBoundsM(candidate.source.origin);
  const keys = keysOverride ?? chunksCovering(bounds);
  const batch = await buildBatch(ensureWorker(), candidate, keys, bounds, pixelsPerMetre(), token, token);
  if (batch.records.length !== keys.length) throw new Error("City preflight did not build every affected chunk.");
  for (const record of batch.records) {
    if (record.mesh.vertices.some((value) => !Number.isFinite(value)) || record.mesh.indices.length !== record.mesh.triangleCount * 3) {
      throw new Error(`City preflight failed in chunk ${record.id}.`);
    }
  }
  return { batch, keys };
}

function installBatch(
  city: CityStateV3,
  records: TerrainChunkRecord[],
  keys: ChunkKey[],
  revision: number,
  actionToken: number,
  batch?: CityBatchBuild,
  full = true
): RebuildResult {
  const renderer = cityRenderer;
  if (renderer === null) throw new Error("The city renderer is unavailable.");
  const current = session.current;
  if (current?.revision !== revision || actionToken !== roadActionSequence) {
    return { full: true, chunks: 0, triangles: 0, bytes: 0, ms: 0, stale: true };
  }
  const started = performance.now();
  const ppm = pixelsPerMetre();
  renderer.pixelsPerMetre = ppm;
  const live = new Set(keys.map(chunkId));
  if (full) {
    for (const id of [...chunks.keys()]) {
      if (!live.has(id)) {
        chunks.delete(id);
        renderer.removeChunk(id);
      }
    }
  }
  for (const record of records) {
    chunks.set(record.id, record);
    renderer.setChunk(chunkGeometry(city, record, ppm));
  }
  frameQuality.reset();
  const result: RebuildResult = {
    full: true,
    chunks: records.length,
    triangles: [...chunks.values()].reduce((sum, record) => sum + record.mesh.triangleCount, 0),
    bytes: [...chunks.values()].reduce((sum, record) => sum + record.bytes, 0),
    ms: performance.now() - started,
    stale: false
  };
  lastBuild = result;
  const counters = batch?.counters;
  lastRoadBuild = {
    requested: keys.length,
    built: records.length,
    compiledRoutes: counters?.compiledRoutes ?? 0,
    compiledSegments: counters?.compiledSegments ?? 0,
    markingTriangleCount: counters?.markingTriangleCount ?? records.reduce((sum, record) => sum + record.markingTriangleCount, 0),
    totalTriangles: counters?.triangleCount ?? records.reduce((sum, record) => sum + record.mesh.triangleCount, 0),
    totalBytes: counters?.bytes ?? records.reduce((sum, record) => sum + record.bytes, 0),
    roundTripMs: batch?.roundTripMs ?? 0,
    workerMode: batch?.workerMode ?? "fallback",
    dirty: !full,
    scope: full ? "all" : "dirty"
  };
  return result;
}

async function commitRoadSource(source: CitySourceV3["roads"], generation?: Partial<CitySourceV3["generation"]>, metadataOnly = false, fullRebuild = false): Promise<RebuildResult> {
  const current = session.current;
  if (current === null) throw new Error("Create a City Generator 2.0 terrain first.");
  const nextSource: CityStateV3["source"] = {
    ...current.source,
    generation: { ...current.source.generation, ...generation },
    roads: source
  };
  const candidate: CityStateV3 = {
    ...current,
    revision: current.revision + 1,
    source: {
      ...nextSource,
      districts: metadataOnly ? current.source.districts : reconcileDistrictsForRoadEdit(current.source, nextSource)
    }
  };
  if (metadataOnly) {
    const reusablePlan = districtPlan !== null && districtPlanRevision === current.revision ? districtPlan : null;
    const saved = await guardedSave(candidate, current.revision, true, null, true);
    session.publishCommit(saved);
    preflightPlan = null;
    if (reusablePlan !== null) {
      districtPlan = reusablePlan;
      districtPlanRevision = saved.revision;
      districtPlanEpoch = session.buildEpoch;
    } else {
      districtPlan = null;
      districtPlanRevision = null;
      districtPlanEpoch = null;
    }
    roadSelection = pruneRoadSelection(roadSelection, source);
    districtSelection = districtSelection.filter((id) => saved.source.districts.some((district) => district.id === id));
    lastRoadBuild = {
      requested: 0,
      built: 0,
      compiledRoutes: 0,
      compiledSegments: 0,
      markingTriangleCount: 0,
      totalTriangles: 0,
      totalBytes: 0,
      roundTripMs: 0,
      workerMode: workerClient === null ? "fallback" : "worker",
      dirty: false,
      scope: "none"
    };
    cancelTerrainDraft();
    notifyCityChanged();
    const existing = [...chunks.values()];
    return { full: true, chunks: 0, triangles: existing.reduce((sum, chunk) => sum + chunk.mesh.triangleCount, 0), bytes: existing.reduce((sum, chunk) => sum + chunk.bytes, 0), ms: 0, stale: false };
  }
  const actionToken = nextRoadSequence();
  const bounds = sceneBoundsM(candidate.source.origin);
  const completeCoverage = chunkCoverageComplete([...chunks.keys()], bounds);
  const installFull = fullRebuild || !completeCoverage;
  const keys = installFull ? chunksCovering(bounds) : dirtyRoadKeys(current.source.roads, source, bounds);
  const prebuilt = await preflightCity(candidate, actionToken, keys);
  const saved = await guardedSave(candidate, current.revision, true);
  session.publishCommit(saved);
  const plan = publishPreflightPlan(saved.revision);
  if (plan !== null) scheduleGeneratedWallRebuild(saved, plan);
  let result: RebuildResult;
  try {
    mountRenderer();
    result = installBatch(saved, prebuilt.batch.records, prebuilt.keys, saved.revision, actionToken, prebuilt.batch, installFull);
  } catch (error) {
    console.error(`${MODULE_ID} | committed road presentation failed`, error);
    ui.notifications?.error(`Nixie: roads were saved, but presentation failed — ${error instanceof Error ? error.message : String(error)}`);
    result = { full: true, chunks: 0, triangles: 0, bytes: 0, ms: 0, stale: false, degraded: true };
  }
  roadSelection = pruneRoadSelection(roadSelection, source);
  const districtIds = new Set(saved.source.districts.map((district) => district.id));
  districtSelection = districtSelection.filter((id) => districtIds.has(id));
  cancelTerrainDraft();
  notifyCityChanged();
  return result;
}

export function getRoadSelection(): RoadSelection {
  return { edgeIds: [...roadSelection.edgeIds], nodeIds: [...roadSelection.nodeIds] };
}

export function clearRoadSelection(): void {
  roadSelection = { edgeIds: [], nodeIds: [] };
  notifyCityChanged();
}

export function selectRoad(edgeId: string, additive = false): RoadSelection {
  const city = session.current;
  if (city === null || !city.source.roads.edges.some((edge) => edge.id === edgeId)) return getRoadSelection();
  const selected = additive ? new Set(roadSelection.edgeIds) : new Set<string>();
  if (selected.has(edgeId)) selected.delete(edgeId);
  else selected.add(edgeId);
  roadSelection = { edgeIds: [...selected], nodeIds: [] };
  notifyCityChanged();
  return getRoadSelection();
}

export function selectRoadNode(nodeId: string, additive = false): RoadSelection {
  const city = session.current;
  if (city === null || !city.source.roads.nodes.some((node) => node.id === nodeId)) return getRoadSelection();
  const selected = additive ? new Set(roadSelection.nodeIds) : new Set<string>();
  if (selected.has(nodeId)) selected.delete(nodeId);
  else selected.add(nodeId);
  roadSelection = { edgeIds: [], nodeIds: [...selected] };
  notifyCityChanged();
  return getRoadSelection();
}

export function roadInspector(edgeIds: readonly string[] = roadSelection.edgeIds): RoadInspector | null {
  const city = session.current;
  if (city === null) return null;
  const edges = city.source.roads.edges.filter((edge) => edgeIds.includes(edge.id));
  if (edges.length === 0) return null;
  const classId = edges.every((edge) => edge.classId === edges[0]!.classId) ? edges[0]!.classId : "multiple";
  const name = edges.every((edge) => edge.name === edges[0]!.name) ? edges[0]!.name : "multiple";
  const locked = edges.every((edge) => edge.locked === edges[0]!.locked) ? edges[0]!.locked : "multiple";
  const origin = edges.every((edge) => edge.origin === edges[0]!.origin) ? edges[0]!.origin : "multiple";
  const routePresets = new Map(city.source.roads.routes.map((route) => [route.id, route.curvePreset]));
  const presets = edges.map((edge) => routePresets.get(edge.routeId)).filter((preset): preset is RoadCurvePreset => preset !== undefined);
  const curvePreset = presets.length > 0 && presets.every((preset) => preset === presets[0]) ? presets[0]! : "multiple";
  return {
    edgeIds: edges.map((edge) => edge.id),
    classId,
    name,
    locked,
    origin,
    curvePreset,
    routeIds: [...new Set(edges.map((edge) => edge.routeId))]
  };
}

export function setRoadGridSnap(enabled: boolean): boolean {
  roadSnapToFoundryGrid = enabled;
  return roadSnapToFoundryGrid;
}

export function roadGridSnapEnabled(): boolean {
  return roadSnapToFoundryGrid;
}

function snapRoadPoint(point: Vec2): Vec2 {
  if (!roadSnapToFoundryGrid) return point;
  const grid = canvas?.grid;
  if (grid?.getSnappedPoint && canvas?.dimensions?.type !== 0) {
    try {
      const mode = (globalThis as any).CONST?.GRID_SNAPPING_MODES?.VERTEX;
      const snapped = grid.getSnappedPoint(point, mode === undefined ? undefined : { mode, resolution: 1 });
      if (snapped && Number.isFinite(snapped.x) && Number.isFinite(snapped.y)) return { x: snapped.x, y: snapped.y };
    } catch {
      return point;
    }
  }
  return point;
}

export function appendRoad(
  points: readonly Vec2[],
  classId: RouteClassId = "street",
  curvePreset: RoadCurvePreset = "standard",
  name: string | null = null
): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (!ROUTE_CLASS_REGISTRY.has(classId)) throw new Error(`Unknown route class "${classId}".`);
    const snapped = points.map((point) => worldToMetres(snapRoadPoint(metresToWorld(point))));
    const source = appendRoute(city.source.roads, snapped, {
      classId,
      curvePreset,
      name,
      origin: "authored",
      revision: city.revision + 1,
      sequence: nextRoadSequence()
    });
    return commitRoadSource(source);
  });
}

export function generateRoads(
  layout: CitySourceV3["generation"]["roadLayout"] = "european",
  hubMode: CitySourceV3["generation"]["hubMode"] = "single-centre"
): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (city.source.roads.edges.length > 0) throw new Error("Initial road generation is available only on an empty road source.");
    const mask = city.source.terrain.urbanFootprint ?? city.source.terrain.land;
    const input: RoadGenerationInput = {
      citySeed: city.source.citySeed,
      mask,
      land: city.source.terrain.land,
      layout,
      hubMode,
      sceneBounds: sceneBoundsM(city.source.origin)
    };
    const actionToken = roadActionSequence + 1;
    const buildToken = session.buildEpoch;
    const generated = await planInitialRoadNetwork(input, city.revision, actionToken, buildToken);
    if (
      session.current?.revision !== city.revision ||
      session.buildEpoch !== buildToken ||
      roadActionSequence + 1 !== actionToken
    ) throw new Error("Initial road generation was superseded by newer Scene state.");
    return commitRoadSource(generated.roads, { roadLayout: layout, hubMode }, false, true);
  });
}

export function moveRoadNode(nodeId: string, point: Vec2): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const source = moveNode(city.source.roads, nodeId, worldToMetres(snapRoadPoint(metresToWorld(point))), {
      revision: city.revision + 1,
      sequence: nextRoadSequence()
    });
    return commitRoadSource(source);
  });
}

export function weldRoadNodes(fromId: string, intoId: string): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    return commitRoadSource(weldNodes(city.source.roads, fromId, intoId));
  });
}

export function deleteRoadJunction(nodeId: string): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    return commitRoadSource(deleteJunction(city.source.roads, nodeId, { revision: city.revision + 1, sequence: nextRoadSequence() }));
  });
}

export function deleteRoads(edgeIds: readonly string[] = roadSelection.edgeIds): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    validateRoadEdgeSelection(city.source.roads, edgeIds);
    const result = deleteEdges(city.source.roads, edgeIds);
    if (result.disconnectedVehicleNetwork) ui.notifications?.warn("Nixie: deleting these roads disconnected the vehicle network.");
    return commitRoadSource(result.source);
  });
}

export function setRoadLocked(locked: boolean, edgeIds: readonly string[] = roadSelection.edgeIds): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const selected = validateRoadEdgeSelection(city.source.roads, edgeIds);
    const source = {
      ...city.source.roads,
      edges: city.source.roads.edges.map((edge) => selected.has(edge.id) ? { ...edge, locked } : edge)
    };
    return commitRoadSource(source, undefined, true);
  });
}

export function setRoadCurvePreset(curvePreset: RoadCurvePreset, edgeIds: readonly string[] = roadSelection.edgeIds, contiguousName = false): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (!(["tight", "standard", "broad"] as const).includes(curvePreset)) throw new Error(`Unknown curve preset "${curvePreset}".`);
    const selectedIds = validateRoadEdgeSelection(city.source.roads, edgeIds);
    const selected = selectedIds.size === 1 && contiguousName
      ? roadEdgesForSelection(city.source.roads, edgeIds, true)
      : selectedIds;
    const routeIds = new Set(city.source.roads.edges.filter((edge) => selected.has(edge.id)).map((edge) => edge.routeId));
    const source = { ...city.source.roads, routes: city.source.roads.routes.map((route) => routeIds.has(route.id) ? { ...route, curvePreset } : route) };
    return commitRoadSource(source);
  });
}

export function renameRoad(name: string | null, contiguousName = false, edgeIds: readonly string[] = roadSelection.edgeIds): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const selectedIds = validateRoadEdgeSelection(city.source.roads, edgeIds);
    const selected = selectedIds.size === 1 && contiguousName
      ? roadEdgesForSelection(city.source.roads, edgeIds, true)
      : selectedIds;
    const source = { ...city.source.roads, edges: city.source.roads.edges.map((edge) => selected.has(edge.id) ? { ...edge, name: name === null || name.trim() === "" ? null : name.trim() } : edge) };
    return commitRoadSource(source, undefined, true);
  });
}

export function reclassifyRoad(classId: RouteClassId, contiguousName = false, edgeIds: readonly string[] = roadSelection.edgeIds): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (!ROUTE_CLASS_REGISTRY.has(classId)) throw new Error(`Unknown route class "${classId}".`);
    const selectedIds = validateRoadEdgeSelection(city.source.roads, edgeIds);
    const selected = selectedIds.size === 1 && contiguousName
      ? roadEdgesForSelection(city.source.roads, edgeIds, true)
      : selectedIds;
    const source = { ...city.source.roads, edges: city.source.roads.edges.map((edge) => selected.has(edge.id) ? { ...edge, classId } : edge) };
    return commitRoadSource(source);
  });
}

function districtPointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!;
    const b = ring[(index + 1) % ring.length]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function districtManualId(city: CityStateV3, lineage: string): string {
  let hash = 0x811c9dc5;
  const material = `${city.source.citySeed}\0districts/manual/${city.revision}/${lineage}`;
  for (let index = 0; index < material.length; index++) hash = Math.imul(hash ^ material.charCodeAt(index), 0x01000193);
  const base = `district_manual_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  const used = new Set(city.source.districts.map((district) => district.id));
  if (!used.has(base)) return base;
  for (let suffix = 1; ; suffix++) {
    const id = `${base}_${suffix}`;
    if (!used.has(id)) return id;
  }
}

function districtSeed(city: CityStateV3, lineage: string): string {
  return `${city.source.citySeed}/district/${city.revision}/${lineage}`;
}

function districtRecord(city: CityStateV3, polygon: Ring, typeId: DistrictTypeId, lineage: string, paletteId?: string): DistrictSource {
  if (!DISTRICT_TYPE_REGISTRY.has(typeId)) throw new Error(`Unknown district type "${typeId}".`);
  const resolvedPaletteId = paletteId ?? DISTRICT_TYPE_REGISTRY.get(typeId)!.defaultPaletteId;
  if (!DISTRICT_PALETTE_IDS.includes(resolvedPaletteId)) throw new Error(`Unknown district palette "${resolvedPaletteId}".`);
  return {
    id: districtManualId(city, lineage),
    polygon: normalizeRing(polygon),
    seed: districtSeed(city, lineage),
    typeId,
    paletteId: resolvedPaletteId,
    origin: "authored",
    locked: false,
    openSpaceOverride: null
  };
}

function districtSourceCommit(source: CityStateV3["source"]): Promise<RebuildResult> {
  return commitSource(source, false, true);
}

export function getDistrictPlan(): DistrictPlan | null {
  return districtPlan === null ? null : structuredClone(districtPlan);
}

// WHY: Cloning tens of thousands of derived cells blocks interactive overlay frames; callers must not mutate this view.
export function getDistrictPlanView(): Readonly<DistrictPlan> | null {
  return districtPlan;
}

export function getDistrictSelection(): string[] {
  return [...districtSelection];
}

export function clearDistrictSelection(): void {
  districtSelection = [];
  notifyCityChanged();
}

export function selectDistrict(id: string, additive = false): string[] {
  const city = session.current;
  if (city === null || !city.source.districts.some((district) => district.id === id)) return getDistrictSelection();
  const selected = additive ? new Set(districtSelection) : new Set<string>();
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  districtSelection = [...selected].filter((candidate) => city.source.districts.some((district) => district.id === candidate)).sort();
  notifyCityChanged();
  return getDistrictSelection();
}

export function districtInspector(ids: readonly string[] = districtSelection): DistrictInspector | null {
  const city = session.current;
  if (city === null) return null;
  const selected = city.source.districts.filter((district) => ids.includes(district.id));
  if (selected.length === 0) return null;
  const same = <T>(pick: (district: DistrictSource) => T): T | "multiple" => {
    const first = pick(selected[0]!);
    return selected.every((district) => JSON.stringify(pick(district)) === JSON.stringify(first)) ? first : "multiple";
  };
  return {
    districtIds: selected.map((district) => district.id),
    typeId: same((district) => district.typeId),
    paletteId: same((district) => district.paletteId),
    seed: same((district) => district.seed),
    locked: same((district) => district.locked),
    openSpaceOverride: same((district) => district.openSpaceOverride)
  };
}

export function setDistrictSnapOptions(options: Partial<DistrictSnapOptions>): DistrictSnapOptions {
  districtSnapOptionsState = { ...districtSnapOptionsState, ...options };
  return districtSnapOptions();
}

export function districtSnapOptions(): DistrictSnapOptions {
  return { ...districtSnapOptionsState };
}

export function setDistrictDraftCancelListener(listener: (() => void) | null): void {
  districtDraftCancelListener = listener;
}

export function cancelDistrictDraft(): void {
  districtDraftCancelListener?.();
}

export function districtDiagnostics(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  if (districtPlan?.diagnostics.warnings.length) {
    entries.push(...districtPlan.diagnostics.warnings.map((message) => ({ subsystem: "districts", message })));
  }
  if (wallDiagnostic !== null) entries.push({ subsystem: "walls", retry: "walls", message: wallDiagnostic.reason, revision: wallDiagnostic.revision });
  return entries;
}

export function retryGeneratedWalls(): Promise<void> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (districtPlan === null || districtPlanRevision !== city.revision || districtPlanEpoch !== session.buildEpoch) {
      await rebuildGeometry();
    }
    const latest = session.current;
    if (latest === null || districtPlan === null) throw new Error("The current district plan is unavailable.");
    cancelScheduledWalls();
    wallDiagnostic = null;
    await wallScheduler.runNow((replacementToken) => installGeneratedWalls(latest, districtPlan!, latest.revision, session.buildEpoch, replacementToken));
    const diagnostic = wallDiagnostic as { kind: "degraded"; reason: string; revision: number } | null;
    if (diagnostic !== null && diagnostic.revision === latest.revision) {
      throw new Error(diagnostic.reason);
    }
  });
}

export function generateDistricts(options: { districtPool: DistrictTypeId[]; openSpaceProfile: DistrictOpenSpaceProfile }): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (city.source.districts.length > 0) throw new Error("Initial district generation requires an empty district source.");
    const source: CityStateV3["source"] = {
      ...city.source,
      generation: {
        ...city.source.generation,
        districtPool: DISTRICT_TYPE_IDS.filter((id) => options.districtPool.includes(id)),
        openSpaceProfile: options.openSpaceProfile
      },
      districts: []
    };
    const availability = districtGenerationAvailability(source);
    if (!availability.available) throw new Error(availability.reason ?? "Initial district generation is unavailable.");
    const actionToken = ++districtActionSequence;
    const buildToken = session.buildEpoch;
    const districts = await planInitialDistricts(source, city.revision, actionToken, buildToken);
    if (
      session.current?.revision !== city.revision ||
      session.buildEpoch !== buildToken ||
      districtActionSequence !== actionToken
    ) throw new Error("Initial district generation was superseded by newer Scene state.");
    return districtSourceCommit({ ...source, districts });
  });
}

export function createDistrict(polygon: Ring, typeId: DistrictTypeId, paletteId?: string): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const incoming = districtRecord(city, polygon, typeId, `draw/${districtActionSequence++}`, paletteId);
    const districts = districtDrawCandidate(city.source, incoming);
    return districtSourceCommit({ ...city.source, districts });
  });
}

export function fillDistrict(point: Vec2, typeId: DistrictTypeId, paletteId?: string): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (districtSelection.length > 1) throw new Error("Fill requires zero or one selected district.");
    const plan = districtPlan ?? buildDistrictPlan(city.source);
    const block = plan.blocks.find((candidate) => districtPointInRing(point, candidate.zoningFace));
    if (block === undefined) throw new Error("Fill must target a generated road-defined block.");
    const selected = districtSelection.length === 1 ? districtSelection[0]! : null;
    const incoming = selected === null ? districtRecord(city, block.zoningFace, typeId, `fill/${block.id}`, paletteId) : undefined;
    const districts = districtFillCandidate(city.source, block.zoningFace, { targetDistrictId: selected, newDistrict: incoming });
    return districtSourceCommit({ ...city.source, districts });
  });
}

export function moveDistrictVertex(id: string, index: number, point: Vec2): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const districts = districtMoveVertexCandidate(city.source, id, index, point);
    return districtSourceCommit({ ...city.source, districts });
  });
}

export function splitDistrict(id: string, points: readonly Vec2[]): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (districtSelection.length !== 1 || districtSelection[0] !== id) throw new Error("Split requires exactly one selected district.");
    if (points.length !== 2) throw new Error("Split requires exactly two points.");
    const districts = districtSplitCandidate(city.source, id, points[0]!, points[1]!, districtManualId(city, `split/${id}/${districtActionSequence++}`));
    return districtSourceCommit({ ...city.source, districts });
  });
}

export function mergeDistricts(ids: readonly string[], survivorId: string): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const districts = districtMergeCandidate(city.source, ids, survivorId);
    const result = await districtSourceCommit({ ...city.source, districts });
    districtSelection = [survivorId];
    notifyCityChanged();
    return result;
  });
}

export function updateDistricts(ids: readonly string[], patch: DistrictUpdatePatch): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const districts = districtUpdateCandidate(city.source, ids, patch);
    return districtSourceCommit({ ...city.source, districts });
  });
}

export function deleteDistricts(ids: readonly string[]): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    const districts = districtDeleteCandidate(city.source, ids);
    return districtSourceCommit({ ...city.source, districts });
  });
}

export function replaceLand(ring: Ring): Promise<RebuildResult> {
  return terrainActions.run(() => {
    const current = session.current;
    if (current === null) throw new Error("Create a 2.0 terrain first.");
    return commitSource({
      ...current.source,
      generation: {
        ...current.source.generation,
        terrainMode: "custom",
        coastEdge: null
      },
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
          ? ({ ...current.source.generation, terrainMode: "custom", coastEdge: null } as const)
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
  const wallRelevant = JSON.stringify(current.source.terrain) !== JSON.stringify(target.source.terrain) || JSON.stringify(current.source.roads) !== JSON.stringify(target.source.roads);
  const saved = await guardedSave(target, current.revision);
  if (direction === "undo") session.publishUndo(saved);
  else session.publishRedo(saved);
  const plan = publishPreflightPlan(saved.revision);
  roadSelection = pruneRoadSelection(roadSelection, saved.source.roads);
  const districtIds = new Set(saved.source.districts.map((district) => district.id));
  districtSelection = districtSelection.filter((id) => districtIds.has(id));
  if (wallRelevant && plan !== null) scheduleGeneratedWallRebuild(saved, plan);
  cancelTerrainDraft();
  notifyCityChanged();
  if (wallRelevant) await rebuildAfterCommit();
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
  console.warn(`${MODULE_ID} | city worker unusable, falling back to the main thread`, error);
}

async function buildPlanForCity(city: CityStateV3, actionToken: number, buildToken: number): Promise<{ plan: DistrictPlan; roundTripMs: number; workerMode: "worker" | "fallback" }> {
  const started = performance.now();
  const client = ensureWorker();
  if (client !== null) {
    try {
      const result = await client.buildDistrictPlan({ source: city.source, sourceRevision: city.revision, actionToken, buildToken });
      if (result.sourceRevision !== city.revision || result.actionToken !== actionToken || result.buildToken !== buildToken) {
        throw new Error("Worker returned a stale district plan.");
      }
      return { plan: result.plan, roundTripMs: performance.now() - started, workerMode: "worker" };
    } catch (error) {
      if (error instanceof Error && error.message === "Worker returned a stale district plan.") throw error;
      noteWorkerFailure(error);
      if (client === workerClient) {
        client.terminate();
        workerClient = null;
        workerUnavailable = true;
      }
    }
  }
  return { plan: buildDistrictPlan(city.source), roundTripMs: performance.now() - started, workerMode: "fallback" };
}

async function planInitialDistricts(
  source: CitySourceV3,
  sourceRevision: number,
  actionToken: number,
  buildToken: number
): Promise<DistrictSource[]> {
  const client = ensureWorker();
  if (client !== null) {
    try {
      const result = await client.generateInitialDistricts({ source, sourceRevision, actionToken, buildToken });
      if (result.sourceRevision !== sourceRevision || result.actionToken !== actionToken || result.buildToken !== buildToken) {
        throw new Error("Worker returned stale initial district generation.");
      }
      return result.districts;
    } catch (error) {
      if (error instanceof Error && error.message === "Worker returned stale initial district generation.") throw error;
      let fallback: DistrictSource[];
      try {
        fallback = generateInitialDistricts(source);
      } catch (generationError) {
        throw generationError;
      }
      noteWorkerFailure(error);
      if (client === workerClient) {
        client.terminate();
        workerClient = null;
        workerUnavailable = true;
      }
      return fallback;
    }
  }
  return generateInitialDistricts(source);
}

async function planInitialRoadNetwork(
  input: RoadGenerationInput,
  sourceRevision: number,
  actionToken: number,
  buildToken: number
): Promise<GeneratedRoadNetwork> {
  const started = performance.now();
  const record = (generated: GeneratedRoadNetwork, workerMode: "worker" | "fallback"): GeneratedRoadNetwork => {
    lastInitialGeneration = {
      planningRoundTripMs: performance.now() - started,
      workerMode,
      diagnostics: generated.diagnostics,
      nodes: generated.roads.nodes.length,
      edges: generated.roads.edges.length,
      routes: generated.roads.routes.length
    };
    return generated;
  };
  const client = ensureWorker();
  if (client === null) return record(generateInitialRoadNetwork(input), "fallback");
  let result;
  try {
    result = await client.generateInitialRoadNetwork({ input, sourceRevision, actionToken, buildToken });
  } catch (workerError) {
    let fallback: GeneratedRoadNetwork;
    try {
      fallback = generateInitialRoadNetwork(input);
    } catch (generationError) {
      throw generationError;
    }
    noteWorkerFailure(workerError);
    if (client === workerClient) {
      workerClient.terminate();
      workerClient = null;
      workerUnavailable = true;
    }
    return record(fallback, "fallback");
  }
  if (
    result.sourceRevision !== sourceRevision ||
    result.actionToken !== actionToken ||
    result.buildToken !== buildToken ||
    result.config.layout !== input.layout ||
    result.config.hubMode !== input.hubMode
  ) throw new Error("Worker returned stale initial road generation.");
  return record({ roads: result.roads, diagnostics: result.diagnostics }, "worker");
}

function recordFromBuild(result: CityChunkBuild): TerrainChunkRecord {
  return {
    id: result.id,
    mesh: {
      vertices: result.mesh.vertices,
      indices: result.mesh.indices,
      vertexCount: result.mesh.vertexCount,
      triangleCount: result.mesh.triangleCount
    },
    boundsM: result.boundsM,
    landTriangleCount: result.exposedLandTriangleCount,
    waterTriangleCount: result.waterTriangleCount,
    markingTriangleCount: result.markingTriangleCount,
    bytes: result.mesh.vertices.byteLength + result.mesh.indices.byteLength
  };
}

interface CityBatchBuild {
  records: TerrainChunkRecord[];
  counters: BuildCityChunksResult["counters"];
  roundTripMs: number;
  workerMode: "worker" | "fallback";
}

async function buildBatch(
  client: WorkerClient | null,
  city: CityStateV3,
  keys: ChunkKey[],
  bounds: Rect,
  ppm: number,
  actionToken: number,
  buildToken: number
): Promise<CityBatchBuild> {
  const started = performance.now();
  if (client !== null) {
    try {
      const result = await client.buildCityChunks({
        source: city.source,
        sourceRevision: city.revision,
        actionToken,
        buildToken,
        sceneBoundsM: bounds,
        pixelsPerMetre: ppm,
        keys
      });
      if (
        result.sourceRevision !== city.revision ||
        result.actionToken !== actionToken ||
        result.buildToken !== buildToken
      ) throw new Error("Worker returned a stale city-chunk batch.");
      return {
        records: result.chunks.map(recordFromBuild),
        counters: result.counters,
        roundTripMs: performance.now() - started,
        workerMode: "worker"
      };
    } catch (error) {
      noteWorkerFailure(error);
      if (client === workerClient) {
        workerClient.terminate();
        workerClient = null;
        workerUnavailable = true;
      }
    }
  }
  const build = buildCityChunksSync(city.source, keys, bounds, ppm);
  return {
    records: build.chunks.map(recordFromBuild),
    counters: {
      requested: keys.length,
      built: build.chunks.length,
      vertexCount: build.chunks.reduce((sum, chunk) => sum + chunk.mesh.vertexCount, 0),
      triangleCount: build.chunks.reduce((sum, chunk) => sum + chunk.mesh.triangleCount, 0),
      bytes: build.chunks.reduce((sum, chunk) => sum + chunk.mesh.vertices.byteLength + chunk.mesh.indices.byteLength, 0),
      compiledRoutes: build.compiledRoutes,
      compiledSegments: build.compiledSegments,
      markingTriangleCount: build.markingTriangleCount
    },
    roundTripMs: performance.now() - started,
    workerMode: "fallback"
  };
}

function chunkGeometry(
  city: CityStateV3,
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
  const batch = await buildBatch(client, city, keys, bounds, ppm, revision, epoch);
  const planToken = ++districtActionSequence;
  const planned = await buildPlanForCity(city, planToken, epoch);
  let installed = 0;
  const current = session.current;
  if (terrainBuildIsCurrent(revision, epoch, current?.revision ?? null, session.buildEpoch)) {
    districtPlan = planned.plan;
    districtPlanRevision = revision;
    districtPlanEpoch = epoch;
    districtPlanRoundTripMs = planned.roundTripMs;
    districtPlanWorkerMode = planned.workerMode;
    for (const record of batch.records) {
      chunks.set(record.id, record);
      renderer.setChunk(chunkGeometry(city, record, ppm));
      frameQuality.reset();
      installed++;
    }
  }

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
  lastRoadBuild = {
    requested: batch.counters.requested,
    built: batch.counters.built,
    compiledRoutes: batch.counters.compiledRoutes,
    compiledSegments: batch.counters.compiledSegments,
    markingTriangleCount: batch.counters.markingTriangleCount,
    totalTriangles: batch.counters.triangleCount,
    totalBytes: batch.counters.bytes,
    roundTripMs: batch.roundTripMs,
    workerMode: batch.workerMode,
    dirty: false,
    scope: "all"
  };
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
  const serializedFlagBytes = new TextEncoder().encode(JSON.stringify(city)).byteLength;
  return {
    ...cityRenderer?.stats(),
    revision: city.revision,
    generatorVersion: city.generatorVersion,
    terrainMode: city.source.generation.terrainMode,
    coastEdge: city.source.generation.coastEdge,
    citySeed: city.source.citySeed,
    landVertices: city.source.terrain.land.length,
    urbanFootprintVertices: city.source.terrain.urbanFootprint?.length ?? 0,
    roadNodes: city.source.roads.nodes.length,
    roadEdges: city.source.roads.edges.length,
    roadRoutes: city.source.roads.routes.length,
    districts: city.source.districts.length,
    districtSelection: getDistrictSelection(),
    districtPlan: districtPlan === null ? null : {
      revision: districtPlanRevision,
      workerMode: districtPlanWorkerMode,
      roundTripMs: districtPlanRoundTripMs,
      blocks: districtPlan.blocks.length,
      fragments: districtPlan.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0),
      developmentCells: districtPlan.developmentCells.length,
      openSpaceIntents: districtPlan.openSpaceIntents.length,
      unzonedRegions: districtPlan.unzoned.length,
      wallCells: districtPlan.wallCells.length
    },
    districtDiagnostics: districtDiagnostics(),
    generatedWalls: lastWallBuild,
    serializedFlagBytes,
    roadSelection: getRoadSelection(),
    roadBuild: lastRoadBuild,
    initialGeneration: lastInitialGeneration,
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
    roadSelection = { edgeIds: [], nodeIds: [] };
    districtSelection = [];
    districtPlan = null;
    districtPlanRevision = null;
    districtPlanEpoch = null;
    unmountRenderer();
    cancelTerrainDraft();
    notifyCityChanged();
    ui.notifications?.warn("Nixie: the Scene city flag is no longer a supported 2.0 state; editing was disabled.");
    return;
  }
  if (!session.adoptExternal(result)) return;
  roadSelection = { edgeIds: [], nodeIds: [] };
  districtSelection = [];
  districtPlan = null;
  districtPlanRevision = null;
  districtPlanEpoch = null;
  cancelTerrainDraft();
  notifyCityChanged();
  ui.notifications?.warn("Nixie: a newer Scene revision was loaded; local history and drafts were cleared.");
  unmountRenderer();
  mountRenderer();
  void rebuildGeometry().then(() => scheduleCurrentPlanWalls()).catch((error) =>
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
      void rebuildGeometry().then(() => scheduleCurrentPlanWalls()).catch((error) =>
        console.error(`${MODULE_ID} | Scene scale terrain rebuild failed`, error)
      );
    }
  });
}

export { isSceneEnabled };
