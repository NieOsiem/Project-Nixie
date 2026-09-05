import { describe, expect, it } from "vitest";
import { difference, intersection, isSnapNoise, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, ringArea, type Ring } from "../geom/types.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS } from "./district-registry.js";
import type {
  ArchitectureOverrideSource,
  ArchitectureProtection,
  CitySourceV4,
  PersistentBuildingSource,
  PersistentPlaceSource,
  PlacementFrame,
  RoadEdgeSource,
  RoadNodeSource,
  RoadRouteSource
} from "./city.js";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS } from "./building-registry.js";
import { LANDMARK_GRAMMAR_IDS, LANDMARK_GRAMMAR_REGISTRY } from "./landmark-registry.js";
import { buildCompleteCityPlan, planParcelBuilding, validateCompleteCityPlan, type BuildingPlan, type CompleteCityPlan } from "./complete-city-plan.js";
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
const frameRing = (frame: PlacementFrame): Ring => {
  const base = rectRing({
    x: frame.centre.x - frame.widthM / 2,
    y: frame.centre.y - frame.depthM / 2,
    width: frame.widthM,
    height: frame.depthM
  });
  const cosine = Math.cos(frame.rotationRad);
  const sine = Math.sin(frame.rotationRad);
  return base.map((point) => ({
    x: frame.centre.x + (point.x - frame.centre.x) * cosine - (point.y - frame.centre.y) * sine,
    y: frame.centre.y + (point.x - frame.centre.x) * sine + (point.y - frame.centre.y) * cosine
  }));
};

const sourceBuilding = (
  id: string,
  centreX: number,
  centreY: number,
  protection: ArchitectureProtection,
  origin: "authored" | "generated" = "authored",
  siteWidth = 72
): PersistentBuildingSource => ({
  id,
  lineage: `architecture/lineage/${id}`,
  origin,
  protection,
  seed: `architecture/geometry/${id}`,
  appearanceSeed: `architecture/appearance/${id}`,
  grammarId: "corporate-setback-tower",
  visualUse: "commercial",
  heightM: 128,
  paletteId: DISTRICT_PALETTE_IDS[0]!,
  sitePolygon: siteRect(centreX, centreY, siteWidth),
  placement: placement(centreX, centreY, Math.min(siteWidth - 12, 52), Math.min(siteWidth - 12, 52)),
  districtId: null,
  blockId: null
});

const sourcePlace = (
  id: string,
  centreX: number,
  centreY: number,
  protection: ArchitectureProtection,
  origin: "authored" | "generated" = "authored"
): PersistentPlaceSource => ({
  id,
  lineage: `architecture/place-lineage/${id}`,
  origin,
  protection,
  seed: `architecture/place-geometry/${id}`,
  appearanceSeed: `architecture/place-appearance/${id}`,
  landmarkGrammarId: "hero-tower-plaza",
  paletteId: DISTRICT_PALETTE_IDS[0]!,
  sitePolygon: siteRect(centreX, centreY, 88),
  placement: placement(centreX, centreY, 72, 72),
  districtId: null,
  blockId: null
});
const buildingFrameForGrammar = (grammarId: (typeof BUILDING_GRAMMAR_IDS)[number]): { width: number; depth: number } => {
  const grammar = BUILDING_GRAMMAR_REGISTRY.get(grammarId);
  if (grammar === undefined) throw new Error(`Missing building grammar ${grammarId}`);
  for (let width = Math.floor(grammar.siteLimits.maxWidthM); width >= Math.ceil(grammar.siteLimits.minWidthM); width--) {
    for (let depth = Math.floor(grammar.siteLimits.maxDepthM); depth >= Math.ceil(grammar.siteLimits.minDepthM); depth--) {
      const areaM2 = width * depth;
      const aspect = width / depth;
      if (
        areaM2 >= grammar.siteLimits.minAreaM2
        && areaM2 <= grammar.siteLimits.maxAreaM2
        && aspect >= grammar.siteLimits.minAspect
        && aspect <= grammar.siteLimits.maxAspect
      ) {
        return { width, depth };
      }
    }
  }
  throw new Error(`No legal placement frame for building grammar ${grammarId}`);
};

const sourceBuildingForGrammar = (
  grammarId: (typeof BUILDING_GRAMMAR_IDS)[number],
  centreX = 100,
  centreY = 100
): PersistentBuildingSource => {
  const grammar = BUILDING_GRAMMAR_REGISTRY.get(grammarId);
  if (grammar === undefined) throw new Error(`Missing building grammar ${grammarId}`);
  const frame = buildingFrameForGrammar(grammarId);
  const siteWidth = Math.max(frame.width, frame.depth) + 18;
  const source = sourceBuilding(`grammar-${grammarId}`, centreX, centreY, "manual-edit", "authored", siteWidth);
  source.grammarId = grammarId;
  source.visualUse = grammar.compatibleUses[0]!;
  source.heightM = grammar.height.minM;
  source.sitePolygon = siteRect(centreX, centreY, siteWidth);
  source.placement = placement(centreX, centreY, frame.width, frame.depth);
  return source;
};

