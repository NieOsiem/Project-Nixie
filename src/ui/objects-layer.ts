import {
  addCityListener,
  editSitePolygon,
  getArchitecturePlanView,
  getCity,
  isSceneEnabled,
  metresToWorld,
  placeBuilding,
  placePlace,
  transformObject,
  worldToMetres,
  type BuildingPlacementInput,
  type PlacePlacementInput
} from "../adapter/canvas.js";
import type { Ring, Rect, Vec2 } from "../core/geom/types.js";
import { ringArea, ringBounds } from "../core/geom/types.js";
import { BUILDING_GRAMMAR_REGISTRY, type BuildingGrammarId, type BuildingGrammarDefinition, type BuildingUseId } from "../core/gen/building-registry.js";
import { LANDMARK_GRAMMAR_REGISTRY, type LandmarkGrammarId, type LandmarkGrammarDefinition } from "../core/gen/landmark-registry.js";
import type { PlacementFrame } from "../core/gen/city.js";

type UnknownRecord = Record<string, unknown>;
interface GraphicsLike {
  eventMode: string;
  clear(): void;
  beginFill(color: number, alpha?: number): void;
  endFill(): void;
  lineStyle(style: unknown): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}
interface InteractionLayerLike {
  active: boolean;
  visible: boolean;
  addChild<T>(child: T): T;
  _draw(options: unknown): Promise<void>;
  _tearDown(options: unknown): Promise<void>;
}
interface ObjectLayerInstance extends InteractionLayerLike {
  refresh(): void;
  configureObjectPlacement(config: ObjectPlacementConfig | null): void;
  finishDraft(): Promise<boolean>;
  cancelDraft(clearConfig?: boolean, notify?: boolean): void;
  hasDraft(): boolean;
  _activate(): void;
  _deactivate(): void;
  _onMouseMove(event: unknown): void;
  _onMove(event: unknown): void;
  _onDragLeftStart(event: unknown): void;
  _onDragLeftMove(event: unknown): void;
  _onDragLeftDrop(event: unknown): void;
  _onDragLeftCancel(): void;
  _onClickLeft(event: unknown): void;
  _onClickRight(event: unknown): void;
  _onDragRightCancel(): void;
}
type LayerConstructor = (new () => ObjectLayerInstance) & { layerOptions?: Record<string, unknown> };
 

import {
  canvasTool,
  clearEditorActionError,
  editorLayerActivated,
  editorLayerDeactivated,
  LAYER_OBJECTS,
  notifyEditorInteraction,
  OBJECT_TOOL,
  setCanvasTool,
  setEditorActionError
} from "./editor-state.js";

export const OBJECT_LAYER_NAME = LAYER_OBJECTS;
export { OBJECT_TOOL } from "./editor-state.js";

export type ObjectKind = "building" | "place";
export interface ObjectSelection {
  ids: string[];
  kind: ObjectKind | null;
}

/**
 * Configuration supplied by the Objects workspace. It is deliberately only a
 * transient catalogue selection: no catalogue or form state is retained by the
 * layer after the workspace clears it.
 */
export interface ObjectPlacementConfig {
  kind: ObjectKind;
  grammarId?: BuildingGrammarId;
  landmarkGrammarId?: LandmarkGrammarId;
  visualUse?: BuildingUseId;
  heightM?: number;
  paletteId?: string | null;
  widthM?: number;
  depthM?: number;
  rotationRad?: number;
}

export interface ObjectPlacementFramePreview {
  kind: ObjectKind;
  frame: PlacementFrame;
  sitePolygon: Ring;
  valid: boolean;
  reason: string | null;
  color: number;
}

export interface ObjectLayerError {
  label: string;
  message: string;
  affectedIds: string[];
}

export interface ObjectsWorkspaceBridge {
  run(label: string, work: Promise<unknown>, then?: () => void): void;
  rerender?: () => void;
}

const COLOR_SITE_BUILDING = 0x6ad8d2;
const COLOR_SITE_PLACE = 0xf1c76d;
const COLOR_SELECTED = 0x74ffa8;
const COLOR_ERROR = 0xff6b75;
const COLOR_HANDLE = 0xffc94a;
export const OBJECT_PREVIEW_OK_COLOR = COLOR_SELECTED;
export const OBJECT_PREVIEW_ERROR_COLOR = COLOR_ERROR;

const DEFAULT_WIDTH_M = 20;
const DEFAULT_DEPTH_M = 20;
const MIN_SITE_AREA_M2 = 1;
function samePlacementConfig(left: ObjectPlacementConfig | null, right: ObjectPlacementConfig | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.kind === right.kind
    && left.grammarId === right.grammarId
    && left.landmarkGrammarId === right.landmarkGrammarId
    && left.visualUse === right.visualUse
    && left.heightM === right.heightM
    && left.paletteId === right.paletteId
    && left.widthM === right.widthM
    && left.depthM === right.depthM
    && left.rotationRad === right.rotationRad;
}


let activeLayer: InteractionLayerLike & {
  refresh?: () => void;
  invalidateHighlights?: () => void;
  configureObjectPlacement?: (config: ObjectPlacementConfig | null) => void;
  finishDraft?: () => Promise<boolean>;
  cancelDraft?: (clearConfig?: boolean, notify?: boolean) => void;
  hasDraft?: () => boolean;
} | null = null;
let workspaceBridge: ObjectsWorkspaceBridge | null = null;
let objectSelection: ObjectSelection = { ids: [], kind: null };
let objectError: ObjectLayerError | null = null;

