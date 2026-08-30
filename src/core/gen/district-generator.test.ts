import { describe, expect, it } from "vitest";
import { rectRing, type Ring } from "../geom/types.js";
import type { CitySourceV4, DistrictSource, RoadEdgeSource, RoadNodeSource, RoadRouteSource } from "./city.js";
import { assignLandmarkCompatibleDistrictTypes, districtGenerationAvailability, districtRegionContext, generateInitialDistricts, resolveGeneratedRegions } from "./district-generator.js";
import { buildDistrictPlan, type DerivedBlock } from "./district-plan.js";
import { DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "./district-registry.js";
import type { LandmarkGrammarId } from "./landmark-registry.js";
import { generateInitialRoadNetwork } from "./road-generator.js";
import { validateRing } from "./terrain.js";

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string): RoadEdgeSource => ({ id, a, b, routeId, classId: "street", name: null, locked: false, origin: "authored" });

const source = (): CitySourceV4 => ({
  origin: { x: 0, y: 0 },
  citySeed: "district-generation",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "multiple-hubs", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
  terrain: { land: rectRing({ x: 0, y: 0, width: 200, height: 200 }), urbanFootprint: null },
  roads: {
    nodes: [node("n", 100, 0), node("w", 0, 100), node("c", 100, 100), node("e", 200, 100), node("s", 100, 200)],
    routes: [route("h"), route("v")],
    edges: [edge("n", "n", "c", "v"), edge("w", "w", "c", "h"), edge("e", "c", "e", "h"), edge("s", "c", "s", "v")]
  },
  districts: [],
  architecture: { buildings: [], places: [], overrides: [] }
});

