// WHY fixture-first: the fixture module installs the hoisted vi.mock registrations for
// ./city-cache.js and ../render/city-renderer.js and stubs the Worker global; the adapter
// must be imported after those mocks are arranged.
import "./phase6-test-fixture.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import { BUILDING_GRAMMAR_REGISTRY, type BuildingGrammarId } from "../core/gen/building-registry.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV5, type CityStateV5, type PersistentBuildingSource, type PersistentPlaceSource, type PlacementFrame, type RoadSource } from "../core/gen/city.js";
import { buildCompleteCityPlan, occupiedPersistentBuildingGeometry, type CompleteCityPlan } from "../core/gen/complete-city-plan.js";
import { compiledRouteOccupancy } from "../core/gen/district-plan.js";
import { analyzeRouteConflicts } from "../core/graph/topology.js";
import { compileRouteNetwork } from "../core/graph/compiler.js";
import { intersection, isSnapNoise, ringAsMulti } from "../core/geom/boolean.js";
import { ringBounds, type MultiPolygon, type Ring, type Vec2 } from "../core/geom/types.js";
import { mountPhase6Fixture, phase6Source, type Phase6Fixture } from "./phase6-test-fixture.js";
import {
  bulkDeleteObjects,
  bulkEditObjects,
  bulkSetObjectsLocked,
  getRouteEditStatus,
  placeBuilding,
  transformObject,
  undo,
  redo
} from "./terrain-canvas.js";

// ---------------------------------------------------------------------------
// Deterministic authored-record helpers. Every mass footprint is contained in its
// own site polygon, so authored records materialize identically regardless of the
// surrounding procedural plan.
// ---------------------------------------------------------------------------

const rectAt = (centreX: number, centreY: number, width: number, depth: number): Ring => [
  { x: centreX - width / 2, y: centreY - depth / 2 },
  { x: centreX + width / 2, y: centreY - depth / 2 },
  { x: centreX + width / 2, y: centreY + depth / 2 },
  { x: centreX - width / 2, y: centreY + depth / 2 }
];

const frameAt = (centreX: number, centreY: number, width: number, depth: number): PlacementFrame => ({
  centre: { x: centreX, y: centreY },
  rotationRad: 0,
  widthM: width,
  depthM: depth
});

const authoredBuilding = (
  id: string,
  centreX: number,
  centreY: number,
  width: number,
  depth: number,
  heightM = 18,
  grammarId: BuildingGrammarId = "infill-rowhouse",
  visualUse: PersistentBuildingSource["visualUse"] = "residential"
): PersistentBuildingSource => ({
  id,
  lineage: `architecture/lineage/${id}`,
  origin: "authored",
  protection: "none",
  seed: `architecture/geometry/${id}`,
  appearanceSeed: `architecture/appearance/${id}`,
  grammarId,
  visualUse,
  heightM,
  paletteId: null,
  sitePolygon: rectAt(centreX, centreY, width, depth),
  placement: frameAt(centreX, centreY, width, depth),
  districtId: null,
  blockId: null
});

const authoredPlace = (id: string, centreX: number, centreY: number): PersistentPlaceSource => ({
  id,
  lineage: `architecture/place-lineage/${id}`,
  origin: "authored",
  protection: "none",
  seed: `architecture/place-geometry/${id}`,
  appearanceSeed: `architecture/place-appearance/${id}`,
  landmarkGrammarId: "hero-tower-plaza",
  paletteId: null,
  sitePolygon: rectAt(centreX, centreY, 56, 56),
  placement: frameAt(centreX, centreY, 44, 44),
  districtId: null,
  blockId: null
});

/** First deterministic road-free rect centre for a persistent-record site: places must
 * stay clear of the compiled road occupancy and no persistent site may overlap a peer
 * persistent site, so the fixture scans the land grid. */
