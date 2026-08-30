import {
  cityLoadStatus,
  deleteObject,
  editObjectProperties,
  getArchitectureSource,
  isSceneEnabled,
  rerollObjectAppearance,
  setObjectLocked,
  type ObjectPropertiesPatch
} from "../../adapter/canvas.js";
import { DISTRICT_PALETTE_IDS } from "../../core/gen/district-registry.js";
import {
  BUILDING_GRAMMARS,
  BUILDING_GRAMMAR_REGISTRY,
  BUILDING_USE_IDS,
  type BuildingGrammarDefinition,
  type BuildingGrammarId,
  type BuildingUseId
} from "../../core/gen/building-registry.js";
import {
  LANDMARK_GRAMMARS,
  LANDMARK_GRAMMAR_REGISTRY,
  type LandmarkGrammarDefinition,
  type LandmarkGrammarId
} from "../../core/gen/landmark-registry.js";
import {
  canvasTool,
  currentObjectCategory,
  currentPendingOperation,
  OBJECT_TOOL,
  setCanvasTool,
  setObjectCategory,
  setObjectStagingClearListener,
  type ObjectCategory
} from "../editor-state.js";
import {
  cancelObjectPlacement,
  clearObjectSelection,
  configureObjectPlacement,
  getObjectError,
  getObjectSelection,
  objectInspector,
  setObjectsWorkspaceBridge
} from "../objects-layer.js";
import { architecturePreviewSVG } from "../architecture-preview.js";
import { escapeHTML, selected, statusKind } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

export type ObjectsActiveCategory = "buildings" | "places";
export type ObjectsPreset =
  | { kind: "building"; id: BuildingGrammarId }
  | { kind: "place"; id: LandmarkGrammarId };

export interface ObjectCatalogueEntry {
  id: string;
  label: string;
  group: string;
  kind: "building" | "place";
}

export interface ObjectsSelection {
  ids: string[];
  kind: "building" | "place" | null;
}

interface NormalizedObject {
  id: string;
  kind: "building" | "place";
  label: string;
  grammarId?: BuildingGrammarId;
  landmarkGrammarId?: LandmarkGrammarId;
  visualUse?: BuildingUseId;
  heightM?: number;
  widthM?: number;
  depthM?: number;
  areaM2?: number;
  paletteId: string | null;
  protection?: string;
  origin?: string;
  persistent: boolean;
  locked: boolean;
}

interface StagedObject {
  grammarId?: BuildingGrammarId;
  landmarkGrammarId?: LandmarkGrammarId;
  visualUse?: BuildingUseId;
  heightM?: number;
  paletteId?: string | null;
}

interface BuildingInspectorState {
  grammar: BuildingGrammarDefinition | null;
  visualUse: BuildingUseId | null;
  heightM: number | null;
  options: readonly BuildingGrammarDefinition[];
}

type ObjectRecord = Record<string, unknown>;

const DISABLED_CATEGORY_COPY: Record<"props" | "pois", string> = {
  props: "Props & Vehicles arrive in Phase 7.",
  pois: "POIs arrive in Phase 8."
};
const PLACE_GROUPS = ["Towers & Spires", "Megastructures & Arcologies", "Infrastructure & Utility", "Civic & Arenas"] as const;
const stagedById = new Map<string, StagedObject>();
const activeCatalogueGroups = new Map<ObjectsActiveCategory, string>();
let activePreset: ObjectsPreset | null = null;
let lastSelectionKey = "";
let actionPending = false;

function asObjectRecord(value: unknown): ObjectRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ObjectRecord;
}

