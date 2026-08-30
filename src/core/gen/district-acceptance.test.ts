import { describe, expect, it } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { rectRing, ringArea, type Ring } from "../geom/types.js";
import { validateCitySourceV4, type CitySourceV4 } from "./city.js";
import { generateInitialDistricts } from "./district-generator.js";
import { buildDistrictPlan, districtBreadthGallery, planDistrictFragmentWithGrammar, type DevelopmentCellPlan, type DistrictBlockFragment } from "./district-plan.js";
import { BLOCK_GRAMMAR_IDS, DISTRICT_TYPE_IDS, DISTRICT_TYPES, DISTRICT_TYPE_REGISTRY, type BlockGrammarId, type DistrictTypeDefinition } from "./district-registry.js";
import { generateInitialRoadNetwork } from "./road-generator.js";
import { validateRing } from "./terrain.js";

const CITY_SIDE_M = 1_000;
const CITY_DIAGONAL_M = Math.SQRT2 * CITY_SIDE_M;
const CITY_SEED = "phase3-acceptance-1400m";
const yieldToRunner = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const area = (ring: Ring): number => Math.abs(ringArea(ring));
const multiArea = (multi: ReturnType<typeof ringAsMulti>): number => multi.reduce(
  (total, polygon) => total + polygon.reduce((sum, ring, index) => sum + (index === 0 ? 1 : -1) * area(ring), 0),
  0
);

function acceptanceSource(): CitySourceV4 {
  const land = rectRing({ x: 0, y: 0, width: CITY_SIDE_M, height: CITY_SIDE_M });
  const roads = generateInitialRoadNetwork({ citySeed: CITY_SEED, mask: land, land, layout: "grid", hubMode: "single-centre" }).roads;
  return {
    origin: { x: 12_000, y: 9_000 },
    citySeed: CITY_SEED,
    generation: {
      terrainMode: "rectangle",
      coastEdge: null,
      roadLayout: "grid",
      hubMode: "single-centre",
      districtPool: [...DISTRICT_TYPE_IDS],
      openSpaceProfile: "medium"
    },
    terrain: { land, urbanFootprint: null },
    roads,
    districts: [],
    architecture: { buildings: [], places: [], overrides: [] }
  };
}

function permuteSource(source: CitySourceV4): CitySourceV4 {
  return {
    ...source,
    roads: {
      nodes: [...source.roads.nodes].reverse(),
      routes: [...source.roads.routes].reverse(),
      edges: [...source.roads.edges].reverse()
    },
    districts: [...source.districts].reverse()
  };
}

