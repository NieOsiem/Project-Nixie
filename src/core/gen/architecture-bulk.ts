import type { Ring } from "../geom/types.js";
import {
  BUILDING_GRAMMAR_IDS,
  BUILDING_GRAMMAR_REGISTRY,
  BUILDING_USE_IDS,
  type BuildingGrammarId,
  type BuildingUseId
} from "./building-registry.js";
import {
  architectureOverrideFor,
  architecturePlanTarget,
  architectureSourceTarget,
  hasOwn,
  manualEditProtection,
  promotedArchitectureSource,
  removeArchitectureOverride,
  replaceArchitectureOverride,
  validateArchitectureObjectPatch,
  type ArchitectureObjectKind,
  type ArchitecturePlanTarget,
  type ArchitectureSourcePatch
} from "./architecture-edit.js";
import { DISTRICT_PALETTE_IDS } from "./district-registry.js";
import { LANDMARK_GRAMMAR_IDS, type LandmarkGrammarId } from "./landmark-registry.js";
import type {
  ArchitectureOverrideSource,
  ArchitectureProtection,
  ArchitectureSource,
  CitySourceV5,
  PersistentBuildingSource,
  PersistentPlaceSource
} from "./city.js";
import type { CompleteCityPlan } from "./complete-city-plan.js";

/**
 * Pure same-type bulk architecture candidate builder (Phase 6 Slice E). Every
 * selected id is validated against ONE retained source/plan snapshot before any
 * mutation; an incompatible member rejects the complete action with the exact
 * ids and reasons. No adapter state, no plan building, no side effects: the
 * caller owns committing the returned candidate through the existing guarded
 * save path. Promotion, override, and patch semantics are the shared
 * architecture-edit helpers, so bulk behaviour stays identical to the
 * singular-edit path by construction.
 */

export type BulkArchitectureOperation =
  | { kind: "lock"; locked: boolean }
  | { kind: "delete" }
  | { kind: "edit"; patch: ArchitectureSourcePatch };

export type BulkArchitectureBlockerKind = "selection" | "unknown" | "building" | "place";

export interface BulkArchitectureBlocker {
  id: string;
  kind: BulkArchitectureBlockerKind;
  reason: string;
}

export class BulkArchitectureError extends Error {
  readonly blockers: BulkArchitectureBlocker[];

  constructor(blockers: readonly BulkArchitectureBlocker[]) {
    super(`Bulk architecture action rejected: ${blockers.map((blocker) => `${blocker.id}: ${blocker.reason}`).join("; ")}`);
    this.name = "BulkArchitectureError";
    this.blockers = [...blockers];
  }
}

export interface BulkArchitectureCandidate {
  architecture: ArchitectureSource;
  /** Prior site polygon of every touched object, for scoped chunk invalidation. */
  sitePolygons: Ring[];
  affectedIds: string[];
}

interface BulkMember {
  id: string;
  kind: ArchitectureObjectKind;
  source: { kind: ArchitectureObjectKind; source: PersistentBuildingSource | PersistentPlaceSource } | null;
  planTarget: ArchitecturePlanTarget | null;
  override: ArchitectureOverrideSource | null;
}


function patchValueProblems(kind: ArchitectureObjectKind, patch: ArchitectureSourcePatch): string[] {
  const problems: string[] = [];
  if (kind === "building") {
    const grammarKnown = patch.grammarId !== undefined && (BUILDING_GRAMMAR_IDS as readonly string[]).includes(patch.grammarId);
    if (hasOwn(patch, "grammarId") && !grammarKnown) {
      problems.push(`Unknown building grammar "${String(patch.grammarId)}".`);
    }
    const useKnown = patch.visualUse !== undefined && (BUILDING_USE_IDS as readonly string[]).includes(patch.visualUse);
    if (hasOwn(patch, "visualUse") && !useKnown) {
      problems.push(`Unknown building visual use "${String(patch.visualUse)}".`);
    }
    if (grammarKnown && useKnown) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(patch.grammarId as BuildingGrammarId);
      if (grammar !== undefined && !grammar.compatibleUses.includes(patch.visualUse as BuildingUseId)) {
        problems.push(`Building grammar "${patch.grammarId}" does not support visual use "${patch.visualUse}".`);
      }
    }
    if (hasOwn(patch, "heightM") && !(typeof patch.heightM === "number" && Number.isFinite(patch.heightM) && patch.heightM > 0)) {
      problems.push(`heightM must be finite and positive, received ${String(patch.heightM)}.`);
    }
  } else {
    if (hasOwn(patch, "landmarkGrammarId") && !(LANDMARK_GRAMMAR_IDS as readonly string[]).includes(patch.landmarkGrammarId as LandmarkGrammarId)) {
      problems.push(`Unknown landmark grammar "${String(patch.landmarkGrammarId)}".`);
    }
  }
  if (hasOwn(patch, "paletteId") && patch.paletteId !== null
    && (!(typeof patch.paletteId === "string") || !(DISTRICT_PALETTE_IDS as readonly string[]).includes(patch.paletteId))) {
    problems.push(`paletteId must be a known palette id or null, received ${String(patch.paletteId)}.`);
  }
  return problems;
}

