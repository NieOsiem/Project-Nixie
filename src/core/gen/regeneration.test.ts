import { describe, expect, it } from "vitest";
import { intersection, isSnapNoise, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV5, type PersistentBuildingSource, type RoadEdgeSource, type RoadNodeSource, type RoadRouteSource } from "./city.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS } from "./district-registry.js";
import { buildDistrictPlan, compiledRouteOccupancy, districtStructuralInputSignature, type DistrictPlan } from "./district-plan.js";
import { effectiveRegenerationSeed, normalizeRegenerationPartialSeedRecords, withRegenerationSeed } from "./regeneration.js";
import { buildCompleteCityPlan, occupiedPersistentBuildingGeometry, type CompleteCityPlan } from "./complete-city-plan.js";

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string, classId: RoadEdgeSource["classId"] = "street"): RoadEdgeSource => ({ id, a, b, routeId, classId, name: null, locked: false, origin: "authored" });

const CITY_SEED = "regeneration-fixture";

/**
 * Four quadrant blocks around the centre crossing. The district polygon covers the
 * north-west block fully and cuts the north-east block into an in-district fragment
 * (x < 150) and an unzoned fragment (x >= 150), so block-level and district-level
 * seed scopes are distinguishable at fragment granularity.
 */
const baseSource = (): CitySourceV5 => ({
  origin: { x: 700, y: 300 },
  citySeed: CITY_SEED,
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
  terrain: { land: rectRing({ x: 0, y: 0, width: 200, height: 200 }), urbanFootprint: null },
  roads: {
    nodes: [node("n", 100, 0), node("w", 0, 100), node("c", 100, 100), node("e", 200, 100), node("s", 100, 200)],
    routes: [route("horizontal"), route("vertical")],
    edges: [edge("north", "n", "c", "vertical"), edge("west", "w", "c", "horizontal"), edge("east", "c", "e", "horizontal"), edge("south", "c", "s", "vertical")]
  },
  districts: [{
    id: "district-a",
    polygon: rectRing({ x: 0, y: 0, width: 150, height: 100 }),
    seed: "district-a-base-seed",
    typeId: DISTRICT_TYPE_IDS[0]!,
    paletteId: DISTRICT_PALETTE_IDS[0]!,
    origin: "generated",
    locked: false,
    openSpaceOverride: null
  }],
  architecture: { buildings: [], places: [], overrides: [] },
  regeneration: { partialSeeds: [] }
});

const blockAt = (plan: DistrictPlan, x: number, y: number) =>
  plan.blocks.find((block) => {
    const bounds = ringBounds(block.zoningFace);
    return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
  })!;

const cellsByFragment = (plan: DistrictPlan): Map<string, string> => {
  const serialized = new Map<string, string>();
  for (const cell of plan.developmentCells) {
    serialized.set(cell.fragmentId, `${serialized.get(cell.fragmentId) ?? ""}|${JSON.stringify(cell)}`);
  }
  return serialized;
};

const fragmentIdsForScope = (plan: DistrictPlan, scope: { blockId: string; districtId: string | null }): string[] =>
  plan.blocks
    .filter((block) => block.id === scope.blockId)
    .flatMap((block) => block.districtFragments)
    .filter((fragment) => scope.districtId === null || fragment.districtId === scope.districtId)
    .map((fragment) => fragment.id);

