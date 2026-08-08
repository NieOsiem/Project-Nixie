import { ROUTE_CLASS_IDS } from "../core/gen/city.js";

/**
 * One shared editor-shell state (UI spec §37): open flag, active workspace, canvas tool,
 * object category, and session-scoped preferences. The shell, the workspaces, and the
 * canvas layers all read tool/workspace state from here instead of from Foundry's
 * scene-control toolbar, which cannot represent a hidden tool on both v12 and v14.
 */

export const LAYER_NIXIE = "nixie";
export const LAYER_ROADS = "nixie-roads";

export const TOOL = {
  LAND_DRAW: "land-draw",
  FOOTPRINT_DRAW: "footprint-draw",
  LAND_EDIT: "land-edit",
  FOOTPRINT_EDIT: "footprint-edit"
} as const;

export const ROAD_TOOL = {
  DRAW: "road-draw",
  SELECT: "road-select",
  EDIT: "road-edit"
} as const;
export type RoadTool = (typeof ROAD_TOOL)[keyof typeof ROAD_TOOL];

export const WORKSPACE_IDS = ["generate", "terrain", "roads", "districts", "objects", "regenerate", "diagnostics"] as const;
export type WorkspaceId = (typeof WORKSPACE_IDS)[number];

export const OBJECT_CATEGORIES = ["buildings", "places", "props", "pois"] as const;
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];

export const WORKSPACE_META: Record<WorkspaceId, { label: string; icon: string; phase: string | null }> = {
  generate: { label: "Generate", icon: "fa-solid fa-wand-magic-sparkles", phase: null },
  terrain: { label: "Terrain", icon: "fa-solid fa-water", phase: null },
  roads: { label: "Roads", icon: "fa-solid fa-road", phase: null },
  districts: { label: "Districts", icon: "fa-solid fa-shapes", phase: "Phase 3" },
  objects: { label: "Objects", icon: "fa-solid fa-boxes-stacked", phase: "Phases 5–8" },
  regenerate: { label: "Regenerate", icon: "fa-solid fa-arrows-rotate", phase: "Phase 6" },
  diagnostics: { label: "Diagnostics", icon: "fa-solid fa-triangle-exclamation", phase: null }
};

/** Which interaction layer, if any, owns the workspace's canvas tools. */
const WORKSPACE_LAYER: Record<WorkspaceId, string | null> = {
  generate: null,
  terrain: LAYER_NIXIE,
  roads: LAYER_ROADS,
  districts: null,
  objects: null,
  regenerate: null,
  diagnostics: null
};

const DEFAULT_TOOL: Record<WorkspaceId, string | null> = {
  generate: null,
  terrain: TOOL.LAND_EDIT,
  roads: ROAD_TOOL.SELECT,
  districts: null,
  objects: null,
  regenerate: null,
  diagnostics: null
};

function isToolForWorkspace(tool: string | null, workspace: WorkspaceId): boolean {
  if (workspace === "terrain") {
    return tool === TOOL.LAND_DRAW || tool === TOOL.FOOTPRINT_DRAW || tool === TOOL.LAND_EDIT || tool === TOOL.FOOTPRINT_EDIT;
  }
  if (workspace === "roads") {
    return tool === ROAD_TOOL.DRAW || tool === ROAD_TOOL.SELECT || tool === ROAD_TOOL.EDIT;
  }
  return tool === null;
}

export type CurvePreset = "tight" | "standard" | "broad";
export type RoadLayout = "european" | "grid" | "mixed";
export type HubMode = "single-centre" | "multiple-hubs";
export type CoastEdge = "north" | "east" | "south" | "west";

export interface EditorPrefs {
  workspace: WorkspaceId;
  tool: string | null;
  objectCategory: ObjectCategory;
  roadClass: string;
  curvePreset: CurvePreset;
  roadLayout: RoadLayout;
  hubMode: HubMode;
}

const PREFS_KEY = "project-nixie:editor-prefs-v2";

const DEFAULT_PREFS: EditorPrefs = {
  workspace: "terrain",
  tool: null,
  objectCategory: "buildings",
  roadClass: "street",
  curvePreset: "standard",
  roadLayout: "european",
  hubMode: "single-centre"
};

function prefsStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function sanitizePrefs(raw: unknown): EditorPrefs {
  const value = (raw ?? {}) as Partial<EditorPrefs>;
  const workspace = WORKSPACE_IDS.includes(value.workspace as WorkspaceId) ? (value.workspace as WorkspaceId) : DEFAULT_PREFS.workspace;
  const tool = typeof value.tool === "string" ? value.tool : DEFAULT_PREFS.tool;
  const objectCategory = OBJECT_CATEGORIES.includes(value.objectCategory as ObjectCategory) ? (value.objectCategory as ObjectCategory) : DEFAULT_PREFS.objectCategory;
  const roadClass = typeof value.roadClass === "string" && (ROUTE_CLASS_IDS as readonly string[]).includes(value.roadClass) ? value.roadClass : DEFAULT_PREFS.roadClass;
  const curvePreset = value.curvePreset === "tight" || value.curvePreset === "broad" ? value.curvePreset : DEFAULT_PREFS.curvePreset;
  const roadLayout = value.roadLayout === "grid" || value.roadLayout === "mixed" ? value.roadLayout : DEFAULT_PREFS.roadLayout;
  const hubMode = value.hubMode === "multiple-hubs" ? value.hubMode : DEFAULT_PREFS.hubMode;
  return { workspace, tool, objectCategory, roadClass, curvePreset, roadLayout, hubMode };
}

function writePrefs(): void {
  const storage = prefsStorage();
  if (storage === null) return;
  const prefs: EditorPrefs = {
    workspace,
    tool,
    objectCategory,
    roadClass,
    curvePreset,
    roadLayout,
    hubMode
  };
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Session storage can be unavailable (privacy mode); preferences are best-effort.
  }
}

function restorePrefs(): void {
  const storage = prefsStorage();
  let raw: unknown = null;
  try {
    const stored = storage?.getItem(PREFS_KEY);
    raw = stored === null || stored === undefined ? null : JSON.parse(stored);
  } catch {
    raw = null;
  }
  const prefs = sanitizePrefs(raw);
  workspace = prefs.workspace;
  tool = prefs.tool;
  objectCategory = prefs.objectCategory;
  roadClass = prefs.roadClass;
  curvePreset = prefs.curvePreset;
  roadLayout = prefs.roadLayout;
  hubMode = prefs.hubMode;
}

let editorOpen = false;
let workspace: WorkspaceId = DEFAULT_PREFS.workspace;
let tool: string | null = DEFAULT_PREFS.tool;
let objectCategory: ObjectCategory = DEFAULT_PREFS.objectCategory;
let roadClass: string = DEFAULT_PREFS.roadClass;
let curvePreset: CurvePreset = DEFAULT_PREFS.curvePreset;
let roadName = "";
let roadScope: "segment" | "contiguous-name" = "segment";
let roadLayout: RoadLayout = DEFAULT_PREFS.roadLayout;
let hubMode: HubMode = DEFAULT_PREFS.hubMode;
let coastEdge: CoastEdge = "west";
let seed = "nixie-2";
let ownedLayer: string | null = null;

export interface EditorController {
  /** Editor opened: show the shell and re-render it. */
  onOpen(): void;
  /** Editor closed: hide the shell (selection and drafts are cleared by the shell). */
  onClose(): void;
  /** Workspace, tool, category, or form state changed: re-render the shell. */
  onStateChanged(): void;
}

let controller: EditorController | null = null;

export function setEditorController(next: EditorController | null): void {
  controller = next;
}

export function isEditorOpen(): boolean {
  return editorOpen;
}

export function currentWorkspace(): WorkspaceId {
  return workspace;
}

export function canvasTool(): string | null {
  return tool;
}

export function ownedLayerName(): string | null {
  return ownedLayer;
}

export function currentObjectCategory(): ObjectCategory {
  return objectCategory;
}

function activateLayer(layer: string | null): void {
  if (layer === null) return;
  const target = canvas?.[layer];
  if (target?.active !== true) target?.activate();
  target?.refresh?.();
}

export function openEditor(): void {
  if (editorOpen) return;
  if (canvas?.ready !== true) {
    ui.notifications?.warn("Nixie: the canvas must be ready before opening the editor.");
    return;
  }
  editorOpen = true;
  restorePrefs();
  if (!isToolForWorkspace(tool, workspace)) tool = DEFAULT_TOOL[workspace];
  ownedLayer = WORKSPACE_LAYER[workspace];
  activateLayer(ownedLayer);
  controller?.onOpen();
}

