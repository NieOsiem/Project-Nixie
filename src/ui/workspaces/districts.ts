import {
  cityLoadStatus,
  clearDistrictSelection,
  deleteDistricts,
  districtDiagnostics,
  districtInspector,
  districtSnapOptions as adapterDistrictSnapOptions,
  generateDistricts,
  getCity,
  getDistrictPlan,
  getDistrictSelection,
  isSceneEnabled,
  mergeDistricts,
  retryGeneratedWalls,
  setDistrictSnapOptions as setAdapterDistrictSnapOptions,
  updateDistricts
} from "../../adapter/canvas.js";
import { validateDistrictOpenSpaceOverride } from "../../core/gen/city.js";
import { BLOCK_GRAMMAR_IDS, DISTRICT_PALETTE_IDS, DISTRICT_TYPE_REGISTRY } from "../../core/gen/district-registry.js";
import { districtBreadthGallery, planDistrictFragmentWithGrammar, type DistrictBlockFragment } from "../../core/gen/district-plan.js";
import { ringAsMulti } from "../../core/geom/boolean.js";
import { rectRing, type Ring } from "../../core/geom/types.js";
import {
  canvasTool,
  currentDistrictPool,
  currentDistrictPalette,
  currentDistrictType,
  currentOpenSpaceProfile,
  DISTRICT_TOOL,
  DISTRICT_TYPE_IDS,
  districtSnapOptions,
  setCanvasTool,
  setDistrictPool,
  setDistrictPalette,
  setDistrictSnapOptions,
  setDistrictType,
  setOpenSpaceProfile,
  type DistrictOpenSpaceProfile,
  type DistrictSnapOptions,
  type DistrictTypeId
} from "../editor-state.js";
import { cancelDistrictDraft, cancelDistrictInteraction, finishDistrictDraft, hasDistrictDraft } from "../district-layer.js";
import { checked, escapeHTML, selected, statusKind } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

const OPEN_SPACE_PROFILES: readonly DistrictOpenSpaceProfile[] = ["none", "very-low", "low", "medium", "high"];

export type DistrictGalleryMode = "overview" | "play";

export interface DistrictGalleryPreview {
  districtTypeId: string;
  grammarId: string;
  fixtureSeed: string;
  districtLabel: string;
  grammarLabel: string;
  cellCount: number;
  polygons: readonly string[];
  scale: number;
}

const GALLERY_FRAGMENT: DistrictBlockFragment = {
  id: "district-gallery-fragment",
  blockId: "district-gallery-block",
  districtId: "district-gallery-district",
  buildable: ringAsMulti(rectRing({ x: 0, y: 0, width: 96, height: 72 }))
};

const galleryPreviewCache = new Map<DistrictGalleryMode, DistrictGalleryPreview[]>();

function galleryEntriesForDisplay(): ReturnType<typeof districtBreadthGallery> {
  const entries = districtBreadthGallery();
  const selected: ReturnType<typeof districtBreadthGallery> = [];
  const seen = new Set<string>();
  const add = (entry: ReturnType<typeof districtBreadthGallery>[number] | undefined): void => {
    if (!entry || seen.has(entry.fixtureSeed)) return;
    seen.add(entry.fixtureSeed);
    selected.push(entry);
  };
  for (const definition of DISTRICT_TYPE_REGISTRY.values()) add(entries.find((entry) => entry.districtTypeId === definition.id));
  for (const grammarId of BLOCK_GRAMMAR_IDS) add(entries.find((entry) => entry.grammarId === grammarId));
  return selected;
}

