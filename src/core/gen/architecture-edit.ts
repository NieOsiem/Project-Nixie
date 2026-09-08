import type { BuildingGrammarId, BuildingUseId } from "./building-registry.js";
import type { LandmarkGrammarId } from "./landmark-registry.js";
import type {
  ArchitectureOverrideSource,
  ArchitectureProtection,
  ArchitectureSource,
  PersistentBuildingSource,
  PersistentPlaceSource,
  PlacementFrame
} from "./city.js";
import type { BuildingPlan, CompleteCityPlan, LandmarkPlan } from "./complete-city-plan.js";

/**
 * Pure architecture promotion, override, and target-lookup helpers shared by the
 * singular adapter edits and the Phase 6 regeneration semantics. No adapter state,
 * no plan building, no side effects: every function is a value-in/value-out utility
 * so regeneration preflight can reuse the exact Phase 5 promotion behaviour.
 */

/** Structural patch applied to a promotion; the adapter's ObjectPropertiesPatch is structurally identical. */
export interface ArchitectureSourcePatch {
  grammarId?: BuildingGrammarId;
  landmarkGrammarId?: LandmarkGrammarId;
  visualUse?: BuildingUseId;
  heightM?: number;
  /** Override appearance stream; absent keeps the derived plan's stream. */
  appearanceSeed?: string;
  paletteId?: string | null;
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export type ArchitecturePlanTarget =
  | { kind: "building"; plan: BuildingPlan }
  | { kind: "place"; plan: LandmarkPlan };

export function architecturePlanTarget(plan: CompleteCityPlan, id: string): ArchitecturePlanTarget | null {
  const building = plan.buildings.find((candidate) => candidate.id === id);
  if (building !== undefined) return { kind: "building", plan: building };
  const place = plan.landmarks.find((candidate) => candidate.id === id);
  return place === undefined ? null : { kind: "place", plan: place };
}

export function architectureSourceTarget(
  architecture: ArchitectureSource,
  id: string
): { kind: "building"; source: PersistentBuildingSource } | { kind: "place"; source: PersistentPlaceSource } | null {
  const building = architecture.buildings.find((candidate) => candidate.id === id);
  if (building !== undefined) return { kind: "building", source: building };
  const place = architecture.places.find((candidate) => candidate.id === id);
  return place === undefined ? null : { kind: "place", source: place };
}

/**
 * Promotes a derived plan object to a persistent source record. The optional
 * `protection` argument lets the regeneration path carry an override's explicit
 * protection into the promoted record; the Phase 5 singular-edit path keeps the
 * established `"manual-edit"` default.
 */
export function promotedArchitectureSource(
  target: ArchitecturePlanTarget,
  patch: ArchitectureSourcePatch,
  placement: PlacementFrame = target.plan.placement!,
  sitePolygon = target.plan.sitePolygon,
  clearAssociations = false,
  protection: ArchitectureProtection = "manual-edit"
): PersistentBuildingSource | PersistentPlaceSource {
  const lineage = target.plan.lineage;
  if (lineage === undefined) throw new Error("The generated architecture object has no stable lineage.");
  if (target.kind === "building") {
    const plan = target.plan;
    return {
      id: plan.id,
      lineage,
      origin: "generated",
      protection,
      seed: plan.seed,
      appearanceSeed: patch.appearanceSeed ?? plan.appearanceSeed,
      grammarId: patch.grammarId ?? plan.grammarId,
      visualUse: patch.visualUse ?? plan.visualUse,
      heightM: patch.heightM ?? plan.heightM,
      paletteId: hasOwn(patch, "paletteId") ? patch.paletteId ?? null : plan.paletteId ?? null,
      sitePolygon: structuredClone(sitePolygon),
      placement: structuredClone(placement),
      districtId: clearAssociations ? null : plan.districtId,
      blockId: clearAssociations ? null : plan.blockId
    };
  }
  const plan = target.plan;
  return {
    id: plan.id,
    lineage,
    origin: "generated",
    protection,
    seed: plan.seed,
    appearanceSeed: patch.appearanceSeed ?? plan.appearanceSeed,
    landmarkGrammarId: patch.landmarkGrammarId ?? plan.landmarkGrammarId,
    paletteId: hasOwn(patch, "paletteId") ? patch.paletteId ?? null : plan.paletteId ?? null,
    sitePolygon: structuredClone(sitePolygon),
    placement: structuredClone(placement),
    districtId: clearAssociations ? null : plan.districtId,
    blockId: clearAssociations ? null : plan.blockId
  };
}

export function replaceArchitectureOverride(
  architecture: ArchitectureSource,
  override: ArchitectureOverrideSource
): ArchitectureSource {
  const key = `${override.targetKind}:${override.targetId}`;
  return {
    ...architecture,
    overrides: [
      ...architecture.overrides.filter((candidate) => `${candidate.targetKind}:${candidate.targetId}` !== key),
      structuredClone(override)
    ]
  };
}

export function removeArchitectureOverride(architecture: ArchitectureSource, kind: "building" | "place", id: string): ArchitectureSource {
  const key = `${kind}:${id}`;
  return {
    ...architecture,
    overrides: architecture.overrides.filter((candidate) => `${candidate.targetKind}:${candidate.targetId}` !== key)
  };
}

export function architectureOverrideFor(
  architecture: ArchitectureSource,
  target: ArchitecturePlanTarget,
  protection: ArchitectureProtection,
  patch: { appearanceSeed?: string; paletteId?: string | null } = {}
): ArchitectureOverrideSource {
  const existing = architecture.overrides.find(
    (candidate) => candidate.targetKind === target.kind && candidate.targetId === target.plan.id
  );
  const effectiveProtection = existing?.protection === "explicit" && protection !== "none"
    ? "explicit"
    : protection;
  const override: ArchitectureOverrideSource = {
    ...(existing === undefined ? {} : structuredClone(existing)),
    targetKind: target.kind,
    targetId: target.plan.id,
    lineage: target.plan.lineage ?? "",
    protection: effectiveProtection,
    snapshotSitePolygon: structuredClone(target.plan.sitePolygon)
  };
  if (patch.appearanceSeed !== undefined) override.appearanceSeed = patch.appearanceSeed;
  if (patch.paletteId !== undefined) override.paletteId = patch.paletteId;
  return override;
}

export type ArchitectureObjectKind = "building" | "place";

/**
 * Field-level validation for an object-properties patch, shared verbatim by the
 * singular adapter path and the Phase 6 bulk actions. Returns every problem so
 * bulk edits can enumerate the whole selection; the singular path throws on the
 * first problem, which is `problems[0]` with identical wording. The allowed
 * field sets deliberately exclude `appearanceSeed`: appearance streams change
 * only through the dedicated reroll path, never through a properties patch.
 */
export function validateArchitectureObjectPatch(kind: ArchitectureObjectKind, patch: object): string[] {
  const problems: string[] = [];
  const keys = Object.keys(patch);
  const allowed = kind === "building"
    ? ["grammarId", "visualUse", "heightM", "paletteId"]
    : ["landmarkGrammarId", "paletteId"];
  for (const key of keys) {
    if (!allowed.includes(key)) problems.push(`Unknown ${kind} object property "${key}".`);
  }
  if (keys.length === 0) problems.push("Object property patch is empty.");
  if (kind === "building" && hasOwn(patch, "landmarkGrammarId")) {
    problems.push("Building object properties cannot include landmarkGrammarId.");
  }
  if (kind === "place" && (hasOwn(patch, "grammarId") || hasOwn(patch, "visualUse") || hasOwn(patch, "heightM"))) {
    problems.push("Place object properties cannot include building fields.");
  }
  return problems;
}

/**
 * Protection applied by manual edits to persistent records: an explicit lock is
 * preserved (locked-content rejection happens before this runs), anything else
 * becomes "manual-edit".
 */
export function manualEditProtection(protection: ArchitectureProtection): ArchitectureProtection {
  return protection === "explicit" ? "explicit" : "manual-edit";
}
