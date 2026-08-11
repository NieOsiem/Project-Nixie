import { describe, expect, it, vi } from "vitest";
import type { GenerationFailure, GenerationState } from "../../adapter/canvas.js";
import {
  diagnosticViews,
  diagnosticsTrayHTML,
  diagnosticsWorkspace,
  hasActionableDiagnosticViews,
  hasWallRetry,
  sanitizeDiagnosticEntry,
  type DiagnosticsWorkspaceDeps
} from "./diagnostics.js";
import type { WorkspaceContext } from "./types.js";

function state(overrides: Partial<GenerationState> = {}): GenerationState {
  return {
    active: false,
    phase: "idle",
    progress: null,
    failure: null,
    seed: null,
    canRetrySameSeed: false,
    canGenerateNewSeed: false,
    canRetryGeometry: false,
    sourceRevision: null,
    epoch: 0,
    startedAt: null,
    completedAt: null,
    ...overrides
  };
}

function failure(overrides: Partial<GenerationFailure> = {}): GenerationFailure {
  return {
    phase: "installing",
    component: "chunks",
    error: "Chunk install failed.",
    canRetrySameSeed: true,
    canGenerateNewSeed: true,
    canRetryGeometry: true,
    ...overrides
  };
}

function fakeCtx(): WorkspaceContext {
  return { rerender: vi.fn(), run: vi.fn() };
}

function depSet(overrides: Partial<DiagnosticsWorkspaceDeps> = {}) {
  const retryWalls = vi.fn(async () => undefined);
  const retryPlan = vi.fn(async () => undefined);
  const retryGeometry = vi.fn(async () => undefined);
  const retrySameSeed = vi.fn(async () => undefined);
  const generateNewSeed = vi.fn(async () => undefined);
  return {
    retryWalls,
    retryPlan,
    retryGeometry,
    retrySameSeed,
    generateNewSeed,
    deps: {
      entries: () => [],
      generationState: () => state(),
      retryWalls,
      retryPlan,
      retryGeometry,
      retrySameSeed,
      generateNewSeed,
      ...overrides
    } satisfies DiagnosticsWorkspaceDeps
  };
}