function displayLabel(id: string): string {
  return id.replaceAll("-", " ").replace(/(^| )([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
}

function svgPoints(points: readonly Ring[number][]): string {
  return points.map(({ x, y }) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");
}

export function districtGalleryPreviews(mode: DistrictGalleryMode = "overview"): DistrictGalleryPreview[] {
  const safeMode: DistrictGalleryMode = mode === "play" ? "play" : "overview";
  const cached = galleryPreviewCache.get(safeMode);
  if (cached) return cached;
  const previews = galleryEntriesForDisplay().map((entry) => {
    const definition = DISTRICT_TYPE_REGISTRY.get(entry.districtTypeId);
    if (!definition) throw new Error(`Unknown district gallery type "${entry.districtTypeId}".`);
    const cells = planDistrictFragmentWithGrammar(GALLERY_FRAGMENT, entry.grammarId, definition.bounds, entry.fixtureSeed);
    return {
      districtTypeId: entry.districtTypeId,
      grammarId: entry.grammarId,
      fixtureSeed: entry.fixtureSeed,
      districtLabel: definition.label,
      grammarLabel: displayLabel(entry.grammarId),
      cellCount: cells.length,
      polygons: cells.map((cell) => svgPoints(cell.polygon)),
      scale: safeMode === "overview" ? entry.overviewScale : entry.playScale
    };
  });
  galleryPreviewCache.set(safeMode, previews);
  return previews;
}

function districtGalleryLauncherHTML(): string {
  return "<div class=\"form-footer nixie-district-gallery-launch\"><button type=\"button\" data-action=\"district-gallery-open\" aria-label=\"Open district breadth gallery\">Breadth gallery</button></div>";
}

export function districtEmptyTrayHTML(): string {
  return "<section data-panel=\"district-empty\" class=\"nixie-tray-inspector\"><h3>Districts</h3><p class=\"nixie-note\">Select a district to inspect it. Fill, draw, split, and merge operate on the canvas.</p><div class=\"form-footer\"><button type=\"button\" data-action=\"district-delete-all\">Delete all districts</button></div>" + districtGalleryLauncherHTML() + "</section>";
}

export function districtGalleryHTML(mode: DistrictGalleryMode = "overview"): string {
  const safeMode: DistrictGalleryMode = mode === "play" ? "play" : "overview";
  const previews = districtGalleryPreviews(safeMode);
  const cards = previews.map((preview) => {
    const polygons = preview.polygons.map((points, index) => `<polygon points=\"${points}\" class=\"nixie-district-gallery-cell\" data-cell-index=\"${index}\"></polygon>`).join("");
    const width = Math.round(220 * preview.scale);
    const height = Math.round(220 * preview.scale * 0.75);
    const label = `${preview.districtLabel} — ${preview.grammarLabel}`;
    return `<figure class=\"nixie-district-gallery-card\" data-district-type=\"${escapeHTML(preview.districtTypeId)}\" data-grammar-id=\"${escapeHTML(preview.grammarId)}\" aria-label=\"${escapeHTML(label)}\"><svg viewBox=\"0 0 96 72\" width=\"${width}\" height=\"${height}\" role=\"img\" aria-label=\"${escapeHTML(label)}\">${polygons}</svg><figcaption><span>${escapeHTML(preview.districtLabel)}</span><small>${escapeHTML(preview.grammarLabel)}</small></figcaption></figure>`;
  }).join("");
  const typeCount = new Set(previews.map((preview) => preview.districtTypeId)).size;
  const grammarCount = new Set(previews.map((preview) => preview.grammarId)).size;
  return `<section class=\"nixie-district-gallery nixie-district-gallery--${safeMode}\" data-panel=\"district-gallery\" aria-label=\"District breadth gallery\"><div class=\"nixie-inspector-head\"><h3>District breadth gallery</h3><button type=\"button\" data-action=\"district-gallery-back\" aria-label=\"Back to Districts\">Back</button></div><p class=\"nixie-note\">Deterministic previews for ${typeCount} district types and ${grammarCount} block grammars. No Scene data is changed.</p><div class=\"nixie-district-gallery-modes\" role=\"group\" aria-label=\"Preview zoom\"><button type=\"button\" data-action=\"district-gallery-mode\" data-mode=\"overview\" aria-pressed=\"${safeMode === "overview"}\">Overview</button><button type=\"button\" data-action=\"district-gallery-mode\" data-mode=\"play\" aria-pressed=\"${safeMode === "play"}\">Play</button></div><div class=\"nixie-district-gallery-grid\">${cards}</div></section>`;
}

function fmt(source: string, ...values: unknown[]): string {
  return source.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)] ?? ""));
}

function districtIds(): string[] {
  const value = getDistrictSelection() as any;
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string");
  const ids = Array.isArray(value?.districtIds) ? value.districtIds : value?.ids;
  return Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string") : [];
}

function districtsOf(city: any): any[] {
  return Array.isArray(city?.source?.districts) ? city.source.districts : [];
}

export function allDistrictIds(city: any): string[] {
  return districtsOf(city)
    .map((district) => district?.id)
    .filter((id: unknown): id is string => typeof id === "string");
}

function hasVehicleNetwork(city: any): boolean {
  const vehicle = new Set(["highway", "arterial", "street", "narrow", "lane", "alley"]);
  return Array.isArray(city?.source?.roads?.edges) && city.source.roads.edges.some((edge: any) => vehicle.has(edge.classId));
}

