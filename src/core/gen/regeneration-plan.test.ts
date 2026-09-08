import { describe, expect, it } from "vitest";
import { buildCompleteCityPlan, type BuildingPlan, type CompleteCityPlan } from "./complete-city-plan.js";
import {
  evaluateRegenerationPreflight,
  resolveRegenerationMemberships,
  resolveRegenerationTargetScope,
  type RegenerationBlocker
} from "./regeneration-plan.js";
import { DISTRICT_PALETTE_IDS } from "./district-registry.js";
import { ringCentroid, rectRing, type Ring } from "../geom/types.js";
import type {
  ArchitectureOverrideSource,
  CitySourceV5,
  PersistentBuildingSource,
  PersistentPlaceSource,
  PlacementFrame,
  RoadEdgeSource,
  RoadNodeSource,
  RoadRouteSource
} from "./city.js";

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

const siteRect = (centreX: number, centreY: number, width: number, height = width): Ring =>
  rectRing({ x: centreX - width / 2, y: centreY - height / 2, width, height });

const placement = (centreX: number, centreY: number, width: number, depth = width, rotationRad = 0): PlacementFrame => ({
  centre: { x: centreX, y: centreY },
  rotationRad,
  widthM: width,
  depthM: depth
});

const building = (
  id: string,
  centreX: number,
  centreY: number,
  protection: PersistentBuildingSource["protection"],
  overrides: Partial<PersistentBuildingSource> = {},
  siteWidth = 72
): PersistentBuildingSource => ({
  id,
  lineage: `regen/lineage/${id}`,
  origin: "authored",
  protection,
  seed: `regen/geometry/${id}`,
  appearanceSeed: `regen/appearance/${id}`,
  grammarId: "corporate-setback-tower",
  visualUse: "commercial",
  heightM: 96,
  paletteId: DISTRICT_PALETTE_IDS[0]!,
  sitePolygon: siteRect(centreX, centreY, siteWidth),
  placement: placement(centreX, centreY, Math.min(siteWidth - 12, 52)),
  districtId: null,
  blockId: null,
  ...overrides
});

const place = (
  id: string,
  centreX: number,
  centreY: number,
  protection: PersistentPlaceSource["protection"],
  overrides: Partial<PersistentPlaceSource> = {}
): PersistentPlaceSource => ({
  id,
  lineage: `regen/place-lineage/${id}`,
  origin: "authored",
  protection,
  seed: `regen/place-geometry/${id}`,
  appearanceSeed: `regen/place-appearance/${id}`,
  landmarkGrammarId: "civic-corporate-compound",
  paletteId: DISTRICT_PALETTE_IDS[0]!,
  sitePolygon: siteRect(centreX, centreY, 100),
  placement: placement(centreX, centreY, 80),
  districtId: null,
  blockId: null,
  ...overrides
});

const emptyArchitecture = (): CitySourceV5["architecture"] => ({ buildings: [], places: [], overrides: [] });