function roadFreeCentre(source: CitySourceV5, width: number, depth: number, peers: readonly Ring[] = []): Vec2 {
  const occupancy = compiledRouteOccupancy(compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY)).all;
  const bounds = ringBounds(source.terrain.land);
  for (let y = bounds.y + depth / 2; y <= bounds.y + bounds.height - depth / 2; y += 8) {
    for (let x = bounds.x + width / 2; x <= bounds.x + bounds.width - width / 2; x += 8) {
      const rect = rectAt(x, y, width, depth);
      if (!isSnapNoise(intersection(ringAsMulti(rect), occupancy))) continue;
      if (peers.some((peer) => !isSnapNoise(intersection(ringAsMulti(rect), ringAsMulti(peer))))) continue;
      return { x, y };
    }
  }
  throw new Error("records fixture found no road-free site");
}
const chainRoads = (locked: readonly string[] = []): RoadSource => ({
  nodes: [
    { id: "a", x: -80, y: 0 },
    { id: "b", x: -20, y: 0 },
    { id: "c", x: 20, y: 0 },
    { id: "d", x: 80, y: 0 }
  ],
  routes: [{ id: "route-h", curvePreset: "standard" }],
  edges: [
    { id: "ab", a: "a", b: "b", routeId: "route-h", classId: "street", name: null, locked: locked.includes("ab"), origin: "authored" },
    { id: "bc", a: "b", b: "c", routeId: "route-h", classId: "street", name: null, locked: locked.includes("bc"), origin: "authored" },
    { id: "cd", a: "c", b: "d", routeId: "route-h", classId: "street", name: null, locked: locked.includes("cd"), origin: "authored" }
  ]
});

/** One long straight source edge whose middle the placement tests occupy. */
const straightRoads = (locked: readonly string[] = []): RoadSource => ({
  nodes: [
    { id: "a", x: -80, y: 0 },
    { id: "d", x: 80, y: 0 }
  ],
  routes: [{ id: "route-h", curvePreset: "standard" }],
  edges: [
    { id: "ad", a: "a", b: "d", routeId: "route-h", classId: "street", name: null, locked: locked.includes("ad"), origin: "authored" }
  ]
});

const twinRoads = (locked: readonly string[] = []): RoadSource => ({
  nodes: [
    { id: "a", x: -80, y: 0 },
    { id: "b", x: -20, y: 0 },
    { id: "c", x: 20, y: 0 },
    { id: "d", x: 80, y: 0 }
  ],
  routes: [{ id: "route-h", curvePreset: "standard" }],
  edges: [
    { id: "ab", a: "a", b: "b", routeId: "route-h", classId: "street", name: null, locked: locked.includes("ab"), origin: "authored" },
    { id: "cd", a: "c", b: "d", routeId: "route-h", classId: "street", name: null, locked: locked.includes("cd"), origin: "authored" }
  ]
});

/** Self-contained route-test city: rectangle land, the given roads, no districts. */
function routeSource(roads: RoadSource, buildings: readonly PersistentBuildingSource[]): CitySourceV5 {
  return {
    origin: { x: 500, y: 400 },
    citySeed: "phase6-route-surgery",
    generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
    terrain: { land: [{ x: -100, y: -80 }, { x: 100, y: -80 }, { x: 100, y: 80 }, { x: -100, y: 80 }], urbanFootprint: null },
    roads,
    districts: [],
    architecture: { buildings: [...buildings], places: [], overrides: [] },
    regeneration: { partialSeeds: [] }
  };
}


/** Fixture city plus authored records the bulk actions operate on. Every record site is
 * scanned road-free against the compiled generated-road occupancy, so the valid-source
 * planner accepts the mount: building materialized masses stay inside their site (route
 * legality is mass-level) and the place keeps the whole-site rule. bulk-locked carries
 * the explicit protection the delete/edit blockers assert. */
function recordsSource(): CitySourceV5 {
  const base = phase6Source();
  const peers: Ring[] = [];
  const site = (width: number, depth: number): Vec2 => {
    const centre = roadFreeCentre(base, width, depth, peers);
    peers.push(rectAt(centre.x, centre.y, width, depth));
    return centre;
  };
  const place = site(56, 56);
  const first = site(24, 16);
  const second = site(24, 16);
  const locked = site(24, 16);
  return {
    ...base,
    architecture: {
      buildings: [
        ...base.architecture.buildings,
        authoredBuilding("bulk-b1", first.x, first.y, 24, 16),
        authoredBuilding("bulk-b2", second.x, second.y, 24, 16),
        { ...authoredBuilding("bulk-locked", locked.x, locked.y, 24, 16), protection: "explicit" }
      ],
      places: [...base.architecture.places, authoredPlace("bulk-p1", place.x, place.y)],
      overrides: [...base.architecture.overrides]
    }
  };
}

function storedBuilding(city: CityStateV5, id: string): PersistentBuildingSource {
  const record = city.source.architecture.buildings.find((building) => building.id === id);
  expect(record).toBeDefined();
  return record!;
}

