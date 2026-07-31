import { describe, expect, it } from "vitest";
import { rectRing, ringBounds, ringCentroid, type MultiPolygon } from "../geom/types.js";
import { VERTEX_FLOATS } from "../geom/mesh.js";
import { BANK_SIZE, DISTRICT_SLOT } from "../palette.js";
import { buildingsForBlocks, type HashFrame, type LotRegion } from "./blocks.js";
import { buildChunk, cityChunks } from "./chunked.js";
import { cityBounds, cityToPixels, demoCity, rectToPixels } from "./demo-city.js";
import { neonMesh } from "./neon.js";
import { buildRoadSurfaces } from "./roads.js";
import {
  copyDistrictPreset,
  copyZoneParams,
  DEFAULT_ZONE_PARAMS,
  districtPresetById,
  DISTRICT_PRESETS,
  normalizeZoneParams,
  lotOptions,
  lotRegions,
  type ZoneParams
} from "./zones.js";

const IDS = [
  "corporate-core",
  "night-market",
  "industrial-utility",
  "residential-megablocks"
] as const;

const materialSignature = (params: ZoneParams): string =>
  JSON.stringify(
    params.palette.materials.map((material) => ({
      base: material.base,
      emissive: material.emissive,
      emissiveStrength: material.emissiveStrength
    }))
  );

const FRAME: HashFrame = { originPx: { x: 0, y: 0 }, pixelsPerMetre: 1 };
const BLOCKS: MultiPolygon = [
  [rectRing({ x: 0, y: 0, width: 600, height: 600 })],
  [rectRing({ x: 700, y: 0, width: 600, height: 600 })],
  [rectRing({ x: 0, y: 700, width: 600, height: 600 })],
  [rectRing({ x: 700, y: 700, width: 600, height: 600 })]
];

const region = (
  params: ZoneParams,
  bank = 2,
  clip: MultiPolygon | null = null,
  seed = params.seed
): LotRegion => ({
  seed,
  bank,
  options: lotOptions(params, FRAME.originPx, FRAME.pixelsPerMetre),
  clip
});

const specsFor = (params: ZoneParams, bank = 2): ReturnType<typeof buildingsForBlocks> =>
  buildingsForBlocks(BLOCKS, [region(params, bank)], FRAME);

const specKey = (spec: ReturnType<typeof buildingsForBlocks>[number]): string => {
  const bounds = ringBounds(spec.footprint);
  return [
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    spec.height,
    spec.wallMaterial,
    spec.roofMaterial,
    spec.seed,
    spec.massingFamily,
    spec.facadeRate,
    spec.poolRate,
    ...(spec.neonWeights ?? [])
  ].join("|");
};

const neonMaterialSlots = (mesh: ReturnType<typeof neonMesh>): number[] =>
  Array.from({ length: mesh.vertexCount }, (_, i) => mesh.vertices[i * VERTEX_FLOATS + 3]! % BANK_SIZE);