const landmarkSiteSideForGrammar = (grammarId: (typeof LANDMARK_GRAMMAR_IDS)[number]): number => {
  const grammar = LANDMARK_GRAMMAR_REGISTRY.get(grammarId);
  if (grammar === undefined) throw new Error(`Missing landmark grammar ${grammarId}`);
  const minimumSide = Math.ceil(Math.sqrt(grammar.minSiteAreaM2));
  const maximumSide = Math.floor(Math.sqrt(grammar.maxSiteAreaM2));
  if (minimumSide > maximumSide) throw new Error(`No square site fits landmark grammar ${grammarId}`);
  const targetArea = grammar.minSiteAreaM2 + (grammar.maxSiteAreaM2 - grammar.minSiteAreaM2) * 0.55;
  return Math.max(minimumSide, Math.min(maximumSide, Math.floor(Math.sqrt(targetArea))));
};

const sourcePlaceForGrammar = (
  grammarId: (typeof LANDMARK_GRAMMAR_IDS)[number],
  centreX = 100,
  centreY = 500
): PersistentPlaceSource => {
  const siteSide = landmarkSiteSideForGrammar(grammarId);
  const source = sourcePlace(`landmark-${grammarId}`, centreX, centreY, "manual-edit", "authored");
  source.landmarkGrammarId = grammarId;
  source.sitePolygon = siteRect(centreX, centreY, siteSide);
  source.placement = placement(centreX, centreY, Math.floor(siteSide * 0.8), Math.floor(siteSide * 0.8));
  return source;
};

const breadthGridCentre = (index: number, count: number, spacing: number): { x: number; y: number } => {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  return {
    x: spacing * (0.5 + (index % columns)),
    y: spacing * (0.5 + Math.floor(index / columns))
  };
};

const buildingBreadthSpacing = Math.max(
  140,
  ...BUILDING_GRAMMAR_IDS.map((grammarId) => {
    const frame = buildingFrameForGrammar(grammarId);
    return Math.max(frame.width, frame.depth) + 42;
  })
);
const landmarkBreadthSpacing = Math.max(
  180,
  ...LANDMARK_GRAMMAR_IDS.map((grammarId) => landmarkSiteSideForGrammar(grammarId) + 72)
);


const emptyArchitecture = (): CitySourceV4["architecture"] => ({ buildings: [], places: [], overrides: [] });

/** Nine spacious blocks leave road-free cells for persistent architecture and fast tests. */
const baseSource = (architecture: CitySourceV4["architecture"] = emptyArchitecture()): CitySourceV4 => ({
  origin: { x: 0, y: 0 },
  citySeed: "phase5-architecture-plan-fixture",
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
  architecture
});
/**
 * Registry breadth uses a road-free mask sized from the materialized records. This keeps
 * every dynamically added grammar inside land without relying on a fixed registry count.
 */
const breadthSource = (architecture: CitySourceV4["architecture"]): CitySourceV4 => {
  const source = baseSource(architecture);
  source.citySeed = "phase5-architecture-registry-breadth";
  const points = [...architecture.buildings, ...architecture.places].flatMap((record) => record.sitePolygon);
  let minX = 0;
  let minY = 0;
  let maxX = 1200;
  let maxY = 1200;
  if (points.length > 0) {
    minX = Math.min(...points.map((point) => point.x));
    minY = Math.min(...points.map((point) => point.y));
    maxX = Math.max(...points.map((point) => point.x));
    maxY = Math.max(...points.map((point) => point.y));
  }
  const margin = 64;
  const land = {
    x: minX - margin,
    y: minY - margin,
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2
  };
  source.terrain.land = rectRing(land);
  source.roads = { nodes: [], routes: [], edges: [] };
  const splitX = land.x + land.width / 2;
  source.districts = [
    { ...source.districts[0]!, polygon: rectRing({ x: land.x, y: land.y, width: splitX - land.x, height: land.height }) },
    { ...source.districts[1]!, polygon: rectRing({ x: splitX, y: land.y, width: land.x + land.width - splitX, height: land.height }) }
  ];
  return source;
};

const architectureFixture = () => ({
  buildings: [
    sourceBuilding("authored-none", 100, 100, "none", "authored"),
    sourceBuilding("authored-explicit", 300, 100, "explicit", "authored"),
    sourceBuilding("promoted-manual", 500, 100, "manual-edit", "generated")
  ],
  places: [
    sourcePlace("place-none", 100, 500, "none", "authored"),
    sourcePlace("place-explicit", 300, 500, "explicit", "authored"),
    sourcePlace("place-promoted", 500, 500, "manual-edit", "generated")
  ],
  overrides: []
});

const overlapArea = (left: Ring, right: Ring): number => {
  const multi = intersection(ringAsMulti(left), ringAsMulti(right));
  return multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);
};

