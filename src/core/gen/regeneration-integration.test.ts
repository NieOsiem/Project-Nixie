import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { ringArea, ringBounds, rectRing, type MultiPolygon, type Ring } from "../geom/types.js";
import { deleteEdges } from "../graph/topology.js";
import { evaluateRegenerationPreflight, type RegenerationPreflight } from "./regeneration-plan.js";
import { effectiveRegenerationSeed, normalizeRegenerationPartialSeedRecords, withRegenerationSeed } from "./regeneration.js";
import { buildDistrictPlan } from "./district-plan.js";
import { buildCompleteCityPlan, deriveBlockHeightBands, validateCompleteCityPlan, type BuildingPlan, type CompleteCityPlan, type LandmarkPlan } from "./complete-city-plan.js";
import { DISTRICT_PALETTE_IDS } from "./district-registry.js";
import type {
  ArchitectureOverrideSource,
  CitySourceV5,
  DistrictSource,
  PersistentBuildingSource,
  PlacementFrame,
  RoadEdgeSource,
  RoadNodeSource,
  RoadRouteSource
} from "./city.js";

/**
 * Full-plan Phase 6 regeneration regressions: chronology (district ⇄ block), partial
 * districts sharing one block with a neighbouring district, protected snapshot/site
 * retention, unprotected authored/promoted removal, protected override promotion, and
 * topology-driven partial-seed cleanup — all exercised through real `buildCompleteCityPlan`
 * builds (no mocks) with content-level assertions on non-target buildings, open spaces,
 * landmarks, and parcels rather than whole-plan tokens or signatures.
 */

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string): RoadEdgeSource => ({
  id,
  a,
  b,
  routeId,
  classId: "street",
  name: null,
  locked: false,
  origin: "authored"
});

const multiArea = (multi: MultiPolygon): number =>
  multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);
const overlap = (a: Ring, b: Ring): number => multiArea(intersection(ringAsMulti(a), ringAsMulti(b)));

const DISTRICT_RESEED = "district-reseed-alpha";
const BLOCK_RESEED = "block-reseed-beta";
const PREFLIGHT_RESEED = "preflight-reseed";
const OVERRIDE_APPEARANCE_SEED = "integration-override-appearance";

/**
 * One 600 m grid city; roads at 200/400. Districts west (0–300, corporate-core) and east
 * (300–600, residential-megablocks) split the middle column of blocks at x = 300, so the
 * centre blocks are mixed-district: regenerating either district shares one block with
 * the neighbouring district, its budget split, and its blended height band.
 */