describe("initial district generation", () => {
  it("requires empty districts, vehicle roads, and a non-empty pool", () => {
    expect(districtGenerationAvailability(source())).toEqual({ available: true, reason: null });
    expect(districtGenerationAvailability({ ...source(), roads: { nodes: [], routes: [], edges: [] } }).available).toBe(false);
    expect(districtGenerationAvailability({ ...source(), generation: { ...source().generation, districtPool: [] } }).available).toBe(false);
  });

  it("grows deterministic connected districts and reconstructs a complete plan", () => {
    const first = generateInitialDistricts(source());
    const second = generateInitialDistricts(source());
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(new Set(first.map((district) => district.typeId)).size).toBeGreaterThan(1);
    expect(first.every((district) => district.origin === "generated" && !district.locked)).toBe(true);
    const plan = buildDistrictPlan({ ...source(), districts: first });
    expect(plan.blocks).toHaveLength(4);
    expect(plan.developmentCells.some((cell) => cell.districtId !== null)).toBe(true);
  });

  it("is independent of road source array order", () => {
    const original = source();
    const permuted = { ...original, roads: { nodes: [...original.roads.nodes].reverse(), routes: [...original.roads.routes].reverse(), edges: [...original.roads.edges].reverse() } };
    expect(generateInitialDistricts(permuted)).toEqual(generateInitialDistricts(original));
  });

  it("uses bounded context tendencies and expresses hierarchy across terrain and hub modes", () => {
    const original = source();
    const coastal = {
      ...original,
      generation: {
        ...original.generation,
        terrainMode: "coastal" as const,
        coastEdge: "north" as const,
        districtPool: ["corporate-core", "heavy-industrial", "waterfront"] as CitySourceV4["generation"]["districtPool"]
      }
    };
    const generated = generateInitialDistricts(coastal);
    expect(new Set(generated.map((district) => district.typeId)).size).toBeGreaterThan(1);
    // Waterfront pool types appear in appropriate waterfront-adjacent context
    expect(generated.some((district) => district.typeId === "waterfront" || district.typeId === "corporate-core")).toBe(true);

    const singleCentre = generateInitialDistricts({ ...original, generation: { ...original.generation, hubMode: "single-centre" } });
    const multipleHubs = generateInitialDistricts(original);
    expect(singleCentre.length).toBeGreaterThan(0);
    expect(multipleHubs.length).toBeGreaterThan(0);

    const block = buildDistrictPlan(original).blocks[0]!;
    const singleContext = districtRegionContext({ ...original, generation: { ...original.generation, hubMode: "single-centre" } }, [block], block.zoningFace);
    const multipleContext = districtRegionContext(original, [block], block.zoningFace);
    expect(singleContext.hubProximity).not.toBe(multipleContext.hubProximity);
  });

  it("merges a generated ring-region into a compatible neighbor instead of exploding it per block", () => {
    const blocks: DerivedBlock[] = [];
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      const id = `b${row}${column}`;
      const zoningFace = rectRing({ x: column * 10, y: row * 10, width: 10, height: 10 });
      blocks.push({ id, zoningFace, buildable: [[zoningFace]], boundaryRoadIds: [], districtFragments: [] });
    }
    const adjacent = new Map<string, string[]>();
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      const neighbors: string[] = [];
      if (row > 0) neighbors.push(`b${row - 1}${column}`);
      if (row < 2) neighbors.push(`b${row + 1}${column}`);
      if (column > 0) neighbors.push(`b${row}${column - 1}`);
      if (column < 2) neighbors.push(`b${row}${column + 1}`);
      adjacent.set(`b${row}${column}`, neighbors.sort());
    }
    const outer = blocks.map((block) => block.id).filter((id) => id !== "b11");
    expect(resolveGeneratedRegions(blocks, [outer, ["b11"]], adjacent, "cleanup-seed")).toEqual([
      blocks.map((block) => block.id).sort()
    ]);
  });

  it("never collapses incompatible holed regions through another invalid merge", () => {
    const blocks: DerivedBlock[] = [];
    for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
      const id = `b${row}${column}`;
      const zoningFace = rectRing({ x: column * 10, y: row * 10, width: 10, height: 10 });
      blocks.push({ id, zoningFace, buildable: [[zoningFace]], boundaryRoadIds: [], districtFragments: [] });
    }
    const adjacent = new Map<string, string[]>();
    for (let row = 0; row < 3; row++) for (let column = 0; column < 6; column++) {
      const neighbors: string[] = [];
      if (row > 0) neighbors.push(`b${row - 1}${column}`);
      if (row < 2) neighbors.push(`b${row + 1}${column}`);
      if (column > 0) neighbors.push(`b${row}${column - 1}`);
      if (column < 5) neighbors.push(`b${row}${column + 1}`);
      adjacent.set(`b${row}${column}`, neighbors.sort());
    }
    const left = blocks.map((block) => block.id).filter((id) => Number(id[2]) < 3 && id !== "b11");
    const right = blocks.map((block) => block.id).filter((id) => Number(id[2]) >= 3 && id !== "b14");
    expect(() => resolveGeneratedRegions(blocks, [left, right], adjacent, "incompatible-cleanup"))
      .toThrowError(/could not be resolved without a hole/);
  });

  it("leaves incompatible faces unzoned on a fresh full-size European network", () => {
    const bounds = { x: 0, y: 0, width: 1_200, height: 800 };
    const land = rectRing(bounds);
    const citySeed = "phase2-organic-european";
    const roads = generateInitialRoadNetwork({ citySeed, mask: land, land, layout: "european", hubMode: "multiple-hubs", sceneBounds: bounds }).roads;
    const european: CitySourceV4 = {
      origin: { x: 0, y: 0 },
      citySeed,
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "european", hubMode: "multiple-hubs", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
      terrain: { land, urbanFootprint: null },
      roads,
      districts: [],
      architecture: { buildings: [], places: [], overrides: [] }
    };
    const first = generateInitialDistricts(european);
    expect(generateInitialDistricts(european)).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((district) => validateRing(district.polygon).ok)).toBe(true);
    const plan = buildDistrictPlan({ ...european, districts: first });
    expect(plan.blocks.some((block) => block.districtFragments.length > 0 && block.districtFragments.every((fragment) => fragment.districtId === null))).toBe(true);
    expect(plan.unzoned.length).toBeGreaterThan(0);
  }, 60_000);

  it("plans the representative 83-block fixture with the complete 16-type pool and coherent hierarchy", () => {
    const land = rectRing({ x: 0, y: 0, width: 1_000, height: 1_000 });
    const roads = generateInitialRoadNetwork({ citySeed: "phase3-acceptance-1400m", mask: land, land, layout: "grid", hubMode: "single-centre" }).roads;
    const representative: CitySourceV4 = {
      origin: { x: 12_000, y: 9_000 },
      citySeed: "phase3-acceptance-1400m",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
      terrain: { land, urbanFootprint: null },
      roads,
      districts: [],
      architecture: { buildings: [], places: [], overrides: [] }
    };
    const districts = generateInitialDistricts(representative);
    const plan = buildDistrictPlan({ ...representative, districts });
    expect(plan.blocks).toHaveLength(83);
    expect(new Set(districts.map((district) => district.typeId)).size).toBeGreaterThan(4);
    expect(plan.developmentCells.length).toBeGreaterThan(plan.blocks.length);

    // Primary central core districts attract central / commercial / mixed / civic types
    const centralTypes = new Set<DistrictTypeId>(["corporate-core", "commercial-highrise", "mixed-use-centre", "civic-institutional", "dense-residential"]);
    expect(districts.some((district) => centralTypes.has(district.typeId))).toBe(true);

    // Adjacency properties: No hard clashes between corporate core and heavy industrial
    const districtByBlock = new Map<string, DistrictTypeId>();
    for (const district of districts) {
      for (const block of plan.blocks) {
        if (block.districtFragments.some((fragment) => fragment.districtId === district.id)) {
          districtByBlock.set(block.id, district.typeId);
        }
      }
    }
    for (const block of plan.blocks) {
      const typeA = districtByBlock.get(block.id);
      if (!typeA) continue;
      for (const roadId of block.boundaryRoadIds) {
        const neighborBlocks = plan.blocks.filter((b) => b.id !== block.id && b.boundaryRoadIds.includes(roadId));
        for (const neighbor of neighborBlocks) {
          const typeB = districtByBlock.get(neighbor.id);
          if (typeB && typeA !== typeB) {
            // Corporate core should not directly abut heavy industrial
            const isHardClash = (typeA === "corporate-core" && typeB === "heavy-industrial") || (typeA === "heavy-industrial" && typeB === "corporate-core");
            expect(isHardClash).toBe(false);
          }
        }
      }
    }
  }, 45_000);
});

