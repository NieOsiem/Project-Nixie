import { describe, expect, it } from "vitest";
import { rectRing, type Ring } from "../geom/types.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS } from "./district-registry.js";
import type {
  ArchitectureOverrideSource,
  ArchitectureProtection,
  CitySourceV5,
  PersistentBuildingSource,
  PersistentPlaceSource,
  PlacementFrame,
  RoadEdgeSource,
  RoadNodeSource,
  RoadRouteSource
} from "./city.js";
import type { BuildingPlan, CompleteCityPlan, LandmarkPlan } from "./complete-city-plan.js";
import {
  BulkArchitectureError,
  buildBulkArchitectureCandidate
} from "./architecture-bulk.js";

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

const siteRect = (centreX: number, centreY: number, width: number): Ring =>
  rectRing({ x: centreX - width / 2, y: centreY - width / 2, width, height: width });

const placement = (centreX: number, centreY: number, size: number): PlacementFrame => ({
  centre: { x: centreX, y: centreY },
  rotationRad: 0,
  widthM: size,
  depthM: size
});

const sourceBuilding = (id: string, centreX: number, centreY: number, protection: ArchitectureProtection): PersistentBuildingSource => ({
  id,
  lineage: `architecture/lineage/${id}`,
  origin: "authored",
  protection,
  seed: `architecture/geometry/${id}`,
  appearanceSeed: `architecture/appearance/${id}`,
  grammarId: "corporate-setback-tower",
  visualUse: "commercial",
  heightM: 128,
  paletteId: DISTRICT_PALETTE_IDS[0]!,
  sitePolygon: siteRect(centreX, centreY, 72),
  placement: placement(centreX, centreY, 48),
  districtId: null,
  blockId: null
});

const sourcePlace = (id: string, centreX: number, centreY: number, protection: ArchitectureProtection): PersistentPlaceSource => ({
  id,
  lineage: `architecture/place-lineage/${id}`,
  origin: "authored",
  protection,
  seed: `architecture/place-geometry/${id}`,
  appearanceSeed: `architecture/place-appearance/${id}`,
  landmarkGrammarId: "hero-tower-plaza",
  paletteId: DISTRICT_PALETTE_IDS[0]!,
  sitePolygon: siteRect(centreX, centreY, 88),
  placement: placement(centreX, centreY, 72),
  districtId: null,
  blockId: null
});

const derivedBuildingPlan = (
  id: string,
  extras: Partial<BuildingPlan> = {}
): BuildingPlan => ({
  id,
  sourceId: null,
  lineage: `derived/lineage/${id}`,
  parcelId: "parcel-1",
  blockId: "block-1",
  fragmentId: "fragment-1",
  districtId: "west",
  grammarId: "corporate-setback-tower",
  visualUse: "commercial",
  archetype: "rectangle",
  seed: `generated/geometry/${id}`,
  appearanceSeed: `generated/appearance/${id}`,
  heightM: 96,
  paletteId: DISTRICT_PALETTE_IDS[1]!,
  sitePolygon: siteRect(200, 300, 72),
  placement: placement(200, 300, 48),
  masses: [],
  areaM2: 72 * 72,
  ...extras
});

const derivedPlacePlan = (id: string, extras: Partial<LandmarkPlan> = {}): LandmarkPlan => ({
  id,
  sourceId: null,
  lineage: `derived/place-lineage/${id}`,
  landmarkGrammarId: "hero-tower-plaza",
  districtId: "west",
  blockId: "block-1",
  sitePolygon: siteRect(200, 300, 88),
  placement: placement(200, 300, 72),
  seed: `generated/place-geometry/${id}`,
  appearanceSeed: `generated/place-appearance/${id}`,
  paletteId: DISTRICT_PALETTE_IDS[1]!,
  masses: [],
  openSpaceIds: [],
  areaM2: 88 * 88,
  ...extras
});

const emptyArchitecture = (): CitySourceV5["architecture"] => ({ buildings: [], places: [], overrides: [] });

const baseSource = (architecture: CitySourceV5["architecture"] = emptyArchitecture()): CitySourceV5 => ({
  origin: { x: 0, y: 0 },
  citySeed: "phase6-architecture-bulk-fixture",
  generation: {
    terrainMode: "rectangle",
    coastEdge: null,
    roadLayout: "grid",
    hubMode: "single-centre",
    districtPool: [...DISTRICT_TYPE_IDS],
    openSpaceProfile: "medium"
  },
  terrain: {
    land: rectRing({ x: 0, y: 0, width: 600, height: 600 }),
    urbanFootprint: null
  },
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
      seed: "district-west",
      typeId: "corporate-core",
      paletteId: DISTRICT_PALETTE_IDS[0]!,
      origin: "generated",
      locked: false,
      openSpaceOverride: null
    },
    {
      id: "east",
      polygon: rectRing({ x: 300, y: 0, width: 300, height: 600 }),
      seed: "district-east",
      typeId: "corporate-core",
      paletteId: DISTRICT_PALETTE_IDS[1]!,
      origin: "generated",
      locked: false,
      openSpaceOverride: null
    }
  ],
  architecture,
  regeneration: { partialSeeds: [] }
});

