import {
  createZone,
  drawRoad,
  eraseAt,
  getCity,
  isMounted,
  junctionAt,
  metresToWorld,
  moveJunction,
  pixelsPerMetre,
  reseedZoneAt,
  setCityListener,
  snapRoadPoint,
  snapWorldPoint,
  toggleParkedCarsAt,
  toggleWalkwayAt
} from "../adapter/canvas.js";
import type { Vec2 } from "../core/geom/types.js";
import { classMap, incidentEdges, nodeMap } from "../core/graph/road-graph.js";

/** Must match the key this layer is registered under in `CONFIG.Canvas.layers`. */
export const LAYER_NAME = "nixie";

/** Non-road tools. Road tools are named after the road class they draw. */
export const TOOL = {
  EDIT: "edit",
  WALKWAY: "walkway",
  PARKING: "parking",
  ZONE: "zone",
  ERASE: "erase"
} as const;

const COLOR_ROAD = 0x63ccff;
const COLOR_PAVEMENT = 0x9a8cff;
const COLOR_PARKING_OFF = 0xff5c6a;
const COLOR_NODE = 0xffc94a;
const COLOR_ZONE = 0xff5c9d;
const COLOR_PREVIEW = 0x74ffa8;

/** Points are world pixels throughout — the adapter converts to metres at the core boundary. */
type Drag =
  | { kind: "road"; classId: string; origin: Vec2; current: Vec2 }
  | { kind: "node"; nodeId: string; origin: Vec2; current: Vec2 }
  | { kind: "zone"; origin: Vec2; current: Vec2 };

/** Surface an edit failure rather than leaving an unhandled rejection in the console. */
function report<T>(label: string, work: Promise<T>, then?: (result: T) => void): void {
  void work.then(then).catch((err) => {
    console.error(`${LAYER_NAME} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${err.message}`);
  });
}

/** A tool named after a road class draws that class. */
function roadClassForTool(tool: string): string | null {
  const city = getCity();
  if (city === null) return null;
  return city.graph.classes.some((c) => c.id === tool) ? tool : null;
}

/**
 * WHY: v12 declares this as a top-level `class` in a classic script, which creates a
 * global *lexical* binding — readable as a bare identifier, never present on globalThis.
 * v13/v14 namespace it instead and have no such global. Reaching for `globalThis` here
 * silently yields undefined on v12 and kills the init hook.
 */
function interactionLayerBase(): any {
  const namespaced = foundry?.canvas?.layers?.InteractionLayer;
  if (namespaced) return namespaced;
  return typeof InteractionLayer === "undefined" ? null : InteractionLayer;
}

let cached: any = null;

/**
 * Built at `init` rather than at import: the class extends a Foundry global, and a
 * top-level `extends` would evaluate before that global is guaranteed to exist.
 */