const gridSource = (architecture: CitySourceV5["architecture"] = { buildings: [], places: [], overrides: [] }): CitySourceV5 => ({
  origin: { x: 0, y: 0 },
  citySeed: "phase6-regen-integration",
  generation: {
    terrainMode: "rectangle",
    coastEdge: null,
    roadLayout: "grid",
    hubMode: "single-centre",
    districtPool: ["corporate-core", "residential-megablocks"],
    openSpaceProfile: "medium"
  },
  terrain: { land: rectRing({ x: 0, y: 0, width: 600, height: 600 }), urbanFootprint: null },
  roads: {
    nodes: [
      node("h0-west", 0, 200), node("h0-east", 600, 200),
      node("h1-west", 0, 400), node("h1-east", 600, 400),
      node("v0-north", 200, 0), node("v0-south", 200, 600),
      node("v1-north", 400, 0), node("v1-south", 400, 600),
      node("c00", 200, 200), node("c10", 400, 200),
      node("c01", 200, 400), node("c11", 400, 400)
    ],
    routes: [route("horizontal-0"), route("horizontal-1"), route("vertical-0"), route("vertical-1")],
    edges: [
      edge("horizontal-0-west", "h0-west", "c00", "horizontal-0"),
      edge("horizontal-0-east", "c00", "c10", "horizontal-0"),
      edge("horizontal-0-far-east", "c10", "h0-east", "horizontal-0"),
      edge("horizontal-1-west", "h1-west", "c01", "horizontal-1"),
      edge("horizontal-1-east", "c01", "c11", "horizontal-1"),
      edge("horizontal-1-far-east", "c11", "h1-east", "horizontal-1"),
      edge("vertical-0-north", "v0-north", "c00", "vertical-0"),
      edge("vertical-0-middle", "c00", "c01", "vertical-0"),
      edge("vertical-0-south", "c01", "v0-south", "vertical-0"),
      edge("vertical-1-north", "v1-north", "c10", "vertical-1"),
      edge("vertical-1-middle", "c10", "c11", "vertical-1"),
      edge("vertical-1-south", "c11", "v1-south", "vertical-1")
    ]
  },
  districts: [
    {
      id: "west",
      polygon: rectRing({ x: 0, y: 0, width: 300, height: 600 }),
      seed: "district-west-base",
      typeId: "corporate-core",
      paletteId: DISTRICT_PALETTE_IDS[0]!,
      origin: "generated",
      locked: false,
      openSpaceOverride: null
    },
    {
      id: "east",
      polygon: rectRing({ x: 300, y: 0, width: 300, height: 600 }),
      seed: "district-east-base",
      typeId: "residential-megablocks",
      paletteId: DISTRICT_PALETTE_IDS[1]!,
      origin: "generated",
      locked: false,
      openSpaceOverride: null
    }
  ],
  architecture,
  regeneration: { partialSeeds: [] }
});

// WHY: the suite builds the same deterministic city repeatedly (chronology, protection,
// replay, topology). A build of the grid fixture is seconds of pure generation and the
// pipeline keeps no module-level state, so identical builds are computed once per worker
// and shared; no test mutates a shared plan.
const sharedPlans = new Map<string, CompleteCityPlan>();
function sharedPlan(key: string, build: () => CompleteCityPlan): CompleteCityPlan {
  let plan = sharedPlans.get(key);
  if (plan === undefined) {
    plan = build();
    sharedPlans.set(key, plan);
  }
  return plan;
}

const allFragmentIds = (plan: CompleteCityPlan): string[] =>
  plan.districtPlan.blocks.flatMap((block) => block.districtFragments).map((fragment) => fragment.id);

const fragmentIdsForDistrict = (plan: CompleteCityPlan, districtId: string): string[] =>
  plan.districtPlan.blocks
    .flatMap((block) => block.districtFragments)
    .filter((fragment) => fragment.districtId === districtId)
    .map((fragment) => fragment.id);

const blockIdAt = (plan: CompleteCityPlan, x: number, y: number): string => {
  const block = plan.districtPlan.blocks.find((candidate) => {
    const bounds = ringBounds(candidate.zoningFace);
    return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
  });
  if (block === undefined) throw new Error(`Fixture: no block at (${x}, ${y}).`);
  return block.id;
};

interface IntegrationFixture {
  source: CitySourceV5;
  plan: CompleteCityPlan;
  districtById: Map<string, DistrictSource>;
  westFragmentIds: string[];
  mixedBlockId: string;
  mixedFragmentIds: string[];
  mixedWestFragmentIds: string[];
  mixedEastFragmentIds: string[];
  allFragmentIds: string[];
}

