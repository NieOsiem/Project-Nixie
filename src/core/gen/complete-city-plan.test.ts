import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, rectsIntersect, ringArea, ringBounds, ringCentroid, type MultiPolygon, type Ring } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV4, type DistrictOpenSpaceOverride, type DistrictSource, type PersistentBuildingSource, type PersistentPlaceSource, type RoadEdgeSource, type RoadNodeSource, type RoadRouteSource } from "./city.js";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY, BUILDING_GRAMMARS, BUILDING_USE_IDS, FOOTPRINT_ARCHETYPE_IDS, INFILL_BUILDING_GRAMMAR_IDS, MICRO_BUILDING_GRAMMAR_IDS, isTowerGrammar, type BuildingGrammarId, type BuildingUseId } from "./building-registry.js";
import { LANDMARK_GRAMMAR_IDS, LANDMARK_GRAMMAR_REGISTRY, PRE_ROAD_LANDMARK_GRAMMAR_IDS, type LandmarkGrammarId } from "./landmark-registry.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_REGISTRY, DISTRICT_TYPES, DISTRICT_TYPE_IDS, type DistrictTypeId } from "./district-registry.js";
import { assignLandmarkCompatibleDistrictTypes, generateInitialDistricts } from "./district-generator.js";
import { generateInitialRoadNetwork } from "./road-generator.js";
import { rectangleLand, validateRing } from "./terrain.js";
import { DENSITY_INFILL_DISTRICT_TYPE_IDS, DENSITY_INFILL_SALT, DENSITY_INFILL_UNZONED_WEIGHTS, DENSITY_SMALL_SITE_GRAMMAR_WEIGHTS, FALLBACK_LANDMARK_SITE_MIN_AREA_MARGIN, FALLBACK_LANDMARK_SITE_TARGET_MAX_M2, FALLBACK_LANDMARK_SITE_TARGET_MIN_M2, GENERATED_MAJOR_LANDMARK_SITE_MIN_AREA_MARGIN, GENERATED_MAJOR_LANDMARK_SITE_TARGET_MAX_M2, GENERATED_MAJOR_LANDMARK_SITE_TARGET_MIN_M2, MAX_ANONYMOUS_OPEN_SPACE_AREA_M2, MAX_DENSITY_INFILL_AREA_M2, MAX_DENSITY_INFILL_BUILDINGS, MAX_DENSITY_INFILL_BUILDINGS_PER_FRAGMENT, MAX_DENSITY_INFILL_BUILDINGS_PER_PARCEL, MAX_REFERENCE_DENSITY_BUILDINGS, MAX_SEMANTIC_CELL_OPEN_SPACE_AREA_M2, MIN_DENSITY_INFILL_AREA_M2, MIN_DENSITY_INFILL_MINOR_DIMENSION_M, buildCompleteCityPlan, deriveBlockHeightBands, derivePaletteBanks, heightBandForBlock, planParcelBuilding, reserveMajorLandmarkSites, shapeBuildingHeight, validateCompleteCityPlan, type BuildingPlan, type CompleteCityPlan, type FrontageSide, type MajorLandmarkSiteReservation } from "./complete-city-plan.js";

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string, classId: RoadEdgeSource["classId"] = "street"): RoadEdgeSource => ({ id, a, b, routeId, classId, name: null, locked: false, origin: "authored" });

const multiArea = (multi: MultiPolygon): number =>
  multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);

const overlap = (a: Ring, b: Ring): number => multiArea(intersection(ringAsMulti(a), ringAsMulti(b)));
const overlapMulti = (a: Ring, b: MultiPolygon): number => multiArea(intersection(ringAsMulti(a), b));
const frameRing = (frame: { centre: { x: number; y: number }; rotationRad: number; widthM: number; depthM: number }): Ring => {
  const halfWidth = frame.widthM / 2;
  const halfDepth = frame.depthM / 2;
  const cosine = Math.cos(frame.rotationRad);
  const sine = Math.sin(frame.rotationRad);
  const axisX = { x: cosine * halfWidth, y: sine * halfWidth };
  const axisY = { x: -sine * halfDepth, y: cosine * halfDepth };
  return [
    { x: frame.centre.x - axisX.x - axisY.x, y: frame.centre.y - axisX.y - axisY.y },
    { x: frame.centre.x + axisX.x - axisY.x, y: frame.centre.y + axisX.y - axisY.y },
    { x: frame.centre.x + axisX.x + axisY.x, y: frame.centre.y + axisX.y + axisY.y },
    { x: frame.centre.x - axisX.x + axisY.x, y: frame.centre.y - axisX.y + axisY.y }
  ];
};

const parkOverride = (rate: number): DistrictOpenSpaceOverride => ({
  rate,
  categoryWeights: { park: 1, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
  sizeWeights: { pocket: 0, small: 0, large: 1, "whole-block": 0 }
});

/**
 * 190×190 grid cross (four 95 m blocks) with two district halves. The mask is small
 * enough that no pre-road landmark reservation can meet the 800 m² minimum site, so
 * landmarks always fall back to legal block-inscribed sites.
 */
const crossSource = (): CitySourceV4 => {
  const districts: DistrictSource[] = [
    { id: "west", polygon: rectRing({ x: 0, y: 0, width: 95, height: 190 }), seed: "west-seed", typeId: "mixed-use-centre", paletteId: DISTRICT_PALETTE_IDS[2]!, origin: "generated", locked: false, openSpaceOverride: null },
    { id: "east", polygon: rectRing({ x: 95, y: 0, width: 95, height: 190 }), seed: "east-seed", typeId: "dense-residential", paletteId: DISTRICT_PALETTE_IDS[4]!, origin: "generated", locked: false, openSpaceOverride: null }
  ];
  return {
    origin: { x: 700, y: 300 },
    citySeed: "complete-plan-cross",
    generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
    terrain: { land: rectRing({ x: 0, y: 0, width: 190, height: 190 }), urbanFootprint: null },
    roads: {
      nodes: [node("n", 95, 0), node("w", 0, 95), node("c", 95, 95), node("e", 190, 95), node("s", 95, 190)],
      routes: [route("horizontal"), route("vertical")],
      edges: [edge("north", "n", "c", "vertical"), edge("west", "w", "c", "horizontal"), edge("east", "c", "e", "horizontal"), edge("south", "c", "s", "vertical")]
    },
    districts,
    architecture: { buildings: [], places: [], overrides: [] }
  };
};

/** Cross variant whose halves carry compatible district tags (formal west, industrial east). */
const compatibleCross = (): CitySourceV4 => {
  const base = crossSource();
  return {
    ...base,
    districts: [
      { ...base.districts[0]!, typeId: "corporate-core", paletteId: DISTRICT_PALETTE_IDS[0]! },
      { ...base.districts[1]!, typeId: "heavy-industrial", paletteId: DISTRICT_PALETTE_IDS[9]! }
    ]
  };
};

const manualReservation = (grammarId: MajorLandmarkSiteReservation["grammarId"], x: number, y: number, width = 70, height = 80): MajorLandmarkSiteReservation => ({
  grammarId,
  sitePolygon: rectRing({ x, y, width, height }),
  lineage: `manual:${grammarId}`,
  seed: `manual-seed:${grammarId}`
});

/**
 * 1600×1200 mask with a boundary ring road (one interior block) split into district
 * strips. The strip count is a parameter: the 16-district breadth test needs all of
 * them, while precedence/landmark tests use fewer strips so the Phase 3 cell planning
 * stays cheap (the per-fragment cell cap dominates build time).
 */
const ringSource = (
  districtCount = 4,
  openSpaceProfile: CitySourceV4["generation"]["openSpaceProfile"] = "medium",
  citySeed = "complete-plan-ring"
): CitySourceV4 => {
  const stripWidth = 1600 / districtCount;
  const districts: DistrictSource[] = DISTRICT_TYPE_IDS.slice(0, districtCount).map((typeId: DistrictTypeId, index: number) => ({
    id: `d${index}`,
    polygon: rectRing({ x: index * stripWidth, y: 0, width: stripWidth, height: 1200 }),
    seed: `district-seed-${index}`,
    typeId,
    paletteId: DISTRICT_PALETTE_IDS[index]!,
    origin: "generated",
    locked: false,
    openSpaceOverride: null
  }));
  return {
    origin: { x: 700, y: 300 },
    citySeed,
    generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile },
    terrain: { land: rectRing({ x: 0, y: 0, width: 1600, height: 1200 }), urbanFootprint: null },
    roads: {
      nodes: [node("a", 0, 0), node("b", 1600, 0), node("c", 1600, 1200), node("d", 0, 1200)],
      routes: [route("ring")],
      edges: [edge("ab", "a", "b", "ring"), edge("bc", "b", "c", "ring"), edge("cd", "c", "d", "ring"), edge("da", "d", "a", "ring")]
    },
    districts,
    architecture: { buildings: [], places: [], overrides: [] }
  };
};

/**
 * Semantic open-space fixture: preserves four district identities, legal landmark sites,
 * and a district-scale whole-block strip without paying for overview-scale fabric.
 */
const compactRingSource = (
  openSpaceProfile: CitySourceV4["generation"]["openSpaceProfile"] = "medium",
  citySeed = "complete-plan-compact-ring"
): CitySourceV4 => {
  const width = 640;
  const height = 640;
  const stripWidth = width / 4;
  const source = ringSource(4, openSpaceProfile, citySeed);
  return {
    ...source,
    terrain: { land: rectRing({ x: 0, y: 0, width, height }), urbanFootprint: null },
    roads: {
      nodes: [node("a", 0, 0), node("b", width, 0), node("c", width, height), node("d", 0, height)],
      routes: [route("ring")],
      edges: [edge("ab", "a", "b", "ring"), edge("bc", "b", "c", "ring"), edge("cd", "c", "d", "ring"), edge("da", "d", "a", "ring")]
    },
    districts: source.districts.map((district, index) => ({
      ...district,
      polygon: rectRing({ x: index * stripWidth, y: 0, width: stripWidth, height })
    }))
  };
};

interface StagedReproductionFixture {
  source: CitySourceV4;
  reservations: MajorLandmarkSiteReservation[];
  warnings: string[];
}

function stagedReproduction(
  citySeed = "foundry-repro-0",
  roadLayout: CitySourceV4["generation"]["roadLayout"] = "european",
  hubMode: CitySourceV4["generation"]["hubMode"] = "multiple-hubs",
  openSpaceProfile: CitySourceV4["generation"]["openSpaceProfile"] = "medium",
  grammarIds: readonly LandmarkGrammarId[] = PRE_ROAD_LANDMARK_GRAMMAR_IDS
): StagedReproductionFixture {
  const sceneBounds = { x: -600, y: -450, width: 1200, height: 900 };
  const land = rectangleLand(sceneBounds);
  const source: CitySourceV4 = {
    origin: { x: 0, y: 0 },
    citySeed,
    generation: {
      terrainMode: "rectangle",
      coastEdge: null,
      roadLayout,
      hubMode,
      districtPool: [...DISTRICT_TYPE_IDS],
      openSpaceProfile
    },
    terrain: { land, urbanFootprint: null },
    roads: { nodes: [], routes: [], edges: [] },
    districts: [],
    architecture: { buildings: [], places: [], overrides: [] }
  };
  const reservations = reserveMajorLandmarkSites(source, grammarIds);
  source.roads = generateInitialRoadNetwork({
    citySeed: source.citySeed,
    mask: land,
    land,
    layout: source.generation.roadLayout,
    hubMode: source.generation.hubMode,
    sceneBounds,
    reservedSites: reservations.map((reservation) => reservation.sitePolygon)
  }).roads;
  source.districts = generateInitialDistricts(source);
  const assignment = assignLandmarkCompatibleDistrictTypes(
    source.districts,
    reservations.map((reservation) => ({ grammarId: reservation.grammarId, sitePolygon: reservation.sitePolygon })),
    source.generation.districtPool,
    `${source.citySeed}/landmarks/v3/district-assignment`
  );
  source.districts = assignment.districts;
  return { source, reservations, warnings: assignment.warnings };
}

// WHY: nine tests plan the identical ringSource(4)/ringSource(16) city; a build is 27–63 s
// of pure generation, so identical builds are computed once per worker and shared. The
// generator is deterministic (asserted below) and the pipeline keeps no module-level state,
// so a shared plan is observationally identical to a fresh one. Tests that tamper with the
// plan (injected-failure cases) spread-copy it and never mutate the shared object.
const sharedPlans = new Map<string, CompleteCityPlan>();
function sharedPlan(key: string, build: () => CompleteCityPlan): CompleteCityPlan {
  let plan = sharedPlans.get(key);
  if (plan === undefined) {
    plan = build();
    sharedPlans.set(key, plan);
  }
  return plan;
}
let fullReservationFixtureCache: StagedReproductionFixture | undefined;
function fullReservationFixture(): StagedReproductionFixture {
  fullReservationFixtureCache ??= stagedReproduction(
    "complete-plan-reserved-sites",
    "grid",
    "single-centre",
    "medium",
    LANDMARK_GRAMMAR_IDS
  );
  return fullReservationFixtureCache;
}
const fullReservationPlan = (): CompleteCityPlan => sharedPlan("full-reservation-fixture", () => {
  const { source, reservations } = fullReservationFixture();
  return buildCompleteCityPlan(source, 1, 0, reservations);
});

const ringFourPlan = (): CompleteCityPlan => sharedPlan("ringSource(4)", () => buildCompleteCityPlan(ringSource(4)));
const ringSixteenPlan = (): CompleteCityPlan => sharedPlan("ringSource(16)", () => buildCompleteCityPlan(ringSource(16)));
const compactFourPlan = (): CompleteCityPlan => sharedPlan("compactRingSource(4)", () => buildCompleteCityPlan(compactRingSource()));
const compactFourRepeat = (): CompleteCityPlan => sharedPlan("compactRingSource(4)/repeat", () => buildCompleteCityPlan(compactRingSource()));

/**
 * Fixed 1,500 m diagonal acceptance fixture. The staged reproduction helper already
 * uses a 1,200 × 900 m scene (a 1,500 m diagonal); promote one deterministic derived
 * building and one non-reserved compound place back into the persistent architecture
 * envelope before rebuilding the plan.
 */
interface MixedDiagonalFixture {
  source: CitySourceV4;
  reservations: MajorLandmarkSiteReservation[];
  warnings: string[];
  plan: CompleteCityPlan;
}

