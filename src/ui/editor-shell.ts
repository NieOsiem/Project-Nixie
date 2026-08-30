import {
  addCityListener,
  canRedo,
  canUndo,
  cancelDistrictDraft,
  cancelTerrainDraft,
  clearDistrictSelection,
  clearRoadSelection,
  generationActive,
  getDistrictSelection,
  getRoadSelection,
  redo,
  undo
} from "../adapter/canvas.js";
import {
  beginPendingOperation,
  clearEditorActionError,
  clearObjectInteraction,
  clearObjectStaging,
  closeEditor,
  currentObjectCategory,
  currentPendingOperation,
  currentWorkspace,
  currentEditorActionError,
  endPendingOperation,
  isEditorOpen,
  isPendingOperation,
  openEditor,
  ownedLayerName,
  setEditorActionError,
  setEditorController,
  setWorkspace,
  WORKSPACE_IDS,
  WORKSPACE_META,
  canvasTool,
  type ObjectCategory,
  type WorkspaceId
} from "./editor-state.js";
import { diagnosticsWarningActive } from "./workspaces/diagnostics.js";
import { workspaceModule } from "./workspaces/index.js";
import { escapeHTML } from "./workspaces/shared.js";
import type { WorkspaceContext } from "./workspaces/types.js";
import { cancelObjectPlacement, clearObjectSelection as clearLayerObjectSelection } from "./objects-layer.js";

const SHELL_ID = "nixie-editor-shell";

function applicationBase(): any {
  const globalScope = globalThis as Record<string, unknown>;
  return foundry?.applications?.api?.ApplicationV2 ?? globalScope.ApplicationV2 ?? null;
}

function run(label: string, work: Promise<unknown>, then?: () => void): void {

  if (!beginPendingOperation(label)) {
    setEditorActionError("operation", new Error(`Another operation is already pending: ${currentPendingOperation()}.`));
    return;
  }
  refreshShell();
  void work
    .then(() => {
      endPendingOperation();
      clearEditorActionError();
      then?.();
      refreshShell();
    })
    .catch((err: unknown) => {
      endPendingOperation();
      const message = err instanceof Error ? err.message : String(err);
      setEditorActionError(label, err);
      console.error(`nixie | ${label} failed`, err);
      ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
      refreshShell();
    });
}

function workspaceContext(): WorkspaceContext {
  return {
    rerender: () => refreshShell(),
    run
  };
}

