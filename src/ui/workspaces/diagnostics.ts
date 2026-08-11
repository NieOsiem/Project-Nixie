import {
  districtDiagnostics,
  generateNewSeed,
  generationState,
  retryDistrictPlan,
  retryFullGeneration,
  retryGeneratedWalls,
  retryGeometry,
  type GenerationFailure,
  type GenerationState
} from "../../adapter/canvas.js";
import { escapeHTML, generationComponentLabel } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

export type DiagnosticRetry = "walls" | "plan" | "geometry" | "same-seed" | "new-seed";

export interface DiagnosticView {
  severity: "error" | "warning";
  message: string;
  subsystem: string;
  retry: DiagnosticRetry | null;
}

function retryOf(raw: unknown): DiagnosticRetry | null {
  return raw === "walls" || raw === "plan" || raw === "geometry" || raw === "same-seed" || raw === "new-seed" ? raw : null;
}

/** Reduces one raw diagnostic entry to the user-facing view; drops developer internals. */
export function sanitizeDiagnosticEntry(raw: Record<string, unknown>): DiagnosticView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = typeof raw.message === "string" && raw.message.length > 0 ? raw.message : typeof raw.reason === "string" && raw.reason.length > 0 ? raw.reason : null;
  if (message === null) return null;
  const retry = retryOf(raw.retry);
  const subsystem = typeof raw.subsystem === "string" && raw.subsystem.length > 0 ? raw.subsystem : retry ?? "city";
  const severity = raw.severity === "warning" || raw.kind === "degraded" || retry === "walls" || retry === "plan" || retry === "geometry" ? "warning" : "error";
  return { severity, message, subsystem, retry };
}

export function diagnosticViews(entries: readonly Record<string, unknown>[]): DiagnosticView[] {
  const views: DiagnosticView[] = [];
  for (const entry of entries) {
    const view = sanitizeDiagnosticEntry(entry);
    if (view !== null) views.push(view);
  }
  return views;
}

/** Any actionable entry (one with a retry) means the Diagnostics tab needs a badge. */
export function hasActionableDiagnosticViews(views: readonly DiagnosticView[]): boolean {
  return views.some((view) => view.retry !== null);
}

/** Decorative degradation specifically: generated walls were not fully rebuilt. */
export function hasWallRetry(views: readonly DiagnosticView[]): boolean {
  return views.some((view) => view.retry === "walls");
}

/** Shell badge: something in Diagnostics needs the GM's attention. */
export function diagnosticsWarningActive(): boolean {
  const state = generationState();
  if (state.phase === "failed" && state.failure !== null) return true;
  return hasActionableDiagnosticViews(diagnosticViews(districtDiagnostics()));
}

/** Decorative degradation note on the Generate tray (spec §17.7). */
export function wallRetryWarningActive(): boolean {
  return hasWallRetry(diagnosticViews(districtDiagnostics()));
}

