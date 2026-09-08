import {
  getArchitecturePlanView,
  getCity,
  getDistrictPlanView,
  isSceneEnabled,
  preflightRegeneration,
  regenerateTargets,
  type RegenerationPreflight
} from "../../adapter/canvas.js";
import type { RegenerationTarget } from "../../core/gen/regeneration.js";
import {
  REGENERATE_TOOL,
  canvasTool,
  clearRegenerationSelection,
  currentPendingOperation,
  getRegenerationSelection,
  isPendingOperation,
  refreshRegenerationSelectionRevision,
  setCanvasTool,
  setRegenerationStagingClearListener,
  type RegenerationSelection
} from "../editor-state.js";
import {
  clearRegenerationBlockers,
  describeRegenerationBlockers,
  regenerationProtectionSummary,
  regenerationSeedSummary,
  type RegenerationSeedSummary,
  regenerationTargetOverlays,
  setRegenerationBlockers
} from "../regenerate-layer.js";
import { escapeHTML } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

/**
 * The Regenerate workspace (UI spec §28): target-mode selection in the shared
 * editor state, a Context Tray with exact target identity, persisted partial-seed
 * display with explicit reuse, preflight-then-commit regeneration, and a durable
 * blocker list. Once a regeneration passes preflight it is uninterruptible — there
 * is no Cancel control (UI spec §28.6).
 */


let seedDraft: string | null = null;
let lastSelectionKey = "";
let lastPreflight: RegenerationPreflight | null = null;
let attemptPending = false;