let integrationFixtureCache: IntegrationFixture | undefined;
function integrationFixture(): IntegrationFixture {
  if (integrationFixtureCache !== undefined) return integrationFixtureCache;
  const source = gridSource();
  const plan = sharedPlan("integration/baseline", () => buildCompleteCityPlan(source));
  expect(validateCompleteCityPlan(plan)).toEqual([]);
  const mixedBlock = plan.districtPlan.blocks.find((block) =>
    new Set(block.districtFragments.map((fragment) => fragment.districtId)).size >= 2
  );
  expect(mixedBlock, "fixture needs a block shared by west and east").toBeDefined();
  const mixedWestFragmentIds = mixedBlock!.districtFragments.filter((fragment) => fragment.districtId === "west").map((fragment) => fragment.id);
  const mixedEastFragmentIds = mixedBlock!.districtFragments.filter((fragment) => fragment.districtId === "east").map((fragment) => fragment.id);
  expect(mixedWestFragmentIds.length).toBeGreaterThan(0);
  expect(mixedEastFragmentIds.length).toBeGreaterThan(0);
  const westFragmentIds = fragmentIdsForDistrict(plan, "west");
  expect(westFragmentIds.length).toBeGreaterThanOrEqual(4);
  // Fixture sanity: both districts carry real procedural content.
  expect(plan.buildings.filter((building) => building.fragmentId !== null && westFragmentIds.includes(building.fragmentId)).length).toBeGreaterThan(0);
  expect(plan.buildings.filter((building) => building.fragmentId !== null && mixedEastFragmentIds.includes(building.fragmentId)).length).toBeGreaterThan(0);
  integrationFixtureCache = {
    source,
    plan,
    districtById: new Map(source.districts.map((district) => [district.id, district])),
    westFragmentIds,
    mixedBlockId: mixedBlock!.id,
    mixedFragmentIds: mixedBlock!.districtFragments.map((fragment) => fragment.id),
    mixedWestFragmentIds,
    mixedEastFragmentIds,
    allFragmentIds: allFragmentIds(plan)
  };
  return integrationFixtureCache;
}

/** Fragment-scoped plan content, compared as actual objects — never plan tokens/signatures. */
const fragmentContent = (plan: CompleteCityPlan, fragmentIds: ReadonlySet<string>) => ({
  buildings: plan.buildings.filter((building) => building.fragmentId !== null && fragmentIds.has(building.fragmentId)),
  openSpaces: plan.openSpaces.filter((openSpace) => fragmentIds.has(openSpace.fragmentId)),
  parcels: plan.parcels.filter((parcel) => fragmentIds.has(parcel.fragmentId))
});

const complementKeep = (fixture: IntegrationFixture, excludedSets: ReadonlySet<string>[]): Set<string> =>
  new Set(fixture.allFragmentIds.filter((fragmentId) => !excludedSets.some((excluded) => excluded.has(fragmentId))));

/** Every fragment outside the excluded scopes must stay byte-identical to the baseline plan. */
function expectNonTargetIdentical(
  actual: CompleteCityPlan,
  baseline: CompleteCityPlan,
  fixture: IntegrationFixture,
  excludedSets: ReadonlySet<string>[],
  landmarkOutsideScope: (landmark: LandmarkPlan) => boolean
): void {
  const keep = complementKeep(fixture, excludedSets);
  expect(fragmentContent(actual, keep)).toEqual(fragmentContent(baseline, keep));
  expect(actual.landmarks.filter(landmarkOutsideScope)).toEqual(baseline.landmarks.filter(landmarkOutsideScope));
}

