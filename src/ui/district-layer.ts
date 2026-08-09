import {
  addCityListener,
  clearDistrictSelection,
  createDistrict as adapterCreateDistrict,
  fillDistrict as adapterFillDistrict,
  getCity,
  getDistrictPlanView,
  getDistrictSelection,
  isSceneEnabled,
  metresToWorld,
  moveDistrictVertex as adapterMoveDistrictVertex,
  selectDistrict as adapterSelectDistrict,
  setDistrictDraftCancelListener,
  setDistrictsPresentation,
  splitDistrict as adapterSplitDistrict,
  worldToMetres
} from "../adapter/canvas.js";
import type { Ring, Vec2 } from "../core/geom/types.js";
import { difference, intersection, ringAsMulti, union } from "../core/geom/boolean.js";
import { ringArea, ringBounds, ringCentroid, type MultiPolygon } from "../core/geom/types.js";
import { validateRing } from "../core/gen/terrain.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { DistrictSource } from "../core/gen/city.js";
import { districtSplitCandidate } from "../core/gen/district-edit.js";
import { canvasTool, clearEditorActionError, currentDistrictPalette, currentDistrictType, DISTRICT_TOOL, districtSnapOptions, editorLayerActivated, editorLayerDeactivated, LAYER_DISTRICTS, notifyEditorInteraction, setEditorActionError } from "./editor-state.js";
import { DistrictOverlayLineMesh, DistrictOverlayLineMeshBuilder } from "./district-overlay-mesh.js";

export const DISTRICT_LAYER_NAME = LAYER_DISTRICTS;
const DISTRICT_OVERLAY_SEGMENTS_PER_FRAME = 2_048;
const DISTRICT_OVERLAY_CPU_BUDGET_MS = 6;
const OPEN_SPACE_COLORS: Record<string, number> = {
  park: 0x64d98a,
  plaza: 0xf1c76d,
  parking: 0x7ca6de,
  vacant: 0xa9a0c3,
  utility: 0xd48f6c,
  landscaping: 0x83cfa8,
  "service-yard": 0xc29072
};

interface DistrictPlanningTask {
  epoch: number;
  plan: any;
  revision: number | null;
  scale: number | null;
  phase: "blocks" | "cells" | "unzoned" | "intents" | "done";
  index: number;
  fragmentByKey: Map<string, any>;
  hatchQueue: Ring[][];
  hatchIterator: Generator<DistrictHatchSegment> | null;
  hatchColor: number;
  hatchSpacing: number;
  hatchWidth: number;
}

function interactionLayerBase(): any {
  const namespaced = foundry?.canvas?.layers?.InteractionLayer;
  if (namespaced) return namespaced;
  return typeof InteractionLayer === "undefined" ? null : InteractionLayer;
}

function screenPx(size: number): number {
  const zoom = canvas?.stage?.scale?.x;
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? size / zoom : size;
}

function invoke(fn: unknown, ...args: unknown[]): Promise<any> {
  if (typeof fn !== "function") return Promise.reject(new Error("District adapter operation is unavailable."));
  try { return Promise.resolve((fn as (...values: unknown[]) => unknown)(...args)); }
  catch (error) { return Promise.reject(error); }
}

function ring(value: unknown): value is Ring {
  return Array.isArray(value) && value.length >= 3 && value.every((point) => point !== null && typeof point === "object" && Number.isFinite((point as any).x) && Number.isFinite((point as any).y));
}

