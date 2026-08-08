import {
  cancelTerrainDraft as cancelAdapterTerrainDraft,
  deleteUrbanFootprint,
  getCity,
  isSceneEnabled,
  metresToWorld,
  moveTerrainVertex,
  replaceLand,
  replaceUrbanFootprint,
  setCityListener,
  setTerrainDraftCancelListener,
  worldToMetres
} from "../adapter/canvas.js";
import type { Ring, Vec2 } from "../core/geom/types.js";
import { canvasTool, editorLayerActivated, editorLayerDeactivated, LAYER_NIXIE, notifyEditorInteraction, TOOL } from "./editor-state.js";

export const LAYER_NAME = LAYER_NIXIE;

type Target = "land" | "urbanFootprint";
type Draft = { target: Target; points: Vec2[] };
type VertexDrag = { target: Target; index: number; origin: Vec2; current: Vec2 };

const COLOR_SCENE = 0x607080;
const COLOR_WATER = 0x16253d;
const COLOR_LAND = 0x314c44;
const COLOR_FOOTPRINT = 0xff5c9d;
const COLOR_HANDLE = 0xffc94a;
const COLOR_PREVIEW = 0x74ffa8;
const COLOR_COAST = 0x6ad8d2;

function interactionLayerBase(): any {
  const namespaced = foundry?.canvas?.layers?.InteractionLayer;
  if (namespaced) return namespaced;
  return typeof InteractionLayer === "undefined" ? null : InteractionLayer;
}

/** Convert a zoom-1 size to scene pixels so hit areas and drag thresholds stay constant on screen. */
function screenPx(size: number): number {
  const zoom = canvas?.stage?.scale?.x;
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? size / zoom : size;
}

function terrainOf(city: any): { land: Ring | null; urbanFootprint: Ring | null } {
  const source = city?.source ?? city;
  const terrain = source?.terrain ?? city?.terrain;
  return {
    land: Array.isArray(terrain?.land) ? terrain.land : null,
    urbanFootprint: Array.isArray(terrain?.urbanFootprint) ? terrain.urbanFootprint : null
  };
}

function targetForTool(tool: string | null): Target | null {
  if (tool === TOOL.LAND_DRAW || tool === TOOL.LAND_EDIT) return "land";
  if (tool === TOOL.FOOTPRINT_DRAW || tool === TOOL.FOOTPRINT_EDIT) return "urbanFootprint";
  return null;
}

function isDrawTool(tool: string | null): boolean {
  return tool === TOOL.LAND_DRAW || tool === TOOL.FOOTPRINT_DRAW;
}

function report(label: string, work: Promise<unknown>, then?: () => void): void {
  void work.then(then).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LAYER_NAME} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
  });
}

let activeLayer: any = null;

export async function finishTerrainDraft(): Promise<boolean> {
  const layer = activeLayer as { finishDraft?: () => Promise<boolean> } | null;
  return layer?.finishDraft?.() ?? false;
}

export function cancelTerrainDraft(): void {
  activeLayer?.cancelDraft?.();
  void cancelAdapterTerrainDraft();
}

export function hasTerrainDraft(): boolean {
  return activeLayer?.hasDraft?.() === true;
}

let cached: any = null;