describe("full-plan regeneration chronology", () => {
  const fixture = integrationFixture;
  const withDistrictSeed = (): CitySourceV5 =>
    withRegenerationSeed(fixture().source, { kind: "district", ids: ["west"] }, DISTRICT_RESEED);
  const withBlockSeed = (): CitySourceV5 =>
    withRegenerationSeed(fixture().source, { kind: "block", ids: [fixture().mixedBlockId] }, BLOCK_RESEED);
  const districtPlan = (): CompleteCityPlan => sharedPlan("chronology/district", () => buildCompleteCityPlan(withDistrictSeed()));
  const blockPlan = (): CompleteCityPlan => sharedPlan("chronology/block", () => buildCompleteCityPlan(withBlockSeed()));
  const districtThenBlockPlan = (): CompleteCityPlan =>
    sharedPlan("chronology/district-then-block", () =>
      buildCompleteCityPlan(withRegenerationSeed(withDistrictSeed(), { kind: "block", ids: [fixture().mixedBlockId] }, BLOCK_RESEED)));
  const blockThenDistrictPlan = (): CompleteCityPlan =>
    sharedPlan("chronology/block-then-district", () =>
      buildCompleteCityPlan(withRegenerationSeed(withBlockSeed(), { kind: "district", ids: ["west"] }, DISTRICT_RESEED)));

  it("rekeys only the target district's fragments and keeps the shared block's other district intact", () => {
    const base = fixture();
    const regenerated = districtPlan();
    expect(validateCompleteCityPlan(regenerated)).toEqual([]);
    // Block and fragment lineage is seed-independent: a reseed never renames topology.
    expect(regenerated.districtPlan.blocks.map((block) => block.id)).toEqual(base.plan.districtPlan.blocks.map((block) => block.id));
    expect(allFragmentIds(regenerated)).toEqual(base.allFragmentIds);

    const west = new Set(base.westFragmentIds);
    // Target content is actually re-rolled by the district's partial seed.
    expect(JSON.stringify(fragmentContent(regenerated, west))).not.toBe(JSON.stringify(fragmentContent(base.plan, west)));
    // The east half of the shared mixed block keeps its content even though the district
    // record re-rolls the west half of the very same block: no cross-fragment seed,
    // budget, height-band, or connector leakage.
    expectNonTargetIdentical(regenerated, base.plan, base, [west], (landmark) => landmark.districtId !== "west");
  }, 300_000);

  it("rekeys every fragment of a block target and no other block", () => {
    const base = fixture();
    const regenerated = blockPlan();
    expect(validateCompleteCityPlan(regenerated)).toEqual([]);
    const mixed = new Set(base.mixedFragmentIds);
    expect(JSON.stringify(fragmentContent(regenerated, mixed))).not.toBe(JSON.stringify(fragmentContent(base.plan, mixed)));
    expectNonTargetIdentical(regenerated, base.plan, base, [mixed], (landmark) => landmark.blockId !== base.mixedBlockId);
  }, 300_000);

  it("a district regeneration followed by a block regeneration leaves the whole block governed by the newest block record", () => {
    const base = fixture();
    const finalPlan = districtThenBlockPlan();
    expect(validateCompleteCityPlan(finalPlan)).toEqual([]);
    const mixed = new Set(base.mixedFragmentIds);
    // The block record (recorded later) wins for every fragment of the block — including
    // the west fragment the older district record also applies to.
    expect(fragmentContent(finalPlan, mixed)).toEqual(fragmentContent(blockPlan(), mixed));
    expect(finalPlan.landmarks.filter((landmark) => landmark.blockId === base.mixedBlockId).map((landmark) => landmark.seed))
      .toEqual(blockPlan().landmarks.filter((landmark) => landmark.blockId === base.mixedBlockId).map((landmark) => landmark.seed));
    // The west-column blocks (outside the block target) still follow the older district record.
    const westColumn = new Set(base.westFragmentIds.filter((fragmentId) => !base.mixedFragmentIds.includes(fragmentId)));
    expect(fragmentContent(finalPlan, westColumn)).toEqual(fragmentContent(districtPlan(), westColumn));
    expectNonTargetIdentical(finalPlan, base.plan, base, [mixed, westColumn], (landmark) => landmark.districtId !== "west" && landmark.blockId !== base.mixedBlockId);
  }, 300_000);

  it("a block regeneration followed by a district regeneration rekeys the district's fragments without disturbing the rest of the block", () => {
    const base = fixture();
    const finalPlan = blockThenDistrictPlan();
    expect(validateCompleteCityPlan(finalPlan)).toEqual([]);
    // The newer district record wins inside its own fragments: identical content to the
    // district-only regeneration, proving seed material depends on (kind, id, seed) and
    // never on record age or surrounding chronology.
    const mixedWest = new Set(base.mixedWestFragmentIds);
    expect(fragmentContent(finalPlan, mixedWest)).toEqual(fragmentContent(districtPlan(), mixedWest));
    // The east half of the shared block still follows the older block record alone.
    const mixedEast = new Set(base.mixedEastFragmentIds);
    expect(fragmentContent(finalPlan, mixedEast)).toEqual(fragmentContent(blockPlan(), mixedEast));
    // West-column blocks follow the district record; east-column blocks keep the baseline.
    const westColumn = new Set(base.westFragmentIds.filter((fragmentId) => !base.mixedFragmentIds.includes(fragmentId)));
    expect(fragmentContent(finalPlan, westColumn)).toEqual(fragmentContent(districtPlan(), westColumn));
    const eastColumn = new Set(base.allFragmentIds.filter((fragmentId) =>
      !base.mixedFragmentIds.includes(fragmentId) && !base.westFragmentIds.includes(fragmentId)));
    expect(fragmentContent(finalPlan, eastColumn)).toEqual(fragmentContent(base.plan, eastColumn));
    expectNonTargetIdentical(finalPlan, base.plan, base, [mixedWest, mixedEast, westColumn], (landmark) => landmark.districtId !== "west" && landmark.blockId !== base.mixedBlockId);
  }, 300_000);

  it("keeps per-block height bands seed-independent while the shared block blends both districts", () => {
    const base = fixture();
    const baselineBands = deriveBlockHeightBands(base.plan.districtPlan, base.districtById);
    expect(deriveBlockHeightBands(districtPlan().districtPlan, base.districtById)).toEqual(baselineBands);
    expect(deriveBlockHeightBands(blockPlan().districtPlan, base.districtById)).toEqual(baselineBands);
    expect(deriveBlockHeightBands(districtThenBlockPlan().districtPlan, base.districtById)).toEqual(baselineBands);
    expect(deriveBlockHeightBands(blockThenDistrictPlan().districtPlan, base.districtById)).toEqual(baselineBands);
    // The mixed block's band is an area blend of both districts' bands — regenerating
    // either district alone must never move it.
    const mixedBand = baselineBands.get(base.mixedBlockId);
    expect(mixedBand, "fixture: the shared block needs a blended band").toBeDefined();
    expect(mixedBand!.minM).toBeGreaterThan(0);
    expect(mixedBand!.maxM).toBeGreaterThan(mixedBand!.minM);
  }, 300_000);
});