function pointInRing(point: Vec2, points: Ring): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    const crosses = (a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function cityDistricts(): any[] {
  const city = getCity() as any;
  return cityDistrictsFrom(city);
}

function polygons(value: unknown): Ring[][] {
  if (ring(value)) return [[value]];
  if (!Array.isArray(value)) return [];
  if (value.length > 0 && value.every((entry) => ring(entry))) return [value as Ring[]];
  return value.flatMap((entry) => polygons(entry));
}

export const DISTRICT_PREVIEW_OK_COLOR = 0x74ffa8;
export const DISTRICT_PREVIEW_ERROR_COLOR = 0xff6b75;
export const DISTRICT_SNAP_TARGET_COLOR = 0xffc94a;

export interface DistrictProvisionalResult {
  id: string;
  polygon: Ring[];
}

export interface DistrictProvisionalPreview {
  result: DistrictProvisionalResult[];
  polygons: Ring[][];
  valid: boolean;
  locked: boolean;
  reason: string | null;
  color: number;
}

function previewResult(result: DistrictProvisionalResult[], valid: boolean, locked: boolean, reason: string | null): DistrictProvisionalPreview {
  return {
    result,
    polygons: result.map((entry) => entry.polygon),
    valid,
    locked,
    reason,
    color: !valid || locked ? DISTRICT_PREVIEW_ERROR_COLOR : DISTRICT_PREVIEW_OK_COLOR
  };
}

function districtForPreview(value: any, polygon = value?.polygon): DistrictSource {
  return {
    id: String(value?.id ?? "district-preview"),
    polygon: polygon as Ring,
    seed: String(value?.seed ?? "district-preview"),
    typeId: (DISTRICT_TYPE_IDS as readonly string[]).includes(value?.typeId) ? value.typeId : DISTRICT_TYPE_IDS[0]!,
    paletteId: (DISTRICT_PALETTE_IDS as readonly string[]).includes(value?.paletteId) ? value.paletteId : DISTRICT_PALETTE_IDS[0]!,
    origin: value?.origin === "generated" ? "generated" : "authored",
    locked: value?.locked === true,
    openSpaceOverride: value?.openSpaceOverride ?? null
  };
}

function multiPolygonArea(value: MultiPolygon): number {
  return value.reduce((total, polygon) => polygon.reduce((area, source, index) => area + (index === 0 ? 1 : -1) * Math.abs(ringArea(source)), 0) + total, 0);
}

function supportedSinglePolygon(value: MultiPolygon): boolean {
  return value.length === 1 && value[0]?.length === 1 && Math.abs(ringArea(value[0]![0]!)) >= 1;
}

export function districtDrawPreview(districts: readonly any[], polygon: Ring, incoming: Partial<DistrictSource> = {}): DistrictProvisionalPreview {
  const result: DistrictProvisionalResult[] = districts
    .filter((district) => typeof district?.id === "string" && ring(district.polygon))
    .map((district) => ({ id: district.id as string, polygon: [district.polygon as Ring] }));
  let valid = ring(polygon) && validateRing(polygon).ok && Math.abs(ringArea(polygon)) >= 1;
  let locked = false;
  let reason: string | null = valid ? null : "Drawn district geometry is invalid.";
  if (valid) {
    for (const district of districts) {
      if (typeof district?.id !== "string" || !ring(district.polygon)) continue;
      let overlap: MultiPolygon;
      try { overlap = intersection(ringAsMulti(district.polygon as Ring), ringAsMulti(polygon)); }
      catch { valid = false; reason = "Drawn district geometry could not be evaluated."; break; }
      if (multiPolygonArea(overlap) <= 1e-5) continue;
      if (district.locked === true) {
        valid = false;
        locked = true;
        reason = `Locked district "${district.id}" blocks overlap subtraction.`;
        continue;
      }
      try {
        const remainder = difference(ringAsMulti(district.polygon as Ring), [ringAsMulti(polygon)]);
        const current = result.find((entry) => entry.id === district.id);
        if (current) current.polygon = remainder[0] ?? [];
        if (!supportedSinglePolygon(remainder)) {
          valid = false;
          reason = "Overlap subtraction must leave one connected, hole-free district above the supported area floor.";
        }
      } catch {
        valid = false;
        reason = "Overlap subtraction could not be evaluated.";
      }
    }
  }
  result.push({ id: String(incoming.id ?? "__district-draft__"), polygon: [polygon] });
  return previewResult(result, valid, locked, reason);
}

export function districtSplitPreview(district: any, points: readonly Vec2[], selectionCount = 1): DistrictProvisionalPreview {
  const source = districtForPreview(district);
  if (selectionCount !== 1) return previewResult([{ id: source.id, polygon: [source.polygon] }], false, false, "Split requires exactly one selected district.");
  if (source.locked) return previewResult([{ id: source.id, polygon: [source.polygon] }], false, true, `Locked district "${source.id}" cannot be split.`);
  if (points.length !== 2) return previewResult([{ id: source.id, polygon: [source.polygon] }], false, false, "Split requires exactly two points.");
  try {
    const output = districtSplitCandidate({ districts: [source] } as any, source.id, points[0]!, points[1]!, "__district-split-preview__");
    const result = output.filter((entry) => entry.id === source.id || entry.id === "__district-split-preview__").map((entry) => ({ id: entry.id, polygon: [entry.polygon] }));
    return previewResult(result, result.length === 2, false, result.length === 2 ? null : "Split must produce exactly two connected districts.");
  } catch (error) {
    return previewResult([{ id: source.id, polygon: [source.polygon] }], false, false, error instanceof Error ? error.message : String(error));
  }
}

export function districtMergePreview(districts: readonly any[], ids: readonly string[], survivorId = ids[0]): DistrictProvisionalPreview {
  const selected = [...new Set(ids)].map((id) => districts.find((district) => district?.id === id)).filter((district): district is any => district !== undefined && ring(district.polygon));
  if (selected.length < 2 || selected.length !== new Set(ids).size || survivorId === undefined || !ids.includes(survivorId)) {
    return previewResult(selected.map((district) => ({ id: district.id, polygon: [district.polygon as Ring] })), false, false, "Merge requires at least two selected districts and an included survivor.");
  }
  try {
    const merged = union(selected.map((district) => ringAsMulti(district.polygon as Ring)));
    const valid = supportedSinglePolygon(merged);
    const locked = selected.some((district) => district.locked === true);
    return previewResult(merged.map((polygon) => ({ id: survivorId, polygon })), valid && !locked, locked, locked ? "Locked districts cannot be merged." : valid ? null : "Merge must leave one connected, hole-free district above the supported area floor.");
  } catch (error) {
    return previewResult([], false, false, error instanceof Error ? error.message : String(error));
  }
}

export interface DistrictOverlayData {
  boundaries: Array<{ id: string; polygon: Ring }>;
  fills: Array<{ id: string; polygon: Ring[] }>;
}

export interface DistrictOrientationCue {
  start: Vec2;
  end: Vec2;
}

export function districtCellOrientationCue(cell: { polygon?: unknown; rotationRad?: unknown }): DistrictOrientationCue | null {
  if (!ring(cell.polygon)) return null;
  const bounds = ringBounds(cell.polygon);
  const extent = Math.min(bounds.width, bounds.height);
  if (!Number.isFinite(extent) || extent <= 0) return null;
  const centre = ringCentroid(cell.polygon);
  const angle = typeof cell.rotationRad === "number" && Number.isFinite(cell.rotationRad) ? cell.rotationRad : 0;
  const halfLength = Math.min(extent * 0.45, Math.max(0.1, extent * 0.2));
  const dx = Math.cos(angle) * halfLength;
  const dy = Math.sin(angle) * halfLength;
  return {
    start: { x: centre.x - dx, y: centre.y - dy },
    end: { x: centre.x + dx, y: centre.y + dy }
  };
}

export function districtOverlayData(city: any, plan: any): DistrictOverlayData {
  const boundaries = cityDistrictsFrom(city)
    .filter((district) => typeof district?.id === "string" && ring(district.polygon))
    .map((district) => ({ id: district.id as string, polygon: district.polygon as Ring }));
  const fills: Array<{ id: string; polygon: Ring[] }> = [];
  for (const block of plan?.blocks ?? []) for (const fragment of block?.districtFragments ?? []) {
    if (typeof fragment?.districtId !== "string") continue;
    for (const polygon of polygons(fragment.buildable)) fills.push({ id: fragment.districtId, polygon });
  }
  return { boundaries, fills };
}

function cityDistrictsFrom(city: any): any[] {
  return Array.isArray(city?.source?.districts) ? city.source.districts : [];
}

function selectedIds(): string[] {
  const value = getDistrictSelection() as any;
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string");
  const ids = Array.isArray(value?.districtIds) ? value.districtIds : value?.ids;
  return Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string") : [];
}

function colourFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  const r = 75 + ((hash >>> 16) & 0x5f);
  const g = 95 + ((hash >>> 8) & 0x6f);
  const b = 120 + (hash & 0x5f);
  return (r << 16) | (g << 8) | b;
}

