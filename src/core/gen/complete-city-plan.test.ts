import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, rectsIntersect, ringArea, ringBounds, type MultiPolygon, type Ring } from "../geom/types.js";
import { MATERIAL } from "../palette.js";
import type { CitySourceV3, DistrictOpenSpaceOverride, DistrictSource, RoadEdgeSource, RoadNodeSource, RoadRouteSource } from "./city.js";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS, FOOTPRINT_ARCHETYPE_IDS, type BuildingGrammarId, type BuildingUseId } from "./building-registry.js";
import { LANDMARK_GRAMMAR_IDS, LANDMARK_GRAMMAR_REGISTRY } from "./landmark-registry.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPES, DISTRICT_TYPE_IDS, type DistrictTypeId } from "./district-registry.js";
import { buildCompleteCityPlan, derivePaletteBanks, planParcelBuilding, reserveMajorLandmarkSites, validateCompleteCityPlan, type BuildingPlan, type CompleteCityPlan, type MajorLandmarkSiteReservation } from "./complete-city-plan.js";

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string, classId: RoadEdgeSource["classId"] = "street"): RoadEdgeSource => ({ id, a, b, routeId, classId, name: null, locked: false, origin: "authored" });

const multiArea = (multi: MultiPolygon): number =>
  multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);

const overlap = (a: Ring, b: Ring): number => multiArea(intersection(ringAsMulti(a), ringAsMulti(b)));
const overlapMulti = (a: Ring, b: MultiPolygon): number => multiArea(intersection(ringAsMulti(a), b));

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
const crossSource = (): CitySourceV3 => {
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
    districts
  };
};

/** Cross variant whose halves carry compatible district tags (formal west, industrial east). */
const compatibleCross = (): CitySourceV3 => {
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
  openSpaceProfile: CitySourceV3["generation"]["openSpaceProfile"] = "medium",
  citySeed = "complete-plan-ring"
): CitySourceV3 => {
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
    districts
  };
};