describe("protection preflight drives a protected full rebuild", () => {
  const westProceduralCandidates = (plan: CompleteCityPlan): BuildingPlan[] =>
    plan.buildings.filter((building) =>
      building.sourceId === null
      && building.placement !== undefined
      && building.masses.length > 0
      && building.districtId === "west"
      && building.fragmentId !== null);

  interface ProtectionFixture {
    source: CitySourceV5;
    plan: CompleteCityPlan;
    preflight: RegenerationPreflight;
    keptTowerId: string;
    authoredShedId: string;
    unlockedPromotedId: string;
    derivedTargetId: string;
    snapshotSitePolygon: Ring;
  }

  let protectionFixtureCache: ProtectionFixture | undefined;
  function protectionFixture(): ProtectionFixture {
    if (protectionFixtureCache !== undefined) return protectionFixtureCache;
    const base = integrationFixture();
    // Promote three baseline buildings into the persistent envelope: one protected
    // (retained), one authored unprotected, and one unlocked promoted record — each from
    // a different west fragment so removal/retention is observable across the scope.
    const candidates = westProceduralCandidates(base.plan);
    expect(candidates.length, "fixture needs promotable west buildings").toBeGreaterThanOrEqual(3);
    const recordFrom = (building: BuildingPlan, origin: PersistentBuildingSource["origin"], protection: PersistentBuildingSource["protection"]): PersistentBuildingSource => ({
      id: building.id,
      lineage: building.lineage,
      origin,
      protection,
      seed: building.seed,
      appearanceSeed: building.appearanceSeed,
      grammarId: building.grammarId,
      visualUse: building.visualUse,
      heightM: building.heightM,
      paletteId: building.paletteId ?? null,
      sitePolygon: building.sitePolygon.map((point) => ({ ...point })),
      placement: { ...building.placement! } satisfies PlacementFrame,
      districtId: building.districtId,
      blockId: building.blockId
    });
    const keptTower = candidates.find((candidate) => base.mixedWestFragmentIds.includes(candidate.fragmentId!))!;
    const others = candidates.filter((candidate) => candidate.id !== keptTower.id);
    const authoredShed = others[0]!;
    const unlockedPromoted = others.find((candidate) => candidate.fragmentId !== authoredShed.fragmentId) ?? others[1]!;
    const architecture: CitySourceV5["architecture"] = {
      buildings: [
        recordFrom(keptTower, "generated", "manual-edit"),
        recordFrom(authoredShed, "authored", "none"),
        recordFrom(unlockedPromoted, "generated", "none")
      ],
      places: [],
      overrides: []
    };
    const preOverrideSource: CitySourceV5 = { ...base.source, architecture };
    const preOverridePlan = sharedPlan("protection/pre-override", () => buildCompleteCityPlan(preOverrideSource));
    expect(validateCompleteCityPlan(preOverridePlan)).toEqual([]);
    // A derived (procedural) west building becomes the protected-override target: its
    // override is promoted into the persistent envelope by preflight.
    const derivedTarget = westProceduralCandidates(preOverridePlan).find((candidate) =>
      candidate.id !== keptTower.id && candidate.id !== authoredShed.id && candidate.id !== unlockedPromoted.id);
    expect(derivedTarget, "fixture needs a derived west override target").toBeDefined();
    const snapshotSitePolygon = derivedTarget!.sitePolygon.map((point) => ({ ...point }));
    const override: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: derivedTarget!.id,
      lineage: derivedTarget!.lineage,
      protection: "explicit",
      snapshotSitePolygon,
      appearanceSeed: OVERRIDE_APPEARANCE_SEED
    };
    const source: CitySourceV5 = {
      ...preOverrideSource,
      architecture: { ...architecture, overrides: [override] }
    };
    const plan = sharedPlan("protection/plan", () => buildCompleteCityPlan(source));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const preflight = evaluateRegenerationPreflight(source, plan, { kind: "district", ids: ["west"] }, PREFLIGHT_RESEED);
    protectionFixtureCache = {
      source,
      plan,
      preflight,
      keptTowerId: keptTower.id,
      authoredShedId: authoredShed.id,
      unlockedPromotedId: unlockedPromoted.id,
      derivedTargetId: derivedTarget!.id,
      snapshotSitePolygon
    };
    return protectionFixtureCache;
  }

  const rebuiltPlan = (): { fixture: ProtectionFixture; plan: CompleteCityPlan } => {
    const fixture = protectionFixture();
    if (fixture.preflight.candidateSource === null) throw new Error("Fixture: preflight unexpectedly produced blockers.");
    return {
      fixture,
      plan: sharedPlan("protection/rebuilt", () => buildCompleteCityPlan(fixture.preflight.candidateSource!))
    };
  };

  it("produces a blocker-free candidate: protected records retained, unprotected authored and promoted records removed, protected override promoted", () => {
    const fixture = protectionFixture();
    const preflight = fixture.preflight;
    expect(preflight.blockers).toEqual([]);
    expect(new Set(preflight.removedIds)).toEqual(new Set([fixture.authoredShedId, fixture.unlockedPromotedId]));
    expect(preflight.retainedIds).toContain(fixture.keptTowerId);
    expect(preflight.retainedIds).toContain(fixture.derivedTargetId);
    const candidate = preflight.candidateSource;
    if (candidate === null) throw new Error("preflight.candidateSource must exist when no blocker exists");
    // Exactly the protected retention and the promotion survive in the architecture.
    expect(candidate.architecture.buildings.map((building) => building.id).sort()).toEqual(
      [fixture.keptTowerId, fixture.derivedTargetId].sort()
    );
    const kept = candidate.architecture.buildings.find((building) => building.id === fixture.keptTowerId)!;
    expect(kept.protection).toBe("manual-edit");
    expect(kept.sitePolygon).toEqual(fixture.source.architecture.buildings.find((building) => building.id === fixture.keptTowerId)!.sitePolygon);
    const promoted = candidate.architecture.buildings.find((building) => building.id === fixture.derivedTargetId)!;
    expect(promoted.protection).toBe("explicit");
    expect(promoted.appearanceSeed).toBe(OVERRIDE_APPEARANCE_SEED);
    expect(promoted.sitePolygon).toEqual(fixture.snapshotSitePolygon);
    expect(candidate.architecture.overrides).toEqual([]);
    expect(candidate.regeneration.partialSeeds).toEqual([
      { targetKind: "district", targetId: "west", seed: PREFLIGHT_RESEED, order: 1 }
    ]);
  });

  it("rebuilds the city with protected snapshots and promoted sites intact and re-rolls only the target scope", () => {
    const { fixture, plan: rebuilt } = rebuiltPlan();
    expect(validateCompleteCityPlan(rebuilt)).toEqual([]);
    const base = integrationFixture();
    // The protected record materializes exactly: identity, site, and declared height.
    const keptBuilding = rebuilt.buildings.find((building) => building.sourceId === fixture.keptTowerId);
    expect(keptBuilding, "the retained protected building must survive the rebuild").toBeDefined();
    const keptRecord = fixture.preflight.candidateSource!.architecture.buildings.find((building) => building.id === fixture.keptTowerId)!;
    expect(keptBuilding!.sitePolygon).toEqual(keptRecord.sitePolygon);
    expect(keptBuilding!.heightM).toBe(keptRecord.heightM);
    expect(keptBuilding!.masses.length).toBeGreaterThan(0);
    // The promoted override materializes at the snapshot site with the override appearance.
    const promotedBuilding = rebuilt.buildings.find((building) => building.sourceId === fixture.derivedTargetId);
    expect(promotedBuilding, "the promoted override must materialize").toBeDefined();
    expect(promotedBuilding!.sitePolygon).toEqual(fixture.snapshotSitePolygon);
    expect(promotedBuilding!.appearanceSeed).toBe(OVERRIDE_APPEARANCE_SEED);
    // The unprotected records are gone.
    expect(rebuilt.buildings.some((building) => building.sourceId === fixture.authoredShedId)).toBe(false);
    expect(rebuilt.buildings.some((building) => building.sourceId === fixture.unlockedPromotedId)).toBe(false);
    // Retained and promoted sites are reserved: no other building's site enters them.
    const reserved = [keptRecord.sitePolygon, fixture.snapshotSitePolygon];
    for (const building of rebuilt.buildings) {
      if (building.sourceId === fixture.keptTowerId || building.sourceId === fixture.derivedTargetId) continue;
      for (const site of reserved) {
        expect(overlap(building.sitePolygon, site), `${building.id} must respect a protected site`).toBeLessThan(0.5);
      }
    }
    // Scope isolation: everything outside the west district stays byte-identical to the
    // pre-rebuild plan; the west scope's procedural content is re-rolled by the new seed.
    const west = new Set(base.westFragmentIds);
    const keep = new Set(base.allFragmentIds.filter((fragmentId) => !west.has(fragmentId)));
    expect(fragmentContent(rebuilt, keep)).toEqual(fragmentContent(fixture.plan, keep));
    expect(rebuilt.landmarks.filter((landmark) => landmark.districtId !== "west"))
      .toEqual(fixture.plan.landmarks.filter((landmark) => landmark.districtId !== "west"));
    const proceduralTarget = rebuilt.buildings.filter((building) =>
      building.sourceId === null && building.fragmentId !== null && west.has(building.fragmentId));
    const proceduralBefore = fixture.plan.buildings.filter((building) =>
      building.sourceId === null && building.fragmentId !== null && west.has(building.fragmentId) && building.id !== fixture.derivedTargetId);
    expect(JSON.stringify(proceduralTarget)).not.toBe(JSON.stringify(proceduralBefore));
    expect(proceduralTarget.length).toBeGreaterThan(0);
  }, 300_000);

  it("reproduces the rebuilt plan content from a full JSON round-trip of the committed source", () => {
    const { fixture, plan: rebuilt } = rebuiltPlan();
    const replayed = buildCompleteCityPlan(JSON.parse(JSON.stringify(fixture.preflight.candidateSource)) as CitySourceV5);
    expect(replayed).toEqual(rebuilt);
  }, 300_000);

  it("rejects structurally impossible targets without producing a candidate", () => {
    const fixture = protectionFixture();
    const unknownBlock = evaluateRegenerationPreflight(fixture.source, fixture.plan, { kind: "block", ids: ["block-does-not-exist"] }, PREFLIGHT_RESEED);
    expect(unknownBlock.candidateSource).toBeNull();
    expect(unknownBlock.blockers.some((blocker) => blocker.kind === "target" && blocker.id === "block-does-not-exist")).toBe(true);
    const badSeed = evaluateRegenerationPreflight(fixture.source, fixture.plan, { kind: "district", ids: ["west"] }, " padded ");
    expect(badSeed.candidateSource).toBeNull();
    expect(badSeed.blockers.some((blocker) => blocker.kind === "seed")).toBe(true);
  });
});

