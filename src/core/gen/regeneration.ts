import type { CitySourceV5, RegenerationPartialSeedRecord, RegenerationTargetKind } from "./city.js";
import type { DistrictPlan } from "./district-plan.js";

/**
 * Pure partial-regeneration seed chronology for schema 5.
 *
 * Records are append-only intents keyed by (targetKind, targetId). `order` is a
 * strictly increasing positive safe integer; the newest applicable record — highest
 * `order` — deterministically wins seed precedence for a scope. Matching is strictly
 * kind+ID-isolated: identical user-entered seed text on different targets stays in
 * distinct records and never cross-applies.
 */

/** A regeneration selection: exactly one district, or one or more blocks by lineage. */
export interface RegenerationTarget {
  kind: RegenerationTargetKind;
  ids: string[];
}


function newestApplicableRecord(
  records: readonly RegenerationPartialSeedRecord[],
  kind: RegenerationTargetKind,
  targetId: string
): RegenerationPartialSeedRecord | null {
  let newest: RegenerationPartialSeedRecord | null = null;
  for (const record of records) {
    if (record.targetKind !== kind || record.targetId !== targetId) continue;
    if (newest === null || record.order >= newest.order) newest = record;
  }
  return newest;
}

/**
 * Effective planning seed base for one fragment scope.
 * Resolves the newest applicable partial-seed record for the scope: a block record
 * matching `scope.blockId` and a district record matching `scope.districtId` (when the
 * fragment is zoned) both apply, and the highest `order` wins regardless of kind, so a
 * newer district event overrides older block attempts and a later block regeneration
 * overrides again. The winning record's target identity is folded into the returned
 * seed material, keeping same-text seeds on different targets in distinct streams.
 * With no applicable record the result is exactly the gen-13 baseline material
 * (`district?.seed ?? citySeed`), so pre-regeneration cities replay unchanged.
 */
export function effectiveRegenerationSeed(
  source: CitySourceV5,
  scope: { blockId: string; districtId: string | null }
): string {
  const records = source.regeneration.partialSeeds;
  const blockRecord = newestApplicableRecord(records, "block", scope.blockId);
  const districtRecord = scope.districtId === null ? null : newestApplicableRecord(records, "district", scope.districtId);
  const winning = districtRecord === null
    ? blockRecord
    : blockRecord === null || districtRecord.order >= blockRecord.order
      ? districtRecord
      : blockRecord;
  if (winning !== null) return `${winning.seed}|${winning.targetKind}/${winning.targetId}`;
  if (scope.districtId !== null) {
    const district = source.districts.find((candidate) => candidate.id === scope.districtId);
    if (district) return district.seed;
  }
  return source.citySeed;
}

/**
 * Records a partial seed for every target id, replacing each selected (kind, id) key.
 *
 * Selected keys are re-anchored as the newest events: their records are removed from
 * their old position and re-appended with fresh orders that continue the global
 * chronology past every stored record — including the replaced keys — so a replaced
 * key's old order is never reused and array order stays in sync with the monotonic
 * order the source validator requires.
 * Older overlapping keys — block records under a district target, earlier targets of
 * other kinds — are preserved untouched; no remapping, no deletion beyond the selected
 * keys. Throws on invalid seed text, unknown target kind, empty id lists or blank ids,
 * and on district-kind ids that do not exist in `source.districts` (block lineages are
 * resolved against the built district plan by the caller, so they are accepted here).
 */
export function withRegenerationSeed(
  source: CitySourceV5,
  target: RegenerationTarget,
  seed: string
): CitySourceV5 {
  if (!(typeof seed === "string" && seed.length > 0 && seed.trim() === seed)) throw new Error("Regeneration seed must be non-empty trimmed text.");
  if (target.kind !== "district" && target.kind !== "block") throw new Error(`Unknown regeneration target kind "${String(target.kind)}".`);
  if (!Array.isArray(target.ids) || target.ids.length === 0) throw new Error("Regeneration target must select at least one id.");
  for (const id of target.ids) {
    if (!(typeof id === "string" && id.length > 0 && id.trim() === id)) throw new Error("Regeneration target ids must be non-empty trimmed text.");
  }
  if (target.kind === "district") {
    const districtIds = new Set(source.districts.map((district) => district.id));
    for (const id of target.ids) {
      if (!districtIds.has(id)) throw new Error(`Cannot record a partial seed for unknown district "${id}".`);
    }
  }
  const ids = [...new Set(target.ids)].sort((a, b) => a.localeCompare(b));
  const selected = new Set(ids);
  const preserved = source.regeneration.partialSeeds.filter((record) => !(record.targetKind === target.kind && selected.has(record.targetId)));
  let nextOrder = source.regeneration.partialSeeds.reduce((max, record) => Math.max(max, record.order), 0) + 1;
  const appended: RegenerationPartialSeedRecord[] = ids.map((id) => ({ targetKind: target.kind, targetId: id, seed, order: nextOrder++ }));
  return { ...source, regeneration: { partialSeeds: [...preserved, ...appended] } };
}

/**
 * Cleanup pass over the stored chronology: drops ONLY records whose target no longer
 * exists — district records whose id left `source.districts`, block records whose
 * `DerivedBlock.id` lineage left `districtPlan.blocks`. Survivors keep their exact
 * seeds and orders (sorted ascending by order); vanished identities are never
 * remapped onto surviving targets.
 */
export function normalizeRegenerationPartialSeedRecords(
  source: CitySourceV5,
  districtPlan: DistrictPlan
): RegenerationPartialSeedRecord[] {
  const liveDistrictIds = new Set(source.districts.map((district) => district.id));
  const liveBlockIds = new Set(districtPlan.blocks.map((block) => block.id));
  return source.regeneration.partialSeeds
    .filter((record) => record.targetKind === "district" ? liveDistrictIds.has(record.targetId) : liveBlockIds.has(record.targetId))
    .sort((a, b) => a.order - b.order);
}