describe("Diagnostics workspace", () => {
  it("retains degraded wall diagnostics with a retry action", () => {
    const html = diagnosticsTrayHTML([{ subsystem: "walls", retry: "walls", message: "Wall replacement failed." }]);
    expect(html).toContain("Wall replacement failed.");
    expect(html).toContain('data-action="diagnostics-retry-walls"');
    expect(html).toContain("Retry generated walls");
  });

  it("renders the empty state", () => {
    expect(diagnosticsTrayHTML([])).toContain("No diagnostics recorded");
  });

  it("sanitizes entries down to user-facing fields, dropping developer internals", () => {
    const view = sanitizeDiagnosticEntry({
      subsystem: "walls",
      retry: "walls",
      message: "Wall replacement failed.",
      kind: "degraded",
      revision: 7,
      epoch: 3,
      actionToken: "a1",
      buildToken: "b1",
      workerMode: "worker",
      raw: { anything: true }
    });
    expect(view).toEqual({ severity: "warning", message: "Wall replacement failed.", subsystem: "walls", retry: "walls" });
    expect(sanitizeDiagnosticEntry({ epoch: 3 })).toBeNull();
    expect(sanitizeDiagnosticEntry("nope" as unknown as Record<string, unknown>)).toBeNull();
  });

  it("maps plan entries to district-planning retries and marks actionable views", () => {
    const views = diagnosticViews([
      { subsystem: "districts", retry: "plan", message: "Planning failed." },
      { subsystem: "districts", message: "A warning without a retry." },
      { subsystem: "walls", retry: "walls", message: "Walls degraded." }
    ]);
    expect(views[0]).toEqual({ severity: "warning", message: "Planning failed.", subsystem: "districts", retry: "plan" });
    expect(views[1]).toEqual({ severity: "error", message: "A warning without a retry.", subsystem: "districts", retry: null });
    expect(views[2]).toEqual({ severity: "warning", message: "Walls degraded.", subsystem: "walls", retry: "walls" });
    expect(hasActionableDiagnosticViews(views)).toBe(true);
    expect(hasActionableDiagnosticViews([views[1]!])).toBe(false);
    expect(hasWallRetry(views)).toBe(true);
    expect(hasWallRetry([views[0]!])).toBe(false);
  });

  it("shows the structural failure with same-seed, new-seed, and render retries", () => {
    const f = failure();
    const html = diagnosticsTrayHTML([], state({ phase: "failed", failure: f }));
    expect(html).toContain("Structural generation failure");
    expect(html).toContain("Chunk install failed.");
    expect(html).toContain("Failing component: rendering city chunks");
    expect(html).toContain('data-action="diagnostics-retry-same-seed">Retry Same Seed</button>');
    expect(html).toContain('data-action="diagnostics-retry-new-seed">Generate New Seed</button>');
    expect(html).toContain('data-action="diagnostics-retry-geometry">Retry rendering</button>');
  });

  it("disables generation retries that the failure does not support", () => {
    const f = failure({ canRetrySameSeed: false, canRetryGeometry: false });
    const html = diagnosticsTrayHTML([], state({ phase: "failed", failure: f }));
    expect(html).toContain('data-action="diagnostics-retry-same-seed" disabled');
    expect(html).toContain('data-action="diagnostics-retry-new-seed"');
    expect(html).toContain('data-action="diagnostics-retry-geometry" disabled');
  });

  it("ignores a non-failed generation state", () => {
    expect(diagnosticsTrayHTML([], state({ phase: "complete" }))).toContain("No diagnostics recorded");
  });
});

describe("Diagnostics workspace actions", () => {
  it("routes wall and plan retries through the standard action runner", () => {
    const { deps, retryWalls, retryPlan } = depSet();
    const module = diagnosticsWorkspace(deps);
    const ctx = fakeCtx();
    module.onAction("diagnostics-retry-walls", {} as HTMLElement, ctx);
    expect(retryWalls).toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledWith("generated wall retry", expect.any(Promise));
    module.onAction("diagnostics-retry-plan", {} as HTMLElement, ctx);
    expect(retryPlan).toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledWith("district plan retry", expect.any(Promise));
  });

  it("routes the render retry through the standard action runner", () => {
    const { deps, retryGeometry } = depSet();
    const module = diagnosticsWorkspace(deps);
    const ctx = fakeCtx();
    module.onAction("diagnostics-retry-geometry", {} as HTMLElement, ctx);
    expect(retryGeometry).toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledWith("render retry", expect.any(Promise));
  });

  it("starts same-seed and new-seed generation retries without the action-error panel", async () => {
    vi.stubGlobal("ui", { notifications: { error: vi.fn() } });
    const { deps, retrySameSeed, generateNewSeed } = depSet();
    const module = diagnosticsWorkspace(deps);
    const ctx = fakeCtx();
    module.onAction("diagnostics-retry-same-seed", {} as HTMLElement, ctx);
    module.onAction("diagnostics-retry-new-seed", {} as HTMLElement, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(retrySameSeed).toHaveBeenCalled();
    expect(generateNewSeed).toHaveBeenCalled();
    expect(ctx.run).not.toHaveBeenCalled();
    expect(ctx.rerender).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders the tray from injected entries and generation state", () => {
    const { deps } = depSet({
      entries: () => [{ subsystem: "walls", retry: "walls", message: "Walls degraded." }],
      generationState: () => state({ phase: "failed", failure: failure() })
    });
    const module = diagnosticsWorkspace(deps);
    const html = module.renderTray();
    expect(html).toContain("Walls degraded.");
    expect(html).toContain("Structural generation failure");
  });
});