export interface DistrictGenerationAvailability {
  enabled: boolean;
  reason: string;
  districtCount: number;
}

export function districtGenerationAvailability(kind: string, sceneEnabled: boolean, city: any, pool = currentDistrictPool()): DistrictGenerationAvailability {
  const count = districtsOf(city).length;
  if (kind !== "supported" || !sceneEnabled) return { enabled: false, reason: "Enable Nixie on this Scene first.", districtCount: count };
  if (city === null || city === undefined) return { enabled: false, reason: "Create terrain and an initial road network first.", districtCount: 0 };
  if (!hasVehicleNetwork(city)) return { enabled: false, reason: "Generate a vehicle road network before generating districts.", districtCount: count };
  if (count > 0) return { enabled: false, reason: "Districts already exist. Edit or delete them explicitly.", districtCount: count };
  if (pool.length === 0) return { enabled: false, reason: "Enable at least one district type.", districtCount: 0 };
  return { enabled: true, reason: "Road network is ready. Generate the initial district layout.", districtCount: 0 };
}

function diagnosticsHTML(): string {
  let raw: any;
  try { raw = districtDiagnostics(); } catch { raw = null; }
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw?.diagnostics) ? raw.diagnostics : [];
  if (entries.length === 0) return "";
  const items = entries.map((entry: any, index: number) => {
    const message = typeof entry === "string" ? entry : String(entry?.message ?? entry?.reason ?? "District operation failed.");
    const retry = entry?.retry === "walls" || entry?.subsystem === "walls" ? fmt("<button type=\"button\" data-action=\"district-retry-walls\" data-diagnostic-index=\"{0}\">Retry generated walls</button>", index) : "";
    return fmt("<li><span>{0}</span>{1}</li>", escapeHTML(message), retry);
  }).join("");
  return "<section class=\"nixie-district-diagnostics\" data-panel=\"district-diagnostics\"><h3>District diagnostics</h3><ul>" + items + "</ul></section>";
}

function renderGenerationTray(availability: DistrictGenerationAvailability): string {
  const pool = new Set(currentDistrictPool());
  const controls = DISTRICT_TYPE_IDS.map((id) => fmt(
    "<label class=\"nixie-district-pool-item\"><input type=\"checkbox\" data-field=\"district-pool\" data-district-type=\"{0}\"{1}> {2}</label>",
    id,
    checked(pool.has(id)),
    escapeHTML(id.replaceAll("-", " "))
  )).join("");
  const profiles = OPEN_SPACE_PROFILES.map((profile) => fmt("<option value=\"{0}\"{1}>{2}</option>", profile, selected(profile, currentOpenSpaceProfile()), profile.replace("-", " "))).join("");
  return "<section data-panel=\"district-generation\" class=\"nixie-tray-inspector\"><h3>Generate initial districts</h3><p class=\"nixie-note\">District settings are staged in this browser session. Generation commits the selected pool and profile with the district source.</p><div class=\"nixie-district-pool\">" + controls + "</div><label class=\"nixie-form-row\"><span>Open-space profile</span><select data-field=\"open-space-profile\">" + profiles + "</select></label><p class=\"nixie-note\" data-status=\"district-generation\">" + escapeHTML(availability.reason) + "</p><div class=\"form-footer\"><button type=\"button\" data-action=\"generate-districts\"" + (availability.enabled ? "" : " disabled") + ">Generate initial districts</button></div></section>";
}

function inspectorValue(record: any, key: string, fallback: unknown = null): any {
  return record?.[key] ?? record?.district?.[key] ?? fallback;
}

let stagedType: DistrictTypeId | undefined;
let stagedPalette: string | undefined;
let stagedSeed: string | undefined;
let stagedLocked: boolean | undefined;
let stagedOverride: "inherit" | "explicit" | undefined;
let stagedOverrideConfig: { rate: number; categoryWeights: Record<string, number>; sizeWeights: Record<string, number> } | undefined;
let mergeSurvivor: string | undefined;
let lastSelectionKey = "";
let seedRerollCounter = 0;
let districtGalleryOpen = false;
let districtGalleryMode: DistrictGalleryMode = "overview";
let stagedOverrideInvalid = false;

export interface DistrictInspectorControlState {
  applyEnabled: boolean;
  resetEnabled: boolean;
  mergeEnabled: boolean;
  overrideVisible: boolean;
}

