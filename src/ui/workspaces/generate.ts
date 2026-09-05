import {
  cityLoadStatus,
  clearConfirmationFor,
  generateNewSeed,
  generationActive,
  generationPreflight,
  generationState,
  retryFullGeneration,
  retryGeometry,
  setSceneEnabled,
  startFullGeneration,
  validateGenerationStaging,
  type ClearConfirmation,
  type FullGenerationRequest,
  type FullGenerationResult,
  type FullGenerationStaging,
  type GenerationFailure,
  type GenerationPreflight,
  type GenerationState
} from "../../adapter/canvas.js";
import {
  applyGeneratePreset,
  clearEditorActionError,
  currentCoastEdge,
  currentDistrictPool,
  currentHubMode,
  currentOpenSpaceProfile,
  currentRoadLayout,
  currentSeed,
  currentTerrainMode,
  DISTRICT_TYPE_IDS,
  GENERATE_PRESETS,
  setCoastEdge,
  setDistrictPool,
  setHubMode,
  setOpenSpaceProfile,
  setRoadLayout,
  setSeed,
  setTerrainMode,
  setWorkspace,
  type CoastEdge,
  type DistrictOpenSpaceProfile,
  type DistrictTypeId,
  type GeneratePresetId,
  type HubMode,
  type RoadLayout,
  type TerrainMode
} from "../editor-state.js";
import { checked, escapeHTML, generationComponentLabel, selected } from "./shared.js";
import { wallRetryWarningActive } from "./diagnostics.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

const EDGES = ["north", "east", "south", "west"] as const;
const OPEN_SPACE_PROFILES: readonly DistrictOpenSpaceProfile[] = ["none", "very-low", "low", "medium", "high"];

export const GENERATION_PHASE_STEPS = [
  "Terrain, land, and water",
  "Major landmarks and reserved sites",
  "Primary roads and highways",
  "Secondary roads and pedestrian routes",
  "Districts and blocks",
  "Parcels, buildings, and open spaces",
  "Walls and final chunk presentation"
] as const;

export interface ConfirmDialog {
  title: string;
  content: string;
}

/** The staged Generate settings snapshot used to build a full-generation request. */
export interface StagedGenerateSettings {
  terrainMode: TerrainMode;
  coastEdge: CoastEdge;
  seed: string;
  roadLayout: RoadLayout;
  hubMode: HubMode;
  districtPool: readonly DistrictTypeId[];
  openSpaceProfile: DistrictOpenSpaceProfile;
}

/** Data the tray form renders; assembled from editor-state staging + adapter preflight. */
export interface GenerateFormModel {
  preflight: GenerationPreflight;
  preset: GeneratePresetId;
  seed: string;
  terrainMode: TerrainMode;
  coastEdge: CoastEdge;
  roadLayout: RoadLayout;
  hubMode: HubMode;
  districtPool: readonly DistrictTypeId[];
  openSpaceProfile: DistrictOpenSpaceProfile;
  busy: boolean;
  /** Cheap staged-settings problem that disables the action, or null when ready to run. */
  stagedProblem: string | null;
  wallWarning: boolean;
  completedSeed: string | null;
}

const SEED_ADJECTIVES = ["shattered", "neon", "static", "chrome", "hollow", "rusted", "cobalt", "feral", "glass", "wired"] as const;
const SEED_NOUNS = ["grid", "skyline", "rain", "district", "arcade", "signal", "tower", "mirage", "harbour", "circuit"] as const;

/** A fresh human-readable city seed for the staged field. */
export function randomSeed(random: () => number = Math.random): string {
  const pick = (list: readonly string[]): string => list[Math.floor(random() * list.length) % list.length] ?? list[0]!;
  return `${pick(SEED_ADJECTIVES)}-${pick(SEED_NOUNS)}-${10 + Math.floor(random() * 90)}`;
}

/** Staged pool from checked district boxes; unknown ids are never staged. */
export function stagedDistrictPool(checkedIds: readonly string[]): DistrictTypeId[] {
  return checkedIds.filter((id): id is DistrictTypeId => (DISTRICT_TYPE_IDS as readonly string[]).includes(id));
}