let mixedDiagonalFixtureCache: MixedDiagonalFixture | undefined;
function mixedDiagonalFixture(): MixedDiagonalFixture {
  if (mixedDiagonalFixtureCache !== undefined) return mixedDiagonalFixtureCache;
  const staged = stagedReproduction("phase5-diagonal-acceptance", "european", "multiple-hubs", "medium");
  const stagedPlan = buildCompleteCityPlan(staged.source, 1, 0, staged.reservations);
  const promotedBuilding = stagedPlan.buildings.find((candidate) =>
    candidate.sourceId === null
    && candidate.placement !== undefined
    && candidate.masses.length > 0
    && Math.abs(ringArea(candidate.sitePolygon)) + candidate.placement.widthM * candidate.placement.depthM * 1e-6
      >= candidate.placement.widthM * candidate.placement.depthM
  );
  if (promotedBuilding === undefined || promotedBuilding.placement === undefined) {
    throw new Error("The diagonal acceptance fixture needs a derived building with a placement frame.");
  }
  const reservedGrammars = new Set(staged.reservations.map((reservation) => reservation.grammarId));
  const promotedPlace = stagedPlan.landmarks.find((candidate) =>
    (candidate.sourceId === null || candidate.sourceId === undefined)
    && candidate.placement !== undefined
    && candidate.masses.length > 1
    && !reservedGrammars.has(candidate.landmarkGrammarId)
    && overlap(candidate.sitePolygon, promotedBuilding.sitePolygon) < 0.5
  );
  if (promotedPlace === undefined || promotedPlace.placement === undefined) {
    throw new Error("The diagonal acceptance fixture needs a derived non-reserved compound place.");
  }
  const architecture: CitySourceV4["architecture"] = {
    buildings: [{
      id: promotedBuilding.id,
      lineage: promotedBuilding.lineage,
      origin: "generated",
      protection: "manual-edit",
      seed: promotedBuilding.seed,
      appearanceSeed: promotedBuilding.appearanceSeed,
      grammarId: promotedBuilding.grammarId,
      visualUse: promotedBuilding.visualUse,
      heightM: promotedBuilding.heightM,
      paletteId: promotedBuilding.paletteId ?? null,
      sitePolygon: promotedBuilding.sitePolygon.map((point) => ({ ...point })),
      placement: { ...promotedBuilding.placement },
      districtId: promotedBuilding.districtId,
      blockId: promotedBuilding.blockId
    } satisfies PersistentBuildingSource],
    places: [{
      id: promotedPlace.id,
      lineage: promotedPlace.lineage ?? promotedPlace.placementLineage ?? promotedPlace.id,
      origin: "authored",
      protection: "explicit",
      seed: promotedPlace.seed,
      appearanceSeed: promotedPlace.appearanceSeed,
      landmarkGrammarId: promotedPlace.landmarkGrammarId,
      paletteId: promotedPlace.paletteId ?? null,
      sitePolygon: promotedPlace.sitePolygon.map((point) => ({ ...point })),
      placement: { ...promotedPlace.placement },
      districtId: promotedPlace.districtId,
      blockId: promotedPlace.blockId
    } satisfies PersistentPlaceSource],
    overrides: []
  };
  const source = { ...staged.source, architecture };
  const plan = buildCompleteCityPlan(source, 1, 0, staged.reservations);
  if (staged.warnings.length > 0) plan.diagnostics.warnings.push(...staged.warnings);
  mixedDiagonalFixtureCache = { source, reservations: staged.reservations, warnings: staged.warnings, plan };
  return mixedDiagonalFixtureCache;
}