export function nixieLayerClass(): any {
  if (cached !== null) return cached;
  const Base = interactionLayerBase();
  if (!Base) throw new Error("InteractionLayer is unavailable — Foundry's canvas API moved.");

  cached = class NixieLayer extends Base {
    static get layerOptions(): any {
      return Object.assign(super.layerOptions, { name: LAYER_NAME, zIndex: 900 });
    }

    #overlay: any = null;
    #preview: any = null;
    #draft: Draft | null = null;
    #drag: VertexDrag | null = null;
    #panHookId: string | null = null;

    async _draw(options: any): Promise<void> {
      await super._draw(options);
      this.#overlay = this.addChild(new PIXI.Graphics());
      this.#preview = this.addChild(new PIXI.Graphics());
      this.#overlay.eventMode = "none";
      this.#preview.eventMode = "none";
      activeLayer = this;
      setTerrainDraftCancelListener(() => this.cancelDraft());
      this.visible = this.active;
      this.refresh();
    }

    async _tearDown(options: any): Promise<void> {
      if (activeLayer === this) activeLayer = null;
      editorLayerDeactivated(LAYER_NAME);
      this.#unwatchPan();
      setCityListener(null);
      setTerrainDraftCancelListener(null);
      this.#overlay = null;
      this.#preview = null;
      this.#draft = null;
      this.#drag = null;
      return super._tearDown(options);
    }

    _activate(): void {
      activeLayer = this;
      editorLayerActivated(LAYER_NAME);
      setCityListener(() => this.refresh());
      setTerrainDraftCancelListener(() => this.cancelDraft());
      this.#syncDragResistance();
      this.#panHookId ??= Hooks.on("canvasPan", () => this.#syncDragResistance());
      this.visible = true;
      this.refresh();
    }

    _deactivate(): void {
      editorLayerDeactivated(LAYER_NAME);
      this.#unwatchPan();
      setCityListener(null);
      setTerrainDraftCancelListener(null);
      this.#draft = null;
      this.#drag = null;
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

    /** Foundry's drag threshold is scene-space; keep it constant on screen while this layer is active. */
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

    hasDraft(): boolean {
      return this.#draft !== null;
    }

    cancelDraft(): void {
      this.#draft = null;
      this.#drag = null;
      this.#preview?.clear();
      this.refresh();
      notifyEditorInteraction();
    }

    async finishDraft(): Promise<boolean> {
      const draft = this.#draft;
      if (draft === null) return false;
      if (draft.points.length < 3) {
        ui.notifications?.warn("Nixie: a boundary needs at least three vertices.");
        return false;
      }
      const ring = draft.points.map((point) => worldToMetres(point));
      try {
        if (draft.target === "land") await replaceLand(ring);
        else await replaceUrbanFootprint(ring);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ui.notifications?.error(`Nixie: invalid ${draft.target === "land" ? "land" : "urban footprint"} — ${message}`);
        return false;
      }
      this.#draft = null;
      this.#preview?.clear();
      this.refresh();
      notifyEditorInteraction();
      return true;
    }

    refresh(): void {
      const g = this.#overlay;
      if (!g) return;
      g.clear();

      const scene = canvas.dimensions.sceneRect;
      const grid = canvas.dimensions.size;
      const city = getCity();
      g.beginFill(0x070b13, 0.76);
      g.drawRect(scene.x, scene.y, scene.width, scene.height);
      g.endFill();
      g.lineStyle({ width: Math.max(2, grid * 0.06), color: COLOR_SCENE, alpha: 0.85 });
      g.drawRect(scene.x, scene.y, scene.width, scene.height);
      if (!isSceneEnabled() || city === null || !this.active) return;

      const { land, urbanFootprint } = terrainOf(city);
      if (land !== null) {
        g.beginFill(COLOR_WATER, 0.72);
        g.drawRect(scene.x, scene.y, scene.width, scene.height);
        g.endFill();
        this.#drawRing(g, land, COLOR_LAND, 0.78, COLOR_COAST);
      }
      if (urbanFootprint !== null) this.#drawRing(g, urbanFootprint, COLOR_FOOTPRINT, 0.22, COLOR_FOOTPRINT);
      this.#drawHandles(g, land, "land");
      this.#drawHandles(g, urbanFootprint, "urbanFootprint");
      this.#refreshPreview();
    }

    #drawRing(g: any, ring: Ring, fill: number, alpha: number, line: number): void {
      const first = metresToWorld(ring[0]!);
      g.beginFill(fill, alpha);
      g.moveTo(first.x, first.y);
      for (const point of ring.slice(1)) {
        const at = metresToWorld(point);
        g.lineTo(at.x, at.y);
      }
      g.lineTo(first.x, first.y);
      g.endFill();
      g.lineStyle({ width: Math.max(2, canvas.dimensions.size * 0.07), color: line, alpha: 0.95 });
      g.moveTo(first.x, first.y);
      for (const point of ring.slice(1)) {
        const at = metresToWorld(point);
        g.lineTo(at.x, at.y);
      }
      g.lineTo(first.x, first.y);
    }

    #drawHandles(g: any, ring: Ring | null, target: Target): void {
      if (ring === null) return;
      const radius = canvas.dimensions.size * (targetForTool(canvasTool()) === target ? 0.18 : 0.11);
      g.lineStyle(0);
      g.beginFill(target === "land" ? COLOR_HANDLE : COLOR_FOOTPRINT, 0.95);
      for (const point of ring) {
        const at = metresToWorld(point);
        g.drawCircle(at.x, at.y, radius);
      }
      g.endFill();
    }

    #refreshPreview(): void {
      const g = this.#preview;
      if (!g) return;
      g.clear();
      const draft = this.#draft;
      if (draft !== null && draft.points.length > 0) {
        g.lineStyle({ width: Math.max(2, canvas.dimensions.size * 0.06), color: COLOR_PREVIEW, alpha: 0.95 });
        const first = draft.points[0]!;
        g.moveTo(first.x, first.y);
        for (const point of draft.points.slice(1)) g.lineTo(point.x, point.y);
        if (draft.points.length >= 3) g.lineTo(first.x, first.y);
        g.lineStyle(0);
        g.beginFill(COLOR_PREVIEW, 0.95);
        for (const point of draft.points) g.drawCircle(point.x, point.y, canvas.dimensions.size * 0.13);
        g.endFill();
      }
      const drag = this.#drag;
      if (drag !== null) {
        g.lineStyle({ width: Math.max(2, canvas.dimensions.size * 0.06), color: COLOR_PREVIEW, alpha: 0.95 });
        g.moveTo(drag.origin.x, drag.origin.y);
        g.lineTo(drag.current.x, drag.current.y);
        g.lineStyle(0);
        g.beginFill(COLOR_PREVIEW, 0.95);
        g.drawCircle(drag.current.x, drag.current.y, canvas.dimensions.size * 0.16);
        g.endFill();
      }
    }

    #pointer(event: any): Vec2 {
      const point = event.getLocalPosition(canvas.stage);
      return { x: point.x, y: point.y };
    }

    #ringWorld(target: Target): Vec2[] {
      const city = getCity();
      if (city === null) return [];
      const ring = terrainOf(city)[target];
      return ring?.map((point) => metresToWorld(point)) ?? [];
    }

    #nearestVertex(target: Target, point: Vec2): { index: number; at: Vec2 } | null {
      const ring = this.#ringWorld(target);
      const reach = screenPx(canvas.dimensions.size * 0.35);
      let nearest: { index: number; at: Vec2 } | null = null;
      let distance = reach * reach;
      ring.forEach((at, index) => {
        const dx = at.x - point.x;
        const dy = at.y - point.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= distance) {
          distance = d2;
          nearest = { index, at };
        }
      });
      return nearest;
    }

    _canDragLeftStart(): boolean {
      return isSceneEnabled() && getCity() !== null && !isDrawTool(canvasTool()) && targetForTool(canvasTool()) !== null;
    }

    _onDragLeftStart(event: any): void {
      if (!this._canDragLeftStart()) return;
      const target = targetForTool(canvasTool());
      if (target === null) return;
      // WHY: drag start fires only after the drag threshold is crossed, so the pointer has
      // already moved off the vertex — anchor the grab on the original press position instead.
      const origin = event?.interactionData?.origin;
      const point = origin !== undefined && Number.isFinite(origin.x) && Number.isFinite(origin.y)
        ? { x: origin.x, y: origin.y }
        : this.#pointer(event);
      const nearest = this.#nearestVertex(target, point);
      if (nearest === null) return;
      this.#drag = { target, index: nearest.index, origin: nearest.at, current: nearest.at };
      this.#refreshPreview();
    }

    _onDragLeftMove(event: any): void {
      if (this.#drag === null) return;
      this.#drag.current = this.#pointer(event);
      this.#refreshPreview();
    }

    _onDragLeftDrop(event: any): void {
      const drag = this.#drag;
      this.#drag = null;
      this.#refreshPreview();
      if (drag === null) return;
      report("vertex move", moveTerrainVertex(drag.target, drag.index, worldToMetres(this.#pointer(event))), () => this.refresh());
    }

    _onDragLeftCancel(): void {
      this.#drag = null;
      this.#refreshPreview();
    }

    _onClickLeft(event: any): void {
      if (!isSceneEnabled() || getCity() === null) return;
      const tool = canvasTool();
      if (!isDrawTool(tool)) return;
      const target = targetForTool(tool);
      if (target === null) return;
      const point = this.#pointer(event);
      if (this.#draft === null || this.#draft.target !== target) this.#draft = { target, points: [] };
      const first = this.#draft.points[0];
      const closeReach = canvas.dimensions.size * 0.35;
      if (first !== undefined && this.#draft.points.length >= 3) {
        const dx = first.x - point.x;
        const dy = first.y - point.y;
        if (dx * dx + dy * dy <= closeReach * closeReach) {
          void this.finishDraft();
          return;
        }
      }
      this.#draft.points.push(point);
      this.#refreshPreview();
      notifyEditorInteraction();
    }

    _onClickRight(): void {
      cancelTerrainDraft();
    }

    _onDragRightCancel(): void {
      cancelTerrainDraft();
    }

    deleteFootprint(): void {
      report("urban footprint deletion", deleteUrbanFootprint(), () => this.refresh());
    }
  };

  return cached;
}
