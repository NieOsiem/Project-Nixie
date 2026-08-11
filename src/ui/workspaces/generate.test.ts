import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClearConfirmation, FullGenerationRequest, FullGenerationResult, GenerationFailure, GenerationPreflight, GenerationState } from "../../adapter/canvas.js";
import {
  currentCoastEdge,
  currentDistrictPool,
  currentOpenSpaceProfile,
  currentSeed,
  currentTerrainMode,
  currentWorkspace,
  DISTRICT_TYPE_IDS,
  setCoastEdge,
  setDistrictPool,
  setHubMode,
  setOpenSpaceProfile,
  setRoadLayout,
  setSeed,
  setTerrainMode,
  setWorkspace
} from "../editor-state.js";
import {
  confirmRandomize,
  fullGenerationRequest,
  generateFormHTML,
  generateProgressHTML,
  generateRecoveryHTML,
  generateStatusMessage,
  generateWorkspace,
  generationProgressState,
  randomSeed,
  randomizeConfirmations,
  stagedDistrictPool,
  type GenerateFormModel,
  type GenerateWorkspaceDeps,
  type StagedGenerateSettings
} from "./generate.js";
import type { WorkspaceContext } from "./types.js";

function preflight(overrides: Partial<GenerationPreflight> = {}): GenerationPreflight {
  return {
    kind: "absent",
    replaceable: true,
    gm: true,
    revision: null,
    schemaVersion: null,
    generatorVersion: null,
    sceneEnabled: true,
    raw: undefined,
    reason: "",
    ...overrides
  };
}

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
    phase: "planning",
    component: "generation",
    error: "Worker failed while planning.",
    canRetrySameSeed: true,
    canGenerateNewSeed: true,
    canRetryGeometry: false,
    ...overrides
  };
}

function formModel(overrides: Partial<GenerateFormModel> = {}): GenerateFormModel {
  return {
    preflight: preflight({ kind: "supported" }),
    preset: "coastal",
    seed: "hand-picked-seed",
    terrainMode: "coastal",
    coastEdge: "east",
    roadLayout: "grid",
    hubMode: "multiple-hubs",
    districtPool: ["old-city", "waterfront"],
    openSpaceProfile: "low",
    busy: false,
    blocked: false,
    stagedProblem: null,
    wallWarning: false,
    completedSeed: null,
    ...overrides
  };
}

function fakeCtx(): WorkspaceContext {
  return { rerender: vi.fn(), run: vi.fn() };
}

function stubUi(): void {
  vi.stubGlobal("ui", { notifications: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } });
}

// The workspace actions are fire-and-forget (`void runRandomize(ctx)`), so tests flush the
// fully microtask-driven confirmation -> start -> notification chain deterministically.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function depSet(overrides: Partial<GenerateWorkspaceDeps> = {}) {
  const confirm = vi.fn(async () => true);
  const start = vi.fn(async (_request: FullGenerationRequest): Promise<FullGenerationResult> => ({ ok: true, state: state({ phase: "complete", seed: "used-seed" }) }));
  const retrySame = vi.fn(async (): Promise<FullGenerationResult> => ({ ok: true, state: state({ phase: "complete", seed: "used-seed" }) }));
  const newSeed = vi.fn(async (): Promise<FullGenerationResult> => ({ ok: true, state: state({ phase: "complete", seed: "fresh-seed" }) }));
  const retryGeometry = vi.fn(async () => undefined);
  const setSceneEnabled = vi.fn(async () => undefined);
  return {
    confirm,
    start,
    retrySame,
    newSeed,
    retryGeometry,
    setSceneEnabled,
    deps: {
      generationPreflight: () => preflight(),
      generationState: () => state(),
      generationActive: () => false,
      startFullGeneration: start,
      retryFullGeneration: retrySame,
      generateNewSeed: newSeed,
      retryGeometry,
      setSceneEnabled,
      confirm,
      ...overrides
    } satisfies GenerateWorkspaceDeps
  };
}

afterEach(() => {
  setSeed("nixie-2");
  setTerrainMode("rectangle");
  setCoastEdge("west");
  setDistrictPool([...DISTRICT_TYPE_IDS]);
  setOpenSpaceProfile("medium");
  setRoadLayout("european");
  setHubMode("single-centre");
  setWorkspace("terrain");
  vi.unstubAllGlobals();
});

