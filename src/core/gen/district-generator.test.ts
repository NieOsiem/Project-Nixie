import { describe, expect, it } from "vitest";
import { rectRing } from "../geom/types.js";
import type { CitySourceV3, RoadEdgeSource, RoadNodeSource, RoadRouteSource } from "./city.js";
import { districtGenerationAvailability, districtRegionContext, generateInitialDistricts, resolveGeneratedRegions } from "./district-generator.js";
import { buildDistrictPlan, type DerivedBlock } from "./district-plan.js";
import { DISTRICT_TYPE_IDS } from "./district-registry.js";
import { generateInitialRoadNetwork } from "./road-generator.js";

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string): RoadEdgeSource => ({ id, a, b, routeId, classId: "street", name: null, locked: false, origin: "authored" });

const source = (): CitySourceV3 => ({
  origin: { x: 0, y: 0 },
  citySeed: "district-generation",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "multiple-hubs", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
  terrain: { land: rectRing({ x: 0, y: 0, width: 200, height: 200 }), urbanFootprint: null },
  roads: {
    nodes: [node("n", 100, 0), node("w", 0, 100), node("c", 100, 100), node("e", 200, 100), node("s", 100, 200)],
    routes: [route("h"), route("v")],
    edges: [edge("n", "n", "c", "v"), edge("w", "w", "c", "h"), edge("e", "c", "e", "h"), edge("s", "c", "s", "v")]
  },
  districts: []
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
    expect(first.map((district) => district.typeId)).toEqual(["corporate-core", "commercial-highrise"]);
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

  it("uses bounded context tendencies without collapsing a multi-type pool", () => {
    const original = source();
    const coastal = {
      ...original,
      generation: {
        ...original.generation,
        terrainMode: "coastal" as const,
        coastEdge: "north" as const,
        districtPool: ["corporate-core", "heavy-industrial", "waterfront"] as CitySourceV3["generation"]["districtPool"]
      }
    };
    const generated = generateInitialDistricts(coastal);
    expect(new Set(generated.map((district) => district.typeId)).size).toBeGreaterThan(1);
    expect(generated.map((district) => district.typeId)).toEqual(["corporate-core", "heavy-industrial"]);
    const singleCentre = generateInitialDistricts({ ...original, generation: { ...original.generation, hubMode: "single-centre" } });
    const multipleHubs = generateInitialDistricts(original);
    expect(singleCentre.map((district) => district.typeId)).toEqual(["corporate-core", "commercial-highrise"]);
    expect(multipleHubs.map((district) => district.typeId)).toEqual(["corporate-core", "commercial-highrise"]);
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

  it("plans the representative 83-block fixture with the complete 16-type pool", () => {
    const land = rectRing({ x: 0, y: 0, width: 1_000, height: 1_000 });
    const roads = generateInitialRoadNetwork({ citySeed: "phase3-acceptance-1400m", mask: land, land, layout: "grid", hubMode: "single-centre" }).roads;
    const representative: CitySourceV3 = {
      origin: { x: 12_000, y: 9_000 },
      citySeed: "phase3-acceptance-1400m",
      generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
      terrain: { land, urbanFootprint: null },
      roads,
      districts: []
    };
    const districts = generateInitialDistricts(representative);
    const plan = buildDistrictPlan({ ...representative, districts });
    expect(plan.blocks).toHaveLength(83);
    expect(new Set(districts.map((district) => district.typeId)).size).toBeGreaterThan(4);
    expect(plan.developmentCells.length).toBeGreaterThan(plan.blocks.length);
  }, 45_000);
});
