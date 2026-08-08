import {
  addCityListener,
  appendRoad,
  cancelRoadDraft as cancelAdapterRoadDraft,
  getCity,
  getRoadSelection,
  isSceneEnabled,
  metresToWorld,
  moveRoadNode,
  pixelsPerMetre,
  selectRoad,
  selectRoadNode,
  setRoadDraftCancelListener,
  weldRoadNodes,
  worldToMetres
} from "../adapter/canvas.js";
import type { Vec2 } from "../core/geom/types.js";
import { ROUTE_CLASS_REGISTRY, type RoadSource, type RouteClassId } from "../core/gen/city.js";
import { compileRouteNetwork } from "../core/graph/compiler.js";
import { canvasTool, editorLayerActivated, editorLayerDeactivated, LAYER_ROADS, notifyEditorInteraction, ROAD_TOOL } from "./editor-state.js";

export const ROAD_LAYER_NAME = LAYER_ROADS;

export { ROAD_TOOL, type RoadTool } from "./editor-state.js";

export type RoadDraftConfig = Partial<{
  classId: RouteClassId;
  curvePreset: "tight" | "standard" | "broad";
  name: string | null;
}>;
type RoadDraft = { points: Vec2[]; classId: RouteClassId; curvePreset: "tight" | "standard" | "broad"; name: string | null };

const COLOR_PREVIEW = 0x74ffa8;
const COLOR_HANDLE = 0xffc94a;
const COLOR_ROAD = 0x6ad8d2;

/** Convert a zoom-1 size to scene pixels so hit areas and drag thresholds stay constant on screen. */
function screenPx(size: number): number {
  const zoom = canvas?.stage?.scale?.x;
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? size / zoom : size;
}

function interactionLayerBase(): any {
  const namespaced = foundry?.canvas?.layers?.InteractionLayer;
  if (namespaced) return namespaced;
  return typeof InteractionLayer === "undefined" ? null : InteractionLayer;
}

function report(label: string, work: Promise<unknown>, then?: () => void): void {
  void work.then(then).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ROAD_LAYER_NAME} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
  });
}

let activeLayer: any = null;

export function finishRoadDraft(): Promise<boolean> {
  const layer = activeLayer as { finishDraft?: () => Promise<boolean> } | null;
  return layer?.finishDraft?.() ?? Promise.resolve(false);
}

export function cancelRoadDraft(): void {
  cancelAdapterRoadDraft();
}

export function hasRoadDraft(): boolean {
  return activeLayer?.hasDraft?.() === true;
}

export function configureRoadDraft(config: RoadDraftConfig): void {
  activeLayer?.configureRoadDraft?.(config);
}