function shellHTML(): string {
  const activeWorkspace = currentWorkspace();
  const module = workspaceModule(activeWorkspace);
  const generationBusy = generationActive();
  const pending = currentPendingOperation();
  const busy = generationBusy || pending !== null;
  const warning = diagnosticsWarningActive();
  const tabs = WORKSPACE_IDS.map((id) => {
    const meta = WORKSPACE_META[id];
    const active = id === activeWorkspace ? " active" : "";
    const unavailable = meta.phase === null ? "" : " unavailable";
    const title = meta.phase === null ? meta.label : `${meta.label} (${meta.phase})`;
    const disabled = busy ? " disabled" : "";
    const badge = id === "diagnostics" && warning ? `<i class="nixie-warn-badge" title="Diagnostics need attention"></i>` : "";
    return `<button type="button" class="nixie-workspace${active}${unavailable}" data-action="workspace" data-workspace="${id}" title="${title}" aria-label="${title}"${disabled}><i class="${meta.icon}"></i><span>${meta.label}</span>${badge}</button>`;
  }).join("");
  // While full-city generation runs, every workspace's controls are locked, so the tray
  // always shows the durable uninterruptible progress regardless of the active workspace.
  const trayModule = generationBusy ? workspaceModule("generate") : module;
  const shelf = generationBusy ? "" : module.renderShelf();
  const tray = trayModule.renderTray();
  const actionError = currentEditorActionError();
  const error = actionError === null ? "" : `<section class="nixie-action-error" data-panel="action-error" role="alert"><h3>${escapeHTML(actionError.label)} failed</h3><p>${escapeHTML(actionError.message)}</p>${actionError.affectedIds.length === 0 ? "" : `<p class="nixie-note">Affected IDs: ${actionError.affectedIds.map((id) => escapeHTML(id)).join(", ")}</p>`}</section>`;
  const pendingPanel = pending === null ? "" : `<section class="nixie-operation-pending" data-panel="pending-operation" role="status" aria-live="polite"><i class="fa-solid fa-spinner" aria-hidden="true"></i><span>Working: ${escapeHTML(pending)}</span></section>`;
  const trayContent = generationBusy ? tray : actionError === null ? `${pendingPanel}${tray}` : `${error}${tray}`;
  const trayIsGenerate = generationBusy || activeWorkspace === "generate";
  const lockedShelf = pending === null ? shelf : shelf.replace(/<(button|input|select|textarea)(\b)(?![^>]*\bdisabled\b)/g, "<$1$2 disabled");
  const lockedTray = pending === null ? tray : tray.replace(/<(button|input|select|textarea)(\b)(?![^>]*\bdisabled\b)/g, "<$1$2 disabled");
  return `<header class="nixie-workspace-bar">
    <div class="nixie-brand"><i class="fa-solid fa-city"></i><span>NIXIE</span></div>
    <nav class="nixie-workspaces">${tabs}</nav>
    <div class="nixie-shell-actions">
      <button type="button" data-action="undo"${canUndo() && !busy ? "" : " disabled"} title="Undo city edit" aria-label="Undo city edit"><i class="fa-solid fa-rotate-left"></i></button>
      <button type="button" data-action="redo"${canRedo() && !busy ? "" : " disabled"} title="Redo city edit" aria-label="Redo city edit"><i class="fa-solid fa-rotate-right"></i></button>
      <span class="nixie-shell-sep"></span>
      <button type="button" data-action="close-editor" title="Close the Nixie editor" aria-label="Close the Nixie editor"><i class="fa-solid fa-xmark"></i></button>
    </div>
  </header>
  ${lockedShelf === "" ? "" : `<div class="nixie-tool-shelf"${pending === null ? "" : " aria-busy=\"true\""}>${lockedShelf}</div>`}
  ${trayContent === "" ? "" : `<div class="nixie-context-tray${trayIsGenerate ? " nixie-tray-generate" : ""}"${pending === null ? "" : " aria-busy=\"true\""}>${generationBusy ? tray : actionError === null ? `${pendingPanel}${lockedTray}` : `${error}${lockedTray}`}</div>`}`;
}

let cachedClass: any = null;
let instance: any = null;
let cityUnsubscribe: (() => void) | null = null;
let lastWorkspace: WorkspaceId | null = null;
let lastObjectTool: string | null = null;
let lastObjectCategory: ObjectCategory | null = null;

function editorShellClass(): any {
  if (cachedClass !== null) return cachedClass;
  const Base = applicationBase();
  if (!Base) throw new Error("ApplicationV2 is unavailable — Foundry's application API moved.");

  cachedClass = class NixieEditorShell extends Base {
    static DEFAULT_OPTIONS = {
      id: SHELL_ID,
      classes: ["nixie-editor"],
      window: { frame: false, positioned: false, title: "", icon: "" }
    };

    _canRender(): void {
      if (!game.user?.isGM) throw new Error("Nixie: the editor is GM-only.");
    }

    async _prepareContext(_options: any): Promise<Record<string, never>> {
      return {};
    }

    async _renderHTML(): Promise<string> {
      return shellHTML();
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
    }

    _onRender(): void {
      const element = (this as unknown as { element: HTMLElement }).element;
      workspaceModule(currentWorkspace()).onRender(element, workspaceContext());
      // Full-city generation and shared commits lock conflicting controls; close remains
      // available so the user can dismiss the shell without cancelling the operation.
      element.classList.toggle("busy", generationActive() || isPendingOperation());
      element.classList.toggle("pending", isPendingOperation());
    }

    async _onClose(options: any): Promise<void> {
      cancelObjectPlacement(false);
      clearObjectInteraction();
      clearLayerObjectSelection();
      cityUnsubscribe?.();
      cityUnsubscribe = null;
      const parent = Base.prototype._onClose;
      if (typeof parent === "function") await parent.call(this, options);
    }

    _onClickAction(_event: PointerEvent, target: HTMLElement): void {
      const action = target.closest<HTMLElement>("[data-action]") ?? target;
      const name = action.dataset.action ?? "";
      if (isPendingOperation() && name !== "close-editor") return;
      if (name === "workspace") {
        clearEditorActionError();
        setWorkspace(action.dataset.workspace as WorkspaceId);
        return;
      }
      if (name === "undo") {
        run("undo", undo());
        return;
      }
      if (name === "redo") {
        run("redo", redo());
        return;
      }
      if (name === "close-editor") {
        closeEditor({ restoreDefaultLayer: true });
        return;
      }
      workspaceModule(currentWorkspace()).onAction(name, action, workspaceContext());
    }
  };
  return cachedClass;
}

