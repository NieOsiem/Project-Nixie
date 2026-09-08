import { difference, isSnapNoise, ringAsMulti, union } from "../geom/boolean.js";
import { ringCentroid, type MultiPolygon, type Ring } from "../geom/types.js";
import {
  architecturePlanTarget,
  promotedArchitectureSource,
  type ArchitecturePlanTarget
} from "./architecture-edit.js";
import { withRegenerationSeed, type RegenerationTarget } from "./regeneration.js";
import type {
  ArchitectureOrigin,
  ArchitectureOverrideSource,
  ArchitectureProtection,
  CitySourceV5,
  PersistentBuildingSource,
  PersistentPlaceSource
} from "./city.js";
import type { BuildingPlan, CompleteCityPlan, LandmarkPlan } from "./complete-city-plan.js";
import type { DistrictBlockFragment } from "./district-plan.js";

/**
 * Pure Phase 6 regeneration semantics: target scope resolution at fragment level,
 * architecture membership (association preferred, centroid fallback only for absent
 * or stale associations), and the all-blockers preflight that produces a safe
 * candidate source. No generation happens here — the candidate only applies
 * persistent-state surgery (removals, override promotions, override cleanup) plus
 * the new partial-seed record via `withRegenerationSeed`.
 */

export type RegenerationBlockerKind = "target" | "seed" | "building" | "place" | "override";

export interface RegenerationBlocker {
  id: string;
  kind: RegenerationBlockerKind;
  reason: string;
}

export interface RegenerationTargetScope {
  target: RegenerationTarget;
  /** Every fragment the target selects: a district target takes its own fragments, a block target all fragments of its blocks. */
  fragments: DistrictBlockFragment[];
  /** Union of the fragments' buildable polygons — the ownership envelope for centroid fallback and UI previews. */
  scopePolygon: MultiPolygon;
}

export type RegenerationMemberOrigin = "persistent" | "derived";

export interface RegenerationMember {
  id: string;
  kind: "building" | "place";
  origin: RegenerationMemberOrigin;
  protection: ArchitectureProtection;
  sitePolygon: Ring;
  /** How membership was decided: stable plan association, or site-centroid fallback. */
  via: "association" | "centroid";
}

export interface RegenerationPreflight {
  target: RegenerationTarget;
  blockers: RegenerationBlocker[];
  /** Protected content that survives: retained persistent records plus promoted protected overrides. */
  retainedIds: string[];
  /** One procedural exclusion envelope per retained protected record (§24.5). */
  excludedSitePolygons: Ring[];
  /** Unprotected persistent target-owned records removed regardless of authored or promoted origin. */
  removedIds: string[];
  /** The source with removals, promotions, and the new partial-seed record applied; null while any blocker exists. */
  candidateSource: CitySourceV5 | null;
}

function ringContainsPoint(ring: Ring, point: { x: number; y: number }): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const crosses = a.y > point.y !== b.y > point.y
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function multiPolygonContainsPoint(multi: MultiPolygon, point: { x: number; y: number }): boolean {
  return multi.some((polygon) => ringContainsPoint(polygon[0]!, point));
}

/**
 * Resolves the fragment-level scope of a regeneration target against the current plan.
 * Returns null when the target is structurally unusable: a district target must name
 * exactly one existing district, a block target at least one existing block lineage.
 */
export function resolveRegenerationTargetScope(plan: CompleteCityPlan, target: RegenerationTarget): RegenerationTargetScope | null {
  if (target.kind === "district") {
    if (target.ids.length !== 1) return null;
    const districtId = target.ids[0]!;
    const fragments = plan.districtPlan.blocks
      .flatMap((block) => block.districtFragments)
      .filter((fragment) => fragment.districtId === districtId);
    if (fragments.length === 0) return null;
    return {
      target: { kind: "district", ids: [districtId] },
      fragments,
      scopePolygon: union(fragments.map((fragment) => fragment.buildable))
    };
  }
  const ids = [...new Set(target.ids)].sort();
  if (ids.length === 0) return null;
  const selected = new Set(ids);
  const blocks = plan.districtPlan.blocks.filter((block) => selected.has(block.id));
  if (blocks.length !== selected.size) return null;
  const fragments = blocks.flatMap((block) => block.districtFragments);
  if (fragments.length === 0) return null;
  return {
    target: { kind: "block", ids },
    fragments,
    scopePolygon: union(fragments.map((fragment) => fragment.buildable))
  };
}