describe("effectiveRegenerationSeed", () => {
  it("falls back to the exact gen-13 material when no record applies", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const zoned = blockAt(plan, 50, 50);
    const unzoned = blockAt(plan, 175, 175);
    expect(effectiveRegenerationSeed(source, { blockId: zoned.id, districtId: "district-a" })).toBe("district-a-base-seed");
    expect(effectiveRegenerationSeed(source, { blockId: unzoned.id, districtId: null })).toBe(CITY_SEED);
  });

  it("resolves the newest applicable record regardless of kind", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const scope = { blockId: blockAt(plan, 50, 50).id, districtId: "district-a" };
    const withBlock = withRegenerationSeed(source, { kind: "block", ids: [scope.blockId] }, "block-seed-1");
    expect(effectiveRegenerationSeed(withBlock, scope)).toBe(`block-seed-1|block/${scope.blockId}`);
    const withDistrict = withRegenerationSeed(withBlock, { kind: "district", ids: ["district-a"] }, "district-seed-2");
    expect(effectiveRegenerationSeed(withDistrict, scope)).toBe("district-seed-2|district/district-a");
    const withLaterBlock = withRegenerationSeed(withDistrict, { kind: "block", ids: [scope.blockId] }, "block-seed-3");
    expect(effectiveRegenerationSeed(withLaterBlock, scope)).toBe(`block-seed-3|block/${scope.blockId}`);
  });

  it("keeps identical seed text kind+ID-isolated across targets", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const blockId = blockAt(plan, 50, 50).id;
    const otherZonedBlockId = blockAt(plan, 120, 50).id;
    const recorded = withRegenerationSeed(
      withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "same-text"),
      { kind: "block", ids: [blockId] },
      "same-text"
    );
    expect(recorded.regeneration.partialSeeds).toHaveLength(2);
    // Identical text, but each record applies only to its own kind+ID scope: the
    // district record governs a zoned block without its own record, the block record
    // governs its block, and the overlap resolves by order (later block event wins).
    expect(effectiveRegenerationSeed(recorded, { blockId: otherZonedBlockId, districtId: "district-a" })).toBe("same-text|district/district-a");
    expect(effectiveRegenerationSeed(recorded, { blockId, districtId: null })).toBe(`same-text|block/${blockId}`);
    expect(effectiveRegenerationSeed(recorded, { blockId, districtId: "district-a" })).toBe(`same-text|block/${blockId}`);
  });

  it("a district record never leaks into a fragment outside the district", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const unzoned = blockAt(plan, 175, 175);
    const recorded = withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "district-seed");
    expect(effectiveRegenerationSeed(recorded, { blockId: unzoned.id, districtId: null })).toBe(CITY_SEED);
  });
});

describe("withRegenerationSeed", () => {
  it("replaces exactly one selected key and preserves older overlapping keys", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const blockId = blockAt(plan, 50, 50).id;
    const seeded = withRegenerationSeed(
      withRegenerationSeed(source, { kind: "block", ids: [blockId] }, "old-block-seed"),
      { kind: "district", ids: ["district-a"] },
      "district-seed"
    );
    expect(seeded.regeneration.partialSeeds.map((record) => [record.targetKind, record.targetId, record.seed, record.order])).toEqual([
      ["block", blockId, "old-block-seed", 1],
      ["district", "district-a", "district-seed", 2]
    ]);
    const replaced = withRegenerationSeed(seeded, { kind: "block", ids: [blockId] }, "new-block-seed");
    expect(replaced.regeneration.partialSeeds.map((record) => [record.targetKind, record.targetId, record.seed, record.order])).toEqual([
      ["district", "district-a", "district-seed", 2],
      ["block", blockId, "new-block-seed", 3]
    ]);
  });

  it("records the full district chronology: block, district reroll, later block", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const blockId = blockAt(plan, 50, 50).id;
    const scope = { blockId, districtId: "district-a" };
    const chronology = withRegenerationSeed(
      withRegenerationSeed(
        withRegenerationSeed(source, { kind: "block", ids: [blockId] }, "block-attempt-1"),
        { kind: "district", ids: ["district-a"] },
        "district-reroll"
      ),
      { kind: "block", ids: [blockId] },
      "block-attempt-2"
    );
    // The older block attempt was replaced (not duplicated); the district event and
    // the newest block attempt coexist, and the newest block wins for its fragment.
    expect(chronology.regeneration.partialSeeds).toHaveLength(2);
    expect(chronology.regeneration.partialSeeds.map((record) => record.order)).toEqual([2, 3]);
    expect(effectiveRegenerationSeed(chronology, scope)).toBe(`block-attempt-2|block/${blockId}`);
    // A fragment of another block inside the district still resolves to the district event.
    const otherBlock = blockAt(plan, 175, 175);
    expect(effectiveRegenerationSeed(chronology, { blockId: otherBlock.id, districtId: null })).toBe(CITY_SEED);
  });

  it("appends ascending orders from one for an empty chronology", () => {
    const source = baseSource();
    const recorded = withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "first");
    expect(recorded.regeneration.partialSeeds).toEqual([
      { targetKind: "district", targetId: "district-a", seed: "first", order: 1 }
    ]);
    expect(source.regeneration.partialSeeds).toEqual([]);
  });

  it("rejects invalid seeds, unknown kinds, empty selections, and unknown districts", () => {
    const source = baseSource();
    expect(() => withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "  ")).toThrow(/non-empty trimmed text/);
    expect(() => withRegenerationSeed(source, { kind: "block", ids: [] }, "seed")).toThrow(/at least one id/);
    expect(() => withRegenerationSeed(source, { kind: "district", ids: ["ghost-district"] }, "seed")).toThrow(/unknown district/);
  });
});