describe("topology cleanup and reconstruction", () => {
  it("drops the stale block record with the road edit, keeps the district record, and reconstructs the surviving city", () => {
    const base = integrationFixture();
    const northWestBlockId = blockIdAt(base.plan, 100, 100);
    const recorded = withRegenerationSeed(
      withRegenerationSeed(base.source, { kind: "block", ids: [northWestBlockId] }, "northwest-attempt"),
      { kind: "district", ids: ["west"] },
      "west-persisted"
    );
    // Deleting the stub road between the north-west and west-middle blocks merges them:
    // the recorded block lineage vanishes and its partial-seed record goes stale.
    const edited = deleteEdges(recorded.roads, ["horizontal-0-west"]);
    expect(edited.disconnectedVehicleNetwork).toBe(false);
    const afterEdit: CitySourceV5 = { ...recorded, roads: edited.source };
    const editedDistrictPlan = buildDistrictPlan(afterEdit);
    expect(editedDistrictPlan.blocks.map((block) => block.id)).not.toContain(northWestBlockId);
    const normalized = normalizeRegenerationPartialSeedRecords(afterEdit, editedDistrictPlan);
    // Only the district record survives, with its exact seed and order — no remapping of
    // the vanished block identity onto the merged block.
    expect(normalized).toEqual([
      { targetKind: "district", targetId: "west", seed: "west-persisted", order: 2 }
    ]);
    const clean: CitySourceV5 = { ...afterEdit, regeneration: { partialSeeds: normalized } };
    const westFragment = editedDistrictPlan.blocks.flatMap((block) => block.districtFragments).find((fragment) => fragment.districtId === "west");
    expect(westFragment, "merged fixture needs a west fragment").toBeDefined();
    expect(effectiveRegenerationSeed(clean, { blockId: westFragment!.blockId, districtId: "west" })).toBe("west-persisted|district/west");
    const eastFragment = editedDistrictPlan.blocks.flatMap((block) => block.districtFragments).find((fragment) => fragment.districtId === "east");
    expect(eastFragment).toBeDefined();
    expect(effectiveRegenerationSeed(clean, { blockId: eastFragment!.blockId, districtId: "east" })).toBe("district-east-base");
    // The surviving city reconstructs from the cleaned source.
    const rebuilt = sharedPlan("topology/rebuilt", () => buildCompleteCityPlan(clean));
    expect(validateCompleteCityPlan(rebuilt)).toEqual([]);
    expect(rebuilt.districtPlan.blocks.map((block) => block.id)).toEqual(editedDistrictPlan.blocks.map((block) => block.id));
    expect(rebuilt.buildings.length).toBeGreaterThan(0);
    expect(rebuilt.landmarks.length).toBeGreaterThan(0);
  }, 300_000);
});