describe("buildCompleteCityPlan", () => {
  it("produces a validating complete plan over all 16 districts with all four landmarks", () => {
    const source = ringSource(16);
    const plan = buildCompleteCityPlan(source);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.diagnostics.landmarkCount).toBe(4);
    expect(plan.diagnostics.landmarkSkipped).toEqual([]);
    expect(new Set(plan.landmarks.map((landmark) => landmark.landmarkGrammarId))).toEqual(new Set(LANDMARK_GRAMMAR_IDS));
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
  }, 120_000);

  it("is deterministic and identical under source permutation and origin shift", () => {
    const source = crossSource();
    const plan = buildCompleteCityPlan(source);
    const shuffled: CitySourceV3 = {
      ...source,
      roads: { nodes: [...source.roads.nodes].reverse(), routes: [...source.roads.routes].reverse(), edges: [...source.roads.edges].reverse() },
      districts: [...source.districts].reverse()
    };
    expect(buildCompleteCityPlan(shuffled)).toEqual(plan);
    const shifted: CitySourceV3 = { ...source, origin: { x: source.origin.x + 12345, y: source.origin.y - 6789 } };
    expect(buildCompleteCityPlan(shifted)).toEqual(plan);
    expect(buildCompleteCityPlan(source)).toEqual(plan);
  }, 120_000);

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
  }, 120_000);

  it("honors global none, a district override above none, and landmark-required open space", () => {
    const nonePlan = buildCompleteCityPlan(ringSource(4, "none"));
    expect(validateCompleteCityPlan(nonePlan)).toEqual([]);
    expect(nonePlan.openSpaces.filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null)).toEqual([]);
    const landmarkOpen = nonePlan.openSpaces.filter((openSpace) => openSpace.landmarkId !== null);
    expect(landmarkOpen.length).toBeGreaterThanOrEqual(1);
    const hero = nonePlan.landmarks.find((landmark) => landmark.landmarkGrammarId === "hero-tower-plaza")!;
    expect(hero.openSpaceIds.length).toBeGreaterThan(0);
    const heroPlaza = nonePlan.openSpaces.find((openSpace) => openSpace.id === hero.openSpaceIds[0])!;
    expect(heroPlaza.category).toBe("plaza");
    expect(overlap(heroPlaza.polygon, hero.sitePolygon)).toBeGreaterThan(heroPlaza.areaM2 - 0.5);
    // The required plaza covers at least the grammar's declared minimum share of the site.
    expect(heroPlaza.areaM2).toBeGreaterThanOrEqual(LANDMARK_GRAMMAR_REGISTRY.get("hero-tower-plaza")!.requiredOpenSpace!.minShare * hero.areaM2 - 0.5);

    const overriddenSource = ringSource(4, "none");
    overriddenSource.districts = overriddenSource.districts.map((district, index) =>
      index === 3 ? { ...district, openSpaceOverride: parkOverride(0.5) } : district
    );
    const overriddenPlan = buildCompleteCityPlan(overriddenSource);
    expect(validateCompleteCityPlan(overriddenPlan)).toEqual([]);
    const ordinary = overriddenPlan.openSpaces.filter((openSpace) => openSpace.landmarkId === null && openSpace.parcelId === null && openSpace.districtId === overriddenSource.districts[3]!.id);
    expect(ordinary.length).toBeGreaterThan(0);
  }, 120_000);

  it("produces final geometry for pocket, small, large, and whole-block sizes", () => {
    const source = ringSource(4, "none");
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
    expect(wholeBlock!.areaM2).toBeGreaterThan(50_000);
    // Landmark sites inside the strip are excluded from the whole-block open space; the
    // surrounding donut remainder becomes explicit parcels, never unexplained gaps.
    for (const parcel of plan.parcels) {
      if (parcel.districtId !== source.districts[2]!.id) continue;
      expect(overlap(parcel.polygon, wholeBlock!.polygon), parcel.id).toBeLessThan(0.5);
    }
    const mediumPlan = buildCompleteCityPlan(ringSource(4, "medium"));
    const sizes = new Set(mediumPlan.openSpaces.map((openSpace) => openSpace.size));
    expect(mediumPlan.openSpaces.length).toBeGreaterThan(0);
    for (const size of sizes) expect(["pocket", "small", "large", "whole-block"]).toContain(size);
  }, 120_000);

  it("keeps every building mass inside its parcel, masses disjoint, parcels disjoint, and buildings clear of open spaces", () => {
    const plan = buildCompleteCityPlan(ringSource(4));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const parcelById = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
    for (const building of plan.buildings) {
      const parcel = parcelById.get(building.parcelId)!;
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
  }, 120_000);

  it("keeps landmark sites road-free, disjoint from parcels, and masses inside sites", () => {
    const plan = buildCompleteCityPlan(ringSource(4));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    for (const landmark of plan.landmarks) {
      expect(overlapMulti(landmark.sitePolygon, plan.routeOccupancy.all), landmark.id).toBeLessThan(0.5);
      for (const parcel of plan.parcels) {
        expect(overlap(landmark.sitePolygon, parcel.polygon), landmark.id).toBeLessThan(0.5);
      }
      for (const mass of landmark.masses) {
        expect(overlap(mass.footprint, landmark.sitePolygon), mass.id).toBeGreaterThan(Math.abs(ringArea(mass.footprint)) - 0.5);
      }
    }
  }, 120_000);

  it("honors pre-reserved major landmark sites verbatim", () => {
    const source = ringSource(16);
    const reserved = reserveMajorLandmarkSites(source);
    expect(reserved.length).toBe(4);
    expect(reserveMajorLandmarkSites(source)).toEqual(reserved);
    const plan = buildCompleteCityPlan(source, 1, 0, reserved);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.diagnostics.landmarkCount).toBe(4);
    expect(plan.diagnostics.landmarkFailures).toEqual([]);
    for (const reservation of reserved) {
      const landmark = plan.landmarks.find((candidate) => candidate.landmarkGrammarId === reservation.grammarId)!;
      expect(landmark.sitePolygon).toEqual(reservation.sitePolygon);
      expect(landmark.placementLineage).toBe(reservation.lineage);
    }
    expect(derivePaletteBanks(source)).toEqual(plan.paletteBanks);
  }, 120_000);

  it("honors explicit full-generation sites verbatim when their districts are compatible", () => {
    const source = ringSource(16);
    const reservations = [
      manualReservation("hero-tower-plaza", 10, 100),
      manualReservation("civic-corporate-compound", 110, 100),
      manualReservation("monument-open-space", 810, 100),
      manualReservation("infrastructure-utility-site", 910, 100)
    ];
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.diagnostics.landmarkCount).toBe(4);
    expect(plan.diagnostics.landmarkSkipped).toEqual([]);
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
  }, 120_000);

  it("keeps explicit reservations verbatim even with district contrast and records a warning", () => {
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
    expect(plan.diagnostics.landmarkCount).toBe(4);
    expect(plan.diagnostics.landmarkSkipped).toEqual([]);
    expect(plan.diagnostics.warnings.some((warning) => warning.includes("infrastructure-utility-site") && warning.includes("contrast"))).toBe(true);
    for (const reservation of reservations) {
      const landmark = plan.landmarks.find((candidate) => candidate.landmarkGrammarId === reservation.grammarId)!;
      expect(landmark.sitePolygon).toEqual(reservation.sitePolygon);
      expect(landmark.placementLineage).toBe(reservation.lineage);
    }
  }, 120_000);

  it("returns dropped internal reservation sites to explicit parcel accounting", () => {
    // Internal planning may drop a pre-road reservation (road overlap or an incompatible
    // cell); the dropped site must reappear as parcels/open spaces, never a void.
    const source = ringSource(4);
    const plan = buildCompleteCityPlan(source);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const reserved = reserveMajorLandmarkSites(source);
    expect(reserved.length).toBe(4);
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
      expect(multiArea(intersection(ringAsMulti(reservation.sitePolygon), covering)), reservation.grammarId).toBeGreaterThan(siteArea * 0.98);
    }
    expect(droppedSites).toBeGreaterThan(0);
  }, 120_000);

  it("throws a structural error when an explicit reservation cannot materialize", () => {
    const source = ringSource(4);
    // A degenerate zero-area site can never carry a landmark; the explicit path must
    // fail loudly instead of returning a plan with fewer landmarks than reservations.
    const degenerate = manualReservation("hero-tower-plaza", 10, 100, 0, 0);
    expect(() => buildCompleteCityPlan(source, 1, 0, [degenerate])).toThrow();
  }, 120_000);

  it("never validates a plan with fewer landmarks than explicit reservations", () => {
    const source = ringSource(4);
    const reservations = [
      manualReservation("hero-tower-plaza", 10, 100),
      manualReservation("civic-corporate-compound", 410, 100),
      manualReservation("infrastructure-utility-site", 810, 100),
      manualReservation("monument-open-space", 1210, 100)
    ];
    const plan = buildCompleteCityPlan(source, 1, 0, reservations);
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const removed = plan.landmarks[0]!;
    const tampered: CompleteCityPlan = {
      ...plan,
      landmarks: plan.landmarks.filter((landmark) => landmark.id !== removed.id),
      openSpaces: plan.openSpaces.filter((openSpace) => openSpace.landmarkId !== removed.id)
    };
    expect(validateCompleteCityPlan(tampered).some((message) => message.includes("explicit reservations"))).toBe(true);
  }, 120_000);

  it("skips landmarks with no compatible district and falls back to compatible block-inscribed sites", () => {
    const plan = buildCompleteCityPlan(crossSource());
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    // No district in the plain cross carries any landmark grammar tag, so every grammar
    // is skipped explicitly instead of being mis-associated.
    expect(plan.diagnostics.landmarkCount).toBe(0);
    expect([...plan.diagnostics.landmarkSkipped].sort()).toEqual([...LANDMARK_GRAMMAR_IDS].sort());
    // With compatible districts the same city falls back to legal block-inscribed sites.
    const fallbackPlan = buildCompleteCityPlan(compatibleCross());
    expect(validateCompleteCityPlan(fallbackPlan)).toEqual([]);
    expect(fallbackPlan.diagnostics.landmarkCount).toBe(3);
    expect(fallbackPlan.landmarks.every((landmark) => landmark.placementLineage.startsWith("fallback:"))).toBe(true);
    expect(fallbackPlan.diagnostics.landmarkSkipped).toEqual(["monument-open-space"]);
    for (const landmark of fallbackPlan.landmarks) {
      expect(overlapMulti(landmark.sitePolygon, fallbackPlan.routeOccupancy.all), landmark.id).toBeLessThan(0.5);
    }
  }, 120_000);

  it("classifies parcels with no fitting grammar as explicitly unbuilt open parcels", () => {
    const plan = buildCompleteCityPlan(ringSource(4));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const builtIds = new Set(plan.buildings.map((building) => building.parcelId));
    // Three kinds of parcel-linked open spaces exist (parcelId !== null):
    //   1. Fix 3b unbuilt fallbacks: parcel that fit no grammar at all
    //      → seed ends in "/unbuilt", category: "landscaping"
    //   2. Residual slivers: leftover geometry after a refined building was placed
    //      → seed contains "/residual/", category: "vacant"
    // Both kinds need a 1-to-1 open space entry for their parcel.
    const parcelLinked = plan.openSpaces.filter((openSpace) => openSpace.parcelId !== null);
    const unbuiltFallbacks = parcelLinked.filter((os) => os.seed.endsWith("/unbuilt"));
    const residualSlivers  = parcelLinked.filter((os) => !os.seed.endsWith("/unbuilt"));
    // Fix 3b: unbuilt parcel fallbacks now use "landscaping" so they blend with
    // the sidewalk surface instead of appearing as derelict scrub.
    expect(unbuiltFallbacks.every((os) => os.category === "landscaping")).toBe(true);
    expect(unbuiltFallbacks.every((os) => os.surfaceStyle === "paving" && os.detailStyle === "planters")).toBe(true);
    // Residual slivers from refined buildings remain "vacant".
    expect(residualSlivers.every((os) => os.category === "vacant")).toBe(true);
    // Every unbuilt parcel (not built, regardless of how it became unbuilt) must
    // have exactly one parcel-linked open space covering its full area.
    const openSpaceByParcel = new Map(parcelLinked.map((os) => [os.parcelId, os]));
    let unbuiltCount = 0;
    let unbuiltAreaM2 = 0;
    for (const parcel of plan.parcels) {
      if (builtIds.has(parcel.id)) continue;
      unbuiltCount++;
      unbuiltAreaM2 += parcel.areaM2;
      const openSpace = openSpaceByParcel.get(parcel.id);
      expect(openSpace, parcel.id).toBeDefined();
      expect(openSpace!.areaM2).toBeCloseTo(parcel.areaM2, 4);
    }
    expect(unbuiltCount).toBeGreaterThan(0);
    expect(parcelLinked.length).toBe(unbuiltCount);
    expect(unbuiltFallbacks.length).toBeGreaterThan(0);
    expect(unbuiltAreaM2 / plan.parcels.reduce((sum, parcel) => sum + parcel.areaM2, 0)).toBeLessThanOrEqual(0.1);
    expect(parcelLinked.every((os) => os.material === MATERIAL.GROUND)).toBe(true);
    const intentional = plan.openSpaces.filter((openSpace) => openSpace.parcelId === null);
    expect(intentional.length).toBeGreaterThan(0);
    expect(intentional.some((openSpace) => openSpace.material !== MATERIAL.GROUND)).toBe(true);
    // The classification is deterministic.
    expect(buildCompleteCityPlan(ringSource(4))).toEqual(plan);
  }, 120_000);
 it("materializes every shipping grammar and all seven archetypes through the production path", () => {
    // Fixed legal breadth gallery: one deterministic parcel per grammar built from its
    // own declared limits, materialized through the same exported production path that
    // planBuildings uses, so the 24 grammars and 7 archetypes are proven as outputs.
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

  it("reaches every archetype and a broad grammar set in a single whole-city plan", () => {
    // Ordinary whole-city reachability sanity: one deterministic plan must produce all
    // seven archetypes and most shipping grammars as generated outputs.
    const plan = buildCompleteCityPlan(ringSource(16));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.buildings.length).toBeGreaterThan(0);
    const grammars = new Set(plan.buildings.map((building) => building.grammarId));
    const archetypes = new Set(plan.buildings.map((building) => building.archetype));
    expect(grammars.size).toBeGreaterThanOrEqual(16);
    expect([...archetypes].sort()).toEqual([...FOOTPRINT_ARCHETYPE_IDS].sort());
    for (const building of plan.buildings) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(building.grammarId)!;
      expect(building.heightM, building.id).toBeGreaterThanOrEqual(grammar.height.minM);
      expect(building.heightM, building.id).toBeLessThanOrEqual(grammar.height.maxM);
      expect(Math.max(...building.masses.map((mass) => mass.elevationM + mass.heightM)), building.id).toBeCloseTo(building.heightM, 9);
    }
  }, 120_000);

  it("rejects injected illegal cross-occupancy, missing landmark open space, and non-fitting grammars", () => {
    const plan = buildCompleteCityPlan(ringSource(4));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    expect(plan.buildings.length).toBeGreaterThan(0);
    const hero = plan.landmarks.find((landmark) => landmark.landmarkGrammarId === "hero-tower-plaza")!;
    expect(hero).toBeDefined();
    const firstParcel = plan.parcels[0]!;
    const firstBuilding = plan.buildings[0]!;
    // (a) a parcel invading a landmark site
    const parcelInvasion: CompleteCityPlan = {
      ...plan,
      parcels: plan.parcels.map((parcel) =>
        parcel.id === firstParcel.id ? { ...parcel, polygon: hero.sitePolygon, areaM2: Math.abs(ringArea(hero.sitePolygon)) } : parcel
      )
    };
    expect(validateCompleteCityPlan(parcelInvasion).some((message) => message.includes("overlaps landmark site"))).toBe(true);
    // (b) an ordinary mass invading a landmark mass
    const massInvasion: CompleteCityPlan = {
      ...plan,
      buildings: plan.buildings.map((building) =>
        building.id === firstBuilding.id && building.masses.length > 0
          ? { ...building, masses: building.masses.map((mass, index) => (index === 0 ? { ...mass, footprint: hero.masses[0]!.footprint } : mass)) }
          : building
      )
    };
    expect(validateCompleteCityPlan(massInvasion).some((message) => message.includes("overlaps landmark"))).toBe(true);
    // (c) missing required landmark open space
    const missingPlaza: CompleteCityPlan = {
      ...plan,
      openSpaces: plan.openSpaces.filter((openSpace) => !hero.openSpaceIds.includes(openSpace.id)),
      landmarks: plan.landmarks.map((landmark) => (landmark.id === hero.id ? { ...landmark, openSpaceIds: [] } : landmark))
    };
    expect(validateCompleteCityPlan(missingPlaza).some((message) => message.includes("requires plaza open space"))).toBe(true);
    // (d) a grammar that cannot fit its parcel
    const nonFitting: CompleteCityPlan = {
      ...plan,
      parcels: plan.parcels.map((parcel) =>
        parcel.id === firstBuilding.parcelId ? { ...parcel, polygon: rectRing({ x: 0, y: 0, width: 10, height: 10 }), areaM2: 100 } : parcel
      ),
      buildings: plan.buildings.map((building) => (building.id === firstBuilding.id ? { ...building, grammarId: "industrial-shed" } : building))
    };
    expect(validateCompleteCityPlan(nonFitting).some((message) => message.includes("does not fit its parcel"))).toBe(true);
    // (e) an invalid neon flag on a mass
    const badNeon: CompleteCityPlan = {
      ...plan,
      buildings: plan.buildings.map((building) =>
        building.id === firstBuilding.id && building.masses.length > 0
          ? { ...building, masses: building.masses.map((mass, index) => (index === 0 ? { ...mass, neonEnabled: "yes" as unknown as boolean } : mass)) }
          : building
      )
    };
    expect(validateCompleteCityPlan(badNeon).some((message) => message.includes("invalid neon flag"))).toBe(true);
  }, 120_000);

  it("rejects injected building totals outside the grammar's declared height range", () => {
    const plan = buildCompleteCityPlan(ringSource(4));
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
  }, 120_000);
});