export function diagnosticEntries(): Array<Record<string, unknown>> {
  try {
    const value = districtDiagnostics();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function retryButtonHTML(view: DiagnosticView): string {
  const action = view.retry === "walls"
    ? "diagnostics-retry-walls"
    : view.retry === "plan"
      ? "diagnostics-retry-plan"
      : view.retry === "geometry"
        ? "diagnostics-retry-geometry"
        : view.retry === "same-seed"
          ? "diagnostics-retry-same-seed"
          : "diagnostics-retry-new-seed";
  const label = view.retry === "walls"
    ? "Retry generated walls"
    : view.retry === "plan"
      ? "Retry district planning"
      : view.retry === "geometry"
        ? "Retry rendering"
        : view.retry === "same-seed"
          ? "Retry Same Seed"
          : "Generate New Seed";
  return `<button type="button" data-action="${action}">${label}</button>`;
}

function failureSectionHTML(failure: GenerationFailure): string {
  return `<div data-panel="generation-failure">
    <h4>Structural generation failure</h4>
    <p>${escapeHTML(failure.error)}</p>
    <p class="nixie-note">Failing component: ${escapeHTML(generationComponentLabel(failure.component))}. No complete city was committed; the Scene flag stays clear until a retry succeeds.</p>
    <div class="form-footer">
      <button type="button" data-action="diagnostics-retry-same-seed"${failure.canRetrySameSeed ? "" : " disabled"}>Retry Same Seed</button>
      <button type="button" data-action="diagnostics-retry-new-seed"${failure.canGenerateNewSeed ? "" : " disabled"}>Generate New Seed</button>
      <button type="button" data-action="diagnostics-retry-geometry"${failure.canRetryGeometry ? "" : " disabled"}>Retry rendering</button>
    </div>
  </div>`;
}

export function diagnosticsTrayHTML(entries: readonly Record<string, unknown>[], generation: GenerationState | null = null): string {
  const sections: string[] = [];
  const failure = generation !== null && generation.phase === "failed" ? generation.failure : null;
  if (failure !== null) sections.push(failureSectionHTML(failure));
  const views = diagnosticViews(entries);
  if (views.length > 0) {
    const items = views.map((view) => {
      const severity = view.severity === "error" ? "error" : "warning";
      const label = view.subsystem === "city" ? "City" : view.subsystem;
      return `<li data-severity="${severity}"><span>${escapeHTML(label)}: ${escapeHTML(view.message)}</span>${view.retry === null ? "" : retryButtonHTML(view)}</li>`;
    }).join("");
    sections.push(`<ul class="nixie-district-diagnostics">${items}</ul>`);
  }
  if (sections.length === 0) {
    return `<section data-panel="diagnostics" class="nixie-tray-inspector"><h3>Diagnostics</h3><p class="nixie-note">No diagnostics recorded. Failed or degraded structural or decorative generation, invalid-geometry rejections, and stale-editor rejections will be listed here.</p></section>`;
  }
  return `<section data-panel="diagnostics" class="nixie-tray-inspector"><h3>Diagnostics</h3>${sections.join("")}</section>`;
}

export interface DiagnosticsWorkspaceDeps {
  entries: () => Array<Record<string, unknown>>;
  generationState: () => GenerationState;
  retryWalls: () => Promise<unknown>;
  retryPlan: () => Promise<unknown>;
  retryGeometry: () => Promise<unknown>;
  retrySameSeed: () => Promise<unknown>;
  generateNewSeed: () => Promise<unknown>;
}

const defaultDeps: DiagnosticsWorkspaceDeps = {
  entries: diagnosticEntries,
  generationState,
  retryWalls: retryGeneratedWalls,
  retryPlan: retryDistrictPlan,
  retryGeometry,
  retrySameSeed: retryFullGeneration,
  generateNewSeed: () => generateNewSeed()
};

export function diagnosticsWorkspace(deps: Partial<DiagnosticsWorkspaceDeps> = {}): WorkspaceModule {
  const d: DiagnosticsWorkspaceDeps = { ...defaultDeps, ...deps };

  const runGeneration = (ctx: WorkspaceContext, work: Promise<unknown>): void => {
    void work
      .then(() => ctx.rerender())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("nixie | city generation retry failed", err);
        ui.notifications?.error(`Nixie: city generation retry failed — ${message}`);
        ctx.rerender();
      });
  };

  return {
    id: "diagnostics",
    renderShelf(): string {
      return "";
    },
    renderTray(): string {
      return diagnosticsTrayHTML(d.entries(), d.generationState());
    },
    onAction(action: string, _target: HTMLElement, ctx: WorkspaceContext): void {
      switch (action) {
        case "diagnostics-retry-walls":
          ctx.run("generated wall retry", d.retryWalls());
          return;
        case "diagnostics-retry-plan":
          ctx.run("district plan retry", d.retryPlan());
          return;
        case "diagnostics-retry-geometry":
          ctx.run("render retry", d.retryGeometry());
          return;
        case "diagnostics-retry-same-seed":
          runGeneration(ctx, d.retrySameSeed());
          return;
        case "diagnostics-retry-new-seed":
          runGeneration(ctx, d.generateNewSeed());
          return;
        default:
          return;
      }
    },
    onRender(_root: HTMLElement, _ctx: WorkspaceContext): void {}
  };
}
