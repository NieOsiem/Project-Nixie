import { beforeEach, describe, expect, it, vi } from "vitest";

type SelectionFixture = { kind: "block" | "district"; ids: string[]; revision: number | null } | null;
type PreflightFixture = {
  target: { kind: "block" | "district"; ids: string[] };
  blockers: Array<{ id: string; kind: string; reason: string }>;
  retainedIds: string[];
  excludedSitePolygons: unknown[];
  removedIds: string[];
  candidateSource: Record<string, unknown> | null;
};

const adapterMocks = vi.hoisted(() => ({
  getArchitecturePlanView: vi.fn<() => unknown>(() => null),
  getCity: vi.fn<() => unknown>(() => null),
  getDistrictPlanView: vi.fn<() => unknown>(() => null),
  isSceneEnabled: vi.fn(() => true),
  preflightRegeneration: vi.fn<(target: unknown, seed: string, revision?: number) => Promise<PreflightFixture>>(),
  regenerateTargets: vi.fn<(target: unknown, seed: string | null, revision?: number) => Promise<unknown>>()
}));
const stateMocks = vi.hoisted(() => ({
  REGENERATE_TOOL: { BLOCK: "block", DISTRICT: "district" },
  canvasTool: vi.fn<() => string | null>(() => "block"),
  clearRegenerationSelection: vi.fn(),
  currentPendingOperation: vi.fn<() => string | null>(() => null),
  getRegenerationSelection: vi.fn<() => SelectionFixture>(() => null),
  isPendingOperation: vi.fn(() => false),
  refreshRegenerationSelectionRevision: vi.fn(),
  setCanvasTool: vi.fn(),
  setRegenerationStagingClearListener: vi.fn()
}));
const layerMocks = vi.hoisted(() => ({
  clearRegenerationBlockers: vi.fn(),
  describeRegenerationBlockers: vi.fn((blockers: Array<{ id: string; kind: string; reason: string }>) =>
    blockers.map((blocker) => ({ ...blocker, geometryId: blocker.id }))
  ),
  regenerationProtectionSummary: vi.fn(() => ({ protectedIds: ["p1"], reservedIds: ["r1"] })),
  regenerationSeedSummary: vi.fn<() => { values: string[]; display: string | null; overriddenIds: string[]; unseededFragments: number }>(() => ({ values: [], display: null, overriddenIds: [], unseededFragments: 0 })),
  regenerationTargetOverlays: vi.fn(() => ({ emphasis: [], final: [[[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]]] })),
  setRegenerationBlockers: vi.fn()
}));
vi.mock("../../adapter/canvas.js", () => adapterMocks);
vi.mock("../editor-state.js", () => stateMocks);
vi.mock("../regenerate-layer.js", () => layerMocks);

import { clearRegenerateWorkspaceState, regenerateWorkspace } from "./regenerate.js";

const city = { revision: 7, source: {} };
const selection = (kind: "block" | "district", ids: string[], revision: number | null = 7) => ({ kind, ids, revision });
const cleanPreflight = (): PreflightFixture => ({
  target: { kind: "block", ids: ["block-a"] },
  blockers: [],
  retainedIds: ["kept-1"],
  excludedSitePolygons: [[{ x: 0, y: 0 }]],
  removedIds: ["removed-1"],
  candidateSource: { ok: true }
});

function fakeContext() {
  const errors: unknown[] = [];
  return {
    errors,
    ctx: {
      rerender: vi.fn(),
      run: vi.fn((_label: string, work: Promise<unknown>, then?: () => void) => {
        void work.then(then).catch((error: unknown) => errors.push(error));
      })
    }
  };
}

function actionTarget(dataset: Record<string, string> = {}): HTMLElement {
  return { dataset } as unknown as HTMLElement;
}

function fakeRoot(): HTMLElement {
  return { querySelector: () => null } as unknown as HTMLElement;
}

/** Drains the pending microtask chain of the mocked run wrapper without timers. */
async function flush(): Promise<void> {
  for (let step = 0; step < 10; step++) await Promise.resolve();
}

function runButton(tray: string): string {
  return tray.match(/<button[^>]*data-action="regen-run"[^>]*>/)?.[0] ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRegenerateWorkspaceState();
  adapterMocks.getCity.mockReturnValue(city);
  adapterMocks.getDistrictPlanView.mockReturnValue({ blocks: [] });
  adapterMocks.getArchitecturePlanView.mockReturnValue({ buildings: [], landmarks: [] });
  adapterMocks.isSceneEnabled.mockReturnValue(true);
  adapterMocks.preflightRegeneration.mockResolvedValue(cleanPreflight());
  adapterMocks.regenerateTargets.mockResolvedValue({ full: true });
  stateMocks.canvasTool.mockReturnValue("block");
  stateMocks.getRegenerationSelection.mockReturnValue(null);
  stateMocks.isPendingOperation.mockReturnValue(false);
  stateMocks.currentPendingOperation.mockReturnValue(null);
  layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
});

