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
import { chunksCovering, chunkId } from "../core/gen/chunks.js";
import {
  normalizeCitySeed,
  normalizeRing,
  validateTerrain,
  type CoastEdge
} from "../core/gen/terrain.js";
import {
  ROUTE_CLASS_REGISTRY,
  validateCitySourceV3,
  type CitySourceV3,
  type CityStateV3,
  type DistrictOpenSpaceProfile,
  type DistrictSource,
  type HubMode,
  type RoadCurvePreset,
  type RoadLayout,
  type RoadOrigin,
  type RouteClassId
} from "../core/gen/city.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "../core/gen/district-registry.js";
import type { DistrictPlan, StructuralInputSignature } from "../core/gen/district-plan.js";
import type { CompleteCityPlan } from "../core/gen/complete-city-plan.js";
import type { CompleteChunkBuild } from "../core/gen/complete-city-chunk.js";
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
import type { CompleteCityChunkProgress } from "../worker/protocol.js";
import {
  cityFlagIdentity,
  clearCityState,
  deleteGeneratedWalls,
  isSceneEnabled,
  loadCityState,
  saveCityState,
  setSceneEnabledFlag,
  type CityLoadResult,
  type ClearConfirmation,
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

export interface RebuildResult {
  full: true;
  chunks: number;
  triangles: number;
  bytes: number;
  ms: number;
  stale: boolean;
  degraded?: boolean;
}

/**
 * Staged settings for one full generation. The adapter composes the Scene-frame staging
 * (origin + scene bounds) from the live canvas; the UI supplies the rest verbatim.
 */
export interface FullGenerationStaging {
  terrainMode: "rectangle" | "coastal";
  coastEdge: CoastEdge | null;
  citySeed: string;
  roadLayout: RoadLayout;
  hubMode: HubMode;
  districtPool: DistrictTypeId[];
  openSpaceProfile: DistrictOpenSpaceProfile;
}

/** The single destructive start action's argument. `randomize` rolls a fresh seed. */
export interface FullGenerationRequest extends FullGenerationStaging {
  randomize: boolean;
  /**
   * The pre-dialog preflight pinned as the ClearConfirmation (kind + exact revision)
   * the user confirmed. The clear re-validates the live Scene against this exact
   * confirmation; a Scene that moved past it is rejected without clearing.
   */
  confirmation: ClearConfirmation;
}

export type { ClearConfirmation };

export interface FullGenerationResult {
  ok: boolean;
  state: GenerationState;
}

export interface GenerationPreflight {
  kind: "absent" | "legacy" | "obsolete-precomplete" | "supported" | "unsupported" | "malformed";
  /** Whether the current Scene state may be replaced by full generation. */
  replaceable: boolean;
  revision: number | null;
  schemaVersion: number | null;
  generatorVersion: number | null;
  sceneEnabled: boolean;
  reason: string;
  /** The exact raw Scene flag observed with this preflight; pins the clear identity. */
  raw: unknown;
}

interface TerrainChunkRecord {
  id: string;
  mesh: MeshBuffers;
  detail: MeshBuffers | null;
  neon: MeshBuffers | null;
  boundsM: Rect;
  boundsPx: Rect;
  landTriangleCount: number;
  waterTriangleCount: number;
  markingTriangleCount: number;
  openSpaceTriangleCount: number;
  buildingCount: number;
  landmarkCount: number;
  openSpaceCount: number;
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
let completeActionSequence = 0;
let absentGenerationSequence = 0;
// WHY: generator 11 owns one complete plan (structure + derived districts + buildings +
// landmarks) instead of the Phase 3 district-only plan. The Districts overlay and the
// generated walls both read from its districtPlan. The plan is derived state, but the
// contract is that every structural commit builds and validates it through the worker
// BEFORE the guarded save and publishes the exact validated plan atomically with the
// commit; metadata-only commits re-stamp it when the structural signature is unchanged.
let completePlan: CompleteCityPlan | null = null;
let completePlanRevision: number | null = null;
let completePlanEpoch: number | null = null;
let completePlanRoundTripMs = 0;
let completePlanDiagnostic: { kind: "degraded"; reason: string; revision: number } | null = null;
let planBuildInFlight: { revision: number; epoch: number } | null = null;
let planBuildQueued: { revision: number; epoch: number } | null = null;
const planWaiters = new Map<number, Array<() => void>>();
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

export type GenerationPhase = "idle" | "planning" | "saving" | "installing" | "complete" | "failed";

export interface GenerationFailure {
  phase: "planning" | "saving" | "installing";
  component: "generation" | "save" | "chunks";
  error: string;
  canRetrySameSeed: boolean;
  canGenerateNewSeed: boolean;
  canRetryGeometry: boolean;
}

export interface GenerationProgress {
  index: number;
  total: number;
}

export interface GenerationState {
  active: boolean;
  phase: GenerationPhase;
  progress: GenerationProgress | null;
  failure: GenerationFailure | null;
  seed: string | null;
  canRetrySameSeed: boolean;
  canGenerateNewSeed: boolean;
  canRetryGeometry: boolean;
  sourceRevision: number | null;
  epoch: number;
  startedAt: number | null;
  completedAt: number | null;
}

// WHY: full-generation ownership lives here, not in the session, so closing or switching
// the editor cannot cancel a running operation. The durable failure state keeps the
// staged settings so Retry Same Seed / Generate New Seed work after an editor round-trip.
interface GenerationOperation {
  staging: FullGenerationStaging;
  seed: string;
  /** The pre-dialog confirmation the user approved; retries carry it forward unchanged. */
  confirmation: ClearConfirmation | null;
  phase: GenerationPhase;
  progress: GenerationProgress | null;
  failure: GenerationFailure | null;
  sourceRevision: number | null;
  epoch: number;
  startedAt: number;
  completedAt: number | null;
}

let generationOperation: GenerationOperation | null = null;

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
        if (latest !== null && completePlan !== null && completePlanRevision === latest.revision && completePlanEpoch === session.buildEpoch) {
          scheduleGeneratedWallRebuild(latest, completePlan.districtPlan);
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
  if (city === null || completePlan === null || completePlanRevision !== city.revision || completePlanEpoch !== session.buildEpoch) return;
  scheduleGeneratedWallRebuild(city, completePlan.districtPlan);
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

// WHY: the plan is derived state that always travels with a saved revision. Structural
// commits build and validate it through the worker BEFORE saving and publish it
// atomically with the commit; the async rebuild path below exists only for derived
// rebuilds (mount, Scene scale changes, retries) where no save happens.
function resetCompletePlanState(): void {
  completePlan = null;
  completePlanRevision = null;
  completePlanEpoch = null;
  completePlanRoundTripMs = 0;
  completePlanDiagnostic = null;
  planBuildInFlight = null;
  planBuildQueued = null;
  resolvePlanWaiters();
}

/** Drop every installed chunk record and its rendered meshes (post-clear and rebuilds). */
function clearInstalledChunks(): void {
  chunks.clear();
  cityRenderer?.clearChunks();
  frameQuality.reset();
}

function resolvePlanWaiters(): void {
  for (const entries of planWaiters.values()) for (const resolve of entries) resolve();
  planWaiters.clear();
}

function waitForCompletePlan(revision: number): Promise<boolean> {
  if (completePlanRevision === revision && completePlan !== null) return Promise.resolve(true);
  // WHY: only a build for this revision can satisfy the waiter; without one the plan can
  // never arrive, so resolve immediately instead of parking the caller forever.
  if (planBuildInFlight?.revision !== revision && planBuildQueued?.revision !== revision) return Promise.resolve(false);
  // WHY: stored-resolver promises need the executor form; Promise.withResolvers requires lib es2024, and this project pins es2022.
  return new Promise((resolve) => {
    const entries = planWaiters.get(revision) ?? [];
    entries.push(() => resolve(completePlanRevision === revision && completePlan !== null));
    planWaiters.set(revision, entries);
  });
}

async function requireCompletePlan(city: CityStateV3): Promise<CompleteCityPlan> {
  if (completePlanRevision === city.revision && completePlan !== null) return completePlan;
  if (planBuildInFlight === null && planBuildQueued === null) requestCompletePlanRebuild(city);
  await waitForCompletePlan(city.revision);
  if (completePlanRevision === city.revision && completePlan !== null) return completePlan;
  throw new Error(completePlanDiagnostic?.reason ?? "The complete city plan for this revision is unavailable.");
}

function publishCompletePlan(plan: CompleteCityPlan, revision: number, epoch: number, walls: boolean, roundTripMs = completePlanRoundTripMs): void {
  completePlan = plan;
  completePlanRevision = revision;
  completePlanEpoch = epoch;
  completePlanRoundTripMs = roundTripMs;
  if (completePlanDiagnostic !== null && completePlanDiagnostic.revision <= revision) completePlanDiagnostic = null;
  const current = session.current;
  if (current !== null) {
    if (walls) scheduleGeneratedWallRebuild(current, plan.districtPlan);
    if (wallDiagnostic?.reason.startsWith("Generated walls were superseded") && wallDiagnostic.revision === revision) {
      wallDiagnostic = null;
      scheduleGeneratedWallRebuild(current, plan.districtPlan);
    }
  }
  resolvePlanWaiters();
  notifyCityChanged();
}

function requestCompletePlanRebuild(city: CityStateV3): void {
  const revision = city.revision;
  const epoch = session.buildEpoch;
  if (planBuildInFlight !== null) {
    planBuildQueued = { revision, epoch };
    return;
  }
  void runCompletePlanRebuild(city, revision, epoch);
}

// WHY: never fall back to a synchronous plan build; the UI thread must not run the
// planning pipeline. A degraded plan is surfaced in Diagnostics and retryable.
async function runCompletePlanRebuild(city: CityStateV3, revision: number, epoch: number): Promise<void> {
  planBuildInFlight = { revision, epoch };
  const actionToken = nextCompleteSequence();
  try {
    const plan = await buildCompletePlanThroughWorker(city.source, revision, epoch, actionToken);
    const current = session.current;
    if (current !== null && terrainBuildIsCurrent(revision, epoch, current.revision, session.buildEpoch)) {
      publishCompletePlan(plan, revision, epoch, false);
    } else {
      resolvePlanWaiters();
    }
  } catch (error) {
    // WHY: buildCompletePlanThroughWorker already handles worker teardown on transport
    // failures; here only the durable diagnostic is recorded.
    completePlanDiagnostic = {
      kind: "degraded",
      reason: workerClient === null
        ? "The city worker is unavailable; the complete city plan could not be rebuilt. Retry when it returns."
        : error instanceof Error ? error.message : String(error),
      revision
    };
    resolvePlanWaiters();
  }
  planBuildInFlight = null;
  flushPlanQueue();
}

function flushPlanQueue(): void {
  const queued = planBuildQueued;
  if (queued === null) return;
  planBuildQueued = null;
  const city = session.current;
  if (city === null || city.revision !== queued.revision) return;
  void runCompletePlanRebuild(city, queued.revision, queued.epoch);
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
  // WHY: the generation operation state is deliberately NOT reset here — full
  // generation ownership survives editor close, so a running operation can finish.
  resetCompletePlanState();
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

function validateCandidate(candidate: CityStateV3): void {
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
  // WHY: generator 11 geometry is preflighted by the worker's complete plan build; there
  // is deliberately no synchronous main-thread chunk fallback on this path.
}

async function guardedSave(
  candidate: CityStateV3,
  expectation: SaveExpectation
): Promise<CityStateV3> {
  validateCandidate(candidate);
  localWriteRevision = candidate.revision;
  try {
    return await saveCityState(candidate, expectation);
  } finally {
    localWriteRevision = null;
  }
}

function nextCompleteSequence(): number {
  completeActionSequence += 1;
  return completeActionSequence;
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

// WHY: generator 11 must decide whether a candidate edit changes the plan's structural
// input BEFORE touching the worker (metadata-only commits reuse the current plan and
// stay offline). This mirrors `inputSignature` in core/gen/district-plan.ts exactly and
// MUST stay in lockstep with it; the comparison target is the worker-built plan's own
// signature, so any drift surfaces as an unnecessary rebuild, never a stale publish.
const SIGNATURE_KEY_SCALE = 1_000;
const SIGNATURE_EPSILON = 1e-6;

function signatureHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function signatureStableId(prefix: string, material: string): string {
  return `${prefix}_${signatureHash(material).toString(16).padStart(8, "0")}`;
}

function signaturePointKey(point: Vec2): string {
  return `${Math.round(point.x * SIGNATURE_KEY_SCALE)},${Math.round(point.y * SIGNATURE_KEY_SCALE)}`;
}

function signatureKeyPoint(key: string): Vec2 {
  const [x, y] = key.split(",").map(Number);
  return { x: x! / SIGNATURE_KEY_SCALE, y: y! / SIGNATURE_KEY_SCALE };
}

function signatureSamePoint(a: Vec2, b: Vec2): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= SIGNATURE_EPSILON;
}

function signatureCanonicalRing(ring: Ring): Ring {
  const snapped: Ring = [];
  for (const point of ring) {
    const next = signatureKeyPoint(signaturePointKey(point));
    const previous = snapped[snapped.length - 1];
    if (!previous || !signatureSamePoint(previous, next)) snapped.push(next);
  }
  if (snapped.length > 1 && signatureSamePoint(snapped[0]!, snapped[snapped.length - 1]!)) snapped.pop();
  const normalized = normalizeRing(snapped);
  if (normalized.length === 0) return [];
  let start = 0;
  for (let i = 1; i < normalized.length; i++) {
    const a = normalized[i]!;
    const b = normalized[start]!;
    if (a.x < b.x || (a.x === b.x && a.y < b.y)) start = i;
  }
  return [...normalized.slice(start), ...normalized.slice(0, start)];
}

function signatureRing(ring: Ring): string {
  return signatureCanonicalRing(ring).map((point) => signaturePointKey(point)).join(";");
}

function structuralSignature(source: CitySourceV3): StructuralInputSignature {
  const nodes = [...source.roads.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const routes = [...source.roads.routes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...source.roads.edges].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, a, b, routeId, classId }) => ({ id, a, b, routeId, classId }));
  const districts = [...source.districts].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, polygon, seed, typeId, openSpaceOverride }) => ({ id, polygon, seed, typeId, openSpaceOverride }));
  return {
    terrain: signatureStableId("terrain", `${signatureRing(source.terrain.land)}|${source.terrain.urbanFootprint ? signatureRing(source.terrain.urbanFootprint) : ""}`),
    roads: signatureStableId("roads", JSON.stringify({ nodes, routes, edges })),
    districts: signatureStableId("districts", JSON.stringify(districts)),
    generation: signatureStableId("generation", JSON.stringify({ districtPool: [...source.generation.districtPool].sort(), openSpaceProfile: source.generation.openSpaceProfile }))
  };
}