/** Staged settings -> the adapter staging shape (custom terrain runs as rectangle). */
function stagingFrom(staged: StagedGenerateSettings): FullGenerationStaging {
  const coastal = staged.terrainMode === "coastal";
  return {
    terrainMode: coastal ? "coastal" : "rectangle",
    coastEdge: coastal ? staged.coastEdge : null,
    citySeed: staged.seed,
    roadLayout: staged.roadLayout,
    hubMode: staged.hubMode,
    districtPool: [...staged.districtPool],
    openSpaceProfile: staged.openSpaceProfile
  };
}

/**
 * Staged settings -> the adapter's single destructive start request. `confirmation` is
 * the pre-dialog preflight pinned before the first dialog so the clear can re-validate
 * the exact Scene state the user confirmed.
 */
export function fullGenerationRequest(staged: StagedGenerateSettings, randomize: boolean, confirmation: ClearConfirmation): FullGenerationRequest {
  return { ...stagingFrom(staged), randomize, confirmation };
}

export function generateStatusMessage(preflight: GenerationPreflight): string {
  if (!preflight.gm) return "Only a GM may replace or create a city with Randomize Entire City.";
  switch (preflight.kind) {
    case "unsupported":
      return "This Scene contains an unsupported City Generator 2.0 schema. Full-city generation is unavailable until the data is migrated or repaired.";
    case "malformed":
      return "The City Generator 2.0 data is malformed. Full-city generation is unavailable until it is repaired.";
    case "legacy":
      return "This Scene contains City Generator 1.0 data. It is read-only until you explicitly replace it with a full-city generation.";
    case "obsolete-precomplete":
      return "This Scene contains an outdated, incomplete City Generator 2.0 city. It is read-only until you explicitly replace it.";
    case "absent":
      return "No Nixie city exists in this Scene. Randomize Entire City generates a new city from the staged settings.";
    case "supported":
      return preflight.sceneEnabled
        ? "The current city is complete. Randomize Entire City replaces it with a new full-city generation."
        : "Nixie is disabled on this Scene. Enable it before generating a city.";
  }
}

/** The two required confirmations (spec §5.2, UI §17.4): discard language first, then uninterruptible. */
export function randomizeConfirmations(preflight: GenerationPreflight): readonly ConfirmDialog[] {
  const first: ConfirmDialog = (() => {
    switch (preflight.kind) {
      case "legacy":
        return {
          title: "Nixie: Replace the legacy city?",
          content: "This Scene contains City Generator 1.0 data. Randomize Entire City permanently discards it and generates a new City Generator 2.0 city. All Nixie-owned city content, locks, generated walls, and City Generator undo and redo history are discarded. The previous city cannot be restored with Undo. Continue?"
        };
      case "obsolete-precomplete":
        return {
          title: "Nixie: Replace the outdated city?",
          content: "This Scene contains an outdated, incomplete City Generator 2.0 city. Randomize Entire City permanently discards it and generates a complete new city. All Nixie-owned city content, locks, generated walls, and City Generator undo and redo history are discarded. The previous city cannot be restored with Undo. Continue?"
        };
      case "supported":
        return {
          title: "Nixie: Replace the current city?",
          content: "Randomize Entire City permanently discards all Nixie-owned city content, locks, generated walls, and City Generator undo and redo history. The previous city cannot be restored with Undo. Continue?"
        };
      default:
        return {
          title: "Nixie: Generate a new city?",
          content: "This Scene has no Nixie city yet. Randomize Entire City generates a new city from the staged settings. Continue?"
        };
    }
  })();
  return [
    first,
    {
      title: "Nixie: Start uninterruptible generation?",
      content: "Once generation begins it cannot be cancelled or undone, and closing the editor or changing the Scene view will not stop it. Continue?"
    }
  ];
}

/**
 * Runs the two ordinary confirmations in order. Returns false — and nothing changes —
 * when either dialog is cancelled.
 */
export async function confirmRandomize(preflight: GenerationPreflight, confirm: (dialog: ConfirmDialog) => Promise<boolean>): Promise<boolean> {
  for (const dialog of randomizeConfirmations(preflight)) {
    if (!(await confirm(dialog))) return false;
  }
  return true;
}