function readString(value: ObjectRecord | null, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function groupForPlace(definition: LandmarkGrammarDefinition): string {
  const id = definition.id;
  if (/tower|spire|beacon|mast|pylon|hq/.test(id)) return PLACE_GROUPS[0];
  if (/compound|frame|arcology|gateway/.test(id)) return PLACE_GROUPS[1];
  if (/utility|infrastructure|transit|cooling/.test(id)) return PLACE_GROUPS[2];
  return PLACE_GROUPS[3];
}

/** Registry-derived catalogue entries; IDs and labels are never duplicated in the UI. */
export function objectCatalogueEntries(category: ObjectsActiveCategory): ObjectCatalogueEntry[] {
  if (category === "buildings") {
    return BUILDING_GRAMMARS.map((definition) => ({ id: definition.id, label: definition.label, group: titleCase(definition.archetype), kind: "building" }));
  }
  return LANDMARK_GRAMMARS.map((definition) => ({ id: definition.id, label: definition.label, group: groupForPlace(definition), kind: "place" }));
}

export function objectCatalogueGroupNames(category: ObjectsActiveCategory): string[] {
  const names = new Set<string>();
  for (const entry of objectCatalogueEntries(category)) names.add(entry.group);
  return [...names];
}

function normalizeSelection(raw: unknown): ObjectsSelection {
  if (Array.isArray(raw)) return { ids: raw.filter((id): id is string => typeof id === "string"), kind: null };
  const value = asObjectRecord(raw);
  const rawIds = value?.ids;
  const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
  const rawKind = value?.kind;
  const kind = rawKind === "building" || rawKind === "place" ? rawKind : null;
  return { ids, kind };
}

function selection(): ObjectsSelection {
  try { return normalizeSelection(getObjectSelection()); }
  catch { return { ids: [], kind: null }; }
}

function selectionKey(value: ObjectsSelection): string {
  return `${value.kind ?? ""}:${value.ids.join("|")}`;
}

function sourceObject(id: string): unknown | null {
  const architecture = getArchitectureSource();
  if (architecture === null) return null;
  return architecture.buildings.find((entry) => entry.id === id) ?? architecture.places.find((entry) => entry.id === id) ?? null;
}

function inspectionRecord(id: string): ObjectRecord | null {
  try {
    const inspection = objectInspector();
    if (inspection !== null && inspection.id === id) return inspection.plan;
  } catch { /* A plan may not be available while a Scene is loading. */ }
  return asObjectRecord(sourceObject(id));
}

function readFiniteNumber(value: ObjectRecord | null, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function ringArea(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const points = value.map((point) => {
    const record = asObjectRecord(point);
    const x = readFiniteNumber(record, "x");
    const y = readFiniteNumber(record, "y");
    return x === undefined || y === undefined ? null : { x, y };
  });
  if (points.some((point) => point === null)) return undefined;
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    if (current === null || next === null) return undefined;
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) * 0.5;
}

function objectDimensions(record: ObjectRecord): Pick<NormalizedObject, "widthM" | "depthM" | "areaM2"> {
  const placement = asObjectRecord(record.placement);
  const widthM = readFiniteNumber(placement, "widthM");
  const depthM = readFiniteNumber(placement, "depthM");
  const areaM2 = readFiniteNumber(record, "areaM2") ?? ringArea(record.sitePolygon)
    ?? (widthM !== undefined && depthM !== undefined ? widthM * depthM : undefined);
  return {
    ...(widthM === undefined ? {} : { widthM }),
    ...(depthM === undefined ? {} : { depthM }),
    ...(areaM2 === undefined ? {} : { areaM2 })
  };
}

function grammarFitsObject(definition: BuildingGrammarDefinition, value: NormalizedObject): boolean {
  if (value.widthM === undefined || value.depthM === undefined) return true;
  const limits = definition.siteLimits;
  if (value.widthM < limits.minWidthM || value.widthM > limits.maxWidthM) return false;
  if (value.depthM < limits.minDepthM || value.depthM > limits.maxDepthM) return false;
  const areaM2 = value.areaM2 ?? value.widthM * value.depthM;
  if (areaM2 < limits.minAreaM2 || areaM2 > limits.maxAreaM2) return false;
  const aspect = value.widthM / value.depthM;
  return aspect >= limits.minAspect && aspect <= limits.maxAspect;
}

function buildingInspectorState(value: NormalizedObject, staged: StagedObject): BuildingInspectorState {
  const requestedGrammarId = staged.grammarId ?? value.grammarId;
  const requestedUse = staged.visualUse ?? value.visualUse ?? null;
  const requestedHeight = staged.heightM ?? value.heightM ?? null;
  const options = BUILDING_GRAMMARS.filter((definition) => grammarFitsObject(definition, value));
  const requestedGrammar = requestedGrammarId === undefined ? undefined : BUILDING_GRAMMAR_REGISTRY.get(requestedGrammarId);
  const grammar = options.find((definition) => definition.id === requestedGrammarId) ?? options[0] ?? requestedGrammar ?? null;
  const visualUse = grammar === null
    ? requestedUse
    : grammar.compatibleUses.includes(requestedUse as BuildingUseId)
      ? requestedUse
      : grammar.compatibleUses[0] ?? null;
  const heightM = grammar === null || requestedHeight === null
    ? requestedHeight
    : Math.min(grammar.height.maxM, Math.max(grammar.height.minM, requestedHeight));
  const normalizedOptions = BUILDING_GRAMMARS.filter((definition) => grammarFitsObject(definition, value));
  const selectedGrammar = normalizedOptions.find((definition) => definition.id === grammar?.id) ?? normalizedOptions[0] ?? grammar;
  return { grammar: selectedGrammar, visualUse, heightM, options: normalizedOptions };
}

function normalizedObject(id: string, kind: "building" | "place"): NormalizedObject | null {
  const record = inspectionRecord(id);
  if (record === null) return null;
  const recordKind = readString(record, "kind") === "place" || kind === "place" ? "place" : "building";
  const grammarId = readString(record, "grammarId") as BuildingGrammarId | undefined;
  const landmarkGrammarId = (readString(record, "landmarkGrammarId") ?? (recordKind === "place" ? grammarId : undefined)) as LandmarkGrammarId | undefined;
  const definition = recordKind === "building"
    ? (grammarId === undefined ? undefined : BUILDING_GRAMMAR_REGISTRY.get(grammarId))
    : (landmarkGrammarId === undefined ? undefined : LANDMARK_GRAMMAR_REGISTRY.get(landmarkGrammarId));
  const source = sourceObject(id);
  const protection = readString(record, "protection");
  const origin = readString(record, "origin");
  const dimensions = objectDimensions(record);
  const visualUse = readString(record, "visualUse") as BuildingUseId | undefined;
  const height = readFiniteNumber(record, "heightM");
  const palette = typeof record.paletteId === "string" ? record.paletteId : null;
  return {
    id,
    kind: recordKind,
    label: readString(record, "label") ?? definition?.label ?? id,
    ...(recordKind === "building" && grammarId !== undefined ? { grammarId } : {}),
    ...(recordKind === "place" && landmarkGrammarId !== undefined ? { landmarkGrammarId } : {}),
    ...(visualUse === undefined ? {} : { visualUse }),
    ...(typeof height === "number" && Number.isFinite(height) ? { heightM: height } : {}),
    paletteId: palette,
    ...dimensions,
    ...(protection === undefined ? {} : { protection }),
    ...(origin === undefined ? {} : { origin }),
    persistent: source !== null,
    locked: protection === "explicit"
  };
}

function selectedObject(): NormalizedObject | null {
  const current = selection();
  if (current.ids.length !== 1 || current.kind === null) return null;
  return normalizedObject(current.ids[0]!, current.kind);
}

function stagedFor(value: NormalizedObject): StagedObject {
  const existing = stagedById.get(value.id);
  if (existing !== undefined) return existing;
  const created: StagedObject = {};
  stagedById.set(value.id, created);
  return created;
}

function stagedDirty(value: StagedObject): boolean {
  return Object.keys(value).length > 0;
}

function resetSelectionStaging(value: ObjectsSelection): void {
  const key = selectionKey(value);
  if (key === lastSelectionKey) return;
  lastSelectionKey = key;
  stagedById.clear();
}

function paletteOptions(value: string | null): string {
  const current = value ?? "";
  return `<option value=""${selected("", current)}>Inherit district palette</option>` + DISTRICT_PALETTE_IDS.map((id) => `<option value="${escapeHTML(id)}"${selected(id, current)}>${escapeHTML(titleCase(id))}</option>`).join("");
}
function buildingOptions(value: string, options: readonly BuildingGrammarDefinition[]): string {
  if (options.length === 0) return `<option value="" disabled>No compatible presets for this site</option>`;
  return options.map((definition) => `<option value="${escapeHTML(definition.id)}"${selected(definition.id, value)}>${escapeHTML(definition.label)}</option>`).join("");
}

function placeOptions(value: string): string {
  return LANDMARK_GRAMMARS.map((definition) => `<option value="${escapeHTML(definition.id)}"${selected(definition.id, value)}>${escapeHTML(definition.label)}</option>`).join("");
}

function useOptions(value: BuildingUseId | null, grammar: BuildingGrammarDefinition | null): string {
  if (grammar === null || grammar.compatibleUses.length === 0) return `<option value="" disabled>No compatible uses</option>`;
  const current = value ?? grammar.compatibleUses[0]!;
  return grammar.compatibleUses.map((id) => `<option value="${escapeHTML(id)}"${selected(id, current)}>${escapeHTML(titleCase(id))}</option>`).join("");
}


function renderMultiSummary(value: ObjectsSelection, interactive = true): string {
  const kind = value.kind === "place" ? "places" : "buildings";
  return `<section data-panel="objects-multi" class="nixie-tray-inspector nixie-objects-inspector" aria-label="Multiple ${kind} selected"><div class="nixie-inspector-head"><h3>${value.ids.length} ${kind} selected</h3><span class="nixie-status-badge">Multiple selection</span></div><p class="nixie-inspector-sub">Shift-click selects same-kind objects. Property editing and transform gizmos are disabled for multi-selection.</p><div class="nixie-object-summary" role="status"><strong>Summary only</strong><span>${escapeHTML(value.ids.join(", "))}</span></div><div class="form-footer"><button type="button" data-action="object-clear-selection" title="Clear object selection"${interactive ? "" : " disabled"}>Clear selection</button></div></section>`;
}

function renderSingleInspector(value: NormalizedObject, enabled: boolean): string {
  const pendingAction = actionPending || currentPendingOperation() !== null;
  const staged = stagedFor(value);
  const editable = enabled && !value.locked && !pendingAction;
  const building = value.kind === "building" ? buildingInspectorState(value, staged) : null;
  const grammar = building?.grammar ?? null;
  const grammarId = grammar?.id ?? "";
  const landmark = staged.landmarkGrammarId ?? value.landmarkGrammarId ?? LANDMARK_GRAMMARS[0]!.id;
  const visualUse = building?.visualUse ?? null;
  const rawHeight = building?.heightM ?? null;
  const height = rawHeight ?? grammar?.height.minM ?? 24;
  const heightMin = grammar?.height.minM ?? 1;
  const heightMax = grammar?.height.maxM ?? 300;
  const palette = staged.paletteId ?? value.paletteId ?? null;
  const dirty = stagedDirty(staged);
  const fields = value.kind === "building"
    ? `<div class="form-group"><label for="nixie-object-grammar">Preset</label><div class="form-fields"><select id="nixie-object-grammar" data-field="object-grammar"${editable ? "" : " disabled"}>${buildingOptions(grammarId, building?.options ?? [])}</select></div></div><div class="form-group"><label for="nixie-object-use">Use</label><div class="form-fields"><select id="nixie-object-use" data-field="object-use"${editable ? "" : " disabled"}>${useOptions(visualUse, grammar)}</select></div></div><div class="form-group"><label for="nixie-object-height">Height <output data-height-output>${Math.round(height)} m</output></label><div class="form-fields"><input id="nixie-object-height" type="range" min="${heightMin}" max="${heightMax}" step="1" value="${escapeHTML(String(height))}" data-field="object-height"${editable ? "" : " disabled"}></div></div>`
    : `<div class="form-group"><label for="nixie-object-landmark">Preset</label><div class="form-fields"><select id="nixie-object-landmark" data-field="object-landmark"${editable ? "" : " disabled"}>${placeOptions(landmark)}</select></div></div>`;
  const origin = value.origin === undefined ? "Derived" : titleCase(value.origin);
  const protection = value.locked ? "Locked" : value.protection === undefined ? "Editable" : titleCase(value.protection);
  const deleteEnabled = enabled && !pendingAction && !value.locked && value.persistent;
  return `<section data-panel="objects-inspector" class="nixie-tray-inspector nixie-objects-inspector" aria-label="${escapeHTML(value.label)} inspector"><div class="nixie-inspector-head"><h3>${escapeHTML(value.label)}</h3><button type="button" data-action="object-lock" title="${value.locked ? "Unlock" : "Lock"} ${escapeHTML(value.label)}"${enabled && !pendingAction ? "" : " disabled"}>${value.locked ? "Unlock" : "Lock"}</button></div><p class="nixie-inspector-sub"><span class="nixie-status-badge">${escapeHTML(protection)}</span> ${escapeHTML(origin)} • ${escapeHTML(value.kind)} • <code>${escapeHTML(value.id)}</code></p><div class="nixie-form-grid">${fields}<div class="form-group"><label for="nixie-object-palette">Palette</label><div class="form-fields"><select id="nixie-object-palette" data-field="object-palette"${editable ? "" : " disabled"}>${paletteOptions(palette)}</select></div></div></div><p class="nixie-note" data-status="object-inspector">${dirty ? "Unapplied changes are staged in this inspector." : "Changes stay staged until Apply."}</p><div class="form-footer"><button type="button" data-action="object-reset"${dirty && editable ? "" : " disabled"}>Reset</button><button type="button" data-action="object-apply"${dirty && editable ? "" : " disabled"}>Apply</button></div><div class="form-footer"><button type="button" data-action="object-reroll"${enabled && !pendingAction && !value.locked ? "" : " disabled"}>Reroll Appearance</button><button type="button" data-action="object-site"${enabled && !pendingAction && !value.locked ? "" : " disabled"} title="Move existing site polygon vertices">Edit Site</button><button type="button" data-action="object-delete"${deleteEnabled ? "" : " disabled"} title="Delete this persistent object">Delete</button><button type="button" data-action="object-clear-selection">Clear selection</button></div></section>`;
}

function renderDiagnostics(): string {
  let error: unknown = null;
  try { error = getObjectError(); } catch { error = null; }
  if (error === null) return "";
  const record = asObjectRecord(error);
  const message = typeof error === "string" ? error : readString(record, "message") ?? readString(record, "reason") ?? "Object operation failed.";
  const affectedRaw = record?.affectedIds;
  const affected = Array.isArray(affectedRaw) ? affectedRaw.filter((id): id is string => typeof id === "string") : [];
  return `<section data-panel="objects-error" class="nixie-object-error" role="alert" aria-live="assertive"><h3>Object operation needs attention</h3><p>${escapeHTML(message)}</p>${affected.length === 0 ? "" : `<p class="nixie-note">Affected objects: ${affected.map(escapeHTML).join(", ")}</p>`}</section>`;
}

function renderCatalogue(category: ObjectsActiveCategory, enabled: boolean): string {
  const entries = objectCatalogueEntries(category);
  const groups = new Map<string, ObjectCatalogueEntry[]>();
  for (const entry of entries) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  const availableGroups = [...groups.keys()];
  const currentGroup = activeCatalogueGroups.get(category);
  const activeGroup = currentGroup !== undefined && groups.has(currentGroup) ? currentGroup : availableGroups[0] ?? "";
  if (activeGroup !== "") activeCatalogueGroups.set(category, activeGroup);
  const values = groups.get(activeGroup) ?? [];
  const family = category === "buildings" ? "building grammars" : "place grammars";
  const activeId = activePreset?.kind === (category === "buildings" ? "building" : "place") ? activePreset.id : "";
  const groupOptions = availableGroups.map((group) => `<option value="${escapeHTML(group)}"${selected(group, activeGroup)}>${escapeHTML(group)} (${groups.get(group)!.length})</option>`).join("");
  const cards = values.map((entry) => {
    const active = entry.id === activeId;
    const preview = entry.kind === "building"
      ? architecturePreviewSVG("building", entry.id, { label: `${entry.label} silhouette` })
      : architecturePreviewSVG("place", entry.id, { label: `${entry.label} silhouette` });
    return `<button type="button" class="nixie-object-catalogue-entry${active ? " active" : ""}" data-action="object-preset" data-object-kind="${entry.kind}" data-object-id="${escapeHTML(entry.id)}"${enabled ? "" : " disabled"} aria-pressed="${active}" title="Place ${escapeHTML(entry.label)}"><span class="nixie-object-preview">${preview}</span><span class="nixie-object-entry-label">${escapeHTML(entry.label)}</span><span class="nixie-object-entry-status">${active ? "Active preset" : "Place"}</span></button>`;
  }).join("");
  const section = activeGroup === ""
    ? `<p class="nixie-note">No ${family} are available.</p>`
    : `<section class="nixie-object-catalogue-group" data-catalogue-group="${escapeHTML(activeGroup)}" aria-label="${escapeHTML(activeGroup)} group"><div class="nixie-object-group-head"><h4>${escapeHTML(activeGroup)}</h4><span class="nixie-object-group-count">${values.length}</span></div><div class="nixie-object-catalogue-grid">${cards}</div></section>`;
  const preset = activePreset === null ? "" : `<p class="nixie-object-preset-status" role="status"><strong>Preset active:</strong> ${escapeHTML(activePreset.id)} — click the canvas to place. Placement stays active after each commit.</p>`;
  return `<section data-panel="objects-catalogue" class="nixie-tray-inspector nixie-object-catalogue" aria-label="${category === "buildings" ? "Building" : "Place"} catalogue"><div class="nixie-inspector-head"><h3>${category === "buildings" ? "Buildings" : "Places"}</h3><span class="nixie-status-badge">${entries.length} ${family}</span></div><p class="nixie-note">Choose a visual preset to place it. Silhouettes are generated from the live registry and cached for this session.</p><div class="nixie-object-group-picker form-group"><label for="nixie-object-catalogue-group">Shape family</label><div class="form-fields"><select id="nixie-object-catalogue-group" data-action="object-group" data-field="object-catalogue-group" aria-label="Choose ${category === "buildings" ? "building" : "place"} shape family"${enabled ? "" : " disabled"}>${groupOptions}</select></div><span class="nixie-object-group-count" aria-live="polite">${values.length} options</span></div><div class="nixie-object-catalogue-groups">${section}</div>${preset}</section>`;
}

function editorEnabled(): boolean {
  try { return statusKind(cityLoadStatus()) === "supported" && isSceneEnabled(); }
  catch { return false; }
}

function defaultBuildingPlacement(definition: BuildingGrammarDefinition): { widthM: number; depthM: number; heightM: number } {
  const limits = definition.siteLimits;
  return { widthM: Math.max(1, Math.min(60, (limits.minWidthM + limits.maxWidthM) * 0.5)), depthM: Math.max(1, Math.min(60, (limits.minDepthM + limits.maxDepthM) * 0.5)), heightM: Math.max(1, (definition.height.minM + definition.height.maxM) * 0.5) };
}

function beginPlacement(preset: ObjectsPreset): void {
  if (preset.kind === "building") {
    const definition = BUILDING_GRAMMAR_REGISTRY.get(preset.id);
    if (definition === undefined) return;
    activePreset = preset;
    setCanvasTool(OBJECT_TOOL.PLACE);
    const defaults = defaultBuildingPlacement(definition);
    configureObjectPlacement({ kind: "building", grammarId: preset.id, visualUse: definition.compatibleUses[0] ?? BUILDING_USE_IDS[0], paletteId: null, widthM: defaults.widthM, depthM: defaults.depthM, heightM: defaults.heightM, rotationRad: 0 });
    return;
  }
  if (!LANDMARK_GRAMMAR_REGISTRY.has(preset.id)) return;
  activePreset = preset;
  setCanvasTool(OBJECT_TOOL.PLACE);
  configureObjectPlacement({ kind: "place", landmarkGrammarId: preset.id, paletteId: null, widthM: 56, depthM: 56, rotationRad: 0 });
}
function normalizeStagedBuildingPreset(value: NormalizedObject, grammarId: BuildingGrammarId): void {
  const definition = BUILDING_GRAMMAR_REGISTRY.get(grammarId);
  if (definition === undefined) return;
  const staged = stagedFor(value);
  const currentUse = staged.visualUse ?? value.visualUse;
  staged.grammarId = grammarId;
  staged.visualUse = currentUse !== undefined && definition.compatibleUses.includes(currentUse)
    ? currentUse
    : definition.compatibleUses[0] ?? BUILDING_USE_IDS[0];
  const currentHeight = staged.heightM ?? value.heightM ?? definition.height.minM;
  staged.heightM = Math.min(definition.height.maxM, Math.max(definition.height.minM, currentHeight));
}


function stagedPatch(value: NormalizedObject, staged: StagedObject): ObjectPropertiesPatch {
  if (value.kind === "building") return { ...(staged.grammarId === undefined ? {} : { grammarId: staged.grammarId }), ...(staged.visualUse === undefined ? {} : { visualUse: staged.visualUse }), ...(staged.heightM === undefined ? {} : { heightM: staged.heightM }), ...(staged.paletteId === undefined ? {} : { paletteId: staged.paletteId }) };
  return { ...(staged.landmarkGrammarId === undefined ? {} : { landmarkGrammarId: staged.landmarkGrammarId }), ...(staged.paletteId === undefined ? {} : { paletteId: staged.paletteId }) };
}

function runObjectAction(label: string, work: Promise<unknown>, ctx: WorkspaceContext, then?: () => void): void {
  actionPending = true;
  const guarded = work.catch((error: unknown) => { actionPending = false; throw error; });
  ctx.run(label, guarded, () => { actionPending = false; then?.(); });
}

export function clearObjectsWorkspaceState(): void {
  stagedById.clear();
  activeCatalogueGroups.clear();
  activePreset = null;
  lastSelectionKey = "";
  actionPending = false;
  setObjectsWorkspaceBridge(null);
}

export function objectsWorkspace(): WorkspaceModule {
  return {
    id: "objects",
    renderShelf(): string {
      const category = currentObjectCategory();
      const enabled = editorEnabled();
      const currentSelection = selection();
      const summary = currentSelection.ids.length === 0 ? "" : `${currentSelection.ids.length} ${currentSelection.kind === "place" ? "place" : "building"}${currentSelection.ids.length === 1 ? "" : "s"} selected`;
      const tool = canvasTool();
      const pending = actionPending || currentPendingOperation() !== null;
      const gate = enabled && !pending ? "" : " disabled";
      const active = (value: string): string => tool === value ? " active" : "";
      return `<div class="nixie-shelf-row nixie-object-categories" role="group" aria-label="Object category"><button type="button" data-action="object-category" data-category="buildings" class="${category === "buildings" ? "active" : ""}"${gate} aria-pressed="${category === "buildings"}" title="Browse building grammars">Buildings</button><button type="button" data-action="object-category" data-category="places" class="${category === "places" ? "active" : ""}"${gate} aria-pressed="${category === "places"}" title="Browse place grammars">Places</button><button type="button" data-action="object-category" data-category="props" disabled aria-disabled="true" title="Props and Vehicles — Phase 7">Props &amp; Vehicles <small>Phase 7</small></button><button type="button" data-action="object-category" data-category="pois" disabled aria-disabled="true" title="Points of Interest — Phase 8">POIs <small>Phase 8</small></button></div><div class="nixie-shelf-row nixie-object-tools" role="group" aria-label="Object tools"><button type="button" data-action="tool" data-tool="${OBJECT_TOOL.SELECT}" class="${active(OBJECT_TOOL.SELECT)}"${gate} aria-pressed="${tool === OBJECT_TOOL.SELECT}" title="Select architecture objects">Select</button><button type="button" data-action="tool" data-tool="${OBJECT_TOOL.PLACE}" class="${active(OBJECT_TOOL.PLACE)}"${gate} aria-pressed="${tool === OBJECT_TOOL.PLACE}" title="Place the active architecture preset">Place</button><button type="button" data-action="tool" data-tool="${OBJECT_TOOL.SITE}" class="${active(OBJECT_TOOL.SITE)}"${gate} aria-pressed="${tool === OBJECT_TOOL.SITE}" title="Move existing site polygon vertices">Site</button>${activePreset === null ? "" : `<span class="nixie-shelf-summary" role="status">Preset: ${escapeHTML(activePreset.id)}</span>`}${summary === "" ? "" : `<span class="nixie-shelf-summary" role="status">${escapeHTML(summary)}</span>`}</div><p class="nixie-shelf-hint">Click to select • Shift-click for same-kind summary • Right-click exits placement</p>`;
    },
    renderTray(): string {
      const category = currentObjectCategory();
      const enabled = editorEnabled();
      if (category === "props" || category === "pois") return `<section data-panel="objects-disabled" class="nixie-tray-inspector nixie-object-disabled"><h3>${category === "props" ? "Props &amp; Vehicles" : "POIs"}</h3><p class="nixie-note">${escapeHTML(DISABLED_CATEGORY_COPY[category])}</p><span class="nixie-status-badge">Unavailable</span></section>`;
      const currentSelection = selection();
      resetSelectionStaging(currentSelection);
      const inspected = currentSelection.ids.length === 1 && currentSelection.kind !== null ? normalizedObject(currentSelection.ids[0]!, currentSelection.kind) : null;
      const pending = actionPending || currentPendingOperation() !== null;
      const body = currentSelection.ids.length > 1 ? renderMultiSummary(currentSelection, !pending) : inspected === null ? renderCatalogue(category, enabled && !pending) : renderSingleInspector(inspected, enabled);
      const state = pending ? `<p class="nixie-object-pending" data-status-kind="pending" role="status"><strong>Pending:</strong> applying the object change. Controls are temporarily locked.</p>` : enabled ? "" : `<p class="nixie-note" data-status-kind="warning" role="status">Enable Nixie on this Scene and create a city before editing objects.</p>`;
      return state + renderDiagnostics() + body;
    },
    onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void {
      if (actionPending || currentPendingOperation() !== null) return;
      if (action === "object-category") {
        const next = target.dataset.category;
        if (next !== "buildings" && next !== "places") return;
        if (next !== currentObjectCategory()) {
          cancelObjectPlacement(false);
          activePreset = null;
          stagedById.clear();
          setObjectCategory(next as ObjectCategory);
          setCanvasTool(OBJECT_TOOL.SELECT);
        }
        return;
      }
      if (action === "object-group") {
        const group = target.dataset.group ?? target.dataset.value ?? "";
        const category = currentObjectCategory();
        if ((category === "buildings" || category === "places") && objectCatalogueGroupNames(category).includes(group)) {
          activeCatalogueGroups.set(category, group);
          ctx.rerender();
        }
        return;
      }
      if (action === "object-preset") {
        const id = target.dataset.objectId ?? "";
        const kind = target.dataset.objectKind;
        if (kind === "building" && BUILDING_GRAMMAR_REGISTRY.has(id as BuildingGrammarId)) beginPlacement({ kind: "building", id: id as BuildingGrammarId });
        else if (kind === "place" && LANDMARK_GRAMMAR_REGISTRY.has(id as LandmarkGrammarId)) beginPlacement({ kind: "place", id: id as LandmarkGrammarId });
        return;
      }
      if (action === "tool") {
        const next = target.dataset.tool ?? null;
        if (next !== OBJECT_TOOL.PLACE) cancelObjectPlacement(false);
        setCanvasTool(next);
        return;
      }
      if (action === "object-clear-selection") { clearObjectSelection(); return; }
      const current = selectedObject();
      if (current === null || selection().ids.length !== 1) return;
      if (action === "object-reset") { stagedById.delete(current.id); ctx.rerender(); return; }
      if (action === "object-apply") {
        const staged = stagedById.get(current.id);
        if (staged === undefined || !stagedDirty(staged)) return;
        runObjectAction("object changes", editObjectProperties(current.id, stagedPatch(current, staged)), ctx, () => stagedById.delete(current.id));
        return;
      }
      if (action === "object-lock") { runObjectAction(`${current.locked ? "unlock" : "lock"} object`, setObjectLocked(current.id, !current.locked), ctx); return; }
      if (action === "object-reroll") { runObjectAction("reroll object appearance", rerollObjectAppearance(current.id), ctx); return; }
      if (action === "object-delete") { runObjectAction("delete object", deleteObject(current.id), ctx, () => stagedById.delete(current.id)); return; }
      if (action === "object-site") { cancelObjectPlacement(false); setCanvasTool(OBJECT_TOOL.SITE); }
    },
    onRender(root: HTMLElement, ctx: WorkspaceContext): void {
      setObjectsWorkspaceBridge({ run: (label, work, then) => ctx.run(label, work, then), rerender: ctx.rerender });
      setObjectStagingClearListener(clearObjectsWorkspaceState);
      const currentSelection = selection();
      resetSelectionStaging(currentSelection);
      const current = selectedObject();
      root.querySelector('[data-field="object-catalogue-group"]')?.addEventListener("change", (event: Event) => {
        const group = (event.target as HTMLSelectElement).value;
        const category = currentObjectCategory();
        if ((category === "buildings" || category === "places") && objectCatalogueGroupNames(category).includes(group)) {
          activeCatalogueGroups.set(category, group);
          ctx.rerender();
        }
      });
      root.querySelector('[data-field="object-grammar"]')?.addEventListener("change", (event: Event) => {
        if (current === null || current.kind !== "building") return;
        const value = (event.target as HTMLSelectElement).value as BuildingGrammarId;
        if (BUILDING_GRAMMAR_REGISTRY.has(value)) {
          const staged = stagedFor(current);
          const state = buildingInspectorState(current, staged);
          if (!state.options.some((definition) => definition.id === value)) return;
          normalizeStagedBuildingPreset(current, value);
          syncInspectorButtons(root, current.id);
          ctx.rerender();
        }
      });
      root.querySelector('[data-field="object-landmark"]')?.addEventListener("change", (event: Event) => { if (current === null) return; const value = (event.target as HTMLSelectElement).value as LandmarkGrammarId; if (LANDMARK_GRAMMAR_REGISTRY.has(value)) { stagedFor(current).landmarkGrammarId = value; syncInspectorButtons(root, current.id); } });
      root.querySelector('[data-field="object-use"]')?.addEventListener("change", (event: Event) => {
        if (current === null || current.kind !== "building") return;
        const value = (event.target as HTMLSelectElement).value as BuildingUseId;
        const staged = stagedFor(current);
        const grammarId = staged.grammarId ?? current.grammarId;
        const grammar = grammarId === undefined ? undefined : BUILDING_GRAMMAR_REGISTRY.get(grammarId);
        if (grammar?.compatibleUses.includes(value) === true) {
          staged.visualUse = value;
          syncInspectorButtons(root, current.id);
          ctx.rerender();
        }
      });
      root.querySelector('[data-field="object-height"]')?.addEventListener("input", (event: Event) => {
        if (current === null || current.kind !== "building") return;
        const value = Number((event.target as HTMLInputElement).value);
        const grammarId = stagedFor(current).grammarId ?? current.grammarId;
        const grammar = grammarId === undefined ? undefined : BUILDING_GRAMMAR_REGISTRY.get(grammarId);
        if (Number.isFinite(value) && value > 0) {
          const normalized = grammar === undefined ? value : Math.min(grammar.height.maxM, Math.max(grammar.height.minM, value));
          stagedFor(current).heightM = normalized;
          const output = root.querySelector<HTMLOutputElement>("[data-height-output]");
          if (output !== null) output.value = `${Math.round(normalized)} m`;
          syncInspectorButtons(root, current.id);
        }
      });
      root.querySelector('[data-field="object-palette"]')?.addEventListener("change", (event: Event) => { if (current === null) return; const value = (event.target as HTMLSelectElement).value; stagedFor(current).paletteId = value === "" ? null : value; syncInspectorButtons(root, current.id); });
    }
  };
}

function syncInspectorButtons(root: HTMLElement, id: string): void {
  const dirty = stagedById.has(id) && stagedDirty(stagedById.get(id)!);
  const disabled = actionPending || currentPendingOperation() !== null || !dirty;
  const apply = root.querySelector<HTMLButtonElement>('[data-action="object-apply"]');
  const reset = root.querySelector<HTMLButtonElement>('[data-action="object-reset"]');
  if (apply !== null) apply.disabled = disabled;
  if (reset !== null) reset.disabled = disabled;
}

export function objectsWorkspaceCatalogueHTML(category: ObjectsActiveCategory = "buildings"): string {
  return renderCatalogue(category, true);
}