function drawRing(g: any, source: Ring, fill: number, alpha: number, line: number, width: number): void {
  const first = metresToWorld(source[0]!);
  if (alpha > 0) {
    g.lineStyle(0);
    g.beginFill(fill, alpha);
    g.moveTo(first.x, first.y);
    for (const point of source.slice(1)) {
      const at = metresToWorld(point);
      g.lineTo(at.x, at.y);
    }
    g.lineTo(first.x, first.y);
    g.endFill();
  }
  g.lineStyle({ width, color: line, alpha: 0.95 });
  g.moveTo(first.x, first.y);
  for (const point of source.slice(1)) {
    const at = metresToWorld(point);
    g.lineTo(at.x, at.y);
  }
  g.lineTo(first.x, first.y);
}

function drawPolygonWithHoles(g: any, polygon: Ring[], fill: number, alpha: number, line: number, width: number): void {
  const outer = polygon[0];
  if (!outer) return;
  if (alpha > 0) {
    const first = metresToWorld(outer[0]!);
    g.lineStyle(0);
    g.beginFill(fill, alpha);
    g.moveTo(first.x, first.y);
    for (const point of outer.slice(1)) { const at = metresToWorld(point); g.lineTo(at.x, at.y); }
    g.lineTo(first.x, first.y);
    for (const hole of polygon.slice(1)) {
      if (typeof g.beginHole !== "function") break;
      const holeFirst = metresToWorld(hole[0]!);
      g.beginHole();
      g.moveTo(holeFirst.x, holeFirst.y);
      for (const point of hole.slice(1)) { const at = metresToWorld(point); g.lineTo(at.x, at.y); }
      g.lineTo(holeFirst.x, holeFirst.y);
      g.endHole();
    }
    g.endFill();
  }
  g.lineStyle({ width, color: line, alpha: 0.95 });
  for (const ringSource of polygon) {
    const ringFirst = metresToWorld(ringSource[0]!);
    g.moveTo(ringFirst.x, ringFirst.y);
    for (const point of ringSource.slice(1)) { const at = metresToWorld(point); g.lineTo(at.x, at.y); }
    g.lineTo(ringFirst.x, ringFirst.y);
  }
}

function fillPolygonWithHoles(g: any, polygon: Ring[], fill: number, alpha: number): void {
  const outer = polygon[0];
  if (!outer || alpha <= 0) return;
  const first = metresToWorld(outer[0]!);
  g.lineStyle(0);
  g.beginFill(fill, alpha);
  g.moveTo(first.x, first.y);
  for (const point of outer.slice(1)) { const at = metresToWorld(point); g.lineTo(at.x, at.y); }
  g.lineTo(first.x, first.y);
  for (const hole of polygon.slice(1)) {
    if (typeof g.beginHole !== "function") break;
    const holeFirst = metresToWorld(hole[0]!);
    g.beginHole();
    g.moveTo(holeFirst.x, holeFirst.y);
    for (const point of hole.slice(1)) { const at = metresToWorld(point); g.lineTo(at.x, at.y); }
    g.lineTo(holeFirst.x, holeFirst.y);
    g.endHole();
  }
  g.endFill();
}

function drawPlanRings(g: any, value: unknown, color: number, alpha: number, width: number): void {
  if (ring(value)) {
    drawRing(g, value, color, alpha, color, width);
    return;
  }
  if (!Array.isArray(value)) return;
  if (value.length > 0 && value.every((item) => ring(item))) {
    drawPolygonWithHoles(g, value as Ring[], color, alpha, color, width);
    return;
  }
  for (const item of value) drawPlanRings(g, item, color, alpha, width);
}

function fillPlanRings(g: any, value: unknown, color: number, alpha: number): void {
  if (ring(value)) {
    fillPolygonWithHoles(g, [value], color, alpha);
    return;
  }
  if (!Array.isArray(value)) return;
  if (value.length > 0 && value.every((item) => ring(item))) {
    fillPolygonWithHoles(g, value as Ring[], color, alpha);
    return;
  }
  for (const item of value) fillPlanRings(g, item, color, alpha);
}

function addRingLines(builder: DistrictOverlayLineMeshBuilder, source: Ring, color: number, alpha: number, width: number): void {
  let previous = metresToWorld(source[source.length - 1]!);
  for (const point of source) {
    const current = metresToWorld(point);
    builder.add(previous, current, width, color, alpha);
    previous = current;
  }
}

function addPlanRingLines(builder: DistrictOverlayLineMeshBuilder, value: unknown, color: number, alpha: number, width: number): void {
  if (ring(value)) {
    addRingLines(builder, value, color, alpha, width);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) addPlanRingLines(builder, item, color, alpha, width);
}

export interface DistrictHatchSegment {
  start: Vec2;
  end: Vec2;
}

