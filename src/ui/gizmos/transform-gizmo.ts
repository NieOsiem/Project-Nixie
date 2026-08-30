import type { PlacementFrame } from "../../core/gen/city.js";
import type { Ring, Vec2 } from "../../core/geom/types.js";

/** Direct-manipulation operation exposed by a transform gizmo. */
export type GizmoAction = "translate" | "rotate" | "resize-width" | "resize-depth" | "vertex";

export interface TransformGizmoSnapshot {
  placement: PlacementFrame;
  sitePolygon: Ring | null;
  action: GizmoAction | null;
  vertexIndex: number | null;
}

export interface TransformGizmoObject {
  /** The object kind controls which controls are offered. Places are fixed-size in Phase 5. */
  kind: "building" | "place";
  placement: PlacementFrame;
  sitePolygon?: Ring | null;
  fixedDimensions?: boolean;
}

export interface TransformGizmoOptions {
  kind: "building" | "place";
  placement: PlacementFrame;
  sitePolygon?: Ring | null;
  /** Explicitly suppress resize controls (useful for a fixed-dimension building grammar). */
  fixedDimensions?: boolean;
  /** Relative angle of the frontage handle in the placement frame. Defaults to the width axis. */
  frontageOffsetRad?: number;
  /** Minimum width/depth accepted by local provisional resize math. */
  minDimension?: number;
  /** Scene/canvas zoom. A getter is useful while the canvas is panned or zoomed. */
  zoom?: number | (() => number);
  enabled?: boolean;
  visible?: boolean;
  onPreview?: (state: TransformGizmoSnapshot) => void;
  onCommit?: (state: TransformGizmoSnapshot) => void | Promise<void>;
  onCancel?: (state: TransformGizmoSnapshot) => void;
}

export interface TransformGizmoControl {
  readonly gizmoAction: GizmoAction;
  readonly vertexIndex: number | null;
  /** Human-readable metadata is deliberately duplicated for Foundry/PIXI versions. */
  readonly gizmoLabel: string;
  eventMode?: string;
  cursor?: string;
  hitArea?: unknown;
  accessible?: boolean;
  accessibleTitle?: string;
  accessibleHint?: string;
  ariaLabel?: string;
  label?: string;
  title?: string;
  destroy?: (options?: unknown) => void;
  on?: (event: string, callback: (event: unknown) => void) => unknown;
  off?: (event: string, callback: (event: unknown) => void) => unknown;
  [key: string]: unknown;
}

interface DisplayObjectLike {
  visible?: boolean;
  eventMode?: string;
  interactiveChildren?: boolean;
  accessible?: boolean;
  label?: string;
  ariaLabel?: string;
  addChild<T>(child: T): T;
  removeChild<T>(child: T): T;
  destroy(options?: unknown): void;
}

interface PixiNamespace {
  Container?: new () => DisplayObjectLike;
  Graphics?: new () => TransformGizmoControl;
  Circle?: new (x: number, y: number, radius: number) => unknown;
}

interface DragState {
  action: GizmoAction;
  vertexIndex: number | null;
  startPointer: Vec2;
  start: TransformGizmoSnapshot;
}

interface FallbackListener {
  callback: (event: unknown) => void;
}

/** A tiny PIXI-compatible fallback keeps pure math and lifecycle tests DOM/Foundry-free. */
class FallbackGraphics {
  eventMode = "none";
  interactive = false;
  visible = true;
  alpha = 1;
  cursor = "default";
  hitArea: unknown;
  position = {
    x: 0,
    y: 0,
    set: (x: number, y: number): void => {
      this.position.x = x;
      this.position.y = y;
    }
  };
  private readonly listeners = new Map<string, FallbackListener[]>();
  clear(): this { return this; }
  beginFill(): this { return this; }
  endFill(): this { return this; }
  lineStyle(): this { return this; }
  drawCircle(): this { return this; }
  drawRect(): this { return this; }
  moveTo(): this { return this; }
  lineTo(): this { return this; }
  on(event: string, callback: (event: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push({ callback });
    this.listeners.set(event, listeners);
    return this;
  }
  off(event: string, callback: (event: unknown) => void): this {
    const listeners = this.listeners.get(event);
    if (listeners !== undefined) this.listeners.set(event, listeners.filter((entry) => entry.callback !== callback));
    return this;
  }
  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener.callback(payload);
  }
  destroy(): void { this.listeners.clear(); }
}