function memberLocked(member: BulkMember): boolean {
  return member.source?.source.protection === "explicit"
    || member.planTarget?.plan.protection === "explicit"
    || member.override?.protection === "explicit";
}

function memberSitePolygon(member: BulkMember): Ring {
  if (member.source !== null) return member.source.source.sitePolygon;
  if (member.planTarget !== null) return member.planTarget.plan.sitePolygon;
  throw new Error(`Architecture object "${member.id}" has no site polygon.`);
}

function isSubstantialEdit(kind: ArchitectureObjectKind, patch: ArchitectureSourcePatch): boolean {
  return kind === "building"
    ? hasOwn(patch, "grammarId") || hasOwn(patch, "visualUse") || hasOwn(patch, "heightM")
    : hasOwn(patch, "landmarkGrammarId");
}

/**
 * Narrows a validated patch to the fields legal for this member kind. Key
 * presence is preserved (`hasOwn`), so a present-but-null paletteId keeps
 * clearing the palette exactly like the singular edit spread.
 */
function kindPatchFields(kind: ArchitectureObjectKind, patch: ArchitectureSourcePatch): ArchitectureSourcePatch {
  const fields: ArchitectureSourcePatch = {};
  if (kind === "building") {
    if (hasOwn(patch, "grammarId")) fields.grammarId = patch.grammarId;
    if (hasOwn(patch, "visualUse")) fields.visualUse = patch.visualUse;
    if (hasOwn(patch, "heightM")) fields.heightM = patch.heightM;
  } else if (hasOwn(patch, "landmarkGrammarId")) {
    fields.landmarkGrammarId = patch.landmarkGrammarId;
  }
  if (hasOwn(patch, "paletteId")) fields.paletteId = patch.paletteId;
  return fields;
}

function promoteDerived(
  architecture: ArchitectureSource,
  member: BulkMember,
  patch: ArchitectureSourcePatch
): ArchitectureSource {
  const planTarget = member.planTarget!;
  const promoted = promotedArchitectureSource(planTarget, patch);
  const withRecord = member.kind === "building"
    ? { ...architecture, buildings: [...architecture.buildings, promoted as PersistentBuildingSource] }
    : { ...architecture, places: [...architecture.places, promoted as PersistentPlaceSource] };
  // Promotion consumes the matching override: the promoted record already
  // carries the override's appearance/palette through the plan fields.
  return removeArchitectureOverride(withRecord, member.kind, member.id);
}