export function* districtHatchSegmentIterator(source: readonly Ring[], spacing: number): Generator<DistrictHatchSegment> {
  if (!Number.isFinite(spacing) || spacing <= 0) return;
  const rings = source.filter((candidate) => candidate.length >= 3 && candidate.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  if (rings.length === 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const points of rings) for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const firstOffset = minX - maxY;
  const lastOffset = maxX - minY;
  const stripeCount = Math.floor((lastOffset - firstOffset) / spacing) + 1;
  if (!Number.isSafeInteger(stripeCount) || stripeCount <= 0) return;
  for (let stripe = 0; stripe < stripeCount; stripe++) {
    const offset = firstOffset + stripe * spacing;
    const crossings: number[] = [];
    for (const points of rings) for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const da = a.x - a.y - offset;
      const db = b.x - b.y - offset;
      // WHY: Half-open crossings count a shared vertex once so even-odd pairing remains stable.
      if (!((da <= 0 && db > 0) || (db <= 0 && da > 0))) continue;
      const t = da / (da - db);
      crossings.push(a.y + (b.y - a.y) * t);
    }
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const startY = crossings[index]!;
      const endY = crossings[index + 1]!;
      if (endY - startY <= 1e-6) continue;
      yield { start: { x: offset + startY, y: startY }, end: { x: offset + endY, y: endY } };
    }
  }
}

export function districtHatchSegments(source: readonly Ring[], spacing: number): DistrictHatchSegment[] {
  return [...districtHatchSegmentIterator(source, spacing)];
}

export function districtSnapTarget(point: Vec2, candidates: readonly Vec2[], reach: number): Vec2 | null {
  let nearest: Vec2 | null = null;
  let distance = reach * reach;
  for (const candidate of candidates) {
    const dx = candidate.x - point.x;
    const dy = candidate.y - point.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= distance) { distance = d2; nearest = candidate; }
  }
  return nearest;
}

function snapWorldPointInfo(point: Vec2, plan: any, excludeDistrictVertex?: { districtId: string; index: number }): { point: Vec2; target: Vec2 | null } {
  const options = districtSnapOptions();
  const candidates: Vec2[] = [];
  const city = getCity() as any;
  if (options.districtVertices) for (const district of cityDistricts()) if (ring(district.polygon)) for (const [index, vertex] of district.polygon.entries()) {
    if (excludeDistrictVertex !== undefined && excludeDistrictVertex.districtId === district.id && excludeDistrictVertex.index === index) continue;
    candidates.push(metresToWorld(vertex));
  }
  if (options.roadJunctions) for (const node of city?.source?.roads?.nodes ?? []) if (Number.isFinite(node.x) && Number.isFinite(node.y)) candidates.push(metresToWorld(node));
  if (options.blockBoundaries) {
    for (const block of plan?.blocks ?? []) if (ring(block?.zoningFace)) {
      for (let index = 0; index < block.zoningFace.length; index++) {
        const first = block.zoningFace[index]!;
        const second = block.zoningFace[(index + 1) % block.zoningFace.length]!;
        candidates.push(metresToWorld(first));
        const worldFirst = metresToWorld(first);
        const worldSecond = metresToWorld(second);
        const dx = worldSecond.x - worldFirst.x;
        const dy = worldSecond.y - worldFirst.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared <= 0 ? 0 : Math.max(0, Math.min(1, ((point.x - worldFirst.x) * dx + (point.y - worldFirst.y) * dy) / lengthSquared));
        candidates.push({ x: worldFirst.x + dx * t, y: worldFirst.y + dy * t });
      }
    }
  }
  if (options.foundryGrid && canvas?.grid?.getSnappedPoint) {
    try {
      const mode = (globalThis as any).CONST?.GRID_SNAPPING_MODES?.VERTEX;
      const snapped = canvas.grid.getSnappedPoint(point, mode === undefined ? undefined : { mode, resolution: 1 });
      if (snapped && Number.isFinite(snapped.x) && Number.isFinite(snapped.y)) candidates.push({ x: snapped.x, y: snapped.y });
    } catch { /* WHY: Foundry grid snapping is optional across supported versions. */ }
  }
  const reach = screenPx(canvas.dimensions.size * 0.45);
  const target = districtSnapTarget(point, candidates, reach);
  return { point: target ?? point, target };
}

let activeLayer: any = null;

export function hasDistrictDraft(): boolean {
  return activeLayer?.hasDraft?.() === true;
}

export function cancelDistrictDraft(): void {
  activeLayer?.cancelDraft?.();
}

export function cancelDistrictInteraction(): void {
  activeLayer?.cancelInteraction?.();
}

export function finishDistrictDraft(): Promise<boolean> {
  const layer = activeLayer as { finishDraft?: () => Promise<boolean> } | null;
  return layer?.finishDraft?.() ?? Promise.resolve(false);
}

