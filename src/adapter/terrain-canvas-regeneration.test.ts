import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_CITY, MODULE_ID } from "../constants.js";
import type { CityStateV5, RegenerationPartialSeedRecord } from "../core/gen/city.js";
import { chunkId, chunksCovering } from "../core/gen/chunks.js";
import { buildCompleteCityPlan } from "../core/gen/complete-city-plan.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import {
  mountPhase6Fixture,
  phase6CacheState,
  phase6MeshSignature,
  phase6Source,
  type Phase6Fixture
} from "./phase6-test-fixture.js";
// NOTE: the fixture import above must stay before this adapter import — the fixture
// module installs the city-cache/city-renderer mocks the adapter's imports resolve to.
import {
  affectedRegenerationChunkKeys,
  canRedo,
  canUndo,
  clearConfirmationFor,
  deleteDistricts,
  deleteRoads,
  generationPreflight,
  getCity,
  getDistrictPlanView,
  mount,
  preflightRegeneration,
  randomizeEntireCity,
  regenerateTargets,
  redo,
  stats,
  undo,
  unmount,
  updateDistricts,
  type RegenerationStats,
  type RegenerationTarget
} from "./terrain-canvas.js";

let fixture: Phase6Fixture;
let fixtureMounted = false;

function requireCity(): CityStateV5 {
  const city = getCity();
  if (city === null) throw new Error("the adapter has no city loaded");
  return city;
}

function requireStats(): Record<string, unknown> {
  const record = stats();
  if (record === null) throw new Error("the adapter has no city loaded");
  return record;
}

function regenStats(): RegenerationStats | null {
  const value: unknown = requireStats().regeneration;
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || !("status" in value)) throw new Error("unexpected regeneration stats shape");
  // The adapter exposes stats() as a loose Record surface; the shape was narrowed above.
  return value as RegenerationStats;
}

function undoDepth(): number {
  const value: unknown = requireStats().undoDepth;
  if (typeof value !== "number") throw new Error("unexpected undoDepth shape");
  return value;
}

/** The persisted seed chronology, grounded against the current stored Scene source. */
function persistedRecords(): RegenerationPartialSeedRecord[] {
  const stored = fixture.getStored();
  if (stored === undefined) throw new Error("the fixture has no stored city state");
  return stored.source.regeneration.partialSeeds;
}

function newestSeedRecord(kind: "block" | "district", id: string): RegenerationPartialSeedRecord {
  const matching = persistedRecords().filter((record) => record.targetKind === kind && record.targetId === id);
  const newest = matching.reduce<RegenerationPartialSeedRecord | null>(
    (best, record) => (best === null || record.order > best.order ? record : best),
    null
  );
  if (newest === null) throw new Error(`no persisted ${kind} seed record for "${id}"`);
  return newest;
}

function districtIds(): string[] {
  return requireCity().source.districts.map((district) => district.id);
}

/** A block whose zoning fragments all belong to the district, so its lineage dies with the district. */
function exclusiveBlockId(districtId: string): string {
  const view = getDistrictPlanView();
  if (view === null) throw new Error("the district plan is not published");
  const block = view.blocks.find(
    (candidate) => candidate.districtFragments.length > 0
      && candidate.districtFragments.every((fragment) => fragment.districtId === districtId)
  );
  if (block === undefined) throw new Error(`no exclusive block found for district "${districtId}"`);
  return block.id;
}

// The fixture stubs the Foundry Hooks global with a plain registry; tests dispatch
// through the same seam the adapter registered into.
interface HookRegistry {
  call(name: string, ...args: unknown[]): void;
}

function dispatchHook(name: string, ...args: unknown[]): void {
  const registry: HookRegistry | undefined = (globalThis as { Hooks?: HookRegistry }).Hooks;
  if (registry === undefined) throw new Error("the fixture did not stub the Hooks global");
  registry.call(name, ...args);
}

async function settleGeometry(revision: number): Promise<void> {
  await vi.waitFor(() => {
    expect(stats()?.completePlan).toEqual(expect.objectContaining({ revision }));
  }, { timeout: 60_000 });
  await vi.waitFor(() => {
    expect(stats()?.lastBuild).toEqual(expect.objectContaining({ full: true, stale: false }));
  }, { timeout: 60_000 });
}