describe("buildCompleteCityPlan", () => {
  it("reserves compact generated major sites for the curated grammars deterministically", () => {
    const source = ringSource(4);
    const first = reserveMajorLandmarkSites(source);
    expect(first.map((reservation) => reservation.grammarId)).toEqual([
      "hero-tower-plaza",
      "civic-corporate-compound",
      "circular-beacon-tower",
      "tri-spire",
      "megaframe-block",
      "arcology-terraces",
      "hex-corporate-hq",
      "logo-gateway"
    ]);
    expect(reserveMajorLandmarkSites(source)).toEqual(first);
    const all = reserveMajorLandmarkSites(source, LANDMARK_GRAMMAR_IDS);
    expect(all.map((reservation) => reservation.grammarId)).toEqual(LANDMARK_GRAMMAR_IDS);
    for (let index = 0; index < all.length; index++) {
      const reservation = all[index]!;
      const definition = LANDMARK_GRAMMAR_REGISTRY.get(reservation.grammarId)!;
      const areaM2 = Math.abs(ringArea(reservation.sitePolygon));
      const safeMinimumM2 = Math.max(
        GENERATED_MAJOR_LANDMARK_SITE_TARGET_MIN_M2,
        definition.minSiteAreaM2 * GENERATED_MAJOR_LANDMARK_SITE_MIN_AREA_MARGIN
      );
      expect(areaM2, reservation.grammarId).toBeGreaterThanOrEqual(safeMinimumM2 - 0.5);
      expect(areaM2, reservation.grammarId).toBeLessThanOrEqual(
        Math.max(GENERATED_MAJOR_LANDMARK_SITE_TARGET_MAX_M2, safeMinimumM2) + 0.5
      );
      expect(overlap(reservation.sitePolygon, source.terrain.land), `${reservation.grammarId} containment`)
        .toBeCloseTo(areaM2, 0);
      for (let otherIndex = index + 1; otherIndex < all.length; otherIndex++) {
        expect(overlap(reservation.sitePolygon, all[otherIndex]!.sitePolygon), `${reservation.grammarId}/${all[otherIndex]!.grammarId}`)
          .toBeLessThan(0.5);
      }
    }
    expect(() => reserveMajorLandmarkSites(source, [
      ...PRE_ROAD_LANDMARK_GRAMMAR_IDS,
      PRE_ROAD_LANDMARK_GRAMMAR_IDS[0]
    ])).toThrow(/Duplicate landmark grammar/);
    expect(() => reserveMajorLandmarkSites(
      source,
      ["unknown-landmark"] as unknown as readonly LandmarkGrammarId[]
    )).toThrow(/Unknown landmark grammar/);
  });

  it.concurrent("produces a validating complete plan over all 16 districts with 12-16 overview landmarks", () => {
    const source = ringSource(16);
    const plan = ringSixteenPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.diagnostics.landmarkCount).toBe(plan.landmarks.length);
    expect(plan.landmarks.length).toBeGreaterThanOrEqual(12);
    expect(plan.landmarks.length).toBeLessThanOrEqual(16);
    const parcelDistricts = new Set(plan.parcels.map((parcel) => parcel.districtId));
    const openSpaceDistricts = new Set(plan.openSpaces.filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null).map((openSpace) => openSpace.districtId));
    for (const district of source.districts) {
      // Every district appears as parcels or as a whole-block ordinary open space.
      expect(parcelDistricts.has(district.id) || openSpaceDistricts.has(district.id), district.id).toBe(true);
    }
    // Every district with parcels shows up as built buildings or explicitly unbuilt open parcels.
    const districtsWithBuildings = new Set(plan.buildings.map((building) => building.districtId));
    const vacantDistricts = new Set(plan.openSpaces.filter((openSpace) => openSpace.parcelId !== null).map((openSpace) => openSpace.districtId));
    for (const district of source.districts) {
      if (parcelDistricts.has(district.id)) expect(districtsWithBuildings.has(district.id) || vacantDistricts.has(district.id), district.id).toBe(true);
    }
    expect(plan.buildings.every((building) => building.masses.length >= 1)).toBe(true);
    // Every landmark is associated with a district whose type shares a compatibility tag.
    const districtById = new Map(source.districts.map((district) => [district.id, district]));
    for (const landmark of plan.landmarks) {
      const district = landmark.districtId ? districtById.get(landmark.districtId) : undefined;
      const type = district ? DISTRICT_TYPES.find((candidate) => candidate.id === district.typeId) : undefined;
      const grammar = LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId)!;
      expect(type, landmark.id).toBeDefined();
      expect(grammar.compatibilityTags.some((tag) => type!.compatibilityTags.includes(tag)), landmark.id).toBe(true);
    }
  }, 300_000);

  it("completes the exact foundry-repro-0 staged generation deterministically with valid topology", () => {
    const { source, reservations, warnings } = stagedReproduction();
    expect(reservations.map((reservation) => reservation.grammarId)).toEqual(PRE_ROAD_LANDMARK_GRAMMAR_IDS);
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) plan.diagnostics.warnings.push(...warnings);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.landmarks.length).toBeGreaterThanOrEqual(14);
    expect(plan.landmarks.length).toBeLessThanOrEqual(16);
    const reservationLineages = new Set(reservations.map((reservation) => reservation.lineage));
    expect(plan.landmarks.filter((landmark) =>
      landmark.placementLineage !== undefined && reservationLineages.has(landmark.placementLineage)
    )).toHaveLength(8);
    for (const grammarId of PRE_ROAD_LANDMARK_GRAMMAR_IDS) {
      const reservation = reservations.find((candidate) => candidate.grammarId === grammarId)!;
      const landmark = plan.landmarks.find((candidate) => candidate.landmarkGrammarId === grammarId)!;
      expect(landmark.sitePolygon, grammarId).toEqual(reservation.sitePolygon);
      expect(landmark.placementLineage, grammarId).toBe(reservation.lineage);
    }
    const preRoadIds = new Set<LandmarkGrammarId>(PRE_ROAD_LANDMARK_GRAMMAR_IDS);
    for (const landmark of plan.landmarks.filter((candidate) => !preRoadIds.has(candidate.landmarkGrammarId))) {
      expect(landmark.placementLineage, landmark.landmarkGrammarId).toMatch(/^fallback:/);
      expect(overlapMulti(landmark.sitePolygon, plan.routeOccupancy.all), landmark.id).toBeLessThan(0.5);
    }

    const repeated = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) repeated.diagnostics.warnings.push(...warnings);
    expect(repeated).toEqual(plan);

    const rings: Ring[] = [
      source.terrain.land,
      ...source.districts.map((district) => district.polygon),
      ...plan.carriageway.flat(),
      ...plan.districtPlan.unzoned.flat(),
      ...plan.districtPlan.wallCells.flat(),
      ...plan.districtPlan.blocks.flatMap((block) => [
        block.zoningFace,
        ...block.buildable.flat(),
        ...block.districtFragments.flatMap((fragment) => fragment.buildable.flat())
      ]),
      ...plan.districtPlan.developmentCells.map((cell) => cell.polygon),
      ...plan.parcels.map((parcel) => parcel.polygon),
      ...plan.openSpaces.map((openSpace) => openSpace.polygon),
      ...plan.buildings.flatMap((building) => building.masses.map((mass) => mass.footprint)),
      ...plan.landmarks.flatMap((landmark) => [
        landmark.sitePolygon,
        ...landmark.masses.map((mass) => mass.footprint)
      ])
    ];
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) expect(validateRing(ring)).toEqual({ ok: true });
  }, 600_000);

  it("locks a fixed 1,500 m diagonal plan with mixed persistent architecture", () => {
    const fixture = mixedDiagonalFixture();
    const { source, plan, reservations } = fixture;
    const diagonalBounds = ringBounds(source.terrain.land);
    const diagonalM = Math.hypot(diagonalBounds.width, diagonalBounds.height);
    const structuralCounts = {
      diagonalM,
      districtCount: source.districts.length,
      roadNodeCount: source.roads.nodes.length,
      roadRouteCount: source.roads.routes.length,
      roadEdgeCount: source.roads.edges.length,
      compiledSegmentCount: compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY).segments.length,
      reservationCount: reservations.length,
      blockCount: plan.districtPlan.blocks.length,
      fragmentCount: plan.districtPlan.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0),
      developmentCellCount: plan.districtPlan.developmentCells.length,
      parcelCount: plan.parcels.length,
      openSpaceCount: plan.openSpaces.length,
      buildingCount: plan.buildings.length,
      landmarkCount: plan.landmarks.length,
      massCount: plan.diagnostics.massCount
    };
    expect(structuralCounts).toEqual({
      diagonalM: 1500,
      districtCount: 11,
      roadNodeCount: 327,
      roadRouteCount: 368,
      roadEdgeCount: 401,
      compiledSegmentCount: 473,
      reservationCount: 8,
      blockCount: 66,
      fragmentCount: 84,
      developmentCellCount: 1475,
      parcelCount: 1267,
      openSpaceCount: 1831,
      buildingCount: 800,
      landmarkCount: 14,
      massCount: 967
    });
    expect(source.architecture.buildings).toHaveLength(1);
    expect(source.architecture.places).toHaveLength(1);
    expect(source.architecture.buildings[0]).toMatchObject({ origin: "generated", protection: "manual-edit" });
    expect(source.architecture.places[0]).toMatchObject({ origin: "authored", protection: "explicit" });
    expect(new Set([
      ...source.architecture.buildings.map((building) => building.id),
      ...source.architecture.places.map((place) => place.id)
    ]).size).toBe(2);
    const persistentBuildingIds = plan.buildings
      .filter((building) => building.sourceId !== null)
      .map((building) => building.sourceId!);
    const persistentLandmarkIds = plan.landmarks
      .filter((landmark) => landmark.sourceId !== null)
      .map((landmark) => landmark.sourceId!);
    expect(new Set(persistentBuildingIds).size).toBe(persistentBuildingIds.length);
    expect(new Set(persistentLandmarkIds).size).toBe(persistentLandmarkIds.length);
    expect([...persistentBuildingIds].sort()).toEqual(source.architecture.buildings.map((building) => building.id).sort());
    expect([...persistentLandmarkIds].sort()).toEqual(source.architecture.places.map((place) => place.id).sort());
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.buildings.filter((building) => building.sourceId !== null)).toHaveLength(1);
    expect(plan.landmarks.filter((landmark) => landmark.sourceId !== null)).toHaveLength(1);
    expect(plan.buildings.filter((building) => building.sourceId !== null)[0]!.id).toBe(source.architecture.buildings[0]!.id);
    expect(plan.landmarks.filter((landmark) => landmark.sourceId !== null)[0]!.id).toBe(source.architecture.places[0]!.id);

    const repeated = buildCompleteCityPlan(source, 1, 0, reservations);
    if (fixture.warnings.length > 0) repeated.diagnostics.warnings.push(...fixture.warnings);
    const planIdentity = (candidate: CompleteCityPlan) => ({
      sourceRevision: candidate.sourceRevision,
      actionToken: candidate.actionToken,
      buildToken: candidate.buildToken,
      epoch: candidate.epoch
    });
    const planCounts = (candidate: CompleteCityPlan) => ({
      blockCount: candidate.districtPlan.blocks.length,
      fragmentCount: candidate.districtPlan.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0),
      developmentCellCount: candidate.districtPlan.developmentCells.length,
      parcelCount: candidate.parcels.length,
      openSpaceCount: candidate.openSpaces.length,
      buildingCount: candidate.buildings.length,
      landmarkCount: candidate.landmarks.length,
      massCount: candidate.diagnostics.massCount
    });
    expect(planIdentity(repeated)).toEqual(planIdentity(plan));
    expect(planCounts(repeated)).toEqual(planCounts(plan));
    expect(repeated).toEqual(plan);
  }, 600_000);
  it("emits placement frames that satisfy the persistent source containment tolerance", () => {
    const { plan } = mixedDiagonalFixture();
    for (const candidate of [...plan.buildings, ...plan.landmarks]) {
      if (candidate.placement === undefined) continue;
      const frameArea = candidate.placement.widthM * candidate.placement.depthM;
      expect(
        overlap(frameRing(candidate.placement), candidate.sitePolygon) + Math.max(1e-4, frameArea * 1e-6)
      ).toBeGreaterThanOrEqual(frameArea);
    }
  }, 120_000);

  it("keeps the nixie-2 overview dense with eight pre-road anchors and legal secondary fallbacks", () => {
    const { source, reservations, warnings } = stagedReproduction(
      "nixie-2",
      "european",
      "single-centre",
      "very-low"
    );
    expect(reservations.map((reservation) => reservation.grammarId)).toEqual(PRE_ROAD_LANDMARK_GRAMMAR_IDS);
    // Eight major anchors preserve the strongest silhouettes while returning enough
    // central land to the road and post-road fallback streams.
    expect(source.roads.edges.length).toBeGreaterThanOrEqual(400);
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) plan.diagnostics.warnings.push(...warnings);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.landmarks.length).toBeGreaterThanOrEqual(14);
    expect(plan.landmarks.length).toBeLessThanOrEqual(16);
    expect(plan.buildings.length).toBeGreaterThanOrEqual(1_050);
    expect(plan.buildings.length).toBeLessThanOrEqual(MAX_REFERENCE_DENSITY_BUILDINGS);
    expect(FALLBACK_LANDMARK_SITE_TARGET_MIN_M2).toBe(2_000);
    expect(FALLBACK_LANDMARK_SITE_TARGET_MAX_M2).toBe(3_000);
    expect(FALLBACK_LANDMARK_SITE_MIN_AREA_MARGIN).toBe(1.1);
    expect(GENERATED_MAJOR_LANDMARK_SITE_TARGET_MIN_M2).toBe(5_000);
    expect(GENERATED_MAJOR_LANDMARK_SITE_TARGET_MAX_M2).toBe(6_500);
    expect(GENERATED_MAJOR_LANDMARK_SITE_MIN_AREA_MARGIN).toBe(1.1);
    expect(DENSITY_INFILL_SALT).toBe("density/v3/infill");
    expect(MAX_DENSITY_INFILL_BUILDINGS).toBe(600);
    expect(MAX_DENSITY_INFILL_BUILDINGS_PER_FRAGMENT).toBe(72);
    expect(MAX_DENSITY_INFILL_BUILDINGS_PER_PARCEL).toBe(12);
    expect(MAX_REFERENCE_DENSITY_BUILDINGS).toBe(1_250);
    expect(MIN_DENSITY_INFILL_AREA_M2).toBe(60);
    expect(MAX_DENSITY_INFILL_AREA_M2).toBe(4_800);
    expect(MIN_DENSITY_INFILL_MINOR_DIMENSION_M).toBe(6.5);
    expect(DENSITY_SMALL_SITE_GRAMMAR_WEIGHTS).toEqual({
      "campus-annex": 0.7,
      "narrow-strip": 0.75
    });
    for (const typeId of [
      "civic-institutional",
      "heavy-industrial",
      "light-industrial",
      "logistics-port",
      "derelict-reclamation"
    ] as const) {
      expect(DENSITY_INFILL_DISTRICT_TYPE_IDS[typeId], typeId).toBe(true);
    }
    expect(DENSITY_INFILL_DISTRICT_TYPE_IDS["utility-infrastructure"]).toBeUndefined();
    const parcelById = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
    const infillBuildings = plan.buildings.filter((building) =>
      building.parcelId !== null && parcelById.get(building.parcelId)?.role.includes("density-infill") === true
    );
    const infillCountByFragment = new Map<string, number>();
    for (const building of infillBuildings) {
      if (building.fragmentId === null) continue;
      infillCountByFragment.set(building.fragmentId, (infillCountByFragment.get(building.fragmentId) ?? 0) + 1);
    }
    expect(Math.max(...infillCountByFragment.values())).toBeLessThanOrEqual(MAX_DENSITY_INFILL_BUILDINGS_PER_FRAGMENT);
    expect(infillBuildings.length).toBeGreaterThan(0);
    expect(infillBuildings.length).toBeLessThanOrEqual(MAX_DENSITY_INFILL_BUILDINGS);
    expect(infillBuildings.some((building) =>
      INFILL_BUILDING_GRAMMAR_IDS.some((grammarId) => grammarId === building.grammarId)
    )).toBe(true);
    const landCentre = ringCentroid(source.terrain.land);
    const parcelsByDistance = plan.parcels.map((parcel) => {
      const centre = ringCentroid(parcel.polygon);
      return {
        id: parcel.id,
        distanceSq: (centre.x - landCentre.x) ** 2 + (centre.y - landCentre.y) ** 2
      };
    }).sort((a, b) => a.distanceSq - b.distanceSq || a.id.localeCompare(b.id));
    const quartileSize = Math.max(1, Math.floor(parcelsByDistance.length / 4));
    const centralParcelIds = new Set(parcelsByDistance.slice(0, quartileSize).map((entry) => entry.id));
    const outerParcelIds = new Set(parcelsByDistance.slice(-quartileSize).map((entry) => entry.id));
    const centralInfillShare = infillBuildings.filter((building) => building.parcelId !== null && centralParcelIds.has(building.parcelId)).length / quartileSize;
    const outerInfillShare = infillBuildings.filter((building) => building.parcelId !== null && outerParcelIds.has(building.parcelId)).length / quartileSize;
    expect(centralInfillShare).toBeGreaterThan(outerInfillShare + 0.05);
    const unzonedInfill = infillBuildings.filter((building) => building.districtId === null);
    for (const building of unzonedInfill) {
      expect(DENSITY_INFILL_UNZONED_WEIGHTS[building.grammarId], building.id).toBeGreaterThan(0);
    }
    for (const grammarId of INFILL_BUILDING_GRAMMAR_IDS) {
      expect(DENSITY_INFILL_UNZONED_WEIGHTS[grammarId], grammarId).toBe(1);
    }
    expect(DENSITY_INFILL_UNZONED_WEIGHTS["campus-annex"]).toBe(0.7);
    expect(DENSITY_INFILL_UNZONED_WEIGHTS["narrow-strip"]).toBe(0.75);
    for (const grammarId of ["street-kiosk", "garage-unit", "shack-shanty", "utility-kiosk"] as const) {
      expect(DENSITY_INFILL_UNZONED_WEIGHTS[grammarId], grammarId).toBe(0);
    }
    for (const grammar of BUILDING_GRAMMARS.filter(isTowerGrammar)) {
      expect(DENSITY_INFILL_UNZONED_WEIGHTS[grammar.id], grammar.id).toBe(0);
    }
    const industrialInfill = infillBuildings.filter((building) => {
      const typeId = source.districts.find((district) => district.id === building.districtId)?.typeId;
      return typeId === "heavy-industrial" || typeId === "derelict-reclamation";
    });
    for (const building of industrialInfill) {
      if (INFILL_BUILDING_GRAMMAR_IDS.some((grammarId) => grammarId === building.grammarId)) {
        expect(building.grammarId).toBe("infill-courtyard-cluster");
      }
      expect(building.masses.every((mass) => !mass.neonEnabled), building.id).toBe(true);
    }
    for (const building of infillBuildings) {
      if (building.parcelId === null) continue;
      const parcel = parcelById.get(building.parcelId);
      if (parcel === undefined) continue;
      expect(parcel.areaM2, parcel.id).toBeLessThanOrEqual(MAX_DENSITY_INFILL_AREA_M2);
      const district = source.districts.find((candidate) => candidate.id === building.districtId);
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(building.grammarId)!;
      if (district === undefined) {
        expect(building.districtId, building.id).toBeNull();
        expect(DENSITY_INFILL_UNZONED_WEIGHTS[building.grammarId], building.id).toBeGreaterThan(0);
      } else {
        expect(DENSITY_INFILL_DISTRICT_TYPE_IDS[district.typeId], district.typeId).toBe(true);
      }
      expect(isTowerGrammar(grammar), building.id).toBe(false);
      expect(
        !MICRO_BUILDING_GRAMMAR_IDS.has(building.grammarId) || building.grammarId === "campus-annex",
        building.id
      ).toBe(true);
      expect(["street-kiosk", "garage-unit", "shack-shanty", "utility-kiosk"]).not.toContain(building.grammarId);
      const expectedDetailPolicy = grammar.geometryPolicy.detail === "none"
        ? "coarse"
        : grammar.geometryPolicy.neon ? "both" : "detail";
      expect(building.masses.every((mass) => mass.detailPolicy === expectedDetailPolicy), building.id).toBe(true);
    }
    const oversizedSourceCourts = plan.districtPlan.developmentCells.filter((cell) =>
      (cell.semanticRole === "courtyard" || cell.semanticRole === "plaza")
      && Math.abs(ringArea(cell.polygon)) > MAX_SEMANTIC_CELL_OPEN_SPACE_AREA_M2
    );
    expect(oversizedSourceCourts.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...oversizedSourceCourts.map((cell) => Math.abs(ringArea(cell.polygon))))).toBeGreaterThan(8_000);

    const semanticPockets = plan.openSpaces.filter((openSpace) => openSpace.lineage.includes("/density/v2/semantic-pocket/"));
    expect(semanticPockets.length).toBeGreaterThanOrEqual(2);
    expect(semanticPockets.every((openSpace) =>
      openSpace.landmarkId === null
      && openSpace.parcelId === null
      && (openSpace.semanticRole === "courtyard" || openSpace.semanticRole === "plaza")
      && openSpace.category === (openSpace.semanticRole === "courtyard" ? "landscaping" : "plaza")
      && openSpace.size === "pocket"
      && openSpace.areaM2 >= 100
      && openSpace.areaM2 <= MAX_ANONYMOUS_OPEN_SPACE_AREA_M2 + 0.5
    )).toBe(true);
    const ordinarySemanticCourts = plan.openSpaces.filter((openSpace) =>
      openSpace.landmarkId === null
      && (openSpace.semanticRole === "courtyard" || openSpace.semanticRole === "plaza")
    );
    expect(Math.max(...ordinarySemanticCourts.map((openSpace) => openSpace.areaM2)))
      .toBeLessThanOrEqual(MAX_SEMANTIC_CELL_OPEN_SPACE_AREA_M2 + 0.5);
    expect(plan.openSpaces.filter((openSpace) => openSpace.landmarkId !== null)
      .every((openSpace) => !openSpace.lineage.includes("/density/v2/semantic-pocket/"))).toBe(true);

    const convertedSourceCourts = oversizedSourceCourts.filter((cell) =>
      semanticPockets.some((pocket) => pocket.lineage.includes(`/${cell.id}/`))
    );
    expect(convertedSourceCourts.length).toBeGreaterThanOrEqual(2);
    for (const cell of convertedSourceCourts) {
      const pocketArea = semanticPockets
        .filter((pocket) => pocket.lineage.includes(`/${cell.id}/`))
        .reduce((sum, pocket) => sum + overlap(cell.polygon, pocket.polygon), 0);
      const returnedParcelArea = plan.parcels.reduce((sum, parcel) => sum + overlap(cell.polygon, parcel.polygon), 0);
      expect(returnedParcelArea, cell.id).toBeGreaterThan(pocketArea);
      for (const pocket of semanticPockets.filter((candidate) => candidate.lineage.includes(`/${cell.id}/`))) {
        for (const parcel of plan.parcels) expect(overlap(parcel.polygon, pocket.polygon), pocket.id).toBeLessThan(0.5);
      }
    }
    const fragmentArea = plan.districtPlan.blocks.reduce((sum, block) =>
      sum + block.districtFragments.reduce((fragmentSum, fragment) => fragmentSum + multiArea(fragment.buildable), 0), 0);
    const landmarkArea = plan.landmarks.reduce((sum, landmark) => sum + landmark.areaM2, 0);
    const nonParcelOpenArea = plan.openSpaces
      .filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null)
      .reduce((sum, openSpace) => sum + openSpace.areaM2, 0);
    const developmentArea = fragmentArea - landmarkArea - nonParcelOpenArea;
    const parcelArea = plan.parcels.reduce((sum, parcel) => sum + parcel.areaM2, 0);
    const builtParcelIds = new Set(plan.buildings.map((building) => building.parcelId));
    const builtParcelArea = plan.parcels
      .filter((parcel) => builtParcelIds.has(parcel.id))
      .reduce((sum, parcel) => sum + parcel.areaM2, 0);
    expect(parcelArea / developmentArea).toBeGreaterThan(0.97);
    expect(builtParcelArea / developmentArea).toBeGreaterThan(0.72);
    const landmarkByGrammar = new Map(plan.landmarks.map((landmark) => [landmark.landmarkGrammarId, landmark]));
    for (const reservation of reservations) {
      const landmark = landmarkByGrammar.get(reservation.grammarId);
      expect(landmark, reservation.grammarId).toBeDefined();
      expect(landmark!.placementLineage, reservation.grammarId).toBe(reservation.lineage);
      expect(landmark!.sitePolygon, reservation.grammarId).toEqual(reservation.sitePolygon);
    }
    const preRoadIds = new Set<LandmarkGrammarId>(PRE_ROAD_LANDMARK_GRAMMAR_IDS);
    const fallbackLandmarks = plan.landmarks.filter((landmark) => !preRoadIds.has(landmark.landmarkGrammarId));
    expect(fallbackLandmarks.length).toBeGreaterThanOrEqual(6);
    expect(fallbackLandmarks.length).toBeLessThanOrEqual(8);
    let fullFallbackCount = 0;
    for (const landmark of fallbackLandmarks) {
      const grammar = LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId)!;
      const safeMinimumM2 = grammar.minSiteAreaM2 * FALLBACK_LANDMARK_SITE_MIN_AREA_MARGIN;
      const compactMaximumM2 = Math.max(FALLBACK_LANDMARK_SITE_TARGET_MAX_M2, safeMinimumM2);
      const compacted = landmark.areaM2 <= compactMaximumM2 + 0.5;
      expect(landmark.placementLineage, landmark.landmarkGrammarId).toMatch(/^fallback:/);
      expect(landmark.areaM2, landmark.id).toBeGreaterThanOrEqual(safeMinimumM2 - 0.5);
      if (!compacted) {
        fullFallbackCount++;
        expect(landmark.areaM2, `${landmark.id} bounded full-site fallback`)
          .toBeLessThanOrEqual(grammar.maxSiteAreaM2 + 0.5);
      }
      expect(landmark.masses.length, landmark.id).toBeGreaterThan(0);
      expect(overlapMulti(landmark.sitePolygon, plan.routeOccupancy.all), landmark.id).toBeLessThan(0.5);

      const block = plan.districtPlan.blocks.find((candidate) => candidate.id === landmark.blockId)!;
      const blockBuildable = union(block.districtFragments.map((fragment) => fragment.buildable));
      expect(overlapMulti(landmark.sitePolygon, blockBuildable), `${landmark.id} containment`)
        .toBeCloseTo(landmark.areaM2, 0);

      const surroundingParcels = plan.parcels.filter((parcel) => parcel.blockId === landmark.blockId);
      expect(surroundingParcels.length, `${landmark.id} remainder parcels`).toBeGreaterThan(0);
      const surroundingAreaM2 = surroundingParcels.reduce((sum, parcel) => sum + parcel.areaM2, 0);
      if (compacted) {
        expect(surroundingAreaM2, `${landmark.id} recovered parcel area`).toBeGreaterThan(landmark.areaM2);
      } else {
        expect(surroundingAreaM2, `${landmark.id} full-site surrounding fabric`).toBeGreaterThan(1_000);
      }
      for (const parcel of surroundingParcels) {
        expect(overlap(parcel.polygon, landmark.sitePolygon), `${landmark.id}/${parcel.id}`).toBeLessThan(0.5);
      }
      for (const other of plan.landmarks) {
        if (other.id !== landmark.id) expect(overlap(other.sitePolygon, landmark.sitePolygon), `${landmark.id}/${other.id}`).toBeLessThan(0.5);
      }

      if (grammar.requiredOpenSpace) {
        const carvedAreaM2 = plan.openSpaces
          .filter((openSpace) => openSpace.landmarkId === landmark.id)
          .reduce((sum, openSpace) => sum + overlap(openSpace.polygon, landmark.sitePolygon), 0);
        expect(carvedAreaM2 + 0.5, `${landmark.id} ${grammar.requiredOpenSpace.category}`)
          .toBeGreaterThanOrEqual(grammar.requiredOpenSpace.minShare * landmark.areaM2);
      }
    }
    expect(fullFallbackCount).toBeLessThanOrEqual(2);
  }, 150_000);

  it("completes european-single-very-low-0 deterministically with valid snapped topology", () => {
    const { source, reservations, warnings } = stagedReproduction(
      "european-single-very-low-0",
      "european",
      "single-centre",
      "very-low"
    );
    const generatedAgain = generateInitialDistricts({ ...source, districts: [] });
    const districtArea = source.districts.reduce((sum, district) => sum + Math.abs(ringArea(district.polygon)), 0);
    const repeatedArea = generatedAgain.reduce((sum, district) => sum + Math.abs(ringArea(district.polygon)), 0);

    expect(generatedAgain.map((district) => district.polygon)).toEqual(source.districts.map((district) => district.polygon));
    expect(Math.abs(repeatedArea - districtArea)).toBeLessThanOrEqual(1e-6);
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) plan.diagnostics.warnings.push(...warnings);
    expect(validateCompleteCityPlan(plan)).toEqual([]);

    const fragmentArea = plan.districtPlan.blocks.reduce((sum, block) =>
      sum + block.districtFragments.reduce((fragmentSum, fragment) => fragmentSum + multiArea(fragment.buildable), 0), 0);
    const landmarkArea = plan.landmarks.reduce((sum, landmark) => sum + landmark.areaM2, 0);
    const nonParcelOpenArea = plan.openSpaces
      .filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null)
      .reduce((sum, openSpace) => sum + openSpace.areaM2, 0);
    const developmentArea = fragmentArea - landmarkArea - nonParcelOpenArea;
    const parcelArea = plan.parcels.reduce((sum, parcel) => sum + parcel.areaM2, 0);
    const builtParcelIds = new Set(plan.buildings.map((building) => building.parcelId));
    const builtParcelArea = plan.parcels
      .filter((parcel) => builtParcelIds.has(parcel.id))
      .reduce((sum, parcel) => sum + parcel.areaM2, 0);
    const anonymousResidualArea = plan.openSpaces
      .filter((openSpace) =>
        openSpace.parcelId !== null
        || (openSpace.semanticRole === "landscape" && /boundary-sliver|residual/.test(openSpace.lineage))
      )
      .reduce((sum, openSpace) => sum + openSpace.areaM2, 0);
    expect(developmentArea).toBeGreaterThan(0);
    expect(parcelArea / developmentArea).toBeGreaterThan(0.97);
    expect(builtParcelArea / developmentArea).toBeGreaterThan(0.65);
    // Landmark-aware road cleanup plus density/v1 pockets deliberately convert a little
    // more fragment area into small breathing spaces. Every anonymous piece is separately
    // capped at 1,200 m²; retain a bounded aggregate budget while the parcel/development
    // and built/development assertions above continue to enforce dense city fabric.
    expect(anonymousResidualArea / fragmentArea).toBeLessThanOrEqual(0.12);

    const repeated = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) repeated.diagnostics.warnings.push(...warnings);
    expect(repeated).toEqual(plan);
    for (const ring of [
      ...plan.districtPlan.blocks.map((block) => block.zoningFace),
      ...plan.districtPlan.developmentCells.map((cell) => cell.polygon),
      ...plan.parcels.map((parcel) => parcel.polygon),
      ...plan.openSpaces.map((openSpace) => openSpace.polygon)
    ]) expect(validateRing(ring)).toEqual({ ok: true });
  }, 600_000);

  it("completes european-single-very-low-2 through district generation and a valid complete plan", () => {
    const { source, reservations, warnings } = stagedReproduction(
      "european-single-very-low-2",
      "european",
      "single-centre",
      "very-low"
    );
    const generatedAgain = generateInitialDistricts({ ...source, districts: [] });
    const districtArea = source.districts.reduce((sum, district) => sum + Math.abs(ringArea(district.polygon)), 0);
    const repeatedArea = generatedAgain.reduce((sum, district) => sum + Math.abs(ringArea(district.polygon)), 0);

    expect(source.districts.length).toBeGreaterThan(0);
    expect(generatedAgain.map((district) => district.polygon)).toEqual(source.districts.map((district) => district.polygon));
    expect(repeatedArea).toBeCloseTo(districtArea, 9);
    expect(districtArea).toBeGreaterThan(0);
    for (const district of source.districts) expect(validateRing(district.polygon)).toEqual({ ok: true });

    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) plan.diagnostics.warnings.push(...warnings);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    for (const ring of [
      ...plan.districtPlan.blocks.map((block) => block.zoningFace),
      ...plan.districtPlan.developmentCells.map((cell) => cell.polygon),
      ...plan.parcels.map((parcel) => parcel.polygon),
      ...plan.openSpaces.map((openSpace) => openSpace.polygon)
    ]) expect(validateRing(ring)).toEqual({ ok: true });
  }, 600_000);

  it("completes european-single-very-low-9 through district generation and a valid complete plan", () => {
    const { source, reservations, warnings } = stagedReproduction(
      "european-single-very-low-9",
      "european",
      "single-centre",
      "very-low"
    );
    const generatedAgain = generateInitialDistricts({ ...source, districts: [] });
    const districtArea = source.districts.reduce((sum, district) => sum + Math.abs(ringArea(district.polygon)), 0);
    const repeatedArea = generatedAgain.reduce((sum, district) => sum + Math.abs(ringArea(district.polygon)), 0);

    expect(source.districts.length).toBeGreaterThan(0);
    expect(generatedAgain.map((district) => district.polygon)).toEqual(source.districts.map((district) => district.polygon));
    expect(repeatedArea).toBeCloseTo(districtArea, 9);
    expect(districtArea).toBeGreaterThan(0);
    for (const district of source.districts) expect(validateRing(district.polygon)).toEqual({ ok: true });

    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    if (warnings.length > 0) plan.diagnostics.warnings.push(...warnings);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    for (const ring of [
      ...plan.districtPlan.blocks.map((block) => block.zoningFace),
      ...plan.districtPlan.developmentCells.map((cell) => cell.polygon),
      ...plan.parcels.map((parcel) => parcel.polygon),
      ...plan.openSpaces.map((openSpace) => openSpace.polygon)
    ]) expect(validateRing(ring)).toEqual({ ok: true });
  }, 600_000);

  it.concurrent("mints globally unique open-space ids that stay stable under regeneration", () => {
    // WHY: degenerate sliver pieces can reach the planner twice through one decomposition
    // (earcut repeats a triangle of a self-touching sliver polygon), which used to mint one
    // planned space with two identical ids. The contract is one id per distinct planned
    // space — including fragments/pieces sharing a semantic role — and a fresh build must
    // reproduce every id exactly, never a mutable encounter-order counter.
    const plan = compactFourPlan();
    const ids = plan.openSpaces.map((openSpace) => openSpace.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(compactFourRepeat().openSpaces.map((openSpace) => openSpace.id)).toEqual(ids);
  }, 300_000);

  it.concurrent("pins plot-sized density pockets and caps anonymous voids", () => {
    const plan = ringSixteenPlan();
    const pockets = plan.openSpaces.filter((openSpace) => openSpace.lineage.includes("/density/v1/pocket/"));
    expect(pockets.length).toBeGreaterThanOrEqual(4);
    expect(pockets.length).toBeLessThanOrEqual(6);
    expect(pockets.every((openSpace) =>
      openSpace.semanticRole === "plaza"
      && openSpace.category === "plaza"
      && openSpace.size === "pocket"
      && openSpace.areaM2 >= 100
      && openSpace.areaM2 <= MAX_ANONYMOUS_OPEN_SPACE_AREA_M2
    )).toBe(true);
    const pocketsPerBlock = new Map<string, number>();
    for (const pocket of pockets) pocketsPerBlock.set(pocket.blockId, (pocketsPerBlock.get(pocket.blockId) ?? 0) + 1);
    expect([...pocketsPerBlock.values()].every((count) => count >= 1 && count <= 2)).toBe(true);

    const anonymous = plan.openSpaces.filter((openSpace) =>
      openSpace.parcelId !== null
      || (openSpace.semanticRole === "landscape" && /boundary-sliver|residual/.test(openSpace.lineage))
    );
    expect(anonymous.length).toBeGreaterThan(0);
    expect(Math.max(...anonymous.map((openSpace) => openSpace.areaM2))).toBeLessThanOrEqual(MAX_ANONYMOUS_OPEN_SPACE_AREA_M2 + 0.5);
  }, 300_000);

  it("is deterministic and identical under source permutation and origin shift", () => {
    const source = crossSource();
    const plan = buildCompleteCityPlan(source);
    const shuffled: CitySourceV4 = {
      ...source,
      roads: { nodes: [...source.roads.nodes].reverse(), routes: [...source.roads.routes].reverse(), edges: [...source.roads.edges].reverse() },
      districts: [...source.districts].reverse()
    };
    expect(buildCompleteCityPlan(shuffled)).toEqual(plan);
    const shifted: CitySourceV4 = { ...source, origin: { x: source.origin.x + 12345, y: source.origin.y - 6789 } };
    expect(buildCompleteCityPlan(shifted)).toEqual(plan);
    expect(buildCompleteCityPlan(source)).toEqual(plan);
  }, 300_000);

  it("materializes grammar circulation as explicit open space before building parcels", () => {
    const size = 300;
    const largeBlock = (typeId: DistrictTypeId): CitySourceV4 => ({
      origin: { x: 700, y: 300 },
      citySeed: `complete-plan-large-block-${typeId}`,
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "none" },
      terrain: { land: rectRing({ x: 0, y: 0, width: size, height: size }), urbanFootprint: null },
      roads: {
        nodes: [node("a", 0, 0), node("b", size, 0), node("c", size, size), node("d", 0, size)],
        routes: [route("ring")],
        edges: [edge("ab", "a", "b", "ring"), edge("bc", "b", "c", "ring"), edge("cd", "c", "d", "ring"), edge("da", "d", "a", "ring")]
      },
      districts: [{ id: "big", polygon: rectRing({ x: 0, y: 0, width: size, height: size }), seed: "big-seed", typeId, paletteId: DISTRICT_PALETTE_IDS[0]!, origin: "generated", locked: false, openSpaceOverride: null }],
      architecture: { buildings: [], places: [], overrides: [] }
    });
    for (const typeId of ["residential-megablocks", "utility-infrastructure"] as const) {
      const source = largeBlock(typeId);
      const plan = buildCompleteCityPlan(source);
      expect(validateCompleteCityPlan(plan)).toEqual([]);
      expect(buildCompleteCityPlan(source)).toEqual(plan);
      const intentionalCells = plan.districtPlan.developmentCells.filter((cell) => cell.classification !== "building");
      expect(intentionalCells.length).toBeGreaterThan(0);
      const semanticSpaces = plan.openSpaces.filter((openSpace) => openSpace.semanticRole !== undefined);
      expect(semanticSpaces.length).toBeGreaterThan(0);
      expect(semanticSpaces.some((openSpace) => openSpace.semanticRole !== "landscape")).toBe(true);
      for (const openSpace of semanticSpaces) {
        const sourceCell = intentionalCells.find((cell) => openSpace.lineage === cell.id);
        if (sourceCell) {
          expect(openSpace.semanticRole).toBe(sourceCell.semanticRole);
          expect(openSpace.category).toBe(sourceCell.openSpaceCategory);
        }
        for (const parcel of plan.parcels) expect(overlap(parcel.polygon, openSpace.polygon), openSpace.id).toBeLessThan(0.5);
        for (const building of plan.buildings) {
          for (const mass of building.masses) expect(overlap(mass.footprint, openSpace.polygon), building.id).toBeLessThan(0.5);
        }
      }
      const residualCells = intentionalCells.filter((cell) => /residual|sliver/.test(cell.localRole));
      expect(residualCells.every((cell) => cell.classification === "landscape")).toBe(true);
      expect(plan.parcels.every((parcel) => {
        const sourceCell = plan.districtPlan.developmentCells.find((cell) => cell.fragmentId === parcel.fragmentId && parcel.role.startsWith(cell.localRole));
        return sourceCell?.classification === "building";
      })).toBe(true);
    }
  }, 300_000);

  it("stamps revision, action token, build token, and epoch deterministically", () => {
    const source = crossSource();
    const plan = buildCompleteCityPlan(source);
    expect(plan.sourceRevision).toBe(1);
    expect(plan.epoch).toBe(0);
    expect(String(plan.actionToken).length).toBeGreaterThan(0);
    expect(String(plan.buildToken).length).toBeGreaterThan(0);
    const stamped = buildCompleteCityPlan(source, 3, 7);
    expect(stamped.sourceRevision).toBe(3);
    expect(stamped.epoch).toBe(7);
    expect(stamped.actionToken).not.toBe(plan.actionToken);
    expect(stamped.buildToken).toBe(plan.buildToken);
    expect(validateCompleteCityPlan(stamped)).toEqual([]);
  }, 300_000);

  it.concurrent("honors global none, a district override above none, and landmark-required open space", () => {
    const nonePlan = buildCompleteCityPlan(compactRingSource("none"));
    expect(validateCompleteCityPlan(nonePlan)).toEqual([]);
    expect(nonePlan.openSpaces.filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null && openSpace.semanticRole === undefined)).toEqual([]);
    const landmarkOpen = nonePlan.openSpaces.filter((openSpace) => openSpace.landmarkId !== null);
    expect(landmarkOpen.length).toBeGreaterThanOrEqual(1);
    const requiredLandmark = nonePlan.landmarks.find((landmark) =>
      Boolean(LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId)?.requiredOpenSpace)
    )!;
    expect(requiredLandmark).toBeDefined();
    const requirement = LANDMARK_GRAMMAR_REGISTRY.get(requiredLandmark.landmarkGrammarId)!.requiredOpenSpace!;
    expect(requiredLandmark.openSpaceIds.length).toBeGreaterThan(0);
    const requiredOpenSpace = nonePlan.openSpaces.find((openSpace) => openSpace.id === requiredLandmark.openSpaceIds[0])!;
    expect(requiredOpenSpace.category).toBe(requirement.category);
    expect(overlap(requiredOpenSpace.polygon, requiredLandmark.sitePolygon)).toBeGreaterThan(requiredOpenSpace.areaM2 - 0.5);
    // Required landmark space survives global `none` and covers its grammar's declared share.
    expect(requiredOpenSpace.areaM2).toBeGreaterThanOrEqual(requirement.minShare * requiredLandmark.areaM2 - 0.5);

    const overriddenSource = compactRingSource("none");
    overriddenSource.districts = overriddenSource.districts.map((district, index) =>
      index === 3 ? { ...district, openSpaceOverride: parkOverride(0.5) } : district
    );
    const overriddenPlan = buildCompleteCityPlan(overriddenSource);
    expect(validateCompleteCityPlan(overriddenPlan)).toEqual([]);
    const ordinary = overriddenPlan.openSpaces.filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null && openSpace.districtId === overriddenSource.districts[3]!.id);
    expect(ordinary.length).toBeGreaterThan(0);
  }, 300_000);

  it.concurrent("produces final geometry for pocket, small, large, and whole-block sizes", () => {
    const source = compactRingSource("none");
    source.districts = source.districts.map((district, index) =>
      index === 2 ? {
        ...district,
        openSpaceOverride: {
          rate: 1,
          categoryWeights: { park: 1, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
          sizeWeights: { pocket: 0, small: 0, large: 0, "whole-block": 1 }
        }
      } : district
    );
    const plan = buildCompleteCityPlan(source);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const wholeBlock = plan.openSpaces.find((openSpace) => openSpace.districtId === source.districts[2]!.id && openSpace.landmarkId === null && openSpace.parcelId === null && openSpace.size === "whole-block");
    expect(wholeBlock?.size).toBe("whole-block");
    expect(wholeBlock!.areaM2).toBeGreaterThan(10_000);
    const districtStripArea = Math.abs(ringArea(source.districts[2]!.polygon));
    const districtBuildableArea = plan.districtPlan.blocks.reduce((sum, block) =>
      sum + block.districtFragments
        .filter((fragment) => fragment.districtId === source.districts[2]!.id)
        .reduce((fragmentSum, fragment) => fragmentSum + multiArea(fragment.buildable), 0), 0);
    expect(districtBuildableArea).toBeGreaterThan(0);
    expect(wholeBlock!.areaM2).toBeGreaterThan(Math.min(districtStripArea, districtBuildableArea) * 0.1);
    expect(wholeBlock!.areaM2).toBeLessThanOrEqual(districtStripArea + 0.5);
    // Landmark sites inside the strip are excluded from the whole-block open space; the
    // surrounding donut remainder becomes explicit parcels, never unexplained gaps.
    for (const parcel of plan.parcels) {
      if (parcel.districtId !== source.districts[2]!.id) continue;
      expect(overlap(parcel.polygon, wholeBlock!.polygon), parcel.id).toBeLessThan(0.5);
    }
    const mediumPlan = compactFourPlan();
    const sizes = new Set(mediumPlan.openSpaces.map((openSpace) => openSpace.size));
    expect(mediumPlan.openSpaces.length).toBeGreaterThan(0);
    for (const size of sizes) expect(["pocket", "small", "large", "whole-block"]).toContain(size);
  }, 300_000);

  it.concurrent("keeps every building mass inside its parcel, masses disjoint, parcels disjoint, and buildings clear of open spaces", () => {
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const parcelById = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
    for (const building of plan.buildings) {
      if (building.parcelId === null) continue;
      const parcel = parcelById.get(building.parcelId);
      if (parcel === undefined) continue;
      for (const mass of building.masses) {
        expect(overlap(mass.footprint, parcel.polygon), mass.id).toBeGreaterThan(Math.abs(ringArea(mass.footprint)) - 0.5);
      }
      for (let left = 0; left < building.masses.length; left++) {
        for (let right = left + 1; right < building.masses.length; right++) {
          const a = building.masses[left]!;
          const b = building.masses[right]!;
          // Stacked podium volumes legally share footprint at different elevations.
          const spansOverlap = a.elevationM < b.elevationM + b.heightM && b.elevationM < a.elevationM + a.heightM;
          if (spansOverlap) expect(overlap(a.footprint, b.footprint), building.id).toBeLessThan(0.5);
        }
      }
    }
    const bounds = plan.parcels.map((parcel) => ringBounds(parcel.polygon));
    for (let left = 0; left < plan.parcels.length; left++) {
      for (let right = left + 1; right < plan.parcels.length; right++) {
        if (!rectsIntersect(bounds[left]!, bounds[right]!)) continue;
        expect(overlap(plan.parcels[left]!.polygon, plan.parcels[right]!.polygon), plan.parcels[left]!.id).toBeLessThan(0.5);
      }
    }
    for (const building of plan.buildings) {
      for (const openSpace of plan.openSpaces) {
        if (openSpace.landmarkId !== null) continue;
        for (const mass of building.masses) {
          expect(overlap(mass.footprint, openSpace.polygon), building.id).toBeLessThan(0.5);
        }
      }
    }
  }, 300_000);

  it.concurrent("keeps landmark sites road-free, disjoint from parcels, and masses inside sites", () => {
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    for (const landmark of plan.landmarks) {
      expect(overlapMulti(landmark.sitePolygon, plan.routeOccupancy.all), landmark.id).toBeLessThan(0.5);
      for (const parcel of plan.parcels) {
        expect(overlap(landmark.sitePolygon, parcel.polygon), landmark.id).toBeLessThan(0.5);
      }
      for (const mass of landmark.masses) {
        expect(overlap(mass.footprint, landmark.sitePolygon), mass.id).toBeGreaterThan(Math.abs(ringArea(mass.footprint)) - 0.5);
      }
      for (let left = 0; left < landmark.masses.length; left++) {
        for (let right = left + 1; right < landmark.masses.length; right++) {
          const a = landmark.masses[left]!;
          const b = landmark.masses[right]!;
          const spansOverlap = a.elevationM < b.elevationM + b.heightM && b.elevationM < a.elevationM + a.heightM;
          if (spansOverlap) expect(overlap(a.footprint, b.footprint), landmark.id).toBeLessThan(0.5);
        }
      }
    }
  }, 300_000);

  it.concurrent("materializes all sixteen memorable landmark compositions at overview scale", () => {
    const plan = fullReservationPlan();
    expect(plan.landmarks).toHaveLength(16);
    const byGrammar = new Map(plan.landmarks.map((landmark) => [landmark.landmarkGrammarId, landmark]));

    const stadium = byGrammar.get("stadium-bowl")!;
    expect(stadium.masses.filter((mass) => mass.kind === "stadium-bowl-segment")).toHaveLength(8);
    expect(stadium.masses.reduce((sum, mass) => sum + Math.abs(ringArea(mass.footprint)), 0) / stadium.areaM2).toBeLessThan(0.55);

    const cooling = byGrammar.get("cooling-tower-yard")!;
    expect(cooling.masses.length).toBeGreaterThanOrEqual(3);
    expect(cooling.masses.length).toBeLessThanOrEqual(5);
    expect(cooling.masses.every((mass) => mass.kind === "cooling-tower" && mass.footprint.length === 8)).toBe(true);

    const garden = byGrammar.get("garden-arcology")!;
    expect(garden.masses).toHaveLength(3);
    for (let index = 1; index < garden.masses.length; index++) {
      expect(garden.masses[index]!.elevationM).toBeCloseTo(garden.masses[index - 1]!.elevationM + garden.masses[index - 1]!.heightM, 9);
      expect(Math.abs(ringArea(garden.masses[index]!.footprint))).toBeLessThan(Math.abs(ringArea(garden.masses[index - 1]!.footprint)));
    }

    const event = byGrammar.get("event-plaza-pylon")!;
    const pylon = event.masses.find((mass) => mass.kind === "luminous-pylon")!;
    expect(pylon.heightM).toBeGreaterThan(90);
    expect(event.openSpaceIds).toHaveLength(1);

    const hex = byGrammar.get("hex-corporate-hq")!;
    expect(hex.masses.every((mass) => mass.footprint.length === 6)).toBe(true);

    const gateway = byGrammar.get("logo-gateway")!;
    expect(gateway.masses.filter((mass) => mass.kind === "logo-gateway-support")).toHaveLength(2);
    expect(gateway.masses.find((mass) => mass.kind === "elevated-logo-sign")!.elevationM).toBeGreaterThan(0);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
  }, 600_000);

  it.concurrent("honors pre-reserved major landmark sites verbatim", () => {
    // Generate roads around the current reservation polygons, then assign compatible
    // districts exactly as the full-generation flow does. A hand-authored ring road is
    // not a valid fixture for testing the pre-road reservation contract.
    const { source, reservations: reserved } = fullReservationFixture();
    expect(reserved.length).toBe(LANDMARK_GRAMMAR_IDS.length);
    expect(reserveMajorLandmarkSites(source, LANDMARK_GRAMMAR_IDS)).toEqual(reserved);
    expect(reserveMajorLandmarkSites(source).map((reservation) => reservation.grammarId)).toEqual(PRE_ROAD_LANDMARK_GRAMMAR_IDS);
    const plan = fullReservationPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.diagnostics.landmarkCount).toBe(reserved.length);
    expect(plan.diagnostics.landmarkFailures).toEqual([]);
    for (const reservation of reserved) {
      const landmark = plan.landmarks.find((candidate) => candidate.landmarkGrammarId === reservation.grammarId)!;
      expect(landmark.sitePolygon).toEqual(reservation.sitePolygon);
      expect(landmark.placementLineage).toBe(reservation.lineage);
    }
    expect(derivePaletteBanks(source)).toEqual(plan.paletteBanks);
  }, 600_000);

  it.concurrent("honors explicit full-generation sites verbatim when their districts are compatible", () => {
    const source = ringSource(16);
    const reservations = [
      manualReservation("hero-tower-plaza", 10, 100),
      manualReservation("civic-corporate-compound", 110, 100),
      manualReservation("monument-open-space", 810, 100),
      manualReservation("infrastructure-utility-site", 910, 100),
      manualReservation("stadium-bowl", 10, 300, 240, 12)
    ];
    const explicitReservationBytes = JSON.stringify(reservations);
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    expect(JSON.stringify(reservations)).toBe(explicitReservationBytes);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const stadium = plan.landmarks.find((landmark) => landmark.landmarkGrammarId === "stadium-bowl")!;
    const stadiumBounds = ringBounds(stadium.sitePolygon);
    expect(stadiumBounds.width / stadiumBounds.height).toBeGreaterThan(10);
    expect(stadium.masses).toHaveLength(8);
    for (let left = 0; left < stadium.masses.length; left++) {
      for (let right = left + 1; right < stadium.masses.length; right++) {
        expect(overlap(stadium.masses[left]!.footprint, stadium.masses[right]!.footprint), `${left}/${right}`).toBeLessThan(0.5);
      }
    }
    const reservationLineages = new Set(reservations.map((reservation) => reservation.lineage));
    expect(plan.landmarks.filter((landmark) =>
      landmark.placementLineage !== undefined && reservationLineages.has(landmark.placementLineage)
    )).toHaveLength(reservations.length);
    expect(plan.diagnostics.landmarkCount).toBe(plan.landmarks.length);
    expect(reservations.every((reservation) => !plan.diagnostics.landmarkSkipped.includes(reservation.grammarId))).toBe(true);
    const districtById = new Map(source.districts.map((district) => [district.id, district]));
    for (const reservation of reservations) {
      const landmark = plan.landmarks.find((candidate) => candidate.landmarkGrammarId === reservation.grammarId)!;
      expect(landmark.sitePolygon).toEqual(reservation.sitePolygon);
      expect(landmark.placementLineage).toBe(reservation.lineage);
      const district = districtById.get(landmark.districtId!);
      const type = DISTRICT_TYPES.find((candidate) => candidate.id === district!.typeId)!;
      const grammar = LANDMARK_GRAMMAR_REGISTRY.get(reservation.grammarId)!;
      expect(grammar.compatibilityTags.some((tag) => type.compatibilityTags.includes(tag)), reservation.grammarId).toBe(true);
    }
  }, 300_000);
  it.concurrent("keeps explicit reservations verbatim even with district contrast and records a warning", () => {
    const source = ringSource(4);
    // ringSource(4) strips: corporate-core (formal), commercial-highrise (formal),
    // mixed-use-centre, residential-megablocks (campus) — the infrastructure reservation
    // sits in mixed-use-centre with no industrial tag, so it is kept verbatim as
    // deterministic contrast and reported as a warning, never dropped.
    const reservations = [
      manualReservation("hero-tower-plaza", 10, 100),
      manualReservation("civic-corporate-compound", 410, 100),
      manualReservation("infrastructure-utility-site", 810, 100),
      manualReservation("monument-open-space", 1210, 100)
    ];
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const reservationLineages = new Set(reservations.map((reservation) => reservation.lineage));
    expect(plan.landmarks.filter((landmark) =>
      landmark.placementLineage !== undefined && reservationLineages.has(landmark.placementLineage)
    )).toHaveLength(reservations.length);
    expect(plan.diagnostics.landmarkCount).toBe(plan.landmarks.length);
    expect(reservations.every((reservation) => !plan.diagnostics.landmarkSkipped.includes(reservation.grammarId))).toBe(true);
    expect(plan.diagnostics.warnings.some((warning) => warning.includes("infrastructure-utility-site") && warning.includes("contrast"))).toBe(true);
    for (const reservation of reservations) {
      const landmark = plan.landmarks.find((candidate) => candidate.landmarkGrammarId === reservation.grammarId)!;
      expect(landmark.sitePolygon).toEqual(reservation.sitePolygon);
      expect(landmark.placementLineage).toBe(reservation.lineage);
    }
  }, 300_000);


  it.concurrent("returns dropped internal reservation sites to explicit parcel accounting", () => {
    // Internal planning may drop a pre-road reservation (road overlap or an incompatible
    // cell); the dropped site must reappear as parcels/open spaces, never a void.
    const source = ringSource(4);
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const reserved = reserveMajorLandmarkSites(source);
    expect(reserved.length).toBe(PRE_ROAD_LANDMARK_GRAMMAR_IDS.length);
    const keptLineages = new Set(plan.landmarks.map((landmark) => landmark.placementLineage));
    const covering = union([
      ...plan.parcels.map((parcel) => ringAsMulti(parcel.polygon)),
      ...plan.openSpaces.filter((openSpace) => openSpace.landmarkId === null).map((openSpace) => ringAsMulti(openSpace.polygon))
    ]);
    let droppedSites = 0;
    for (const reservation of reserved) {
      if (keptLineages.has(reservation.lineage)) continue;
      droppedSites++;
      const siteArea = Math.abs(ringArea(reservation.sitePolygon));
      const accountedArea = multiArea(intersection(ringAsMulti(reservation.sitePolygon), covering));
      const roadArea = overlapMulti(reservation.sitePolygon, plan.routeOccupancy.all);
      // A reservation dropped because a road enters it cannot turn that occupied strip
      // back into a parcel. Polygon clipping around the newer non-rectangular landmark
      // sites can also leave bounded snap residuals, so require at least 88% of the
      // remaining developable area and cap the absolute unaccounted area below 800 m².
      // Together those bounds still reject a silently dropped site.
      const developableArea = siteArea - roadArea;
      expect(accountedArea / developableArea, reservation.grammarId).toBeGreaterThan(0.88);
      expect(developableArea - accountedArea, reservation.grammarId).toBeLessThan(800);
    }
    expect(droppedSites).toBeGreaterThan(0);
  }, 300_000);

  it.concurrent("throws a structural error when an explicit reservation cannot materialize", () => {
    const source = ringSource(4);
    // A degenerate zero-area site can never carry a landmark; the explicit path must
    // fail loudly instead of returning a plan with fewer landmarks than reservations.
    const degenerate = manualReservation("hero-tower-plaza", 10, 100, 0, 0);
    expect(() => buildCompleteCityPlan(source, 1, 0, [degenerate])).toThrow();
  }, 300_000);

  it.concurrent("never validates a plan with fewer landmarks than explicit reservations", () => {
    const { reservations } = fullReservationFixture();
    const plan = fullReservationPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.diagnostics.explicitReservationCount).toBe(reservations.length);
    const reservationLineages = new Set(reservations.map((reservation) => reservation.lineage));
    const removed = plan.landmarks.find((landmark) =>
      landmark.placementLineage !== undefined && reservationLineages.has(landmark.placementLineage)
    );
    expect(removed).toBeDefined();
    if (removed === undefined) return;
    const tampered: CompleteCityPlan = {
      ...plan,
      landmarks: plan.landmarks.filter((landmark) => landmark.id !== removed.id),
      openSpaces: plan.openSpaces.filter((openSpace) => openSpace.landmarkId !== removed.id)
    };
    expect(validateCompleteCityPlan(tampered).some((message) => message.includes("explicit reservations"))).toBe(true);
  }, 600_000);

  it("skips landmarks with no compatible district and falls back to compatible block-inscribed sites", () => {
    const plan = buildCompleteCityPlan(crossSource());
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    // The plain cross only carries fine-grain, market, and residential tags. Grammars
    // requiring wholly unrelated district families are explicitly skipped rather than
    // mis-associated; compatible old and newly appended grammars may share a block when
    // enough legal buildable area remains.
    const necessarilySkipped = [
      "hero-tower-plaza",
      "civic-corporate-compound",
      "infrastructure-utility-site",
      "monument-open-space",
      "circular-beacon-tower",
      "tri-spire",
      "comms-mast-field",
      "cooling-tower-yard",
      "hex-corporate-hq"
    ] as const;
    expect(plan.diagnostics.landmarkCount).toBeGreaterThanOrEqual(3);
    for (const grammarId of necessarilySkipped) expect(plan.diagnostics.landmarkSkipped, grammarId).toContain(grammarId);

    const fallbackPlan = buildCompleteCityPlan(compatibleCross());
    expect(fallbackPlan.landmarks.every((landmark) =>
      landmark.placementLineage !== undefined && landmark.placementLineage.startsWith("fallback:")
    )).toBe(true);
    const placed = new Set(fallbackPlan.landmarks.map((landmark) => landmark.landmarkGrammarId));
    for (const required of ["hero-tower-plaza", "civic-corporate-compound", "infrastructure-utility-site", "comms-mast-field"] as const) {
      expect(placed, required).toContain(required);
    }
    for (const landmark of fallbackPlan.landmarks) {
      expect(overlapMulti(landmark.sitePolygon, fallbackPlan.routeOccupancy.all), landmark.id).toBeLessThan(0.5);
    }
  }, 300_000);

  it.concurrent("classifies parcels with no fitting grammar as explicitly unbuilt open parcels", () => {
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const builtIds = new Set(plan.buildings.map((building) => building.parcelId));
    // Parcel-linked open spaces are either unbuilt landscaping or residual vacant
    // pieces. Oversized anonymous surfaces may be split, but every piece remains linked
    // to its source parcel and the pieces together cover that parcel exactly.
    const parcelLinked = plan.openSpaces.filter((openSpace) => openSpace.parcelId !== null);
    const unbuiltFallbacks = parcelLinked.filter((os) => os.seed.endsWith("/unbuilt"));
    const residualSlivers  = parcelLinked.filter((os) => !os.seed.endsWith("/unbuilt"));
    // Fix 3b: unbuilt parcel fallbacks now use "landscaping" so they blend with
    // the sidewalk surface instead of appearing as derelict scrub.
    expect(unbuiltFallbacks.every((os) => os.category === "landscaping")).toBe(true);
    expect(unbuiltFallbacks.every((os) => os.surfaceStyle === "paving" && os.detailStyle === "planters")).toBe(true);
    // Residual slivers from refined buildings remain "vacant".
    expect(residualSlivers.every((os) => os.category === "vacant")).toBe(true);
    const openSpacesByParcel = new Map<string, typeof parcelLinked>();
    for (const openSpace of parcelLinked) {
      openSpacesByParcel.set(openSpace.parcelId!, [...(openSpacesByParcel.get(openSpace.parcelId!) ?? []), openSpace]);
    }
    let unbuiltCount = 0;
    let unbuiltAreaM2 = 0;
    for (const parcel of plan.parcels) {
      if (builtIds.has(parcel.id)) continue;
      unbuiltCount++;
      unbuiltAreaM2 += parcel.areaM2;
      const owned = openSpacesByParcel.get(parcel.id);
      expect(owned, parcel.id).toBeDefined();
      expect(owned!.reduce((sum, openSpace) => sum + openSpace.areaM2, 0)).toBeCloseTo(parcel.areaM2, 4);
      expect(owned!.every((openSpace) => openSpace.areaM2 <= MAX_ANONYMOUS_OPEN_SPACE_AREA_M2 + 0.5), parcel.id).toBe(true);
    }
    expect(unbuiltCount).toBeGreaterThan(0);
    expect(openSpacesByParcel.size).toBe(unbuiltCount);
    expect(unbuiltFallbacks.length).toBeGreaterThan(0);
    expect(unbuiltAreaM2 / plan.parcels.reduce((sum, parcel) => sum + parcel.areaM2, 0)).toBeLessThanOrEqual(0.1);
    expect(parcelLinked.every((os) => os.material === MATERIAL.GROUND)).toBe(true);
    const intentional = plan.openSpaces.filter((openSpace) => openSpace.parcelId === null);
    expect(intentional.length).toBeGreaterThan(0);
    expect(intentional.some((openSpace) => openSpace.material !== MATERIAL.GROUND)).toBe(true);
    // A second compact build pins full planner determinism without regenerating the
    // overview-scale fabric solely for an equality assertion.
    expect(compactFourRepeat()).toEqual(compactFourPlan());
  }, 300_000);
  it("materializes every shipping grammar and all seventeen archetypes through the production path", () => {
    // Fixed legal breadth gallery: one deterministic parcel per grammar built from its
    // own declared limits, materialized through the same exported production path that
    // planBuildings uses, so all 55 grammars and 17 archetypes are proven as outputs.
    const archetypes = new Set<string>();
    for (const grammarId of BUILDING_GRAMMAR_IDS) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(grammarId)!;
      const limits = grammar.siteLimits;
      const width = (limits.minWidthM + limits.maxWidthM) / 2;
      const depth = (limits.minDepthM + limits.maxDepthM) / 2;
      const parcel = {
        id: `gallery-${grammarId}`,
        blockId: "block-0",
        fragmentId: "frag-0",
        districtId: null,
        polygon: rectRing({ x: 0, y: 0, width, height: depth }),
        frontageAngleRad: 0,
        seed: `gallery/${grammarId}`,
        areaM2: width * depth
      };
      // The midpoint parcel must itself be legal, proving the declared limits are
      // self-consistent before any generation.
      expect(parcel.areaM2, grammarId).toBeGreaterThanOrEqual(limits.minAreaM2);
      expect(parcel.areaM2, grammarId).toBeLessThanOrEqual(limits.maxAreaM2);
      expect(width / depth, grammarId).toBeGreaterThanOrEqual(limits.minAspect);
      expect(width / depth, grammarId).toBeLessThanOrEqual(limits.maxAspect);
      const weights = Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [id, id === grammarId ? 1 : 0])) as Record<BuildingGrammarId, number>;
      const useWeights = Object.fromEntries(BUILDING_USE_IDS.map((use) => [use, 1])) as Record<BuildingUseId, number>;
      const building = planParcelBuilding(parcel, weights, useWeights, undefined, new Map());
      expect(building, grammarId).not.toBeNull();
      expect(building!.grammarId, grammarId).toBe(grammarId);
      expect(building!.archetype, grammarId).toBe(grammar.archetype);
      archetypes.add(building!.archetype);
      expect(building!.masses.length, grammarId).toBeGreaterThanOrEqual(grammar.massing.minMasses);
      expect(building!.masses.length, grammarId).toBeLessThanOrEqual(grammar.massing.maxMasses);
      expect(building!.setbackM!, grammarId).toBeGreaterThanOrEqual(grammar.footprint.setbackMin);
      expect(building!.setbackM!, grammarId).toBeLessThanOrEqual(grammar.footprint.setbackMax);
      // The declared height range is enforced on the TOTAL: heightM is the peak of the
      // masses' tops and both stay inside the grammar's declared range.
      expect(building!.heightM, grammarId).toBeGreaterThanOrEqual(grammar.height.minM);
      expect(building!.heightM, grammarId).toBeLessThanOrEqual(grammar.height.maxM);
      const totalHeight = Math.max(...building!.masses.map((mass) => mass.elevationM + mass.heightM));
      expect(totalHeight, grammarId).toBeCloseTo(building!.heightM, 9);
      for (const mass of building!.masses) {
        expect(mass.elevationM + mass.heightM, mass.id).toBeLessThanOrEqual(grammar.height.maxM + 1e-9);
      }
      expect(grammar.compatibleUses, grammarId).toContain(building!.visualUse);
      if (grammar.archetype === "l-shape" || grammar.archetype === "u-shape") {
        const base = building!.masses.find((mass) => mass.elevationM === 0);
        expect(base, grammarId).toBeDefined();
        expect(base!.footprint.length, grammarId).toBeGreaterThan(4);
      }
      for (const mass of building!.masses) {
        expect(mass.neonEnabled, mass.id).toBe(grammar.geometryPolicy.neon);
        expect(overlap(mass.footprint, parcel.polygon), mass.id).toBeGreaterThan(Math.abs(ringArea(mass.footprint)) - 0.5);
      }
      for (let left = 0; left < building!.masses.length; left++) {
        for (let right = left + 1; right < building!.masses.length; right++) {
          const a = building!.masses[left]!;
          const b = building!.masses[right]!;
          const spansOverlap = a.elevationM < b.elevationM + b.heightM && b.elevationM < a.elevationM + a.heightM;
          if (spansOverlap) expect(overlap(a.footprint, b.footprint), grammarId).toBeLessThan(0.5);
        }
      }
      if (grammarId === "commercial-twin-tower-podium") {
        // Actual twin towers where declared: podium plus two sibling tower masses at the
        // same elevation, disjoint and contained in the podium footprint.
        const towers = building!.masses.filter((mass) => mass.massing === "tower");
        const podium = building!.masses.find((mass) => mass.massing === "podium")!;
        expect(towers.length).toBe(2);
        expect(towers[0]!.elevationM).toBe(towers[1]!.elevationM);
        expect(towers[0]!.elevationM).toBeGreaterThan(0);
        expect(overlap(towers[0]!.footprint, towers[1]!.footprint)).toBeLessThan(0.5);
        expect(overlap(towers[0]!.footprint, podium.footprint)).toBeGreaterThan(Math.abs(ringArea(towers[0]!.footprint)) - 0.5);
      }
      if (grammar.archetype === "chamfered") {
        const base = building!.masses[0]!;
        for (const mass of building!.masses) {
          expect([6, 8], mass.id).toContain(mass.footprint.length);
          expect(overlap(mass.footprint, base.footprint), mass.id).toBeGreaterThan(Math.abs(ringArea(mass.footprint)) - 0.5);
        }
      }
      if (grammar.archetype === "stepped") {
        expect(building!.masses.length).toBeGreaterThanOrEqual(3);
        for (let index = 1; index < building!.masses.length; index++) {
          const lower = building!.masses[index - 1]!;
          const upper = building!.masses[index]!;
          expect(Math.abs(ringArea(upper.footprint)), upper.id).toBeLessThan(Math.abs(ringArea(lower.footprint)));
          expect(upper.elevationM, upper.id).toBeCloseTo(lower.elevationM + lower.heightM, 9);
          expect(overlap(upper.footprint, building!.masses[0]!.footprint), upper.id).toBeGreaterThan(Math.abs(ringArea(upper.footprint)) - 0.5);
        }
      }
      if (grammar.archetype === "offset-tower") {
        const podium = building!.masses.find((mass) => mass.massing === "podium")!;
        const tower = building!.masses.find((mass) => mass.massing === "offset-tower")!;
        const podiumCentre = ringCentroid(podium.footprint);
        const towerCentre = ringCentroid(tower.footprint);
        expect(Math.hypot(towerCentre.x - podiumCentre.x, towerCentre.y - podiumCentre.y), grammarId).toBeGreaterThan(0.1);
        expect(overlap(tower.footprint, podium.footprint), grammarId).toBeGreaterThan(Math.abs(ringArea(tower.footprint)) - 0.5);
      }
      if (grammar.archetype === "bridge") {
        const supports = building!.masses.filter((mass) => mass.massing === "bridge-support");
        const connector = building!.masses.find((mass) => mass.massing === "skybridge")!;
        expect(supports).toHaveLength(2);
        expect(connector.elevationM).toBeGreaterThan(0);
        expect(connector.heightM).toBeGreaterThanOrEqual(6);
        expect(connector.heightM).toBeLessThanOrEqual(12);
        const supportBounds = supports.map((support) => ringBounds(support.footprint)).sort((a, b) => a.x - b.x);
        const connectorBounds = ringBounds(connector.footprint);
        expect(connectorBounds.x).toBeCloseTo(supportBounds[0]!.x + supportBounds[0]!.width, 9);
        expect(connectorBounds.x + connectorBounds.width).toBeCloseTo(supportBounds[1]!.x, 9);
        for (const support of supports) {
          const spansOverlap = connector.elevationM < support.elevationM + support.heightM &&
            support.elevationM < connector.elevationM + connector.heightM;
          expect(spansOverlap, support.id).toBe(true);
          expect(overlap(connector.footprint, support.footprint), support.id).toBeLessThan(0.5);
        }
      }
      if (grammar.archetype === "cantilever") {
        const base = building!.masses.find((mass) => mass.massing === "cantilever-base")!;
        const upper = building!.masses.find((mass) => mass.massing === "cantilever-slab")!;
        expect(Math.abs(ringArea(upper.footprint)) - overlap(upper.footprint, base.footprint), grammarId).toBeGreaterThan(0.5);
        expect(upper.elevationM).toBeGreaterThanOrEqual(base.heightM);
      }
      if (grammar.archetype === "t-shape") {
        expect(building!.masses[0]!.footprint.length, grammarId).toBeGreaterThanOrEqual(8);
      }
      if (grammar.archetype === "cross" || grammar.archetype === "h-shape") {
        expect(building!.masses[0]!.footprint.length, grammarId).toBeGreaterThan(8);
      }
      if (grammar.archetype === "hexagonal") {
        expect(building!.masses.every((mass) => mass.footprint.length === 6), grammarId).toBe(true);
      }
      if (grammar.archetype === "sawtooth") {
        const base = building!.masses.find((mass) => mass.massing === "merged-sawtooth-base")!;
        expect(base, grammarId).toBeDefined();
        expect(base.footprint.length, grammarId).toBeGreaterThan(8);
      }
    }
    expect([...archetypes].sort()).toEqual([...FOOTPRINT_ARCHETYPE_IDS].sort());
  }, 60_000);

  it("keeps stacked and multi-mass totals inside every grammar's declared height range", () => {
    // Probe a deterministic seed spread per grammar: every produced total must equal the
    // declared heightM inside the grammar range, regardless of the mass-count roll, and
    // stacked L/U outputs must sit exactly on the base's top.
    for (const grammarId of BUILDING_GRAMMAR_IDS) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(grammarId)!;
      const limits = grammar.siteLimits;
      const width = (limits.minWidthM + limits.maxWidthM) / 2;
      const depth = (limits.minDepthM + limits.maxDepthM) / 2;
      const weights = Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [id, id === grammarId ? 1 : 0])) as Record<BuildingGrammarId, number>;
      const useWeights = Object.fromEntries(BUILDING_USE_IDS.map((use) => [use, 1])) as Record<BuildingUseId, number>;
      let stackedSeen = 0;
      for (let seedIndex = 0; seedIndex < 40; seedIndex++) {
        const probe = {
          id: `probe-${grammarId}-${seedIndex}`,
          blockId: "block-0",
          fragmentId: "frag-0",
          districtId: null,
          polygon: rectRing({ x: 0, y: 0, width, height: depth }),
          frontageAngleRad: 0,
          seed: `probe/${grammarId}/${seedIndex}`,
          areaM2: width * depth
        };
        const building = planParcelBuilding(probe, weights, useWeights, undefined, new Map());
        if (building === null) continue;
        expect(building.heightM, building.id).toBeGreaterThanOrEqual(grammar.height.minM - 1e-9);
        expect(building.heightM, building.id).toBeLessThanOrEqual(grammar.height.maxM + 1e-9);
        const totalHeight = Math.max(...building.masses.map((mass) => mass.elevationM + mass.heightM));
        expect(totalHeight, building.id).toBeCloseTo(building.heightM, 9);
        for (const mass of building.masses) {
          expect(mass.elevationM + mass.heightM, mass.id).toBeLessThanOrEqual(grammar.height.maxM + 1e-9);
        }
        if (building.masses.length >= 2 && (grammar.archetype === "l-shape" || grammar.archetype === "u-shape")) {
          stackedSeen++;
          expect(building.masses[1]!.elevationM, building.id).toBeCloseTo(building.masses[0]!.heightM, 9);
        }
      }
      if ((grammar.archetype === "l-shape" || grammar.archetype === "u-shape") && grammar.massing.maxMasses >= 2) {
        expect(stackedSeen, grammarId).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it("changes only appearance fields when the appearance seed changes", () => {
    const parcel = {
      id: "iso-parcel",
      blockId: "block-0",
      fragmentId: "frag-0",
      districtId: null,
      polygon: rectRing({ x: 0, y: 0, width: 40, height: 34 }),
      frontageAngleRad: 0,
      seed: "iso/parcel",
      areaM2: 40 * 34
    };
    const weights = Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [id, id === "corporate-tower-podium" ? 1 : 0])) as Record<BuildingGrammarId, number>;
    const useWeights = Object.fromEntries(BUILDING_USE_IDS.map((use) => [use, 1])) as Record<BuildingUseId, number>;
    const first = planParcelBuilding(parcel, weights, useWeights, undefined, new Map(), "iso/appearance/one")!;
    const second = planParcelBuilding(parcel, weights, useWeights, undefined, new Map(), "iso/appearance/two")!;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const geometry = (plan: BuildingPlan): string =>
      JSON.stringify([
        plan.id,
        plan.parcelId,
        plan.blockId,
        plan.fragmentId,
        plan.districtId,
        plan.grammarId,
        plan.visualUse,
        plan.archetype,
        plan.seed,
        plan.heightM,
        plan.setbackM,
        plan.areaM2,
        plan.masses.map((mass) => [
          mass.id,
          mass.buildingId,
          mass.index,
          mass.footprint,
          mass.archetype,
          mass.elevationM,
          mass.heightM,
          mass.massing,
          mass.frontage,
          mass.wallSlots,
          mass.roofSlots,
          mass.neonSlots,
          mass.detailPolicy,
          mass.neonEnabled,
          mass.seed
        ])
      ]);
    const appearance = (plan: BuildingPlan): string =>
      JSON.stringify(
        plan.masses.map((mass) => [
          mass.roofline,
          mass.facadeProfile,
          mass.wallMaterial,
          mass.roofMaterial,
          mass.facadeSeed,
          mass.signageRate,
          mass.rooftopUtilityRate,
          mass.wear
        ])
      );
    expect(geometry(second)).toBe(geometry(first));
    expect(appearance(second)).not.toBe(appearance(first));
    // The production default appearance lineage is the parcel-derived appearance stream.
    expect(planParcelBuilding(parcel, weights, useWeights, undefined, new Map())!.appearanceSeed).toBe("iso/parcel/appearance");
  }, 30_000);

  it.concurrent("reaches every archetype and a broad grammar set in a single whole-city plan", () => {
    // Ordinary whole-city reachability sanity: one deterministic plan must produce all
    // seventeen archetypes and a broad set of shipping grammars as generated outputs.
    const plan = ringSixteenPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.buildings.length).toBeGreaterThan(0);
    const grammars = new Set(plan.buildings.map((building) => building.grammarId));
    const archetypes = new Set(plan.buildings.map((building) => building.archetype));
    expect(grammars.size).toBeGreaterThanOrEqual(16);
    expect([...archetypes].sort()).toEqual([...FOOTPRINT_ARCHETYPE_IDS].sort());
    for (const archetype of ["t-shape", "cross", "h-shape", "hexagonal", "sawtooth"] as const) {
      expect(plan.buildings.filter((building) => building.archetype === archetype).length, archetype).toBeGreaterThanOrEqual(10);
    }
    for (const building of plan.buildings) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(building.grammarId)!;
      expect(building.heightM, building.id).toBeGreaterThanOrEqual(grammar.height.minM);
      expect(building.heightM, building.id).toBeLessThanOrEqual(grammar.height.maxM);
      expect(Math.max(...building.masses.map((mass) => mass.elevationM + mass.heightM)), building.id).toBeCloseTo(building.heightM, 9);
    }
  }, 300_000);

  it.concurrent("rejects injected illegal cross-occupancy, missing landmark open space, and non-fitting grammars", () => {
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.buildings.length).toBeGreaterThan(0);
    const occupiedLandmark = plan.landmarks.find((landmark) => landmark.masses.length > 0)!;
    const requiredLandmark = plan.landmarks.find((landmark) => {
      const grammar = LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId);
      return Boolean(grammar?.requiredOpenSpace)
        && Math.abs(ringArea(landmark.sitePolygon)) >= (grammar?.minSiteAreaM2 ?? Infinity)
        && landmark.openSpaceIds.length > 0;
    })!;
    expect(occupiedLandmark).toBeDefined();
    expect(requiredLandmark).toBeDefined();
    const requiredCategory = LANDMARK_GRAMMAR_REGISTRY.get(requiredLandmark.landmarkGrammarId)!.requiredOpenSpace!.category;
    const firstParcel = plan.parcels[0]!;
    const firstBuilding = plan.buildings[0]!;
    // (a) a parcel invading a landmark site
    const parcelInvasion: CompleteCityPlan = {
      ...plan,
      parcels: plan.parcels.map((parcel) =>
        parcel.id === firstParcel.id
          ? { ...parcel, polygon: occupiedLandmark.sitePolygon, areaM2: Math.abs(ringArea(occupiedLandmark.sitePolygon)) }
          : parcel
      )
    };
    expect(validateCompleteCityPlan(parcelInvasion).some((message) => message.includes("overlaps landmark site"))).toBe(true);
    // (b) an ordinary mass invading a landmark mass
    const massInvasion: CompleteCityPlan = {
      ...plan,
      buildings: plan.buildings.map((building) =>
        building.id === firstBuilding.id && building.masses.length > 0
          ? { ...building, masses: building.masses.map((mass, index) =>
            index === 0 ? { ...mass, footprint: occupiedLandmark.masses[0]!.footprint } : mass
          ) }
          : building
      )
    };
    expect(validateCompleteCityPlan(massInvasion).some((message) => message.includes("overlaps landmark"))).toBe(true);
    // (c) missing required landmark open space
    const missingRequiredOpenSpace: CompleteCityPlan = {
      ...plan,
      openSpaces: plan.openSpaces.filter((openSpace) => !requiredLandmark.openSpaceIds.includes(openSpace.id)),
      landmarks: plan.landmarks.map((landmark) =>
        landmark.id === requiredLandmark.id ? { ...landmark, openSpaceIds: [] } : landmark
      )
    };
    expect(validateCompleteCityPlan(missingRequiredOpenSpace).some((message) =>
      message.includes(`requires ${requiredCategory} open space`)
    )).toBe(true);
    // (d) a grammar that cannot fit its parcel
    const nonFitting: CompleteCityPlan = {
      ...plan,
      parcels: plan.parcels.map((parcel) =>
        parcel.id === firstBuilding.parcelId ? { ...parcel, polygon: rectRing({ x: 0, y: 0, width: 10, height: 10 }), areaM2: 100 } : parcel
      ),
      buildings: plan.buildings.map((building) => (building.id === firstBuilding.id ? { ...building, grammarId: "industrial-shed" } : building))
    };
    expect(validateCompleteCityPlan(nonFitting).some((message) => message.includes("does not fit its parcel"))).toBe(true);
    // (e) non-landmark grammar-authored courts cannot regress to district-scale voids.
    const oversizedSemanticCourt: CompleteCityPlan = {
      ...plan,
      openSpaces: plan.openSpaces.map((openSpace, index) =>
        index === 0
          ? {
            ...openSpace,
            landmarkId: null,
            parcelId: null,
            semanticRole: "courtyard",
            areaM2: MAX_SEMANTIC_CELL_OPEN_SPACE_AREA_M2 + 1
          }
          : openSpace
      )
    };
    expect(validateCompleteCityPlan(oversizedSemanticCourt).some((message) =>
      message.includes("exceeds the development-cell area cap")
    )).toBe(true);
    // (f) an invalid neon flag on a mass
    const badNeon: CompleteCityPlan = {
      ...plan,
      buildings: plan.buildings.map((building) =>
        building.id === firstBuilding.id && building.masses.length > 0
          ? { ...building, masses: building.masses.map((mass, index) => (index === 0 ? { ...mass, neonEnabled: "yes" as unknown as boolean } : mass)) }
          : building
      )
    };
    expect(validateCompleteCityPlan(badNeon).some((message) => message.includes("invalid neon flag"))).toBe(true);
    // (g) frontage descriptors must remain unit world-space vectors.
    const badFrontage: CompleteCityPlan = {
      ...plan,
      buildings: plan.buildings.map((building) =>
        building.id === firstBuilding.id && building.masses.length > 0
          ? { ...building, masses: building.masses.map((mass, index) => (index === 0 ? { ...mass, frontage: { angleRad: 0, outward: { x: 0, y: 0 } } } : mass)) }
          : building
      )
    };
    expect(validateCompleteCityPlan(badFrontage).some((message) => message.includes("invalid frontage descriptor"))).toBe(true);
  }, 300_000);

  it.concurrent("rejects injected building totals outside the grammar's declared height range", () => {
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const first = plan.buildings[0]!;
    const grammar = BUILDING_GRAMMAR_REGISTRY.get(first.grammarId)!;
    const withHeight = (heightM: number): CompleteCityPlan => ({
      ...plan,
      buildings: plan.buildings.map((building) => (building.id === first.id ? { ...building, heightM } : building))
    });
    expect(
      validateCompleteCityPlan(withHeight(grammar.height.maxM + 100)).some(
        (message) => message.includes("total height") && message.includes("outside")
      )
    ).toBe(true);
    expect(
      validateCompleteCityPlan(withHeight(grammar.height.minM - 100)).some(
        (message) => message.includes("total height") && message.includes("outside")
      )
    ).toBe(true);
    // A single mass towering past the declared maximum is rejected even when heightM is
    // left untouched, because the total must equal the peak of the masses' tops.
    const tallMass: CompleteCityPlan = {
      ...plan,
      buildings: plan.buildings.map((building) =>
        building.id === first.id && building.masses.length > 0
          ? { ...building, masses: building.masses.map((mass, index) => (index === 0 ? { ...mass, heightM: grammar.height.maxM + 50 } : mass)) }
          : building
      )
    };
    const tallProblems = validateCompleteCityPlan(tallMass);
    expect(tallProblems.some((message) => message.includes("declared maximum height"))).toBe(true);
    expect(tallProblems.some((message) => message.includes("masses' peak"))).toBe(true);
  }, 300_000);
});