/** The current plan when the candidate's structural input is unchanged (metadata reuse). */
function planForCandidate(candidate: CityStateV3): CompleteCityPlan | null {
  const plan = completePlan;
  const current = session.current;
  if (plan === null || current === null) return null;
  // WHY: the plan is keyed to the saved revision (every source change bumps the revision);
  // the build epoch only reflects render-input changes like Scene scale, which must not
  // invalidate the semantic plan.
  if (completePlanRevision !== current.revision) return null;
  const signature = structuralSignature(candidate.source);
  const stored = plan.structuralInput;
  if (signature.terrain !== stored.terrain || signature.roads !== stored.roads || signature.districts !== stored.districts || signature.generation !== stored.generation) return null;
  return plan;
}

// WHY: the complete plan and its chunks are worker-only; there is deliberately no
// synchronous main-thread build fallback for either. Identity (revision/action/build/
// epoch) is validated on every result and every progressive chunk message, so stale or
// superseded work installs nothing.
async function buildCompletePlanThroughWorker(source: CitySourceV3, sourceRevision: number, epoch: number, actionToken: number): Promise<CompleteCityPlan> {
  const client = ensureWorker();
  if (client === null) throw new Error("The city worker is unavailable; the complete city plan cannot be built.");
  const started = performance.now();
  let result: Awaited<ReturnType<WorkerClient["buildCompleteCityPlan"]>>;
  try {
    result = await client.buildCompleteCityPlan({ source, sourceRevision, actionToken, buildToken: epoch, epoch });
  } catch (error) {
    noteWorkerFailure(error);
    if (client === workerClient) {
      client.terminate();
      workerClient = null;
      workerUnavailable = true;
    }
    throw error;
  }
  if (result.sourceRevision !== sourceRevision || result.actionToken !== actionToken || result.buildToken !== epoch || result.epoch !== epoch) {
    throw new Error("Worker returned a stale complete city plan.");
  }
  if (result.validation.length > 0) {
    throw new Error(`The complete city plan is invalid: ${result.validation.join(" ")}`);
  }
  completePlanRoundTripMs = performance.now() - started;
  return result.plan;
}