describe("normalizeRegenerationPartialSeedRecords", () => {
  it("drops vanished district ids and vanished block lineages without remapping", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const blockId = blockAt(plan, 50, 50).id;
    const seeded: CitySourceV5 = {
      ...source,
      regeneration: {
        partialSeeds: [
          { targetKind: "district", targetId: "district-a", seed: "keep-district", order: 1 },
          { targetKind: "district", targetId: "ghost-district", seed: "drop-me", order: 2 },
          { targetKind: "block", targetId: blockId, seed: "keep-block", order: 3 },
          { targetKind: "block", targetId: "block_ghost", seed: "drop-me-too", order: 4 }
        ]
      }
    };
    const normalized = normalizeRegenerationPartialSeedRecords(seeded, plan);
    expect(normalized.map((record) => [record.targetKind, record.targetId, record.seed, record.order])).toEqual([
      ["district", "district-a", "keep-district", 1],
      ["block", blockId, "keep-block", 3]
    ]);
  });

  it("returns records sorted ascending by order for an unsorted chronology", () => {
    const source = baseSource();
    const plan = buildDistrictPlan(source);
    const blockId = blockAt(plan, 50, 50).id;
    const seeded: CitySourceV5 = {
      ...source,
      regeneration: {
        partialSeeds: [
          { targetKind: "block", targetId: blockId, seed: "later", order: 7 },
          { targetKind: "district", targetId: "district-a", seed: "earlier", order: 3 }
        ]
      }
    };
    expect(normalizeRegenerationPartialSeedRecords(seeded, plan).map((record) => record.order)).toEqual([3, 7]);
  });
});

describe("target-local seed threading", () => {
  it("a district target rekeys only its owned fragments", () => {
    const source = baseSource();
    const baseline = buildDistrictPlan(source);
    const regenerated = buildDistrictPlan(withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "reseeded-district"));
    const before = cellsByFragment(baseline);
    const after = cellsByFragment(regenerated);
    expect(before.size).toBe(after.size);
    // In-district fragments (north-west block fully, north-east in-district strip) rekey.
    const zonedScopes = regenerated.blocks
      .flatMap((block) => block.districtFragments)
      .filter((fragment) => fragment.districtId === "district-a")
      .map((fragment) => fragment.id);
    expect(zonedScopes.length).toBeGreaterThanOrEqual(2);
    for (const fragmentId of zonedScopes) expect(after.get(fragmentId), `fragment ${fragmentId}`).not.toBe(before.get(fragmentId));
    // Unzoned fragments stay byte-identical.
    const unzonedScopes = regenerated.blocks
      .flatMap((block) => block.districtFragments)
      .filter((fragment) => fragment.districtId === null)
      .map((fragment) => fragment.id);
    expect(unzonedScopes.length).toBeGreaterThanOrEqual(2);
    for (const fragmentId of unzonedScopes) expect(after.get(fragmentId), `fragment ${fragmentId}`).toBe(before.get(fragmentId));
  });

  it("a block target rekeys every fragment of the block and no other block", () => {
    const source = baseSource();
    const baseline = buildDistrictPlan(source);
    // The north-east block straddles the district boundary: one zoned + one unzoned fragment.
    const plan = buildDistrictPlan(source);
    const straddling = blockAt(plan, 120, 50);
    expect(straddling.districtFragments).toHaveLength(2);
    const regenerated = buildDistrictPlan(withRegenerationSeed(source, { kind: "block", ids: [straddling.id] }, "reseeded-block"));
    const before = cellsByFragment(baseline);
    const after = cellsByFragment(regenerated);
    const targetFragmentIds = fragmentIdsForScope(regenerated, { blockId: straddling.id, districtId: null });
    expect(targetFragmentIds).toHaveLength(2);
    for (const fragmentId of targetFragmentIds) expect(after.get(fragmentId)).not.toBe(before.get(fragmentId));
    for (const [fragmentId, cells] of before) {
      if (targetFragmentIds.includes(fragmentId)) continue;
      expect(after.get(fragmentId)).toBe(cells);
    }
  });

  it("an empty chronology replays the plan byte-identically, stale records included", () => {
    const source = baseSource();
    const baseline = buildDistrictPlan(source);
    const stale: CitySourceV5 = {
      ...source,
      regeneration: {
        partialSeeds: [
          { targetKind: "block", targetId: "block_ghost", seed: "ghost-seed", order: 1 },
          { targetKind: "district", targetId: "ghost-district", seed: "ghost-seed-2", order: 2 }
        ]
      }
    };
    expect(buildDistrictPlan(stale).developmentCells).toEqual(baseline.developmentCells);
    expect(buildDistrictPlan(stale).openSpaceIntents).toEqual(baseline.openSpaceIntents);
  });

  it("the regeneration branch enters the structural input signature", () => {
    const source = baseSource();
    const before = districtStructuralInputSignature(source);
    const after = districtStructuralInputSignature(withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "changed-seed"));
    expect(after.regeneration).not.toBe(before.regeneration);
    expect(before.regeneration).toMatch(/^regeneration_[0-9a-f]{8}$/);
    // A no-op reseed of an empty chronology keeps every other component stable.
    expect(after.terrain).toBe(before.terrain);
    expect(after.roads).toBe(before.roads);
    expect(after.districts).toBe(before.districts);
    expect(after.generation).toBe(before.generation);
    expect(after.architecture).toBe(before.architecture);
  });

  it("preserves derived block lineage identity across reseeds", () => {
    const source = baseSource();
    const baseline = buildDistrictPlan(source);
    const regenerated = buildDistrictPlan(withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "reseeded"));
    expect(regenerated.blocks.map((block) => block.id)).toEqual(baseline.blocks.map((block) => block.id));
    expect(regenerated.blocks.map((block) => block.districtFragments.map((fragment) => fragment.id)))
      .toEqual(baseline.blocks.map((block) => block.districtFragments.map((fragment) => fragment.id)));
  });
});