describe("Regenerate shelf", () => {
  it("exposes both target modes with active state, summary, and accessibility", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["a", "b"]));
    const shelf = regenerateWorkspace().renderShelf();
    expect(shelf).toContain('data-action="regen-tool" data-mode="block"');
    expect(shelf).toContain('data-action="regen-tool" data-mode="district"');
    expect(shelf).toContain("2 blocks selected");
    expect(shelf).toContain('aria-pressed="true"');
    expect(shelf).toContain('aria-label="Clear the regeneration selection"');
  });

  it("reports a singular district summary", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("district", ["north"]));
    expect(regenerateWorkspace().renderShelf()).toContain("1 district selected");
  });

  it("locks shelf controls while an operation is pending", () => {
    stateMocks.isPendingOperation.mockReturnValue(true);
    expect(regenerateWorkspace().renderShelf()).toContain(" disabled");
  });
});

describe("Regenerate tray", () => {
  it("prompts for a target and offers no run action without a selection", () => {
    const tray = regenerateWorkspace().renderTray();
    expect(tray).toContain("Select complete blocks");
    expect(tray).not.toContain('data-action="regen-run"');
  });

  it("shows exact target identity, seed display, roads statement, and protection counts", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a", "block-b"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: ["s-1", "s-2"], display: "Multiple", overriddenIds: [], unseededFragments: 0 });
    const tray = regenerateWorkspace().renderTray();
    expect(tray).toContain("2 complete blocks");
    expect(tray).toContain("<code>block-a</code>, <code>block-b</code>");
    expect(tray).toContain("Persisted seed (effective): <code>Multiple</code>");
    expect(tray).not.toContain("partly overridden");
    expect(tray).toContain("Roads remain fixed");
    expect(tray).toContain("Protected content: 1 object, reserved sites: 1");
    expect(runButton(tray)).not.toContain("disabled");
    expect(tray).not.toMatch(/data-action="[^"]*cancel/i);
  });

  it("labels stored block seed records as overridden when a newer district event controls them", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: ["district-new"], display: "district-new", overriddenIds: ["block-a"], unseededFragments: 0 });
    const tray = regenerateWorkspace().renderTray();
    expect(tray).toContain("Persisted seed (effective): <code>district-new</code>");
    expect(tray).toContain("partly overridden by a newer regeneration event");
    expect(tray).toContain("those fragments follow the newer seed");
  });

  it("disables the run action for a stale selection and explains why", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"], 5));
    const tray = regenerateWorkspace().renderTray();
    expect(tray).toContain("selection is stale");
    expect(runButton(tray)).toContain("disabled");
  });
});