export function districtOverrideInputProblems(rate: number, categories: string, sizes: string): string[] {
  let categoryWeights: unknown;
  let sizeWeights: unknown;
  try {
    categoryWeights = JSON.parse(categories);
  } catch {
    return ["Category weights must be valid JSON."];
  }
  try {
    sizeWeights = JSON.parse(sizes);
  } catch {
    return ["Size weights must be valid JSON."];
  }
  return validateDistrictOpenSpaceOverride({ rate, categoryWeights, sizeWeights });
}

export function districtInspectorControlState(selectionCount: number, editable: boolean, dirty: boolean, override: "inherit" | "explicit", survivor: string | undefined, invalid = false): DistrictInspectorControlState {
  return {
    applyEnabled: editable && dirty && !invalid,
    resetEnabled: editable && dirty,
    mergeEnabled: editable && selectionCount > 1 && survivor !== undefined,
    overrideVisible: editable && override === "explicit"
  };
}

function syncInspectorButtons(root: HTMLElement): void {
  const editable = root.querySelector<HTMLElement>("[data-field=\"district-open-space\"]")?.hasAttribute("disabled") !== true;
  const rate = root.querySelector<HTMLInputElement>("[data-field=\"district-override-rate\"]");
  const categories = root.querySelector<HTMLInputElement>("[data-field=\"district-override-categories\"]");
  const sizes = root.querySelector<HTMLInputElement>("[data-field=\"district-override-sizes\"]");
  const overrideProblems = rate !== null && categories !== null && sizes !== null
    ? districtOverrideInputProblems(Number(rate.value), categories.value, sizes.value)
    : [];
  stagedOverrideInvalid = overrideProblems.length > 0;
  for (const field of [rate, categories, sizes]) field?.toggleAttribute("aria-invalid", stagedOverrideInvalid);
  const state = districtInspectorControlState(
    root.querySelector("[data-field=\"district-survivor\"]") ? 2 : 1,
    editable,
    stagedType !== undefined || stagedPalette !== undefined || stagedSeed !== undefined || stagedLocked !== undefined || stagedOverride !== undefined || stagedOverrideConfig !== undefined,
    stagedOverride ?? (inspectorValue(districtInspector() as any, "openSpaceOverride", null) === null ? "inherit" : "explicit"),
    mergeSurvivor,
    stagedOverrideInvalid
  );
  root.querySelector<HTMLButtonElement>("[data-action=\"district-apply\"]")?.toggleAttribute("disabled", !state.applyEnabled);
  root.querySelector<HTMLButtonElement>("[data-action=\"district-reset\"]")?.toggleAttribute("disabled", !state.resetEnabled);
  root.querySelector<HTMLButtonElement>("[data-action=\"district-merge\"]")?.toggleAttribute("disabled", !state.mergeEnabled);
}

function resetStaged(ids: string[]): void {
  stagedType = undefined;
  stagedPalette = undefined;
  stagedSeed = undefined;
  stagedLocked = undefined;
  stagedOverride = undefined;
  stagedOverrideConfig = undefined;
  mergeSurvivor = undefined;
  stagedOverrideInvalid = false;
  lastSelectionKey = ids.join("|");
}

function defaultOverride(): { rate: number; categoryWeights: Record<string, number>; sizeWeights: Record<string, number> } {
  return {
    rate: 0.14,
    categoryWeights: { park: 1, plaza: 1, parking: 1, vacant: 1, utility: 1, landscaping: 1, "service-yard": 1 },
    sizeWeights: { pocket: 1, small: 1, large: 1, "whole-block": 1 }
  };
}