describe("target-owned landmark presentation rekey", () => {
  const landmarksById = (plan: CompleteCityPlan) =>
    new Map(plan.landmarks.map((landmark) => [landmark.id, landmark]));

  it("record-free and ghost-record sources replay landmark presentation byte-identically", () => {
    const source = baseSource();
    const baseline = buildCompleteCityPlan(source);
    expect(baseline.landmarks.length).toBeGreaterThan(0);
    const ghosted: CitySourceV5 = {
      ...source,
      regeneration: {
        partialSeeds: [
          { targetKind: "block", targetId: "block_ghost", seed: "ghost-seed", order: 1 },
          { targetKind: "district", targetId: "ghost-district", seed: "ghost-seed-2", order: 2 }
        ]
      }
    };
    expect(buildCompleteCityPlan(ghosted).landmarks).toEqual(baseline.landmarks);
  });

  it("a district target rekeys owned landmark presentation while sites, identities, and neighbors stay fixed", () => {
    const source = baseSource();
    const baseline = buildCompleteCityPlan(source);
    const seeded = withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "reseeded-district");
    const regenerated = buildCompleteCityPlan(seeded);
    const before = landmarksById(baseline);
    const after = landmarksById(regenerated);
    expect(after.size).toBe(before.size);
    const owned = [...after.values()].filter((landmark) => landmark.districtId === "district-a");
    expect(owned.length).toBeGreaterThan(0);
    for (const landmark of owned) {
      const previous = before.get(landmark.id)!;
      expect(landmark.seed).not.toBe(previous.seed);
      expect(landmark.appearanceSeed).not.toBe(previous.appearanceSeed);
      // Spec §16.5: the compound replaces as one unit — identity, site, and placement stay verbatim.
      expect(landmark.sitePolygon).toEqual(previous.sitePolygon);
      expect(landmark.placement).toEqual(previous.placement);
      expect(landmark.lineage).toEqual(previous.lineage);
      expect(landmark.masses.length).toBeGreaterThan(0);
      expect(JSON.stringify(landmark.masses)).not.toBe(JSON.stringify(previous.masses));
    }
    for (const [id, landmark] of after) {
      if (landmark.districtId === "district-a") continue;
      expect(landmark).toEqual(before.get(id));
    }
  });

  it("rekeyed landmark presentation reconstructs identically from the persisted record", () => {
    const source = baseSource();
    const seeded = withRegenerationSeed(source, { kind: "district", ids: ["district-a"] }, "reseeded-district");
    const first = buildCompleteCityPlan(seeded);
    const reloaded = buildCompleteCityPlan(seeded);
    expect(reloaded.landmarks).toEqual(first.landmarks);
  });
});