describe("Regenerate preflight and commit flow", () => {
  it("runs preflight before generation and reuses one chosen seed across preflight and commit", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: ["persisted"], display: "persisted", overriddenIds: [], unseededFragments: 0 });
    const module = regenerateWorkspace();
    module.renderTray();
    const { ctx } = fakeContext();
    module.onAction("regen-new-seed", actionTarget(), ctx);
    expect(ctx.rerender).toHaveBeenCalled();
    module.onAction("regen-run", actionTarget(), ctx);
    await flush();
    expect(adapterMocks.preflightRegeneration).toHaveBeenCalledTimes(1);
    expect(adapterMocks.regenerateTargets).toHaveBeenCalledTimes(1);
    expect(adapterMocks.preflightRegeneration.mock.calls[0]![1]).toBe(adapterMocks.regenerateTargets.mock.calls[0]![1]);
    expect(adapterMocks.preflightRegeneration.mock.calls[0]![0]).toEqual({ kind: "block", ids: ["block-a"] });
    expect(adapterMocks.regenerateTargets.mock.calls[0]![0]).toEqual({ kind: "block", ids: ["block-a"] });
    expect(adapterMocks.preflightRegeneration.mock.calls[0]![2]).toBe(7);
    expect(adapterMocks.regenerateTargets.mock.calls[0]![2]).toBe(7);
    expect(adapterMocks.regenerateTargets.mock.calls[0]![1]).not.toBeNull();
  });

  it("starts no generation when preflight reports blockers and surfaces them durably", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: ["persisted"], display: "persisted", overriddenIds: [], unseededFragments: 0 });
    const blockers = [
      { id: "b1", kind: "building", reason: "is locked" },
      { id: "b2", kind: "place", reason: "blocks a compound" }
    ];
    adapterMocks.preflightRegeneration.mockResolvedValue({ ...cleanPreflight(), blockers, candidateSource: null });
    const module = regenerateWorkspace();
    module.renderTray();
    const { ctx, errors } = fakeContext();
    module.onAction("regen-run", actionTarget(), ctx);
    await flush();
    expect(adapterMocks.regenerateTargets).not.toHaveBeenCalled();
    expect(layerMocks.setRegenerationBlockers).toHaveBeenCalledWith(blockers);
    const thrown = errors[0] as { blockers?: unknown; message?: string };
    expect(thrown?.blockers).toEqual(blockers);
    expect(thrown?.message).toContain("No generation started");
    const tray = module.renderTray();
    expect(tray).toContain("Regeneration blocked (2) — no generation started");
    expect(tray).toContain("nixie-regen-blocker-kind");
    expect(tray).toContain("is locked");
    expect(tray).toContain("blocks a compound");
    expect(tray).toContain('data-action="regen-dismiss-blockers"');
    expect(tray).toContain("Protection is never overridden");
  });

  it("chooses a fresh seed for every attempt when the staged seed is empty", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("district", ["north"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
    const module = regenerateWorkspace();
    module.renderTray();
    const { ctx } = fakeContext();
    module.onAction("regen-run", actionTarget(), ctx);
    await flush();
    const firstSeed = adapterMocks.preflightRegeneration.mock.calls[0]![1];
    adapterMocks.preflightRegeneration.mockClear();
    adapterMocks.regenerateTargets.mockClear();
    module.onAction("regen-run", actionTarget(), ctx);
    await flush();
    expect(adapterMocks.preflightRegeneration).toHaveBeenCalledTimes(1);
    expect(adapterMocks.preflightRegeneration.mock.calls[0]![1]).not.toBe(firstSeed);
  });

  it("keeps the target regenerable after success by refreshing its retained revision", async () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
    const module = regenerateWorkspace();
    module.renderTray();
    const { ctx } = fakeContext();
    module.onAction("regen-run", actionTarget(), ctx);
    await flush();
    expect(stateMocks.refreshRegenerationSelectionRevision).toHaveBeenCalledWith(7);
    expect(ctx.rerender).toHaveBeenCalled();
  });

  it("refuses to start while an operation is pending", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
    const module = regenerateWorkspace();
    module.renderTray();
    stateMocks.isPendingOperation.mockReturnValue(true);
    const { ctx } = fakeContext();
    module.onAction("regen-run", actionTarget(), ctx);
    expect(adapterMocks.preflightRegeneration).not.toHaveBeenCalled();
  });

  it("marks the operation uninterruptible: pending tray has aria-busy and no cancel control", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
    stateMocks.isPendingOperation.mockReturnValue(true);
    const tray = regenerateWorkspace().renderTray();
    expect(tray).toContain("aria-busy");
    expect(tray).toContain("uninterruptible");
    expect(tray).toContain('role="status"');
    expect(tray).not.toMatch(/data-action="[^"]*cancel/i);
  });
});

describe("Regenerate workspace lifecycle", () => {
  it("clears prior mode selection when switching target tool", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    const { ctx } = fakeContext();
    regenerateWorkspace().onAction("regen-tool", actionTarget({ mode: "district" }), ctx);
    expect(stateMocks.clearRegenerationSelection).toHaveBeenCalled();
    expect(stateMocks.setCanvasTool).toHaveBeenCalledWith("district");
    expect(ctx.rerender).toHaveBeenCalled();
  });

  it("keeps a compatible selection when switching to the same mode", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    const { ctx } = fakeContext();
    regenerateWorkspace().onAction("regen-tool", actionTarget({ mode: "block" }), ctx);
    expect(stateMocks.clearRegenerationSelection).not.toHaveBeenCalled();
    expect(stateMocks.setCanvasTool).toHaveBeenCalledWith("block");
  });

  it("registers the staging clear listener and clears blocker presentation through it", () => {
    regenerateWorkspace().onRender(fakeRoot(), fakeContext().ctx);
    expect(stateMocks.setRegenerationStagingClearListener).toHaveBeenCalledTimes(1);
    const listener = stateMocks.setRegenerationStagingClearListener.mock.calls[0]![0] as () => void;
    listener();
    expect(layerMocks.clearRegenerationBlockers).toHaveBeenCalled();
  });

  it("clears everything on workspace state reset", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    regenerateWorkspace().renderTray();
    clearRegenerateWorkspaceState();
    expect(layerMocks.clearRegenerationBlockers).toHaveBeenCalled();
  });
});

describe("Regenerate seed staging", () => {
  it("resets the staged seed when the selection changes", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
    const module = regenerateWorkspace();
    const { ctx } = fakeContext();
    module.renderTray();
    module.onAction("regen-new-seed", actionTarget(), ctx);
    expect(module.renderTray()).toMatch(/value="[0-9a-f]{32}"/);
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-b"]));
    expect(module.renderTray()).toContain('value=""');
  });

  it("dismisses the blocker list explicitly", () => {
    stateMocks.getRegenerationSelection.mockReturnValue(selection("block", ["block-a"]));
    layerMocks.regenerationSeedSummary.mockReturnValue({ values: [], display: null, overriddenIds: [], unseededFragments: 0 });
    const { ctx } = fakeContext();
    regenerateWorkspace().onAction("regen-dismiss-blockers", actionTarget(), ctx);
    expect(layerMocks.clearRegenerationBlockers).toHaveBeenCalled();
    expect(ctx.rerender).toHaveBeenCalled();
  });
});
