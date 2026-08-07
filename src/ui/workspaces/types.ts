import type { WorkspaceId } from "../editor-state.js";

export interface WorkspaceContext {
  /** Re-render the whole shell. */
  rerender(): void;
  /** Run a Promise-returning action with the standard error notification. */
  run(label: string, work: Promise<unknown>, then?: () => void): void;
}

export interface WorkspaceModule {
  id: WorkspaceId;
  /** Tool Shelf HTML for the workspace ("" when the workspace owns no tools). */
  renderShelf(): string;
  /** Context Tray HTML ("" when the workspace needs no tray). */
  renderTray(): string;
  onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void;
  onRender(root: HTMLElement, ctx: WorkspaceContext): void;
}