describe("Generate tray form state", () => {
  it("renders every staged control: preset, seed, terrain/coast, road/hub, 16 districts, open space", () => {
    const html = generateFormHTML(formModel());
    expect(html).toContain('<select data-field="preset"');
    expect(html).toContain('<option value="full-city">Full City</option>');
    expect(html).toContain('<option value="coastal" selected>Coastal</option>');
    expect(html).toContain('data-field="seed" value="hand-picked-seed"');
    expect(html).toContain('data-field="terrain-mode"');
    expect(html).toContain('<option value="coastal" selected>Coastal</option>');
    expect(html).toContain('data-field="coast-edge"');
    expect(html).toContain('<option value="east" selected>East</option>');
    expect(html).toContain('data-field="road-layout"');
    expect(html).toContain('<option value="grid" selected>Grid</option>');
    expect(html).toContain('data-field="hub-mode"');
    expect(html).toContain('<option value="multiple-hubs" selected>Multiple hubs</option>');
    expect(html).toContain('data-field="open-space-profile"');
    expect(html).toContain('<option value="low" selected>Low</option>');
    expect(html).toContain('data-action="randomize" class="nixie-destructive"');
    expect(html).toContain("Randomize Entire City");
  });

  it("renders exactly the 16 shipping district checkboxes with the staged pool checked", () => {
    const html = generateFormHTML(formModel());
    expect(DISTRICT_TYPE_IDS).toHaveLength(16);
    expect((html.match(/data-field="district-pool"/g) ?? []).length).toBe(16);
    expect(html).toContain('data-district-type="old-city" checked');
    expect(html).toContain('data-district-type="waterfront" checked');
    expect(html).not.toContain('data-district-type="corporate-core" checked');
    for (const id of DISTRICT_TYPE_IDS) expect(html).toContain(`data-district-type="${id}"`);
  });

  it("states that staged settings never modify the current city", () => {
    const html = generateFormHTML(formModel());
    expect(html).toContain("do not modify the current city");
    expect(html).not.toContain("data-action=\"create-rectangle\"");
    expect(html).not.toContain("data-action=\"create-coastal\"");
    expect(html).not.toContain("data-action=\"generate-roads\"");
    expect(html).not.toContain("data-action=\"delete-all-roads\"");
  });

  it("disables every staged control and the action while generation is busy", () => {
    const html = generateFormHTML(formModel({ busy: true }));
    expect(html).toContain('data-action="randomize" class="nixie-destructive" disabled');
    expect(html).toContain('<input type="text" data-field="seed" value="hand-picked-seed" disabled>');
    expect(html).toContain('<select data-field="preset" disabled>');
    expect(html).toContain('<select data-field="terrain-mode" disabled>');
    expect(html).toContain('<select data-field="coast-edge" disabled>');
    expect(html).toContain('<select data-field="road-layout" disabled>');
    expect(html).toContain('<select data-field="hub-mode" disabled>');
    expect(html).toContain('<select data-field="open-space-profile" disabled>');
    expect(html).toContain('data-field="district-pool" data-district-type="old-city" checked disabled');
    expect(html).toContain('data-field="enable" checked disabled');
  });

  it("disables the coast edge for rectangle terrain and keeps it for coastal", () => {
    expect(generateFormHTML(formModel({ terrainMode: "rectangle" }))).toContain('<select data-field="coast-edge" disabled>');
    expect(generateFormHTML(formModel({ terrainMode: "coastal" }))).not.toContain('<select data-field="coast-edge" disabled>');
  });

  it("shows refusal language and a disabled action for unsupported and malformed data", () => {
    const unsupported = generateFormHTML(formModel({ preflight: preflight({ kind: "unsupported", replaceable: false }) }));
    expect(unsupported).toContain("unsupported City Generator 2.0 schema");
    expect(unsupported).toMatch(/data-action="randomize"[^>]*disabled/);
    const malformed = generateFormHTML(formModel({ preflight: preflight({ kind: "malformed", replaceable: false }) }));
    expect(malformed).toContain("malformed");
    expect(malformed).toMatch(/data-action="randomize"[^>]*disabled/);
  });

  it("keeps the replaceable message for legacy and obsolete data with the action enabled", () => {
    const legacy = generateFormHTML(formModel({ preflight: preflight({ kind: "legacy", replaceable: true }) }));
    expect(legacy).toContain("City Generator 1.0 data");
    expect(legacy).toMatch(/data-action="randomize" class="nixie-destructive">/);
    const obsolete = generateFormHTML(formModel({ preflight: preflight({ kind: "obsolete-precomplete", replaceable: true }) }));
    expect(obsolete).toContain("outdated, incomplete");
    expect(obsolete).toMatch(/data-action="randomize" class="nixie-destructive">/);
  });

  it("gates the randomize action on GM authority with a GM-only message", () => {
    const html = generateFormHTML(formModel({ preflight: preflight({ gm: false }) }));
    expect(html).toMatch(/data-action="randomize"[^>]*disabled/);
    expect(html).toContain("Only a GM may replace or create a city");
    expect(generateFormHTML(formModel({ preflight: preflight({ gm: true }) }))).toMatch(/data-action="randomize" class="nixie-destructive">/);
  });

  it("blocks generation until the Scene is enabled", () => {
    const html = generateFormHTML(formModel({ preflight: preflight({ kind: "supported", sceneEnabled: false }) }));
    expect(html).toContain("Nixie is disabled on this Scene");
    expect(html).toMatch(/data-action="randomize"[^>]*disabled/);
    expect(html).not.toContain('data-field="enable" checked');
  });

  it("disables the action and shows the reason when the staged form is invalid", () => {
    const html = generateFormHTML(formModel({ stagedProblem: "Enter a non-empty city seed." }));
    expect(html).toMatch(/data-action="randomize"[^>]*disabled/);
    expect(html).toContain('data-status="staged-invalid"');
    expect(html).toContain("Enter a non-empty city seed.");
    expect(generateFormHTML(formModel())).not.toContain('data-status="staged-invalid"');
  });

  it("renders the completion and wall-warning notes", () => {
    const html = generateFormHTML(formModel({ completedSeed: "used-seed", wallWarning: true }));
    expect(html).toContain("City generated with seed used-seed.");
    expect(html).toContain('data-status="wall-warning"');
    expect(html).toContain('data-action="generate-diagnostics"');
    expect(generateFormHTML(formModel())).not.toContain("City generated with seed");
  });

  it("builds the status message per preflight kind", () => {
    expect(generateStatusMessage(preflight({ kind: "unsupported" }))).toContain("unavailable");
    expect(generateStatusMessage(preflight({ kind: "malformed" }))).toContain("malformed");
    expect(generateStatusMessage(preflight({ kind: "legacy" }))).toContain("read-only");
    expect(generateStatusMessage(preflight({ kind: "absent" }))).toContain("No Nixie city");
    expect(generateStatusMessage(preflight({ kind: "supported", sceneEnabled: true }))).toContain("complete");
  });

  it("filters unknown district ids out of the staged pool", () => {
    expect(stagedDistrictPool(["old-city", "bogus", "waterfront", ""])).toEqual(["old-city", "waterfront"]);
  });
});

