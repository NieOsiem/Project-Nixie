import {
  addCityListener,
  getArchitecturePlanView,
  getCity,
  getDistrictPlanView,
  isSceneEnabled,
  metresToWorld,
  worldToMetres
} from "../adapter/canvas.js";
import type { RegenerationBlocker, RegenerationPreflight } from "../core/gen/regeneration-plan.js";
import type { Polygon, Ring, Vec2 } from "../core/geom/types.js";
import { ringBounds } from "../core/geom/types.js";
import {
  LAYER_REGENERATE,
  REGENERATE_TOOL,
  canvasTool,
  clearRegenerationSelection,
  editorLayerActivated,
  editorLayerDeactivated,
  getRegenerationSelection,
  isPendingOperation,
  notifyEditorInteraction,
  selectRegenerationTarget,
  setRegenerationSelectionListener,
  type RegenerationSelection
} from "./editor-state.js";

/**
 * The Regenerate canvas layer (UI spec §28): owned overlay for partial-regeneration
 * targets. It emphasizes selected blocks or the one selected district, shows the final
 * expanded target (the fragment buildable union), marks protected objects and reserved
 * sites, and highlights preflight blockers in red plus a non-color hatch badge. All
 * overlays are cached per plan/selection/revision and never redrawn per frame.
 */

export const REGENERATE_LAYER_NAME = LAYER_REGENERATE;
export type { RegenerationBlocker, RegenerationPreflight };
export type { RegenerationSelection } from "./editor-state.js";

type UnknownRecord = Record<string, unknown>;

interface GraphicsLike {
  eventMode: string;
  clear(): void;
  beginFill(color: number, alpha?: number): void;
  endFill(): void;
  lineStyle(style: unknown): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  beginHole?(): void;
  endHole?(): void;
}
interface InteractionLayerLike {
  active: boolean;
  visible: boolean;
  addChild<T>(child: T): T;
  _activate?(): void;
  _deactivate?(): void;
  _draw(options: unknown): Promise<void>;
  _tearDown(options: unknown): Promise<void>;
}
type LayerConstructor = (new () => InteractionLayerLike) & { layerOptions?: Record<string, unknown> };

const COLOR_DIM = 0x0b0a13;
const COLOR_BLOCK_FACE = 0x9a97a0;
const COLOR_SELECTED = 0x74ffa8;
const COLOR_FINAL = 0x6ad8d2;
const COLOR_PROTECTED = 0xf1c76d;
const COLOR_BLOCKER = 0xff6b75;
const COLOR_HOVER = 0xf0f0e0;

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
  return Array.isArray(value) && value.length >= 3 && value.every((point) => finitePoint(point));
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

/** Accepts a Ring, a Polygon, or a MultiPolygon and returns its polygons with holes. */
function polygonsOf(value: unknown): Polygon[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (validRing(value)) return [[value]];
  const polygons: Polygon[] = [];
  for (const item of value) {
    if (!Array.isArray(item)) continue;
    if (validRing(item)) {
      polygons.push([item]);
      continue;
    }
    const outer = item[0];
    if (!validRing(outer)) continue;
    polygons.push([outer, ...item.slice(1).filter(validRing)]);
  }
  return polygons;
}

function planBlocks(plan: unknown): UnknownRecord[] {
  const blocks = field(plan, "blocks");
  return Array.isArray(blocks) ? blocks.filter((block) => record(block) !== null).map((block) => record(block)!) : [];
}

function cityDistricts(city: unknown): UnknownRecord[] {
  const districts = field(field(city, "source"), "districts");
  return Array.isArray(districts) ? districts.filter((district) => record(district) !== null).map((district) => record(district)!) : [];
}

function cityRevision(city: unknown): number | null {
  const revision = field(city, "revision");
  return typeof revision === "number" ? revision : null;
}