function renderInspector(ids: string[], enabled: boolean): string {
  const key = ids.join("|");
  if (key !== lastSelectionKey) resetStaged(ids);
  const raw = districtInspector() as any;
  const multiple = ids.length > 1;
  const type = stagedType ?? inspectorValue(raw, "typeId", multiple ? "multiple" : currentDistrictType());
  const palette = stagedPalette ?? inspectorValue(raw, "paletteId", multiple ? "multiple" : "");
  const seed = stagedSeed ?? inspectorValue(raw, "seed", "");
  const lockedValue = stagedLocked ?? inspectorValue(raw, "locked", false);
  const sourceOverride = inspectorValue(raw, "openSpaceOverride", null);
  const override = stagedOverride ?? (sourceOverride === null ? "inherit" : "explicit");
  const overrideConfig = stagedOverrideConfig ?? (sourceOverride === null ? defaultOverride() : sourceOverride);
  const dirty = stagedType !== undefined || stagedPalette !== undefined || stagedSeed !== undefined || stagedLocked !== undefined || stagedOverride !== undefined || stagedOverrideConfig !== undefined;
  const locked = lockedValue === true || lockedValue === "multiple";
  const editable = enabled && !locked;
  const canUnlock = enabled && locked;
  const title = multiple ? ids.length + " districts selected" : "District " + (ids[0] ?? "");
  const options = DISTRICT_TYPE_IDS.map((id) => fmt("<option value=\"{0}\"{1}>{2}</option>", id, selected(id, type === "multiple" ? "" : String(type)), escapeHTML(id.replaceAll("-", " ")))).join("");
  const multipleOption = type === "multiple" && stagedType === undefined ? "<option value=\"multiple\" selected disabled>Multiple</option>" : "";
  const paletteValue = palette === "multiple" ? "" : String(palette ?? "");
  const paletteChoices = [...DISTRICT_PALETTE_IDS, ...(paletteValue && !DISTRICT_PALETTE_IDS.includes(paletteValue) ? [paletteValue] : [])];
  const paletteOptions = paletteValue === "" && palette === "multiple" ? "<option value=\"multiple\" selected disabled>Multiple</option>" : "";
  const paletteSelect = "<select data-field=\"district-palette\"" + (editable ? "" : " disabled") + ">" + paletteOptions + paletteChoices.map((id) => fmt("<option value=\"{0}\"{1}>{0}</option>", escapeHTML(id), selected(id, paletteValue))).join("") + "</select>";
  const overrideFields = override === "explicit" ? "<div class=\"form-group\"><label>Override rate</label><div class=\"form-fields\"><input type=\"number\" step=\"0.01\" min=\"0\" max=\"1\" data-field=\"district-override-rate\" value=\"" + escapeHTML(String(overrideConfig.rate ?? 0)) + "\"></div></div><div class=\"form-group\"><label>Category weights</label><div class=\"form-fields\"><input type=\"text\" data-field=\"district-override-categories\" value=\'" + escapeHTML(JSON.stringify(overrideConfig.categoryWeights ?? {})) + "\'></div></div><div class=\"form-group\"><label>Size weights</label><div class=\"form-fields\"><input type=\"text\" data-field=\"district-override-sizes\" value=\'" + escapeHTML(JSON.stringify(overrideConfig.sizeWeights ?? {})) + "\'></div></div>" : "";
  const seedDisabled = multiple || !editable;
  const survivor = multiple ? "<div class=\"form-group\"><label>Merge survivor</label><div class=\"form-fields\"><select data-field=\"district-survivor\"><option value=\"\">Choose survivor…</option>" + ids.map((id) => "<option value=\"" + escapeHTML(id) + "\"" + selected(id, mergeSurvivor ?? "") + ">" + escapeHTML(id) + "</option>").join("") + "</select></div></div>" : "";
  return "<section data-panel=\"district-inspector\" class=\"nixie-tray-inspector\"><div class=\"nixie-inspector-head\"><h3>" + escapeHTML(title) + "</h3><button type=\"button\" data-action=\"district-unlock\"" + (canUnlock ? "" : " disabled") + ">Unlock</button></div><p class=\"nixie-inspector-sub\">" + (multiple ? "Same-type bulk edit" : "District identity and planning settings") + "</p><div class=\"nixie-form-grid\"><div class=\"form-group\"><label>Type</label><div class=\"form-fields\"><select data-field=\"district-type\"" + (editable ? "" : " disabled") + ">" + multipleOption + options + "</select></div></div><div class=\"form-group\"><label>Palette</label><div class=\"form-fields\">" + paletteSelect + "</div></div>" + (multiple ? "" : "<div class=\"form-group\"><label>Seed</label><div class=\"form-fields\"><input type=\"text\" data-field=\"district-seed\" value=\"" + escapeHTML(String(seed ?? "")) + "\"" + (seedDisabled ? " disabled" : "") + "></div></div>") + "<div class=\"form-group\"><label><input type=\"checkbox\" data-field=\"district-locked\"" + (lockedValue === true ? " checked" : "") + (editable ? "" : " disabled") + "> Locked</label></div><div class=\"form-group\"><label>Open space</label><div class=\"form-fields\"><select data-field=\"district-open-space\"" + (editable ? "" : " disabled") + "><option value=\"inherit\"" + selected("inherit", override) + ">Inherit global profile</option><option value=\"explicit\"" + selected("explicit", override) + ">Explicit override</option></select></div></div>" + (editable ? overrideFields : "") + survivor + "</div><div class=\"form-footer\"><button type=\"button\" data-action=\"district-reroll-seed\"" + (multiple || !editable ? " disabled" : "") + ">Reroll seed</button><button type=\"button\" data-action=\"district-reset\"" + (dirty && editable ? "" : " disabled") + ">Reset</button><button type=\"button\" data-action=\"district-apply\"" + (dirty && editable ? "" : " disabled") + ">Apply and Regenerate</button></div><div class=\"form-footer\"><button type=\"button\" data-action=\"district-merge\"" + (multiple && editable && mergeSurvivor !== undefined ? "" : " disabled") + ">Merge selection</button><button type=\"button\" data-action=\"district-delete\"" + (editable ? "" : " disabled") + ">Delete</button><button type=\"button\" data-action=\"district-delete-all\">Delete all districts</button><button type=\"button\" data-action=\"district-clear\"" + (ids.length > 0 ? "" : " disabled") + ">Clear selection</button></div></section>";
}