function ensureInstance(): void {
  if (instance === null) instance = new (editorShellClass())();
}

function showShell(): void {
  ensureInstance();
  lastWorkspace = currentWorkspace();
  lastObjectTool = canvasTool();
  lastObjectCategory = currentObjectCategory();
  cityUnsubscribe ??= addCityListener(() => {
    if (isEditorOpen()) void instance.render({ force: true });
  });
  void instance.render({ force: true });
}
function hideShell(): void {
  clearEditorActionError();
  cancelTerrainDraft();
  cancelDistrictDraft();
  cancelObjectPlacement(false);
  clearObjectInteraction();
  clearLayerObjectSelection();
  clearRoadSelection();
  clearDistrictSelection();
  cityUnsubscribe?.();
  cityUnsubscribe = null;
  lastWorkspace = null;
  lastObjectTool = null;
  lastObjectCategory = null;
  if (instance?.rendered === true) void instance.close();
}
function clearDepartedWorkspaceState(): void {
  const next = currentWorkspace();
  const previous = lastWorkspace;
  const nextTool = canvasTool();
  const nextCategory = currentObjectCategory();
  const objectTransition = next === "objects" && (lastObjectTool !== nextTool || lastObjectCategory !== nextCategory);
  // Record the observed state before invoking cleanup. Cleanup can notify the
  // controller synchronously, and re-entrant renders must see this transition
  // as handled rather than starting it again.
  lastWorkspace = next;
  lastObjectTool = nextTool;
  lastObjectCategory = nextCategory;
  if (previous === "objects" && next !== "objects") {
    cancelObjectPlacement(false);
    clearObjectInteraction();
    clearLayerObjectSelection();
  } else if (objectTransition) {
    // Tool/category transitions discard transient placement and Inspector staging but
    // preserve a compatible selection until the layer decides whether it still applies.
    cancelObjectPlacement(false);
    clearObjectStaging();
  }
  if (previous === "districts" && next !== "districts") {
    cancelDistrictDraft();
    if (getDistrictSelection().length > 0) clearDistrictSelection();
  }
  if (previous === "roads" && next !== "roads") {
    const selection = getRoadSelection();
    if (selection.edgeIds.length > 0 || selection.nodeIds.length > 0) clearRoadSelection();
  }
}

function refreshShell(): void {
  if (!isEditorOpen()) return;
  const layer = ownedLayerName();
  if (layer !== null) canvas?.[layer]?.refresh?.();
  if (instance?.rendered === true) void instance.render({ force: true });
}

export function installEditorShellController(): void {
  setEditorController({
    onOpen: showShell,
    onClose: hideShell,
    onStateChanged: () => {
      clearDepartedWorkspaceState();
      refreshShell();
    }
  });
}

/** module.api compatibility: open the editor at the Terrain workspace. */
export function openTerrainApp(): void {
  openEditor();
  setWorkspace("terrain");
}

/** module.api compatibility: open the editor at the Roads workspace. */
export function openRoadApp(): void {
  openEditor();
  setWorkspace("roads");
}

export function openDistrictApp(): void {
  openEditor();
  setWorkspace("districts");
}

/** module.api compatibility: open the editor at the Objects workspace. */
export function openObjectsApp(): void {
  openEditor();
  setWorkspace("objects");
}