export function closeEditor(options: { restoreDefaultLayer?: boolean } = {}): void {
  if (!editorOpen) return;
  editorOpen = false;
  writePrefs();
  const owned = ownedLayer;
  ownedLayer = null;
  if (owned !== null) {
    const layer = canvas?.[owned];
    if (layer?.active === true) layer.deactivate();
  }
  if (options.restoreDefaultLayer !== false) {
    const tokens = canvas?.tokens;
    if (tokens?.active !== true) tokens?.activate();
  }
  controller?.onClose();
}

/**
 * Called by the interaction layers when they are activated (canvas[L] .activate()).
 * Opening the editor by clicking the Nixie control flows through here.
 */
export function editorLayerActivated(layer: string): void {
  if (layer !== LAYER_NIXIE && layer !== LAYER_ROADS) return;
  if (!editorOpen) {
    openEditor();
    return;
  }
  if (ownedLayer === layer) return;
  // The control icon clicked while editing on the other layer: adopt that layer's workspace.
  setWorkspace(layer === LAYER_ROADS ? "roads" : "terrain");
}

/**
 * Called by the interaction layers when they are deactivated. Closing the editor by
 * switching to another Foundry control flows through here. Deferred by a microtask so
 * a workspace switch inside the editor (which briefly deactivates the old layer) is not
 * mistaken for the user leaving the editor.
 */
export function editorLayerDeactivated(layer: string): void {
  if (!editorOpen) return;
  if (ownedLayer !== layer) return;
  queueMicrotask(() => {
    if (!editorOpen || ownedLayer !== layer) return;
    closeEditor({ restoreDefaultLayer: false });
  });
}

export function setWorkspace(next: WorkspaceId): void {
  if (next === workspace) return;
  const previousLayer = WORKSPACE_LAYER[workspace];
  workspace = next;
  if (!isToolForWorkspace(tool, next)) tool = DEFAULT_TOOL[next];
  if (editorOpen) {
    ownedLayer = WORKSPACE_LAYER[next];
    if (ownedLayer === null && previousLayer !== null) {
      // Moving to a workspace with no canvas tools: clear the planning overlay.
      const previous = canvas?.[previousLayer];
      if (previous?.active === true) previous.deactivate();
    } else {
      activateLayer(ownedLayer);
    }
  }
  writePrefs();
  controller?.onStateChanged();
}

export function setCanvasTool(next: string | null): void {
  if (tool === next) return;
  tool = next;
  writePrefs();
  controller?.onStateChanged();
}

/**
 * The canvas layers call this after draft or selection state changes that do not
 * commit a revision (drawing an anchor, backtracking, starting a draft) so the shell
 * can refresh button enabled states immediately.
 */
export function notifyEditorInteraction(): void {
  controller?.onStateChanged();
}

export function setObjectCategory(next: ObjectCategory): void {
  if (objectCategory === next) return;
  objectCategory = next;
  writePrefs();
  controller?.onStateChanged();
}

export function currentRoadClass(): string {
  return roadClass;
}

export function setRoadClass(next: string): void {
  roadClass = next;
  writePrefs();
  controller?.onStateChanged();
}

export function currentCurvePreset(): CurvePreset {
  return curvePreset;
}

export function setCurvePreset(next: CurvePreset): void {
  curvePreset = next;
  writePrefs();
  controller?.onStateChanged();
}

export function currentRoadName(): string {
  return roadName;
}

export function setRoadName(next: string): void {
  roadName = next;
}

export function currentRoadScope(): "segment" | "contiguous-name" {
  return roadScope;
}

export function setRoadScope(next: "segment" | "contiguous-name"): void {
  roadScope = next;
}

export function currentRoadLayout(): RoadLayout {
  return roadLayout;
}

export function setRoadLayout(next: RoadLayout): void {
  roadLayout = next;
  writePrefs();
}

export function currentHubMode(): HubMode {
  return hubMode;
}

export function setHubMode(next: HubMode): void {
  hubMode = next;
  writePrefs();
}

export function currentCoastEdge(): CoastEdge {
  return coastEdge;
}

export function setCoastEdge(next: CoastEdge): void {
  coastEdge = next;
}

export function currentSeed(): string {
  return seed;
}

export function setSeed(next: string): void {
  seed = next;
}