/** Informative progress view derived from the adapter's durable generation state. */
export function generationProgressState(state: GenerationState): { label: string; percent: number | null; done: number; active: number | null } {
  const progress = state.progress;
  const fraction = progress !== null && progress.total > 0 ? Math.min(1, Math.max(0, progress.index / progress.total)) : null;
  switch (state.phase) {
    case "planning":
      return { label: "Planning city structure…", percent: null, done: 0, active: null };
    case "saving":
      return { label: "Saving the city…", percent: null, done: 0, active: null };
    case "installing": {
      const stepCount = GENERATION_PHASE_STEPS.length;
      const done = fraction === null ? 0 : Math.min(stepCount - 1, Math.floor(fraction * stepCount));
      const active = fraction === null || done >= stepCount - 1 ? null : done;
      return { label: "Rendering city chunks…", percent: fraction === null ? null : Math.round(fraction * 100), done, active };
    }
    default:
      return { label: "Generating city…", percent: null, done: 0, active: null };
  }
}

export function generateProgressHTML(state: GenerationState): string {
  const view = generationProgressState(state);
  const steps = GENERATION_PHASE_STEPS.map((step, index) => {
    const stateClass = index < view.done ? " done" : index === view.active ? " active" : "";
    return `<li class="nixie-progress-step${stateClass}">${escapeHTML(step)}</li>`;
  }).join("");
  const bar =
    view.percent === null
      ? ""
      : `<div class="nixie-progress-bar"><div class="nixie-progress-fill" style="width:${view.percent}%"></div></div><p class="nixie-note">${view.percent}% complete</p>`;
  return `<section data-panel="generate" class="nixie-tray-generate">
    <h3>Generating city</h3>
    <div class="nixie-progress-block">
      <p class="nixie-progress-label">${escapeHTML(view.label)}</p>
      ${bar}
      <ul class="nixie-progress-steps">${steps}</ul>
      <p class="nixie-note">This operation cannot be cancelled. Closing the editor does not stop it.</p>
    </div>
  </section>`;
}

export function generateRecoveryHTML(state: GenerationState, failure: GenerationFailure): string {
  const sameSeedDisabled = !failure.canRetrySameSeed || state.active ? " disabled" : "";
  const newSeedDisabled = !failure.canGenerateNewSeed || state.active ? " disabled" : "";
  const geometryDisabled = !failure.canRetryGeometry || state.active ? " disabled" : "";
  const note = failure.component === "chunks"
    ? "The city structure was saved, but final chunk rendering failed. Retry rendering to finish the visible city."
    : `Structural failure while ${generationComponentLabel(failure.component)}. No complete city was committed and the Scene flag stays clear until a retry succeeds.`;
  return `<section data-panel="generate" class="nixie-tray-generate">
    <div class="nixie-recovery">
      <h3>City generation failed</h3>
      <p class="nixie-recovery-error">${escapeHTML(failure.error)}</p>
      <p class="nixie-note">${escapeHTML(note)}</p>
      <div class="nixie-recovery-actions">
        <button type="button" data-action="retry-same-seed"${sameSeedDisabled}>Retry Same Seed</button>
        <button type="button" data-action="retry-new-seed"${newSeedDisabled}>Generate New Seed</button>
        <button type="button" data-action="retry-geometry"${geometryDisabled}>Retry rendering</button>
        <button type="button" data-action="generate-diagnostics">Diagnostics</button>
      </div>
    </div>
  </section>`;
}