class FallbackContainer implements DisplayObjectLike {
  readonly children: unknown[] = [];
  visible = true;
  eventMode = "none";
  interactiveChildren = true;
  addChild<T>(child: T): T {
    this.children.push(child);
    return child;
  }
  removeChild<T>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
  destroy(): void { this.children.length = 0; }
}

function pixi(): PixiNamespace | null {
  try {
    return typeof PIXI === "undefined" ? null : PIXI as unknown as PixiNamespace;
  } catch {
    return null;
  }
}

const ContainerBase = (pixi()?.Container ?? FallbackContainer) as new () => DisplayObjectLike;

function graphics(): TransformGizmoControl {
  const namespace = pixi();
  if (namespace?.Graphics !== undefined) return new namespace.Graphics();
  return new FallbackGraphics() as unknown as TransformGizmoControl;
}

function clonePoint(point: Vec2): Vec2 {
  return { x: point.x, y: point.y };
}

export function clonePlacement(placement: PlacementFrame): PlacementFrame {
  return {
    centre: clonePoint(placement.centre),
    rotationRad: placement.rotationRad,
    widthM: placement.widthM,
    depthM: placement.depthM
  };
}

export function cloneSnapshot(state: TransformGizmoSnapshot): TransformGizmoSnapshot {
  return {
    placement: clonePlacement(state.placement),
    sitePolygon: state.sitePolygon?.map(clonePoint) ?? null,
    action: state.action,
    vertexIndex: state.vertexIndex
  };
}

/** Convert a zoom-1 radius to canvas coordinates while keeping the hit target screen-sized. */
export function zoomHitRadius(radius: number, zoom = 1): number {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return safeRadius / safeZoom;
}

export const hitRadius = zoomHitRadius;