interface CompleteIdentity {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
}

function completeIdentityMatches(result: CompleteIdentity, expected: CompleteIdentity): boolean {
  return (
    result.sourceRevision === expected.sourceRevision &&
    result.actionToken === expected.actionToken &&
    result.buildToken === expected.buildToken &&
    result.epoch === expected.epoch
  );
}

function completeRecordFrom(build: CompleteChunkBuild): TerrainChunkRecord {
  const bytes = build.mesh.vertices.byteLength + build.mesh.indices.byteLength +
    build.detail.vertices.byteLength + build.detail.indices.byteLength +
    build.neon.vertices.byteLength + build.neon.indices.byteLength;
  return {
    id: build.id,
    mesh: build.mesh,
    detail: build.detail,
    neon: build.neon,
    boundsM: build.boundsM,
    boundsPx: build.boundsPx,
    landTriangleCount: build.exposedLandTriangleCount,
    waterTriangleCount: build.waterTriangleCount,
    markingTriangleCount: build.markingTriangleCount,
    openSpaceTriangleCount: build.openSpaceTriangleCount,
    buildingCount: build.buildingCount,
    landmarkCount: build.landmarkCount,
    openSpaceCount: build.openSpaceCount,
    bytes
  };
}

function completeChunkGeometry(build: CompleteChunkBuild): ChunkGeometry {
  return {
    id: build.id,
    mesh: build.mesh,
    detail: build.detail,
    neon: build.neon,
    boundsPx: build.boundsPx,
    buildingCount: build.buildingCount,
    landmarkCount: build.landmarkCount,
    openSpaceCount: build.openSpaceCount
  };
}

/**
 * Build the final complete chunks for a saved revision through the worker and install
 * them as they arrive. Every progress message is identity-checked; stale ones install
 * nothing. Throws when the worker fails so callers decide between a degraded result
 * (ordinary commits, rebuilds) and a durable failure (full generation).
 */