export function generateFormHTML(model: GenerateFormModel): string {
  const { preflight } = model;
  const busyDisabled = model.busy ? " disabled" : "";
  // WHY: enable-control eligibility is separate from generation-action eligibility. A GM
  // must be able to toggle Nixie on in any replaceable Scene state (absent, disabled
  // supported, legacy, obsolete) while busy generation and unsupported/malformed data
  // keep the control disabled. Destructive generation stays gated on sceneEnabled below.
  const enableDisabled = preflight.gm && preflight.replaceable && !model.busy ? "" : " disabled";
  const terrainMode = model.terrainMode === "coastal" ? "coastal" : "rectangle";
  const coastDisabled = terrainMode !== "coastal" || model.busy ? " disabled" : "";
  const canRandomize = preflight.gm && preflight.replaceable && preflight.sceneEnabled && !model.busy && model.stagedProblem === null;
  const stagedProblem = model.stagedProblem === null ? "" : `<p class="nixie-note" data-status="staged-invalid">${escapeHTML(model.stagedProblem)}</p>`;
  const presetOptions = GENERATE_PRESETS.map(
    (preset) => `<option value="${preset.id}"${selected(preset.id, model.preset)}>${escapeHTML(preset.label)}</option>`
  ).join("");
  const terrainOptions =
    `<option value="rectangle"${selected("rectangle", terrainMode)}>Rectangle</option>` +
    `<option value="coastal"${selected("coastal", terrainMode)}>Coastal</option>`;
  const coastOptions = EDGES.map(
    (edge) => `<option value="${edge}"${selected(edge, model.coastEdge)}>${edge[0]!.toUpperCase()}${edge.slice(1)}</option>`
  ).join("");
  const roadOptions = (
    [
      ["european", "European"],
      ["grid", "Grid"],
      ["mixed", "Mixed"]
    ] as const
  )
    .map(([value, label]) => `<option value="${value}"${selected(value, model.roadLayout)}>${label}</option>`)
    .join("");
  const hubOptions = (
    [
      ["single-centre", "Single centre"],
      ["multiple-hubs", "Multiple hubs"]
    ] as const
  )
    .map(([value, label]) => `<option value="${value}"${selected(value, model.hubMode)}>${label}</option>`)
    .join("");
  const districtItems = DISTRICT_TYPE_IDS.map((id) =>
    `<label class="nixie-generate-district-item"><input type="checkbox" data-field="district-pool" data-district-type="${id}"${checked(model.districtPool.includes(id))}${busyDisabled}>${escapeHTML(id.replaceAll("-", " "))}</label>`
  ).join("");
  const profileOptions = OPEN_SPACE_PROFILES.map((profile) => {
    const label = profile === "very-low" ? "Very low" : profile === "none" ? "None" : profile[0]!.toUpperCase() + profile.slice(1);
    return `<option value="${profile}"${selected(profile, model.openSpaceProfile)}>${escapeHTML(label)}</option>`;
  }).join("");
  const completion = model.completedSeed === null ? "" : `<p class="nixie-note" data-status="generation-complete">City generated with seed ${escapeHTML(model.completedSeed)}.</p>`;
  const wallWarning =
    model.wallWarning
      ? `<p class="nixie-note" data-status="wall-warning">Generated walls were not fully rebuilt. <button type="button" data-action="generate-diagnostics">Open Diagnostics</button></p>`
      : "";
  return `<section data-panel="generate" class="nixie-tray-generate">
    <div data-status="scene" data-status-kind="${preflight.kind}"><p>${escapeHTML(generateStatusMessage(preflight))}</p></div>
    <div class="form-group"><label><input type="checkbox" data-field="enable"${preflight.sceneEnabled ? " checked" : ""}${enableDisabled}> Enable Nixie on this Scene</label></div>
    ${completion}
    <h3>Generate city</h3>
    <p class="nixie-note">Settings are staged in this browser session. They do not modify the current city until Randomize Entire City runs.</p>
    <div class="nixie-form-grid">
      <div class="form-group"><label>Preset</label><div class="form-fields"><select data-field="preset"${busyDisabled}>${presetOptions}</select></div></div>
      <div class="form-group"><label>City seed</label><div class="form-fields"><input type="text" data-field="seed" value="${escapeHTML(model.seed)}"${busyDisabled}><button type="button" data-action="reroll-seed"${busyDisabled} title="Randomize the staged seed">&#8635;</button></div></div>
    </div>
    <div class="nixie-generate-sections">
      <div class="nixie-generate-section"><h4>Terrain</h4><div class="nixie-form-grid">
        <div class="form-group"><label>Mode</label><div class="form-fields"><select data-field="terrain-mode"${busyDisabled}>${terrainOptions}</select></div></div>
        <div class="form-group"><label>Coast edge</label><div class="form-fields"><select data-field="coast-edge"${coastDisabled}>${coastOptions}</select></div></div>
      </div></div>
      <div class="nixie-generate-section"><h4>Structure</h4><div class="nixie-form-grid">
        <div class="form-group"><label>Roads</label><div class="form-fields"><select data-field="road-layout"${busyDisabled}>${roadOptions}</select></div></div>
        <div class="form-group"><label>Hubs</label><div class="form-fields"><select data-field="hub-mode"${busyDisabled}>${hubOptions}</select></div></div>
      </div></div>
      <div class="nixie-generate-section"><h4>Open space</h4><div class="nixie-form-grid">
        <div class="form-group"><label>Profile</label><div class="form-fields"><select data-field="open-space-profile"${busyDisabled}>${profileOptions}</select></div></div>
      </div></div>
    </div>
    <h4>Districts</h4>
    <div class="nixie-generate-district-grid">${districtItems}</div>
    ${wallWarning}
    ${stagedProblem}
    <div class="form-footer">
      <button type="button" data-action="randomize" class="nixie-destructive"${canRandomize ? "" : " disabled"}>Randomize Entire City</button>
    </div>
  </section>`;
}