/** Midpoint of a grammar's legal height range: always materializable, usually a change. */
function midGrammarHeight(grammarId: BuildingGrammarId): number {
  const grammar = BUILDING_GRAMMAR_REGISTRY.get(grammarId)!;
  return grammar.height.minM + (grammar.height.maxM - grammar.height.minM) / 2;
}

function totalBlockedArcM(conflict: { blockedArcM: ReadonlyArray<{ startM: number; endM: number }> }): number {
  return conflict.blockedArcM.reduce((sum, interval) => sum + (interval.endM - interval.startM), 0);
}

function massExtentX(occupied: MultiPolygon): { min: number; max: number } {
  const points = occupied.flat(2);
  const xs = points.map((point) => point.x);
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

// ---------------------------------------------------------------------------
// Bulk architecture actions over the real Worker/plan pipeline.
// ---------------------------------------------------------------------------

describe("Phase 6 bulk architecture actions", () => {
  let fixture: Phase6Fixture;

  beforeEach(async () => {
    fixture = await mountPhase6Fixture(recordsSource());
  });

  afterEach(() => {
    fixture.dispose();
  });

  function stored(): CityStateV5 {
    const city = fixture.getStored();
    expect(city).toBeDefined();
    return city!;
  }

  /** Derived (plan-only) buildings: resolvable through the retained plan, promotable. */
  function derivedBuildings(): CompleteCityPlan["buildings"] {
    const city = stored();
    return buildCompleteCityPlan(city.source, city.revision).buildings.filter(
      (building) => building.sourceId === null && building.placement !== undefined
    );
  }

  function saves(): number {
    return fixture.scene.setFlag.mock.calls.length;
  }

  it("locks two authored records with one save, one revision, and one history step", async () => {
    const revision = stored().revision;
    const savesBefore = saves();
    const setsBefore = fixture.renderer.sets.length;
    const clearsBefore = fixture.renderer.clears;

    await bulkSetObjectsLocked(["bulk-b1", "bulk-b2"], true);

    expect(stored().revision).toBe(revision + 1);
    expect(saves() - savesBefore).toBe(1);
    expect(storedBuilding(stored(), "bulk-b1").protection).toBe("explicit");
    expect(storedBuilding(stored(), "bulk-b2").protection).toBe("explicit");
    // Scoped reinstall: affected chunks are pushed again, nothing is cleared wholesale.
    expect(fixture.renderer.sets.length - setsBefore).toBeGreaterThan(0);
    expect(fixture.renderer.clears - clearsBefore).toBe(0);

    await expect(undo()).resolves.toBe(true);
    expect(stored().revision).toBe(revision + 2);
    expect(storedBuilding(stored(), "bulk-b1").protection).toBe("none");
    expect(storedBuilding(stored(), "bulk-b2").protection).toBe("none");

    await expect(redo()).resolves.toBe(true);
    expect(storedBuilding(stored(), "bulk-b1").protection).toBe("explicit");
    expect(storedBuilding(stored(), "bulk-b2").protection).toBe("explicit");
  }, 120_000);

  it("locks a derived object as explicit protection and releases it back to none", async () => {
    const derived = derivedBuildings()[0]!;
    const revision = stored().revision;

    await bulkSetObjectsLocked([derived.id], true);

    expect(stored().revision).toBe(revision + 1);
    // Locking a derived object persists its protection across plan rebuilds: the
    // commit materializes the explicit override into a record (override consumed) —
    // either representation must carry the explicit protection.
    const lockedRecord = stored().source.architecture.buildings.find((building) => building.id === derived.id);
    const lockedOverride = stored().source.architecture.overrides.find((candidate) => candidate.targetId === derived.id);
    expect(lockedRecord !== undefined || lockedOverride !== undefined).toBe(true);
    expect(lockedRecord?.protection ?? lockedOverride?.protection).toBe("explicit");

    await bulkSetObjectsLocked([derived.id], false);

    const releasedRecord = stored().source.architecture.buildings.find((building) => building.id === derived.id);
    const releasedOverride = stored().source.architecture.overrides.find((candidate) => candidate.targetId === derived.id);
    expect(releasedRecord !== undefined || releasedOverride !== undefined).toBe(true);
    expect(releasedRecord?.protection ?? releasedOverride?.protection).toBe("none");
  }, 120_000);

  it("promotes every substantially edited derived member in one bulk edit and one save", async () => {
    const pool = derivedBuildings();
    const grammarId = pool[0]!.grammarId;
    const members = pool.filter((building) => building.grammarId === grammarId).slice(0, 2);
    expect(members).toHaveLength(2);
    const height = midGrammarHeight(grammarId);
    const revision = stored().revision;
    const savesBefore = saves();

    await bulkEditObjects(members.map((building) => building.id), { heightM: height });

    expect(stored().revision).toBe(revision + 1);
    expect(saves() - savesBefore).toBe(1);
    for (const member of members) {
      const record = stored().source.architecture.buildings.find((building) => building.id === member.id);
      expect(record).toBeDefined();
      expect(record).toMatchObject({ origin: "generated", protection: "manual-edit", grammarId, heightM: height });
      expect(stored().source.architecture.overrides.some((candidate) => candidate.targetId === member.id)).toBe(false);
    }

    // One undo step reverts the whole bulk edit: both promotions disappear together.
    await expect(undo()).resolves.toBe(true);
    expect(stored().revision).toBe(revision + 2);
    for (const member of members) {
      expect(stored().source.architecture.buildings.some((building) => building.id === member.id)).toBe(false);
    }
  }, 120_000);

  it("applies a palette-only edit to a derived object without a substantial change", async () => {
    const pool = derivedBuildings();
    const derived = pool[1] ?? pool[0]!;
    const paletteId = DISTRICT_PALETTE_IDS[4]!;
    const revision = stored().revision;

    await bulkEditObjects([derived.id], { paletteId });

    expect(stored().revision).toBe(revision + 1);
    // The protected manual-edit override is materialized into a persistent record at
    // commit time; either representation must carry the palette and no substantial
    // promotion (grammar/height) may have happened.
    const override = stored().source.architecture.overrides.find((candidate) => candidate.targetId === derived.id);
    const record = stored().source.architecture.buildings.find((building) => building.id === derived.id);
    if (record !== undefined) {
      expect(record).toMatchObject({ origin: "generated", protection: "manual-edit", paletteId, grammarId: derived.grammarId, heightM: derived.heightM });
      expect(override).toBeUndefined();
    } else {
      expect(override).toMatchObject({ protection: "manual-edit", paletteId });
    }
  }, 120_000);

  it("rejects a mixed-kind selection naming the exact blocker and changes nothing", async () => {
    const before = structuredClone(fixture.getStored());
    let error: unknown;
    try {
      await bulkSetObjectsLocked(["bulk-b1", "bulk-p1"], true);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error & { blockers?: unknown }).blockers).toEqual([
      { id: "selection", kind: "selection", reason: "Bulk selection must contain objects of a single type; found building and place objects." }
    ]);
    expect(fixture.getStored()).toEqual(before);
  }, 120_000);

  it("enumerates missing, locked, and nondeletable delete members with exact blockers and changes nothing", async () => {
    const derived = derivedBuildings()[0]!;
    const before = structuredClone(fixture.getStored());
    let error: unknown;
    try {
      await bulkDeleteObjects([derived.id, "bulk-ghost", "bulk-locked"]);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error & { blockers?: unknown }).blockers).toEqual([
      { id: "bulk-ghost", kind: "unknown", reason: 'Unknown architecture object "bulk-ghost".' },
      { id: derived.id, kind: "building", reason: "Derived architecture objects cannot be deleted." },
      { id: "bulk-locked", kind: "building", reason: "The architecture object is locked." }
    ]);
    expect(fixture.getStored()).toEqual(before);
  }, 120_000);

  it("rejects editing a locked member with the exact blocker and changes nothing", async () => {
    const before = structuredClone(fixture.getStored());
    let error: unknown;
    try {
      await bulkEditObjects(["bulk-locked"], { heightM: 20 });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error & { blockers?: unknown }).blockers).toEqual([
      { id: "bulk-locked", kind: "building", reason: "The architecture object is locked." }
    ]);
    expect(fixture.getStored()).toEqual(before);
  }, 120_000);

  it("rejects an explicitly staged stale expectedRevision before any save", async () => {
    const revision = stored().revision;
    await bulkSetObjectsLocked(["bulk-b1"], true);
    expect(stored().revision).toBe(revision + 1);

    const snapshot = structuredClone(fixture.getStored());
    await expect(bulkSetObjectsLocked(["bulk-b1"], false, revision)).rejects.toThrow(/superseded by a newer city revision/);
    expect(fixture.getStored()).toEqual(snapshot);
  }, 120_000);

  it("captures the expected revision at call time so an action queued behind a commit goes stale without saving", async () => {
    const derived = derivedBuildings()[0]!;
    const revision = stored().revision;

    fixture.worker.delayNextPlan();
    const edit = bulkEditObjects([derived.id], { heightM: midGrammarHeight(derived.grammarId) });
    await fixture.worker.whenPlanDelayed();

    // Queued behind the parked edit while the city is still at `revision`; its expected
    // revision is captured now, at call time, not when the queue reaches it.
    const lock = bulkSetObjectsLocked(["bulk-b1"], true);

    fixture.worker.releasePlan();
    await edit;
    expect(stored().revision).toBe(revision + 1);

    await expect(lock).rejects.toThrow(/superseded by a newer city revision/);
    expect(stored().revision).toBe(revision + 1);
    expect(storedBuilding(stored(), "bulk-b1").protection).toBe("none");
  }, 120_000);

  it("deletes authored records in one save and reverts them together in a single undo step", async () => {
    const b1 = structuredClone(storedBuilding(stored(), "bulk-b1"));
    const b2 = structuredClone(storedBuilding(stored(), "bulk-b2"));
    const revision = stored().revision;
    const savesBefore = saves();
    const setsBefore = fixture.renderer.sets.length;
    const clearsBefore = fixture.renderer.clears;

    await bulkDeleteObjects(["bulk-b1", "bulk-b2"]);

    expect(stored().revision).toBe(revision + 1);
    expect(saves() - savesBefore).toBe(1);
    expect(stored().source.architecture.buildings.some((building) => building.id === "bulk-b1")).toBe(false);
    expect(stored().source.architecture.buildings.some((building) => building.id === "bulk-b2")).toBe(false);
    expect(fixture.renderer.sets.length - setsBefore).toBeGreaterThan(0);
    expect(fixture.renderer.clears - clearsBefore).toBe(0);

    await expect(undo()).resolves.toBe(true);
    expect(stored().revision).toBe(revision + 2);
    expect(storedBuilding(stored(), "bulk-b1")).toEqual(b1);
    expect(storedBuilding(stored(), "bulk-b2")).toEqual(b2);

    await expect(redo()).resolves.toBe(true);
    expect(stored().revision).toBe(revision + 3);
    expect(stored().source.architecture.buildings.some((building) => building.id === "bulk-b1")).toBe(false);
    expect(stored().source.architecture.buildings.some((building) => building.id === "bulk-b2")).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Route surgery through the real adapter path: authored placement, transform, and
// bulk geometry edits whose materialized masses cross roads.
// ---------------------------------------------------------------------------

describe("Phase 6 route surgery through adapter actions", () => {
  let fixture: Phase6Fixture | undefined;

  afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
  });

  function stored(): CityStateV5 {
    expect(fixture).toBeDefined();
    const city = fixture!.getStored();
    expect(city).toBeDefined();
    return city!;
  }

  function edgeEndpoints(source: RoadSource, edgeId: string): [Vec2, Vec2] {
    const edge = source.edges.find((candidate) => candidate.id === edgeId);
    expect(edge).toBeDefined();
    const a = source.nodes.find((node) => node.id === edge!.a);
    const b = source.nodes.find((node) => node.id === edge!.b);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    return [a!, b!];
  }

  it("does not report route surgery as committed when the Scene save rejects", async () => {
    fixture = await mountPhase6Fixture(routeSource(straightRoads(), []));
    const before = structuredClone(stored());
    fixture.scene.setFlag.mockRejectedValueOnce(new Error("Scene write denied"));

    await expect(placeBuilding({
      grammarId: "infill-rowhouse",
      visualUse: "residential",
      heightM: 18,
      paletteId: null,
      placement: frameAt(0, 0, 40, 24),
      sitePolygon: rectAt(0, 0, 40, 24)
    })).rejects.toThrow("Scene write denied");

    expect(stored()).toEqual(before);
    expect(getRouteEditStatus()).toBeNull();
  }, 120_000);

  it("trims an unlocked straight road into outside fragments when a placed building crosses it, warning about the disconnected network", async () => {
    fixture = await mountPhase6Fixture(routeSource(straightRoads(), []));
    const before = structuredClone(stored().source.roads);
    const revision = stored().revision;
    const savesBefore = fixture.scene.setFlag.mock.calls.length;

    await placeBuilding({
      grammarId: "infill-rowhouse",
      visualUse: "residential",
      heightM: 18,
      paletteId: null,
      placement: frameAt(0, 0, 40, 24),
      sitePolygon: rectAt(0, 0, 40, 24)
    });

    const city = stored();
    expect(city.revision).toBe(revision + 1);
    expect(fixture.scene.setFlag.mock.calls.length - savesBefore).toBe(1);
    expect(city.source.architecture.buildings).toHaveLength(1);

    // Grounding: the committed record's materialized masses really cross the road.
    const occupied = occupiedPersistentBuildingGeometry(city.source.architecture.buildings[0]!, city.source);
    expect(analyzeRouteConflicts(before, occupied).map((conflict) => conflict.edgeId)).toEqual(["ad"]);

    // One straight edge became two outside fragments; the blocked middle is gone.
    expect(city.source.roads.edges).toHaveLength(2);
    expect(city.source.roads.edges.map((edge) => edge.id)).toContain("ad");
    const extent = massExtentX(occupied);
    const [westA, westB] = edgeEndpoints(city.source.roads, "ad");
    expect(Math.max(westA.x, westB.x)).toBeLessThan(extent.min);
    const child = city.source.roads.edges.find((edge) => edge.id !== "ad")!;
    const [childA, childB] = edgeEndpoints(city.source.roads, child.id);
    expect(Math.min(childA.x, childB.x)).toBeGreaterThan(extent.max);
    expect(city.source.roads.routes.map((route) => route.id)).toEqual(["route-h"]);

    const status = getRouteEditStatus();
    expect(status).not.toBeNull();
    expect(status!.trimmedEdgeIds).toEqual(["ad"]);
    expect(status!.removedEdgeIds).toEqual([]);
    expect(status!.blockers).toEqual([]);
    expect(status!.conflicts.map((conflict) => conflict.edgeId)).toEqual(["ad"]);
    expect(status!.disconnectedVehicleNetwork).toBe(true);

    // The compound architecture+roads commit reverts as one history step.
    await expect(undo()).resolves.toBe(true);
    expect(stored().source.roads).toEqual(before);
    expect(stored().source.architecture.buildings).toHaveLength(0);
  }, 120_000);

  it("removes a fully covered middle edge, prunes its orphan junctions, and trims adjacent edges when a transform crosses the chain", async () => {
    fixture = await mountPhase6Fixture(routeSource(chainRoads(), [authoredBuilding("b-mover", 0, 20, 40, 24)]));
    const before = structuredClone(stored().source.roads);
    const revision = stored().revision;

    await transformObject("b-mover", { placement: frameAt(0, 0, 40, 24) });

    const city = stored();
    expect(city.revision).toBe(revision + 1);
    const moved = storedBuilding(city, "b-mover");
    expect(moved.placement.centre).toEqual({ x: 0, y: 0 });

    const occupied = occupiedPersistentBuildingGeometry(moved, city.source);
    expect(analyzeRouteConflicts(before, occupied).map((conflict) => conflict.edgeId).sort()).toEqual(["ab", "bc", "cd"]);

    // The kept west fragment of "ab" retains its id; the kept east fragment of "cd"
    // is a split child that still reaches node d.
    expect(city.source.roads.edges).toHaveLength(2);
    expect(city.source.roads.edges.map((edge) => edge.id)).toContain("ab");
    const eastChild = city.source.roads.edges.find((edge) => edge.id !== "ab")!;
    expect([eastChild.a, eastChild.b]).toContain("d");
    expect(city.source.roads.nodes.some((node) => node.id === "b")).toBe(false);
    expect(city.source.roads.nodes.some((node) => node.id === "c")).toBe(false);

    const status = getRouteEditStatus();
    expect(status!.trimmedEdgeIds).toEqual(["ab", "cd"]);
    expect(status!.removedEdgeIds).toEqual(["bc"]);
    expect(status!.blockers).toEqual([]);
    expect(status!.disconnectedVehicleNetwork).toBe(true);
  }, 120_000);

  it("aborts a transform with locked direct edge and leaves architecture and roads untouched", async () => {
    fixture = await mountPhase6Fixture(routeSource(chainRoads(["bc"]), [authoredBuilding("b-mover", 0, 20, 40, 24)]));
    const before = structuredClone(fixture.getStored());
    const revision = stored().revision;

    await expect(transformObject("b-mover", { placement: frameAt(0, 0, 40, 24) })).rejects.toThrow(/Road edge "bc" corridor intersects/);

    expect(stored().revision).toBe(revision);
    expect(fixture.getStored()).toEqual(before);
    const status = getRouteEditStatus();
    expect(status!.blockers).toHaveLength(1);
    expect(status!.blockers[0]).toMatchObject({ id: "bc", kind: "road" });
    expect(status!.trimmedEdgeIds).toEqual([]);
    expect(status!.removedEdgeIds).toEqual([]);
  }, 120_000);

  it("aborts a transform when only the locked adjacent edge's junction disc is touched", async () => {
    fixture = await mountPhase6Fixture(routeSource(chainRoads(["ab"]), [authoredBuilding("b-mover", 0, 20, 40, 24)]));
    const before = structuredClone(fixture.getStored());
    const revision = stored().revision;

    // Grounding: the moved masses overlap "ab" only through b's end-cap junction disc
    // (a sliver well under one corridor width), never its corridor quad, while "bc"
    // is blocked along most of its length.
    const moved: PersistentBuildingSource = {
      ...authoredBuilding("b-mover", 0, 20, 40, 24),
      sitePolygon: rectAt(0, 0, 40, 24),
      placement: frameAt(0, 0, 40, 24)
    };
    const conflicts = analyzeRouteConflicts(stored().source.roads, occupiedPersistentBuildingGeometry(moved, stored().source));
    const abConflict = conflicts.find((conflict) => conflict.edgeId === "ab");
    const bcConflict = conflicts.find((conflict) => conflict.edgeId === "bc");
    expect(abConflict).toBeDefined();
    expect(bcConflict).toBeDefined();
    expect(totalBlockedArcM(abConflict!)).toBeLessThan(8);
    expect(totalBlockedArcM(bcConflict!)).toBeGreaterThan(30);

    await expect(transformObject("b-mover", { placement: frameAt(0, 0, 40, 24) })).rejects.toThrow(/Road edge "ab" corridor intersects/);

    expect(stored().revision).toBe(revision);
    expect(fixture.getStored()).toEqual(before);
    const status = getRouteEditStatus();
    expect(status!.blockers).toHaveLength(1);
    expect(status!.blockers[0]).toMatchObject({ id: "ab", kind: "road" });
    expect(status!.trimmedEdgeIds).toEqual([]);
  }, 120_000);

  it("never deletes routes when only the reservation site overlaps the corridor and the masses stay clear", async () => {
    fixture = await mountPhase6Fixture(routeSource(chainRoads(), []));
    const before = structuredClone(stored().source.roads);
    const revision = stored().revision;

    // The site polygon crosses the street corridor (y in [-7, 7]) while the frame sits
    // north of it; the materialized masses inherit the frame clearance, not the site.
    const site = rectAt(0, 9.5, 40, 20);
    expect(Math.min(...site.map((point) => point.y))).toBeLessThan(7);

    await placeBuilding({
      grammarId: "infill-rowhouse",
      visualUse: "residential",
      heightM: 18,
      paletteId: null,
      placement: frameAt(0, 13, 40, 12),
      sitePolygon: site
    });

    const city = stored();
    expect(city.revision).toBe(revision + 1);
    expect(city.source.architecture.buildings).toHaveLength(1);
    expect(city.source.roads).toEqual(before);

    // Grounding: no occupied mass overlaps the corridor, so surgery never runs.
    const occupied = occupiedPersistentBuildingGeometry(city.source.architecture.buildings[0]!, city.source);
    expect(analyzeRouteConflicts(before, occupied)).toEqual([]);
    const status = getRouteEditStatus();
    expect(status === null || (status.blockers.length === 0 && status.trimmedEdgeIds.length === 0 && status.removedEdgeIds.length === 0)).toBe(true);
  }, 120_000);

  it("runs one all-selection route surgery for a bulk grammar edit whose members cross separate edges", async () => {
    const mountedGrammar: BuildingGrammarId = "civic-entry-court";
    const editedGrammar: BuildingGrammarId = "infill-rowhouse";
    fixture = await mountPhase6Fixture(routeSource(twinRoads(), [
      authoredBuilding("b-west", -50, 23, 40, 40, midGrammarHeight(mountedGrammar), mountedGrammar, "mixed-use"),
      authoredBuilding("b-east", 50, 23, 40, 40, midGrammarHeight(mountedGrammar), mountedGrammar, "mixed-use")
    ]));
    const before = structuredClone(stored().source.roads);
    const revision = stored().revision;
    const savesBefore = fixture.scene.setFlag.mock.calls.length;

    // Grounding: the mounted masses keep their setback-mode clearance from both
    // corridors, so the starting city is valid. The edited street-wall grammar fills
    // the same frame, extending each member's masses across a different edge — the
    // candidate masses below are computed before the edit through the production
    // materialization path, so the surgery is never fed a fake planned input.
    const city = stored();
    for (const member of ["b-west", "b-east"] as const) {
      expect(analyzeRouteConflicts(before, occupiedPersistentBuildingGeometry(storedBuilding(city, member), city.source))).toEqual([]);
    }
    const crossing: MultiPolygon = [
      ...occupiedPersistentBuildingGeometry(
        { ...storedBuilding(city, "b-west"), grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) },
        city.source
      ),
      ...occupiedPersistentBuildingGeometry(
        { ...storedBuilding(city, "b-east"), grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) },
        city.source
      )
    ];
    expect(analyzeRouteConflicts(before, crossing).map((conflict) => conflict.edgeId).sort()).toEqual(["ab", "cd"]);

    await bulkEditObjects(["b-west", "b-east"], { grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) });

    const edited = stored();
    expect(edited.revision).toBe(revision + 1);
    expect(fixture.scene.setFlag.mock.calls.length - savesBefore).toBe(1);
    expect(storedBuilding(edited, "b-west")).toMatchObject({ grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) });
    expect(storedBuilding(edited, "b-east")).toMatchObject({ grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) });

    expect(edited.source.roads.edges).toHaveLength(4);
    expect(edited.source.roads.edges.map((edge) => edge.id)).toContain("ab");
    expect(edited.source.roads.edges.map((edge) => edge.id)).toContain("cd");
    const status = getRouteEditStatus();
    expect(status!.trimmedEdgeIds).toEqual(["ab", "cd"]);
    expect(status!.removedEdgeIds).toEqual([]);
    expect(status!.blockers).toEqual([]);
    expect(status!.disconnectedVehicleNetwork).toBe(true);

    // One undo step restores both the bulk edit and the road surgery.
    await expect(undo()).resolves.toBe(true);
    expect(stored().source.roads).toEqual(before);
    expect(storedBuilding(stored(), "b-west")).toMatchObject({ grammarId: mountedGrammar, heightM: midGrammarHeight(mountedGrammar) });
    expect(storedBuilding(stored(), "b-east")).toMatchObject({ grammarId: mountedGrammar, heightM: midGrammarHeight(mountedGrammar) });
  }, 120_000);

  it("aborts a bulk grammar edit on a locked conflicted edge and clears the stale blockers on the next conflict-free edit", async () => {
    const mountedGrammar: BuildingGrammarId = "civic-entry-court";
    const editedGrammar: BuildingGrammarId = "infill-rowhouse";
    fixture = await mountPhase6Fixture(routeSource(twinRoads(["ab"]), [
      authoredBuilding("b-west", -50, 23, 40, 40, midGrammarHeight(mountedGrammar), mountedGrammar, "mixed-use"),
      authoredBuilding("b-east", 50, 23, 40, 40, midGrammarHeight(mountedGrammar), mountedGrammar, "mixed-use"),
      authoredBuilding("b-clear", 0, 40, 30, 20)
    ]));
    const before = structuredClone(fixture.getStored());
    const revision = stored().revision;

    // Grounding: the mounted masses stay clear of every corridor; the edited grammar's
    // candidate masses would extend across the locked edge, so the whole action aborts.
    const city = stored();
    for (const member of ["b-west", "b-east"] as const) {
      expect(analyzeRouteConflicts(city.source.roads, occupiedPersistentBuildingGeometry(storedBuilding(city, member), city.source))).toEqual([]);
    }
    const candidate = occupiedPersistentBuildingGeometry(
      { ...storedBuilding(city, "b-west"), grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) },
      city.source
    );
    expect(analyzeRouteConflicts(city.source.roads, candidate).map((conflict) => conflict.edgeId)).toEqual(["ab"]);

    await expect(bulkEditObjects(["b-west", "b-east"], { grammarId: editedGrammar, heightM: midGrammarHeight(editedGrammar) })).rejects.toThrow(/Road edge "ab" corridor intersects/);

    expect(stored().revision).toBe(revision);
    expect(fixture.getStored()).toEqual(before);
    expect(getRouteEditStatus()!.blockers.map((blocker) => blocker.id)).toEqual(["ab"]);

    // A conflict-free bulk edit commits and clears the stale blockers.
    await bulkEditObjects(["b-clear"], { heightM: 12 });
    expect(storedBuilding(stored(), "b-clear").heightM).toBe(12);
    expect(stored().revision).toBe(revision + 1);
    const status = getRouteEditStatus();
    expect(status === null || (status.blockers.length === 0 && status.trimmedEdgeIds.length === 0 && status.removedEdgeIds.length === 0)).toBe(true);
  }, 120_000);
});