export function districtsWorkspace(): WorkspaceModule {
  return {
    id: "districts",
    renderShelf(): string {
      const kind = statusKind(cityLoadStatus());
      const enabled = kind === "supported" && isSceneEnabled();
      const count = allDistrictIds(getCity()).length;
      const gate = enabled && count > 0 ? "" : " disabled";
      const tool = canvasTool();
      const active = (id: string): string => tool === id ? " active" : "";
      const ids = districtIds();
      const draft = hasDistrictDraft();
      const buttonDefs: Array<[string, string]> = [
        [DISTRICT_TOOL.SELECT, "Select"], [DISTRICT_TOOL.FILL, "Fill"], [DISTRICT_TOOL.DRAW, "Draw Polygon"],
        [DISTRICT_TOOL.EDIT, "Edit Vertices"], [DISTRICT_TOOL.SPLIT, "Split"], [DISTRICT_TOOL.MERGE, "Merge"]
      ];
      const buttons = buttonDefs.map(([id, label]) => fmt("<button type=\"button\" data-action=\"district-tool\" data-tool=\"{0}\" class=\"{1}\"{2}>{3}</button>", id, active(id), gate, label)).join("");
      const summary = ids.length === 0 ? "" : "<span class=\"nixie-shelf-sep\"></span><span class=\"nixie-shelf-summary\">" + ids.length + " district" + (ids.length === 1 ? "" : "s") + " selected</span>";
      const draftButtons = draft ? "<span class=\"nixie-shelf-sep\"></span><button type=\"button\" data-action=\"district-finish\">Finish</button><button type=\"button\" data-action=\"district-cancel\">Cancel</button>" : "";
      const snap = districtSnapOptions();
      const typeOptions = DISTRICT_TYPE_IDS.map((id) => "<option value=\"" + id + "\"" + selected(id, currentDistrictType()) + ">" + escapeHTML(id.replaceAll("-", " ")) + "</option>").join("");
      const paletteOptions = DISTRICT_PALETTE_IDS.map((id) => "<option value=\"" + id + "\"" + selected(id, currentDistrictPalette()) + ">" + escapeHTML(id.replaceAll("-", " ")) + "</option>").join("");
      return "<div class=\"nixie-shelf-row\">" + buttons + summary + draftButtons + "</div><div class=\"nixie-shelf-row nixie-district-snap-row\"><label class=\"nixie-shelf-field\">Type<select data-field=\"district-type-select\">" + typeOptions + "</select></label><label class=\"nixie-shelf-field\">Palette<select data-field=\"district-palette-select\">" + paletteOptions + "</select></label><label class=\"nixie-shelf-field\"><input type=\"checkbox\" data-field=\"snap-district\"" + checked(snap.districtVertices) + "> District snap</label><label class=\"nixie-shelf-field\"><input type=\"checkbox\" data-field=\"snap-road\"" + checked(snap.roadJunctions) + "> Road/junction</label><label class=\"nixie-shelf-field\"><input type=\"checkbox\" data-field=\"snap-block\"" + checked(snap.blockBoundaries) + "> Block boundary</label><label class=\"nixie-shelf-field\"><input type=\"checkbox\" data-field=\"snap-grid\"" + checked(snap.foundryGrid) + "> Foundry grid</label></div>";
    },
    renderTray(): string {
      if (districtGalleryOpen) return districtGalleryHTML(districtGalleryMode);
      const kind = statusKind(cityLoadStatus());
      const availability = districtGenerationAvailability(kind, isSceneEnabled(), getCity());
      const diagnostics = diagnosticsHTML();
      if (diagnostics !== "") return diagnostics;
      if (availability.districtCount === 0) return renderGenerationTray(availability) + districtGalleryLauncherHTML();
      const ids = districtIds();
      if (ids.length === 0) return districtEmptyTrayHTML();
      return renderInspector(ids, kind === "supported" && isSceneEnabled()) + districtGalleryLauncherHTML();
    },
    onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void {
      const ids = districtIds();
      switch (action) {
        case "district-gallery-open": districtGalleryOpen = true; ctx.rerender(); return;
        case "district-gallery-back": districtGalleryOpen = false; ctx.rerender(); return;
        case "district-gallery-mode":
          districtGalleryMode = target.dataset.mode === "play" ? "play" : "overview";
          ctx.rerender();
          return;
        case "district-tool": cancelDistrictInteraction(); setCanvasTool(target.dataset.tool ?? DISTRICT_TOOL.SELECT); return;
        case "district-finish": ctx.run("district draft", finishDistrictDraft()); return;
        case "district-cancel": cancelDistrictDraft(); ctx.rerender(); return;
        case "generate-districts": ctx.run("initial district generation", Promise.resolve(generateDistricts({ districtPool: currentDistrictPool(), openSpaceProfile: currentOpenSpaceProfile() }))); return;
        case "district-apply": {
          if (stagedOverrideInvalid) {
            ui.notifications?.warn("Nixie: fix the open-space override before applying district changes.");
            return;
          }
          const patch: Record<string, unknown> = {};
          if (stagedType !== undefined) patch.typeId = stagedType;
          if (stagedPalette !== undefined) patch.paletteId = stagedPalette;
          if (stagedSeed !== undefined) patch.seed = stagedSeed;
          if (stagedLocked !== undefined) patch.locked = stagedLocked;
          if (stagedOverride !== undefined || stagedOverrideConfig !== undefined) {
            const currentOverride = inspectorValue(districtInspector() as any, "openSpaceOverride", null);
            const mode = stagedOverride ?? (currentOverride === null ? "inherit" : "explicit");
            patch.openSpaceOverride = mode === "inherit" ? null : stagedOverrideConfig ?? currentOverride ?? defaultOverride();
          }
          if (ids.length > 0 && Object.keys(patch).length > 0) ctx.run("district changes", Promise.resolve(updateDistricts(ids, patch)), () => resetStaged(ids));
          return;
        }
        case "district-reroll-seed": {
          if (ids.length === 1) {
            const currentSeed = inspectorValue(districtInspector() as any, "seed", ids[0]);
            stagedSeed = `${String(currentSeed || ids[0])}/reroll/${++seedRerollCounter}`;
            ctx.rerender();
          }
          return;
        }
        case "district-reset": resetStaged(ids); ctx.rerender(); return;
        case "district-unlock": ctx.run("district unlock", Promise.resolve(updateDistricts(ids, { locked: false }))); return;
        case "district-delete": ctx.run("district deletion", Promise.resolve(deleteDistricts(ids))); return;
        case "district-delete-all": ctx.run("delete all districts", Promise.resolve(deleteDistricts(allDistrictIds(getCity())))); return;
        case "district-merge":
          if (ids.length > 1 && mergeSurvivor !== undefined) ctx.run("district merge", Promise.resolve(mergeDistricts(ids, mergeSurvivor)));
          else if (ids.length > 1) ui.notifications?.warn("Nixie: choose the surviving district before merging.");
          return;
        case "district-clear": clearDistrictSelection(); ctx.rerender(); return;
        case "district-retry-walls": ctx.run("generated wall retry", Promise.resolve(retryGeneratedWalls())); return;
        default: return;
      }
    },
    onRender(root: HTMLElement, ctx: WorkspaceContext): void {
      syncInspectorButtons(root);
      root.querySelectorAll<HTMLInputElement>("[data-field=\"district-pool\"]").forEach((input) => input.addEventListener("change", () => {
        const id = input.dataset.districtType as DistrictTypeId;
        const pool = new Set(currentDistrictPool());
        if (input.checked) pool.add(id); else pool.delete(id);
        setDistrictPool([...pool]);
      }));
      root.querySelector<HTMLSelectElement>("[data-field=\"open-space-profile\"]")?.addEventListener("change", (event: Event) => setOpenSpaceProfile((event.target as HTMLSelectElement).value as DistrictOpenSpaceProfile));
      root.querySelector<HTMLSelectElement>("[data-field=\"district-type-select\"]")?.addEventListener("change", (event: Event) => setDistrictType((event.target as HTMLSelectElement).value as DistrictTypeId));
      root.querySelector<HTMLSelectElement>("[data-field=\"district-palette-select\"]")?.addEventListener("change", (event: Event) => setDistrictPalette((event.target as HTMLSelectElement).value));
      const snap: Array<[keyof DistrictSnapOptions, string]> = [["districtVertices", "snap-district"], ["roadJunctions", "snap-road"], ["blockBoundaries", "snap-block"], ["foundryGrid", "snap-grid"]];
      snap.forEach(([key, field]) => root.querySelector<HTMLInputElement>("[data-field=\"" + field + "\"]")?.addEventListener("change", (event: Event) => {
        const next = setDistrictSnapOptions({ [key]: (event.target as HTMLInputElement).checked });
        try { setAdapterDistrictSnapOptions(next); } catch { /* WHY: shell tests render without a mounted canvas adapter. */ }
      }));
      root.querySelector<HTMLSelectElement>("[data-field=\"district-type\"]")?.addEventListener("change", (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        if ((DISTRICT_TYPE_IDS as readonly string[]).includes(value)) stagedType = value as DistrictTypeId;
        syncInspectorButtons(root);
      });
      root.querySelector<HTMLSelectElement>("[data-field=\"district-palette\"]")?.addEventListener("change", (event: Event) => { stagedPalette = (event.target as HTMLSelectElement).value; syncInspectorButtons(root); });
      root.querySelector<HTMLInputElement>("[data-field=\"district-seed\"]")?.addEventListener("input", (event: Event) => { stagedSeed = (event.target as HTMLInputElement).value; syncInspectorButtons(root); });
      root.querySelector<HTMLInputElement>("[data-field=\"district-locked\"]")?.addEventListener("change", (event: Event) => { stagedLocked = (event.target as HTMLInputElement).checked; syncInspectorButtons(root); });
      root.querySelector<HTMLSelectElement>("[data-field=\"district-open-space\"]")?.addEventListener("change", (event: Event) => {
        stagedOverride = (event.target as HTMLSelectElement).value as "inherit" | "explicit";
        if (stagedOverride === "explicit" && stagedOverrideConfig === undefined) stagedOverrideConfig = defaultOverride();
        ctx.rerender();
      });
      root.querySelector<HTMLSelectElement>("[data-field=\"district-survivor\"]")?.addEventListener("change", (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        mergeSurvivor = value === "" ? undefined : value;
        syncInspectorButtons(root);
      });
      root.querySelector<HTMLInputElement>("[data-field=\"district-override-rate\"]")?.addEventListener("input", (event: Event) => {
        const current = stagedOverrideConfig ?? defaultOverride();
        current.rate = Number((event.target as HTMLInputElement).value);
        stagedOverrideConfig = current;
        syncInspectorButtons(root);
      });
      root.querySelector<HTMLInputElement>("[data-field=\"district-override-categories\"]")?.addEventListener("input", (event: Event) => {
        try {
          const current = stagedOverrideConfig ?? defaultOverride();
          const parsed = JSON.parse((event.target as HTMLInputElement).value);
          if (parsed && typeof parsed === "object") { current.categoryWeights = parsed; stagedOverrideConfig = current; }
        } catch {}
        syncInspectorButtons(root);
      });
      root.querySelector<HTMLInputElement>("[data-field=\"district-override-sizes\"]")?.addEventListener("input", (event: Event) => {
        try {
          const current = stagedOverrideConfig ?? defaultOverride();
          const parsed = JSON.parse((event.target as HTMLInputElement).value);
          if (parsed && typeof parsed === "object") { current.sizeWeights = parsed; stagedOverrideConfig = current; }
        } catch {}
        syncInspectorButtons(root);
      });
    }
  };
}

export function districtPlanForOverlay(): unknown {
  try { return getDistrictPlan(); } catch { return null; }
}

export function syncDistrictSnapAdapter(): void {
  try { setAdapterDistrictSnapOptions(adapterDistrictSnapOptions()); } catch { /* WHY: no mounted adapter during shell initialization. */ }
}