async function installCompleteChunks(
  city: CityStateV3,
  plan: CompleteCityPlan,
  actionToken: number,
  epoch: number,
  onProgress?: (completed: number, total: number) => void
): Promise<RebuildResult> {
  mountRenderer();
  // WHY: a null renderer (canvas torn down mid-operation) must not fail the operation —
  // records still accumulate and a later mount reinstalls them from the saved flag.
  const renderer = cityRenderer;
  const started = performance.now();
  const bounds = sceneBoundsM(city.source.origin);
  const keys = chunksCovering(bounds);
  const ppm = pixelsPerMetre();
  if (renderer !== null) renderer.pixelsPerMetre = ppm;
  const live = new Set(keys.map(chunkId));
  for (const id of [...chunks.keys()]) {
    if (live.has(id)) continue;
    chunks.delete(id);
    renderer?.removeChunk(id);
  }
  const client = ensureWorker();
  if (client === null) throw new Error("The city worker is unavailable; final city geometry cannot be built.");
  const identity: CompleteIdentity = { sourceRevision: city.revision, actionToken, buildToken: epoch, epoch };
  let installed = 0;
  let staleProgress = false;
  const summary = await client.buildCompleteCityChunks(
    {
      source: city.source,
      plan,
      sceneBoundsM: bounds,
      pixelsPerMetre: ppm,
      keys,
      ...identity
    },
    (progress: CompleteCityChunkProgress) => {
      if (staleProgress) return;
      if (!completeIdentityMatches(progress, identity)) {
        staleProgress = true;
        return;
      }
      const current = session.current;
      if (!terrainBuildIsCurrent(city.revision, epoch, current?.revision ?? null, session.buildEpoch)) {
        staleProgress = true;
        return;
      }
      const record = completeRecordFrom(progress.chunk);
      chunks.set(record.id, record);
      if (renderer !== null) {
        renderer.setChunk(completeChunkGeometry(progress.chunk));
        frameQuality.reset();
        installed++;
      }
      onProgress?.(progress.index + 1, progress.total);
    }
  );
  if (staleProgress || !completeIdentityMatches(summary, identity)) {
    throw new Error("Worker returned a stale complete city chunk batch.");
  }
  const result: RebuildResult = {
    full: true,
    chunks: installed,
    triangles: [...chunks.values()].reduce((sum, record) => sum + record.mesh.triangleCount, 0),
    bytes: [...chunks.values()].reduce((sum, record) => sum + record.bytes, 0),
    ms: performance.now() - started,
    stale: !terrainBuildIsCurrent(city.revision, epoch, session.current?.revision ?? null, session.buildEpoch)
  };
  lastBuild = result;
  lastRoadBuild = {
    requested: summary.counters.requested,
    built: summary.counters.built,
    compiledRoutes: 0,
    compiledSegments: 0,
    markingTriangleCount: summary.counters.markingTriangleCount,
    totalTriangles: summary.counters.triangleCount,
    totalBytes: summary.counters.bytes,
    roundTripMs: performance.now() - started,
    workerMode: "worker",
    dirty: false,
    scope: "all"
  };
  return result;
}

/**
 * Shared commit path for every generator 11 structural or metadata edit. Structural
 * edits build and validate the matching complete plan through the worker BEFORE the
 * guarded save and publish the exact validated plan atomically with the commit; metadata
 * edits reuse the current plan only when the structural signature is unchanged.
 */
async function commitCandidate(candidate: CityStateV3, options: { wallRelevant?: boolean } = {}): Promise<RebuildResult> {
  const current = session.current;
  if (current === null) throw new Error("Create a City Generator 2.0 terrain first.");
  const wallRelevant = options.wallRelevant ?? true;
  const reusable = planForCandidate(candidate);
  let plan: CompleteCityPlan;
  let actionToken = 0;
  if (reusable !== null) {
    plan = reusable;
  } else {
    actionToken = nextCompleteSequence();
    plan = await buildCompletePlanThroughWorker(candidate.source, candidate.revision, session.buildEpoch, actionToken);
  }
  const saved = await guardedSave(candidate, current.revision);
  session.publishCommit(saved);
  publishCompletePlan(plan, saved.revision, session.buildEpoch, wallRelevant);
  const districtIds = new Set(saved.source.districts.map((district) => district.id));
  districtSelection = districtSelection.filter((id) => districtIds.has(id));
  cancelTerrainDraft();
  notifyCityChanged();
  if (reusable !== null) {
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
    const existing = [...chunks.values()];
    return {
      full: true,
      chunks: 0,
      triangles: existing.reduce((sum, chunk) => sum + chunk.mesh.triangleCount, 0),
      bytes: existing.reduce((sum, chunk) => sum + chunk.bytes, 0),
      ms: 0,
      stale: false
    };
  }
  try {
    return await installCompleteChunks(saved, plan, actionToken, session.buildEpoch);
  } catch (error) {
    console.error(`${MODULE_ID} | committed city presentation failed`, error);
    ui.notifications?.error(`Nixie: the city was saved, but presentation failed — ${error instanceof Error ? error.message : String(error)}`);
    return {
      full: true,
      chunks: 0,
      triangles: [...chunks.values()].reduce((sum, chunk) => sum + chunk.mesh.triangleCount, 0),
      bytes: [...chunks.values()].reduce((sum, chunk) => sum + chunk.bytes, 0),
      ms: 0,
      stale: false,
      degraded: true
    };
  }
}

async function commitSource(source: CityStateV3["source"], wallRelevant = true): Promise<RebuildResult> {
  const current = session.current;
  if (current === null) throw new Error("Create a City Generator 2.0 terrain first.");
  const candidate: CityStateV3 = { ...current, revision: current.revision + 1, source };
  return commitCandidate(candidate, { wallRelevant });
}

async function commitRoadSource(source: CitySourceV3["roads"], generation?: Partial<CitySourceV3["generation"]>, metadataOnly = false): Promise<RebuildResult> {
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
  const result = await commitCandidate(candidate);
  roadSelection = pruneRoadSelection(roadSelection, source);
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
    return commitRoadSource(generated.roads, { roadLayout: layout, hubMode });
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
  // WHY: district-only commits never schedule walls; the derived walls follow the plan,
  // which the commit publishes and the wall scheduler refreshes after the next structural
  // road/terrain commit or an explicit Retry.
  return commitSource(source, false);
}

export function getDistrictPlan(): DistrictPlan | null {
  return completePlan === null ? null : structuredClone(completePlan.districtPlan);
}

