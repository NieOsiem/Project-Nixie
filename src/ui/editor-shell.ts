import {
  addCityListener,
  canRedo,
  canUndo,
  cancelTerrainDraft,
  clearRoadSelection,
  redo,
  undo
} from "../adapter/canvas.js";
import {
  closeEditor,
  currentWorkspace,
  isEditorOpen,
  openEditor,
  ownedLayerName,
  setEditorController,
  setWorkspace,
  WORKSPACE_IDS,
  WORKSPACE_META,
  type WorkspaceId
} from "./editor-state.js";
import { workspaceModule } from "./workspaces/index.js";
import type { WorkspaceContext } from "./workspaces/types.js";

const SHELL_ID = "nixie-editor-shell";

function applicationBase(): any {
  return foundry?.applications?.api?.ApplicationV2 ?? null;
}

function run(label: string, work: Promise<unknown>, then?: () => void): void {
  void work
    .then(then)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`nixie | ${label} failed`, err);
      ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
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
  const tabs = WORKSPACE_IDS.map((id) => {
    const meta = WORKSPACE_META[id];
    const active = id === activeWorkspace ? " active" : "";
    const unavailable = meta.phase === null ? "" : " unavailable";
    const title = meta.phase === null ? meta.label : `${meta.label} (${meta.phase})`;
    return `<button type="button" class="nixie-workspace${active}${unavailable}" data-action="workspace" data-workspace="${id}" title="${title}"><i class="${meta.icon}"></i><span>${meta.label}</span></button>`;
  }).join("");
  const shelf = module.renderShelf();
  const tray = module.renderTray();
  return `<header class="nixie-workspace-bar">
    <div class="nixie-brand"><i class="fa-solid fa-city"></i><span>NIXIE</span></div>
    <nav class="nixie-workspaces">${tabs}</nav>
    <div class="nixie-shell-actions">
      <button type="button" data-action="undo"${canUndo() ? "" : " disabled"} title="Undo city edit"><i class="fa-solid fa-rotate-left"></i></button>
      <button type="button" data-action="redo"${canRedo() ? "" : " disabled"} title="Redo city edit"><i class="fa-solid fa-rotate-right"></i></button>
      <button type="button" data-action="close-editor" title="Close the Nixie editor"><i class="fa-solid fa-xmark"></i></button>
    </div>
  </header>
  ${shelf === "" ? "" : `<div class="nixie-tool-shelf">${shelf}</div>`}
  ${tray === "" ? "" : `<div class="nixie-context-tray${activeWorkspace === "generate" ? " nixie-tray-generate" : ""}">${tray}</div>`}`;
}

let cachedClass: any = null;
let instance: any = null;
let cityUnsubscribe: (() => void) | null = null;

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
      workspaceModule(currentWorkspace()).onRender(this.element as HTMLElement, workspaceContext());
    }

    async _onClose(options: any): Promise<void> {
      cityUnsubscribe?.();
      cityUnsubscribe = null;
      const parent = Base.prototype._onClose;
      if (typeof parent === "function") await parent.call(this, options);
    }

    _onClickAction(_event: PointerEvent, target: HTMLElement): void {
      const action = target.closest<HTMLElement>("[data-action]") ?? target;
      const name = action.dataset.action ?? "";
      if (name === "workspace") {
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
  cityUnsubscribe ??= addCityListener(() => {
    if (isEditorOpen()) void instance.render({ force: true });
  });
  void instance.render({ force: true });
}

function hideShell(): void {
  cancelTerrainDraft();
  clearRoadSelection();
  cityUnsubscribe?.();
  cityUnsubscribe = null;
  if (instance?.rendered === true) void instance.close();
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
    onStateChanged: refreshShell
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