describe("terrain-canvas Phase 6 regeneration pipeline", () => {
  beforeEach(async () => {
    fixture = await mountPhase6Fixture(phase6Source());
    fixtureMounted = true;
  });

  afterEach(() => {
    // Dispose only when the fixture mounted: a failed setup must surface its own
    // error instead of burying it under a teardown failure of a stale fixture.
    if (fixtureMounted) fixture.dispose();
    fixtureMounted = false;
  });

  it("commits a block regeneration as one save, one revision, and one history entry while roads and walls stay untouched", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();
    const roadsBefore = JSON.stringify(before.source.roads);
    const saves = fixture.scene.setFlag.mock.calls.length;
    const wallCreates = fixture.scene.createEmbeddedDocuments.mock.calls.length;
    const wallDeletes = fixture.scene.deleteEmbeddedDocuments.mock.calls.length;

    const result = await regenerateTargets(target, "block-seed-1");

    expect(result).toEqual(expect.objectContaining({ full: true, stale: false }));
    expect(fixture.scene.setFlag.mock.calls.length - saves).toBe(1);
    expect(requireCity().revision).toBe(before.revision + 1);
    expect(undoDepth()).toBe(1);
    expect(JSON.stringify(requireCity().source.roads)).toBe(roadsBefore);
    expect(fixture.scene.createEmbeddedDocuments.mock.calls.length - wallCreates).toBe(0);
    expect(fixture.scene.deleteEmbeddedDocuments.mock.calls.length - wallDeletes).toBe(0);
    expect(fixture.getStored()!.revision).toBe(before.revision + 1);
    expect(newestSeedRecord("block", blockId)).toEqual(expect.objectContaining({
      targetKind: "block",
      targetId: blockId,
      seed: "block-seed-1"
    }));
    expect(regenStats()).toEqual(expect.objectContaining({ status: "complete", seed: "block-seed-1" }));
  }, 120_000);

  it("commits a district regeneration the same way and scopes the chunk rebuild to the target", async () => {
    const districtId = districtIds()[0]!;
    const target: RegenerationTarget = { kind: "district", ids: [districtId] };
    const before = requireCity();
    const roadsBefore = JSON.stringify(before.source.roads);
    const saves = fixture.scene.setFlag.mock.calls.length;
    const wallCreates = fixture.scene.createEmbeddedDocuments.mock.calls.length;
    const wallDeletes = fixture.scene.deleteEmbeddedDocuments.mock.calls.length;
    const fullCoverage = new Set(fixture.renderer.sets).size;

    const result = await regenerateTargets(target, "district-seed-1");

    const requested = fixture.worker.chunkRequests.at(-1)!;
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThan(fullCoverage);
    expect(result.chunks).toBe(requested.length);
    expect(fixture.scene.setFlag.mock.calls.length - saves).toBe(1);
    expect(requireCity().revision).toBe(before.revision + 1);
    expect(undoDepth()).toBe(1);
    expect(JSON.stringify(requireCity().source.roads)).toBe(roadsBefore);
    expect(fixture.scene.createEmbeddedDocuments.mock.calls.length - wallCreates).toBe(0);
    expect(fixture.scene.deleteEmbeddedDocuments.mock.calls.length - wallDeletes).toBe(0);
    expect(newestSeedRecord("district", districtId)).toEqual(expect.objectContaining({
      targetKind: "district",
      targetId: districtId,
      seed: "district-seed-1"
    }));
  }, 120_000);

  it("generates and persists a fresh seed on every null-seed reroll instead of replaying the chronology", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();

    await regenerateTargets(target, null);

    const firstSeed = regenStats()!.seed;
    expect(typeof firstSeed).toBe("string");
    expect(firstSeed!.length).toBeGreaterThan(0);
    expect(firstSeed!.trim()).toBe(firstSeed);
    const firstRecord = newestSeedRecord("block", blockId);
    expect(firstRecord.seed).toBe(firstSeed);

    await regenerateTargets(target, null);

    const secondRecord = newestSeedRecord("block", blockId);
    expect(secondRecord.seed).not.toBe(firstRecord.seed);
    expect(secondRecord.order).toBeGreaterThan(firstRecord.order);
    expect(persistedRecords().filter((record) => record.targetKind === "block" && record.targetId === blockId)).toHaveLength(1);
    expect(fixture.getStored()!.revision).toBe(before.revision + 2);
    expect(regenStats()!.seed).toBe(secondRecord.seed);
  }, 120_000);

  it("replays identical geometry for an explicit seed after unmount and remount", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };

    await regenerateTargets(target, "replay-seed");
    const firstInstalled = new Set(fixture.worker.chunkRequests.at(-1)!);
    expect(firstInstalled.size).toBeGreaterThan(0);
    const firstSignatures = new Map<string, string>();
    for (const id of firstInstalled) {
      const geometry = fixture.renderer.latest.get(id);
      if (geometry !== undefined) firstSignatures.set(id, phase6MeshSignature(geometry));
    }
    expect(firstSignatures.size).toBe(firstInstalled.size);

    unmount();
    mount();
    await settleGeometry(requireCity().revision);

    await regenerateTargets(target, "replay-seed");

    const secondInstalled = new Set(fixture.worker.chunkRequests.at(-1)!);
    expect(secondInstalled).toEqual(firstInstalled);
    for (const id of secondInstalled) {
      const replayed = fixture.renderer.latest.get(id);
      expect(replayed).toBeDefined();
      expect(phase6MeshSignature(replayed!)).toBe(firstSignatures.get(id));
    }
  }, 120_000);

  it("rejects every regeneration blocker before the Worker plans anything", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const validTarget: RegenerationTarget = { kind: "block", ids: [blockId] };
    const missingTarget: RegenerationTarget = { kind: "block", ids: ["block_missing"] };
    const emptyTarget: RegenerationTarget = { kind: "block", ids: [] };
    const before = requireCity();
    const planBuilds = fixture.worker.planBuilds;
    const chunkBuilds = fixture.worker.chunkBuilds;
    const saves = fixture.scene.setFlag.mock.calls.length;

    const padded = await preflightRegeneration(validTarget, "  padded  ");
    expect(padded.candidateSource).toBeNull();
    expect(padded.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "seed" })]));

    await expect(preflightRegeneration(missingTarget, "seed")).resolves.toEqual(expect.objectContaining({
      blockers: expect.arrayContaining([expect.objectContaining({ kind: "target" })]),
      candidateSource: null
    }));
    await expect(regenerateTargets(missingTarget, "seed")).rejects.toThrow(/Regeneration blocked/);
    await expect(regenerateTargets(emptyTarget, "seed")).rejects.toThrow(/Regeneration blocked/);
    await expect(regenerateTargets(validTarget, "  padded  ")).rejects.toThrow(/Regeneration blocked/);

    expect(fixture.worker.planBuilds).toBe(planBuilds);
    expect(fixture.worker.chunkBuilds).toBe(chunkBuilds);
    expect(fixture.scene.setFlag.mock.calls.length).toBe(saves);
    expect(requireCity()).toEqual(before);
  }, 120_000);

  it("rejects a stale expectedRevision before claiming, planning, or saving", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();
    const planBuilds = fixture.worker.planBuilds;
    const saves = fixture.scene.setFlag.mock.calls.length;

    await expect(regenerateTargets(target, "stale-seed", before.revision - 1)).rejects.toThrow(/superseded by a newer city revision/);
    await expect(regenerateTargets(target, "future-seed", before.revision + 7)).rejects.toThrow(/superseded by a newer city revision/);

    expect(fixture.worker.planBuilds).toBe(planBuilds);
    expect(fixture.scene.setFlag.mock.calls.length).toBe(saves);
    expect(requireCity()).toEqual(before);
  }, 120_000);

  it("leaves source, history, and cache untouched when a delayed plan loses the epoch race", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();
    const saves = fixture.scene.setFlag.mock.calls.length;
    const depth = undoDepth();
    const clearsBefore = fixture.renderer.clears;

    fixture.worker.delayNextPlan();
    const pending = regenerateTargets(target, "race-seed");
    await fixture.worker.whenPlanDelayed();

    // A Scene bounds change bumps the render epoch without touching the city flag.
    dispatchHook("updateScene", fixture.scene, { padding: 0.5 });
    fixture.worker.releasePlan();

    await expect(pending).rejects.toThrow(/superseded by a newer city revision; nothing changed/);
    expect(regenStats()).toEqual(expect.objectContaining({ status: "stale", seed: "race-seed" }));
    expect(fixture.scene.setFlag.mock.calls.length).toBe(saves);
    expect(undoDepth()).toBe(depth);
    // The aborted regeneration neither installs nor wipes: scoped installs never clear,
    // and the abort happens before the install step entirely.
    expect(fixture.renderer.clears).toBe(clearsBefore);
    for (const call of phase6CacheState.publish.mock.calls) {
      expect(call[0].revision).toBe(before.revision);
    }
    for (const call of phase6CacheState.publishChunks.mock.calls) {
      expect(call[0].revision).toBe(before.revision);
    }
  }, 120_000);

  it("commits nothing when an external Scene revision races the delayed plan", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();
    const saves = fixture.scene.setFlag.mock.calls.length;

    fixture.worker.delayNextPlan();
    const pending = regenerateTargets(target, "race-seed");
    await fixture.worker.whenPlanDelayed();

    const external: CityStateV5 = { ...before, revision: before.revision + 5, source: structuredClone(before.source) };
    fixture.setStored(external);
    dispatchHook("updateScene", fixture.scene, { flags: { [MODULE_ID]: { [FLAG_CITY]: external } } });

    // The external adoption terminated the in-flight build; the parked response is inert.
    await expect(pending).rejects.toThrow(/worker terminated/);
    fixture.worker.releasePlan();

    expect(getCity()).toEqual(external);
    expect(fixture.scene.setFlag.mock.calls.length).toBe(saves);
    expect(regenStats()).toEqual(expect.objectContaining({ status: "failed", seed: "race-seed" }));
    for (const call of [...phase6CacheState.publish.mock.calls, ...phase6CacheState.publishChunks.mock.calls]) {
      expect(call[0].revision).not.toBe(before.revision + 1);
    }
  }, 120_000);

  it("drops the deleted district's seed record while road-defined blocks and their seeds survive", async () => {
    const ids = districtIds();
    const doomedId = ids[0]!;
    const survivorId = ids[1]!;
    const doomedBlockId = exclusiveBlockId(doomedId);
    const survivorBlockId = exclusiveBlockId(survivorId);

    await regenerateTargets({ kind: "block", ids: [doomedBlockId] }, "doomed-block-seed");
    await regenerateTargets({ kind: "district", ids: [doomedId] }, "doomed-district-seed");
    await regenerateTargets({ kind: "block", ids: [survivorBlockId] }, "kept-block-seed");
    expect(newestSeedRecord("block", doomedBlockId).seed).toBe("doomed-block-seed");

    const before = requireCity();
    const planBuilds = fixture.worker.planBuilds;
    const saves = fixture.scene.setFlag.mock.calls.length;

    await deleteDistricts([doomedId]);

    expect(fixture.scene.setFlag.mock.calls.length - saves).toBe(1);
    expect(requireCity().revision).toBe(before.revision + 1);
    // The cleanup rides the topology commit's own Worker plan build, not a follow-up commit.
    expect(fixture.worker.planBuilds).toBeGreaterThan(planBuilds);
    const stored = fixture.getStored()!;
    expect(stored.revision).toBe(before.revision + 1);
    expect(stored.source.districts.some((district) => district.id === doomedId)).toBe(false);
    // Blocks are faces of the road network, not district lineage: deleting a district
    // leaves every block live, so its seed record survives untouched.
    const liveBlockIds = new Set(getDistrictPlanView()!.blocks.map((block) => block.id));
    expect(liveBlockIds.has(doomedBlockId)).toBe(true);
    const records = stored.source.regeneration.partialSeeds;
    expect(records.some((record) => record.targetKind === "district" && record.targetId === doomedId)).toBe(false);
    expect(newestSeedRecord("block", doomedBlockId).seed).toBe("doomed-block-seed");
    for (const record of records) {
      if (record.targetKind === "block") expect(liveBlockIds.has(record.targetId)).toBe(true);
    }
    // Surviving records keep their exact seed and chronology position.
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetKind: "block", targetId: survivorBlockId, seed: "kept-block-seed" })
    ]));
  }, 120_000);

  it("cleans a vanished block's seed record in the same save as the road deletion that replaced it", async () => {
    const doomedDistrict = districtIds()[0]!;
    const blockId = exclusiveBlockId(doomedDistrict);
    const survivorDistrict = districtIds()[1]!;
    const survivorBlockId = exclusiveBlockId(survivorDistrict);

    await regenerateTargets({ kind: "block", ids: [blockId] }, "merged-away-seed");
    await regenerateTargets({ kind: "district", ids: [doomedDistrict] }, "kept-district-seed");
    await regenerateTargets({ kind: "block", ids: [survivorBlockId] }, "kept-block-seed");

    // Pure topology: pick a boundary edge the doomed block shares with a neighbouring
    // block. Removing that edge merges the two faces into one whose boundary-road
    // lineage group differs, so the block's identity genuinely vanishes with the road
    // edit — no district deletion involved.
    const view = getDistrictPlanView();
    if (view === null) throw new Error("the district plan is not published");
    const doomedBlock = view.blocks.find((block) => block.id === blockId);
    if (doomedBlock === undefined) throw new Error(`block "${blockId}" vanished before the road edit`);
    const sharedEdgeId = doomedBlock.boundaryRoadIds.find((edgeId) =>
      view.blocks.some((other) => other.id !== blockId && other.boundaryRoadIds.includes(edgeId))
    );
    if (sharedEdgeId === undefined) throw new Error(`block "${blockId}" shares no boundary road with a neighbour`);

    const before = requireCity();
    const saves = fixture.scene.setFlag.mock.calls.length;
    const clearsBefore = fixture.renderer.clears;

    const result = await deleteRoads([sharedEdgeId]);

    expect(result).toEqual(expect.objectContaining({ full: true, stale: false }));
    expect(fixture.scene.setFlag.mock.calls.length - saves).toBe(1);
    expect(requireCity().revision).toBe(before.revision + 1);
    expect(fixture.renderer.clears).toBe(clearsBefore);
    const stored = fixture.getStored()!;
    expect(stored.revision).toBe(before.revision + 1);
    expect(stored.source.roads.edges.some((edge) => edge.id === sharedEdgeId)).toBe(false);
    // The merge replaced the block lineage; the vanished identity's seed record was
    // cleaned in THAT same atomic save — no follow-up commit.
    const liveBlockIds = new Set(getDistrictPlanView()!.blocks.map((block) => block.id));
    expect(liveBlockIds.has(blockId)).toBe(false);
    const records = stored.source.regeneration.partialSeeds;
    expect(records.some((record) => record.targetKind === "block" && record.targetId === blockId)).toBe(false);
    // The district survived the road edit with its seed untouched, as did the other block.
    expect(stored.source.districts.some((district) => district.id === doomedDistrict)).toBe(true);
    expect(newestSeedRecord("district", doomedDistrict)).toEqual(expect.objectContaining({ seed: "kept-district-seed" }));
    expect(newestSeedRecord("block", survivorBlockId)).toEqual(expect.objectContaining({ seed: "kept-block-seed" }));
    for (const record of records) {
      if (record.targetKind === "block") expect(liveBlockIds.has(record.targetId)).toBe(true);
    }
  }, 120_000);

  it("keeps district seed Apply and Reroll as the newest chronology events over older block attempts", async () => {
    const districtId = districtIds()[1]!;
    const blockId = exclusiveBlockId(districtId);

    await regenerateTargets({ kind: "block", ids: [blockId] }, "older-block-attempt");

    await updateDistricts([districtId], { seed: "applied-seed" });

    let stored = fixture.getStored()!;
    let districtRecord = newestSeedRecord("district", districtId);
    const blockRecord = newestSeedRecord("block", blockId);
    expect(districtRecord.seed).toBe("applied-seed");
    expect(districtRecord.order).toBeGreaterThan(blockRecord.order);
    expect(stored.source.districts.find((district) => district.id === districtId)!.seed).toBe("applied-seed");

    await regenerateTargets({ kind: "district", ids: [districtId] }, null);

    stored = fixture.getStored()!;
    const rerolled = newestSeedRecord("district", districtId);
    expect(rerolled.seed).not.toBe("applied-seed");
    expect(rerolled.seed).not.toBe(districtRecord.seed);
    expect(rerolled.order).toBeGreaterThan(districtRecord.order);
    // The older block attempt is preserved untouched; the rerolled event wins precedence.
    expect(newestSeedRecord("block", blockId)).toEqual(blockRecord);
    const orders = stored.source.regeneration.partialSeeds.map((record) => record.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  }, 120_000);

  it("rebuilds exactly the old/new/cross-boundary chunk union and installs it scoped", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();
    const oldPlan = buildCompleteCityPlan(before.source, before.revision);
    const preflight = await preflightRegeneration(target, "union-seed");
    expect(preflight.candidateSource).not.toBeNull();
    const newPlan = buildCompleteCityPlan(preflight.candidateSource!, before.revision + 1);

    const expectedKeys = affectedRegenerationChunkKeys(oldPlan, newPlan, target);
    expect(expectedKeys.length).toBeGreaterThan(0);
    const fullCoverage = new Set(fixture.renderer.sets).size;
    expect(expectedKeys.length).toBeLessThan(fullCoverage);

    const setsBefore = fixture.renderer.sets.length;
    const clearsBefore = fixture.renderer.clears;

    const result = await regenerateTargets(target, "union-seed");

    const requested = fixture.worker.chunkRequests.at(-1)!;
    expect([...requested].sort()).toEqual(expectedKeys.map((key) => chunkId(key)).sort());
    // The scoped install touched exactly the union chunks and never wiped the chunk set.
    expect([...new Set(fixture.renderer.sets.slice(setsBefore))].sort()).toEqual([...requested].sort());
    expect(fixture.renderer.clears).toBe(clearsBefore);
    expect(result.chunks).toBe(expectedKeys.length);
    expect(chunksCovering({ x: 0, y: 0, width: 384, height: 256 }).length).toBe(fullCoverage);
  }, 120_000);

  it("undoes and redoes a regeneration one step at a time through the guarded history", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    const target: RegenerationTarget = { kind: "block", ids: [blockId] };
    const before = requireCity();
    const savesBefore = fixture.scene.setFlag.mock.calls.length;

    await regenerateTargets(target, "history-seed");
    const regenerated = requireCity();
    expect(undoDepth()).toBe(1);
    expect(canRedo()).toBe(false);

    expect(await undo()).toBe(true);
    const undone = requireCity();
    expect(undone.revision).toBe(regenerated.revision + 1);
    expect(undone.source).toEqual(before.source);
    expect(fixture.getStored()!.source).toEqual(before.source);
    expect(undoDepth()).toBe(0);
    expect(canUndo()).toBe(false);
    expect(canRedo()).toBe(true);
    expect(fixture.scene.setFlag.mock.calls.length - savesBefore).toBe(2);

    expect(await redo()).toBe(true);
    const redone = requireCity();
    expect(redone.revision).toBe(regenerated.revision + 2);
    expect(redone.source).toEqual(regenerated.source);
    expect(fixture.getStored()!.source).toEqual(regenerated.source);
    expect(undoDepth()).toBe(1);
  }, 120_000);

  it("clears partial seeds and history when Randomize Entire City replaces the city through its confirmation", async () => {
    const blockId = exclusiveBlockId(districtIds()[0]!);
    await regenerateTargets({ kind: "block", ids: [blockId] }, "soon-cleared");
    const before = requireCity();
    expect(before.source.regeneration.partialSeeds.length).toBeGreaterThan(0);
    expect(before.source.citySeed).toBe("phase6-adapter-fixture");

    const result = await randomizeEntireCity({
      terrainMode: "rectangle",
      coastEdge: null,
      citySeed: "ignored-randomize-seed",
      roadLayout: "grid",
      hubMode: "single-centre",
      districtPool: [...DISTRICT_TYPE_IDS],
      openSpaceProfile: "medium",
      randomize: false,
      confirmation: clearConfirmationFor(generationPreflight())
    });

    expect(result.ok).toBe(true);
    const fresh = requireCity();
    expect(fresh.revision).toBe(1);
    expect(fresh.source.citySeed).not.toBe("ignored-randomize-seed");
    expect(fresh.source.citySeed).not.toBe(before.source.citySeed);
    expect(fresh.source.regeneration.partialSeeds).toEqual([]);
    expect(fixture.getStored()!.source.regeneration.partialSeeds).toEqual([]);
    expect(undoDepth()).toBe(0);
    expect(canUndo()).toBe(false);
  }, 120_000);
});