const planWith = (buildings: BuildingPlan[], landmarks: LandmarkPlan[]): CompleteCityPlan =>
  ({ buildings, landmarks }) as unknown as CompleteCityPlan;

const buildingById = (architecture: ArchitectureSourceOf, id: string): PersistentBuildingSource => {
  const building = architecture.buildings.find((candidate) => candidate.id === id);
  if (building === undefined) throw new Error(`Missing building ${id}`);
  return building;
};

const overrideFor = (architecture: ArchitectureSourceOf, kind: string, id: string): ArchitectureOverrideSource | undefined =>
  architecture.overrides.find((candidate) => candidate.targetKind === kind && candidate.targetId === id);

type ArchitectureSourceOf = CitySourceV5["architecture"];

const bulkErrorBlockers = (run: () => unknown): BulkArchitectureError["blockers"] => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BulkArchitectureError);
    return (error as BulkArchitectureError).blockers;
  }
  throw new Error("Expected the bulk action to be rejected.");
};

describe("buildBulkArchitectureCandidate", () => {
  it("locks and unlocks persistent records as explicit transitions", () => {
    const source = baseSource({
      buildings: [sourceBuilding("b1", 100, 100, "none"), sourceBuilding("b2", 300, 100, "manual-edit")],
      places: [],
      overrides: []
    });
    const plan = planWith([derivedBuildingPlan("derived-1")], []);

    const locked = buildBulkArchitectureCandidate(source, plan, ["b1", "b2"], { kind: "lock", locked: true });
    expect(buildingById(locked.architecture, "b1").protection).toBe("explicit");
    expect(buildingById(locked.architecture, "b2").protection).toBe("explicit");
    expect(locked.affectedIds).toEqual(["b1", "b2"]);
    expect(locked.sitePolygons).toHaveLength(2);

    const unlocked = buildBulkArchitectureCandidate(source, plan, ["b1"], { kind: "lock", locked: false });
    expect(buildingById(unlocked.architecture, "b1").protection).toBe("none");
  });

  it("locks a derived object as an explicit override and unlocks it back to none without deleting the override", () => {
    const source = baseSource();
    const plan = planWith([derivedBuildingPlan("derived-1")], []);

    const locked = buildBulkArchitectureCandidate(source, plan, ["derived-1"], { kind: "lock", locked: true });
    expect(locked.architecture.buildings).toHaveLength(0);
    const lockOverride = overrideFor(locked.architecture, "building", "derived-1");
    expect(lockOverride?.protection).toBe("explicit");
    expect(lockOverride?.lineage).toBe("derived/lineage/derived-1");

    const unlocked = buildBulkArchitectureCandidate(source, plan, ["derived-1"], { kind: "lock", locked: false });
    const unlockOverride = overrideFor(unlocked.architecture, "building", "derived-1");
    expect(unlockOverride?.protection).toBe("none");
    expect(unlockOverride).toBeDefined();
  });

  it("promotes a derived building on substantial edit and consumes the matching override preserving appearance and palette", () => {
    const override: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: "derived-1",
      lineage: "derived/lineage/derived-1",
      protection: "manual-edit",
      snapshotSitePolygon: siteRect(200, 300, 72),
      appearanceSeed: "override/appearance",
      paletteId: DISTRICT_PALETTE_IDS[2]!
    };
    const source = baseSource({
      buildings: [],
      places: [],
      overrides: [override]
    });
    // The plan build stamps override appearance/palette onto the plan object.
    const plan = planWith(
      [derivedBuildingPlan("derived-1", { appearanceSeed: "override/appearance", paletteId: DISTRICT_PALETTE_IDS[2]! })],
      []
    );

    const candidate = buildBulkArchitectureCandidate(
      source,
      plan,
      ["derived-1"],
      { kind: "edit", patch: { heightM: 150 } }
    );
    expect(candidate.architecture.overrides).toHaveLength(0);
    expect(candidate.architecture.buildings).toHaveLength(1);
    const promoted = buildingById(candidate.architecture, "derived-1");
    expect(promoted.origin).toBe("generated");
    expect(promoted.protection).toBe("manual-edit");
    expect(promoted.appearanceSeed).toBe("override/appearance");
    expect(promoted.paletteId).toBe(DISTRICT_PALETTE_IDS[2]);
    expect(promoted.heightM).toBe(150);
    expect(promoted.districtId).toBe("west");
    expect(promoted.blockId).toBe("block-1");
    expect(promoted.sitePolygon).toEqual(override.snapshotSitePolygon);
  });

  it("promotes a derived place on substantial edit through the place patch fields", () => {
    const source = baseSource();
    const plan = planWith([], [derivedPlacePlan("derived-place-1")]);

    const candidate = buildBulkArchitectureCandidate(
      source,
      plan,
      ["derived-place-1"],
      { kind: "edit", patch: { landmarkGrammarId: "civic-corporate-compound" } }
    );
    expect(candidate.architecture.buildings).toHaveLength(0);
    expect(candidate.architecture.places).toHaveLength(1);
    const promoted = candidate.architecture.places[0]!;
    expect(promoted).toMatchObject({
      id: "derived-place-1",
      origin: "generated",
      protection: "manual-edit",
      landmarkGrammarId: "civic-corporate-compound",
      districtId: "west",
      blockId: "block-1"
    });
    expect(promoted.sitePolygon).toEqual(siteRect(200, 300, 88));
    expect(candidate.architecture.overrides).toHaveLength(0);
    expect(candidate.affectedIds).toEqual(["derived-place-1"]);
  });

  it("keeps palette-only edits to derived objects as protected sparse overrides", () => {
    const source = baseSource();
    const plan = planWith([derivedBuildingPlan("derived-1")], []);

    const candidate = buildBulkArchitectureCandidate(
      source,
      plan,
      ["derived-1"],
      { kind: "edit", patch: { paletteId: DISTRICT_PALETTE_IDS[3]! } }
    );
    expect(candidate.architecture.buildings).toHaveLength(0);
    expect(candidate.architecture.overrides).toHaveLength(1);
    const sparse = overrideFor(candidate.architecture, "building", "derived-1")!;
    expect(sparse.protection).toBe("manual-edit");
    expect(sparse.paletteId).toBe(DISTRICT_PALETTE_IDS[3]);
    expect(sparse.appearanceSeed).toBeUndefined();
    expect(sparse.snapshotSitePolygon).toEqual(siteRect(200, 300, 72));
  });

  it("applies persistent edits at manual-edit protection and preserves unrelated records", () => {
    const untouched = sourceBuilding("b2", 300, 100, "manual-edit");
    const source = baseSource({
      buildings: [sourceBuilding("b1", 100, 100, "none"), untouched],
      places: [],
      overrides: []
    });
    const plan = planWith([], []);

    const candidate = buildBulkArchitectureCandidate(
      source,
      plan,
      ["b1"],
      { kind: "edit", patch: { heightM: 200, paletteId: DISTRICT_PALETTE_IDS[4]! } }
    );
    const edited = buildingById(candidate.architecture, "b1");
    expect(edited.protection).toBe("manual-edit");
    expect(edited.heightM).toBe(200);
    expect(edited.paletteId).toBe(DISTRICT_PALETTE_IDS[4]);
    expect(buildingById(candidate.architecture, "b2")).toEqual(untouched);
  });

  it("deletes only persistent records and clears their override", () => {
    const override: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: "b1",
      lineage: "architecture/lineage/b1",
      protection: "manual-edit",
      snapshotSitePolygon: siteRect(100, 100, 72)
    };
    const source = baseSource({
      buildings: [sourceBuilding("b1", 100, 100, "none"), sourceBuilding("b2", 300, 100, "none")],
      places: [],
      overrides: [override]
    });
    const plan = planWith([], []);

    const candidate = buildBulkArchitectureCandidate(source, plan, ["b1"], { kind: "delete" });
    expect(candidate.architecture.buildings.map((building) => building.id)).toEqual(["b2"]);
    expect(candidate.architecture.overrides).toHaveLength(0);
    expect(candidate.affectedIds).toEqual(["b1"]);
    expect(candidate.sitePolygons).toEqual([siteRect(100, 100, 72)]);
  });

  it("rejects mixed-kind selections for edit and delete", () => {
    const source = baseSource({
      buildings: [sourceBuilding("b1", 100, 100, "none")],
      places: [sourcePlace("p1", 100, 500, "none")],
      overrides: []
    });
    const plan = planWith([], []);

    const editBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(source, plan, ["b1", "p1"], { kind: "edit", patch: { paletteId: null } })
    );
    expect(editBlockers.some((blocker) => blocker.kind === "selection" && /single type/.test(blocker.reason))).toBe(true);

    const deleteBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(source, plan, ["b1", "p1"], { kind: "delete" })
    );
    expect(deleteBlockers.some((blocker) => blocker.kind === "selection" && /single type/.test(blocker.reason))).toBe(true);
  });

  it("rejects deletion of derived objects and enumerates every invalid delete member", () => {
    const locked = sourceBuilding("b-locked", 100, 100, "explicit");
    const source = baseSource({
      buildings: [locked],
      places: [],
      overrides: []
    });
    const plan = planWith([derivedBuildingPlan("derived-1")], []);

    const blockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(source, plan, ["missing", "b-locked", "derived-1"], { kind: "delete" })
    );
    expect(blockers.map((blocker) => blocker.id).sort()).toEqual(["b-locked", "derived-1", "missing"]);
    const missing = blockers.find((blocker) => blocker.id === "missing")!;
    expect(missing.kind).toBe("unknown");
    expect(missing.reason).toContain("Unknown architecture object");
    expect(blockers.find((blocker) => blocker.id === "b-locked")!.reason).toContain("locked");
    expect(blockers.find((blocker) => blocker.id === "derived-1")!.reason).toContain("Derived architecture objects cannot be deleted");
  });

  it("rejects edits of locked members while lock and unlock remain permissible", () => {
    const source = baseSource({
      buildings: [sourceBuilding("b1", 100, 100, "explicit")],
      places: [],
      overrides: []
    });
    const plan = planWith([derivedBuildingPlan("derived-1")], []);

    const editBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(source, plan, ["b1", "derived-1"], { kind: "edit", patch: { heightM: 120 } })
    );
    expect(editBlockers).toHaveLength(1);
    expect(editBlockers[0]).toMatchObject({ id: "b1", kind: "building" });

    // Explicit lock and unlock transitions themselves are never blocked.
    const relock = buildBulkArchitectureCandidate(source, plan, ["b1"], { kind: "lock", locked: true });
    expect(buildingById(relock.architecture, "b1").protection).toBe("explicit");
    const release = buildBulkArchitectureCandidate(source, plan, ["b1"], { kind: "lock", locked: false });
    expect(buildingById(release.architecture, "b1").protection).toBe("none");
  });

  it("enumerates empty selections, duplicates, unknown patch fields, and invalid patch values without mutating anything", () => {
    const before = baseSource({
      buildings: [sourceBuilding("b1", 100, 100, "none")],
      places: [],
      overrides: []
    });
    const snapshot = structuredClone(before);
    const plan = planWith([derivedBuildingPlan("derived-1")], []);

    const emptyBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(before, plan, [], { kind: "delete" })
    );
    expect(emptyBlockers[0]).toMatchObject({ id: "selection", kind: "selection" });

    const duplicateBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(before, plan, ["b1", "b1"], { kind: "delete" })
    );
    expect(duplicateBlockers.some((blocker) => /duplicate id "b1"/.test(blocker.reason))).toBe(true);

    const patchBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(before, plan, ["b1", "derived-1"], {
        kind: "edit",
        patch: {
          heightM: -4,
          grammarId: "corporate-setback-tower",
          visualUse: "residential",
          paletteId: "not-a-palette",
          appearanceSeed: "smuggled"
        }
      })
    );
    const reasons = patchBlockers.map((blocker) => blocker.reason);
    expect(reasons.filter((reason) => /Unknown building object property "appearanceSeed"/.test(reason))).toHaveLength(2);
    expect(reasons.some((reason) => /heightM must be finite and positive/.test(reason))).toBe(true);
    expect(reasons.some((reason) => /does not support visual use "residential"/.test(reason))).toBe(true);
    expect(reasons.some((reason) => /paletteId must be a known palette id or null/.test(reason))).toBe(true);

    const crossKindBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(before, plan, ["b1"], { kind: "edit", patch: { landmarkGrammarId: "hero-tower-plaza" } })
    );
    expect(crossKindBlockers.some((blocker) => /cannot include landmarkGrammarId/.test(blocker.reason))).toBe(true);

    const emptyPatchBlockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(before, plan, ["b1"], { kind: "edit", patch: {} })
    );
    expect(emptyPatchBlockers.some((blocker) => /patch is empty/.test(blocker.reason))).toBe(true);

    expect(before).toEqual(snapshot);
  });

  it("rejects promotion of derived objects without a placement frame", () => {
    const source = baseSource();
    const plan = planWith([derivedBuildingPlan("derived-1", { placement: undefined })], []);

    const blockers = bulkErrorBlockers(() =>
      buildBulkArchitectureCandidate(source, plan, ["derived-1"], { kind: "edit", patch: { heightM: 120 } })
    );
    expect(blockers.some((blocker) => /no placement frame and cannot be promoted/.test(blocker.reason))).toBe(true);
  });

});