function ringCentroid(ring: Ring): Vec2 {
  let x = 0;
  let y = 0;
  for (const point of ring) {
    x += point.x;
    y += point.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/**
 * The complete block under a plan-space point, or null. Blocks carrying at least one
 * district fragment are selectable — fragments with a null districtId (unzoned land)
 * still resolve to a valid buildable scope; a block with no fragments at all would
 * resolve to no scope, so it stays unselectable (UI spec §28.2).
 */
export function regenerateBlockAt(pointM: Vec2, districtPlan: unknown): string | null {
  for (const block of planBlocks(districtPlan)) {
    const fragments = field(block, "districtFragments");
    if (!Array.isArray(fragments) || fragments.length === 0) continue;
    const face = field(block, "zoningFace");
    if (validRing(face) && pointInRing(pointM, face) && typeof block.id === "string") return block.id;
  }
  return null;
}

/** The district whose authored polygon contains a plan-space point, or null. */
export function regenerateDistrictAt(pointM: Vec2, city: unknown): string | null {
  for (const district of cityDistricts(city)) {
    const polygon = field(district, "polygon");
    if (validRing(polygon) && pointInRing(pointM, polygon) && typeof district.id === "string") return district.id;
  }
  return null;
}

export interface RegenerationTargetOverlays {
  /** The selected blocks' zoning faces (block mode) or the district's authored polygon. */
  emphasis: Polygon[];
  /** The final expanded target: the union of the target fragments' buildable polygons. */
  final: Polygon[];
}

/**
 * Canvas-space (metres) polygons for the selection emphasis and the final expanded
 * target. A district target regenerates every fragment the district occupies, so its
 * final target is the district's fragments across blocks — wider than its authored
 * polygon wherever a fragment extends beyond the district boundary.
 */
export function regenerationTargetOverlays(
  selection: RegenerationSelection | null,
  districtPlan: unknown,
  city: unknown
): RegenerationTargetOverlays {
  if (selection === null || selection.ids.length === 0) return { emphasis: [], final: [] };
  const fragmentsOf = (block: UnknownRecord): unknown[] =>
    Array.isArray(field(block, "districtFragments")) ? field(block, "districtFragments") as unknown[] : [];
  if (selection.kind === "district") {
    const districtId = selection.ids[0]!;
    const final = planBlocks(districtPlan)
      .flatMap(fragmentsOf)
      .filter((fragment) => record(fragment) !== null && field(fragment, "districtId") === districtId)
      .flatMap((fragment) => polygonsOf(field(fragment, "buildable")));
    if (final.length === 0) return { emphasis: [], final: [] };
    const authored = cityDistricts(city)
      .filter((district) => district.id === districtId)
      .map((district) => field(district, "polygon"))
      .find(validRing);
    return { emphasis: authored === undefined ? [] : [[authored]], final };
  }
  const selected = new Set(selection.ids);
  const blocks = planBlocks(districtPlan).filter((block) => selected.has(block.id as string));
  if (blocks.length !== selected.size) return { emphasis: [], final: [] };
  const emphasis = blocks
    .map((block) => field(block, "zoningFace"))
    .filter(validRing)
    .map((face) => [face]);
  const final = blocks.flatMap(fragmentsOf).flatMap((fragment) => polygonsOf(field(fragment, "buildable")));
  if (final.length === 0) return { emphasis: [], final: [] };
  return { emphasis, final };
}

/** Stable cache/identity key for a selection; also reused by the workspace. */
export function regenerationSelectionKey(selection: RegenerationSelection | null): string {
  return selection === null ? "" : `${selection.kind}\u0001${selection.ids.join("\u0000")}\u0001${String(selection.revision)}`;
}

export interface RegenerationSeedSummary {
  /** Distinct effective seed texts aggregated over the selection's fragments. */
  values: string[];
  /** null when no record exists, the seed text when one value, "Multiple" otherwise. */
  display: string | null;
  /**
   * Selected target IDs whose own stored record does NOT govern every fragment — a
   * newer opposite-kind event controls at least part of the target's geometry.
   */
  overriddenIds: string[];
  /** Fragments (or fallback: whole targets) with no applicable partial-seed record. */
  unseededFragments: number;
}

function newestSeedRecord(records: readonly unknown[], kind: unknown, targetId: string): UnknownRecord | null {
  let newest: UnknownRecord | null = null;
  for (const raw of records) {
    const entry = record(raw);
    if (entry === null || entry.targetKind !== kind || entry.targetId !== targetId) continue;
    if (newest === null || (typeof entry.order === "number" && (typeof newest.order !== "number" || entry.order >= newest.order))) newest = entry;
  }
  return newest;
}

function recordOrder(entry: UnknownRecord): number {
  return typeof entry.order === "number" ? entry.order : -1;
}

function recordSeed(entry: UnknownRecord): string | null {
  return typeof entry.seed === "string" ? entry.seed : null;
}

/**
 * The effective partial seeds for the selection (spec §26.4 chronology), resolved PER
 * FRAGMENT: a block split across district boundaries can carry different effective
 * seeds in different fragments, because each fragment's seed is the newest applicable
 * record among the block's own record and that fragment's district record (and vice
 * versa for a district target vs. the block records of the blocks holding its
 * fragments). Winners are aggregated as raw seed texts — a single selected block can
 * legitimately present "Multiple", and no unified winner is ever invented. Blocks or
 * districts whose own record loses on some fragments are reported in overriddenIds;
 * fragments with no applicable record at all are counted in unseededFragments so the
 * tray can mark mixed seeded/unseeded targets distinctly. Without a district plan the
 * summary falls back to the direct newest record per target ID (legacy callers).
 */
export function regenerationSeedSummary(
  city: unknown,
  selection: RegenerationSelection | null,
  districtPlan?: unknown
): RegenerationSeedSummary {
  const records = field(field(field(city, "source"), "regeneration"), "partialSeeds");
  const values: string[] = [];
  const overriddenIds: string[] = [];
  let unseededFragments = 0;
  if (selection !== null && Array.isArray(records)) {
    if (districtPlan === undefined) {
      for (const id of selection.ids) {
        const own = newestSeedRecord(records, selection.kind, id);
        const seed = own === null ? null : recordSeed(own);
        if (seed === null) unseededFragments += 1;
        else values.push(seed);
      }
    } else {
      const fragments: { ownerId: string; ownRecord: UnknownRecord | null; otherKind: "district" | "block"; otherId: string | null }[] = [];
      if (selection.kind === "block") {
        const selected = new Set(selection.ids);
        for (const block of planBlocks(districtPlan)) {
          if (typeof block.id !== "string" || !selected.has(block.id)) continue;
          const own = newestSeedRecord(records, "block", block.id);
          for (const raw of Array.isArray(field(block, "districtFragments")) ? field(block, "districtFragments") as unknown[] : []) {
            const districtId = field(raw, "districtId");
            fragments.push({ ownerId: block.id, ownRecord: own, otherKind: "district", otherId: typeof districtId === "string" ? districtId : null });
          }
        }
      } else {
        const districtId = selection.ids[0]!;
        const own = newestSeedRecord(records, "district", districtId);
        for (const block of planBlocks(districtPlan)) {
          if (typeof block.id !== "string") continue;
          const holds = Array.isArray(field(block, "districtFragments"))
            && (field(block, "districtFragments") as unknown[]).some((raw) => field(raw, "districtId") === districtId);
          if (!holds) continue;
          for (const raw of field(block, "districtFragments") as unknown[]) {
            if (field(raw, "districtId") !== districtId) continue;
            fragments.push({ ownerId: districtId, ownRecord: own, otherKind: "block", otherId: typeof block.id === "string" ? block.id : null });
          }
        }
      }
      const partlyOverridden = new Set<string>();
      for (const fragment of fragments) {
        let winner = fragment.ownRecord;
        if (fragment.otherId !== null) {
          const other = newestSeedRecord(records, fragment.otherKind, fragment.otherId);
          if (other !== null && (winner === null || recordOrder(other) >= recordOrder(winner))) winner = other;
        }
        if (winner === null) {
          unseededFragments += 1;
          continue;
        }
        if (winner !== fragment.ownRecord && fragment.ownRecord !== null) partlyOverridden.add(fragment.ownerId);
        const seed = recordSeed(winner);
        if (seed !== null) values.push(seed);
        else unseededFragments += 1;
      }
      for (const id of selection.ids) {
        if (partlyOverridden.has(id)) overriddenIds.push(id);
      }
    }
  }
  const distinct = [...new Set(values)];
  return {
    values,
    display: distinct.length === 0 ? null : distinct.length === 1 ? distinct[0]! : "Multiple",
    overriddenIds,
    unseededFragments
  };
}

export interface RegenerationProtectionSummary {
  /** Protected (explicit or manual-edit) objects whose site lies inside the target. */
  protectedIds: string[];
  /** Procedural reserved major-landmark sites (empty generated reservations) inside the target. */
  reservedIds: string[];
}

interface PlanArchitectureEntry {
  id: string;
  kind: "building" | "place";
  protection: unknown;
  sitePolygon: unknown;
  origin: unknown;
  masses: unknown;
}

function planArchitectureEntries(plan: unknown): PlanArchitectureEntry[] {
  const view = record(plan);
  if (view === null) return [];
  const entries: PlanArchitectureEntry[] = [];
  for (const key of ["buildings", "landmarks"] as const) {
    const list = view[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const entry = record(raw);
      if (entry === null || typeof entry.id !== "string") continue;
      entries.push({
        id: entry.id,
        kind: key === "buildings" ? "building" : "place",
        protection: entry.protection,
        sitePolygon: entry.sitePolygon,
        origin: entry.origin,
        masses: entry.masses
      });
    }
  }
  return entries;
}

function pointInPolygons(point: Vec2, polygons: Polygon[]): boolean {
  for (const polygon of polygons) {
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

function entryIsReserved(entry: PlanArchitectureEntry): boolean {
  return entry.protection === undefined || entry.protection === "none"
    ? entry.origin === "generated" && Array.isArray(entry.masses) && entry.masses.length === 0
    : false;
}

/**
 * Cheap retained-count preview for the tray before any async preflight: protected
 * objects and reserved procedural sites whose site centroid lies inside the final
 * target. Exact retained/excluded figures come from the async preflight result.
 */
export function regenerationProtectionSummary(plan: unknown, final: Polygon[]): RegenerationProtectionSummary {
  const protectedIds: string[] = [];
  const reservedIds: string[] = [];
  for (const entry of planArchitectureEntries(plan)) {
    if (!validRing(entry.sitePolygon)) continue;
    if (!pointInPolygons(ringCentroid(entry.sitePolygon), final)) continue;
    if (entry.protection !== undefined && entry.protection !== "none") protectedIds.push(entry.id);
    else if (entryIsReserved(entry)) reservedIds.push(entry.id);
  }
  return { protectedIds, reservedIds };
}

/**
 * Plan geometry lookups for preflight blockers: only blockers that name an identifiable
 * object get canvas emphasis; target/seed blockers stay tray-only. Override blocker IDs
 * are `kind:targetId` pairs; the geometry lives on the target object.
 */
export function blockerGeometryId(blocker: RegenerationBlocker): string | null {
  if (blocker.kind === "building" || blocker.kind === "place") return blocker.id;
  if (blocker.kind === "override") {
    const separator = blocker.id.indexOf(":");
    return separator === -1 ? null : blocker.id.slice(separator + 1);
  }
  return null;
}

export function describeRegenerationBlockers(
  blockers: readonly RegenerationBlocker[]
): { id: string; kind: string; reason: string; geometryId: string | null }[] {
  return blockers.map((blocker) => ({
    id: blocker.id,
    kind: blocker.kind,
    reason: blocker.reason,
    geometryId: blockerGeometryId(blocker)
  }));
}

// ---------------------------------------------------------------------------
// Module-level layer state shared with the workspace bridge.

interface ActiveRegenerateLayer extends InteractionLayerLike {
  refresh?(): void;
  invalidateOverlays?(): void;
}

let activeLayer: ActiveRegenerateLayer | null = null;
let blockers: RegenerationBlocker[] | null = null;

/** Durable failed-preflight blockers; the layer draws them until explicitly cleared. */
export function setRegenerationBlockers(next: readonly RegenerationBlocker[] | null): void {
  const key = next === null || next.length === 0 ? null : [...next];
  const changed = JSON.stringify(key) !== JSON.stringify(blockers);
  blockers = key;
  if (changed) activeLayer?.invalidateOverlays?.();
}

export function getRegenerationBlockers(): RegenerationBlocker[] {
  return blockers === null ? [] : blockers.map((blocker) => ({ ...blocker }));
}

export function clearRegenerationBlockers(): void {
  setRegenerationBlockers(null);
}

let cachedClass: LayerConstructor | null = null;

/**
 * Foundry-safe layer factory (objects-layer pattern): InteractionLayer is resolved at
 * first use, never at module import, so unit tests can stub the canvas API.
 */
export function regenerateLayerClass(): LayerConstructor {
  if (cachedClass !== null) return cachedClass;
  const Base = interactionLayerBase();
  if (typeof Base !== "function") throw new Error("InteractionLayer is unavailable — Foundry's canvas API moved.");
  const BaseClass = Base as LayerConstructor;

  cachedClass = class NixieRegenerateLayer extends BaseClass {
    static get layerOptions(): Record<string, unknown> {
      const parent = BaseClass.layerOptions ?? {};
      return Object.assign({}, parent, { name: REGENERATE_LAYER_NAME, zIndex: 930 });
    }

    #base: GraphicsLike | null = null;
    #dim: GraphicsLike | null = null;
    #target: GraphicsLike | null = null;
    #marks: GraphicsLike | null = null;
    #blockers: GraphicsLike | null = null;
    #hover: GraphicsLike | null = null;
    #baseCache: string | null = null;
    #targetCache: string | null = null;
    #marksCache: string | null = null;
    #blockersCache: string | null = null;
    #hoverId: string | null = null;
    #removeCityListener: (() => void) | null = null;
    #selectionListener: (() => void) | null = null;

    #invalidateCaches(): void {
      this.#baseCache = null;
      this.#targetCache = null;
      this.#marksCache = null;
      this.#blockersCache = null;
    }

    invalidateOverlays(): void {
      this.#blockersCache = null;
      this.#marksCache = null;
      this.refresh();
    }

    #registerListeners(): void {
      this.#removeCityListener ??= addCityListener(() => {
        this.#invalidateCaches();
        this.refresh();
      });
      // The layer owns the regenerate selection listener; selection changes redraw the
      // overlay and refresh the shell through the shared interaction notification.
      this.#selectionListener ??= (() => {
        const listener = (): void => {
          this.#invalidateCaches();
          this.#hoverId = null;
          this.#hover?.clear();
          this.refresh();
          notifyEditorInteraction();
        };
        setRegenerationSelectionListener(listener);
        return listener;
      })();
    }

    async _draw(options: unknown): Promise<void> {
      await super._draw(options);
      const base: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const dim: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const target: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const marks: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const blockersGraphic: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      const hover: GraphicsLike | null = this.addChild(new PIXI.Graphics());
      if (base === null || dim === null || target === null || marks === null || blockersGraphic === null || hover === null) return;
      for (const graphic of [base, dim, target, marks, blockersGraphic, hover]) graphic.eventMode = "none";
      this.#base = base;
      this.#dim = dim;
      this.#target = target;
      this.#marks = marks;
      this.#blockers = blockersGraphic;
      this.#hover = hover;
      activeLayer = this;
      this.#registerListeners();
      this.#invalidateCaches();
      this.refresh();
    }

    async _tearDown(options: unknown): Promise<void> {
      this.#invalidateCaches();
      if (activeLayer === this) activeLayer = null;
      editorLayerDeactivated(REGENERATE_LAYER_NAME);
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      this.#clearGraphics();
      return super._tearDown(options);
    }

    #clearGraphics(): void {
      this.#base?.clear();
      this.#dim?.clear();
      this.#target?.clear();
      this.#marks?.clear();
      this.#blockers?.clear();
      this.#hover?.clear();
    }

    _activate(): void {
      this.#invalidateCaches();
      activeLayer = this;
      editorLayerActivated(REGENERATE_LAYER_NAME);
      this.#registerListeners();
      this.visible = true;
      this.refresh();
    }

    _deactivate(): void {
      this.#invalidateCaches();
      editorLayerDeactivated(REGENERATE_LAYER_NAME);
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      this.#hoverId = null;
      this.#clearGraphics();
      this.visible = false;
    }

    #interactive(): boolean {
      return this.active && isSceneEnabled() && getCity() !== null && !isPendingOperation();
    }

    #pointer(event: unknown): Vec2 {
      const getLocalPosition = field(event, "getLocalPosition");
      const point = typeof getLocalPosition === "function" ? getLocalPosition.call(event, canvas.stage) : null;
      if (finitePoint(point)) return { x: point.x, y: point.y };
      const data = field(event, "data");
      const global = field(data, "global");
      if (finitePoint(global)) return { x: global.x, y: global.y };
      return { x: 0, y: 0 };
    }

    #hit(pointWorld: Vec2): { kind: "block" | "district"; id: string } | null {
      const city = getCity();
      if (city === null) return null;
      const pointM = worldToMetres(pointWorld);
      const tool = canvasTool();
      if (tool === REGENERATE_TOOL.BLOCK) {
        const id = regenerateBlockAt(pointM, getDistrictPlanView());
        return id === null ? null : { kind: "block", id };
      }
      if (tool === REGENERATE_TOOL.DISTRICT) {
        const id = regenerateDistrictAt(pointM, city);
        return id === null ? null : { kind: "district", id };
      }
      return null;
    }

    #commitHit(hit: { kind: "block" | "district"; id: string } | null, additive: boolean): void {
      const city = getCity();
      if (city === null) return;
      if (hit === null) {
        clearRegenerationSelection();
        return;
      }
      // District targets are always singular; additive Shift only applies to blocks.
      selectRegenerationTarget(hit.kind, hit.id, hit.kind === "block" ? additive : false, cityRevision(city));
    }

    _onClickLeft(event: unknown): void {
      if (!this.#interactive()) return;
      this.#commitHit(this.#hit(this.#pointer(event)), record(event)?.shiftKey === true);
    }

    _onClickRight(event: unknown): void {
      if (!this.#interactive()) return;
      this.#commitHit(this.#hit(this.#pointer(event)), record(event)?.shiftKey === true);
    }

    _onMouseMove(event: unknown): void {
      if (!this.active || !isSceneEnabled() || getCity() === null) return;
      const hit = this.#hit(this.#pointer(event));
      const id = hit?.id ?? null;
      if (id === this.#hoverId) return;
      this.#hoverId = id;
      this.#refreshHover();
    }

    _onMove(event: unknown): void {
      this._onMouseMove(event);
    }

    #traceRing(g: GraphicsLike, ring: Ring): void {
      const first = metresToWorld(ring[0]!);
      g.moveTo(first.x, first.y);
      for (const point of ring.slice(1)) {
        const world = metresToWorld(point);
        g.lineTo(world.x, world.y);
      }
      g.lineTo(first.x, first.y);
    }

    #tracePolygon(g: GraphicsLike, polygon: Polygon): void {
      for (const ring of polygon) this.#traceRing(g, ring);
    }

    #fillPolygon(g: GraphicsLike, polygon: Polygon, color: number, alpha: number): void {
      const outer = polygon[0];
      if (outer === undefined) return;
      g.lineStyle(0);
      g.beginFill(color, alpha);
      this.#traceRing(g, outer);
      for (const hole of polygon.slice(1)) {
        if (typeof g.beginHole !== "function" || typeof g.endHole !== "function") break;
        g.beginHole();
        this.#traceRing(g, hole);
        g.endHole();
      }
      g.endFill();
    }

    #fillPolygons(g: GraphicsLike, polygons: Polygon[], color: number, alpha: number): void {
      for (const polygon of polygons) this.#fillPolygon(g, polygon, color, alpha);
    }

    #outlinePolygons(g: GraphicsLike, polygons: Polygon[], color: number, width: number, alpha: number): void {
      g.lineStyle({ width, color, alpha });
      for (const polygon of polygons) this.#tracePolygon(g, polygon);
    }

    /** Dim everything outside the final target, with coverage polygons punched out. */
    #drawDim(dim: GraphicsLike, coverage: Polygon[]): void {
      const bounds = this.#sceneBounds(coverage);
      if (bounds === null) return;
      dim.lineStyle(0);
      dim.beginFill(COLOR_DIM, 0.62);
      dim.moveTo(bounds.x, bounds.y);
      dim.lineTo(bounds.x + bounds.width, bounds.y);
      dim.lineTo(bounds.x + bounds.width, bounds.y + bounds.height);
      dim.lineTo(bounds.x, bounds.y + bounds.height);
      dim.lineTo(bounds.x, bounds.y);
      for (const polygon of coverage) {
        const outer = polygon[0]!;
        if (typeof dim.beginHole !== "function" || typeof dim.endHole !== "function") break;
        dim.beginHole();
        this.#traceRing(dim, outer);
        dim.endHole();
      }
      dim.endFill();
      // Holes inside coverage polygons stay dimmed: refill them as dim islands.
      if (typeof dim.beginHole === "function") {
        for (const polygon of coverage) {
          for (const hole of polygon.slice(1)) this.#fillPolygon(dim, [hole], COLOR_DIM, 0.62);
        }
      }
    }

    #sceneBounds(coverage: Polygon[]): { x: number; y: number; width: number; height: number } | null {
      const sceneRect = record(canvas?.dimensions?.sceneRect);
      if (sceneRect !== null && typeof sceneRect.x === "number" && typeof sceneRect.y === "number" && typeof sceneRect.width === "number" && typeof sceneRect.height === "number") {
        return { x: sceneRect.x, y: sceneRect.y, width: sceneRect.width, height: sceneRect.height };
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const polygon of coverage) {
        if (!validRing(polygon[0])) continue;
        const bounds = ringBounds(polygon[0]);
        minX = Math.min(minX, bounds.x);
        minY = Math.min(minY, bounds.y);
        maxX = Math.max(maxX, bounds.x + bounds.width);
        maxY = Math.max(maxY, bounds.y + bounds.height);
      }
      if (!Number.isFinite(minX)) return null;
      const pad = Math.max(maxX - minX, maxY - minY) * 0.5;
      return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    }

    #drawMarker(g: GraphicsLike, polygon: Polygon, color: number, shape: "cross" | "circle" | "diamond"): void {
      const outer = polygon[0];
      if (outer === undefined || !validRing(outer)) return;
      const bounds = ringBounds(outer);
      const centre = metresToWorld({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
      const radius = Math.max(3, (canvas?.dimensions?.size ?? 100) * 0.09);
      g.lineStyle({ width: Math.max(2, radius * 0.35), color, alpha: 0.95 });
      if (shape === "circle") {
        for (let step = 0; step <= 16; step++) {
          const point = { x: centre.x + radius * Math.cos((step / 16) * Math.PI * 2), y: centre.y + radius * Math.sin((step / 16) * Math.PI * 2) };
          if (step === 0) g.moveTo(point.x, point.y);
          else g.lineTo(point.x, point.y);
        }
        return;
      }
      if (shape === "diamond") {
        g.moveTo(centre.x, centre.y - radius);
        g.lineTo(centre.x + radius, centre.y);
        g.lineTo(centre.x, centre.y + radius);
        g.lineTo(centre.x - radius, centre.y);
        g.lineTo(centre.x, centre.y - radius);
        return;
      }
      g.moveTo(centre.x - radius, centre.y - radius);
      g.lineTo(centre.x + radius, centre.y + radius);
      g.moveTo(centre.x + radius, centre.y - radius);
      g.lineTo(centre.x - radius, centre.y + radius);
    }

    /** Non-color hatch across the blocker bbox; paired with the red outline and cross. */
    #drawHatch(g: GraphicsLike, polygon: Polygon, color: number): void {
      const outer = polygon[0];
      if (outer === undefined || !validRing(outer)) return;
      const bounds = ringBounds(outer);
      const size = Math.max(6, (canvas?.dimensions?.size ?? 100) * 0.2);
      const start = metresToWorld({ x: bounds.x + bounds.width / 2 - size, y: bounds.y + bounds.height / 2 + size });
      g.lineStyle({ width: Math.max(2, size * 0.09), color, alpha: 0.7 });
      for (let offset = -size; offset <= size; offset += Math.max(3, size / 3)) {
        g.moveTo(start.x + offset, start.y - offset);
        g.lineTo(start.x + offset + size, start.y - offset - size);
      }
    }

    refresh(): void {
      const targetGraphic = this.#target;
      const dim = this.#dim;
      if (targetGraphic === null || dim === null) return;
      const city = getCity();
      const districtPlan = getDistrictPlanView();
      const plan = getArchitecturePlanView();
      if (!this.active || !isSceneEnabled() || city === null || districtPlan === null) {
        this.#clearGraphics();
        this.#invalidateCaches();
        return;
      }
      const selection = getRegenerationSelection();
      const lineWidth = Math.max(2, (canvas?.dimensions?.size ?? 100) * 0.05);
      const contextKey = `${String(cityRevision(city))}\u0001${districtPlan === null ? "" : "plan"}\u0001${plan === null ? "" : "plan"}`;
      const selectionKey = regenerationSelectionKey(selection);
      const tool = canvasTool();

      if (this.#baseCache !== contextKey + tool + String(lineWidth)) {
        this.#base?.clear();
        // Mode affordance: faint outlines of everything the current tool can select.
        if (tool === REGENERATE_TOOL.BLOCK) {
          const faces = planBlocks(districtPlan)
            .filter((block) => Array.isArray(field(block, "districtFragments")) && (field(block, "districtFragments") as unknown[]).length > 0)
            .map((block) => field(block, "zoningFace"))
            .filter(validRing)
            .map((face) => [face]);
          this.#outlinePolygons(this.#base!, faces, COLOR_BLOCK_FACE, Math.max(1, lineWidth * 0.5), 0.35);
        } else if (tool === REGENERATE_TOOL.DISTRICT) {
          const polygons = cityDistricts(city)
            .map((district) => field(district, "polygon"))
            .filter(validRing)
            .map((polygon) => [polygon]);
          this.#outlinePolygons(this.#base!, polygons, COLOR_BLOCK_FACE, Math.max(1, lineWidth * 0.5), 0.35);
        }
        this.#baseCache = contextKey + tool + String(lineWidth);
      }

      if (this.#targetCache !== contextKey + selectionKey + String(lineWidth)) {
        targetGraphic.clear();
        dim.clear();
        if (selection !== null && selection.ids.length > 0) {
          const overlays = regenerationTargetOverlays(selection, districtPlan, city);
          this.#fillPolygons(targetGraphic, overlays.emphasis, COLOR_SELECTED, 0.10);
          this.#outlinePolygons(targetGraphic, overlays.emphasis, COLOR_SELECTED, lineWidth, 0.85);
          this.#fillPolygons(targetGraphic, overlays.final, COLOR_FINAL, 0.22);
          this.#outlinePolygons(targetGraphic, overlays.final, COLOR_FINAL, lineWidth * 1.6, 0.95);
          this.#drawDim(dim, overlays.final);
        }
        this.#targetCache = contextKey + selectionKey + String(lineWidth);
      }

      const blockerKey = JSON.stringify(blockers);
      const marksKey = contextKey + selectionKey + String(lineWidth);
      const blockersKey = contextKey + blockerKey + String(lineWidth);
      if (this.#marksCache !== marksKey || this.#blockersCache !== blockersKey) {
        this.#marks?.clear();
        this.#blockers?.clear();
        const final = selection !== null && selection.ids.length > 0 ? regenerationTargetOverlays(selection, districtPlan, city).final : [];
        if (final.length > 0) {
          for (const entry of planArchitectureEntries(plan)) {
            if (!validRing(entry.sitePolygon)) continue;
            if (!pointInPolygons(ringCentroid(entry.sitePolygon), final)) continue;
            const polygon: Polygon = [entry.sitePolygon];
            if (entry.protection !== undefined && entry.protection !== "none") {
              this.#outlinePolygons(this.#marks!, [polygon], COLOR_PROTECTED, Math.max(1, lineWidth * 0.8), 0.9);
              this.#drawMarker(this.#marks!, polygon, COLOR_PROTECTED, "circle");
            } else if (entryIsReserved(entry)) {
              this.#outlinePolygons(this.#marks!, [polygon], COLOR_FINAL, Math.max(1, lineWidth * 0.8), 0.8);
              this.#drawMarker(this.#marks!, polygon, COLOR_FINAL, "diamond");
            }
          }
        }
        const geometryIds = new Set((blockers ?? []).map(blockerGeometryId).filter((id): id is string => id !== null));
        if (geometryIds.size > 0 && final.length > 0) {
          for (const entry of planArchitectureEntries(plan)) {
            if (!geometryIds.has(entry.id)) continue;
            const site = entry.sitePolygon;
            if (!validRing(site)) continue;
            const polygon: Polygon = [site];
            this.#outlinePolygons(this.#blockers!, [polygon], COLOR_BLOCKER, lineWidth * 1.8, 0.95);
            this.#drawMarker(this.#blockers!, polygon, COLOR_BLOCKER, "cross");
            this.#drawHatch(this.#blockers!, polygon, COLOR_BLOCKER);
          }
        }
        this.#marksCache = marksKey;
        this.#blockersCache = blockersKey;
      }
      this.#refreshHover();
    }

    #refreshHover(): void {
      const hover = this.#hover;
      if (hover === null) return;
      hover.clear();
      if (this.#hoverId === null || !this.#interactive()) return;
      const city = getCity();
      const districtPlan = getDistrictPlanView();
      if (city === null || districtPlan === null) return;
      const tool = canvasTool();
      let polygon: Polygon | null = null;
      if (tool === REGENERATE_TOOL.BLOCK) {
        const face = planBlocks(districtPlan)
          .filter((block) => block.id === this.#hoverId)
          .map((block) => field(block, "zoningFace"))
          .find(validRing);
        polygon = face === undefined ? null : [face];
      } else if (tool === REGENERATE_TOOL.DISTRICT) {
        const authored = cityDistricts(city)
          .filter((district) => district.id === this.#hoverId)
          .map((district) => field(district, "polygon"))
          .find(validRing);
        polygon = authored === undefined ? null : [authored];
      }
      if (polygon === null) return;
      const lineWidth = Math.max(2, (canvas?.dimensions?.size ?? 100) * 0.05);
      this.#outlinePolygons(hover, [polygon], COLOR_HOVER, lineWidth * 0.9, 0.8);
    }
  };
  return cachedClass;
}