describe("assignLandmarkCompatibleDistrictTypes", () => {
  const district = (id: string, polygon: Ring, typeId: DistrictTypeId): DistrictSource => ({
    id,
    polygon,
    seed: `${id}-seed`,
    typeId,
    paletteId: DISTRICT_TYPE_REGISTRY.get(typeId)!.defaultPaletteId,
    origin: "generated",
    locked: false,
    openSpaceOverride: null
  });
  // Corporate core is "formal"; a hero tower (formal+waterfront) fits it, a utility site
  // (industrial) does not.
  const hero = { grammarId: "hero-tower-plaza" as LandmarkGrammarId, sitePolygon: rectRing({ x: 10, y: 10, width: 20, height: 20 }) };
  const utility = { grammarId: "infrastructure-utility-site" as LandmarkGrammarId, sitePolygon: rectRing({ x: 60, y: 60, width: 20, height: 20 }) };
  const tags = (typeId: DistrictTypeId): readonly string[] => DISTRICT_TYPE_REGISTRY.get(typeId)!.compatibilityTags;

  it("reassigns a containing district to a compatible type with the type's default palette", () => {
    const districts = [district("a", rectRing({ x: 0, y: 0, width: 100, height: 100 }), "corporate-core")];
    const { districts: assigned, warnings } = assignLandmarkCompatibleDistrictTypes(districts, [utility], [...DISTRICT_TYPE_IDS], "seed");
    expect(warnings).toEqual([]);
    const updated = assigned[0]!;
    expect(updated.id).toBe("a");
    expect(updated.polygon).toEqual(districts[0]!.polygon);
    expect(updated.seed).toBe("a-seed");
    expect(updated.typeId).not.toBe("corporate-core");
    expect(tags(updated.typeId)).toContain("industrial");
    expect(updated.paletteId).toBe(DISTRICT_TYPE_REGISTRY.get(updated.typeId)!.defaultPaletteId);
  });

  it("keeps the original type when it already satisfies every contained reservation", () => {
    const districts = [district("a", rectRing({ x: 0, y: 0, width: 100, height: 100 }), "corporate-core")];
    const { districts: assigned, warnings } = assignLandmarkCompatibleDistrictTypes(districts, [hero], [...DISTRICT_TYPE_IDS], "seed");
    expect(warnings).toEqual([]);
    expect(assigned[0]).toEqual(districts[0]);
  });

  it("is deterministic across identical inputs", () => {
    const districts = [
      district("a", rectRing({ x: 0, y: 0, width: 100, height: 100 }), "corporate-core"),
      district("b", rectRing({ x: 100, y: 0, width: 100, height: 100 }), "corporate-core")
    ];
    const first = assignLandmarkCompatibleDistrictTypes(districts, [utility], [...DISTRICT_TYPE_IDS], "seed");
    const second = assignLandmarkCompatibleDistrictTypes(districts, [utility], [...DISTRICT_TYPE_IDS], "seed");
    expect(second).toEqual(first);
  });

  it("leaves the original type as deterministic contrast with a warning when no pool type fits", () => {
    const districts = [district("a", rectRing({ x: 0, y: 0, width: 100, height: 100 }), "corporate-core")];
    // Pool is only "formal" types: nothing fits an industrial utility site.
    const { districts: assigned, warnings } = assignLandmarkCompatibleDistrictTypes(districts, [utility], ["corporate-core", "civic-institutional"], "seed");
    expect(assigned[0]).toEqual(districts[0]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/District "a" cannot host landmark reservation/);
  });

  it("touches nothing when no reservation or no containing district exists", () => {
    const districts = [district("a", rectRing({ x: 0, y: 0, width: 100, height: 100 }), "corporate-core")];
    expect(assignLandmarkCompatibleDistrictTypes(districts, [], [...DISTRICT_TYPE_IDS], "seed").districts).toEqual(districts);
    const outside = { grammarId: "hero-tower-plaza" as LandmarkGrammarId, sitePolygon: rectRing({ x: 500, y: 500, width: 20, height: 20 }) };
    expect(assignLandmarkCompatibleDistrictTypes(districts, [outside], [...DISTRICT_TYPE_IDS], "seed").districts).toEqual(districts);
  });
});