describe("occupiedPersistentBuildingGeometry", () => {
  const candidateFromPlan = (source: CitySourceV5): PersistentBuildingSource => {
    const plan = buildCompleteCityPlan(source);
    const generated = plan.buildings.find((building) => building.origin === "generated" && building.masses.length > 0);
    if (generated === undefined || generated.placement === undefined) {
      throw new Error("Fixture: plan lacks a generated building with a materialized placement.");
    }
    return {
      id: generated.id,
      lineage: generated.lineage,
      origin: "generated",
      protection: "none",
      seed: generated.seed,
      appearanceSeed: generated.appearanceSeed,
      grammarId: generated.grammarId,
      visualUse: generated.visualUse,
      heightM: generated.heightM,
      // Unzoned generated buildings legitimately carry no palette; the persistent record
      // stores that as a null paletteId, never a rejected mock.
      paletteId: generated.paletteId ?? null,
      sitePolygon: generated.sitePolygon,
      placement: generated.placement,
      districtId: generated.districtId,
      blockId: generated.blockId
    };
  };

  it("materializes the same masses the planner materializes for the persistent record", () => {
    const source = baseSource();
    const candidate = candidateFromPlan(source);
    const recorded = { ...source, architecture: { buildings: [candidate], places: [], overrides: [] } };
    const rebuilt = buildCompleteCityPlan(recorded);
    const persistent = rebuilt.buildings.find((building) => building.id === candidate.id)!;
    expect(persistent.sourceId).toBe(candidate.id);
    const occupancy = occupiedPersistentBuildingGeometry(candidate, recorded);
    expect(occupancy).toEqual(union(persistent.masses.map((mass) => ringAsMulti(mass.footprint))));
    // Actual mass geometry, never the reservation site alone: setbacks carve the
    // materialized footprint strictly inside the site polygon.
    const massArea = occupancy.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0]!)), 0);
    const siteArea = Math.abs(ringArea(candidate.sitePolygon));
    expect(massArea).toBeGreaterThan(0);
    expect(massArea).toBeLessThan(siteArea);
  });

  it("analyzes a candidate crossing roads before the planner runs, using masses rather than site", () => {
    const candidate = candidateFromPlan(baseSource());
    const source = baseSource();
    const routeOccupancy = compiledRouteOccupancy(compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY));
    // A generated candidate never sits on a route: its masses clear the canonical occupancy.
    const restOccupancy = occupiedPersistentBuildingGeometry(candidate, source);
    expect(isSnapNoise(intersection(restOccupancy, routeOccupancy.all))).toBe(true);
    // The same candidate translated onto the vertical road (x = 100): the helper returns
    // mass geometry for the road-crossing candidate WITHOUT route validation or planning,
    // so conflict analysis runs before the full planner would reject it.
    const bounds = ringBounds(candidate.sitePolygon);
    const dx = 100 - (bounds.x + bounds.width / 2);
    const dy = 50 - (bounds.y + bounds.height / 2);
    const moved: PersistentBuildingSource = {
      ...candidate,
      sitePolygon: candidate.sitePolygon.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      placement: { ...candidate.placement, centre: { x: candidate.placement.centre.x + dx, y: candidate.placement.centre.y + dy } }
    };
    const movedOccupancy = occupiedPersistentBuildingGeometry(moved, source);
    expect(isSnapNoise(intersection(movedOccupancy, routeOccupancy.all))).toBe(false);
  });

  it("rejects an invalid candidate instead of guessing geometry", () => {
    const candidate = candidateFromPlan(baseSource());
    expect(() => occupiedPersistentBuildingGeometry({ ...candidate, grammarId: "not-a-grammar" as PersistentBuildingSource["grammarId"] }, baseSource())).toThrow();
  });
});