/** One 600 m grid city; roads at 200/400, districts west (0–300) and east (300–600). */
const baseSource = (architecture: CitySourceV5["architecture"] = emptyArchitecture()): CitySourceV5 => ({
  origin: { x: 0, y: 0 },
  citySeed: "phase6-regeneration-plan-fixture",
  generation: {
    terrainMode: "rectangle",
    coastEdge: null,
    roadLayout: "grid",
    hubMode: "single-centre",
    districtPool: ["corporate-core"],
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

const build = (source: CitySourceV5): CompleteCityPlan => buildCompleteCityPlan(source, 7, 3, []);

const blockIdAt = (plan: CompleteCityPlan, x: number, y: number): string => {
  const block = plan.districtPlan.blocks.find((candidate) =>
    candidate.districtFragments.some((fragment) =>
      fragment.buildable.some((polygon) => {
        const centre = ringCentroid(polygon[0]!);
        return Math.abs(centre.x - x) < 60 && Math.abs(centre.y - y) < 60;
      })
    )
  );
  if (block === undefined) throw new Error(`Fixture: no block fragment near (${x}, ${y}).`);
  return block.id;
};

/** Membership fixture: quadrant sites in the north-west block plus east-side records. */
const membershipArchitecture = (westBlock: string, eastBlock: string): CitySourceV5["architecture"] => ({
  buildings: [
    building("assoc-west", 60, 60, "none", { blockId: westBlock, districtId: "west" }),
    building("assoc-east", 500, 100, "none", { blockId: eastBlock, districtId: "east" }),
    // Geometrically inside the west block but stably associated with the east block:
    // never pulled into a west target by proximity.
    building("misassociated", 140, 140, "none", { blockId: eastBlock, districtId: "east" }),
    // Authored provenance: a stale association falls back to site-centroid ownership.
    building("stale-assoc", 140, 60, "none", { blockId: "block-no-longer-exists", districtId: null }),
    building("unassoc-protected", 60, 140, "explicit"),
    // Generated provenance with a stale association (e.g. a manually promoted generated
    // record the adapter failed to re-associate): never selected by proximity.
    building("stale-generated", 170, 170, "none", { origin: "generated", blockId: "block-no-longer-exists", districtId: null }),
    building("east-unassoc", 500, 500, "none")
  ],
  places: [],
  overrides: []
});

const blockerIds = (blockers: RegenerationBlocker[]): string[] => blockers.map((blocker) => blocker.id);

describe("Phase 6 regeneration target scope", () => {
  it("resolves a block target to all fragments of the selected blocks", () => {
    const source = baseSource();
    const plan = build(source);
    const westBlock = blockIdAt(plan, 100, 100);
    const scope = resolveRegenerationTargetScope(plan, { kind: "block", ids: [westBlock] });
    expect(scope).not.toBeNull();
    expect(scope!.target).toEqual({ kind: "block", ids: [westBlock] });
    expect(scope!.fragments.length).toBeGreaterThan(0);
    for (const fragment of scope!.fragments) expect(fragment.blockId).toBe(westBlock);
  });

  it("resolves a district target to exactly the fragments assigned to that district", () => {
    const source = baseSource();
    const plan = build(source);
    const scope = resolveRegenerationTargetScope(plan, { kind: "district", ids: ["west"] });
    expect(scope).not.toBeNull();
    expect(scope!.target).toEqual({ kind: "district", ids: ["west"] });
    expect(scope!.fragments.length).toBeGreaterThan(0);
    for (const fragment of scope!.fragments) expect(fragment.districtId).toBe("west");
  });

  it("rejects structurally unusable targets", () => {
    const source = baseSource();
    const plan = build(source);
    const westBlock = blockIdAt(plan, 100, 100);
    expect(resolveRegenerationTargetScope(plan, { kind: "block", ids: ["block-unknown"] })).toBeNull();
    expect(resolveRegenerationTargetScope(plan, { kind: "block", ids: [] })).toBeNull();
    expect(resolveRegenerationTargetScope(plan, { kind: "district", ids: ["west", "east"] })).toBeNull();
    expect(resolveRegenerationTargetScope(plan, { kind: "district", ids: ["nowhere"] })).toBeNull();
    expect(westBlock.length).toBeGreaterThan(0);
  });
});

describe("Phase 6 regeneration membership", () => {
  const westBlockIds = () => {
    const skeleton = baseSource();
    const plan = build(skeleton);
    const westBlock = blockIdAt(plan, 100, 100);
    const eastBlock = blockIdAt(plan, 500, 100);
    // The plan predates the membership records: persistent source records must stay
    // discoverable against a retained plan built before they existed.
    return { source: baseSource(membershipArchitecture(westBlock, eastBlock)), plan, westBlock, eastBlock };
  };

  it("prefers stable associations and keeps other-target content out", () => {
    const { source, plan, westBlock, eastBlock } = westBlockIds();
    const scope = resolveRegenerationTargetScope(plan, { kind: "block", ids: [westBlock] })!;
    const members = resolveRegenerationMemberships(source, plan, scope);
    const westMember = members.find((member) => member.id === "assoc-west");
    expect(westMember).toMatchObject({ kind: "building", origin: "persistent", via: "association" });
    const misassociated = members.find((member) => member.id === "misassociated");
    expect(misassociated).toBeUndefined();
    const eastMember = members.find((member) => member.id === "assoc-east");
    expect(eastMember).toBeUndefined();
    const eastUnassoc = members.find((member) => member.id === "east-unassoc");
    expect(eastUnassoc).toBeUndefined();
    expect(eastBlock.length).toBeGreaterThan(0);
  });

  it("falls back to site-centroid ownership only for absent or stale associations", () => {
    const { source, plan, westBlock } = westBlockIds();
    const scope = resolveRegenerationTargetScope(plan, { kind: "block", ids: [westBlock] })!;
    const members = resolveRegenerationMemberships(source, plan, scope);
    const stale = members.find((member) => member.id === "stale-assoc");
    expect(stale).toMatchObject({ via: "centroid", origin: "persistent" });
    const unassoc = members.find((member) => member.id === "unassoc-protected");
    expect(unassoc).toMatchObject({ via: "centroid", protection: "explicit" });
  });

  it("restricts centroid fallback to authored records: generated provenance with stale associations stays out", () => {
    const { source, plan, westBlock } = westBlockIds();
    const scope = resolveRegenerationTargetScope(plan, { kind: "block", ids: [westBlock] })!;
    const members = resolveRegenerationMemberships(source, plan, scope);
    const ids = members.map((member) => member.id);
    // Authored provenance: an absent or stale association falls back to site-centroid ownership.
    expect(members.find((member) => member.id === "stale-assoc")).toMatchObject({ via: "centroid", origin: "persistent" });
    // Generated provenance (including promoted generated records): a stale association
    // keeps the record out entirely — proximity never rescues it. The adapter must
    // assign valid associations on manually transformed promotions so future
    // regeneration can target them by association.
    expect(ids).not.toContain("stale-generated");
  });

  it("classifies derived plan objects by their stable fragment associations", () => {
    const { source, plan } = westBlockIds();
    const scope = resolveRegenerationTargetScope(plan, { kind: "district", ids: ["west"] })!;
    const members = resolveRegenerationMemberships(source, plan, scope);
    const derived = members.filter((member) => member.origin === "derived");
    expect(derived.length).toBeGreaterThan(0);
    const derivedBuildings = derived.filter((member) => member.kind === "building");
    expect(derivedBuildings.length).toBeGreaterThan(0);
    // Derived buildings always carry their fragment's block association, and derived
    // objects are never pulled in by centroid proximity: absent lineage keeps them out.
    expect(derivedBuildings.every((member) => member.via === "association")).toBe(true);
    const outOfDistrictDerived = members.filter((member) => {
      if (member.origin !== "derived") return false;
      const planObject = plan.buildings.find((candidate) => candidate.id === member.id)
        ?? plan.landmarks.find((candidate) => candidate.id === member.id);
      return planObject !== undefined && planObject.districtId !== "west";
    });
    expect(outOfDistrictDerived).toEqual([]);
  });

  it("resolves district membership through district associations", () => {
    const { source, plan } = westBlockIds();
    const scope = resolveRegenerationTargetScope(plan, { kind: "district", ids: ["west"] })!;
    const members = resolveRegenerationMemberships(source, plan, scope);
    const ids = members.map((member) => member.id);
    expect(ids).toContain("assoc-west");
    expect(ids).toContain("unassoc-protected");
    expect(ids).toContain("stale-assoc");
    expect(ids).not.toContain("stale-generated");
    // The misassociated record belongs to the east district: its geometry lies inside
    // the west district, but the association wins and proximity never pulls it in.
    expect(ids).not.toContain("misassociated");
    expect(ids).not.toContain("assoc-east");
    expect(ids).not.toContain("east-unassoc");
  });
});

describe("Phase 6 regeneration preflight", () => {
  const westBlockIds = () => {
    const source = baseSource();
    const plan = build(source);
    return { plan, westBlock: blockIdAt(plan, 100, 100), eastBlock: blockIdAt(plan, 500, 100) };
  };

  /** Derived buildings exist per district planning; the target block is derived from a real one. */
  const derivedTargets = (plan: CompleteCityPlan): { inTarget: BuildingPlan; outside: BuildingPlan; inBlock: string; outBlock: string } => {
    const inTarget = plan.buildings.find((candidate) =>
      candidate.sourceId === null && candidate.districtId === "west" && candidate.blockId !== null && candidate.placement !== undefined);
    const outside = plan.buildings.find((candidate) =>
      candidate.sourceId === null && candidate.districtId === "east" && candidate.blockId !== null && candidate.placement !== undefined);
    if (inTarget === undefined || outside === undefined) throw new Error("Fixture: plan lacks derived buildings in both districts.");
    return { inTarget, outside, inBlock: inTarget.blockId!, outBlock: outside.blockId! };
  };

  it("removes every unprotected target record regardless of origin and reserves protected sites", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const source = baseSource(membershipArchitecture(westBlock, eastBlock));
    const result = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock] }, "seed-alpha");
    expect(result.blockers).toEqual([]);
    expect(result.retainedIds).toEqual(["unassoc-protected"]);
    const candidate = result.candidateSource!;
    const surviving = candidate.architecture.buildings.map((record) => record.id);
    expect(surviving).toEqual(expect.arrayContaining(["assoc-east", "east-unassoc", "misassociated", "unassoc-protected", "stale-generated"]));
    expect(surviving).not.toEqual(expect.arrayContaining(["assoc-west", "stale-assoc"]));
    expect(candidate.architecture.buildings.find((record) => record.id === "unassoc-protected")).toStrictEqual(
      source.architecture.buildings.find((record) => record.id === "unassoc-protected")
    );
    // Roads and outside-scope content stay identity-stable.
    expect(candidate.roads).toStrictEqual(source.roads);
    expect(candidate.districts).toStrictEqual(source.districts);
    expect(candidate.terrain).toStrictEqual(source.terrain);
    expect(candidate.architecture.buildings.find((record) => record.id === "east-unassoc")).toStrictEqual(
      source.architecture.buildings.find((record) => record.id === "east-unassoc")
    );
  });

  it("writes one new partial-seed record and preserves older overlapping records", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const source = baseSource(membershipArchitecture(westBlock, eastBlock));
    const first = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock] }, "seed-alpha");
    expect(first.candidateSource!.regeneration.partialSeeds).toEqual([
      { targetKind: "block", targetId: westBlock, seed: "seed-alpha", order: 1 }
    ]);
    const withHistory = baseSource(membershipArchitecture(westBlock, eastBlock));
    withHistory.regeneration.partialSeeds = [
      { targetKind: "district", targetId: "west", seed: "district-seed", order: 1 },
      { targetKind: "block", targetId: westBlock, seed: "old-block-seed", order: 2 }
    ];
    const second = evaluateRegenerationPreflight(withHistory, plan, { kind: "block", ids: [westBlock] }, "seed-beta");
    expect(second.candidateSource!.regeneration.partialSeeds).toEqual([
      { targetKind: "district", targetId: "west", seed: "district-seed", order: 1 },
      { targetKind: "block", targetId: westBlock, seed: "seed-beta", order: 3 }
    ]);
  });

  it("promotes protected target overrides to exact persistent snapshots via the shared helper", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const { inTarget: derivedInTarget, outside: derivedOutside, inBlock } = derivedTargets(plan);
    const overrideFor = (planId: string, lineage: string, sitePolygon: Ring, protection: ArchitectureOverrideSource["protection"]): ArchitectureOverrideSource => ({
      targetKind: "building",
      targetId: planId,
      lineage,
      protection,
      snapshotSitePolygon: sitePolygon,
      appearanceSeed: `regen/override-appearance/${planId}`,
      paletteId: DISTRICT_PALETTE_IDS[2]!
    });
    const architecture = membershipArchitecture(westBlock, eastBlock);
    architecture.overrides = [
      overrideFor(derivedInTarget!.id, derivedInTarget!.lineage, derivedInTarget!.sitePolygon, "explicit"),
      overrideFor(derivedOutside!.id, derivedOutside!.lineage, derivedOutside!.sitePolygon, "explicit")
    ];
    const source = baseSource(architecture);
    const result = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [inBlock] }, "seed-promote");
    expect(result.blockers).toEqual([]);
    expect(result.retainedIds).toContain(derivedInTarget!.id);
    const promoted = result.candidateSource!.architecture.buildings.find((record) => record.id === derivedInTarget!.id);
    expect(promoted).toBeDefined();
    expect(promoted!.origin).toBe("generated");
    expect(promoted!.protection).toBe("explicit");
    expect(promoted!.lineage).toBe(derivedInTarget!.lineage);
    expect(promoted!.sitePolygon).toStrictEqual(derivedInTarget!.sitePolygon);
    expect(promoted!.appearanceSeed).toBe(`regen/override-appearance/${derivedInTarget!.id}`);
    expect(promoted!.paletteId).toBe(DISTRICT_PALETTE_IDS[2]!);
    // Out-of-target override: retained untouched, never promoted, never orphaned.
    expect(result.candidateSource!.architecture.overrides).toHaveLength(1);
    expect(result.candidateSource!.architecture.overrides[0]!.targetId).toBe(derivedOutside!.id);
    // The input source is never mutated by preflight.
    expect(source.architecture.overrides).toHaveLength(2);
  });

  it("drops an unprotected target override with the regenerated content", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const { inTarget: derivedInTarget, outside: derivedOutside, inBlock } = derivedTargets(plan);
    const architecture = membershipArchitecture(westBlock, eastBlock);
    architecture.overrides = [
      {
        targetKind: "building",
        targetId: derivedInTarget!.id,
        lineage: derivedInTarget!.lineage,
        protection: "none",
        snapshotSitePolygon: derivedInTarget!.sitePolygon
      },
      {
        targetKind: "building",
        targetId: derivedOutside!.id,
        lineage: derivedOutside!.lineage,
        protection: "none",
        snapshotSitePolygon: derivedOutside!.sitePolygon
      }
    ];
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [inBlock] }, "seed-none");
    expect(result.blockers).toEqual([]);
    expect(result.candidateSource!.architecture.overrides).toHaveLength(1);
    expect(result.candidateSource!.architecture.overrides[0]!.targetId).toBe(derivedOutside!.id);
    expect(result.candidateSource!.architecture.buildings.some((record) => record.id === derivedInTarget!.id)).toBe(false);
  });

  it("reports an override whose derived object no longer exists instead of promoting it", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const architecture = membershipArchitecture(westBlock, eastBlock);
    architecture.overrides = [{
      targetKind: "building",
      targetId: "building-never-existed",
      lineage: "regen/lineage/building-never-existed",
      protection: "explicit",
      snapshotSitePolygon: siteRect(100, 100, 72)
    }];
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [westBlock] }, "seed-orphan");
    expect(result.candidateSource).toBeNull();
    const overrideBlockers = result.blockers.filter((blocker) => blocker.kind === "override");
    expect(overrideBlockers).toHaveLength(1);
    expect(overrideBlockers[0]!.id).toBe("building:building-never-existed");
    expect(overrideBlockers[0]!.reason).toContain("building-never-existed");
  });

  it("matches override lineage strictly instead of treating missing lineage as a wildcard", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const { inTarget: derivedInTarget, inBlock } = derivedTargets(plan);
    const architecture = membershipArchitecture(westBlock, eastBlock);
    architecture.overrides = [
      ({ targetKind: "building", targetId: derivedInTarget!.id, protection: "explicit", snapshotSitePolygon: derivedInTarget!.sitePolygon } as unknown as ArchitectureOverrideSource),
      { targetKind: "building", targetId: derivedInTarget!.id, lineage: "", protection: "explicit", snapshotSitePolygon: derivedInTarget!.sitePolygon },
      { targetKind: "building", targetId: derivedInTarget!.id, lineage: "regen/lineage/someone-else", protection: "explicit", snapshotSitePolygon: derivedInTarget!.sitePolygon }
    ];
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [inBlock] }, "seed-lineage");
    expect(result.candidateSource).toBeNull();
    const overrideBlockers = result.blockers.filter((blocker) => blocker.kind === "override");
    expect(overrideBlockers).toHaveLength(3);
  });

  it("cleans up stale unprotected overrides instead of blocking ordinary regeneration", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const { outside: derivedOutside } = derivedTargets(plan);
    const architecture = membershipArchitecture(westBlock, eastBlock);
    architecture.overrides = [
      ({ targetKind: "building", targetId: "building-never-existed", protection: "none", snapshotSitePolygon: siteRect(100, 100, 72) } as unknown as ArchitectureOverrideSource),
      { targetKind: "building", targetId: derivedOutside!.id, lineage: derivedOutside!.lineage, protection: "none", snapshotSitePolygon: derivedOutside!.sitePolygon }
    ];
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [westBlock] }, "seed-cleanup");
    expect(result.blockers).toEqual([]);
    expect(result.candidateSource).not.toBeNull();
    // The stale unprotected override is dropped; the live out-of-target one survives.
    expect(result.candidateSource!.architecture.overrides).toHaveLength(1);
    expect(result.candidateSource!.architecture.overrides[0]!.targetId).toBe(derivedOutside!.id);
  });

  it("refuses promotion when a protected override's snapshot site no longer matches the derived object", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const { inTarget: derivedInTarget, inBlock } = derivedTargets(plan);
    const architecture = membershipArchitecture(westBlock, eastBlock);
    architecture.overrides = [{
      targetKind: "building",
      targetId: derivedInTarget!.id,
      lineage: derivedInTarget!.lineage,
      protection: "explicit",
      snapshotSitePolygon: derivedInTarget!.sitePolygon.map((point) => ({ x: point.x + 20, y: point.y + 20 }))
    }];
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [inBlock] }, "seed-snapshot");
    expect(result.candidateSource).toBeNull();
    expect(result.blockers.some((blocker) => blocker.kind === "building" && blocker.id === derivedInTarget!.id && blocker.reason.includes("snapshot site polygon"))).toBe(true);
  });

  it("rejects the whole action when independently protected objects sit inside a replaced compound site", () => {
    const { plan, westBlock } = westBlockIds();
    const architecture: CitySourceV5["architecture"] = {
      buildings: [
        building("insider-one", 75, 100, "explicit", { sitePolygon: siteRect(75, 100, 40), placement: placement(75, 100, 28) }),
        building("insider-two", 125, 100, "explicit", { sitePolygon: siteRect(125, 100, 40), placement: placement(125, 100, 28) })
      ],
      places: [place("compound-site", 100, 100, "none")],
      overrides: []
    };
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [westBlock] }, "seed-compound");
    expect(result.candidateSource).toBeNull();
    expect(result.blockers.map((blocker) => blocker.id).sort()).toEqual(["insider-one", "insider-two"]);
    for (const blocker of result.blockers) {
      expect(blocker.kind).toBe("building");
      expect(blocker.reason).toContain("compound-site");
    }
    // The same geometry with a protected compound is fully retained: locks are
    // independent and the protected compound is retained with its site reserved.
    const retained = baseSource({
      ...architecture,
      places: [place("compound-site", 100, 100, "explicit")]
    });
    const retainedResult = evaluateRegenerationPreflight(retained, plan, { kind: "block", ids: [westBlock] }, "seed-compound");
    expect(retainedResult.blockers).toEqual([]);
    expect(retainedResult.retainedIds.sort()).toEqual(["compound-site", "insider-one", "insider-two"]);
    expect(retainedResult.removedIds).toEqual([]);
    expect(retainedResult.excludedSitePolygons).toHaveLength(3);
  });

  it("counts protected source records associated outside the target as compound insiders", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const architecture: CitySourceV5["architecture"] = {
      buildings: [
        building("outside-assoc-insider", 100, 100, "explicit", { blockId: eastBlock, districtId: "east" })
      ],
      places: [place("compound-site", 100, 100, "none")],
      overrides: []
    };
    const result = evaluateRegenerationPreflight(baseSource(architecture), plan, { kind: "block", ids: [westBlock] }, "seed-insider");
    expect(result.candidateSource).toBeNull();
    expect(result.blockers.map((blocker) => blocker.id)).toEqual(["outside-assoc-insider"]);
  });

  it("enumerates target and seed validation blockers without generating a candidate", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const source = baseSource(membershipArchitecture(westBlock, eastBlock));
    const unknownBlock = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock, "block-unknown"] }, "seed");
    expect(blockerIds(unknownBlock.blockers)).toContain("block-unknown");
    expect(unknownBlock.candidateSource).toBeNull();
    const twoDistricts = evaluateRegenerationPreflight(source, plan, { kind: "district", ids: ["west", "east"] }, "seed");
    expect(twoDistricts.blockers.some((blocker) => blocker.kind === "target")).toBe(true);
    const unknownDistrict = evaluateRegenerationPreflight(source, plan, { kind: "district", ids: ["nowhere"] }, "seed");
    expect(blockerIds(unknownDistrict.blockers)).toContain("nowhere");
    const emptySeed = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock] }, "");
    expect(emptySeed.blockers.some((blocker) => blocker.kind === "seed")).toBe(true);
    const paddedSeed = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock] }, " padded ");
    expect(paddedSeed.blockers.some((blocker) => blocker.kind === "seed")).toBe(true);
    for (const result of [unknownBlock, twoDistricts, unknownDistrict, emptySeed, paddedSeed]) {
      expect(result.candidateSource).toBeNull();
    }
  });

  it("rejects target id lists containing non-string entries instead of dropping them", () => {
    const { plan, westBlock } = westBlockIds();
    const source = baseSource();
    const mixed = evaluateRegenerationPreflight(
      source,
      plan,
      { kind: "block", ids: [westBlock, 42 as unknown as string] },
      "seed-mixed"
    );
    expect(mixed.candidateSource).toBeNull();
    expect(mixed.blockers.some((blocker) => blocker.kind === "target" && blocker.reason.includes("non-empty text"))).toBe(true);
  });

  it("is deterministic between the pre-generation and commit-revision runs", () => {
    const { plan, westBlock, eastBlock } = westBlockIds();
    const source = baseSource(membershipArchitecture(westBlock, eastBlock));
    const first = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock] }, "seed-stable");
    const second = evaluateRegenerationPreflight(source, plan, { kind: "block", ids: [westBlock] }, "seed-stable");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.candidateSource).not.toBeNull();
  });
});