function withAcceptanceOverride(districts: CitySourceV4["districts"]): CitySourceV4["districts"] {
  return districts.map((district, index) => index === 0 ? {
    ...district,
    openSpaceOverride: {
      rate: 0.31,
      categoryWeights: { park: 1, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
      sizeWeights: { pocket: 0, small: 1, large: 0, "whole-block": 0 }
    }
  } : district);
}

function planningSignature(cells: DevelopmentCellPlan[]): string {
  const rotations = [...new Set(cells.map((cell) => cell.rotationRad.toFixed(4)))].sort();
  const roles = [...new Set(cells.map((cell) => cell.localRole.replace(/-?\d+$/u, "")))].sort();
  const totalArea = cells.reduce((sum, cell) => sum + area(cell.polygon), 0);
  return JSON.stringify({ count: cells.length, roles, rotations, area: Math.round(totalArea * 10) / 10 });
}

describe("Phase 3 district acceptance fixtures", () => {
  it("plans a representative metre-space city with bounded structural output", async () => {
    const source = acceptanceSource();
    const started = performance.now();
    const generated = withAcceptanceOverride(generateInitialDistricts(source));
    await yieldToRunner();
    const plan = buildDistrictPlan({ ...source, districts: generated });
    const elapsedMs = performance.now() - started;

    expect(CITY_DIAGONAL_M).toBeGreaterThanOrEqual(1_200);
    expect(CITY_DIAGONAL_M).toBeLessThanOrEqual(1_500);
    expect(source.roads.edges.length).toBeGreaterThan(20);
    expect(plan.blocks.length).toBeGreaterThan(20);
    expect(generated.length).toBeGreaterThan(1);
    expect(plan.developmentCells.length).toBeGreaterThan(plan.blocks.length);
    expect(plan.openSpaceIntents.length).toBe(plan.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0));
    expect(plan.wallCells.length).toBeGreaterThan(0);
    expect(plan.diagnostics.faceCount).toBe(plan.blocks.length);
    expect(plan.diagnostics.fragmentCount).toBeGreaterThanOrEqual(plan.blocks.length);
    expect(plan.blocks.every((block) => block.districtFragments.length > 0)).toBe(true);
    expect(generated.filter((district) => district.openSpaceOverride !== null)).toHaveLength(1);
    expect(plan.developmentCells.length).toBeLessThan(200_000);
    expect(plan.blocks.length).toBeLessThan(20_000);
    expect(plan.developmentCells.every((cell) => validateRing(cell.polygon).ok)).toBe(true);
    expect(elapsedMs).toBeLessThan(45_000);

    const fragmentById = new Map(plan.blocks.flatMap((block) => block.districtFragments.map((fragment) => [fragment.id, fragment] as const)));
    for (const cell of plan.developmentCells) {
      const fragment = fragmentById.get(cell.fragmentId);
      expect(fragment).toBeDefined();
      const cellArea = area(cell.polygon);
      expect(cellArea).toBeGreaterThan(1e-6);
      expect(multiArea(intersection(ringAsMulti(cell.polygon), fragment!.buildable))).toBeCloseTo(cellArea, 2);
    }
  }, 60_000);

  it("reconstructs identical metre-space plans under source permutation and origin changes", async () => {
    const source = acceptanceSource();
    const districts = withAcceptanceOverride(generateInitialDistricts(source));
    await yieldToRunner();
    const first = buildDistrictPlan({ ...source, districts });
    await yieldToRunner();
    const permuted = buildDistrictPlan(permuteSource({ ...source, districts }));
    await yieldToRunner();
    const shifted = buildDistrictPlan({ ...source, origin: { x: 48_000, y: -31_000 }, districts });

    expect(permuted.blocks).toEqual(first.blocks);
    expect(permuted.developmentCells).toEqual(first.developmentCells);
    expect(permuted.openSpaceIntents).toEqual(first.openSpaceIntents);
    expect(shifted.blocks).toEqual(first.blocks);
    expect(shifted.developmentCells).toEqual(first.developmentCells);
    expect(shifted.openSpaceIntents).toEqual(first.openSpaceIntents);
    expect(permuted.revisionInputs).toEqual(first.revisionInputs);
    expect(shifted.revisionInputs).toEqual(first.revisionInputs);
  }, 120_000);

  it("covers every district identity and grammar with materially varied planning fixtures", () => {
    const gallery = districtBreadthGallery();
    expect(new Set(gallery.map((entry) => entry.districtTypeId))).toEqual(new Set(DISTRICT_TYPE_IDS));
    expect(new Set(gallery.map((entry) => entry.grammarId))).toEqual(new Set(BLOCK_GRAMMAR_IDS));
    expect(gallery.every((entry) => entry.fixtureSeed.startsWith("gallery/v3/"))).toBe(true);

    const ring = rectRing({ x: 0, y: 0, width: 140, height: 110 });
    const fragment: DistrictBlockFragment = { id: "gallery-fragment", blockId: "gallery-block", districtId: "gallery-district", buildable: ringAsMulti(ring) };
    const dominantGrammar = (definition: DistrictTypeDefinition): BlockGrammarId =>
      [...BLOCK_GRAMMAR_IDS].sort((a, b) => definition.grammarWeights[b] - definition.grammarWeights[a] || a.localeCompare(b))[0]!;

    // Every block grammar materializes a distinct planning form, so a district family's
    // dominant form is observable without palette colour.
    const grammarSignatures = new Set<string>();
    for (const grammarId of BLOCK_GRAMMAR_IDS) {
      const definition = DISTRICT_TYPES.find((entry) => entry.id === "mixed-use-centre")!;
      const cells = planDistrictFragmentWithGrammar(fragment, grammarId, definition.bounds, `gallery/${grammarId}`);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => validateRing(cell.polygon).ok)).toBe(true);
      expect(cells.every((cell) => cell.grammarId === grammarId)).toBe(true);
      grammarSignatures.add(planningSignature(cells));
    }
    expect(grammarSignatures.size).toBe(BLOCK_GRAMMAR_IDS.length);

    // Types sharing a dominant grammar form a family. Shared forms (formal towers,
    // residential courtyards, industrial sheds, fine-grain streetfronts) are deliberate
    // correlated metropolitan materials, so family members may materialize the same
    // dominant-form fixture; each member must still differ from its family peers in a
    // durable non-colour planning dimension: height band, cell scale, grammar mix, or
    // building/use DNA.
    const families = new Map<BlockGrammarId, DistrictTypeDefinition[]>();
    for (const typeId of DISTRICT_TYPE_IDS) {
      const definition = DISTRICT_TYPE_REGISTRY.get(typeId)!;
      const dominant = dominantGrammar(definition);
      const cells = planDistrictFragmentWithGrammar(fragment, dominant, definition.bounds, `gallery/type/${typeId}`);
      expect(cells.length, typeId).toBeGreaterThan(0);
      expect(cells.every((cell) => validateRing(cell.polygon).ok), typeId).toBe(true);
      expect(cells.every((cell) => cell.grammarId === dominant), typeId).toBe(true);
      families.set(dominant, [...(families.get(dominant) ?? []), definition]);
    }

    const grammarMix = (definition: DistrictTypeDefinition): string =>
      BLOCK_GRAMMAR_IDS
        .filter((id) => definition.grammarWeights[id] > 0)
        .sort((a, b) => definition.grammarWeights[b] - definition.grammarWeights[a] || a.localeCompare(b))
        .join(">");

    for (const [dominant, members] of families) {
      for (let first = 0; first < members.length; first++) {
        for (let second = first + 1; second < members.length; second++) {
          const a = members[first]!;
          const b = members[second]!;
          const distinct = JSON.stringify(a.heightBand) !== JSON.stringify(b.heightBand) ||
            JSON.stringify(a.bounds) !== JSON.stringify(b.bounds) ||
            grammarMix(a) !== grammarMix(b) ||
            JSON.stringify(a.buildingGrammarWeights) !== JSON.stringify(b.buildingGrammarWeights) ||
            JSON.stringify(a.visualUseWeights) !== JSON.stringify(b.visualUseWeights);
          expect(distinct, `${dominant}: ${a.id} and ${b.id} are planning twins`).toBe(true);
        }
      }
    }
  }, 45_000);

  it("serializes only authoritative source fields and round-trips validation", () => {
    const source = acceptanceSource();
    const districts = withAcceptanceOverride(generateInitialDistricts(source));
    const state = { kind: "city-generator-2" as const, schemaVersion: 4 as const, generatorVersion: 12 as const, revision: 7, source: { ...source, districts } };
    const encoded = JSON.stringify(state);
    const decoded = JSON.parse(encoded) as typeof state;

    expect(decoded).toEqual(state);
    expect(validateCitySourceV4(decoded.source)).toEqual([]);
    for (const derivedKey of ["blocks", "developmentCells", "openSpaceIntents", "wallCells", "diagnostics"]) {
      expect(encoded).not.toContain(`"${derivedKey}"`);
    }
  }, 45_000);
});
