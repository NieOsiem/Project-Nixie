import type { WorkspaceId } from "../editor-state.js";
import { escapeHTML } from "./shared.js";
import type { WorkspaceModule } from "./types.js";

export function unavailableWorkspace(id: WorkspaceId, note: string): WorkspaceModule {
  return {
    id,
    renderShelf(): string {
      return `<p class="nixie-placeholder">${escapeHTML(note)}</p>`;
    },
    renderTray(): string {
      return "";
    },
    onAction(_action: string, _target: HTMLElement, _ctx: never): void {},
    onRender(_root: HTMLElement, _ctx: never): void {}
  };
}