export function buildBulkArchitectureCandidate(
  source: CitySourceV5,
  plan: CompleteCityPlan,
  ids: readonly string[],
  operation: BulkArchitectureOperation
): BulkArchitectureCandidate {
  const blockers: BulkArchitectureBlocker[] = [];

  if (ids.length === 0) {
    blockers.push({ id: "selection", kind: "selection", reason: "Select at least one architecture object." });
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      blockers.push({ id: String(id), kind: "selection", reason: "Selection identifiers must be non-empty text." });
      continue;
    }
    if (seen.has(id)) {
      blockers.push({ id, kind: "selection", reason: `Bulk selection contains duplicate id "${id}".` });
      continue;
    }
    seen.add(id);
  }

  const members: BulkMember[] = [];
  const kinds = new Set<ArchitectureObjectKind>();
  for (const id of seen) {
    const sourceTarget = architectureSourceTarget(source.architecture, id);
    const planTarget = architecturePlanTarget(plan, id);
    if (sourceTarget === null && planTarget === null) {
      blockers.push({ id, kind: "unknown", reason: `Unknown architecture object "${id}".` });
      continue;
    }
    const kind = sourceTarget?.kind ?? planTarget!.kind;
    kinds.add(kind);
    const override = source.architecture.overrides.find(
      (candidate) => candidate.targetKind === kind && candidate.targetId === id
    ) ?? null;
    members.push({ id, kind, source: sourceTarget, planTarget, override });
  }
  if (kinds.size > 1) {
    const [first, second] = [...kinds].sort();
    blockers.push({
      id: "selection",
      kind: "selection",
      reason: `Bulk selection must contain objects of a single type; found ${first} and ${second} objects.`
    });
  }

  if (operation.kind === "delete") {
    for (const member of members) {
      if (member.source === null) {
        blockers.push({ id: member.id, kind: member.kind, reason: "Derived architecture objects cannot be deleted." });
        continue;
      }
      if (member.source.source.protection === "explicit") {
        blockers.push({ id: member.id, kind: member.kind, reason: "The architecture object is locked." });
      }
    }
  } else if (operation.kind === "edit") {
    for (const member of members) {
      for (const problem of validateArchitectureObjectPatch(member.kind, operation.patch)) {
        blockers.push({ id: member.id, kind: member.kind, reason: problem });
      }
      for (const problem of patchValueProblems(member.kind, operation.patch)) {
        blockers.push({ id: member.id, kind: member.kind, reason: problem });
      }
      if (memberLocked(member)) {
        blockers.push({ id: member.id, kind: member.kind, reason: "The architecture object is locked." });
      }
      if (member.source === null && isSubstantialEdit(member.kind, operation.patch)
        && member.planTarget?.plan.placement === undefined) {
        blockers.push({
          id: member.id,
          kind: member.kind,
          reason: `Derived architecture object "${member.id}" has no placement frame and cannot be promoted.`
        });
      }
    }
  }

  if (blockers.length > 0) throw new BulkArchitectureError(blockers);

  let architecture: ArchitectureSource = source.architecture;
  const sitePolygons: Ring[] = [];
  const affectedIds: string[] = [];
  for (const member of members) {
    sitePolygons.push(memberSitePolygon(member));
    affectedIds.push(member.id);
    if (operation.kind === "lock") {
      const protection: ArchitectureProtection = operation.locked ? "explicit" : "none";
      if (member.source !== null) {
        const id = member.id;
        architecture = member.kind === "building"
          ? { ...architecture, buildings: architecture.buildings.map((building) => building.id === id ? { ...building, protection } : building) }
          : { ...architecture, places: architecture.places.map((place) => place.id === id ? { ...place, protection } : place) };
      } else {
        // Lock and unlock are both permissible explicit transitions; unlocking
        // a protected derived override keeps the override record at "none"
        // rather than deleting it, matching the singular lock path.
        architecture = replaceArchitectureOverride(
          architecture,
          architectureOverrideFor(architecture, member.planTarget!, protection)
        );
      }
    } else if (operation.kind === "edit") {
      const patch = kindPatchFields(member.kind, operation.patch);
      if (member.source !== null) {
        const id = member.id;
        architecture = member.kind === "building"
          ? { ...architecture, buildings: architecture.buildings.map((building) => building.id === id ? { ...building, ...patch, protection: manualEditProtection(building.protection) } : building) }
          : { ...architecture, places: architecture.places.map((place) => place.id === id ? { ...place, ...patch, protection: manualEditProtection(place.protection) } : place) };
      } else if (isSubstantialEdit(member.kind, operation.patch)) {
        architecture = promoteDerived(architecture, member, patch);
      } else {
        // Palette-only edits to derived objects stay as protected sparse
        // overrides instead of promoting a persistent record.
        architecture = replaceArchitectureOverride(
          architecture,
          architectureOverrideFor(architecture, member.planTarget!, "manual-edit", { paletteId: patch.paletteId })
        );
      }
    } else {
      architecture = removeArchitectureOverride(
        member.kind === "building"
          ? { ...architecture, buildings: architecture.buildings.filter((building) => building.id !== member.id) }
          : { ...architecture, places: architecture.places.filter((place) => place.id !== member.id) },
        member.kind,
        member.id
      );
    }
  }

  return { architecture, sitePolygons, affectedIds };
}