export function nixieLayerClass(): any {
  if (cached !== null) return cached;
  const Base = interactionLayerBase();
  if (!Base) throw new Error("InteractionLayer is unavailable — Foundry's canvas API moved.");

  cached = class NixieLayer extends Base {
    static get layerOptions(): any {
      // Above the placeable layers so the editor overlay is never buried by walls or notes.
      return Object.assign(super.layerOptions, { name: LAYER_NAME, zIndex: 900 });
    }

    #overlay: any = null;
    #preview: any = null;
    #drag: Drag | null = null;

    async _draw(options: any): Promise<void> {
      await super._draw(options);
      this.#overlay = this.addChild(new PIXI.Graphics());
      this.#preview = this.addChild(new PIXI.Graphics());
      this.#overlay.eventMode = "none";
      this.#preview.eventMode = "none";
      this.visible = this.active;
      this.refresh();
    }

    async _tearDown(options: any): Promise<void> {
      setCityListener(null);
      this.#overlay = null;
      this.#preview = null;
      this.#drag = null;
      return super._tearDown(options);
    }

    _activate(): void {
      setCityListener(() => this.refresh());
      this.visible = true;
      this.refresh();
    }

    _deactivate(): void {
      setCityListener(null);
      this.#drag = null;
      this.#preview?.clear();
      this.visible = false;
    }

    /** Redraw the params overlay: what the city is made of, not what it renders as. */
    refresh(): void {
      const g = this.#overlay;
      if (!g) return;
      g.clear();

      const city = getCity();
      if (city === null || !this.active) return;

      const grid = canvas.dimensions.size;
      const ppm = pixelsPerMetre();
      const nodes = nodeMap(city.graph);
      const classes = classMap(city.graph);

      // Params are metres; PIXI draws in world pixels.
      for (const zone of city.zones) {
        const at = metresToWorld({ x: zone.rect.x, y: zone.rect.y });
        g.lineStyle({ width: grid * 0.06, color: COLOR_ZONE, alpha: 0.85 });
        g.beginFill(COLOR_ZONE, 0.05);
        g.drawRect(at.x, at.y, zone.rect.width * ppm, zone.rect.height * ppm);
        g.endFill();
      }

      for (const edge of city.graph.edges) {
        const from = nodes.get(edge.a);
        const to = nodes.get(edge.b);
        if (!from || !to) continue;
        const a = metresToWorld(from);
        const b = metresToWorld(to);
        const roadClass = classes.get(edge.classId);
        const widthM = roadClass?.widthM ?? 6;
        const sidewalkM = edge.sidewalks === false ? 0 : (roadClass?.sidewalkM ?? 0);

        // Pavement drawn underneath, so the walkway toggle is visible in the overlay.
        if (sidewalkM > 0) {
          g.lineStyle({ width: (widthM + sidewalkM * 2) * ppm, color: COLOR_PAVEMENT, alpha: 0.12 });
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        g.lineStyle({ width: widthM * ppm, color: COLOR_ROAD, alpha: 0.16 });
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.lineStyle({ width: grid * 0.035, color: COLOR_ROAD, alpha: 0.8 });
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        if (game.activeTool === TOOL.PARKING && edge.parkedCars === false) {
          g.lineStyle({ width: grid * 0.08, color: COLOR_PARKING_OFF, alpha: 0.9 });
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
      }

      // Fatter handles while the edit tool is out, because they become grab targets.
      const handle = game.activeTool === TOOL.EDIT ? grid * 0.14 : grid * 0.09;
      g.lineStyle(0);
      g.beginFill(COLOR_NODE, 0.95);
      for (const node of city.graph.nodes) {
        const at = metresToWorld(node);
        g.drawCircle(at.x, at.y, handle);
      }
      g.endFill();
    }

    #refreshPreview(): void {
      const g = this.#preview;
      if (!g) return;
      g.clear();

      const drag = this.#drag;
      if (drag === null) return;
      const grid = canvas.dimensions.size;

      if (drag.kind === "zone") {
        const x = Math.min(drag.origin.x, drag.current.x);
        const y = Math.min(drag.origin.y, drag.current.y);
        g.lineStyle({ width: grid * 0.06, color: COLOR_PREVIEW, alpha: 0.9 });
        g.beginFill(COLOR_PREVIEW, 0.08);
        g.drawRect(x, y, Math.abs(drag.current.x - drag.origin.x), Math.abs(drag.current.y - drag.origin.y));
        g.endFill();
        return;
      }

      const city = getCity();

      if (drag.kind === "node") {
        if (city !== null) {
          const nodes = nodeMap(city.graph);
          g.lineStyle({ width: grid * 0.05, color: COLOR_PREVIEW, alpha: 0.9 });
          for (const edge of incidentEdges(city.graph, drag.nodeId)) {
            const other = nodes.get(edge.a === drag.nodeId ? edge.b : edge.a);
            if (!other) continue;
            const at = metresToWorld(other);
            g.moveTo(at.x, at.y);
            g.lineTo(drag.current.x, drag.current.y);
          }
        }
        g.lineStyle(0);
        g.beginFill(COLOR_PREVIEW, 0.95);
        g.drawCircle(drag.current.x, drag.current.y, grid * 0.15);
        g.endFill();
        return;
      }

      const widthM = city?.graph.classes.find((c) => c.id === drag.classId)?.widthM ?? 9;
      g.lineStyle({ width: widthM * pixelsPerMetre(), color: COLOR_PREVIEW, alpha: 0.3 });
      g.moveTo(drag.origin.x, drag.origin.y);
      g.lineTo(drag.current.x, drag.current.y);
      g.lineStyle({ width: grid * 0.04, color: COLOR_PREVIEW, alpha: 0.95 });
      g.moveTo(drag.origin.x, drag.origin.y);
      g.lineTo(drag.current.x, drag.current.y);
      g.lineStyle(0);
      g.beginFill(COLOR_PREVIEW, 0.95);
      g.drawCircle(drag.origin.x, drag.origin.y, grid * 0.1);
      g.drawCircle(drag.current.x, drag.current.y, grid * 0.1);
      g.endFill();
    }

    #pointer(event: any): Vec2 {
      const p = event.getLocalPosition(canvas.stage);
      return { x: p.x, y: p.y };
    }

    _canDragLeftStart(): boolean {
      return isMounted();
    }

    _onDragLeftStart(event: any): void {
      if (!isMounted()) return;
      const tool = game.activeTool;
      const point = this.#pointer(event);
      const classId = roadClassForTool(tool);

      if (tool === TOOL.ZONE) {
        const snapped = snapWorldPoint(point);
        this.#drag = { kind: "zone", origin: snapped, current: snapped };
      } else if (tool === TOOL.EDIT) {
        const node = junctionAt(point);
        if (node === null) return;
        const at = metresToWorld(node);
        this.#drag = { kind: "node", nodeId: node.id, origin: at, current: at };
      } else if (classId !== null) {
        const snapped = snapRoadPoint(point);
        this.#drag = { kind: "road", classId, origin: snapped, current: snapped };
      } else {
        return;
      }
      this.#refreshPreview();
    }

    _onDragLeftMove(event: any): void {
      const drag = this.#drag;
      if (drag === null) return;
      const point = this.#pointer(event);
      // A dragged junction snaps to the grid only. Snapping it to the graph would pin it
      // to its own incident roads and it would never move.
      drag.current = drag.kind === "road" ? snapRoadPoint(point) : snapWorldPoint(point);
      this.#refreshPreview();
    }

    _onDragLeftDrop(event: any): void {
      const drag = this.#drag;
      this.#drag = null;
      this.#preview?.clear();
      if (drag === null) return;
      const point = this.#pointer(event);

      if (drag.kind === "zone") {
        const end = snapWorldPoint(point);
        const rect = {
          x: drag.origin.x,
          y: drag.origin.y,
          width: end.x - drag.origin.x,
          height: end.y - drag.origin.y
        };
        report("zone create", createZone(rect), (zone) => {
          if (zone === null) ui.notifications?.warn("Nixie: zone too small.");
        });
        return;
      }
      if (drag.kind === "node") {
        report("junction move", moveJunction(drag.nodeId, snapWorldPoint(point)));
        return;
      }
      report("road draw", drawRoad(drag.origin, snapRoadPoint(point), drag.classId));
    }

    _onDragLeftCancel(): void {
      this.#drag = null;
      this.#preview?.clear();
    }

    _onClickLeft(event: any): void {
      if (!isMounted()) return;
      const point = this.#pointer(event);

      switch (game.activeTool) {
        case TOOL.ERASE:
          report("erase", eraseAt(point), (removed) => {
            if (removed === null) ui.notifications?.info("Nixie: nothing to erase here.");
          });
          return;
        case TOOL.WALKWAY:
          report("walkway toggle", toggleWalkwayAt(point), (hit) => {
            if (!hit) ui.notifications?.info("Nixie: no road under the cursor.");
          });
          return;
        case TOOL.PARKING:
          report("parked-car toggle", toggleParkedCarsAt(point), (hit) => {
            if (!hit) ui.notifications?.info("Nixie: no road under the cursor.");
          });
          return;
        case TOOL.ZONE:
          report("reseed", reseedZoneAt(point), (zone) => {
            if (zone === null) ui.notifications?.info("Nixie: drag to draw a zone.");
          });
          return;
        default:
          return;
      }
    }
  };

  return cached;
}