interface BaseOverlayCacheKey {
  plan: unknown;
  lineWidth: number;
}

interface HighlightsCacheKey {
  plan: unknown;
  selection: string;
  error: string;
  lineWidth: number;
}

function selectionStateKey(selection: ObjectSelection): string {
  return `${selection.kind ?? ""}\u0001${selection.ids.join("\u0000")}`;
}

function errorStateKey(error: ObjectLayerError | null): string {
  return error === null ? "" : `${error.label}\u0001${error.message}\u0001${error.affectedIds.join("\u0000")}`;
}

function invalidateActiveHighlights(): void {
  activeLayer?.invalidateHighlights?.();
}

function interactionLayerBase(): unknown {
  const namespaced = foundry?.canvas?.layers?.InteractionLayer;
  if (namespaced) return namespaced;
  return typeof InteractionLayer === "undefined" ? null : InteractionLayer;
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function field(value: unknown, key: string): unknown {
  return record(value)?.[key];
}

function finitePoint(value: unknown): value is Vec2 {
  const candidate = record(value);
  return candidate !== null && Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function validRing(value: unknown): value is Ring {
  return Array.isArray(value)
    && value.length >= 3
    && value.every((point) => finitePoint(point));
}

function pointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index]!;
    const b = ring[(index + ring.length - 1) % ring.length]!;
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Supports a Ring, Polygon, or MultiPolygon without allocating normalized copies. */
function pointInShape(point: Vec2, value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (validRing(value)) return pointInRing(point, value);
  if (!Array.isArray(value[0])) return false;
  for (const polygon of value as unknown[]) {
    if (!Array.isArray(polygon) || polygon.length === 0) continue;
    if (!validRing(polygon[0])) continue;
    if (!pointInRing(point, polygon[0])) continue;
    let inHole = false;
    for (const hole of polygon.slice(1)) {
      if (validRing(hole) && pointInRing(point, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function rectContains(rect: Rect, point: Vec2): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Vec2, b: Vec2, point: Vec2): boolean {
  return point.x >= Math.min(a.x, b.x) - 1e-8
    && point.x <= Math.max(a.x, b.x) + 1e-8
    && point.y >= Math.min(a.y, b.y) - 1e-8
    && point.y <= Math.max(a.y, b.y) + 1e-8
    && Math.abs(orientation(a, b, point)) <= 1e-8;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > 1e-8 && abD < -1e-8) || (abC < -1e-8 && abD > 1e-8))
    && ((cdA > 1e-8 && cdB < -1e-8) || (cdA < -1e-8 && cdB > 1e-8))) return true;
  return (Math.abs(abC) <= 1e-8 && onSegment(a, b, c))
    || (Math.abs(abD) <= 1e-8 && onSegment(a, b, d))
    || (Math.abs(cdA) <= 1e-8 && onSegment(c, d, a))
    || (Math.abs(cdB) <= 1e-8 && onSegment(c, d, b));
}

function ringsOverlap(a: Ring, b: Ring): boolean {
  if (!validRing(a) || !validRing(b)) return false;
  const aBounds = ringBounds(a);
  const bBounds = ringBounds(b);
  if (aBounds.x > bBounds.x + bBounds.width || bBounds.x > aBounds.x + aBounds.width
    || aBounds.y > bBounds.y + bBounds.height || bBounds.y > aBounds.y + aBounds.height) return false;
  for (let ai = 0; ai < a.length; ai++) {
    const a0 = a[ai]!;
    const a1 = a[(ai + 1) % a.length]!;
    for (let bi = 0; bi < b.length; bi++) {
      if (segmentsIntersect(a0, a1, b[bi]!, b[(bi + 1) % b.length]!)) return true;
    }
  }
  return pointInRing(a[0]!, b) || pointInRing(b[0]!, a);
}

function frameRing(frame: PlacementFrame): Ring {
  const halfWidth = frame.widthM / 2;
  const halfDepth = frame.depthM / 2;
  const cos = Math.cos(frame.rotationRad);
  const sin = Math.sin(frame.rotationRad);
  return [
    { x: frame.centre.x - halfWidth * cos + halfDepth * sin, y: frame.centre.y - halfWidth * sin - halfDepth * cos },
    { x: frame.centre.x + halfWidth * cos + halfDepth * sin, y: frame.centre.y + halfWidth * sin - halfDepth * cos },
    { x: frame.centre.x + halfWidth * cos - halfDepth * sin, y: frame.centre.y + halfWidth * sin + halfDepth * cos },
    { x: frame.centre.x - halfWidth * cos - halfDepth * sin, y: frame.centre.y - halfWidth * sin + halfDepth * cos }
  ];
}

export function placementFrameRing(frame: PlacementFrame): Ring {
  return frameRing(frame);
}

function normalizedDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function frameForConfig(config: ObjectPlacementConfig, centre: Vec2): PlacementFrame {
  return {
    centre: { x: centre.x, y: centre.y },
    rotationRad: typeof config.rotationRad === "number" && Number.isFinite(config.rotationRad) ? config.rotationRad : 0,
    widthM: normalizedDimension(config.widthM, DEFAULT_WIDTH_M),
    depthM: normalizedDimension(config.depthM, DEFAULT_DEPTH_M)
  };
}

interface ArchitectureEntry {
  id: string;
  kind: ObjectKind;
  sitePolygon: Ring;
  plan: UnknownRecord;
}

function architectureObjects(plan: unknown): ArchitectureEntry[] {
  const planRecord = record(plan);
  if (planRecord === null) return [];
  const result: ArchitectureEntry[] = [];
  const buildings = planRecord.buildings;
  if (Array.isArray(buildings)) {
    for (const candidate of buildings) {
      const candidateRecord = record(candidate);
      if (candidateRecord === null) continue;
      const id = candidateRecord.id;
      const sitePolygon = candidateRecord.sitePolygon;
      if (typeof id === "string" && validRing(sitePolygon)) result.push({ id, kind: "building", sitePolygon, plan: candidateRecord });
    }
  }
  const landmarks = planRecord.landmarks;
  if (Array.isArray(landmarks)) {
    for (const candidate of landmarks) {
      const candidateRecord = record(candidate);
      if (candidateRecord === null) continue;
      const id = candidateRecord.id;
      const sitePolygon = candidateRecord.sitePolygon;
      if (typeof id === "string" && validRing(sitePolygon)) result.push({ id, kind: "place", sitePolygon, plan: candidateRecord });
    }
  }
  return result;
}

function placementPeerBlocks(object: ArchitectureEntry): boolean {
  const sourceId = field(object.plan, "sourceId");
  const protection = field(object.plan, "protection");
  // A fully-derived object is replaceable by authored placement unless an override
  // explicitly made it manual or protected. Persistent sources always block.
  return sourceId !== null || protection === "manual-edit" || protection === "explicit";
}

function cityRevision(city: unknown): number | null {
  const revision = field(city, "revision");
  return typeof revision === "number" && Number.isInteger(revision) ? revision : null;
}

function citySource(city: unknown): UnknownRecord {
  return record(field(city, "source")) ?? record(city) ?? {};
}

function placementValidity(
  config: ObjectPlacementConfig,
  frame: PlacementFrame,
  city: unknown,
  plan: unknown,
  excludeId: string | null = null
): { valid: boolean; reason: string | null } {
  if (city === null || city === undefined) return { valid: false, reason: "Create a City Generator 2.0 terrain first." };
  if (!Number.isFinite(frame.widthM) || !Number.isFinite(frame.depthM) || frame.widthM <= 0 || frame.depthM <= 0) {
    return { valid: false, reason: "The placement frame must have positive dimensions." };
  }
  const site = frameRing(frame);
  if (Math.abs(ringArea(site)) < MIN_SITE_AREA_M2) return { valid: false, reason: "The placement site is too small." };
  const source = citySource(city);
  const terrain = record(source.terrain);
  const land = terrain?.land;
  const urbanFootprint = terrain?.urbanFootprint;
  if (!pointInShape(frame.centre, land)) return { valid: false, reason: "The placement must lie inside land." };
  if (urbanFootprint !== undefined && !pointInShape(frame.centre, urbanFootprint)) return { valid: false, reason: "The placement must lie inside the urban footprint." };
  for (const point of site) {
    if (!pointInShape(point, land)) return { valid: false, reason: "The placement frame exceeds land." };
    if (urbanFootprint !== undefined && !pointInShape(point, urbanFootprint)) return { valid: false, reason: "The placement frame exceeds the urban footprint." };
  }
  if (config.kind === "building") {
    const grammar: BuildingGrammarDefinition | undefined = config.grammarId === undefined ? undefined : BUILDING_GRAMMAR_REGISTRY.get(config.grammarId);
    if (grammar === undefined) return { valid: false, reason: "Choose a valid building catalogue entry." };
    const area = Math.abs(ringArea(site));
    if (area < grammar.siteLimits.minAreaM2 || area > grammar.siteLimits.maxAreaM2) return { valid: false, reason: "The site area is outside this building grammar's limits." };
    if (config.visualUse !== undefined && !grammar.compatibleUses.includes(config.visualUse)) return { valid: false, reason: "The selected visual use is incompatible with this building grammar." };
    const height = config.heightM;
    if (height !== undefined && (!Number.isFinite(height) || height <= 0 || height < grammar.height.minM || height > grammar.height.maxM)) {
      return { valid: false, reason: "The building height is outside this grammar's range." };
    }
  } else {
    const grammar: LandmarkGrammarDefinition | undefined = config.landmarkGrammarId === undefined ? undefined : LANDMARK_GRAMMAR_REGISTRY.get(config.landmarkGrammarId);
    if (grammar === undefined) return { valid: false, reason: "Choose a valid place catalogue entry." };
    const area = Math.abs(ringArea(site));
    if (area < grammar.minSiteAreaM2 || area > grammar.maxSiteAreaM2) return { valid: false, reason: "The site area is outside this place grammar's limits." };
  }
  const routeOccupancy = record(field(plan, "routeOccupancy"));
  const occupancy = routeOccupancy?.all;
  if (Array.isArray(occupancy)) {
    for (const polygon of occupancy) {
      if (!Array.isArray(polygon) || !validRing(polygon[0])) continue;
      if (ringsOverlap(site, polygon[0])) return { valid: false, reason: "The placement overlaps road occupancy." };
    }
  }
  for (const object of architectureObjects(plan)) {
    if (object.id === excludeId || !placementPeerBlocks(object)) continue;
    if (ringsOverlap(site, object.sitePolygon)) return { valid: false, reason: `The placement overlaps ${object.kind} "${object.id}".` };
  }
  return { valid: true, reason: null };
}
export function objectPlacementPreview(
  config: ObjectPlacementConfig,
  centre: Vec2,
  city: unknown = getCity(),
  plan: unknown = getArchitecturePlanView()
): ObjectPlacementFramePreview {
  const frame = frameForConfig(config, centre);
  const result = placementValidity(config, frame, city, plan);
  return {
    kind: config.kind,
    frame,
    sitePolygon: frameRing(frame),
    valid: result.valid,
    reason: result.reason,
    color: result.valid ? OBJECT_PREVIEW_OK_COLOR : OBJECT_PREVIEW_ERROR_COLOR
  };
}

function sitePreview(site: Ring, kind: ObjectKind, city: unknown, plan: unknown, excludeId: string): ObjectPlacementFramePreview {
  const source = citySource(city);
  const terrain = record(source.terrain);
  let valid = validRing(site) && Math.abs(ringArea(site)) >= MIN_SITE_AREA_M2;
  let reason: string | null = valid ? null : "The site needs at least three non-collinear points.";
  if (valid && !pointInShape(site[0]!, terrain?.land)) {
    valid = false;
    reason = "The site must lie inside land.";
  }
  const urbanFootprint = terrain?.urbanFootprint;
  if (valid && urbanFootprint !== undefined) {
    for (const point of site) {
      if (!pointInShape(point, urbanFootprint)) {
        valid = false;
        reason = "The site must lie inside the urban footprint.";
        break;
      }
    }
  }
  if (valid) {
    for (const point of site) {
      if (!pointInShape(point, terrain?.land)) {
        valid = false;
        reason = "The site must lie inside land.";
        break;
      }
    }
  }
  const routeOccupancy = record(field(plan, "routeOccupancy"))?.all;
  if (valid && Array.isArray(routeOccupancy)) {
    for (const polygon of routeOccupancy) {
      if (Array.isArray(polygon) && validRing(polygon[0]) && ringsOverlap(site, polygon[0])) {
        valid = false;
        reason = "The site overlaps road occupancy.";
        break;
      }
    }
  }
  if (valid) {
    for (const object of architectureObjects(plan)) {
      if (object.id === excludeId || !placementPeerBlocks(object)) continue;
      if (ringsOverlap(site, object.sitePolygon)) {
        valid = false;
        reason = `The site overlaps ${object.kind} "${object.id}".`;
        break;
      }
    }
  }
  const centre = { x: 0, y: 0 };
  if (validRing(site) && site.length > 0) {
    for (const point of site) {
      centre.x += point.x;
      centre.y += point.y;
    }
    centre.x /= site.length;
    centre.y /= site.length;
  }
  const bounds = validRing(site) ? ringBounds(site) : { x: centre.x, y: centre.y, width: DEFAULT_WIDTH_M, height: DEFAULT_DEPTH_M };
  const frame: PlacementFrame = { centre, rotationRad: 0, widthM: Math.max(bounds.width, 1), depthM: Math.max(bounds.height, 1) };
  return { kind, frame, sitePolygon: site, valid, reason, color: valid ? OBJECT_PREVIEW_OK_COLOR : OBJECT_PREVIEW_ERROR_COLOR };
}

function shiftKey(event: unknown): boolean {
  const direct = field(event, "shiftKey");
  const data = field(event, "data");
  const interactionData = field(event, "interactionData");
  return direct === true || field(field(data, "originalEvent"), "shiftKey") === true || field(field(interactionData, "originalEvent"), "shiftKey") === true;
}

function eventOrigin(event: unknown): Vec2 | null {
  const origin = field(field(event, "interactionData"), "origin") ?? field(field(event, "data"), "origin");
  return finitePoint(origin) ? { x: origin.x, y: origin.y } : null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clearRememberedError(): void {
  if (objectError === null) return;
  objectError = null;
  clearEditorActionError();
  invalidateActiveHighlights();
}
function clearPlacementError(): void {
  if (objectError?.label === "object placement") clearRememberedError();
}

function rememberError(label: string, error: unknown, affectedIds: readonly string[]): void {
  const message = errorMessage(error);
  objectError = { label, message, affectedIds: [...affectedIds] };
  invalidateActiveHighlights();
  setEditorActionError(label, { message, affectedIds: [...affectedIds] });
}


function runMutation(label: string, work: Promise<unknown>, affectedIds: readonly string[], then?: () => void): void {
  const guarded = work.catch((error: unknown) => {
    rememberError(label, error, affectedIds);
    throw error;
  });
  const success = () => {
    clearRememberedError();
    then?.();
    activeLayer?.refresh?.();
    workspaceBridge?.rerender?.();
    notifyEditorInteraction();
  };
  if (workspaceBridge !== null) {
    workspaceBridge.run(label, guarded, success);
    return;
  }
  void guarded.then(success).catch((error: unknown) => {
    console.error(`${OBJECT_LAYER_NAME} | ${label} failed`, error);
    ui.notifications?.error(`Nixie: ${label} failed — ${errorMessage(error)}`);
  });
}

export function setObjectsWorkspaceBridge(next: ObjectsWorkspaceBridge | null): void {
  workspaceBridge = next;
}

export const setObjectLayerController = setObjectsWorkspaceBridge;

export function getObjectSelection(): ObjectSelection {
  return { ids: [...objectSelection.ids], kind: objectSelection.kind };
}

export function clearObjectSelection(): void {
  if (objectSelection.ids.length === 0 && objectSelection.kind === null) return;
  objectSelection = { ids: [], kind: null };
  invalidateActiveHighlights();
  activeLayer?.refresh?.();
  notifyEditorInteraction();
}

export interface ObjectInspector {
  id: string;
  kind: ObjectKind;
  derived: boolean;
  locked: boolean;
  plan: UnknownRecord;
}

export function objectInspector(ids: readonly string[] = objectSelection.ids): ObjectInspector | null {
  const plan = getArchitecturePlanView();
  const selected = architectureObjects(plan).filter((object) => ids.includes(object.id));
  if (selected.length !== 1) return null;
  const object = selected[0]!;
  return {
    id: object.id,
    kind: object.kind,
    derived: object.plan.sourceId === null || object.plan.sourceId === undefined,
    locked: object.plan.protection === "explicit",
    plan: object.plan
  };
}

export function getObjectError(): ObjectLayerError | null {
  return objectError === null ? null : { ...objectError, affectedIds: [...objectError.affectedIds] };
}

export function clearObjectError(): void {
  clearRememberedError();
  activeLayer?.refresh?.();
}

function selectObjectHit(hit: { id: string; kind: ObjectKind } | null, additive: boolean): void {
  const previous = objectSelection;
  if (hit === null) {
    if (!additive) clearObjectSelection();
    return;
  }
  if (!additive || objectSelection.kind !== hit.kind) {
    objectSelection = { ids: [hit.id], kind: hit.kind };
  } else {
    const ids = new Set(objectSelection.ids);
    if (ids.has(hit.id)) ids.delete(hit.id);
    else ids.add(hit.id);
    objectSelection = { ids: [...ids].sort(), kind: ids.size === 0 ? null : hit.kind };
  }
  if (previous.kind === objectSelection.kind
    && previous.ids.length === objectSelection.ids.length
    && previous.ids.every((id, index) => id === objectSelection.ids[index])) return;
  invalidateActiveHighlights();
  activeLayer?.refresh?.();
  notifyEditorInteraction();
}
export function architectureObjectAt(pointM: Vec2, plan: unknown = getArchitecturePlanView(), kind: ObjectKind | null = null): { id: string; kind: ObjectKind } | null {
  const objects = architectureObjects(plan);
  for (let index = objects.length - 1; index >= 0; index--) {
    const object = objects[index]!;
    if (kind !== null && object.kind !== kind) continue;
    const bounds = ringBounds(object.sitePolygon);
    if (!rectContains(bounds, pointM)) continue;
    if (pointInRing(pointM, object.sitePolygon)) return { id: object.id, kind: object.kind };
  }
  return null;
}

let cachedClass: LayerConstructor | null = null;

export function objectsLayerClass(): LayerConstructor {
  if (cachedClass !== null) return cachedClass;
  const Base = interactionLayerBase();
  if (typeof Base !== "function") throw new Error("InteractionLayer is unavailable — Foundry's canvas API moved.");
  const BaseClass = Base as LayerConstructor;

  cachedClass = class NixieObjectsLayer extends BaseClass {
    static get layerOptions(): Record<string, unknown> {
      const parent = BaseClass.layerOptions ?? {};
      return Object.assign({}, parent, { name: OBJECT_LAYER_NAME, zIndex: 920 });
    }

    #overlay: GraphicsLike | null = null;
    #highlights: GraphicsLike | null = null;
    #preview: GraphicsLike | null = null;
    #baseOverlayCache: BaseOverlayCacheKey | null = null;
    #highlightsCache: HighlightsCacheKey | null = null;
    #removeCityListener: (() => void) | null = null;
    #observedCityRevision: number | null = null;
    #panHookId: string | null = null;
    #config: ObjectPlacementConfig | null = null;
    #ghostCentreWorld: Vec2 | null = null;
    #siteDraft: { id: string; kind: ObjectKind; start: Vec2; current: Vec2 } | null = null;
    #finishing = false;

    invalidateHighlights(): void {
      this.#highlightsCache = null;
    }

    #invalidateCaches(): void {
      this.#baseOverlayCache = null;
      this.#highlightsCache = null;
    }

    async _draw(options: unknown): Promise<void> {
      await super._draw(options);
      const overlay: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const highlights: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const preview: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      if (overlay === null || highlights === null || preview === null) return;
      overlay.eventMode = "none";
      highlights.eventMode = "none";
      preview.eventMode = "none";
      this.#overlay = overlay;
      this.#highlights = highlights;
      this.#preview = preview;
      activeLayer = this;
      this.#removeCityListener ??= addCityListener(() => {
        const revision = cityRevision(getCity());
        if (revision !== this.#observedCityRevision) clearRememberedError();
        this.#observedCityRevision = revision;
        this.refresh();
      });
      this.#observedCityRevision = cityRevision(getCity());
      this.#invalidateCaches();
      this.refresh();
    }

    async _tearDown(options: unknown): Promise<void> {
      this.#invalidateCaches();
      if (activeLayer === this) activeLayer = null;
      editorLayerDeactivated(OBJECT_LAYER_NAME);
      this.#unwatchPan();
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      this.#observedCityRevision = null;
      this.#overlay?.clear();
      this.#highlights?.clear();
      this.#preview?.clear();
      this.#overlay = null;
      this.#highlights = null;
      this.#preview = null;
      this.#clearInteractionState();
      return super._tearDown(options);
    }

    _activate(): void {
      this.#invalidateCaches();
      activeLayer = this;
      editorLayerActivated(OBJECT_LAYER_NAME);
      this.#removeCityListener ??= addCityListener(() => {
        const revision = cityRevision(getCity());
        if (revision !== this.#observedCityRevision) clearRememberedError();
        this.#observedCityRevision = revision;
        this.refresh();
      });
      this.#observedCityRevision = cityRevision(getCity());
      this.#panHookId ??= Hooks.on("canvasPan", () => this.#syncDragResistance());
      this.visible = true;
      this.refresh();
    }

    _deactivate(): void {
      this.#invalidateCaches();
      editorLayerDeactivated(OBJECT_LAYER_NAME);
      this.#unwatchPan();
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      this.#observedCityRevision = null;
      this.#clearInteractionState();
      this.#overlay?.clear();
      this.#highlights?.clear();
      this.#preview?.clear();
      this.visible = false;
    }


    #clearInteractionState(): void {
      const hadConfig = this.#config !== null;
      const hadGhost = this.#ghostCentreWorld !== null;
      const hadSiteDraft = this.#siteDraft !== null;
      const hadSelection = objectSelection.kind !== null || objectSelection.ids.length > 0;
      const hadError = objectError !== null;
      if (!hadConfig && !hadGhost && !hadSiteDraft && !hadSelection && !this.#finishing && !hadError) return;
      if (hadError) clearRememberedError();
      this.#config = null;
      this.#ghostCentreWorld = null;
      this.#siteDraft = null;
      this.#finishing = false;
      objectSelection = { ids: [], kind: null };
      if (hadSelection) this.invalidateHighlights();
      notifyEditorInteraction();
    }

    #unwatchPan(): void {
      if (this.#panHookId !== null) {
        Hooks.off("canvasPan", this.#panHookId);
        this.#panHookId = null;
      }
      this.#syncDragResistance();
    }

    #syncDragResistance(): void {
      const manager = canvas?.mouseInteractionManager;
      if (manager === undefined || manager === null) return;
      const options: Record<string, unknown> = manager.options ?? (manager.options = {});
      if (!this.active) {
        delete options.dragResistance;
        return;
      }
      const size = canvas?.dimensions?.size;
      const zoom = canvas?.stage?.scale?.x;
      if (typeof size === "number" && size > 0) options.dragResistance = typeof zoom === "number" && zoom > 0 ? size / (4 * zoom) : size / 4;
    }

    configureObjectPlacement(config: ObjectPlacementConfig | null): void {
      const unchanged = samePlacementConfig(this.#config, config);
      if (!unchanged) clearPlacementError();
      if (unchanged) return;
      this.#config = config === null ? null : { ...config };
      this.#siteDraft = null;
      this.#ghostCentreWorld = null;
      this.#refreshPreview();
      notifyEditorInteraction();
    }

    hasDraft(): boolean {
      return this.#ghostCentreWorld !== null || this.#siteDraft !== null;
    }

    cancelDraft(clearConfig = true, notify = true): void {
      const hadGhost = this.#ghostCentreWorld !== null;
      const hadSiteDraft = this.#siteDraft !== null;
      const hadConfig = clearConfig && this.#config !== null;
      clearPlacementError();
      if (!hadGhost && !hadSiteDraft && !hadConfig) return;
      this.#ghostCentreWorld = null;
      this.#siteDraft = null;
      if (clearConfig) this.#config = null;
      // The shell's single refresh redraws the object rings. Clearing the
      // preview directly avoids a synchronous full-plan redraw during cancel.
      this.#preview?.clear();
      if (notify) notifyEditorInteraction();
    }

    async finishDraft(): Promise<boolean> {
      if (this.#finishing) return false;
      if (this.#siteDraft !== null) return this.#finishSiteDraft();
      if (this.#config?.kind === "building" || this.#config?.kind === "place") {
        if (this.#ghostCentreWorld === null) return false;
        return this.#placeAt(this.#ghostCentreWorld);
      }
      return false;
    }

    #pointer(event: unknown): Vec2 {
      const getLocalPosition = field(event, "getLocalPosition");
      const point = typeof getLocalPosition === "function" ? getLocalPosition.call(event, canvas.stage) : null;
      if (finitePoint(point)) return { x: point.x, y: point.y };
      const fallback = eventOrigin(event);
      return fallback ?? { x: 0, y: 0 };
    }
    #setGhost(event: unknown): Vec2 {
      const point = this.#pointer(event);
      this.#ghostCentreWorld = point;
      const config = this.#config;
      if (config !== null) {
        const preview = objectPlacementPreview(config, worldToMetres(point), getCity(), getArchitecturePlanView());
        if (preview.valid) clearPlacementError();
      }
      this.#refreshPreview();
      return point;
    }

    #finishSiteDraft(): Promise<boolean> {
      const draft = this.#siteDraft;
      if (draft === null || this.#finishing) return Promise.resolve(false);
      const start = worldToMetres(draft.start);
      const current = worldToMetres(draft.current);
      const site: Ring = [
        { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y) },
        { x: Math.max(start.x, current.x), y: Math.min(start.y, current.y) },
        { x: Math.max(start.x, current.x), y: Math.max(start.y, current.y) },
        { x: Math.min(start.x, current.x), y: Math.max(start.y, current.y) }
      ];
      const preview = sitePreview(site, draft.kind, getCity(), getArchitecturePlanView(), draft.id);
      if (!preview.valid) {
        rememberError("site edit", new Error(preview.reason ?? "Invalid site."), [draft.id]);
        this.#refreshPreview();
        return Promise.resolve(false);
      }
      this.#finishing = true;
      this.#siteDraft = null;
      const operation = editSitePolygon(draft.id, site);
      runMutation("site edit", operation, [draft.id], () => {
        this.#finishing = false;
        this.#ghostCentreWorld = null;
        this.refresh();
      });
      // `ctx.run` owns the completion/error delivery; this return value is the
      // accepted gesture rather than the eventual adapter result.
      return Promise.resolve(true);
    }

    #placeAt(world: Vec2): Promise<boolean> {
      const config = this.#config;
      if (config === null || this.#finishing) return Promise.resolve(false);
      const centre = worldToMetres(world);
      const preview = objectPlacementPreview(config, centre, getCity(), getArchitecturePlanView());
      this.#ghostCentreWorld = world;
      if (!preview.valid) {
        rememberError("object placement", new Error(preview.reason ?? "Invalid placement."), []);
        this.#refreshPreview();
        return Promise.resolve(false);
      }
      clearPlacementError();
      this.#finishing = true;
      const operation = config.kind === "building"
        ? placeBuilding({
            grammarId: config.grammarId!,
            visualUse: config.visualUse!,
            heightM: config.heightM!,
            paletteId: config.paletteId ?? null,
            placement: preview.frame,
            sitePolygon: preview.sitePolygon
          } satisfies BuildingPlacementInput)
        : placePlace({
            landmarkGrammarId: config.landmarkGrammarId!,
            paletteId: config.paletteId ?? null,
            placement: preview.frame,
            sitePolygon: preview.sitePolygon
          } satisfies PlacePlacementInput);
      runMutation("object placement", operation, [], () => {
        this.#finishing = false;
        // Keep the catalogue selection and ghost for repeated placement.
        this.refresh();
      });
      return Promise.resolve(true);
    }
    _onMouseMove(event: unknown): void {
      if (canvasTool() === OBJECT_TOOL.PLACE && this.#config !== null) this.#setGhost(event);
      if (canvasTool() === OBJECT_TOOL.SITE && this.#siteDraft !== null) {
        this.#siteDraft.current = this.#pointer(event);
        this.#refreshPreview();
      }
    }
    _onMove(event: unknown): void {
      this._onMouseMove(event);
    }
    _onDragLeftStart(event: unknown): void {
      if (!isSceneEnabled() || getCity() === null || canvasTool() !== OBJECT_TOOL.SITE) return;
      const pointWorld = eventOrigin(event) ?? this.#pointer(event);
      const hit = architectureObjectAt(worldToMetres(pointWorld));
      if (hit === null) return;
      selectObjectHit(hit, shiftKey(event));
      this.#siteDraft = { id: hit.id, kind: hit.kind, start: pointWorld, current: pointWorld };
      this.#refreshPreview();
    }
    _onDragLeftMove(event: unknown): void {
      if (canvasTool() === OBJECT_TOOL.PLACE && this.#config !== null) {
        this.#setGhost(event);
        return;
      }
      if (this.#siteDraft !== null) {
        this.#siteDraft.current = this.#pointer(event);
        this.#refreshPreview();
      }
    }
    _onDragLeftDrop(event: unknown): void {
      if (this.#siteDraft === null) return;
      this.#siteDraft.current = this.#pointer(event);
      void this.#finishSiteDraft();
    }

    _onDragLeftCancel(): void {
      this.#siteDraft = null;
      this.#refreshPreview();
    }
    _onClickLeft(event: unknown): void {
      if (!isSceneEnabled() || getCity() === null) return;
      const tool = canvasTool();
      if (tool === OBJECT_TOOL.PLACE && this.#config !== null) {
        const pointWorld = this.#setGhost(event);
        void this.#placeAt(pointWorld);
        return;
      }
      if (tool === OBJECT_TOOL.SELECT || tool === OBJECT_TOOL.SITE) {
        const pointWorld = this.#pointer(event);
        selectObjectHit(architectureObjectAt(worldToMetres(pointWorld)), shiftKey(event));
      }
    }
    #cancelToSelect(): void {
      // Transition first so the shell owns one synchronous cancellation path.
      // The direct cancel is a no-controller fallback for canvas/unit callers.
      setCanvasTool(OBJECT_TOOL.SELECT);
      this.cancelDraft(true, false);
    }
    _onClickRight(event: unknown): void {
      const tool = canvasTool();
      if (tool === OBJECT_TOOL.PLACE || tool === OBJECT_TOOL.SITE) {
        this.#cancelToSelect();
        return;
      }
      if (tool === OBJECT_TOOL.SELECT && isSceneEnabled() && getCity() !== null) {
        selectObjectHit(architectureObjectAt(worldToMetres(this.#pointer(event))), shiftKey(event));
      }
    }

    _onDragRightCancel(): void {
      const tool = canvasTool();
      if (tool === OBJECT_TOOL.PLACE || tool === OBJECT_TOOL.SITE) {
        this.#cancelToSelect();
        return;
      }
      this.cancelDraft(true);
    }
    #drawRing(g: GraphicsLike, ring: Ring, color: number, fillAlpha: number, lineWidth: number, lineAlpha: number): void {
      if (!validRing(ring)) return;
      const first = metresToWorld(ring[0]!);
      g.beginFill(color, fillAlpha);
      g.moveTo(first.x, first.y);
      for (const point of ring.slice(1)) {
        const world = metresToWorld(point);
        g.lineTo(world.x, world.y);
      }
      g.lineTo(first.x, first.y);
      g.endFill();
      g.lineStyle({ width: lineWidth, color, alpha: lineAlpha });
      g.moveTo(first.x, first.y);
      for (const point of ring.slice(1)) {
        const world = metresToWorld(point);
        g.lineTo(world.x, world.y);
      }
      g.lineTo(first.x, first.y);
    }

    refresh(): void {
      const overlay = this.#overlay;
      const highlights = this.#highlights;
      if (!overlay || !highlights) return;
      const city = getCity();
      if (!this.active || !isSceneEnabled() || city === null) {
        overlay.clear();
        highlights.clear();
        this.#preview?.clear();
        this.#invalidateCaches();
        return;
      }
      const plan = getArchitecturePlanView();
      const selection = selectionStateKey(objectSelection);
      const error = errorStateKey(objectError);
      const lineWidth = Math.max(2, (canvas?.dimensions?.size ?? 100) * 0.05);
      const cachedBase = this.#baseOverlayCache;
      const redrawBase = cachedBase === null
        || cachedBase.plan !== plan
        || cachedBase.lineWidth !== lineWidth;
      const cachedHighlights = this.#highlightsCache;
      const redrawHighlights = cachedHighlights === null
        || cachedHighlights.plan !== plan
        || cachedHighlights.selection !== selection
        || cachedHighlights.error !== error
        || cachedHighlights.lineWidth !== lineWidth;
      let objects: ArchitectureEntry[] | null = null;
      if (redrawBase) {
        objects = architectureObjects(plan);
        overlay.clear();
        for (const object of objects) {
          const color = object.kind === "building" ? COLOR_SITE_BUILDING : COLOR_SITE_PLACE;
          this.#drawRing(overlay, object.sitePolygon, color, 0.09, lineWidth, 0.85);
        }
        this.#baseOverlayCache = { plan, lineWidth };
      }
      if (redrawHighlights) {
        highlights.clear();
        const selected = new Set(objectSelection.ids);
        const errors = new Set(objectError?.affectedIds ?? []);
        if (selected.size > 0 || errors.size > 0) {
          objects ??= architectureObjects(plan);
          for (const object of objects) {
            const isSelected = selected.has(object.id);
            const isError = errors.has(object.id);
            if (!isSelected && !isError) continue;
            this.#drawRing(
              highlights,
              object.sitePolygon,
              isError ? COLOR_ERROR : COLOR_SELECTED,
              isError ? 0.26 : 0.24,
              lineWidth * 1.8,
              0.85
            );
            this.#drawMarker(highlights, object.sitePolygon, isError ? COLOR_ERROR : COLOR_HANDLE);
          }
        }
        this.#highlightsCache = { plan, selection, error, lineWidth };
      }
      this.#refreshPreview();
    }
    #drawMarker(g: GraphicsLike, ring: Ring, color: number): void {
      const bounds = ringBounds(ring);
      const centre = metresToWorld({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      const radius = Math.max(3, (canvas?.dimensions?.size ?? 100) * 0.11);
      g.lineStyle({ width: Math.max(2, radius * 0.35), color, alpha: 0.95 });
      g.moveTo(centre.x - radius, centre.y - radius);
      g.lineTo(centre.x + radius, centre.y + radius);
      g.moveTo(centre.x + radius, centre.y - radius);
      g.lineTo(centre.x - radius, centre.y + radius);
    }

    #refreshPreview(): void {
      const previewGraphic = this.#preview;
      if (!previewGraphic || !this.active || !isSceneEnabled() || getCity() === null) return;
      previewGraphic.clear();
      if (this.#config !== null && this.#ghostCentreWorld !== null && canvasTool() === OBJECT_TOOL.PLACE) {
        const centre = worldToMetres(this.#ghostCentreWorld);
        const preview = objectPlacementPreview(this.#config, centre, getCity(), getArchitecturePlanView());
        this.#drawRing(previewGraphic, preview.sitePolygon, preview.color, preview.valid ? 0.28 : 0.34, Math.max(2, (canvas?.dimensions?.size ?? 100) * 0.07), 0.98);
        if (!preview.valid) this.#drawMarker(previewGraphic, preview.sitePolygon, COLOR_ERROR);
      }
      const draft = this.#siteDraft;
      if (draft !== null && canvasTool() === OBJECT_TOOL.SITE) {
        const start = worldToMetres(draft.start);
        const current = worldToMetres(draft.current);
        const site: Ring = [
          { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y) },
          { x: Math.max(start.x, current.x), y: Math.min(start.y, current.y) },
          { x: Math.max(start.x, current.x), y: Math.max(start.y, current.y) },
          { x: Math.min(start.x, current.x), y: Math.max(start.y, current.y) }
        ];
        const preview = sitePreview(site, draft.kind, getCity(), getArchitecturePlanView(), draft.id);
        this.#drawRing(previewGraphic, site, preview.color, preview.valid ? 0.28 : 0.34, Math.max(2, (canvas?.dimensions?.size ?? 100) * 0.07), 0.98);
        if (!preview.valid) this.#drawMarker(previewGraphic, site, COLOR_ERROR);
      }
    }
  };
  return cachedClass;
}

export function configureObjectPlacement(config: ObjectPlacementConfig | null): void {
  activeLayer?.configureObjectPlacement?.(config);
}

export function finishObjectPlacement(): Promise<boolean> {
  const layer = activeLayer as { finishDraft?: () => Promise<boolean> } | null;
  return layer?.finishDraft?.() ?? Promise.resolve(false);
}

export function cancelObjectPlacement(notify = true): void {
  activeLayer?.cancelDraft?.(true, notify);
}

export function hasObjectDraft(): boolean {
  return activeLayer?.hasDraft?.() === true;
}

export function transformObjectSelection(placement: PlacementFrame): boolean {
  if (objectSelection.ids.length !== 1) return false;
  const id = objectSelection.ids[0]!;
  runMutation("object transform", transformObject(id, { placement }), [id]);
  return true;
}