// WHY: Cloning tens of thousands of derived cells blocks interactive overlay frames; callers must not mutate this view.
export function getDistrictPlanView(): Readonly<DistrictPlan> | null {
  return completePlan === null ? null : completePlan.districtPlan;
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
  if (completePlanDiagnostic !== null) {
    entries.push({ subsystem: "districts", retry: "plan", message: completePlanDiagnostic.reason, revision: completePlanDiagnostic.revision });
  }
  if (completePlan !== null && completePlan.districtPlan.diagnostics.warnings.length) {
    entries.push(...completePlan.districtPlan.diagnostics.warnings.map((message) => ({ subsystem: "districts", message })));
  }
  if (wallDiagnostic !== null) entries.push({ subsystem: "walls", retry: "walls", message: wallDiagnostic.reason, revision: wallDiagnostic.revision });
  return entries;
}

export function retryDistrictPlan(): Promise<void> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (completePlanRevision === city.revision && completePlan !== null) return;
    if (workerUnavailable && workerClient === null) {
      // WHY: the worker is only sticky for automatic fallback; an explicit retry may re-create it.
      workerUnavailable = false;
    }
    await rebuildGeometry();
    if (completePlan === null || completePlanRevision !== city.revision) {
      throw new Error(completePlanDiagnostic?.reason ?? "The complete city plan is unavailable.");
    }
  });
}

export function retryGeneratedWalls(): Promise<void> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (completePlan === null || completePlanRevision !== city.revision || completePlanEpoch !== session.buildEpoch) {
      await rebuildGeometry();
      await requireCompletePlan(city);
    }
    const latest = session.current;
    const plan = completePlan;
    if (latest === null || plan === null) throw new Error("The current complete city plan is unavailable.");
    cancelScheduledWalls();
    wallDiagnostic = null;
    await wallScheduler.runNow((replacementToken) => installGeneratedWalls(latest, plan.districtPlan, latest.revision, session.buildEpoch, replacementToken));
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
    // WHY: the complete plan is derived; Fill needs the block faces, so it waits for the
    // current revision's plan instead of rebuilding it on the UI thread.
    const complete = await requireCompletePlan(city);
    const block = complete.districtPlan.blocks.find((candidate) => districtPointInRing(point, candidate.zoningFace));
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
  const reusable = planForCandidate(target);
  let plan: CompleteCityPlan;
  let actionToken = 0;
  if (reusable !== null) {
    plan = reusable;
  } else {
    actionToken = nextCompleteSequence();
    plan = await buildCompletePlanThroughWorker(target.source, target.revision, session.buildEpoch, actionToken);
  }
  const saved = await guardedSave(target, current.revision);
  if (direction === "undo") session.publishUndo(saved);
  else session.publishRedo(saved);
  publishCompletePlan(plan, saved.revision, session.buildEpoch, true);
  roadSelection = pruneRoadSelection(roadSelection, saved.source.roads);
  const districtIds = new Set(saved.source.districts.map((district) => district.id));
  districtSelection = districtSelection.filter((id) => districtIds.has(id));
  cancelTerrainDraft();
  notifyCityChanged();
  if (reusable !== null) return true;
  try {
    await installCompleteChunks(saved, plan, actionToken, session.buildEpoch);
  } catch (error) {
    console.error(`${MODULE_ID} | restored city presentation failed`, error);
    ui.notifications?.error(`Nixie: the city was restored, but presentation failed — ${error instanceof Error ? error.message : String(error)}`);
  }
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
  // WHY: generator 11 never falls back to a synchronous plan/chunk build; a failed
  // worker degrades or rejects the operation and the user retries through Diagnostics.
  console.warn(`${MODULE_ID} | city worker failed`, error);
}