describe("frontage placement", () => {
  const frontage = (axis: "u" | "v", sign: 1 | -1): FrontageSide => ({ axis, sign });
  const only = (grammarId: BuildingGrammarId): Record<BuildingGrammarId, number> =>
    Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [id, id === grammarId ? 1 : 0])) as Record<BuildingGrammarId, number>;
  const allUses = (): Record<BuildingUseId, number> =>
    Object.fromEntries(BUILDING_USE_IDS.map((use) => [use, 1])) as Record<BuildingUseId, number>;
  const parcel = (x: number, y: number, width: number, height: number, angle = 0) => ({
    id: `parcel-${x}-${y}`,
    blockId: "block-0",
    fragmentId: "fragment-0",
    districtId: null,
    polygon: rectRing({ x, y, width, height }),
    frontageAngleRad: angle,
    seed: `parcel-${x}-${y}`,
    areaM2: width * height
  });

  it("pushes a street-wall mass flush to its frontage with no side moats", () => {
    // narrow-shopfront: maxWidthM 16, maxDepthM 30, maxAreaM2 480
    const input = parcel(0, 0, 14, 26);
    const building = planParcelBuilding(input, only("narrow-shopfront"), allUses(), undefined, new Map(), undefined, frontage("v", 1));
    expect(building, "street-wall grammar must build on a fitting parcel").not.toBeNull();
    const grammar = BUILDING_GRAMMAR_REGISTRY.get(building!.grammarId)!;
    expect(grammar.frontage.mode).toBe("street-wall");
    // Front edge: in the parcel's local frame the front is the max-Y side (sign +1).
    const localMasses = building!.masses.map((mass, index) => ({
      id: `${building!.id}|m${index}`,
      maxY: Math.max(...mass.footprint.map((point) => point.y)),
      minX: Math.min(...mass.footprint.map((point) => point.x)),
      maxX: Math.max(...mass.footprint.map((point) => point.x))
    }));
    const front = 26;
    for (const mass of localMasses) {
      // flush to the road: front gap at most the declared front-setback maximum
      expect(front - mass.maxY, mass.id).toBeGreaterThanOrEqual(-0.01);
      expect(front - mass.maxY, mass.id).toBeLessThanOrEqual(grammar.frontage.frontSetback[1] + 0.01);
    }
    // width span: the mass fills the parcel width (no buffer moats on the sides)
    const span = Math.max(...localMasses.map((mass) => mass.maxX)) - Math.min(...localMasses.map((mass) => mass.minX));
    expect(span).toBeGreaterThan(14 * 0.85);
    expect(building!.masses.every((mass) =>
      mass.frontage?.angleRad === 0 &&
      mass.frontage.outward.x === 0 &&
      mass.frontage.outward.y === 1
    )).toBe(true);
  });

  it("centers the same street-wall grammar when no frontage is detected but still fills the parcel width", () => {
    const input = parcel(0, 0, 14, 26);
    const building = planParcelBuilding(input, only("narrow-shopfront"), allUses(), undefined, new Map());
    expect(building).not.toBeNull();
    const ys = building!.masses.flatMap((mass) => mass.footprint.map((point) => point.y));
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const midY = (minY + maxY) / 2;
    expect(midY).toBeGreaterThan(9);
    expect(midY).toBeLessThan(17);
    const xs = building!.masses.flatMap((mass) => mass.footprint.map((point) => point.x));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(14 * 0.85);
    expect(building!.masses.every((mass) => mass.frontage === null)).toBe(true);
  });

  it("persists one deterministic world-space frontage tangent and outward normal on every mass", () => {
    const angle = Math.PI / 3;
    const width = 50;
    const depth = 44;
    const centre = { x: width / 2, y: depth / 2 };
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const base = parcel(0, 0, width, depth, angle);
    const input = {
      ...base,
      // Keep the parcel geometry aligned with its declared frontage frame; 50×44 m is
      // comfortably inside the production grammar's current site limits.
      polygon: base.polygon.map((point) => ({
        x: centre.x + (point.x - centre.x) * cos - (point.y - centre.y) * sin,
        y: centre.y + (point.x - centre.x) * sin + (point.y - centre.y) * cos
      }))
    };
    const side: FrontageSide = { axis: "u", sign: -1, angleRad: angle + Math.PI / 2 };
    const first = planParcelBuilding(input, only("corporate-tower-podium"), allUses(), undefined, new Map(), undefined, side);
    const second = planParcelBuilding(input, only("corporate-tower-podium"), allUses(), undefined, new Map(), undefined, side);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const expected = {
      angleRad: angle + Math.PI / 2,
      outward: { x: -Math.cos(angle), y: -Math.sin(angle) }
    };
    expect(first!.masses.map((mass) => mass.frontage)).toEqual(first!.masses.map(() => expected));
    expect(second!.masses.map((mass) => mass.frontage)).toEqual(first!.masses.map((mass) => mass.frontage));
    const descriptor = first!.masses[0]!.frontage!;
    expect(Math.hypot(descriptor.outward.x, descriptor.outward.y)).toBeCloseTo(1, 12);
    expect(descriptor.outward.x * Math.cos(descriptor.angleRad) + descriptor.outward.y * Math.sin(descriptor.angleRad)).toBeCloseTo(0, 12);
  });

  it("keeps a setback-mode grammar off the street with a front plaza", () => {
    // civic-pavilion: maxDepthM 34
    const input = parcel(0, 0, 30, 30);
    const building = planParcelBuilding(input, only("civic-pavilion"), allUses(), undefined, new Map(), undefined, frontage("v", 1));
    expect(building).not.toBeNull();
    const grammar = BUILDING_GRAMMAR_REGISTRY.get(building!.grammarId)!;
    expect(grammar.frontage.mode).toBe("setback");
    const maxY = Math.max(...building!.masses.flatMap((mass) => mass.footprint.map((point) => point.y)));
    expect(30 - maxY).toBeGreaterThanOrEqual(grammar.frontage.frontSetback[0] - 0.01);
  });

  it("builds sub-100 m² fine-grain parcels through the micro grammars", () => {
    const input = parcel(0, 0, 6, 6); // 36 m² — below the old 100 m² main-grammar floor
    const building = planParcelBuilding(input, only("street-kiosk"), allUses(), undefined, new Map(), undefined, frontage("v", 1));
    expect(building, "a 36 m² parcel must produce a street-kiosk").not.toBeNull();
    expect(building!.grammarId).toBe("street-kiosk");
    const grammar = BUILDING_GRAMMAR_REGISTRY.get("street-kiosk")!;
    expect(building!.heightM).toBeGreaterThanOrEqual(grammar.height.minM);
    expect(building!.heightM).toBeLessThanOrEqual(grammar.height.maxM);
    for (const mass of building!.masses) {
      expect(overlap(mass.footprint, input.polygon)).toBeGreaterThan(Math.abs(ringArea(mass.footprint)) - 0.5);
    }
  });

  it.concurrent("keeps whole-city density above the pre-pass moat baseline", () => {
    // Regression floor for the Phase 4.5 density pass: before it, the median parcel
    // occupancy on the ring fixture was ~0.25 (buildings centered with all-side moats).
    const plan = ringSixteenPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const parcelById = new Map(plan.parcels.map((p) => [p.id, p]));
    const ratios = plan.buildings
      .map((building) => {
        const p = building.parcelId === null ? undefined : parcelById.get(building.parcelId);
        return p ? building.areaM2 / p.areaM2 : 0;
      })
      .sort((a, b) => a - b);
    expect(ratios.length).toBeGreaterThan(0);
    const median = ratios[Math.floor(ratios.length / 2)]!;
    expect(median).toBeGreaterThan(0.45);
    // And the width-span contract: no building may sit with big side moats. The
    // mass union spans the parcel's local width on the median (irregular clipped
    // pieces can legitimately have wider AABBs than their building).
    const spans: number[] = [];
    for (const building of plan.buildings) {
      const p = building.parcelId === null ? undefined : parcelById.get(building.parcelId);
      if (!p) continue;
      const centre = ringCentroid(p.polygon);
      const local = p.polygon.map((point) => {
        const dx = point.x - centre.x;
        const dy = point.y - centre.y;
        const c = Math.cos(-p.frontageAngleRad);
        const s = Math.sin(-p.frontageAngleRad);
        return { x: centre.x + dx * c - dy * s, y: centre.y + dx * s + dy * c };
      });
      const bounds = ringBounds(local);
      const massXs = building.masses.flatMap((mass) => mass.footprint.map((point) => {
        const dx = point.x - centre.x;
        const dy = point.y - centre.y;
        const c = Math.cos(-p.frontageAngleRad);
        const s = Math.sin(-p.frontageAngleRad);
        return { x: centre.x + dx * c - dy * s, y: centre.y + dx * s + dy * c };
      }));
      const massMinX = Math.min(...massXs.map((point) => point.x));
      const massMaxX = Math.max(...massXs.map((point) => point.x));
      spans.push((massMaxX - massMinX) / bounds.width);
    }
    spans.sort((a, b) => a - b);
    const p10 = spans[Math.floor(spans.length * 0.1)]!;
    expect(spans[Math.floor(spans.length / 2)]!).toBeGreaterThan(0.7);
    expect(p10).toBeGreaterThan(0.3);
    expect(spans[0]!).toBeGreaterThan(0.12);
  }, 300_000);
});