export interface GenerateWorkspaceDeps {
  generationPreflight: () => GenerationPreflight;
  generationState: () => GenerationState;
  generationActive: () => boolean;
  startFullGeneration: (request: FullGenerationRequest) => Promise<FullGenerationResult>;
  retryFullGeneration: () => Promise<FullGenerationResult>;
  generateNewSeed: (seed?: string) => Promise<FullGenerationResult>;
  retryGeometry: () => Promise<unknown>;
  setSceneEnabled: (enabled: boolean) => Promise<void>;
  confirm: (dialog: ConfirmDialog) => Promise<boolean>;
}

async function dialogConfirm(dialog: ConfirmDialog): Promise<boolean> {
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: dialog.title },
    content: dialog.content,
    rejectClose: false,
    modal: true
  });
  return confirmed === true;
}

const defaultDeps: GenerateWorkspaceDeps = {
  generationPreflight,
  generationState,
  generationActive,
  startFullGeneration,
  retryFullGeneration,
  generateNewSeed,
  retryGeometry,
  setSceneEnabled,
  confirm: dialogConfirm
};

export function generateWorkspace(deps: Partial<GenerateWorkspaceDeps> = {}): WorkspaceModule {
  const d: GenerateWorkspaceDeps = { ...defaultDeps, ...deps };
  let sourceRevision: number | null = null;
  let stagedPreset: GeneratePresetId = "full-city";
  let localBusy = false;

  const isBusy = (): boolean => localBusy || d.generationActive();

  const syncSeedFromCity = (): void => {
    if (isBusy()) return;
    const status = cityLoadStatus();
    if (status.kind !== "supported") {
      sourceRevision = null;
      return;
    }
    const revision = status.state.revision;
    if (revision !== sourceRevision) setSeed(status.state.source.citySeed);
    sourceRevision = revision;
  };

  const currentStaged = (): StagedGenerateSettings => ({
    terrainMode: currentTerrainMode(),
    coastEdge: currentCoastEdge(),
    seed: currentSeed(),
    roadLayout: currentRoadLayout(),
    hubMode: currentHubMode(),
    districtPool: currentDistrictPool(),
    openSpaceProfile: currentOpenSpaceProfile()
  });

  const formModel = (): GenerateFormModel => {
    const preflight = d.generationPreflight();
    const state = d.generationState();
    return {
      preflight,
      preset: stagedPreset,
      seed: currentSeed(),
      terrainMode: currentTerrainMode(),
      coastEdge: currentCoastEdge(),
      roadLayout: currentRoadLayout(),
      hubMode: currentHubMode(),
      districtPool: currentDistrictPool(),
      openSpaceProfile: currentOpenSpaceProfile(),
      busy: isBusy(),
      stagedProblem: validateGenerationStaging(stagingFrom(currentStaged())),
      wallWarning: wallRetryWarningActive(),
      completedSeed: state.phase === "complete" && typeof state.seed === "string" ? state.seed : null
    };
  };

  const beginGeneration = async (ctx: WorkspaceContext, work: Promise<FullGenerationResult>): Promise<void> => {
    localBusy = true;
    clearEditorActionError();
    ctx.rerender();
    try {
      const result = await work;
      if (result.ok && result.state.phase === "complete") {
        ui.notifications?.info("Nixie: city generation complete.");
      } else if (!result.ok) {
        ui.notifications?.error("Nixie: city generation failed.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("nixie | city generation failed", err);
      ui.notifications?.error(`Nixie: city generation failed — ${message}`);
    } finally {
      localBusy = false;
      ctx.rerender();
    }
  };

  const runRandomize = async (ctx: WorkspaceContext): Promise<void> => {
    if (isBusy()) return;
    const staged = currentStaged();
    // WHY: cheap staged-input errors never reach the confirmations; the adapter also
    // re-checks the same rule defensively before claim and clear.
    if (validateGenerationStaging(stagingFrom(staged)) !== null) return;
    const preflight = d.generationPreflight();
    if (!preflight.gm || !preflight.replaceable || !preflight.sceneEnabled) return;
    // WHY: pin the exact pre-dialog preflight (kind + revision) so a Scene that changes
    // while the dialogs are open is rejected at clear time instead of silently replaced.
    const confirmation = clearConfirmationFor(preflight);
    const confirmed = await confirmRandomize(preflight, d.confirm);
    if (!confirmed) return;
    // WHY: the staged seed is the generated seed; only the explicit New Seed retry rolls.
    await beginGeneration(ctx, d.startFullGeneration(fullGenerationRequest(staged, false, confirmation)));
  };

  const runRetrySameSeed = (ctx: WorkspaceContext): void => {
    const state = d.generationState();
    if (state.failure === null || isBusy()) return;
    void beginGeneration(ctx, d.retryFullGeneration());
  };

  const runRetryNewSeed = (ctx: WorkspaceContext): void => {
    const state = d.generationState();
    if (state.failure === null || isBusy()) return;
    void beginGeneration(ctx, d.generateNewSeed());
  };

  return {
    id: "generate",

    renderShelf(): string {
      return "";
    },

    renderTray(): string {
      syncSeedFromCity();
      const state = d.generationState();
      if (isBusy()) return generateProgressHTML(state);
      if (state.phase === "failed" && state.failure !== null) return generateRecoveryHTML(state, state.failure);
      return generateFormHTML(formModel());
    },

    onAction(action: string, _target: HTMLElement, ctx: WorkspaceContext): void {
      switch (action) {
        case "reroll-seed":
          setSeed(randomSeed());
          ctx.rerender();
          return;
        case "randomize":
          void runRandomize(ctx);
          return;
        case "retry-same-seed":
          runRetrySameSeed(ctx);
          return;
        case "retry-new-seed":
          runRetryNewSeed(ctx);
          return;
        case "retry-geometry":
          ctx.run("render retry", d.retryGeometry());
          return;
        case "generate-diagnostics":
          setWorkspace("diagnostics");
          return;
        default:
          return;
      }
    },

    onRender(root: HTMLElement, ctx: WorkspaceContext): void {
      root.querySelector('[data-field="enable"]')?.addEventListener("change", (event: Event) => {
        void d.setSceneEnabled((event.target as HTMLInputElement).checked);
      });
      root.querySelector('[data-field="preset"]')?.addEventListener("change", (event: Event) => {
        const id = (event.target as HTMLSelectElement).value as GeneratePresetId;
        if (applyGeneratePreset(id)) stagedPreset = id;
        ctx.rerender();
      });
      root.querySelector('[data-field="seed"]')?.addEventListener("input", (event: Event) => {
        setSeed((event.target as HTMLInputElement).value);
      });
      root.querySelector('[data-field="terrain-mode"]')?.addEventListener("change", (event: Event) => {
        setTerrainMode((event.target as HTMLSelectElement).value as TerrainMode);
      });
      root.querySelector('[data-field="coast-edge"]')?.addEventListener("change", (event: Event) => {
        setCoastEdge((event.target as HTMLSelectElement).value as CoastEdge);
      });
      root.querySelector('[data-field="road-layout"]')?.addEventListener("change", (event: Event) => {
        setRoadLayout((event.target as HTMLSelectElement).value as RoadLayout);
      });
      root.querySelector('[data-field="hub-mode"]')?.addEventListener("change", (event: Event) => {
        setHubMode((event.target as HTMLSelectElement).value as HubMode);
      });
      root.querySelector('[data-field="open-space-profile"]')?.addEventListener("change", (event: Event) => {
        setOpenSpaceProfile((event.target as HTMLSelectElement).value as DistrictOpenSpaceProfile);
      });
      root.querySelectorAll('[data-field="district-pool"]').forEach((box) => {
        box.addEventListener("change", () => {
          const checkedIds = Array.from(root.querySelectorAll<HTMLInputElement>('[data-field="district-pool"]'))
            .filter((input) => input.checked)
            .map((input) => input.dataset.districtType ?? "");
          setDistrictPool(stagedDistrictPool(checkedIds));
        });
      });
    }
  };
}