function randomSeed(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues !== undefined) {
    const bytes = new Uint32Array(4);
    cryptoObject.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(8, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Cheap Scene-state preflight for the Generate tray; one flag read, no worker. */
export function generationPreflight(): GenerationPreflight {
  const result = loadCityState();
  const sceneEnabled = isSceneEnabled();
  const base = { sceneEnabled, raw: result.kind === "absent" ? undefined : result.raw };
  switch (result.kind) {
    case "absent":
      return { ...base, kind: "absent", replaceable: true, revision: null, schemaVersion: null, generatorVersion: null, reason: "This Scene has no city flag." };
    case "legacy":
      return { ...base, kind: "legacy", replaceable: true, revision: null, schemaVersion: null, generatorVersion: null, reason: "This Scene contains City Generator 1.0 data." };
    case "obsolete-precomplete":
      return { ...base, kind: "obsolete-precomplete", replaceable: true, revision: result.revision, schemaVersion: result.schemaVersion, generatorVersion: result.generatorVersion, reason: `This Scene contains an obsolete pre-complete generation (schema ${result.schemaVersion}, generator ${result.generatorVersion}).` };
    case "supported":
      return { ...base, kind: "supported", replaceable: true, revision: result.state.revision, schemaVersion: result.state.schemaVersion, generatorVersion: result.state.generatorVersion, reason: `This Scene contains a complete city at revision ${result.state.revision}.` };
    case "unsupported":
      return { ...base, kind: "unsupported", replaceable: false, revision: null, schemaVersion: result.schemaVersion, generatorVersion: result.generatorVersion ?? null, reason: "This Scene contains an unsupported City Generator 2.0 schema; it is never cleared automatically." };
    case "malformed":
      return { ...base, kind: "malformed", replaceable: false, revision: null, schemaVersion: null, generatorVersion: null, reason: "The City Generator 2.0 data is malformed; it is never cleared automatically." };
  }
}

export function generationActive(): boolean {
  const operation = generationOperation;
  return operation !== null && operation.phase !== "complete" && operation.phase !== "failed";
}

export function generationState(): GenerationState {
  const operation = generationOperation;
  const degradedCurrent = session.current !== null && completePlan !== null && completePlanRevision === session.current.revision && lastBuild?.degraded === true;
  if (operation === null) {
    return {
      active: false,
      phase: "idle",
      progress: null,
      failure: null,
      seed: null,
      canRetrySameSeed: false,
      canGenerateNewSeed: false,
      canRetryGeometry: degradedCurrent,
      sourceRevision: null,
      epoch: session.buildEpoch,
      startedAt: null,
      completedAt: null
    };
  }
  return {
    active: operation.phase !== "complete" && operation.phase !== "failed",
    phase: operation.phase,
    progress: operation.progress,
    failure: operation.failure,
    seed: operation.seed,
    canRetrySameSeed: operation.failure?.canRetrySameSeed ?? false,
    canGenerateNewSeed: operation.failure?.canGenerateNewSeed ?? false,
    canRetryGeometry: (operation.failure?.canRetryGeometry ?? false) || (operation.phase === "complete" && degradedCurrent),
    sourceRevision: operation.sourceRevision,
    epoch: operation.epoch,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt
  };
}

/**
 * Cheap staged-settings validation: no worker, no Scene writes. Returns a user-facing
 * problem, or null when the staged settings are ready to run. The Generate tray disables
 * its action on the same rule the adapter enforces defensively before claim and clear.
 */
export function validateGenerationStaging(staging: FullGenerationStaging): string | null {
  if (staging.citySeed.trim().length === 0) return "Enter a non-empty city seed.";
  if (staging.terrainMode === "coastal" && staging.coastEdge === null) return "Coastal generation requires a coast edge.";
  if (staging.terrainMode !== "coastal" && staging.coastEdge !== null) return "A coast edge only applies to coastal generation.";
  if (staging.districtPool.length === 0) return "Select at least one district type.";
  if (staging.districtPool.some((id) => !(DISTRICT_TYPE_IDS as readonly string[]).includes(id))) return "The district pool contains an unknown district type.";
  if (staging.roadLayout !== "european" && staging.roadLayout !== "grid" && staging.roadLayout !== "mixed") return "Choose a valid road layout.";
  if (staging.hubMode !== "single-centre" && staging.hubMode !== "multiple-hubs") return "Choose a valid hub mode.";
  if (staging.openSpaceProfile !== "none" && staging.openSpaceProfile !== "very-low" && staging.openSpaceProfile !== "low" && staging.openSpaceProfile !== "medium" && staging.openSpaceProfile !== "high") {
    return "Choose a valid open-space profile.";
  }
  return null;
}

/** The ClearConfirmation a pre-dialog preflight pins; unreplaceable kinds never map. */
export function clearConfirmationFor(preflight: GenerationPreflight): ClearConfirmation {
  switch (preflight.kind) {
    case "absent":
      return "absent";
    case "legacy":
      return { kind: "legacy", identity: cityFlagIdentity(preflight.raw) };
    case "obsolete-precomplete":
      return { kind: "obsolete-precomplete", revision: preflight.revision!, identity: cityFlagIdentity(preflight.raw) };
    case "supported":
      return { kind: "supported", revision: preflight.revision!, identity: cityFlagIdentity(preflight.raw) };
    default:
      throw new Error(`Full generation cannot replace ${preflight.kind} Scene state.`);
  }
}

function confirmationMatches(confirmation: ClearConfirmation, preflight: GenerationPreflight): boolean {
  if (confirmation === "absent") return preflight.kind === "absent";
  switch (confirmation.kind) {
    case "legacy":
      return preflight.kind === "legacy" && confirmation.identity === cityFlagIdentity(preflight.raw);
    case "obsolete-precomplete":
      return preflight.kind === "obsolete-precomplete" && preflight.revision === confirmation.revision && confirmation.identity === cityFlagIdentity(preflight.raw);
    case "supported":
      return preflight.kind === "supported" && preflight.revision === confirmation.revision && confirmation.identity === cityFlagIdentity(preflight.raw);
  }
}

/**
 * The clear authorization for this run. Fresh starts use the confirmation pinned before
 * the UI dialogs (kind + exact revision); a Scene that moved past it rejects without
 * clearing. Retries clear without new confirmations only while the Scene is still absent
 * or still exactly the revision that same confirmed operation created (its saved
 * sourceRevision); anything else needs fresh confirmation.
 */
function resolveClearConfirmation(pinned: ClearConfirmation | null, retry: boolean): ClearConfirmation {
  const current = generationPreflight();
  if (!current.replaceable) {
    throw new Error(`Full generation cannot replace this Scene state: ${current.reason}`);
  }
  if (retry) {
    if (current.kind === "absent") return "absent";
    if (pinned !== null && confirmationMatches(pinned, current)) return pinned;
    const operation = generationOperation;
    if (current.kind === "supported" && operation !== null && operation.sourceRevision !== null && current.revision === operation.sourceRevision) {
      return { kind: "supported", revision: current.revision, identity: cityFlagIdentity(current.raw) };
    }
    throw new Error("The Scene changed since the confirmed generation; run Randomize Entire City again for fresh confirmation.");
  }
  if (pinned === null) {
    throw new Error("Full generation requires the confirmed pre-dialog Scene state.");
  }
  if (!confirmationMatches(pinned, current)) {
    throw new Error("The Scene changed while you confirmed; nothing was cleared. Run Randomize Entire City again for fresh confirmation.");
  }
  return pinned;
}

function completeGeneration(): void {
  if (generationOperation === null) return;
  generationOperation.phase = "complete";
  generationOperation.progress = null;
  generationOperation.failure = null;
  generationOperation.completedAt = performance.now();
}

function failGeneration(phase: "planning" | "saving" | "installing", error: string): void {
  if (generationOperation === null) return;
  generationOperation.phase = "failed";
  generationOperation.progress = null;
  generationOperation.failure = {
    phase,
    component: phase === "planning" ? "generation" : phase === "saving" ? "save" : "chunks",
    error,
    canRetrySameSeed: true,
    canGenerateNewSeed: true,
    canRetryGeometry: phase === "installing" && session.current !== null
  };
  generationOperation.completedAt = performance.now();
}

/**
 * Synchronously claims the durable operation slot so a second start/retry is rejected
 * before it enqueues, even while the first operation is still awaiting its worker.
 * Returns false when another full generation is already active. Retries keep the
 * confirmation and the source revision of the confirmed operation they are re-running.
 */
function claimGeneration(staging: FullGenerationStaging, seed: string, confirmation: ClearConfirmation | null, previous: GenerationOperation | null = null): boolean {
  if (generationActive()) return false;
  generationOperation = {
    staging: { ...staging },
    seed,
    confirmation,
    phase: "planning",
    progress: null,
    failure: null,
    // WHY: a retry keeps the revision its confirmed operation created so the retry guard
    // can authorize clearing exactly that state without a fresh confirmation.
    sourceRevision: previous?.sourceRevision ?? null,
    epoch: session.buildEpoch,
    startedAt: performance.now(),
    completedAt: null
  };
  notifyCityChanged();
  return true;
}

/**
 * The one destructive full-generation operation. The UI performs its two confirmations
 * BEFORE calling this and pins the pre-dialog preflight (kind + exact revision) into the
 * request; the adapter clears only against that unchanged confirmation, so a Scene that
 * moved past it rejects without clearing. Order: guarded clear -> delete generated walls
 * -> session/history/selection/drafts/plan/chunks reset + notify -> worker-only complete
 * generation -> validation -> guarded revision-1 absent save -> publish source + plan
 * baseline -> progressive final chunks -> restore editing -> best-effort walls. Any
 * structural failure leaves the flag absent and a durable failure state for Retry Same
 * Seed / Generate New Seed; a stale or invalid request releases the slot instead.
 */
async function runFullGeneration(staging: FullGenerationStaging, seed: string, pinned: ClearConfirmation | null, retry: boolean): Promise<FullGenerationResult> {
  // WHY: the entry points claim the operation synchronously; this run always has one.
  const operation = generationOperation;
  if (operation === null) throw new Error("No full generation is active; start one first.");
  let confirmation: ClearConfirmation;
  try {
    const problem = validateGenerationStaging(staging);
    if (problem !== null) throw new Error(problem);
    confirmation = resolveClearConfirmation(pinned, retry);
  } catch (error) {
    // WHY: a stale, invalid, or unreplaceable request is a request error, not an
    // operation failure the recovery UI could retry; release the slot so the tray
    // returns to the form for a fresh confirmation instead of looping on retry.
    generationOperation = null;
    throw error;
  }
  try {
    await clearCityState(confirmation);
    try {
      await deleteGeneratedWalls();
    } catch (error) {
      console.error(`${MODULE_ID} | generated wall cleanup failed during full generation`, error);
      ui.notifications?.warn("Nixie: the city was cleared, but generated wall cleanup failed.");
    }
    // WHY: the confirmed clear is the moment the old city stops existing. Session state,
    // history, plan, road+district selections, drafts, generated-wall presentation, and
    // installed chunk records/rendered chunks all reset immediately; unrelated documents
    // were untouched by the guarded flag clear above.
    session.reset({ kind: "absent" });
    resetCompletePlanState();
    clearRoadSelection();
    clearDistrictSelection();
    cancelTerrainDraft();
    cancelScheduledWalls();
    wallDiagnostic = null;
    clearInstalledChunks();
    notifyCityChanged();
    // WHY: the post-clear epoch (after session.reset) stamps the worker request and the
    // plan it composes; the publish/install below re-syncs the operation epoch to the
    // session's post-publish epoch so request, plan, and published session all carry
    // post-clear epochs.
    const epoch = session.buildEpoch;
    operation.epoch = epoch;
    const absentToken = `absent:${++absentGenerationSequence}`;
    const actionToken = nextCompleteSequence();
    if (workerUnavailable && workerClient === null) {
      // WHY: an explicit retry may re-create the worker even though automatic fallback
      // was skipped while it was unavailable.
      workerUnavailable = false;
    }
    const client = ensureWorker();
    if (client === null) throw new Error("The generation worker is unavailable.");
    const generated = await client.generateCompleteCityPlan({
      staging: {
        ...staging,
        citySeed: seed,
        origin: sceneCentre(),
        sceneBoundsM: sceneBoundsM()
      },
      absentGenerationToken: absentToken,
      actionToken,
      buildToken: epoch,
      epoch
    });
    if (
      generated.sourceRevision !== 1 ||
      generated.absentGenerationToken !== absentToken ||
      generated.actionToken !== actionToken ||
      generated.buildToken !== epoch ||
      generated.epoch !== epoch
    ) {
      throw new Error("Worker returned a stale full generation result.");
    }
    if (generated.validation.length > 0) {
      throw new Error(`Full generation validation failed: ${generated.validation.join(" ")}`);
    }
    operation.phase = "saving";
    notifyCityChanged();
    // WHY: the worker composes the revision-1 SOURCE; the adapter wraps it into the full
    // persisted state so the guarded revision-1 save validates a real CityStateV3.
    const candidate: CityStateV3 = {
      kind: "city-generator-2",
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      revision: 1,
      source: generated.candidate
    };
    const saved = await guardedSave(candidate, "absent");
    session.publishCreation(saved);
    // WHY: the published session epoch (post-publish) is the one the plan baseline and
    // chunk install use; the operation epoch follows so request, plan, and published
    // session agree on one post-clear epoch.
    operation.epoch = session.buildEpoch;
    publishCompletePlan(generated.plan, saved.revision, session.buildEpoch, false);
    operation.sourceRevision = saved.revision;
    operation.phase = "installing";
    operation.progress = { index: 0, total: 0 };
    notifyCityChanged();
    const built = await installCompleteChunks(saved, generated.plan, actionToken, session.buildEpoch, (completed, total) => {
      if (generationOperation !== null) generationOperation.progress = { index: completed, total };
      notifyCityChanged();
    });
    // WHY: a stale install means the session moved past this city before its chunks
    // landed; reporting completion would be a lie, so the operation fails in the
    // installing phase and exposes geometry recovery instead.
    if (built.stale) {
      throw new Error("City chunks were superseded before installation finished.");
    }
    scheduleGeneratedWallRebuild(saved, generated.plan.districtPlan);
    completeGeneration();
    notifyCityChanged();
    return { ok: true, state: generationState() };
  } catch (error) {
    const phase = operation.phase === "saving" || operation.phase === "installing" ? operation.phase : "planning";
    failGeneration(phase, error instanceof Error ? error.message : String(error));
    notifyCityChanged();
    return { ok: false, state: generationState() };
  }
}

function fullGenerationStaging(request: FullGenerationRequest): FullGenerationStaging {
  return {
    terrainMode: request.terrainMode,
    coastEdge: request.coastEdge,
    citySeed: request.citySeed,
    roadLayout: request.roadLayout,
    hubMode: request.hubMode,
    districtPool: [...request.districtPool],
    openSpaceProfile: request.openSpaceProfile
  };
}

/** Start a full generation. Call only after the UI's two confirmations. */
export function startFullGeneration(request: FullGenerationRequest): Promise<FullGenerationResult> {
  const requested = fullGenerationStaging(request);
  const seed = request.randomize ? randomSeed() : normalizeCitySeed(request.citySeed.trim());
  const staging = { ...requested, citySeed: seed };
  // WHY: cheap staged-input errors are rejected before the operation claims the slot,
  // enqueues, or clears — the same rule the Generate tray uses to disable its action.
  const problem = validateGenerationStaging(staging);
  if (problem !== null) return Promise.reject(new Error(problem));
  // WHY: claim synchronously so a double-click is rejected before it enqueues behind the
  // running operation's action queue slot.
  if (!claimGeneration(staging, seed, request.confirmation)) {
    return Promise.reject(new Error("A full generation is already in progress; wait for it to finish."));
  }
  return terrainActions.run(() => runFullGeneration(staging, seed, request.confirmation, false));
}

/** Retry the last failed full generation with the exact same seed and settings. */
export function retryFullGeneration(): Promise<FullGenerationResult> {
  const operation = generationOperation;
  if (operation === null || operation.failure === null) {
    return Promise.reject(new Error("There is no failed full generation to retry."));
  }
  if (!operation.failure.canRetrySameSeed) {
    return Promise.reject(new Error("Retrying with the same seed is unavailable for this failure."));
  }
  if (!claimGeneration(operation.staging, operation.seed, operation.confirmation, operation)) {
    return Promise.reject(new Error("A full generation is already in progress; wait for it to finish."));
  }
  return terrainActions.run(() => runFullGeneration(operation.staging, operation.seed, operation.confirmation, true));
}

/** Retry the last failed full generation with a new seed (random when omitted). */
export function generateNewSeed(seed?: string): Promise<FullGenerationResult> {
  const operation = generationOperation;
  if (operation === null || operation.failure === null) {
    return Promise.reject(new Error("There is no failed full generation to retry."));
  }
  if (!operation.failure.canGenerateNewSeed) {
    return Promise.reject(new Error("Generating a new seed is unavailable for this failure."));
  }
  const next = seed !== undefined && seed.trim().length > 0 ? normalizeCitySeed(seed.trim()) : randomSeed();
  if (!claimGeneration(operation.staging, next, operation.confirmation, operation)) {
    return Promise.reject(new Error("A full generation is already in progress; wait for it to finish."));
  }
  return terrainActions.run(() => runFullGeneration(operation.staging, next, operation.confirmation, true));
}

/** Start full generation with a fresh random seed and the given settings. */
export function randomizeEntireCity(request: FullGenerationRequest): Promise<FullGenerationResult> {
  return startFullGeneration({ ...request, randomize: true });
}

/** Reinstall the final chunks for the current saved plan (post-save install recovery). */
export function retryGeometry(): Promise<RebuildResult> {
  return terrainActions.run(async () => {
    const city = session.current;
    if (city === null) throw new Error("Create a City Generator 2.0 terrain first.");
    if (completePlan === null || completePlanRevision !== city.revision) {
      await rebuildGeometry();
      const built = lastBuild;
      if (built === null) throw new Error("City geometry is unavailable.");
      return built;
    }
    return installCompleteChunks(city, completePlan, nextCompleteSequence(), session.buildEpoch);
  });
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

export async function rebuildGeometry(): Promise<RebuildResult> {
  const city = session.current;
  if (city === null) throw new Error("No supported City Generator 2.0 state is loaded.");
  mountRenderer();
  // WHY: installCompleteChunks tolerates a null renderer (records still accumulate), so a
  // torn-down canvas must not fail the rebuild; a later mount reinstalls the chunks.

  const started = performance.now();
  const epoch = session.buildEpoch;
  const revision = city.revision;
  // WHY: scale/bounds rebuilds reuse the current semantic plan — only pixels and chunk
  // coverage change. The plan is rebuilt (through the worker, never synchronously) only
  // when it is missing for this revision (e.g. after a fresh mount); the build epoch
  // intentionally does not invalidate it.
  let plan = completePlan !== null && completePlanRevision === revision ? completePlan : null;
  if (plan === null) {
    try {
      plan = await buildCompletePlanThroughWorker(city.source, revision, epoch, nextCompleteSequence());
    } catch (error) {
      noteWorkerFailure(error);
      completePlanDiagnostic = {
        kind: "degraded",
        reason: error instanceof Error ? error.message : String(error),
        revision
      };
      console.log(`${MODULE_ID} | complete plan rebuild failed — ${String(error)}`);
      return { full: true, chunks: 0, triangles: 0, bytes: 0, ms: performance.now() - started, stale: false, degraded: true };
    }
    const current = session.current;
    if (!terrainBuildIsCurrent(revision, epoch, current?.revision ?? null, session.buildEpoch)) {
      // WHY: a newer commit landed while this plan was building; its plan is authoritative.
      return { full: true, chunks: 0, triangles: 0, bytes: 0, ms: performance.now() - started, stale: true };
    }
    publishCompletePlan(plan, revision, epoch, false);
  }
  try {
    return await installCompleteChunks(city, plan, nextCompleteSequence(), epoch);
  } catch (error) {
    const current = session.current;
    if (cityRenderer === null || !terrainBuildIsCurrent(revision, epoch, current?.revision ?? null, session.buildEpoch)) {
      return { full: true, chunks: 0, triangles: 0, bytes: 0, ms: performance.now() - started, stale: true };
    }
    console.error(`${MODULE_ID} | terrain rebuild failed`, error);
    ui.notifications?.error(`Nixie: city presentation failed — ${error instanceof Error ? error.message : String(error)}`);
    return { full: true, chunks: 0, triangles: 0, bytes: 0, ms: performance.now() - started, stale: false, degraded: true };
  }
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
    completePlan: completePlan === null ? null : {
      revision: completePlanRevision,
      roundTripMs: completePlanRoundTripMs,
      buildToken: completePlan.buildToken,
      blocks: completePlan.districtPlan.blocks.length,
      fragments: completePlan.districtPlan.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0),
      developmentCells: completePlan.districtPlan.developmentCells.length,
      openSpaceIntents: completePlan.districtPlan.openSpaceIntents.length,
      unzonedRegions: completePlan.districtPlan.unzoned.length,
      wallCells: completePlan.districtPlan.wallCells.length,
      parcels: completePlan.parcels.length,
      openSpaces: completePlan.openSpaces.length,
      buildings: completePlan.buildings.length,
      landmarks: completePlan.landmarks.length
    },
    districtDiagnostics: districtDiagnostics(),
    generation: generationState(),
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
    resetCompletePlanState();
    unmountRenderer();
    cancelTerrainDraft();
    notifyCityChanged();
    ui.notifications?.warn("Nixie: the Scene city flag is no longer a supported 2.0 state; editing was disabled.");
    return;
  }
  if (!session.adoptExternal(result)) return;
  roadSelection = { edgeIds: [], nodeIds: [] };
  districtSelection = [];
  resetCompletePlanState();
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