function finiteZoom(value: number | (() => number) | undefined): number {
  const candidate = typeof value === "function" ? value() : value;
  return Number.isFinite(candidate) && candidate !== undefined && candidate > 0 ? candidate : 1;
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function localToWorld(centre: Vec2, rotationRad: number, local: Vec2): Vec2 {
  const cosine = Math.cos(rotationRad);
  const sine = Math.sin(rotationRad);
  return {
    x: centre.x + local.x * cosine - local.y * sine,
    y: centre.y + local.x * sine + local.y * cosine
  };
}

export function worldToLocal(centre: Vec2, rotationRad: number, world: Vec2): Vec2 {
  const cosine = Math.cos(rotationRad);
  const sine = Math.sin(rotationRad);
  const delta = subtract(world, centre);
  return {
    x: delta.x * cosine + delta.y * sine,
    y: -delta.x * sine + delta.y * cosine
  };
}

export function translatePlacement(placement: PlacementFrame, delta: Vec2): PlacementFrame {
  return { ...clonePlacement(placement), centre: add(placement.centre, delta) };
}

function shortestAngle(delta: number): number {
  const turn = Math.PI * 2;
  return ((delta + Math.PI) % turn + turn) % turn - Math.PI;
}

/** Rotate from one frontage handle position to another without accumulating angle drift. */
export function rotatePlacement(
  placement: PlacementFrame,
  startPointer: Vec2,
  pointer: Vec2,
  frontageOffsetRad = 0
): PlacementFrame {
  const before = subtract(startPointer, placement.centre);
  const after = subtract(pointer, placement.centre);
  if (before.x * before.x + before.y * before.y < Number.EPSILON || after.x * after.x + after.y * after.y < Number.EPSILON) {
    return clonePlacement(placement);
  }
  const delta = shortestAngle(
    (Math.atan2(after.y, after.x) - frontageOffsetRad) - (Math.atan2(before.y, before.x) - frontageOffsetRad)
  );
  return { ...clonePlacement(placement), rotationRad: placement.rotationRad + delta };
}

export type ResizeAction = "resize-width" | "resize-depth";

export function resizePlacement(
  placement: PlacementFrame,
  action: ResizeAction,
  startPointer: Vec2,
  pointer: Vec2,
  minDimension = 1
): PlacementFrame {
  const safeMinimum = Number.isFinite(minDimension) && minDimension > 0 ? minDimension : 1;
  const movement = subtract(pointer, startPointer);
  const localMovement = worldToLocal({ x: 0, y: 0 }, placement.rotationRad, movement);
  const next = clonePlacement(placement);
  if (action === "resize-width") next.widthM = Math.max(safeMinimum, placement.widthM + localMovement.x * 2);
  else next.depthM = Math.max(safeMinimum, placement.depthM + localMovement.y * 2);
  return next;
}


/** Apply a placement-frame transform to the existing site without introducing vertices. */
export function transformSitePolygon(sitePolygon: Ring, before: PlacementFrame, after: PlacementFrame): Ring {
  if (!Number.isFinite(before.widthM) || before.widthM <= 0 || !Number.isFinite(before.depthM) || before.depthM <= 0) {
    return sitePolygon.map(clonePoint);
  }
  const scaleX = after.widthM / before.widthM;
  const scaleY = after.depthM / before.depthM;
  return sitePolygon.map((point) => {
    const local = worldToLocal(before.centre, before.rotationRad, point);
    return localToWorld(after.centre, after.rotationRad, { x: local.x * scaleX, y: local.y * scaleY });
  });
}
export function moveSiteVertex(ring: Ring, index: number, point: Vec2): Ring {
  return ring.map((vertex, current) => current === index ? clonePoint(point) : clonePoint(vertex));
}

function circleHitArea(radius: number): unknown {
  const Circle = pixi()?.Circle;
  if (Circle !== undefined) return new Circle(0, 0, radius);
  return {
    x: 0,
    y: 0,
    radius,
    contains(x: number, y: number): boolean {
      return x * x + y * y <= radius * radius;
    }
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? value as UnknownRecord : null;
}

function setProperty(target: object, key: string, value: unknown): void {
  (target as unknown as UnknownRecord)[key] = value;
}

function setPosition(control: TransformGizmoControl, point: Vec2): void {
  const position = asRecord(control.position);
  const set = position?.set;
  if (typeof set === "function") set.call(position, point.x, point.y);
  else setProperty(control, "position", { x: point.x, y: point.y });
  setProperty(control, "x", point.x);
  setProperty(control, "y", point.y);
}

function invokeGraphics(graphic: object, name: string, ...args: unknown[]): void {
  const method = (graphic as unknown as UnknownRecord)[name];
  if (typeof method === "function") method.apply(graphic, args);
}

function drawLine(graphic: object, a: Vec2, b: Vec2): void {
  invokeGraphics(graphic, "moveTo", a.x, a.y);
  invokeGraphics(graphic, "lineTo", b.x, b.y);
}

function pointLike(value: unknown): Vec2 | null {
  const record = asRecord(value);
  const x = record?.x;
  const y = record?.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function pointFromEvent(event: unknown, parent: object): Vec2 | null {
  const record = asRecord(event);
  const data = asRecord(record?.data);
  const interactionData = asRecord(record?.interactionData);
  const candidates = [record?.global, data?.global, interactionData?.global];
  for (const candidate of candidates) {
    const point = pointLike(candidate);
    if (point !== null) return point;
  }
  const getLocalPosition = record?.getLocalPosition ?? data?.getLocalPosition;
  if (typeof getLocalPosition === "function") {
    const point = getLocalPosition.call(data ?? record, parent);
    const local = pointLike(point);
    if (local !== null) return local;
  }
  const clientX = record?.clientX;
  const clientY = record?.clientY;
  if (typeof clientX === "number" && typeof clientY === "number" && Number.isFinite(clientX) && Number.isFinite(clientY)) {
    return { x: clientX, y: clientY };
  }
  return null;
}

function labelFor(action: GizmoAction, vertexIndex: number | null): string {
  if (action === "translate") return "Move object";
  if (action === "rotate") return "Rotate object frontage";
  if (action === "resize-width") return "Resize object width";
  if (action === "resize-depth") return "Resize object depth";
  return `Move site vertex ${Math.max(0, (vertexIndex ?? 0) + 1)}`;
}

function setControlMetadata(control: TransformGizmoControl, action: GizmoAction, vertexIndex: number | null, enabled: boolean): void {
  const label = labelFor(action, vertexIndex);
  setProperty(control, "gizmoAction", action);
  setProperty(control, "vertexIndex", vertexIndex);
  setProperty(control, "gizmoLabel", label);
  setProperty(control, "name", `nixie-gizmo-${action}${vertexIndex === null ? "" : `-${vertexIndex}`}`);
  control.eventMode = enabled ? "static" : "none";
  setProperty(control, "interactive", enabled);
  control.cursor = enabled ? "pointer" : "default";
  control.accessible = true;
  control.accessibleTitle = label;
  control.accessibleHint = "Drag to adjust. Release to commit; cancel restores the previous value.";
  control.ariaLabel = label;
  control.label = label;
  control.title = label;
  setProperty(control, "data-tooltip", label);
  setProperty(control, "aria-disabled", enabled ? "false" : "true");
  control.hitArea = circleHitArea(1);
}

/**
 * PIXI controller for direct object manipulation. The controller never calls an adapter itself:
 * preview callbacks are local and the single commit callback is invoked once on pointer release.
 */
export class TransformGizmo extends ContainerBase {
  readonly controls = new Map<string, TransformGizmoControl>();
  private readonly options: TransformGizmoOptions;
  private placement: PlacementFrame;
  private sitePolygon: Ring | null;
  private drag: DragState | null = null;
  private provisional: TransformGizmoSnapshot | null = null;
  private destroyed = false;
  private readonly bindings: Array<{ target: TransformGizmoControl; event: string; callback: (event: unknown) => void }> = [];

  constructor(options: TransformGizmoOptions) {
    super();
    this.options = { ...options };
    this.placement = clonePlacement(options.placement);
    this.sitePolygon = options.sitePolygon?.map(clonePoint) ?? null;
    this.visible = options.visible ?? true;
    this.eventMode = "static";
    this.interactiveChildren = true;
    this.accessible = true;
    this.label = "Object transform gizmo";
    this.ariaLabel = "Object transform gizmo";
    setProperty(this, "data-tooltip", "Object transform gizmo");
    this.buildControls();
    this.refresh();
    this.setEnabled(options.enabled ?? true);
  }

  get state(): TransformGizmoSnapshot {
    return this.snapshot(this.provisional ?? { action: null, vertexIndex: null });
  }

  get isDragging(): boolean { return this.drag !== null; }
  get activeAction(): GizmoAction | null { return this.drag?.action ?? null; }
  get provisionalState(): TransformGizmoSnapshot | null {
    return this.provisional === null ? null : cloneSnapshot(this.provisional);
  }

  getControl(action: GizmoAction): TransformGizmoControl | undefined {
    return this.controls.get(action);
  }

  getVertexControl(index: number): TransformGizmoControl | undefined {
    return this.controls.get(`vertex:${index}`);
  }

  setEnabled(enabled: boolean): void {
    this.options.enabled = enabled;
    for (const control of this.controls.values()) setControlMetadata(control, control.gizmoAction, control.vertexIndex, enabled);
    this.eventMode = enabled ? "static" : "none";
    this.interactiveChildren = enabled;
    if (!enabled) this.cancel();
  }

  setZoom(zoom: number | (() => number)): void {
    this.options.zoom = zoom;
    this.refresh();
  }

  setPlacement(placement: PlacementFrame, sitePolygon: Ring | null | undefined = this.sitePolygon): void {
    this.placement = clonePlacement(placement);
    this.sitePolygon = sitePolygon?.map(clonePoint) ?? null;
    this.provisional = null;
    if (this.drag !== null) this.drag = null;
    this.buildControls();
    this.refresh();
  }

  setSitePolygon(sitePolygon: Ring | null | undefined): void {
    this.sitePolygon = sitePolygon?.map(clonePoint) ?? null;
    this.provisional = null;
    this.buildControls();
    this.refresh();
  }

  /** Begin a drag directly; useful for layers and deterministic lifecycle tests. */
  beginDrag(action: GizmoAction, pointer: Vec2, vertexIndex: number | null = null): boolean {
    if (this.destroyed || this.options.enabled === false || !this.actionAvailable(action, vertexIndex)) return false;
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;
    this.drag = {
      action,
      vertexIndex,
      startPointer: clonePoint(pointer),
      start: this.snapshot({ action: null, vertexIndex: null })
    };
    this.provisional = cloneSnapshot(this.drag.start);
    return true;
  }

  startDrag(action: GizmoAction, pointer: Vec2, vertexIndex: number | null = null): boolean {
    return this.beginDrag(action, pointer, vertexIndex);
  }

  /** Update only local provisional state. No adapter or expensive rebuild is touched here. */
  updateDrag(pointer: Vec2): boolean {
    const drag = this.drag;
    if (drag === null || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;
    const next = this.nextSnapshot(drag, pointer);
    this.provisional = next;
    this.placement = clonePlacement(next.placement);
    this.sitePolygon = next.sitePolygon?.map(clonePoint) ?? null;
    this.refresh();
    this.options.onPreview?.(cloneSnapshot(next));
    return true;
  }

  moveDrag(pointer: Vec2): boolean { return this.updateDrag(pointer); }

  /** Finish one drag and invoke exactly one commit callback. */
  endDrag(pointer?: Vec2): TransformGizmoSnapshot | null {
    const drag = this.drag;
    if (drag === null) return null;
    if (pointer !== undefined) this.updateDrag(pointer);
    const final = cloneSnapshot(this.provisional ?? drag.start);
    final.action = drag.action;
    final.vertexIndex = drag.vertexIndex;
    this.drag = null;
    this.provisional = null;
    this.placement = clonePlacement(final.placement);
    this.sitePolygon = final.sitePolygon?.map(clonePoint) ?? null;
    this.refresh();
    const result = cloneSnapshot(final);
    void this.options.onCommit?.(result);
    return result;
  }

  pointerUp(pointer?: Vec2): TransformGizmoSnapshot | null { return this.endDrag(pointer); }

  /** Restore the drag's exact pre-drag state and notify the layer without committing. */
  cancel(): TransformGizmoSnapshot | null {
    const drag = this.drag;
    if (drag === null) return null;
    const restored = cloneSnapshot(drag.start);
    this.drag = null;
    this.provisional = null;
    this.placement = clonePlacement(restored.placement);
    this.sitePolygon = restored.sitePolygon?.map(clonePoint) ?? null;
    this.refresh();
    const result = cloneSnapshot(restored);
    this.options.onCancel?.(result);
    return result;
  }

  cancelDrag(): TransformGizmoSnapshot | null { return this.cancel(); }

  refresh(): void {
    if (this.destroyed) return;
    const zoom = finiteZoom(this.options.zoom);
    const visualRadius = zoomHitRadius(8, zoom);
    const hit = zoomHitRadius(18, zoom);
    const current = this.provisional?.placement ?? this.placement;
    const frontageDistance = Math.max(current.widthM, current.depthM) / 2 + zoomHitRadius(28, zoom);
    const rotatePoint = localToWorld(current.centre, current.rotationRad, {
      x: Math.cos(this.options.frontageOffsetRad ?? 0) * frontageDistance,
      y: Math.sin(this.options.frontageOffsetRad ?? 0) * frontageDistance
    });
    const widthPoint = localToWorld(current.centre, current.rotationRad, { x: current.widthM / 2, y: 0 });
    const depthPoint = localToWorld(current.centre, current.rotationRad, { x: 0, y: current.depthM / 2 });
    this.positionControl("translate", current.centre, visualRadius, hit);
    this.positionControl("rotate", rotatePoint, visualRadius, hit);
    if (this.canResize) {
      this.positionControl("resize-width", widthPoint, visualRadius, hit);
      this.positionControl("resize-depth", depthPoint, visualRadius, hit);
    }
    for (const key of this.controls.keys()) {
      if (!key.startsWith("vertex:")) continue;
      const index = Number(key.slice("vertex:".length));
      const point = this.sitePolygon?.[index];
      if (point !== undefined) this.positionControl(key, point, visualRadius, hit);
    }
  }

  destroy(options?: unknown): void {
    if (this.destroyed) return;
    this.cancel();
    this.destroyed = true;
    for (const binding of this.bindings) binding.target.off?.(binding.event, binding.callback);
    this.bindings.length = 0;
    for (const control of this.controls.values()) control.destroy?.();
    this.controls.clear();
    super.destroy(options);
  }

  private get canResize(): boolean {
    return this.options.kind === "building" && this.options.fixedDimensions !== true;
  }

  private actionAvailable(action: GizmoAction, vertexIndex: number | null): boolean {
    if (action === "resize-width" || action === "resize-depth") return this.canResize;
    if (action === "vertex") return vertexIndex !== null && this.sitePolygon?.[vertexIndex] !== undefined;
    return action === "translate" || action === "rotate";
  }

  private snapshot(meta: { action: GizmoAction | null; vertexIndex: number | null }): TransformGizmoSnapshot {
    return {
      placement: clonePlacement(this.placement),
      sitePolygon: this.sitePolygon?.map(clonePoint) ?? null,
      action: meta.action,
      vertexIndex: meta.vertexIndex
    };
  }

  private nextSnapshot(drag: DragState, pointer: Vec2): TransformGizmoSnapshot {
    const next = cloneSnapshot(drag.start);
    next.action = drag.action;
    next.vertexIndex = drag.vertexIndex;
    if (drag.action === "translate") {
      next.placement = translatePlacement(drag.start.placement, subtract(pointer, drag.startPointer));
    } else if (drag.action === "rotate") {
      next.placement = rotatePlacement(
        drag.start.placement,
        drag.startPointer,
        pointer,
        this.options.frontageOffsetRad ?? 0
      );
    } else if (drag.action === "resize-width" || drag.action === "resize-depth") {
      next.placement = resizePlacement(
        drag.start.placement,
        drag.action,
        drag.startPointer,
        pointer,
        this.options.minDimension ?? 1
      );
    } else if (drag.vertexIndex !== null && next.sitePolygon !== null) {
      next.sitePolygon = moveSiteVertex(next.sitePolygon, drag.vertexIndex, pointer);
    }
    if (drag.action !== "vertex" && next.sitePolygon !== null) {
      next.sitePolygon = transformSitePolygon(next.sitePolygon, drag.start.placement, next.placement);
    }
    return next;
  }

  private buildControls(): void {
    const required = new Set<string>(["translate", "rotate"]);
    if (this.canResize) required.add("resize-width").add("resize-depth");
    for (let index = 0; index < (this.sitePolygon?.length ?? 0); index += 1) required.add(`vertex:${index}`);
    for (const [key, control] of this.controls) {
      if (required.has(key)) continue;
      this.removeChild?.(control);
      control.destroy?.();
      this.controls.delete(key);
    }
    for (const action of ["translate", "rotate", "resize-width", "resize-depth"] as const) {
      if (!required.has(action) || this.controls.has(action)) continue;
      this.createControl(action, null);
    }
    for (let index = 0; index < (this.sitePolygon?.length ?? 0); index += 1) {
      const key = `vertex:${index}`;
      if (!this.controls.has(key)) this.createControl("vertex", index);
    }
    this.drawControls();
  }

  private createControl(action: GizmoAction, vertexIndex: number | null): void {
    const control = graphics();
    setControlMetadata(control, action, vertexIndex, this.options.enabled !== false);
    const key = action === "vertex" ? `vertex:${vertexIndex}` : action;
    this.controls.set(key, control);
    this.addChild(control);
    const down = (event: unknown): void => {
      const point = pointFromEvent(event, this);
      if (point === null || !this.beginDrag(action, point, vertexIndex)) return;
      const eventRecord = asRecord(event);
      const stopPropagation = eventRecord?.stopPropagation;
      if (typeof stopPropagation === "function") stopPropagation.call(event);
      const data = asRecord(eventRecord?.data);
      const originalEvent = asRecord(data?.originalEvent);
      const preventDefault = originalEvent?.preventDefault;
      if (typeof preventDefault === "function") preventDefault.call(originalEvent);
    };
    const move = (event: unknown): void => {
      const point = pointFromEvent(event, this);
      if (point !== null) this.updateDrag(point);
    };
    const up = (event: unknown): void => {
      const point = pointFromEvent(event, this);
      this.endDrag(point ?? undefined);
    };
    const cancel = (): void => { this.cancel(); };
    this.bind(control, "pointerdown", down);
    this.bind(control, "pointermove", move);
    this.bind(control, "pointerup", up);
    this.bind(control, "pointerupoutside", up);
    this.bind(control, "pointercancel", cancel);
    this.bind(control, "pointerleave", move);
  }

  private bind(target: TransformGizmoControl, event: string, callback: (event: unknown) => void): void {
    if (typeof target.on === "function") target.on(event, callback);
    else setProperty(target, `on${event}`, callback);
    this.bindings.push({ target, event, callback });
  }

  private positionControl(key: string, point: Vec2, visualRadius: number, hit: number): void {
    const control = this.controls.get(key);
    if (control === undefined) return;
    setPosition(control, point);
    control.hitArea = circleHitArea(hit);
    this.drawControl(control, visualRadius);
  }

  private drawControls(): void {
    const zoom = finiteZoom(this.options.zoom);
    const visualRadius = zoomHitRadius(8, zoom);
    for (const control of this.controls.values()) this.drawControl(control, visualRadius);
  }

  private drawControl(control: TransformGizmoControl, radius: number): void {
    invokeGraphics(control, "clear");
    invokeGraphics(control, "lineStyle", { width: Math.max(1, radius * 0.22), color: 0xf4d35e, alpha: 0.98 });
    invokeGraphics(control, "beginFill", 0x121a2b, 0.94);
    if (control.gizmoAction === "resize-width" || control.gizmoAction === "resize-depth") {
      invokeGraphics(control, "drawRect", -radius, -radius, radius * 2, radius * 2);
    } else if (control.gizmoAction === "rotate") {
      invokeGraphics(control, "drawCircle", 0, 0, radius * 0.82);
      invokeGraphics(control, "lineStyle", { width: Math.max(1, radius * 0.16), color: 0xf4d35e, alpha: 0.98 });
      drawLine(control, { x: -radius * 0.45, y: 0 }, { x: radius * 0.55, y: 0 });
    } else if (control.gizmoAction === "vertex") {
      invokeGraphics(control, "drawRect", -radius * 0.72, -radius * 0.72, radius * 1.44, radius * 1.44);
    } else {
      invokeGraphics(control, "drawCircle", 0, 0, radius);
      invokeGraphics(control, "lineStyle", { width: Math.max(1, radius * 0.18), color: 0x74ffa8, alpha: 0.98 });
      drawLine(control, { x: -radius * 0.45, y: 0 }, { x: radius * 0.45, y: 0 });
      drawLine(control, { x: 0, y: -radius * 0.45 }, { x: 0, y: radius * 0.45 });
    }
    invokeGraphics(control, "endFill");
  }

}

export function createTransformGizmo(options: TransformGizmoOptions): TransformGizmo {
  return new TransformGizmo(options);
}

/** Compatibility alias for layer factories that use the repository's *Class naming convention. */
export const transformGizmoClass = TransformGizmo;
