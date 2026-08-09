import { districtDiagnostics, retryGeneratedWalls } from "../../adapter/canvas.js";
import { escapeHTML } from "./shared.js";
import type { WorkspaceContext } from "./types.js";
import type { WorkspaceModule } from "./types.js";

export function diagnosticEntries(): Array<Record<string, unknown>> {
  try {
    const value = districtDiagnostics();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function diagnosticsTrayHTML(entries: readonly Record<string, unknown>[]): string {
  if (entries.length === 0) return `<section data-panel="diagnostics" class="nixie-tray-inspector"><h3>Diagnostics</h3><p class="nixie-note">No diagnostics recorded. Failed or degraded structural or decorative generation, invalid-geometry rejections, and stale-editor rejections will be listed here.</p></section>`;
  const items = entries.map((entry) => {
    const message = String(entry.message ?? entry.reason ?? "Diagnostic recorded.");
    const retry = entry.retry === "walls" || entry.subsystem === "walls" ? `<button type="button" data-action="diagnostics-retry-walls">Retry generated walls</button>` : "";
    return `<li><span>${escapeHTML(message)}</span>${retry}</li>`;
  }).join("");
  return `<section data-panel="diagnostics" class="nixie-tray-inspector"><h3>Diagnostics</h3><ul class="nixie-district-diagnostics">${items}</ul></section>`;
}

export function diagnosticsWorkspace(): WorkspaceModule {
  return {
    id: "diagnostics",
    renderShelf(): string {
      return "";
    },
    renderTray(): string {
      return diagnosticsTrayHTML(diagnosticEntries());
    },
    onAction(action: string, _target: HTMLElement, ctx: WorkspaceContext): void {
      if (action === "diagnostics-retry-walls") ctx.run("generated wall retry", retryGeneratedWalls());
    },
    onRender(_root: HTMLElement, _ctx: WorkspaceContext): void {}
  };
}