const persistentBuilding = (plan: CompleteCityPlan, sourceId: string): BuildingPlan => {
  const building = plan.buildings.find((candidate) => candidate.sourceId === sourceId);
  if (!building) throw new Error(`Missing persistent building ${sourceId}`);
  return building;
};

const build = (source: CitySourceV4): CompleteCityPlan => buildCompleteCityPlan(source, 7, 3, []);

describe("Phase 5 persistent architecture planning", () => {
  it("materializes authored and promoted buildings and compound places at every protection level", () => {
    const source = baseSource(architectureFixture());
    const plan = build(source);

    expect(validateCompleteCityPlan(plan)).toEqual([]);
    for (const record of [...source.architecture.buildings, ...source.architecture.places]) {
      const candidate = record.id.startsWith("place-")
        ? plan.landmarks.find((landmark) => landmark.sourceId === record.id)
        : plan.buildings.find((building) => building.sourceId === record.id);
      expect(candidate, record.id).toBeDefined();
      expect(candidate).toMatchObject({
        id: record.id,
        sourceId: record.id,
        lineage: record.lineage,
        origin: record.origin,
        protection: record.protection,
        seed: record.seed,
        appearanceSeed: record.appearanceSeed,
        paletteId: record.paletteId,
        sitePolygon: record.sitePolygon,
        placement: record.placement
      });
      expect(candidate!.masses.length, record.id).toBeGreaterThan(0);
      if (record.id.startsWith("place-")) {
        expect(candidate!.masses.length, record.id).toBeGreaterThan(1);
        expect(plan.landmarks.find((landmark) => landmark.sourceId === record.id)!.openSpaceIds.length, record.id).toBeGreaterThan(0);
      }
      for (const mass of candidate!.masses) {
        const outsideSite = difference(ringAsMulti(mass.footprint), [ringAsMulti(record.sitePolygon)]);
        expect(isSnapNoise(outsideSite), `${record.id}:${mass.id}`).toBe(true);
      }
    }
    expect(plan.landmarks.every((landmark) => !Object.prototype.hasOwnProperty.call(landmark, "parcelId"))).toBe(true);
  });

  it("carves persistent sites before procedural parcels and preserves nullable associations", () => {
    const source = baseSource(architectureFixture());
    const plan = build(source);
    const persistentSites = [
      ...source.architecture.buildings.map((record) => record.sitePolygon),
      ...source.architecture.places.map((record) => record.sitePolygon)
    ];

    for (const site of persistentSites) {
      expect(plan.parcels.every((parcel) => overlapArea(parcel.polygon, site) < 0.5)).toBe(true);
      expect(plan.buildings
        .filter((building) => building.sourceId === null)
        .every((building) => building.masses.every((mass) => overlapArea(mass.footprint, site) < 0.5))).toBe(true);
      expect(plan.openSpaces
        .filter((openSpace) => openSpace.landmarkId === null)
        .every((openSpace) => overlapArea(openSpace.polygon, site) < 0.5)).toBe(true);
    }
    for (const building of plan.buildings.filter((candidate) => candidate.sourceId !== null)) {
      expect(building.parcelId).toBeNull();
      expect(building.blockId).toBeNull();
      expect(building.fragmentId).toBeNull();
      expect(building.districtId).toBeNull();
    }
    for (const place of plan.landmarks.filter((candidate) => candidate.sourceId !== null)) {
      expect(place.blockId).toBeNull();
      expect(place.districtId).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(place, "parcelId")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(place, "fragmentId")).toBe(false);
    }
  });

  it("reconstructs exact lineage, palette, structural seed, and placement deterministically", () => {
    const source = baseSource(architectureFixture());
    const first = build(source);
    const second = build(source);
    expect(second).toEqual(first);

    for (const record of source.architecture.buildings) {
      const building = persistentBuilding(first, record.id);
      expect(building.lineage).toBe(record.lineage);
      expect(building.seed).toBe(record.seed);
      expect(building.paletteId).toBe(record.paletteId);
      expect(building.appearanceSeed).toBe(record.appearanceSeed);
      expect(building.archetype).toBe("stepped");
      expect(building.placement).toEqual(record.placement);
      expect(building.sitePolygon).toEqual(record.sitePolygon);
    }
    for (const record of source.architecture.places) {
      const place = first.landmarks.find((candidate) => candidate.sourceId === record.id)!;
      expect(place.lineage).toBe(record.lineage);
      expect(place.seed).toBe(record.seed);
      expect(place.paletteId).toBe(record.paletteId);
      expect(place.appearanceSeed).toBe(record.appearanceSeed);
      expect(place.placement).toEqual(record.placement);
      expect(place.sitePolygon).toEqual(record.sitePolygon);
    }
  });
  it("materializes every current building grammar from a compatible persistent source", () => {
    const records = BUILDING_GRAMMAR_IDS.map((grammarId, index, all) => {
      const centre = breadthGridCentre(index, all.length, buildingBreadthSpacing);
      return sourceBuildingForGrammar(grammarId, centre.x, centre.y);
    });
    const plan = build(breadthSource({ buildings: records, places: [], overrides: [] }));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const materializedArchetypes = new Set<string>();
    for (const source of records) {
      const grammar = BUILDING_GRAMMAR_REGISTRY.get(source.grammarId)!;
      const building = plan.buildings.find((candidate) => candidate.sourceId === source.id);
      expect(building, source.grammarId).toBeDefined();
      if (building === undefined) throw new Error(`Missing persistent building ${source.id}`);
      expect(building).toMatchObject({
        sourceId: source.id,
        lineage: source.lineage,
        origin: source.origin,
        protection: source.protection,
        grammarId: source.grammarId,
        archetype: grammar.archetype,
        visualUse: source.visualUse,
        seed: source.seed,
        appearanceSeed: source.appearanceSeed,
        sitePolygon: source.sitePolygon,
        placement: source.placement
      });
      expect(building.masses.length, source.grammarId).toBeGreaterThan(0);
      expect(isSnapNoise(difference(ringAsMulti(frameRing(source.placement)), [ringAsMulti(source.sitePolygon)])), source.grammarId).toBe(true);
      for (const mass of building.masses) {
        expect(isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(source.sitePolygon)])), `${source.grammarId}:${mass.id}`).toBe(true);
      }
      materializedArchetypes.add(building.archetype);
    }
    const expectedArchetypes = new Set(
      records.map((source) => BUILDING_GRAMMAR_REGISTRY.get(source.grammarId)!.archetype)
    );
    expect(materializedArchetypes).toEqual(expectedArchetypes);
  }, 30_000);

  it("materializes every current landmark grammar from a persistent source with lineage and site containment", () => {
    const records = LANDMARK_GRAMMAR_IDS.map((grammarId, index, all) => {
      const centre = breadthGridCentre(index, all.length, landmarkBreadthSpacing);
      return sourcePlaceForGrammar(grammarId, centre.x, centre.y);
    });
    const plan = build(breadthSource({ buildings: [], places: records, overrides: [] }));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const materializedGrammars = new Set<string>();
    for (const source of records) {
      const grammar = LANDMARK_GRAMMAR_REGISTRY.get(source.landmarkGrammarId)!;
      const landmark = plan.landmarks.find((candidate) => candidate.sourceId === source.id);
      expect(landmark, source.landmarkGrammarId).toBeDefined();
      if (landmark === undefined) throw new Error(`Missing persistent landmark ${source.id}`);
      expect(landmark).toMatchObject({
        sourceId: source.id,
        lineage: source.lineage,
        placementLineage: source.lineage,
        origin: source.origin,
        protection: source.protection,
        landmarkGrammarId: source.landmarkGrammarId,
        seed: source.seed,
        appearanceSeed: source.appearanceSeed,
        sitePolygon: source.sitePolygon,
        placement: source.placement
      });
      expect(landmark.masses.length, source.landmarkGrammarId).toBeGreaterThan(0);
      expect(isSnapNoise(difference(ringAsMulti(frameRing(source.placement)), [ringAsMulti(source.sitePolygon)])), source.landmarkGrammarId).toBe(true);
      for (const mass of landmark.masses) {
        expect(isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(source.sitePolygon)])), `${source.landmarkGrammarId}:${mass.id}`).toBe(true);
      }
      if (grammar.requiredOpenSpace !== null) {
        expect(landmark.openSpaceIds.length, source.landmarkGrammarId).toBeGreaterThan(0);
      }
      materializedGrammars.add(landmark.landmarkGrammarId);
    }
    expect(materializedGrammars).toEqual(new Set(records.map((source) => source.landmarkGrammarId)));
  }, 30_000);



  it("rejects persistent sites that are outside land, outside urban footprint, on roads, or peer-overlapping", () => {
    const outsideLand = baseSource({
      buildings: [sourceBuilding("outside-land", -10, 100, "none")],
      places: [],
      overrides: []
    });
    expect(() => build(outsideLand)).toThrow(/land|outside|contain/i);

    const outsideUrban = baseSource({
      buildings: [sourceBuilding("outside-urban", 500, 100, "none")],
      places: [],
      overrides: []
    });
    outsideUrban.terrain.urbanFootprint = rectRing({ x: 0, y: 0, width: 300, height: 600 });
    expect(() => build(outsideUrban)).toThrow(/urban|footprint|outside|contain/i);

    const roadSite = baseSource({
      buildings: [sourceBuilding("road-site", 200, 100, "none", "authored", 72)],
      places: [],
      overrides: []
    });
    expect(() => build(roadSite)).toThrow(/road|carriage|occupancy/i);

    const peerOverlap = baseSource({
      buildings: [sourceBuilding("peer-a", 100, 100, "none"), sourceBuilding("peer-b", 100, 100, "explicit")],
      places: [sourcePlace("peer-place", 100, 100, "manual-edit")],
      overrides: []
    });
    expect(() => build(peerOverlap)).toThrow(/overlap|peer|persistent/i);
  });

  it("rejects a placement frame or materialized mass that escapes a persistent site", () => {
    const frameEscape = sourceBuilding("frame-escape", 100, 100, "none");
    frameEscape.placement = placement(100, 100, 90, 90);
    expect(() => build(baseSource({ buildings: [frameEscape], places: [], overrides: [] }))).toThrow(/frame|site|contain/i);

    const validPlan = build(baseSource({
      buildings: [sourceBuilding("mass-check", 100, 100, "none")],
      places: [],
      overrides: []
    }));
    const original = persistentBuilding(validPlan, "mass-check");
    const tampered = {
      ...validPlan,
      buildings: validPlan.buildings.map((building) => building.sourceId === "mass-check"
        ? {
            ...building,
            masses: building.masses.map((mass, index) => index === 0
              ? { ...mass, footprint: siteRect(580, 580, 20) }
              : mass)
          }
        : building)
    };
    expect(original.sourceId).toBe("mass-check");
    expect(validateCompleteCityPlan(tampered).some((problem) => /mass.*site|site.*mass|mass.*contained/i.test(problem))).toBe(true);
  });

  it("accepts a connected hole-free manual multi-parcel site and rejects disconnected or hole-like equivalents", () => {
    const connectedParts = [
      rectRing({ x: 40, y: 40, width: 60, height: 60 }),
      rectRing({ x: 100, y: 40, width: 60, height: 60 }),
      rectRing({ x: 100, y: 100, width: 60, height: 60 })
    ];
    const connectedUnion = union(connectedParts.map(ringAsMulti));
    expect(connectedUnion).toHaveLength(1);
    expect(connectedUnion[0]).toHaveLength(1);
    const connectedRing = connectedUnion[0]?.[0];
    if (connectedRing === undefined) throw new Error("Expected edge-sharing parcel union to produce one outer ring.");
    expect(Math.abs(ringArea(connectedRing))).toBeCloseTo(
      connectedParts.reduce((sum, part) => sum + Math.abs(ringArea(part)), 0),
      6
    );

    const connectedSite: PersistentBuildingSource = {
      ...sourceBuilding("connected-site", 100, 110, "manual-edit"),
      // Three edge-sharing parcel-sized bands form one connected, hole-free site.
      sitePolygon: connectedRing,
      placement: placement(130, 100, 52, 52)
    };
    const accepted = build(baseSource({ buildings: [connectedSite], places: [], overrides: [] }));
    expect(validateCompleteCityPlan(accepted)).toEqual([]);
    const acceptedBuilding = persistentBuilding(accepted, "connected-site");
    expect(acceptedBuilding.sitePolygon).toEqual(connectedSite.sitePolygon);
    expect(acceptedBuilding.masses.length).toBeGreaterThan(0);
    expect(acceptedBuilding.masses.every((mass) =>
      isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(connectedSite.sitePolygon)]))
    )).toBe(true);

    const disconnectedParts = [
      rectRing({ x: 40, y: 40, width: 40, height: 40 }),
      rectRing({ x: 120, y: 120, width: 40, height: 40 })
    ];
    const disconnectedUnion = union(disconnectedParts.map(ringAsMulti));
    expect(disconnectedUnion).toHaveLength(2);
    const disconnectedSite: PersistentBuildingSource = {
      ...sourceBuilding("disconnected-site", 100, 100, "none"),
      // Serializing two disconnected outer rings into one Ring repeats vertices and is invalid.
      sitePolygon: disconnectedParts.flatMap((part) => [...part, part[0]!])
    };
    expect(() => build(baseSource({ buildings: [disconnectedSite], places: [], overrides: [] }))).toThrow(/ring|polygon|self|invalid|site/i);

    const holeOuter = rectRing({ x: 40, y: 40, width: 120, height: 120 });
    const holeInner = rectRing({ x: 70, y: 70, width: 60, height: 60 });
    const holedUnion = difference(ringAsMulti(holeOuter), [ringAsMulti(holeInner)]);
    expect(holedUnion).toHaveLength(1);
    expect(holedUnion[0]).toHaveLength(2);
    const holeLikeSite: PersistentBuildingSource = {
      ...sourceBuilding("hole-like-site", 100, 100, "none"),
      // Serializing an outer loop and an inner loop into one Ring cannot preserve hole ownership.
      sitePolygon: holedUnion[0]!.flatMap((ring) => [...ring, ring[0]!])
    };
    expect(() => build(baseSource({ buildings: [holeLikeSite], places: [], overrides: [] }))).toThrow(/ring|polygon|self|invalid|site/i);
  });

  it("matches and applies sparse appearance overrides by target id, lineage, and canonical site snapshot", () => {
    const base = baseSource();
    const original = build(base);
    const target = original.buildings.find((building) => building.sourceId === null);
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("Expected an unzoned procedural building for override fixture.");
    const override: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: target.id,
      lineage: target.lineage,
      protection: "none",
      snapshotSitePolygon: target.sitePolygon,
      appearanceSeed: "rerolled/appearance/seed",
      paletteId: null
    };
    const withOverride = build(baseSource({ buildings: [], places: [], overrides: [override] }));
    const rerolled = withOverride.buildings.find((building) => building.id === target.id);
    if (rerolled === undefined) throw new Error(`Missing overridden building ${target.id}.`);
    expect(rerolled.sourceId).toBeNull();
    expect(rerolled.lineage).toBe(target.lineage);
    expect(rerolled.appearanceSeed).toBe(override.appearanceSeed);
    expect(rerolled.paletteId).toBeNull();
    expect(rerolled.seed).toBe(target.seed);
    expect(rerolled.masses.map((mass) => mass.footprint)).toEqual(target.masses.map((mass) => mass.footprint));
    expect(rerolled.masses.map((mass) => mass.heightM)).toEqual(target.masses.map((mass) => mass.heightM));
  });

  it("reports unprotected stale, lineage-mismatched, and snapshot-mismatched overrides without proximity remapping", () => {
    const original = build(baseSource());
    const target = original.buildings.find((building) => building.sourceId === null);
    if (target === undefined) throw new Error("Expected an unzoned procedural building for stale override fixture.");
    const stale: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: "stale-nearby-id",
      lineage: target.lineage,
      protection: "none",
      snapshotSitePolygon: target.sitePolygon,
      appearanceSeed: "must-not-apply"
    };
    const wrongLineage: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: target.id,
      lineage: "migrated/wrong-lineage",
      protection: "none",
      snapshotSitePolygon: target.sitePolygon,
      appearanceSeed: "must-not-apply-lineage"
    };
    const wrongSnapshot: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: target.id,
      lineage: target.lineage,
      protection: "none",
      snapshotSitePolygon: siteRect(580, 580, 20),
      appearanceSeed: "must-not-apply-snapshot"
    };
    const plan = build(baseSource({ buildings: [], places: [], overrides: [stale] }));
    expect(plan.diagnostics.orphanedOverrides).toContain(stale.targetId);
    expect(plan.diagnostics.warnings.some((warning) => warning.includes(stale.targetId))).toBe(true);
    expect(plan.buildings.find((building) => building.id === target.id)!.appearanceSeed).toBe(target.appearanceSeed);

    const lineagePlan = build(baseSource({ buildings: [], places: [], overrides: [wrongLineage] }));
    expect(lineagePlan.diagnostics.orphanedOverrides).toContain(wrongLineage.targetId);
    expect(lineagePlan.buildings.find((building) => building.id === target.id)!.appearanceSeed).toBe(target.appearanceSeed);

    const snapshotPlan = build(baseSource({ buildings: [], places: [], overrides: [wrongSnapshot] }));
    expect(snapshotPlan.diagnostics.orphanedOverrides).toContain(wrongSnapshot.targetId);
    expect(snapshotPlan.buildings.find((building) => building.id === target.id)!.appearanceSeed).toBe(target.appearanceSeed);
  });

  it("rejects a protected override when its target, lineage, or canonical site snapshot no longer matches", () => {
    const original = build(baseSource());
    const target = original.buildings.find((building) => building.sourceId === null);
    if (target === undefined) throw new Error("Expected an unzoned procedural building for protected override fixture.");
    const protectedOverride: ArchitectureOverrideSource = {
      targetKind: "building",
      targetId: target.id,
      lineage: target.lineage,
      protection: "explicit",
      snapshotSitePolygon: siteRect(580, 580, 20),
      appearanceSeed: "protected-reroll"
    };
    expect(() => build(baseSource({ buildings: [], places: [], overrides: [protectedOverride] }))).toThrow(/protected|override|snapshot|mismatch|orphan/i);
  });

  it("orphanizes unprotected overrides of persistent objects and rejects protected ones", () => {
    const building = sourceBuilding("override-persistent-building", 100, 100, "none");
    const place = sourcePlace("override-persistent-place", 100, 500, "none");
    const unprotected = (targetKind: "building" | "place", targetId: string, lineage: string, snapshotSitePolygon: Ring): ArchitectureOverrideSource => ({
      targetKind,
      targetId,
      lineage,
      protection: "none",
      snapshotSitePolygon,
      appearanceSeed: "must-not-mask-persistent-source",
      paletteId: null
    });
    const source = baseSource({
      buildings: [building],
      places: [place],
      overrides: [
        unprotected("building", building.id, building.lineage, building.sitePolygon),
        unprotected("place", place.id, place.lineage, place.sitePolygon)
      ]
    });
    const plan = build(source);
    expect(plan.diagnostics.orphanedOverrides).toEqual(expect.arrayContaining([building.id, place.id]));
    expect(persistentBuilding(plan, building.id).appearanceSeed).toBe(building.appearanceSeed);
    expect(plan.landmarks.find((landmark) => landmark.sourceId === place.id)?.appearanceSeed).toBe(place.appearanceSeed);

    const protectedOverride = unprotected("building", building.id, building.lineage, building.sitePolygon);
    protectedOverride.protection = "explicit";
    expect(() => build(baseSource({
      buildings: [building],
      places: [],
      overrides: [protectedOverride]
    }))).toThrow(/protected|override|mismatch/i);
  });

  it("fits derived building and place frames to concave geometry without changing frontage or mass containment", () => {
    const concaveSite: Ring = [
      { x: 40, y: 40 },
      { x: 56, y: 40 },
      { x: 56, y: 66 },
      { x: 52, y: 66 },
      { x: 52, y: 70 },
      { x: 40, y: 70 }
    ];
    const placeSite: Ring = [
      { x: 40, y: 40 },
      { x: 120, y: 40 },
      { x: 120, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 120 },
      { x: 40, y: 120 }
    ];
    const buildingWeights = Object.fromEntries(
      BUILDING_GRAMMAR_IDS.map((grammarId) => [grammarId, grammarId === "narrow-shopfront" ? 1 : 0])
    ) as Record<(typeof BUILDING_GRAMMAR_IDS)[number], number>;
    const useWeights = Object.fromEntries(BUILDING_USE_IDS.map((use) => [use, 1])) as Record<(typeof BUILDING_USE_IDS)[number], number>;
    const derivedBuilding = planParcelBuilding({
      id: "concave-derived-parcel",
      blockId: "concave-block",
      fragmentId: "concave-fragment",
      districtId: null,
      polygon: concaveSite,
      frontageAngleRad: 0,
      seed: "concave-derived/geometry",
      areaM2: 464
    }, buildingWeights, useWeights, undefined, new Map());
    expect(derivedBuilding).not.toBeNull();
    if (derivedBuilding === null || derivedBuilding.placement === undefined) throw new Error("Expected a derived building frame.");
    const buildingFrame = frameRing(derivedBuilding.placement);
    expect(derivedBuilding.placement.rotationRad).toBe(0);
    expect(isSnapNoise(difference(ringAsMulti(buildingFrame), [ringAsMulti(concaveSite)]))).toBe(true);
    expect(derivedBuilding.masses.every((mass) =>
      isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(concaveSite)]))
    )).toBe(true);

    const placePlan = buildCompleteCityPlan(baseSource(), 7, 3, [{
      grammarId: "infrastructure-utility-site",
      lineage: "concave-derived/place",
      seed: "concave-derived/place/geometry",
      sitePolygon: placeSite
    }]);
    const derivedPlace = placePlan.landmarks.find((landmark) => landmark.placementLineage === "concave-derived/place");
    expect(derivedPlace).toBeDefined();
    if (derivedPlace === undefined || derivedPlace.placement === undefined) throw new Error("Expected a derived place frame.");
    const placeFrame = frameRing(derivedPlace.placement);
    expect(isSnapNoise(difference(ringAsMulti(placeFrame), [ringAsMulti(placeSite)]))).toBe(true);
    expect(derivedPlace.masses.every((mass) =>
      isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(placeSite)]))
    )).toBe(true);
  });

  it("keeps an appearance reroll structurally isolated for a persistent building", () => {
    const firstSource = baseSource({
      buildings: [sourceBuilding("appearance-isolation", 100, 100, "manual-edit")],
      places: [],
      overrides: []
    });
    const secondSource = structuredClone(firstSource);
    secondSource.architecture.buildings[0]!.appearanceSeed = "different-appearance-stream";
    const first = build(firstSource);
    const second = build(secondSource);
    const firstBuilding = persistentBuilding(first, "appearance-isolation");
    const secondBuilding = persistentBuilding(second, "appearance-isolation");

    expect(secondBuilding.seed).toBe(firstBuilding.seed);
    expect(secondBuilding.lineage).toBe(firstBuilding.lineage);
    expect(secondBuilding.sitePolygon).toEqual(firstBuilding.sitePolygon);
    expect(secondBuilding.placement).toEqual(firstBuilding.placement);
    expect(secondBuilding.areaM2).toBe(firstBuilding.areaM2);
    expect(secondBuilding.masses.map((mass) => mass.footprint)).toEqual(firstBuilding.masses.map((mass) => mass.footprint));
    expect(secondBuilding.masses.map((mass) => mass.heightM)).toEqual(firstBuilding.masses.map((mass) => mass.heightM));
    expect(secondBuilding.appearanceSeed).toBe("different-appearance-stream");
    expect(secondBuilding.masses.map((mass) => ({ wallMaterial: mass.wallMaterial, roofMaterial: mass.roofMaterial, facadeSeed: mass.facadeSeed })))
      .not.toEqual(firstBuilding.masses.map((mass) => ({ wallMaterial: mass.wallMaterial, roofMaterial: mass.roofMaterial, facadeSeed: mass.facadeSeed })));
  });

  it("promotes an unchanged concave-site generated building on a height-only edit and keeps authored/changed geometry strict", () => {
    // L-shaped site: 60x24 bottom leg plus a 30x20 right leg (2040 m2). The persisted
    // promotion frame mirrors promotedArchitectureSource: the smaller mass-envelope
    // placementFrameForRing fitted into the concave site (here the bottom leg), whose
    // width sits below residential-wing's 18 m minWidth even though the site fits.
    const grammar = BUILDING_GRAMMAR_REGISTRY.get("residential-wing");
    if (grammar === undefined) throw new Error("Missing building grammar residential-wing");
    const concaveSite: Ring = [
      { x: 40, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 44 },
      { x: 70, y: 44 },
      { x: 70, y: 24 },
      { x: 40, y: 24 }
    ];
    const envelopeSource = (): PersistentBuildingSource => ({
      ...sourceBuilding("concave-envelope", 68, 12, "manual-edit", "generated"),
      grammarId: "residential-wing",
      visualUse: grammar.compatibleUses[0]!,
      heightM: grammar.height.minM,
      sitePolygon: concaveSite,
      placement: placement(68, 12, 16, 22)
    });
    const frame = frameRing(envelopeSource().placement);
    expect(isSnapNoise(difference(ringAsMulti(frame), [ringAsMulti(concaveSite)]))).toBe(true);

    const plan = build(baseSource({ buildings: [envelopeSource()], places: [], overrides: [] }));
    expect(validateCompleteCityPlan(plan)).toEqual([]);
    const building = persistentBuilding(plan, "concave-envelope");
    expect(building.grammarId).toBe("residential-wing");
    expect(building.masses.every((mass) =>
      isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(concaveSite)]))
    )).toBe(true);

    // Height-only semantic promotion: grammar, use, palette, site, and frame stay verbatim.
    const promoted = envelopeSource();
    promoted.heightM = 100;
    const promotedPlan = build(baseSource({ buildings: [promoted], places: [], overrides: [] }));
    expect(validateCompleteCityPlan(promotedPlan)).toEqual([]);
    const promotedBuilding = persistentBuilding(promotedPlan, "concave-envelope");
    expect(promotedBuilding.heightM).toBe(100);
    expect(promotedBuilding.grammarId).toBe(building.grammarId);
    expect(promotedBuilding.visualUse).toBe(building.visualUse);
    expect(promotedBuilding.paletteId).toBe(building.paletteId);
    expect(promotedBuilding.sitePolygon).toEqual(building.sitePolygon);
    expect(promotedBuilding.placement).toEqual(building.placement);
    expect(promotedBuilding.masses.every((mass) =>
      isSnapNoise(difference(ringAsMulti(mass.footprint), [ringAsMulti(concaveSite)]))
    )).toBe(true);

    // Authored placements still validate strictly against the frame itself.
    expect(() => build(baseSource({
      buildings: [{ ...envelopeSource(), origin: "authored" }],
      places: [],
      overrides: []
    }))).toThrow(/placement frame does not fit grammar/);

    // Changed geometry (frame and site transformed together, as transformObject does)
    // shrinks the parcel below the grammar's declared limits and still rejects.
    const scaleAboutFrameCentre = (ring: Ring, factor: number): Ring =>
      ring.map((point) => ({
        x: 68 + (point.x - 68) * factor,
        y: 12 + (point.y - 12) * factor
      }));
    const transformed = envelopeSource();
    transformed.sitePolygon = scaleAboutFrameCentre(transformed.sitePolygon, 0.3);
    transformed.placement = {
      centre: { x: 68, y: 12 },
      rotationRad: 0,
      widthM: transformed.placement.widthM * 0.3,
      depthM: transformed.placement.depthM * 0.3
    };
    expect(() => build(baseSource({ buildings: [transformed], places: [], overrides: [] })))
      .toThrow(/placement frame does not fit grammar/);
  });

  it("lets a moved generated promotion shadow its original procedural stable id", () => {
    const initial = build(baseSource());
    const candidates = initial.buildings.filter((building) =>
      building.sourceId === null && building.placement !== undefined && building.blockId !== null
    );
    const donor = candidates[0];
    const identity = candidates.find((building) => building.id !== donor?.id);
    if (donor === undefined || donor.placement === undefined || identity === undefined) {
      throw new Error("Expected two procedural buildings for promotion regression.");
    }
    const promoted: PersistentBuildingSource = {
      id: identity.id,
      lineage: identity.lineage,
      origin: "generated",
      protection: "manual-edit",
      seed: donor.seed,
      appearanceSeed: donor.appearanceSeed,
      grammarId: donor.grammarId,
      visualUse: donor.visualUse,
      heightM: donor.heightM,
      paletteId: donor.paletteId ?? null,
      sitePolygon: structuredClone(donor.sitePolygon),
      placement: structuredClone(donor.placement),
      districtId: donor.districtId,
      blockId: donor.blockId
    };

    const rebuilt = build(baseSource({ buildings: [promoted], places: [], overrides: [] }));
    expect(validateCompleteCityPlan(rebuilt)).toEqual([]);
    expect(rebuilt.buildings.filter((building) => building.id === identity.id)).toHaveLength(1);
    expect(persistentBuilding(rebuilt, identity.id).sitePolygon).toEqual(donor.sitePolygon);
  });
});