/**
 * Classifies architecture membership for a resolved scope. Stable plan associations
 * decide membership whenever they are present and valid; the site-centroid fallback
 * is authored-provenance semantics: an authored persistent record whose relevant
 * association is absent or stale falls back to site ownership, while generated-origin
 * records (including promoted generated source records) and derived plan objects
 * never do — a valid association pointing outside the target never pulls its object
 * in either way. The adapter must assign valid associations when it manually
 * transforms (promotes) generated records, so future regeneration can target them
 * by association instead of proximity.
 */
export function resolveRegenerationMemberships(
  source: CitySourceV5,
  plan: CompleteCityPlan,
  scope: RegenerationTargetScope
): RegenerationMember[] {
  const validBlocks = new Set(plan.districtPlan.blocks.map((block) => block.id));
  const validDistricts = new Set(source.districts.map((district) => district.id));
  const scopeBlockIds = new Set(scope.fragments.map((fragment) => fragment.blockId));
  const scopeDistrictIds = new Set(scope.fragments.flatMap((fragment) => fragment.districtId === null ? [] : [fragment.districtId]));
  const targetIds = scope.target.ids;
  const members: RegenerationMember[] = [];

  const consider = (
    id: string,
    kind: "building" | "place",
    origin: RegenerationMemberOrigin,
    provenance: ArchitectureOrigin,
    protection: ArchitectureProtection,
    sitePolygon: Ring,
    primaryAssociation: string | null,
    primaryValid: ReadonlySet<string>,
    secondaryAssociation: string | null,
    secondaryValid: ReadonlySet<string>,
    secondaryInScope: (association: string) => boolean
  ): void => {
    if (primaryAssociation !== null && primaryValid.has(primaryAssociation)) {
      if (!targetIds.includes(primaryAssociation)) return;
      members.push({ id, kind, origin, protection, sitePolygon, via: "association" });
      return;
    }
    // Absent or stale primary association: a valid secondary association outside the
    // target still excludes the record — nearby content of another target is never pulled in.
    if (secondaryAssociation !== null && secondaryValid.has(secondaryAssociation) && !secondaryInScope(secondaryAssociation)) return;
    // Centroid fallback is authored-provenance semantics: generated-origin records
    // (including promoted generated source records) and derived objects always carry
    // lineage associations, so absent or stale lineage keeps them out instead of
    // proximity rescuing them. `origin` here is the storage category
    // ("persistent" | "derived"), NOT source provenance — the `provenance` argument
    // carries the record's actual "generated" | "authored" origin.
    if (provenance !== "authored") return;
    if (!multiPolygonContainsPoint(scope.scopePolygon, ringCentroid(sitePolygon))) return;
    members.push({ id, kind, origin, protection, sitePolygon, via: "centroid" });
  };

  for (const building of source.architecture.buildings) {
    if (scope.target.kind === "block") {
      consider(building.id, "building", "persistent", building.origin, building.protection, building.sitePolygon,
        building.blockId, validBlocks, building.districtId, validDistricts, (districtId) => scopeDistrictIds.has(districtId));
    } else {
      consider(building.id, "building", "persistent", building.origin, building.protection, building.sitePolygon,
        building.districtId, validDistricts, building.blockId, validBlocks, (blockId) => scopeBlockIds.has(blockId));
    }
  }
  for (const place of source.architecture.places) {
    if (scope.target.kind === "block") {
      consider(place.id, "place", "persistent", place.origin, place.protection, place.sitePolygon,
        place.blockId, validBlocks, place.districtId, validDistricts, (districtId) => scopeDistrictIds.has(districtId));
    } else {
      consider(place.id, "place", "persistent", place.origin, place.protection, place.sitePolygon,
        place.districtId, validDistricts, place.blockId, validBlocks, (blockId) => scopeBlockIds.has(blockId));
    }
  }

  const derivedProtection = (planObject: BuildingPlan | LandmarkPlan, targetKind: "building" | "place"): ArchitectureProtection => {
    const override = source.architecture.overrides.find(
      (candidate) => candidate.targetKind === targetKind && candidate.targetId === planObject.id
    );
    return override?.protection ?? planObject.protection ?? "none";
  };
  for (const building of plan.buildings) {
    if (building.sourceId !== null) continue; // persistent records are classified above
    if (scope.target.kind === "block") {
      consider(building.id, "building", "derived", "generated", derivedProtection(building, "building"), building.sitePolygon,
        building.blockId, validBlocks, building.districtId, validDistricts, (districtId) => scopeDistrictIds.has(districtId));
    } else {
      consider(building.id, "building", "derived", "generated", derivedProtection(building, "building"), building.sitePolygon,
        building.districtId, validDistricts, building.blockId, validBlocks, (blockId) => scopeBlockIds.has(blockId));
    }
  }
  for (const landmark of plan.landmarks) {
    if ((landmark.sourceId ?? null) !== null) continue;
    if (scope.target.kind === "block") {
      consider(landmark.id, "place", "derived", "generated", derivedProtection(landmark, "place"), landmark.sitePolygon,
        landmark.blockId, validBlocks, landmark.districtId, validDistricts, (districtId) => scopeDistrictIds.has(districtId));
    } else {
      consider(landmark.id, "place", "derived", "generated", derivedProtection(landmark, "place"), landmark.sitePolygon,
        landmark.districtId, validDistricts, landmark.blockId, validBlocks, (blockId) => scopeBlockIds.has(blockId));
    }
  }
  return members;
}