describe("block height coherence", () => {
  it.concurrent("keeps every block's ordinary buildings inside one coherent height band", () => {
    const plan = ringFourPlan();
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const districtById = new Map(ringSource(4).districts.map((district) => [district.id, district]));
    const bands = deriveBlockHeightBands(plan.parcels, districtById);
    const heightsByBlock = new Map<string, number[]>();
    const parcelById = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
    const infillBlocks = new Set<string>();
    for (const building of plan.buildings) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(building.grammarId)!;
      if (isTowerGrammar(grammar) || MICRO_BUILDING_GRAMMAR_IDS.has(building.grammarId)) continue;
      const band = building.blockId === null ? undefined : bands.get(building.blockId);
      expect(band, building.id).toBeDefined();
      if (band === undefined) continue;
      // Every ordinary height draws from its block's band, or from a deterministic
      // shoulder window strictly inside the grammar's declared range when the band lies
      // outside it (a shopfront in a tower block hugs the top of its 22-48 m range
      // instead of joining the megatower).
      expect(building.heightM, building.id).toBeGreaterThanOrEqual(Math.min(band.minM, grammar.height.minM) - 1e-9);
      expect(building.heightM, building.id).toBeLessThanOrEqual(Math.max(band.maxM, grammar.height.maxM) + 1e-9);
      if (building.blockId === null) continue;
      heightsByBlock.set(building.blockId, [...(heightsByBlock.get(building.blockId) ?? []), building.heightM]);
      if (building.parcelId !== null && parcelById.get(building.parcelId)?.role.includes("density-infill")) infillBlocks.add(building.blockId);
    }
    // Established blocks stay within 3×. A block receiving explicit density/v3 infill may
    // layer low/mid-rise foreground against its tower band, matching the visual density
    // target, but remains bounded to 5×.
    let coherentBlocks = 0;
    for (const [blockId, heights] of heightsByBlock) {
      if (heights.length < 2) continue;
      coherentBlocks++;
      expect(Math.max(...heights) / Math.min(...heights), blockId)
        .toBeLessThanOrEqual(infillBlocks.has(blockId) ? 5 : 3);
    }
    expect(coherentBlocks).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it("derives deterministic per-block height bands that vary between blocks", () => {
    const definition = DISTRICT_TYPE_REGISTRY.get("commercial-highrise")!;
    const first = heightBandForBlock("coherence-a", definition)!;
    expect(heightBandForBlock("coherence-a", definition)).toEqual(first);
    expect(first.minM).toBeGreaterThan(0);
    expect(first.maxM).toBeGreaterThan(first.minM);
    expect(heightBandForBlock("coherence-b", definition)!.minM).not.toBeCloseTo(first.minM, 6);
  });

  it("keeps banded heights inside every grammar's declared range even under extreme bands", () => {
    for (const grammar of BUILDING_GRAMMARS) {
      for (const band of [{ minM: 6, maxM: 14 }, { minM: 300, maxM: 500 }] as const) {
        for (const roll of [0, 0.5, 1]) {
          const heightM = shapeBuildingHeight(grammar, band, roll);
          expect(heightM, grammar.id).toBeGreaterThanOrEqual(grammar.height.minM - 1e-9);
          expect(heightM, grammar.id).toBeLessThanOrEqual(grammar.height.maxM + 1e-9);
        }
      }
    }
  });

  it("samples the grammar/band intersection when the band overlaps the range", () => {
    const shopfront = BUILDING_GRAMMAR_REGISTRY.get("narrow-shopfront")!; // 22-48
    const band = { minM: 38, maxM: 84 };
    expect(shapeBuildingHeight(shopfront, band, 0)).toBe(38);
    expect(shapeBuildingHeight(shopfront, band, 1)).toBe(48);
    expect(shapeBuildingHeight(shopfront, band, 0.5)).toBe(43);
  });

  it("samples interior grammar shoulders instead of pinning exact caps/floors when the band is disjoint", () => {
    const shopfront = BUILDING_GRAMMAR_REGISTRY.get("narrow-shopfront")!; // 22-48
    const farAbove = { minM: 200, maxM: 260 };
    const above = [0, 0.5, 1].map((roll) => shapeBuildingHeight(shopfront, farAbove, roll));
    // No cap plateau: the roll endpoints vary across the upper shoulder instead of
    // every building collapsing onto the exact 48 m cap.
    expect(new Set(above).size).toBe(3);
    expect(above[0]!).toBeLessThan(above[1]!);
    expect(above[1]!).toBeLessThan(above[2]!);
    for (const heightM of above) {
      expect(heightM, "upper shoulder stays inside the declared range").toBeGreaterThan(shopfront.height.minM);
      expect(heightM, "upper shoulder stays inside the declared range").toBeLessThan(shopfront.height.maxM);
    }
    const flatiron = BUILDING_GRAMMAR_REGISTRY.get("corner-flatiron")!; // 36-190
    const farBelow = { minM: 10, maxM: 14 };
    const below = [0, 0.5, 1].map((roll) => shapeBuildingHeight(flatiron, farBelow, roll));
    expect(new Set(below).size).toBe(3);
    expect(below[0]!).toBeLessThan(below[1]!);
    expect(below[1]!).toBeLessThan(below[2]!);
    for (const heightM of below) {
      expect(heightM, "lower shoulder stays inside the declared range").toBeGreaterThan(flatiron.height.minM);
      expect(heightM, "lower shoulder stays inside the declared range").toBeLessThan(flatiron.height.maxM);
    }
    const touchingCap = [0, 0.5, 1].map((roll) =>
      shapeBuildingHeight(shopfront, { minM: shopfront.height.maxM, maxM: 84 }, roll)
    );
    expect(new Set(touchingCap).size).toBe(3);
    expect(touchingCap.every((heightM) => heightM < shopfront.height.maxM)).toBe(true);
    // Same inputs stay deterministic.
    expect(shapeBuildingHeight(shopfront, farAbove, 0.37)).toBe(shapeBuildingHeight(shopfront, farAbove, 0.37));
    expect(shapeBuildingHeight(flatiron, farBelow, 0.37)).toBe(shapeBuildingHeight(flatiron, farBelow, 0.37));
  });
});

describe("thin-building emission floor", () => {
  const rotate = (point: { x: number; y: number }, origin: { x: number; y: number }, angle: number): { x: number; y: number } => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
  };

  const orientedMinor = (ring: Ring): number => {
    const angle = Math.atan2(ring[1]!.y - ring[0]!.y, ring[1]!.x - ring[0]!.x);
    const centre = ringCentroid(ring);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of ring) {
      const localX = (point.x - centre.x) * Math.cos(angle) + (point.y - centre.y) * Math.sin(angle);
      const localY = -(point.x - centre.x) * Math.sin(angle) + (point.y - centre.y) * Math.cos(angle);
      if (localX < minX) minX = localX;
      if (localX > maxX) maxX = localX;
      if (localY < minY) minY = localY;
      if (localY > maxY) maxY = localY;
    }
    return Math.min(maxX - minX, maxY - minY);
  };

  const allWeights = Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [id, 1])) as Record<BuildingGrammarId, number>;
  const allUses = Object.fromEntries(BUILDING_USE_IDS.map((use) => [use, 1])) as Record<BuildingUseId, number>;

  it("never emits a non-micro mass with an oriented minor dimension below six metres", () => {
    // Realistic thin-boundary parcels: narrow strips, shallow cells, and rotated
    // (diagonal) cells whose AABB overstates the true oriented width. Whichever
    // non-micro grammar is chosen, every emitted mass must clear the 6 m floor.
    const boundaries: Array<[number, number, number]> = [
      [4.5, 30, 0],
      [5, 28, 0],
      [5.5, 26, 0],
      [6, 24, 0],
      [6.5, 22, 0],
      [7.5, 30, 0],
      [8, 22, 0],
      [9, 20, 0],
      [10, 18, 0],
      [12, 16, 0],
      [14, 16, 0],
      [26, 6.5, Math.PI / 6],
      [26, 6.5, Math.PI / 4],
      [24, 8, Math.PI / 3],
      [30, 9, Math.PI / 5]
    ];
    let emitted = 0;
    for (const [width, height, angle] of boundaries) {
      for (let index = 0; index < 12; index++) {
        const origin = { x: width / 2, y: height / 2 };
        const polygon = rectRing({ x: 0, y: 0, width, height }).map((point) => rotate(point, origin, angle));
        const building = planParcelBuilding(
          { id: `thin-${width}-${height}-${index}`, blockId: "thin-block", fragmentId: "thin-frag", districtId: null, polygon, frontageAngleRad: 0, seed: `thin/${width}/${height}/${index}`, areaM2: width * height },
          allWeights,
          allUses,
          undefined,
          new Map()
        );
        if (building === null) continue;
        // Micro grammars fill sub-floor slivers intentionally; the floor binds only
        // ordinary (non-micro) masses.
        if (MICRO_BUILDING_GRAMMAR_IDS.has(building.grammarId)) continue;
        emitted++;
        for (const mass of building.masses) {
          expect(orientedMinor(mass.footprint), `${building.grammarId} ${building.id}`).toBeGreaterThanOrEqual(6 - 1e-6);
        }
      }
    }
    expect(emitted).toBeGreaterThan(0);
  });

  it("builds narrow strip parcels only at credible widths", () => {
    const only = (id: BuildingGrammarId): Record<BuildingGrammarId, number> =>
      Object.fromEntries(BUILDING_GRAMMAR_IDS.map((grammarId) => [grammarId, grammarId === id ? 1 : 0])) as Record<BuildingGrammarId, number>;
    // A 6 m strip is below the raised narrow-strip floor and must not emit a 4 m bar.
    const belowFloor = planParcelBuilding(
      { id: "strip-6", blockId: "b", fragmentId: "f", districtId: null, polygon: rectRing({ x: 0, y: 0, width: 6, height: 30 }), frontageAngleRad: 0, seed: "strip/6", areaM2: 180 },
      only("narrow-strip"),
      allUses,
      undefined,
      new Map()
    );
    expect(belowFloor).toBeNull();
    // A 7.5 m strip builds, and every mass clears the floor.
    const credible = planParcelBuilding(
      { id: "strip-7", blockId: "b", fragmentId: "f", districtId: null, polygon: rectRing({ x: 0, y: 0, width: 7.5, height: 30 }), frontageAngleRad: 0, seed: "strip/7", areaM2: 225 },
      only("narrow-strip"),
      allUses,
      undefined,
      new Map()
    );
    expect(credible, "a 7.5 m strip must still build").not.toBeNull();
    for (const mass of credible!.masses) {
      expect(orientedMinor(mass.footprint), credible!.id).toBeGreaterThanOrEqual(6 - 1e-6);
    }
  });

  it("keeps rotated thin-boundary cells from emitting sub-six-metre bars", () => {
    // A 6.5 m-deep diagonal strip: the cell-frame AABB reads ~23 m, but the true
    // oriented width is below the floor. The fitted mass collapses to the true width,
    // so the emission guard must reject it rather than emit a pathological bar.
    for (const angle of [Math.PI / 6, Math.PI / 4, Math.PI / 3]) {
      const origin = { x: 13, y: 3.25 };
      const polygon = rectRing({ x: 0, y: 0, width: 26, height: 6.5 }).map((point) => rotate(point, origin, angle));
      const building = planParcelBuilding(
        { id: `diag-${angle}`, blockId: "b", fragmentId: "f", districtId: null, polygon, frontageAngleRad: 0, seed: `diag/${angle}`, areaM2: 26 * 6.5 },
        allWeights,
        allUses,
        undefined,
        new Map()
      );
      if (building === null) continue;
      if (MICRO_BUILDING_GRAMMAR_IDS.has(building.grammarId)) continue;
      for (const mass of building.masses) {
        expect(orientedMinor(mass.footprint), `${building.grammarId} at ${angle}`).toBeGreaterThanOrEqual(6 - 1e-6);
      }
    }
  });

  it("never builds a building on a sub-six-metre parcel in a whole-city plan", () => {
    // The production path routes clipped boundary/stagger slivers (parcels whose own
    // frame is thinner than 6 m) straight to the explicit unbuilt classification, so
    // no grammar — micro included — can raise a sub-floor bar on them.
    const plan = buildCompleteCityPlan(crossSource());
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const parcelById = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
    const parcelMinor = (parcel: { polygon: Ring; frontageAngleRad: number }): number => {
      const angle = parcel.frontageAngleRad;
      const centre = ringCentroid(parcel.polygon);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const point of parcel.polygon) {
        const localX = (point.x - centre.x) * Math.cos(angle) + (point.y - centre.y) * Math.sin(angle);
        const localY = -(point.x - centre.x) * Math.sin(angle) + (point.y - centre.y) * Math.cos(angle);
        if (localX < minX) minX = localX;
        if (localX > maxX) maxX = localX;
        if (localY < minY) minY = localY;
        if (localY > maxY) maxY = localY;
      }
      return Math.min(maxX - minX, maxY - minY);
    };
    for (const building of plan.buildings) {
      if (building.parcelId === null) continue;
      const parcel = parcelById.get(building.parcelId);
      if (parcel === undefined) continue;
      expect(parcelMinor(parcel), building.id).toBeGreaterThanOrEqual(6 - 1e-6);
    }
    // Every parcel that IS thinner than 6 m stays explicitly unbuilt: it must have a
    // full-area parcel-linked open space (the /unbuilt landscaping classification).
    const openByParcel = new Map(plan.openSpaces.filter((openSpace) => openSpace.parcelId !== null).map((openSpace) => [openSpace.parcelId, openSpace]));
    for (const parcel of plan.parcels) {
      if (parcelMinor(parcel) >= 6 - 1e-6) continue;
      const openSpace = openByParcel.get(parcel.id);
      expect(openSpace, parcel.id).toBeDefined();
      expect(openSpace!.areaM2).toBeCloseTo(parcel.areaM2, 4);
    }
  }, 60_000);
});