export function districtLayerClass(): any {
  const Base = interactionLayerBase();
  if (!Base) throw new Error("InteractionLayer is unavailable — Foundry's canvas API moved.");

  return class NixieDistrictLayer extends Base {
    static get layerOptions(): any {
      return Object.assign(super.layerOptions, { name: DISTRICT_LAYER_NAME, zIndex: 920 });
    }

    #overlay: any = null;
    #planningFill: any = null;
    #planningFills: any[] = [];
    #planningHost: any = null;
    #planningMeshes: DistrictOverlayLineMesh[] = [];
    #planningTask: DistrictPlanningTask | null = null;
    #planningFrame: number | null = null;
    #planningEpoch = 0;
    #preview: any = null;
    #draft: { mode: "draw" | "split"; points: Vec2[]; cursor: Vec2 | null } | null = null;
    #drag: { districtId: string; index: number; origin: Vec2; current: Vec2; locked: boolean } | null = null;
    #snapTarget: Vec2 | null = null;
    #removeCityListener: (() => void) | null = null;
    #panHookId: string | null = null;
    #refreshFrame: number | null = null;
    #plan: any = null;
    #planRevision: number | null = null;
    #planPending = false;
    #planResolved = false;
    #planningRevision: number | null = null;
    #planningScale: number | null = null;

    async _draw(options: any): Promise<void> {
      await super._draw(options);
      this.#overlay = this.addChild(new PIXI.Graphics());
      this.#planningFill = this.addChild(new PIXI.Container());
      this.#planningHost = this.addChild(new PIXI.Container());
      this.#preview = this.addChild(new PIXI.Graphics());
      this.#overlay.eventMode = "none";
      this.#planningFill.eventMode = "none";
      this.#planningHost.eventMode = "none";
      this.#preview.eventMode = "none";
      activeLayer = this;
      setDistrictDraftCancelListener(() => this.cancelDraft());
      this.visible = this.active;
      this.refresh();
    }

    async _tearDown(options: any): Promise<void> {
      if (activeLayer === this) activeLayer = null;
      editorLayerDeactivated(DISTRICT_LAYER_NAME);
      this.#unwatchPan();
      this.#cancelRefresh();
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      setDistrictDraftCancelListener(null);
      setDistrictsPresentation(false);
      this.#clearPlanning();
      this.#overlay = null;
      this.#planningFill = null;
      this.#planningHost = null;
      this.#preview = null;
      this.#draft = null;
      this.#drag = null;
      this.#snapTarget = null;
      this.#plan = null;
      this.#planRevision = null;
      this.#planPending = false;
      this.#planResolved = false;
      return super._tearDown(options);
    }

    _activate(): void {
      activeLayer = this;
      editorLayerActivated(DISTRICT_LAYER_NAME);
      this.#removeCityListener ??= addCityListener(() => {
        if (this.#plan === null) this.#planResolved = false;
        this.refresh();
      });
      setDistrictDraftCancelListener(() => this.cancelDraft());
      this.#syncDragResistance();
      this.#panHookId ??= Hooks.on("canvasPan", () => {
        this.#syncDragResistance();
        if (this.#planningScale !== canvas?.stage?.scale?.x) this.refresh();
      });
      this.visible = true;
      setDistrictsPresentation(true);
      this.refresh();
    }

    _deactivate(): void {
      editorLayerDeactivated(DISTRICT_LAYER_NAME);
      this.#unwatchPan();
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      setDistrictDraftCancelListener(null);
      this.#draft = null;
      this.#drag = null;
      this.#snapTarget = null;
      this.#cancelRefresh();
      this.#clearPlanning();
      this.#plan = null;
      this.#planRevision = null;
      this.#planPending = false;
      this.#planResolved = false;
      setDistrictsPresentation(false);
      clearDistrictSelection();
      this.#preview?.clear();
      this.visible = false;
    }

    #unwatchPan(): void {
      if (this.#panHookId !== null) {
        Hooks.off("canvasPan", this.#panHookId);
        this.#panHookId = null;
      }
      this.#syncDragResistance();
    }

    #cancelRefresh(): void {
      if (this.#refreshFrame === null) return;
      cancelAnimationFrame(this.#refreshFrame);
      this.#refreshFrame = null;
    }

    #clearPlanning(): void {
      this.#planningEpoch++;
      if (this.#planningFrame !== null) {
        cancelAnimationFrame(this.#planningFrame);
        this.#planningFrame = null;
      }
      for (const mesh of this.#planningMeshes) {
        mesh.display.parent?.removeChild(mesh.display);
        mesh.destroy();
      }
      this.#planningMeshes = [];
      for (const fill of this.#planningFills) {
        fill.parent?.removeChild(fill);
        fill.destroy();
      }
      this.#planningFills = [];
      this.#planningTask = null;
      this.#planPending = false;
      this.#planningRevision = null;
      this.#planningScale = null;
    }

    #syncDragResistance(): void {
      const manager = canvas?.mouseInteractionManager;
      if (manager === undefined || manager === null) return;
      const options: Record<string, unknown> = manager.options ?? (manager.options = {});
      if (!this.active) {
        delete options.dragResistance;
        return;
      }
      options.dragResistance = screenPx(canvas.dimensions.size / 4);
    }

    hasDraft(): boolean { return this.#draft !== null && this.#draft.points.length > 0; }

    cancelDraft(): void {
      this.#draft = null;
      this.#drag = null;
      this.#snapTarget = null;
      this.#preview?.clear();
      this.refresh();
      notifyEditorInteraction();
    }

    cancelInteraction(): void { this.cancelDraft(); }

    async finishDraft(): Promise<boolean> {
      const draft = this.#draft;
      if (draft === null || draft.points.length < (draft.mode === "split" ? 2 : 3)) return false;
      if (draft.mode === "split" && selectedIds().length !== 1) {
        const message = "Split requires exactly one selected district.";
        setEditorActionError("district split", new Error(message));
        ui.notifications?.error("Nixie: district split failed — " + message);
        this.#refreshPreview();
        return false;
      }
      const preview = this.#provisionalForDraft(draft);
      if (preview !== null && !preview.valid) {
        const message = preview.reason ?? "District geometry is invalid.";
        setEditorActionError("district edit", new Error(message));
        ui.notifications?.error("Nixie: district edit failed — " + message);
        this.#refreshPreview();
        return false;
      }
      try {
        if (draft.mode === "split") {
          const id = selectedIds()[0];
          if (!id) throw new Error("Select one district before splitting it.");
          await invoke(adapterSplitDistrict, id, draft.points.map(worldToMetres));
        } else {
          await invoke(adapterCreateDistrict, draft.points.map(worldToMetres), currentDistrictType(), currentDistrictPalette());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setEditorActionError("district edit", error);
        ui.notifications?.error("Nixie: district edit failed — " + message);
        return false;
      }
      this.#draft = null;
      this.#snapTarget = null;
      this.#preview?.clear();
      clearEditorActionError();
      this.refresh();
      notifyEditorInteraction();
      return true;
    }

    #pointer(event: any): Vec2 {
      const point = event.getLocalPosition(canvas.stage);
      return { x: point.x, y: point.y };
    }

    #hitDistrict(point: Vec2): string | null {
      const metrePoint = worldToMetres(point);
      for (const district of cityDistricts().slice().reverse()) if (ring(district.polygon) && pointInRing(metrePoint, district.polygon)) return district.id;
      return null;
    }

    #provisionalForDraft(draft: { mode: "draw" | "split"; points: Vec2[]; cursor: Vec2 | null }, points = draft.points): DistrictProvisionalPreview | null {
      const metres = points.map(worldToMetres);
      if (draft.mode === "draw") return districtDrawPreview(cityDistricts(), metres);
      const id = selectedIds()[0];
      const district = cityDistricts().find((entry) => entry.id === id);
      return district === undefined ? null : districtSplitPreview(district, metres, selectedIds().length);
    }

    #nearestVertex(point: Vec2): { districtId: string; index: number; at: Vec2; locked: boolean } | null {
      const reach = screenPx(canvas.dimensions.size * 0.4);
      let nearest: { districtId: string; index: number; at: Vec2; locked: boolean } | null = null;
      let distance = reach * reach;
      const ids = new Set(selectedIds());
      for (const district of cityDistricts()) {
        if (!ids.has(district.id) || !ring(district.polygon)) continue;
        district.polygon.forEach((source: Vec2, index: number) => {
          const at = metresToWorld(source);
          const dx = at.x - point.x;
          const dy = at.y - point.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= distance) { distance = d2; nearest = { districtId: district.id, index, at, locked: district.locked === true }; }
        });
      }
      return nearest;
    }

    refresh(): void {
      if (this.#refreshFrame !== null) return;
      this.#refreshFrame = requestAnimationFrame(() => {
        this.#refreshFrame = requestAnimationFrame(() => {
          this.#refreshFrame = null;
          this.#renderOverlay();
        });
      });
    }

    #renderOverlay(): void {
      const g = this.#overlay;
      if (!g) return;
      g.clear();
      if (!isSceneEnabled() || !this.active) return;
      const city = getCity() as any;
      const revision = typeof city?.revision === "number" ? city.revision : null;
      const scale = typeof canvas?.stage?.scale?.x === "number" ? canvas.stage.scale.x : null;
      const selected = new Set(selectedIds());
      if (this.#planRevision !== revision) {
        this.#clearPlanning();
        this.#plan = null;
        this.#planRevision = revision;
        this.#planResolved = false;
      }
      const plan = this.#plan;
      const overlay = districtOverlayData(city, plan);
      for (const fill of overlay.fills) {
        const color = selected.has(fill.id) ? 0xffc94a : colourFor(fill.id);
        drawPlanRings(g, fill.polygon, color, selected.has(fill.id) ? 0.34 : 0.22, screenPx(Math.max(1.5, canvas.dimensions.size * 0.04)));
      }
      for (const boundary of overlay.boundaries) {
        const color = selected.has(boundary.id) ? 0xffc94a : colourFor(boundary.id);
        drawRing(g, boundary.polygon, color, 0, color, screenPx(Math.max(2, canvas.dimensions.size * 0.07)));
      }
      this.#refreshPreview();
      if (plan === null && !this.#planResolved) this.#schedulePlanView(revision);
      else if (plan !== null && (this.#planningRevision !== revision || this.#planningScale !== scale)) this.#startPlanning(plan, revision, scale);
    }

    #schedulePlanView(revision: number | null): void {
      if (this.#planPending) return;
      this.#planPending = true;
      const epoch = this.#planningEpoch;
      this.#planningFrame = requestAnimationFrame(() => {
        this.#planningFrame = null;
        this.#planPending = false;
        if (epoch !== this.#planningEpoch || !this.active || !isSceneEnabled() || getCity()?.revision !== revision) return;
        try { this.#plan = getDistrictPlanView(); } catch { this.#plan = null; }
        this.#planResolved = true;
        this.refresh();
      });
    }

    #startPlanning(plan: any, revision: number | null, scale: number | null): void {
      this.#clearPlanning();
      this.#planningRevision = revision;
      this.#planningScale = scale;
      const fragmentByKey = new Map<string, any>();
      for (const block of plan?.blocks ?? []) for (const fragment of block?.districtFragments ?? []) {
        fragmentByKey.set(`${String(block.id)}\0${String(fragment.id)}`, fragment);
      }
      const task: DistrictPlanningTask = {
        epoch: this.#planningEpoch,
        plan,
        revision,
        scale,
        phase: "blocks",
        index: 0,
        fragmentByKey,
        hatchQueue: [],
        hatchIterator: null,
        hatchColor: 0,
        hatchSpacing: 0,
        hatchWidth: 0
      };
      this.#planningTask = task;
      this.#planningFrame = requestAnimationFrame(() => this.#stepPlanning(task.epoch));
    }

    #stepPlanning(epoch: number): void {
      this.#planningFrame = null;
      const task = this.#planningTask;
      const currentScale = typeof canvas?.stage?.scale?.x === "number" ? canvas.stage.scale.x : null;
      const currentRevision = getCity()?.revision ?? null;
      const presentationChanged = task !== null && (currentRevision !== task.revision || currentScale !== task.scale);
      if (task === null || task.epoch !== epoch || epoch !== this.#planningEpoch || !this.active || !isSceneEnabled() || presentationChanged) {
        if (task !== null && task.epoch === epoch) {
          const restart = this.active && isSceneEnabled() && presentationChanged;
          this.#clearPlanning();
          if (restart) this.refresh();
        }
        return;
      }
      const builder = new DistrictOverlayLineMeshBuilder();
      const started = performance.now();
      let processed = 0;
      let hasMore = true;
      while (builder.segmentCount < DISTRICT_OVERLAY_SEGMENTS_PER_FRAME) {
        if (processed > 0 && performance.now() - started >= DISTRICT_OVERLAY_CPU_BUDGET_MS) break;
        hasMore = this.#processPlanningItem(task, builder);
        if (!hasMore) break;
        processed++;
      }
      const data = builder.build();
      if (data.segmentCount > 0 && this.#planningHost) {
        const mesh = new DistrictOverlayLineMesh(data);
        mesh.display.eventMode = "none";
        this.#planningHost.addChild(mesh.display);
        this.#planningMeshes.push(mesh);
      }
      if (!hasMore) {
        this.#planningTask = null;
        return;
      }
      this.#planningFrame = requestAnimationFrame(() => this.#stepPlanning(epoch));
    }

    #processPlanningItem(task: DistrictPlanningTask, builder: DistrictOverlayLineMeshBuilder): boolean {
      for (;;) {
        if (task.hatchIterator !== null) {
          const next = task.hatchIterator.next();
          if (!next.done) {
            builder.add(next.value.start, next.value.end, task.hatchWidth, task.hatchColor, 0.5);
            return true;
          }
          task.hatchIterator = null;
        }
        const hatchPolygon = task.hatchQueue.shift();
        if (hatchPolygon !== undefined) {
          const rings = hatchPolygon.map((points) => points.map((point) => metresToWorld(point)));
          task.hatchIterator = districtHatchSegmentIterator(rings, task.hatchSpacing);
          continue;
        }
        if (task.phase === "blocks") {
          const blocks = task.plan?.blocks ?? [];
          if (task.index >= blocks.length) { task.phase = "cells"; task.index = 0; continue; }
          const block = blocks[task.index++]!;
          addPlanRingLines(builder, block.zoningFace ?? block.polygon, 0x8ed9d4, 0.95, screenPx(Math.max(1.5, canvas.dimensions.size * 0.04)));
          return true;
        }
        if (task.phase === "cells") {
          const cells = task.plan?.developmentCells ?? [];
          if (task.index >= cells.length) { task.phase = "unzoned"; task.index = 0; continue; }
          const cell = cells[task.index++]!;
          addPlanRingLines(builder, cell.polygon, 0xe7a7e4, 0.95, screenPx(Math.max(1, canvas.dimensions.size * 0.025)));
          const cue = districtCellOrientationCue(cell);
          if (cue) builder.add(metresToWorld(cue.start), metresToWorld(cue.end), screenPx(Math.max(1, canvas.dimensions.size * 0.02)), 0xffd390, 0.78);
          return true;
        }
        if (task.phase === "unzoned") {
          const unzoned = task.plan?.unzoned ?? [];
          if (task.index >= unzoned.length) { task.phase = "intents"; task.index = 0; continue; }
          const polygon = unzoned[task.index++]!;
          const fill = new PIXI.Graphics();
          fill.eventMode = "none";
          fillPlanRings(fill, polygon, 0x7d8796, 0.12);
          this.#planningFill?.addChild(fill);
          this.#planningFills.push(fill);
          addPlanRingLines(builder, polygon, 0x7d8796, 0.95, screenPx(Math.max(1, canvas.dimensions.size * 0.025)));
          this.#queueHatches(task, polygon, 0x7d8796);
          return true;
        }
        if (task.phase === "intents") {
          const intents = task.plan?.openSpaceIntents ?? [];
          if (task.index >= intents.length) { task.phase = "done"; continue; }
          const intent = intents[task.index++]!;
          if (intent?.category !== null && intent?.targetShare > 0) {
            const fragment = task.fragmentByKey.get(`${String(intent.blockId)}\0${String(intent.fragmentId)}`);
            if (fragment) this.#queueHatches(task, fragment.buildable, OPEN_SPACE_COLORS[intent.category] ?? 0xa9a0c3);
          }
          return true;
        }
        return false;
      }
    }

    #queueHatches(task: DistrictPlanningTask, value: unknown, color: number): void {
      const spacing = screenPx(Math.max(8, canvas.dimensions.size * 0.32));
      task.hatchQueue.push(...polygons(value));
      task.hatchColor = color;
      task.hatchSpacing = Math.max(spacing, 4);
      task.hatchWidth = Math.max(1, spacing * 0.08);
    }

    #refreshPreview(): void {
      const g = this.#preview;
      if (!g) return;
      g.clear();
      const draft = this.#draft;
      if (draft !== null && draft.points.length > 0) {
        const points = draft.points.slice();
        if (draft.cursor !== null && points.length >= (draft.mode === "split" ? 1 : 2)) points.push(draft.cursor);
        const preview = points.length >= (draft.mode === "split" ? 2 : 3) ? this.#provisionalForDraft(draft, points) : null;
        const color = preview?.color ?? DISTRICT_PREVIEW_ERROR_COLOR;
        if (preview !== null) {
          for (const entry of preview.result) for (const polygon of [entry.polygon]) {
            if (polygon.length > 0) drawPolygonWithHoles(g, polygon, color, 0.16, color, screenPx(Math.max(2, canvas.dimensions.size * 0.06)));
          }
        }
        g.lineStyle({ width: screenPx(Math.max(2, canvas.dimensions.size * 0.06)), color, alpha: 0.95 });
        g.moveTo(points[0]!.x, points[0]!.y);
        for (const point of points.slice(1)) g.lineTo(point.x, point.y);
        if (draft.mode === "draw" && points.length >= 3) g.lineTo(points[0]!.x, points[0]!.y);
        g.lineStyle(0);
        g.beginFill(color, 0.95);
        for (const point of points) g.drawCircle(point.x, point.y, screenPx(canvas.dimensions.size * 0.13));
        g.endFill();
      }
      if (canvasTool() === DISTRICT_TOOL.MERGE) {
        const ids = selectedIds();
        if (ids.length > 1) {
          const preview = districtMergePreview(cityDistricts(), ids);
          for (const entry of preview.result) for (const polygon of [entry.polygon]) {
            if (polygon.length > 0) drawPolygonWithHoles(g, polygon, preview.color, 0.2, preview.color, screenPx(Math.max(2, canvas.dimensions.size * 0.06)));
          }
        }
      }
      if (this.#drag !== null) {
        const source = cityDistricts().find((district) => district.id === this.#drag?.districtId);
        const moved = source && ring(source.polygon) ? source.polygon.map((point: Vec2, index: number) => index === this.#drag!.index ? worldToMetres(this.#drag!.current) : point) : null;
        const preview = moved !== null && source !== undefined && !this.#drag.locked
          ? districtDrawPreview(cityDistricts().filter((district) => district.id !== this.#drag!.districtId), moved, { id: this.#drag.districtId })
          : null;
        const valid = moved !== null && validateRing(moved).ok && (preview?.valid ?? true);
        const color = this.#drag.locked || !valid ? DISTRICT_PREVIEW_ERROR_COLOR : DISTRICT_PREVIEW_OK_COLOR;
        g.lineStyle({ width: screenPx(Math.max(2, canvas.dimensions.size * 0.06)), color, alpha: 0.95 });
        g.moveTo(this.#drag.origin.x, this.#drag.origin.y);
        g.lineTo(this.#drag.current.x, this.#drag.current.y);
      }
      if (this.#snapTarget !== null) {
        g.lineStyle({ width: screenPx(Math.max(2, canvas.dimensions.size * 0.04)), color: DISTRICT_SNAP_TARGET_COLOR, alpha: 0.95 });
        g.drawCircle(this.#snapTarget.x, this.#snapTarget.y, screenPx(canvas.dimensions.size * 0.18));
      }
    }

    _canDragLeftStart(): boolean {
      return canvasTool() === DISTRICT_TOOL.EDIT && isSceneEnabled() && cityDistricts().length > 0;
    }

    _onDragLeftStart(event: any): void {
      if (!this._canDragLeftStart()) return;
      const origin = event?.interactionData?.origin;
      const point = origin !== undefined && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? { x: origin.x, y: origin.y } : this.#pointer(event);
      const nearest = this.#nearestVertex(point);
      if (nearest) this.#drag = { ...nearest, origin: nearest.at, current: nearest.at };
      this.#refreshPreview();
    }

    _onDragLeftMove(event: any): void {
      if (this.#drag === null) return;
      const snapped = snapWorldPointInfo(this.#pointer(event), this.#plan, this.#drag);
      this.#drag.current = snapped.point;
      this.#snapTarget = snapped.target;
      this.#refreshPreview();
    }

    _onDragLeftDrop(event: any): void {
      const drag = this.#drag;
      this.#drag = null;
      this.#refreshPreview();
      if (drag === null) return;
      if (drag.locked) {
        const message = `Locked district "${drag.districtId}" cannot be edited.`;
        setEditorActionError("district vertex move", new Error(message));
        ui.notifications?.error("Nixie: district vertex move failed — " + message);
        return;
      }
      const snapped = snapWorldPointInfo(this.#pointer(event), this.#plan, drag);
      this.#snapTarget = snapped.target;
      const at = snapped.point;
      void invoke(adapterMoveDistrictVertex, drag.districtId, drag.index, worldToMetres(at)).then(() => clearEditorActionError()).catch((error) => { setEditorActionError("district vertex move", error); ui.notifications?.error("Nixie: district vertex move failed — " + (error instanceof Error ? error.message : String(error))); });
    }

    _onDragLeftCancel(): void { this.#drag = null; this.#refreshPreview(); }

    _onMouseMove(event: any): void {
      if (!isSceneEnabled() || !this.active) return;
      const snapped = snapWorldPointInfo(this.#pointer(event), this.#plan);
      this.#snapTarget = snapped.target;
      if (this.#draft !== null) this.#draft.cursor = snapped.point;
      this.#refreshPreview();
    }

    _onPointerMove(event: any): void { this._onMouseMove(event); }

    _onClickLeft(event: any): void {
      if (!isSceneEnabled()) return;
      const snapped = snapWorldPointInfo(this.#pointer(event), this.#plan);
      this.#snapTarget = snapped.target;
      const point = snapped.point;
      const tool = canvasTool();
      if (tool === DISTRICT_TOOL.SELECT || tool === DISTRICT_TOOL.MERGE) {
        const id = this.#hitDistrict(point);
        if (id === null) {
          clearDistrictSelection();
          this.refresh();
          notifyEditorInteraction();
        } else {
          void invoke(adapterSelectDistrict, id, Boolean(event.shiftKey || event.data?.originalEvent?.shiftKey)).then(() => { clearEditorActionError(); this.refresh(); notifyEditorInteraction(); }).catch((error) => { setEditorActionError("district selection", error); });
        }
        return;
      }
      if (tool === DISTRICT_TOOL.FILL) {
        void invoke(adapterFillDistrict, worldToMetres(point), currentDistrictType(), currentDistrictPalette()).then(() => clearEditorActionError()).catch((error) => { setEditorActionError("district fill", error); ui.notifications?.error("Nixie: district fill failed — " + (error instanceof Error ? error.message : String(error))); });
        return;
      }
      if (tool !== DISTRICT_TOOL.DRAW && tool !== DISTRICT_TOOL.SPLIT) return;
      const mode = tool === DISTRICT_TOOL.SPLIT ? "split" : "draw";
      if (this.#draft === null || this.#draft.mode !== mode) this.#draft = { mode, points: [], cursor: null };
      const first = this.#draft.points[0];
      const closeReach = screenPx(canvas.dimensions.size * 0.35);
      if (first && this.#draft.points.length >= 3 && mode === "draw" && Math.hypot(first.x - point.x, first.y - point.y) <= closeReach) { void this.finishDraft(); return; }
      if (this.#draft.points.length >= (mode === "draw" ? 3 : 2) && event.data?.originalEvent?.detail >= 2) { void this.finishDraft(); return; }
      this.#draft.points.push(point);
      this.#draft.cursor = null;
      this.#refreshPreview();
      notifyEditorInteraction();
    }

    _onClickLeft2(): void { if (this.#draft?.mode === "split") void this.finishDraft(); }

    _onClickRight(): void {
      if (this.#draft !== null && this.#draft.points.length > 0) {
        this.#draft.points.pop();
        this.#draft.cursor = null;
        if (this.#draft.points.length === 0) this.#draft = null;
        this.#refreshPreview();
        notifyEditorInteraction();
        return;
      }
      this.cancelDraft();
    }

    _onDragRightCancel(): void { this.cancelDraft(); }
  };
}