/**
 * Enumerates every blocker for the requested regeneration and, when none exist,
 * produces the candidate source: unprotected persistent target records removed with
 * their overrides, protected target overrides promoted to exact persistent snapshots
 * through the shared Phase 5 promotion helper, protected persistent records retained
 * unchanged with their site polygons reserved, and the new partial-seed record
 * written. No generation and no plan mutation happen here.
 */
export function evaluateRegenerationPreflight(
  source: CitySourceV5,
  plan: CompleteCityPlan,
  target: RegenerationTarget,
  seed: string
): RegenerationPreflight {
  const blockers: RegenerationBlocker[] = [];
  const rawIds: unknown[] = Array.isArray(target?.ids) ? target.ids : [];
  const targetKind = target?.kind;
  if (targetKind !== "district" && targetKind !== "block") {
    blockers.push({ id: "target", kind: "target", reason: "The regeneration target kind must be \"district\" or \"block\"." });
  } else {
    const ids = rawIds;
    if (targetKind === "district" && ids.length !== 1) {
      blockers.push({ id: "target", kind: "target", reason: "A district regeneration must select exactly one district." });
    }
    if (ids.length === 0) {
      blockers.push({ id: "target", kind: "target", reason: "Select at least one complete block to regenerate." });
    }
    for (const id of ids) {
      if (typeof id !== "string" || id.trim().length === 0) {
        blockers.push({ id: String(id), kind: "target", reason: "Target identifiers must be non-empty text." });
      }
    }
    if (targetKind === "district" && ids.length === 1 && typeof ids[0] === "string") {
      const districtId = ids[0]!;
      if (!source.districts.some((district) => district.id === districtId)) {
        blockers.push({ id: districtId, kind: "target", reason: `District "${districtId}" does not exist in the city source.` });
      }
    }
    if (targetKind === "block") {
      const knownBlocks = new Set(plan.districtPlan.blocks.map((block) => block.id));
      for (const id of new Set(ids)) {
        if (typeof id === "string" && id.trim().length > 0 && !knownBlocks.has(id)) {
          blockers.push({ id, kind: "target", reason: `Block "${id}" does not exist in the current plan.` });
        }
      }
    }
  }
  if (typeof seed !== "string" || seed.length === 0 || seed.trim() !== seed) {
    blockers.push({ id: "seed", kind: "seed", reason: "The regeneration seed must be non-empty text without leading or trailing whitespace." });
  }

  const targetHasBlockers = blockers.some((blocker) => blocker.kind === "target");
  const scope = targetHasBlockers ? null : resolveRegenerationTargetScope(plan, target);
  if (scope === null && !targetHasBlockers) {
    blockers.push({ id: String(rawIds[0] ?? "target"), kind: "target", reason: "The target resolves to no buildable area in the current plan." });
  }

  const memberships = scope === null ? [] : resolveRegenerationMemberships(source, plan, scope);
  const persistentMembers = memberships.filter((member) => member.origin === "persistent");
  const derivedMembers = memberships.filter((member) => member.origin === "derived");
  const removedIds = persistentMembers.filter((member) => member.protection === "none").map((member) => member.id);
  const retainedMembers = persistentMembers.filter((member) => member.protection !== "none");
  const retainedIds = retainedMembers.map((member) => member.id);
  const excludedSitePolygons = retainedMembers.map((member) => member.sitePolygon);

  // Override pass: protected target overrides are promoted only after their snapshot site
  // polygon is verified against the derived object under the shared snap-noise gate,
  // unprotected target overrides die with the regenerated content, out-of-target overrides
  // are retained untouched, and a protected override whose derived object or lineage no
  // longer matches is a blocker — retention cannot be verified, and it is never
  // blanket-promoted just to avoid the orphan. Stale unprotected overrides are cleanup,
  // not blockers: they are dropped so ordinary regeneration proceeds.
  const promotedRecords: (PersistentBuildingSource | PersistentPlaceSource)[] = [];
  const survivingOverrides: ArchitectureOverrideSource[] = [];
  if (scope !== null) {
    for (const override of source.architecture.overrides) {
      const planTarget: ArchitecturePlanTarget | null = architecturePlanTarget(plan, override.targetId);
      // Strict lineage contract: both lineages must be present and identical; neither
      // an undefined plan lineage nor an empty override lineage acts as a wildcard.
      const lineageMatches = planTarget !== null
        && planTarget.kind === override.targetKind
        && planTarget.plan.lineage !== undefined
        && planTarget.plan.lineage === override.lineage;
      if (!lineageMatches) {
        if (override.protection !== "none") {
          blockers.push({
            id: `${override.targetKind}:${override.targetId}`,
            kind: "override",
            reason: `The protected ${override.targetKind} override for "${override.targetId}" no longer matches any derived object; its retention cannot be verified.`
          });
        }
        continue;
      }
      const member = derivedMembers.find((candidate) => candidate.id === planTarget!.plan.id);
      if (member === undefined) {
        survivingOverrides.push(structuredClone(override));
        continue;
      }
      if (override.protection === "none") continue;
      const placement = planTarget!.plan.placement;
      if (placement === undefined) {
        blockers.push({
          id: planTarget!.plan.id,
          kind: planTarget!.kind,
          reason: `The protected override for "${planTarget!.plan.id}" cannot be promoted: the derived object has no placement frame.`
        });
        continue;
      }
      // The snapshot must be canonically equivalent to the current derived site: the
      // shared snap-noise gate decides — mutual boolean difference is snap noise in
      // both directions — never an area or vertex guess.
      let snapshotMatches: boolean;
      try {
        snapshotMatches = isSnapNoise(difference(ringAsMulti(override.snapshotSitePolygon), [ringAsMulti(planTarget!.plan.sitePolygon)]))
          && isSnapNoise(difference(ringAsMulti(planTarget!.plan.sitePolygon), [ringAsMulti(override.snapshotSitePolygon)]));
      } catch {
        snapshotMatches = false;
      }
      if (!snapshotMatches) {
        blockers.push({
          id: planTarget!.plan.id,
          kind: planTarget!.kind,
          reason: `The protected override for "${planTarget!.plan.id}" cannot be promoted: its snapshot site polygon no longer matches the derived object's site.`
        });
        continue;
      }
      const promoted = promotedArchitectureSource(
        planTarget!,
        {
          ...(override.appearanceSeed === undefined ? {} : { appearanceSeed: override.appearanceSeed }),
          ...(override.paletteId === undefined ? {} : { paletteId: override.paletteId })
        },
        placement,
        override.snapshotSitePolygon,
        false,
        override.protection
      );
      promotedRecords.push(promoted);
      retainedIds.push(planTarget!.plan.id);
      excludedSitePolygons.push(promoted.sitePolygon);
    }
  }

  // Compound scope (§16.5): an unprotected place in the target is replaced as one unit,
  // so independently protected objects inside its site make the whole action impossible.
  // Every protected source object counts — including records associated outside the
  // target — plus promoted protected overrides. Protection is never inherited and the
  // compound's own lock state does not extend.
  const protectedObjects: { id: string; kind: "building" | "place"; sitePolygon: Ring }[] = [
    ...source.architecture.buildings.filter((record) => record.protection !== "none").map((record) => ({ id: record.id, kind: "building" as const, sitePolygon: record.sitePolygon })),
    ...source.architecture.places.filter((record) => record.protection !== "none").map((record) => ({ id: record.id, kind: "place" as const, sitePolygon: record.sitePolygon })),
    ...promotedRecords.map((record) => ({
      id: record.id,
      kind: "grammarId" in record ? "building" as const : "place" as const,
      sitePolygon: record.sitePolygon
    }))
  ];
  for (const member of memberships) {
    if (member.kind !== "place" || member.protection !== "none") continue;
    for (const insider of protectedObjects) {
      if (insider.id === member.id) continue;
      if (ringContainsPoint(member.sitePolygon, ringCentroid(insider.sitePolygon))) {
        blockers.push({
          id: insider.id,
          kind: insider.kind,
          reason: `Independently protected ${insider.kind} "${insider.id}" lies inside the site of place "${member.id}", which regeneration replaces as one unit; unlock or move it before regenerating.`
        });
      }
    }
  }

  if (blockers.length > 0 || scope === null) {
    const reportedTarget: RegenerationTarget = targetKind === "district" || targetKind === "block"
      ? { kind: targetKind, ids: [...rawIds] as string[] }
      : { kind: "block", ids: [] };
    return {
      target: reportedTarget,
      blockers,
      retainedIds,
      excludedSitePolygons,
      removedIds,
      candidateSource: null
    };
  }

  const removedBuildingIds = new Set(removedIds.filter((id) => source.architecture.buildings.some((building) => building.id === id)));
  const removedPlaceIds = new Set(removedIds.filter((id) => source.architecture.places.some((place) => place.id === id)));
  const promotedBuildings = promotedRecords.filter((record): record is PersistentBuildingSource => "grammarId" in record);
  const promotedPlaces = promotedRecords.filter((record): record is PersistentPlaceSource => "landmarkGrammarId" in record);
  const candidate = structuredClone(source);
  candidate.architecture = {
    buildings: [...candidate.architecture.buildings.filter((building) => !removedBuildingIds.has(building.id)), ...promotedBuildings],
    places: [...candidate.architecture.places.filter((place) => !removedPlaceIds.has(place.id)), ...promotedPlaces],
    overrides: survivingOverrides
  };
  return {
    target: scope.target,
    blockers,
    retainedIds,
    excludedSitePolygons,
    removedIds,
    candidateSource: withRegenerationSeed(candidate, scope.target, seed)
  };
}
