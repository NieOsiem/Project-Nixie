import type { WorkspaceModule } from "./types.js";

export function diagnosticsWorkspace(): WorkspaceModule {
  return {
    id: "diagnostics",
    renderShelf(): string {
      return "";
    },
    renderTray(): string {
      return `<section data-panel="diagnostics" class="nixie-tray-inspector">
        <h3>Diagnostics</h3>
        <p class="nixie-note">No diagnostics recorded. Failed or degraded structural or decorative generation, invalid-geometry rejections, and stale-editor rejections will be listed here.</p>
      </section>`;
    },
    onAction(_action: string, _target: HTMLElement, _ctx: never): void {},
    onRender(_root: HTMLElement, _ctx: never): void {}
  };
}