export function roadLayerClass(): any {
  const Base = interactionLayerBase();
  if (!Base) throw new Error("InteractionLayer is unavailable — Foundry's canvas API moved.");

  return class NixieRoadLayer extends Base {
    static get layerOptions(): any {
      return Object.assign(super.layerOptions, { name: ROAD_LAYER_NAME, zIndex: 910 });
    }

    #overlay: any = null;
    #preview: any = null;
    #roadDraft: RoadDraft | null = null;
    #finishing = false;
    #roadDrag: { nodeId: string; origin: Vec2; current: Vec2 } | null = null;
    #removeCityListener: (() => void) | null = null;
    #panHookId: string | null = null;

    async _draw(options: any): Promise<void> {
      await super._draw(options);
      this.#overlay = this.addChild(new PIXI.Graphics());
      this.#preview = this.addChild(new PIXI.Graphics());
      this.#overlay.eventMode = "none";
      this.#preview.eventMode = "none";
      activeLayer = this;
      if (this.active) this.#removeCityListener ??= addCityListener(() => this.refresh());
      setRoadDraftCancelListener(() => this.cancelDraft());
      this.visible = this.active;
      this.refresh();
    }

    async _tearDown(options: any): Promise<void> {
      if (activeLayer === this) activeLayer = null;
      editorLayerDeactivated(ROAD_LAYER_NAME);
      this.#unwatchPan();
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      setRoadDraftCancelListener(null);
      this.#overlay = null;
      this.#preview = null;
      this.#roadDraft = null;
      this.#roadDrag = null;
      return super._tearDown(options);
    }

    _activate(): void {
      activeLayer = this;
      editorLayerActivated(ROAD_LAYER_NAME);
      this.#removeCityListener ??= addCityListener(() => this.refresh());
      setRoadDraftCancelListener(() => this.cancelDraft());
      this.#syncDragResistance();
      this.#panHookId ??= Hooks.on("canvasPan", () => this.#syncDragResistance());
      this.visible = true;
      this.refresh();
    }

    _deactivate(): void {
      editorLayerDeactivated(ROAD_LAYER_NAME);
      this.#unwatchPan();
      this.#removeCityListener?.();
      this.#removeCityListener = null;
      setRoadDraftCancelListener(null);
      this.#roadDraft = null;
      this.#roadDrag = null;
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
      return (this.#roadDraft?.points.length ?? 0) > 0;
    }

    configureRoadDraft(config: RoadDraftConfig): void {
      if (this.#roadDraft === null) this.#roadDraft = { points: [], classId: "street", curvePreset: "standard", name: null };
      this.#roadDraft = { ...this.#roadDraft, ...config };
      this.#refreshPreview();
    }

    cancelDraft(): void {
      this.#roadDraft = null;
      this.#roadDrag = null;
      this.#preview?.clear();
      this.refresh();
      notifyEditorInteraction();
    }

    async finishDraft(): Promise<boolean> {
      const draft = this.#roadDraft;
      if (draft === null) return false;
      if (this.#finishing) return false;
      if (draft.points.length < 2) {
        ui.notifications?.warn("Nixie: a road needs at least two anchors.");
        return false;
      }
      this.#finishing = true;
      try {
        await appendRoad(draft.points.map(worldToMetres), draft.classId, draft.curvePreset, draft.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ui.notifications?.error(`Nixie: invalid road — ${message}`);
        return false;
      } finally {
        this.#finishing = false;
      }
      if (this.#roadDraft === draft) this.#roadDraft = null;
      this.#preview?.clear();
      this.refresh();
      notifyEditorInteraction();
      return true;
    }

    refresh(): void {
      const g = this.#overlay;
      if (!g) return;
      g.clear();
      if (!isSceneEnabled() || getCity() === null || !this.active) return;
      this.#drawRoads(g);
      this.#refreshPreview();
    }

    #drawRoads(g: any): void {
      const city = getCity();
      if (city === null) return;
      const selected = new Set(getRoadSelection().edgeIds);
      let network;
      try {
        network = compileRouteNetwork(city.source.roads);
      } catch {
        return;
      }
      for (const span of network.segments) {
        const from = metresToWorld(span.a);
        const to = metresToWorld(span.b);
        g.lineStyle({
          width: Math.max(2, span.widthM * pixelsPerMetre()),
          color: selected.has(span.edgeId) ? COLOR_PREVIEW : COLOR_ROAD,
          alpha: selected.has(span.edgeId) ? 0.9 : 0.5
        });
        g.moveTo(from.x, from.y);
        g.lineTo(to.x, to.y);
      }
      g.lineStyle(0);
      g.beginFill(COLOR_HANDLE, 0.95);
      const handleRadius = Math.max(3, canvas.dimensions.size * 0.12);
      for (const node of city.source.roads.nodes) {
        const at = metresToWorld(node);
        g.drawCircle(at.x, at.y, handleRadius);
      }
      g.endFill();
    }

    #refreshPreview(): void {
      const g = this.#preview;
      if (!g) return;
      g.clear();
      const draft = this.#roadDraft;
      if (draft !== null && draft.points.length > 0) {
        const source: RoadSource = {
          nodes: draft.points.map((point, index) => ({ id: `draft-node-${index}`, ...worldToMetres(point) })),
          routes: [{ id: "draft-route", curvePreset: draft.curvePreset }],
          edges: draft.points.slice(1).map((_point, index) => ({ id: `draft-edge-${index}`, a: `draft-node-${index}`, b: `draft-node-${index + 1}`, routeId: "draft-route", classId: draft.classId, name: draft.name, locked: false, origin: "authored" as const }))
        };
        let network;
        try {
          network = compileRouteNetwork(source);
        } catch {
          network = null;
        }
        const cls = ROUTE_CLASS_REGISTRY.get(draft.classId);
        g.lineStyle({ width: Math.max(2, (cls?.widthM ?? 6) * pixelsPerMetre()), color: COLOR_PREVIEW, alpha: 0.72 });
        for (const span of network?.segments ?? []) {
          const from = metresToWorld(span.a);
          const to = metresToWorld(span.b);
          g.moveTo(from.x, from.y);
          g.lineTo(to.x, to.y);
        }
        g.lineStyle(0);
        g.beginFill(COLOR_PREVIEW, 0.95);
        const anchorRadius = canvas.dimensions.size * 0.13;
        for (const point of draft.points) g.drawCircle(point.x, point.y, anchorRadius);
        g.endFill();
      }
      const drag = this.#roadDrag;
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

    #nearestRoadNode(point: Vec2, excludeId: string | null = null): { id: string; at: Vec2 } | null {
      const city = getCity();
      if (city === null) return null;
      const reach = screenPx(canvas.dimensions.size * 0.45);
      let nearest: { id: string; at: Vec2 } | null = null;
      let distance = reach * reach;
      for (const node of city.source.roads.nodes) {
        if (node.id === excludeId) continue;
        const at = metresToWorld(node);
        const dx = at.x - point.x;
        const dy = at.y - point.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= distance) {
          distance = d2;
          nearest = { id: node.id, at };
        }
      }
      return nearest;
    }

    #nearestRoadEdge(point: Vec2): string | null {
      const city = getCity();
      if (city === null) return null;
      let network;
      try {
        network = compileRouteNetwork(city.source.roads);
      } catch {
        return null;
      }
      let best: string | null = null;
      let distance = screenPx(canvas.dimensions.size * 0.45);
      for (const span of network.segments) {
        const from = metresToWorld(span.a);
        const to = metresToWorld(span.b);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const lengthSq = dx * dx + dy * dy;
        const u = lengthSq > 0 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq)) : 0;
        const px = from.x + dx * u;
        const py = from.y + dy * u;
        const distanceHere = Math.hypot(point.x - px, point.y - py);
        if (distanceHere <= distance) {
          distance = distanceHere;
          best = span.edgeId;
        }
      }
      return best;
    }

    _canDragLeftStart(): boolean {
      return canvasTool() === ROAD_TOOL.EDIT && isSceneEnabled() && getCity() !== null;
    }

    _onDragLeftStart(event: any): void {
      if (!this._canDragLeftStart()) return;
      // WHY: drag start fires only after the drag threshold is crossed, so the pointer has
      // already moved off the node — anchor the grab on the original press position instead.
      const origin = event?.interactionData?.origin;
      const point = origin !== undefined && Number.isFinite(origin.x) && Number.isFinite(origin.y)
        ? { x: origin.x, y: origin.y }
        : this.#pointer(event);
      const nearest = this.#nearestRoadNode(point);
      if (nearest === null) return;
      this.#roadDrag = { nodeId: nearest.id, origin: nearest.at, current: nearest.at };
      this.#refreshPreview();
    }

    _onDragLeftMove(event: any): void {
      if (this.#roadDrag === null) return;
      this.#roadDrag.current = this.#pointer(event);
      this.#refreshPreview();
    }

    _onDragLeftDrop(event: any): void {
      if (this.#roadDrag === null) return;
      const drag = this.#roadDrag;
      this.#roadDrag = null;
      this.#refreshPreview();
      const at = this.#pointer(event);
      const target = this.#nearestRoadNode(at, drag.nodeId);
      if (target !== null) {
        report("road weld", weldRoadNodes(drag.nodeId, target.id), () => this.refresh());
        return;
      }
      report("road anchor move", moveRoadNode(drag.nodeId, worldToMetres(at)), () => this.refresh());
    }

    _onDragLeftCancel(): void {
      this.#roadDrag = null;
      this.#refreshPreview();
    }

    _onClickLeft(event: any): void {
      if (!isSceneEnabled() || getCity() === null) return;
      const tool = canvasTool();
      if (tool === ROAD_TOOL.SELECT) {
        const edgeId = this.#nearestRoadEdge(this.#pointer(event));
        if (edgeId !== null) selectRoad(edgeId, Boolean(event.shiftKey || event.data?.originalEvent?.shiftKey));
        return;
      }
      if (tool === ROAD_TOOL.EDIT) {
        const node = this.#nearestRoadNode(this.#pointer(event));
        if (node !== null) selectRoadNode(node.id, Boolean(event.shiftKey || event.data?.originalEvent?.shiftKey));
        return;
      }
      if (tool !== ROAD_TOOL.DRAW) return;
      const point = this.#pointer(event);
      if (this.#roadDraft === null) this.#roadDraft = { points: [], classId: "street", curvePreset: "standard", name: null };
      const connecting = this.#roadDraft.points.length > 0 && (this.#nearestRoadNode(point) !== null || this.#nearestRoadEdge(point) !== null);
      this.#roadDraft.points.push(point);
      this.#refreshPreview();
      notifyEditorInteraction();
      const original = event.data?.originalEvent ?? event;
      if (original.detail >= 2 || connecting) void this.finishDraft();
    }

    _onClickLeft2(): void {
      if (canvasTool() === ROAD_TOOL.DRAW && this.#roadDraft !== null) void this.finishDraft();
    }

    _onClickRight(): void {
      if (canvasTool() === ROAD_TOOL.DRAW && this.#roadDraft !== null && this.#roadDraft.points.length > 0) {
        this.#roadDraft.points.pop();
        this.#refreshPreview();
        notifyEditorInteraction();
        return;
      }
      cancelRoadDraft();
    }

    _onDragRightCancel(): void {
      cancelRoadDraft();
    }
  };
}