describe("district identity presets", () => {
  it("ships the four distinct grammars with distinct macro and visual controls", () => {
    expect(DISTRICT_PRESETS.map((preset) => preset.id)).toEqual(IDS);

    const params = IDS.map((id) => copyDistrictPreset(id)!);
    expect(params.every((value) => value !== null)).toBe(true);

    const signatures = params.map((value) =>
      JSON.stringify({
        occupancy: value.occupancy,
        heightCluster: value.heightCluster,
        massingWeights: value.massingWeights,
        facadeRate: value.facadeRate,
        poolRate: value.poolRate,
        wallWeights: value.wallWeights,
        roofWeights: value.roofWeights,
        neonWeights: value.neonWeights,
        palette: materialSignature(value)
      })
    );
    expect(new Set(signatures).size).toBe(IDS.length);

    for (const field of [
      "occupancy",
      "heightCluster",
      "facadeRate",
      "poolRate",
      "wallWeights",
      "roofWeights",
      "neonWeights"
    ] as const) {
      expect(new Set(params.map((value) => JSON.stringify(value[field]))).size).toBeGreaterThan(1);
    }
    expect(new Set(params.map((value) => JSON.stringify(value.massingWeights))).size).toBeGreaterThan(1);
    expect(new Set(params.map(materialSignature)).size).toBe(IDS.length);
  });

  it("deep-copies presets so editor changes cannot mutate the shipped templates", () => {
    const copy = copyDistrictPreset(IDS[0])!;
    const before = copyDistrictPreset(IDS[0])!;
    expect(copy).toEqual(before);

    copy.massingWeights.block = 0;
    copy.wallWeights[0] = 0;
    copy.roofWeights[1] = 0;
    copy.neonWeights[0] = 0;
    copy.palette.materials[0]!.base.r = 0;
    copy.palette.materials[0]!.emissive.g = 0;

    expect(copyDistrictPreset(IDS[0])).toEqual(before);
    expect(districtPresetById(IDS[0])!.params).toEqual(before);
  });

  it("deep-copies arbitrary zone params and does not retain mutable defaults", () => {
    const source = copyDistrictPreset(IDS[1])!;
    const copy = copyZoneParams(source);
    copy.massingWeights.podiumTower = 0;
    copy.wallWeights[1] = 0;
    copy.palette.materials[1]!.base.b = 0;

    expect(source.massingWeights.podiumTower).not.toBe(0);
    expect(source.wallWeights[1]).not.toBe(0);
    expect(source.palette.materials[1]!.base.b).not.toBe(0);

    const defaults = normalizeZoneParams({ seed: 33 });
    expect(defaults).toEqual(normalizeZoneParams({ seed: 33 }));
    defaults.massingWeights.block = 0;
    defaults.wallWeights[0] = 0;
    defaults.palette.materials[0]!.base.r = 0;
    expect(normalizeZoneParams({ seed: 33 })).toEqual(normalizeZoneParams({ seed: 33 }));
    expect(DEFAULT_ZONE_PARAMS.massingWeights.block).toBeGreaterThan(0);
    expect(DEFAULT_ZONE_PARAMS.wallWeights[0]).toBeGreaterThan(0);
  });

  it("normalizes old stored params with safe, bounded defaults", () => {
    const normalized = normalizeZoneParams({ seed: 7, lotSizeM: 0, occupancy: 4, facadeRate: -1 });
    expect(normalized.seed).toBe(7);
    expect(normalized.lotSizeM).toBeGreaterThan(0);
    expect(normalized.occupancy).toBe(1);
    expect(normalized.facadeRate).toBe(0);
    expect(normalized.massingWeights).toEqual(DEFAULT_ZONE_PARAMS.massingWeights);
    expect(normalized.wallWeights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(normalized.roofWeights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(normalized.neonWeights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
  });
});

describe("district identity generation", () => {
  it("repeats a preset build exactly, including selected family and neon controls", () => {
    const params = copyDistrictPreset("night-market")!;
    const first = specsFor(params);
    const second = specsFor(params);
    expect(second.map(specKey)).toEqual(first.map(specKey));
    expect(neonMesh(second, 1)).toEqual(neonMesh(first, 1));
  });

  it("applies occupancy at block granularity, preserving deliberate open blocks", () => {
    const source = copyDistrictPreset("residential-megablocks")!;
    const full = specsFor(normalizeZoneParams({ ...source, occupancy: 1 }));
    const empty = specsFor(normalizeZoneParams({ ...source, occupancy: 0 }));
    expect(full.length).toBeGreaterThan(0);
    expect(empty).toEqual([]);
  });

  it("makes the four presets observable in generated massing, heights, materials and neon", () => {
    const outputs = IDS.map((id) => {
      const params = copyDistrictPreset(id)!;
      const specs = specsFor(params);
      const mesh = neonMesh(specs, 1);
      const averageHeight = specs.reduce((sum, spec) => sum + spec.height, 0) / specs.length;
      const families = new Map<string, number>();
      for (const spec of specs) families.set(spec.massingFamily!, (families.get(spec.massingFamily!) ?? 0) + 1);
      const dominant = Object.entries(params.massingWeights).sort((a, b) => b[1] - a[1])[0]![0];
      return {
        params,
        specs,
        averageHeight,
        familySignature: [...families.keys()].sort().join(","),
        dominantFraction: (families.get(dominant) ?? 0) / specs.length,
        materialSignature: specs
          .map((spec) => `${spec.wallMaterial % BANK_SIZE}/${spec.roofMaterial % BANK_SIZE}`)
          .sort()
          .join(","),
        neonQuadCount: mesh.vertexCount / 4,
        neonSlots: neonMaterialSlots(mesh)
      };
    });

    expect(outputs.every((output) => output.specs.length > 0)).toBe(true);
    expect(new Set(outputs.map((output) => output.specs.length)).size).toBeGreaterThan(1);
    expect(new Set(outputs.map((output) => output.averageHeight.toFixed(5))).size).toBeGreaterThan(1);
    expect(new Set(outputs.map((output) => output.dominantFraction.toFixed(3))).size).toBeGreaterThan(1);
    expect(new Set(outputs.map((output) => output.materialSignature)).size).toBe(IDS.length);
    expect(new Set(outputs.map((output) => output.neonQuadCount)).size).toBeGreaterThan(1);
    expect(new Set(outputs.map((output) => output.neonSlots.join(","))).size).toBeGreaterThan(1);
    for (const output of outputs) expect(output.dominantFraction).toBeGreaterThan(0.25);
  });

  it("blends heights into deterministic coarse clusters when requested", () => {
    const source = copyDistrictPreset("residential-megablocks")!;
    const clustered = normalizeZoneParams({
      ...source,
      lotSizeM: 20,
      occupancy: 1,
      heightCluster: 1
    });
    const noisy = normalizeZoneParams({ ...clustered, heightCluster: 0 });
    const clusteredSpecs = specsFor(clustered);
    const noisySpecs = specsFor(noisy);

    const grouped = new Map<string, number[]>();
    for (const spec of clusteredSpecs) {
      const centre = ringCentroid(spec.footprint);
      const key = `${Math.floor(centre.x / 80)},${Math.floor(centre.y / 80)}`;
      const heights = grouped.get(key) ?? [];
      heights.push(spec.height);
      grouped.set(key, heights);
    }
    expect([...grouped.values()].some((heights) => heights.length > 1 && new Set(heights).size === 1)).toBe(true);
    expect(new Set(noisySpecs.map((spec) => spec.height)).size).toBeGreaterThan(
      new Set(clusteredSpecs.map((spec) => spec.height)).size
    );
  });

  it("keeps a neighbour unchanged when the other zone is reseeded or edited", () => {
    const west = copyDistrictPreset("corporate-core")!;
    const east = copyDistrictPreset("night-market")!;
    const westClip: MultiPolygon = [[rectRing({ x: 0, y: 0, width: 650, height: 1400 })]];
    const eastClip: MultiPolygon = [[rectRing({ x: 650, y: 0, width: 650, height: 1400 })]];
    const blocks: MultiPolygon = [[rectRing({ x: 0, y: 0, width: 1300, height: 1400 })]];
    const build = (eastParams: ZoneParams, eastSeed: number) =>
      buildingsForBlocks(
        blocks,
        [region(west, 7, westClip), region(eastParams, 11, eastClip, eastSeed)],
        FRAME
      );
    const before = build(east, east.seed);
    const reseeded = build(east, east.seed + 1);
    const edited = build(
      normalizeZoneParams({ ...east, occupancy: 0.15, massingWeights: { block: 1, podiumTower: 0, terraced: 0 } }),
      east.seed
    );
    const westSpecs = (specs: ReturnType<typeof buildingsForBlocks>) =>
      specs.filter((spec) => ringBounds(spec.footprint).x < 650).map(specKey);
    expect(westSpecs(before)).toEqual(westSpecs(reseeded));
    expect(westSpecs(before)).toEqual(westSpecs(edited));
    expect(reseeded.map(specKey)).not.toEqual(before.map(specKey));
    expect(edited.map(specKey)).not.toEqual(before.map(specKey));
    expect(new Set(before.filter((spec) => Math.floor(spec.wallMaterial / BANK_SIZE) === 7).map((spec) => spec.wallMaterial))).toEqual(
      new Set(reseeded.filter((spec) => Math.floor(spec.wallMaterial / BANK_SIZE) === 7).map((spec) => spec.wallMaterial))
    );
  });

  it("honours weighted family and material controls independently of the preset values", () => {
    const source = copyDistrictPreset("industrial-utility")!;
    const params = normalizeZoneParams({
      ...source,
      occupancy: 1,
      massingWeights: { block: 1, podiumTower: 0, terraced: 0 },
      wallWeights: [1, 0, 0],
      roofWeights: [0, 1, 0]
    });
    const specs = specsFor(params, 13);
    expect(specs.every((spec) => spec.massingFamily === "block")).toBe(true);
    expect(specs.every((spec) => spec.wallMaterial % BANK_SIZE === DISTRICT_SLOT.WALL_A)).toBe(true);
    expect(specs.every((spec) => spec.roofMaterial % BANK_SIZE === DISTRICT_SLOT.ROOF_B)).toBe(true);

    const neon = neonMesh(
      specs.map((spec) => ({ ...spec, facadeRate: 1, poolRate: 0, neonWeights: [1, 0] as const })),
      1
    );
    expect(neon.vertexCount).toBeGreaterThan(0);
    expect(new Set(neonMaterialSlots(neon))).toEqual(new Set([DISTRICT_SLOT.NEON_A]));
  });

  it("keeps chunk partitioning equivalent after applying a district preset", () => {
    const origin = { x: 5000, y: 4000 };
    const params = {
      ...demoCity(origin),
      zones: [
        {
          ...copyDistrictPreset("industrial-utility")!,
          id: "z1",
          bank: 9,
          rect: { x: -130, y: -90, width: 90, height: 180 }
        }
      ]
    };
    const pixelsPerMetre = 25;
    const boundsM = cityBounds(params, 20)!;
    const px = cityToPixels(params, pixelsPerMetre);
    const boundsPx = rectToPixels(boundsM, origin, pixelsPerMetre);
    const surfaces = buildRoadSurfaces(px.graph, boundsPx, pixelsPerMetre);
    const whole = buildingsForBlocks(
      surfaces.blocks,
      lotRegions(params.base, px.zones, boundsPx, pixelsPerMetre, origin),
      { originPx: origin, pixelsPerMetre }
    );
    const chunks = cityChunks(boundsM).map((key) => buildChunk(params, key, boundsM, pixelsPerMetre));
    const fromChunks = chunks.flatMap((chunk) => chunk.buildings);
    expect(fromChunks.map(specKey).sort()).toEqual(whole.map(specKey).sort());
    expect(fromChunks.every((spec) => Math.floor(spec.wallMaterial / BANK_SIZE) === 9 || Math.floor(spec.wallMaterial / BANK_SIZE) === 1)).toBe(true);
  });
});