describe("Randomize Entire City confirmations", () => {
  it("shows discard language first and uninterruptible language second, in order", () => {
    const dialogs = randomizeConfirmations(preflight({ kind: "supported" }));
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0]!.title).toBe("Nixie: Replace the current city?");
    expect(dialogs[0]!.content).toContain("permanently discards");
    expect(dialogs[0]!.content).toContain("cannot be restored with Undo");
    expect(dialogs[1]!.title).toBe("Nixie: Start uninterruptible generation?");
    expect(dialogs[1]!.content).toContain("cannot be cancelled");
    expect(dialogs[1]!.content).toContain("closing the editor");
  });

  it("warns that Nixie-owned content, locks, generated walls, and City Generator history are discarded", () => {
    const dialogs = randomizeConfirmations(preflight({ kind: "supported" }));
    const first = dialogs[0]!;
    expect(first.content).toContain("Nixie-owned city content");
    expect(first.content).toContain("locks");
    expect(first.content).toContain("generated walls");
    expect(first.content).toContain("City Generator undo and redo history");
    expect(first.content).toContain("cannot be restored with Undo");
    expect(dialogs[1]!.content).toContain("cannot be cancelled or undone");
  });

  it("carries the discard warning into the legacy and obsolete first dialogs", () => {
    for (const kind of ["legacy", "obsolete-precomplete"] as const) {
      const first = randomizeConfirmations(preflight({ kind }))[0]!;
      expect(first.content).toContain("Nixie-owned city content");
      expect(first.content).toContain("locks");
      expect(first.content).toContain("generated walls");
      expect(first.content).toContain("City Generator undo and redo history");
    }
  });

  it("uses kind-specific first dialogs for legacy and obsolete data", () => {
    const legacy = randomizeConfirmations(preflight({ kind: "legacy" }))[0]!;
    expect(legacy.title).toBe("Nixie: Replace the legacy city?");
    expect(legacy.content).toContain("City Generator 1.0 data");
    const obsolete = randomizeConfirmations(preflight({ kind: "obsolete-precomplete" }))[0]!;
    expect(obsolete.title).toBe("Nixie: Replace the outdated city?");
    expect(obsolete.content).toContain("outdated, incomplete");
  });

  it("uses a build-first dialog when the Scene has no city", () => {
    const dialogs = randomizeConfirmations(preflight({ kind: "absent" }));
    expect(dialogs[0]!.title).toBe("Nixie: Generate a new city?");
  });

  it("confirms both dialogs in order when accepted", async () => {
    const confirm = vi.fn(async () => true);
    expect(await confirmRandomize(preflight({ kind: "supported" }), confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("cancelling the first dialog stops before the second and changes nothing", async () => {
    const confirm = vi.fn(async () => false);
    expect(await confirmRandomize(preflight({ kind: "supported" }), confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("cancelling the second dialog returns false after both were shown", async () => {
    let calls = 0;
    const confirm = vi.fn(async () => {
      calls += 1;
      return calls < 2;
    });
    expect(await confirmRandomize(preflight({ kind: "supported" }), confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe("Full generation request", () => {
  const staged: StagedGenerateSettings = {
    terrainMode: "coastal",
    coastEdge: "north",
    seed: "staged-seed",
    roadLayout: "grid",
    hubMode: "multiple-hubs",
    districtPool: ["old-city", "waterfront"],
    openSpaceProfile: "high"
  };

  it("passes staged settings through with the pinned confirmation and randomize flag", () => {
    const confirmation: ClearConfirmation = { kind: "supported", revision: 4, identity: '{"revision":4}' };
    expect(fullGenerationRequest(staged, true, confirmation)).toEqual({
      terrainMode: "coastal",
      coastEdge: "north",
      citySeed: "staged-seed",
      roadLayout: "grid",
      hubMode: "multiple-hubs",
      districtPool: ["old-city", "waterfront"],
      openSpaceProfile: "high",
      randomize: true,
      confirmation
    });
    expect(fullGenerationRequest(staged, false, "absent")).toMatchObject({ randomize: false, confirmation: "absent" });
  });

  it("maps rectangle and custom terrain modes to a null coast edge", () => {
    expect(fullGenerationRequest({ ...staged, terrainMode: "rectangle" }, false, "absent").coastEdge).toBeNull();
    expect(fullGenerationRequest({ ...staged, terrainMode: "custom" }, false, "absent")).toMatchObject({ terrainMode: "rectangle", coastEdge: null });
  });

  it("generates fresh human-readable seeds", () => {
    expect(randomSeed(() => 0)).toMatch(/^[a-z]+-[a-z]+-\d+$/);
    expect(randomSeed(() => 0)).not.toBe(randomSeed(() => 0.99));
  });
});

describe("Generation progress", () => {
  it("derives labels and step state from the durable phase", () => {
    expect(generationProgressState(state({ phase: "planning" }))).toEqual({ label: "Planning city structure…", percent: null, done: 0, active: null });
    expect(generationProgressState(state({ phase: "installing", progress: { index: 4, total: 10 } }))).toEqual({ label: "Rendering city chunks…", percent: 40, done: 2, active: 2 });
    expect(generationProgressState(state({ phase: "installing", progress: { index: 10, total: 10 } })).active).toBeNull();
  });

  it("renders uninterruptible progress with no Cancel and all seven phase steps", () => {
    const html = generateProgressHTML(state({ active: true, phase: "installing", progress: { index: 4, total: 10 } }));
    expect(html).toContain("This operation cannot be cancelled.");
    expect(html).toContain("40% complete");
    expect(html).toContain('class="nixie-progress-step done"');
    expect(html).toContain('class="nixie-progress-step active"');
    expect(html).not.toContain("data-action=\"cancel\"");
    expect(html).not.toContain("Randomize Entire City");
    // Exactly the seven phase steps: the wrapper list uses `nixie-progress-steps`, so a
    // step match must be followed by the closing quote or a state class, not an "s".
    expect((html.match(/nixie-progress-step(?=[" ])/g) ?? []).length).toBe(7);
  });

  it("claims only implemented Phase 4 work: walls, no Phase-5 props, vehicles, or POIs", () => {
    const html = generateProgressHTML(state({ active: true, phase: "installing", progress: { index: 6, total: 7 } }));
    expect(html).toContain("Rendering city chunks");
    expect(html).toContain("Walls and final chunk presentation");
    expect(html).not.toMatch(/props/i);
    expect(html).not.toMatch(/vehicles/i);
    expect(html).not.toMatch(/POIs?/i);
    expect(generateProgressHTML(state({ phase: "planning" }))).toContain("Planning city structure");
    expect(generateProgressHTML(state({ phase: "saving" }))).toContain("Saving the city");
  });
});

describe("Structural failure recovery", () => {
  it("renders the failing component, error, and retry actions", () => {
    const f = failure();
    const html = generateRecoveryHTML(state({ phase: "failed", failure: f }), f);
    expect(html).toContain("City generation failed");
    expect(html).toContain("Worker failed while planning.");
    expect(html).toContain("Structural failure while generating the city");
    expect(html).toContain('data-action="retry-same-seed">Retry Same Seed</button>');
    expect(html).toContain('data-action="retry-new-seed">Generate New Seed</button>');
    expect(html).toContain('data-action="retry-geometry" disabled');
    expect(html).toContain('data-action="generate-diagnostics">Diagnostics</button>');
  });

  it("disables retry actions while the operation is active", () => {
    const f = failure();
    const html = generateRecoveryHTML(state({ active: true, phase: "failed", failure: f }), f);
    expect(html).toContain('data-action="retry-same-seed" disabled');
    expect(html).toContain('data-action="retry-new-seed" disabled');
    expect(html).toContain('data-action="retry-geometry" disabled');
  });

  it("labels save and chunk failures distinctly", () => {
    const save = generateRecoveryHTML(state({ phase: "failed", failure: failure({ component: "save", error: "Save failed." }) }), failure({ component: "save", error: "Save failed." }));
    expect(save).toContain("Structural failure while saving the city");
    const chunks = generateRecoveryHTML(state({ phase: "failed", failure: failure({ component: "chunks", error: "Chunk failed.", canRetryGeometry: true }) }), failure({ component: "chunks", error: "Chunk failed.", canRetryGeometry: true }));
    expect(chunks).toContain("final chunk rendering failed");
    expect(chunks).toContain('data-action="retry-geometry">Retry rendering</button>');
  });
});

describe("Generate workspace behavior", () => {
  it("runs both confirmations then starts with the staged seed and the pinned confirmation", async () => {
    stubUi();
    setSeed("hand-picked");
    setTerrainMode("coastal");
    setCoastEdge("north");
    setRoadLayout("grid");
    setHubMode("multiple-hubs");
    setDistrictPool(["old-city", "waterfront"]);
    setOpenSpaceProfile("low");
    const { deps, confirm, start } = depSet();
    const module = generateWorkspace(deps);
    const ctx = fakeCtx();
    module.onAction("randomize", {} as HTMLElement, ctx);
    await flushMicrotasks();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledWith({
      terrainMode: "coastal",
      coastEdge: "north",
      citySeed: "hand-picked",
      roadLayout: "grid",
      hubMode: "multiple-hubs",
      districtPool: ["old-city", "waterfront"],
      openSpaceProfile: "low",
      randomize: false,
      confirmation: "absent"
    });
    expect(ctx.rerender).toHaveBeenCalled();
  });

  it("pins the exact pre-dialog confirmation into the generation request", async () => {
    stubUi();
    setSeed("pinned-seed");
    const { deps, start } = depSet({ generationPreflight: () => preflight({ kind: "supported", replaceable: true, revision: 5 }) });
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(start).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0]![0];
    expect(request).toMatchObject({ citySeed: "pinned-seed", randomize: false });
    expect(request.confirmation).toMatchObject({ kind: "supported", revision: 5 });
    // The confirmation also carries the raw-payload identity observed with the preflight.
    if (typeof request.confirmation !== "string") expect(request.confirmation.identity.length).toBeGreaterThan(0);
  });

  it("never shows confirmations or starts for a non-GM", async () => {
    stubUi();
    const { deps, confirm, start } = depSet({ generationPreflight: () => preflight({ gm: false }) });
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(confirm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("changes nothing when the first confirmation is cancelled", async () => {
    stubUi();
    const { deps, start } = depSet({ confirm: vi.fn(async () => false) });
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(start).not.toHaveBeenCalled();
  });

  it("changes nothing when the second confirmation is cancelled", async () => {
    stubUi();
    let calls = 0;
    const confirm = vi.fn(async () => {
      calls += 1;
      return calls < 2;
    });
    const { deps, start } = depSet({ confirm });
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses unsupported data without confirmations or a start", async () => {
    stubUi();
    const { deps, confirm, start } = depSet({ generationPreflight: () => preflight({ kind: "unsupported", replaceable: false }) });
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(confirm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects an empty staged seed before any confirmation or start", async () => {
    stubUi();
    setSeed("   ");
    const { deps, confirm, start } = depSet();
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(confirm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects an empty district pool before any confirmation or start", async () => {
    stubUi();
    setDistrictPool([]);
    const { deps, confirm, start } = depSet();
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(confirm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores the action while generation is already active", async () => {
    stubUi();
    const { deps, confirm, start } = depSet({ generationActive: () => true });
    const module = generateWorkspace(deps);
    module.onAction("randomize", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(confirm).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("retries with the same seed and with a new seed from the failure state", async () => {
    stubUi();
    const f = failure();
    const { deps, retrySame, newSeed } = depSet({ generationState: () => state({ phase: "failed", failure: f }), generationActive: () => false });
    const module = generateWorkspace(deps);
    module.onAction("retry-same-seed", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(retrySame).toHaveBeenCalled();
    module.onAction("retry-new-seed", {} as HTMLElement, fakeCtx());
    await flushMicrotasks();
    expect(newSeed).toHaveBeenCalled();
  });

  it("retries final rendering through the standard action runner", () => {
    const { deps, retryGeometry } = depSet();
    const module = generateWorkspace(deps);
    const ctx = fakeCtx();
    module.onAction("retry-geometry", {} as HTMLElement, ctx);
    expect(retryGeometry).toHaveBeenCalled();
    expect(ctx.run).toHaveBeenCalledWith("render retry", expect.any(Promise));
  });

  it("rerolls the staged seed without touching the adapter", async () => {
    const { deps, start, confirm } = depSet();
    const module = generateWorkspace(deps);
    const ctx = fakeCtx();
    module.onAction("reroll-seed", {} as HTMLElement, ctx);
    await flushMicrotasks();
    expect(currentSeed()).toMatch(/^[a-z]+-[a-z]+-\d+$/);
    expect(start).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(ctx.rerender).toHaveBeenCalled();
  });

  it("switches to Diagnostics from the recovery path", () => {
    const { deps } = depSet();
    const module = generateWorkspace(deps);
    module.onAction("generate-diagnostics", {} as HTMLElement, fakeCtx());
    expect(currentWorkspace()).toBe("diagnostics");
  });

  it("renders progress while active and recovery after failure", () => {
    const { deps: activeDeps } = depSet({
      generationState: () => state({ active: true, phase: "installing", progress: { index: 1, total: 2 } }),
      generationActive: () => true
    });
    expect(generateWorkspace(activeDeps).renderTray()).toContain("cannot be cancelled");
    const f = failure();
    const { deps: failedDeps } = depSet({ generationState: () => state({ phase: "failed", failure: f }), generationActive: () => false });
    expect(generateWorkspace(failedDeps).renderTray()).toContain("City generation failed");
  });

  it("keeps the staged Generate settings out of the adapter until the action runs", async () => {
    stubUi();
    setTerrainMode("coastal");
    setCoastEdge("south");
    setDistrictPool(["old-city"]);
    setOpenSpaceProfile("none");
    const { deps, start } = depSet();
    const module = generateWorkspace(deps);
    module.renderTray();
    expect(start).not.toHaveBeenCalled();
    expect(currentTerrainMode()).toBe("coastal");
    expect(currentCoastEdge()).toBe("south");
    expect(currentDistrictPool()).toEqual(["old-city"]);
    expect(currentOpenSpaceProfile()).toBe("none");
    expect(currentSeed()).toBe("nixie-2");
  });
});