/** Text protocol for seeds matches the adapter's own generator: 128 bits of hex. */
function randomSeedText(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues !== undefined) {
    const bytes = new Uint32Array(4);
    cryptoObject.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(8, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function selectionKey(selection: RegenerationSelection | null): string {
  return selection === null ? "" : `${selection.kind}:${[...selection.ids].sort().join("|")}`;
}

function cityRevision(): number | null {
  const city = getCity();
  const revision = (city as { revision?: unknown } | null)?.revision;
  return typeof revision === "number" ? revision : null;
}

function editorEnabled(): boolean {
  return isSceneEnabled() && getCity() !== null;
}

function pending(): boolean {
  return attemptPending || isPendingOperation() || currentPendingOperation() !== null;
}

function targetLabel(selection: RegenerationSelection): string {
  if (selection.kind === "district") return "One complete district";
  return selection.ids.length === 1 ? "One complete block" : `${selection.ids.length} complete blocks`;
}

function modeForTool(tool: string | null): "block" | "district" | null {
  if (tool === REGENERATE_TOOL.BLOCK) return "block";
  if (tool === REGENERATE_TOOL.DISTRICT) return "district";
  return null;
}

/**
 * Per-selection tray state: changing the selection invalidates the staged seed, any
 * stale preflight result, and the durable blocker presentation (state-side selection
 * clearing is shared; the workspace clears its own staging).
 */
function resetSelectionStaging(selection: RegenerationSelection | null): void {
  const key = selectionKey(selection);
  if (key === lastSelectionKey) return;
  seedDraft = null;
  lastPreflight = null;
  clearRegenerationBlockers();
  lastSelectionKey = key;
}

function renderSeedRow(seedSummary: RegenerationSeedSummary): string {
  const value = seedDraft ?? "";
  const note = seedDraft === null
    ? "Leave the seed empty to choose a fresh seed for each attempt, or enter one to reuse it exactly."
    : "This exact seed will be reused for the next attempt.";
  return `<div class="nixie-regen-seed">
    <label class="nixie-regen-field-label" for="nixie-regen-seed-input">Partial seed</label>
    <div class="nixie-regen-seed-row">
      <input id="nixie-regen-seed-input" data-field="regen-seed" type="text" value="${escapeHTML(value)}" placeholder="Fresh seed each attempt" title="Partial regeneration seed for this target" aria-label="Partial regeneration seed" spellcheck="false">
      <button type="button" data-action="regen-new-seed" title="Generate a new partial seed" aria-label="Generate a new partial seed"><i class="fa-solid fa-dice" aria-hidden="true"></i> New Seed</button>
      <button type="button" data-action="regen-seed-reset" title="Forget the staged seed" aria-label="Forget the staged seed"${seedDraft === null ? " disabled" : ""}><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Reset</button>
    </div>
    <p class="nixie-note">Persisted seed (effective): <code>${seedSummary.display === null ? "none yet" : escapeHTML(seedSummary.display)}</code></p>
    ${seedSummary.overriddenIds.length === 0 ? "" : `<p class="nixie-note" data-status-kind="warning">Stored seed record(s) for ${escapeHTML(seedSummary.overriddenIds.join(", "))} are partly overridden by a newer regeneration event; those fragments follow the newer seed.</p>`}
    ${seedSummary.display !== null && seedSummary.unseededFragments > 0 ? `<p class="nixie-note" data-status-kind="warning">${seedSummary.unseededFragments} fragment${seedSummary.unseededFragments === 1 ? "" : "s"} have no partial-seed record and still follow the city's base generation.</p>` : ""}
    <p class="nixie-note">${escapeHTML(note)}</p>
  </div>`;
}

function renderBlockers(): string {
  if (lastPreflight === null || lastPreflight.blockers.length === 0) return "";
  const items = describeRegenerationBlockers(lastPreflight.blockers).map((blocker) =>
    `<li class="nixie-regen-blocker"><i class="fa-solid fa-ban" aria-hidden="true"></i><div><span class="nixie-regen-blocker-kind" data-kind="${escapeHTML(blocker.kind)}">${escapeHTML(blocker.kind)}</span> <code>${escapeHTML(blocker.id)}</code><p>${escapeHTML(blocker.reason)}</p></div></li>`
  ).join("");
  return `<section class="nixie-regen-blockers" role="alert" aria-label="Regeneration blockers">
    <h4><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Regeneration blocked (${lastPreflight.blockers.length}) — no generation started</h4>
    <ul>${items}</ul>
    <p class="nixie-note">Unlock or move every blocker separately, then retry. Protection is never overridden and there is no "ignore once" action.</p>
    <button type="button" data-action="regen-dismiss-blockers" title="Hide the blocker list" aria-label="Hide the blocker list">Dismiss list</button>
  </section>`;
}

function renderStatus(selection: RegenerationSelection | null, stale: boolean): string {
  if (!editorEnabled()) {
    return `<p class="nixie-note" data-status-kind="warning" role="status">Enable Nixie on this Scene and create a city before regenerating.</p>`;
  }
  if (selection === null) {
    return `<p class="nixie-note" role="status">Select complete blocks (Shift-click adds more) or exactly one district on the canvas.</p>`;
  }
  if (stale) {
    return `<p class="nixie-note" data-status-kind="error" role="alert">The selection is stale: the city changed since it was made. Clear the selection and select the target again.</p>`;
  }
  return "";
}

function renderProtectionStatus(selection: RegenerationSelection): string {
  const city = getCity();
  const plan = getArchitecturePlanView();
  if (city === null || plan === null) return "";
  if (lastPreflight !== null) {
    const retained = lastPreflight.retainedIds.length;
    const excluded = lastPreflight.excludedSitePolygons.length;
    const removed = lastPreflight.removedIds.length;
    return `<p class="nixie-note" data-status-kind="info">Protected content: ${retained} retained (${excluded} excluded site${excluded === 1 ? "" : "s"}), ${removed} rebuilt. Roads remain fixed for ordinary block and district regeneration.</p>`;
  }
  const overlays = regenerationTargetOverlays(selection, getDistrictPlanView(), city);
  if (overlays.final.length === 0) return "";
  const summary = regenerationProtectionSummary(plan, overlays.final);
  return `<p class="nixie-note" data-status-kind="info">Protected content: ${summary.protectedIds.length} object${summary.protectedIds.length === 1 ? "" : "s"}, reserved sites: ${summary.reservedIds.length}. Roads remain fixed for ordinary block and district regeneration; only the target's buildings and places are rebuilt.</p>`;
}

export function clearRegenerateWorkspaceState(): void {
  seedDraft = null;
  lastSelectionKey = "";
  lastPreflight = null;
  attemptPending = false;
  clearRegenerationBlockers();
}

function runRegeneration(ctx: WorkspaceContext): void {
  const selection = getRegenerationSelection();
  const city = getCity();
  if (selection === null || selection.ids.length === 0 || city === null || !isSceneEnabled()) return;
  if (pending()) return;
  // One seed per attempt, fixed before preflight so preflight and commit describe the
  // same generation intent. An empty staged seed means "fresh seed for this attempt";
  // a staged (typed or New Seed) value is an explicit reuse.
  const seed = (seedDraft ?? "").trim() === "" ? randomSeedText() : seedDraft!.trim();
  const target: RegenerationTarget = { kind: selection.kind, ids: [...selection.ids] };
  attemptPending = true;
  const work = (async () => {
    const preflight = await preflightRegeneration(target, seed, selection.revision ?? undefined);
    if (preflight.blockers.length > 0 || preflight.candidateSource === null) {
      lastPreflight = preflight;
      setRegenerationBlockers(preflight.blockers);
      const summary = preflight.blockers.map((blocker) => `${blocker.kind} "${blocker.id}"`).join(", ");
      throw Object.assign(
        new Error(`Regeneration blocked by ${preflight.blockers.length} blocker(s): ${summary}. No generation started.`),
        { blockers: preflight.blockers }
      );
    }
    lastPreflight = preflight;
    setRegenerationBlockers(null);
    await regenerateTargets(target, seed, selection.revision ?? undefined);
  })().catch((error: unknown) => {
    attemptPending = false;
    throw error;
  });
  ctx.run("regeneration", work, () => {
    attemptPending = false;
    lastPreflight = null;
    seedDraft = null;
    // The target survives regeneration: refresh its retained revision so the GM can
    // immediately run another attempt without a stale-selection rejection.
    const currentRevision = cityRevision();
    if (currentRevision !== null) refreshRegenerationSelectionRevision(currentRevision);
    ctx.rerender();
  });
}

export function regenerateWorkspace(): WorkspaceModule {
  return {
    id: "regenerate",
    renderShelf(): string {
      const tool = canvasTool();
      const mode = modeForTool(tool) ?? "block";
      const selection = getRegenerationSelection();
      const gate = pending() || !editorEnabled() ? " disabled" : "";
      const summary = selection === null
        ? "No regeneration target"
        : selection.kind === "district"
          ? "1 district selected"
          : `${selection.ids.length} block${selection.ids.length === 1 ? "" : "s"} selected`;
      return `<div class="nixie-shelf-row nixie-regen-tools" role="group" aria-label="Regeneration target mode">
        <button type="button" data-action="regen-tool" data-mode="block" class="${mode === "block" ? "active" : ""}" aria-pressed="${mode === "block"}"${gate} title="Select one or more complete blocks; Shift-click adds more">Blocks</button>
        <button type="button" data-action="regen-tool" data-mode="district" class="${mode === "district" ? "active" : ""}" aria-pressed="${mode === "district"}"${gate} title="Select exactly one complete district">District</button>
        <span class="nixie-shelf-summary">${escapeHTML(summary)}</span>
        <button type="button" data-action="regen-clear-selection" class="nixie-regen-clear"${gate !== "" || selection === null ? " disabled" : ""} title="Clear the regeneration selection" aria-label="Clear the regeneration selection"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>`;
    },
    renderTray(): string {
      const selection = getRegenerationSelection();
      const enabled = editorEnabled();
      resetSelectionStaging(enabled ? selection : null);
      const stale = selection !== null && selection.revision !== null && selection.revision !== cityRevision();
      const seedSummary = regenerationSeedSummary(getCity(), selection, getDistrictPlanView() ?? undefined);
      const busy = pending();
      const body = selection === null
        ? ""
        : `<h3>${escapeHTML(targetLabel(selection))}</h3>
          <p class="nixie-regen-target">${escapeHTML(selection.kind === "district" ? "District" : "Blocks")}: <code>${selection.ids.map((id) => escapeHTML(id)).join("</code>, <code>")}</code></p>
          ${renderSeedRow(seedSummary)}
          ${renderProtectionStatus(selection)}
          ${renderBlockers()}
          <button type="button" data-action="regen-run" class="nixie-regen-run"${enabled && !busy && !stale ? "" : " disabled"} title="Preflight and regenerate the selected target" aria-label="Preflight and regenerate the selected target"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Regenerate</button>
          <p class="nixie-note">Once regeneration passes preflight it runs to completion and cannot be cancelled.</p>`;
      return `<section data-panel="regenerate" class="nixie-tray-inspector nixie-regen"${busy ? ' aria-busy="true"' : ""}>
        ${renderStatus(selection, stale)}
        ${body}
        ${busy ? `<p class="nixie-regen-progress" data-status-kind="pending" role="status" aria-live="polite"><i class="fa-solid fa-spinner" aria-hidden="true"></i> Working on the regeneration. There is no Cancel — the operation is uninterruptible.</p>` : ""}
      </section>`;
    },
    onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void {
      if (action === "regen-tool") {
        if (pending()) return;
        const mode = target.dataset.mode;
        if (mode !== "block" && mode !== "district") return;
        const nextTool = mode === "block" ? REGENERATE_TOOL.BLOCK : REGENERATE_TOOL.DISTRICT;
        // Switching target mode clears the prior mode's selection (UI spec §11.4).
        const selection = getRegenerationSelection();
        if (selection !== null && selection.kind !== mode) clearRegenerationSelection();
        setCanvasTool(nextTool);
        ctx.rerender();
        return;
      }
      if (action === "regen-clear-selection") {
        if (pending()) return;
        clearRegenerationSelection();
        ctx.rerender();
        return;
      }
      if (action === "regen-new-seed") {
        if (pending()) return;
        seedDraft = randomSeedText();
        ctx.rerender();
        return;
      }
      if (action === "regen-seed-reset") {
        if (pending()) return;
        seedDraft = null;
        ctx.rerender();
        return;
      }
      if (action === "regen-dismiss-blockers") {
        lastPreflight = null;
        clearRegenerationBlockers();
        ctx.rerender();
        return;
      }
      if (action === "regen-run") runRegeneration(ctx);
    },
    onRender(root: HTMLElement, ctx: WorkspaceContext): void {
      setRegenerationStagingClearListener(clearRegenerateWorkspaceState);
      const seedInput = root.querySelector<HTMLInputElement>('[data-field="regen-seed"]');
      seedInput?.addEventListener("input", (event: Event) => {
        seedDraft = (event.target as HTMLInputElement).value;
      });
      seedInput?.addEventListener("change", () => ctx.rerender());
    }
  };
}
