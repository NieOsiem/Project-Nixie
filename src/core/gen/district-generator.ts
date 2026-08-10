import { union, ringAsMulti } from "../geom/boolean.js";
import { ringArea, ringBounds, ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV3, type DistrictSource } from "./city.js";
import { validateDistrictCandidates } from "./district-edit.js";
import { buildDistrictPlan, type DerivedBlock } from "./district-plan.js";
import { DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "./district-registry.js";
import { validateRing } from "./terrain.js";

export interface DistrictGenerationAvailability {
  available: boolean;
  reason: string | null;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function stableId(prefix: string, material: string): string {
  return `${prefix}_${fnv1a(material).toString(16).padStart(8, "0")}`;
}

function vehicleRoadCount(source: CitySourceV3): number {
  return source.roads.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle).length;
}

export function districtGenerationAvailability(source: CitySourceV3): DistrictGenerationAvailability {
  if (source.districts.length > 0) return { available: false, reason: "Initial district generation requires an empty district source." };
  if (source.generation.districtPool.length === 0) return { available: false, reason: "Initial district generation requires a non-empty district pool." };
  if (vehicleRoadCount(source) === 0) return { available: false, reason: "Initial district generation requires a vehicle-road network." };
  const terrainValidation = validateRing(source.terrain.urbanFootprint ?? source.terrain.land);
  if (!terrainValidation.ok) return { available: false, reason: terrainValidation.reason };
  return { available: true, reason: null };
}

function adjacency(blocks: readonly DerivedBlock[]): Map<string, string[]> {
  const roadBlocks = new Map<string, string[]>();
  for (const block of blocks) for (const roadId of block.boundaryRoadIds) roadBlocks.set(roadId, [...(roadBlocks.get(roadId) ?? []), block.id]);
  const adjacent = new Map(blocks.map((block) => [block.id, new Set<string>()]));
  for (const ids of roadBlocks.values()) {
    const ordered = [...new Set(ids)].sort();
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      adjacent.get(ordered[i]!)?.add(ordered[j]!);
      adjacent.get(ordered[j]!)?.add(ordered[i]!);
    }
  }
  return new Map([...adjacent.entries()].map(([id, values]) => [id, [...values].sort()]));
}

function components(blocks: readonly DerivedBlock[], adjacent: ReadonlyMap<string, readonly string[]>): string[][] {
  const unseen = new Set(blocks.map((block) => block.id));
  const output: string[][] = [];
  while (unseen.size > 0) {
    const first = [...unseen].sort()[0]!;
    unseen.delete(first);
    const queue = [first];
    const component: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      component.push(id);
      for (const next of adjacent.get(id) ?? []) if (unseen.delete(next)) queue.push(next);
    }
    output.push(component.sort());
  }
  return output.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function seedBlocks(component: readonly string[], citySeed: string): string[] {
  const preferred = component.length >= 4 ? Math.max(2, Math.ceil(component.length / 4)) : 1;
  const count = Math.max(1, Math.min(component.length, preferred, 8));
  return [...component]
    .sort((a, b) => fnv1a(`${citySeed}/districts/v3/seed-face/${a}`) - fnv1a(`${citySeed}/districts/v3/seed-face/${b}`) || a.localeCompare(b))
    .slice(0, count)
    .sort();
}

function growRegions(
  blocks: readonly DerivedBlock[],
  component: readonly string[],
  adjacent: ReadonlyMap<string, readonly string[]>,
  citySeed: string
): string[][] {
  const seeds = seedBlocks(component, citySeed);
  const owner = new Map<string, string>();
  const regions = new Map<string, string[]>();
  const queue: { blockId: string; seedId: string; depth: number }[] = seeds.map((seedId) => ({ blockId: seedId, seedId, depth: 0 }));
  queue.sort((a, b) => a.seedId.localeCompare(b.seedId));
  while (queue.length > 0) {
    queue.sort((a, b) => a.depth - b.depth || fnv1a(`${citySeed}/districts/v3/growth/${a.seedId}/${a.blockId}`) - fnv1a(`${citySeed}/districts/v3/growth/${b.seedId}/${b.blockId}`) || a.seedId.localeCompare(b.seedId));
    const current = queue.shift()!;
    if (owner.has(current.blockId)) continue;
    const candidate = [...(regions.get(current.seedId) ?? []), current.blockId].sort();
    if (regionPolygon(blocks, candidate) === null) continue;
    owner.set(current.blockId, current.seedId);
    regions.set(current.seedId, candidate);
    for (const next of adjacent.get(current.blockId) ?? []) if (!owner.has(next)) queue.push({ blockId: next, seedId: current.seedId, depth: current.depth + 1 });
  }
  return [...regions.values()].map((ids) => ids.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function regionPolygon(blocks: readonly DerivedBlock[], blockIds: readonly string[]): Ring | null {
  const ids = new Set(blockIds);
  const result = union(blocks.filter((block) => ids.has(block.id)).map((block) => ringAsMulti(block.zoningFace)));
  if (result.length !== 1 || result[0]!.length !== 1) return null;
  const ring = result[0]![0]!;
  return Math.abs(ringArea(ring)) >= 1 ? ring : null;
}

export function resolveGeneratedRegions(
  blocks: readonly DerivedBlock[],
  input: readonly (readonly string[])[],
  adjacent: ReadonlyMap<string, readonly string[]>,
  citySeed: string
): string[][] {
  const regions = input.map((region) => [...new Set(region)].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
  for (let attempt = 0; attempt < blocks.length && regions.some((region) => regionPolygon(blocks, region) === null); attempt++) {
    const invalidIndex = regions.findIndex((region) => regionPolygon(blocks, region) === null);
    const invalid = regions[invalidIndex]!;
    const candidates = regions
      .map((region, index) => ({ region, index }))
      .filter(({ region, index }) => index !== invalidIndex && invalid.some((id) => (adjacent.get(id) ?? []).some((next) => region.includes(next))))
      .map(({ region, index }) => ({ region, index, merged: [...new Set([...invalid, ...region])].sort() }))
      .filter(({ merged }) => regionPolygon(blocks, merged) !== null)
      .sort((left, right) =>
        fnv1a(`${citySeed}/districts/v3/hole-cleanup/${invalid.join(",")}/${left.region.join(",")}`) - fnv1a(`${citySeed}/districts/v3/hole-cleanup/${invalid.join(",")}/${right.region.join(",")}`) ||
        left.region[0]!.localeCompare(right.region[0]!)
      );
    const target = candidates[0];
    if (target === undefined) throw new Error(`Generated district region "${invalid.join(",")}" could not be resolved without a hole.`);
    const remove = [invalidIndex, target.index].sort((a, b) => b - a);
    for (const index of remove) regions.splice(index, 1);
    regions.push(target.merged);
    regions.sort((a, b) => a[0]!.localeCompare(b[0]!));
  }
  const invalid = regions.find((region) => regionPolygon(blocks, region) === null);
  if (invalid !== undefined) throw new Error(`Generated district region "${invalid.join(",")}" could not be resolved without a hole.`);
  return regions;
}

function enabledPool(source: CitySourceV3): DistrictTypeId[] {
  const seen = new Set<DistrictTypeId>();
  const pool: DistrictTypeId[] = [];
  for (const id of source.generation.districtPool) {
    if (!DISTRICT_TYPE_REGISTRY.has(id) || seen.has(id)) continue;
    seen.add(id);
    pool.push(id);
  }
  return pool;
}

export interface DistrictRegionContext {
  hubProximity: number;
  hierarchy: number;
  waterfront: number;
  areaShare: number;
  elongation: number;
  peripheral: number;
}

const ROAD_HIERARCHY = { highway: 1, arterial: 0.85, street: 0.58, narrow: 0.42, lane: 0.3, alley: 0.2 } as const;

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hubs(source: CitySourceV3, bounds: ReturnType<typeof ringBounds>): Vec2[] {
  if (source.generation.hubMode === "single-centre") return [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }];
  return Array.from({ length: 3 }, (_, index) => ({
    x: bounds.x + bounds.width * (0.2 + hashUnit(`${source.citySeed}/districts/v3/hub/${index}/x`) * 0.6),
    y: bounds.y + bounds.height * (0.2 + hashUnit(`${source.citySeed}/districts/v3/hub/${index}/y`) * 0.6)
  }));
}

function hashUnit(text: string): number {
  return fnv1a(text) / 0x1_0000_0000;
}

export function districtRegionContext(source: CitySourceV3, blocks: readonly DerivedBlock[], polygon: Ring): DistrictRegionContext {
  const mask = source.terrain.urbanFootprint ?? source.terrain.land;
  const maskBounds = ringBounds(mask);
  const regionBounds = ringBounds(polygon);
  const centre = ringCentroid(polygon);
  const diagonal = Math.max(1, Math.hypot(maskBounds.width, maskBounds.height));
  const nearestHub = Math.min(...hubs(source, maskBounds).map((hub) => distance(centre, hub)));
  const edgeById = new Map(source.roads.edges.map((edge) => [edge.id, edge]));
  let hierarchy = 0;
  for (const block of blocks) for (const id of block.boundaryRoadIds) {
    const edge = edgeById.get(id);
    if (edge && Object.hasOwn(ROAD_HIERARCHY, edge.classId)) hierarchy = Math.max(hierarchy, ROAD_HIERARCHY[edge.classId as keyof typeof ROAD_HIERARCHY]);
  }
  let waterfront = 0;
  if (source.generation.terrainMode === "coastal" && source.generation.coastEdge) {
    const edgeDistance = source.generation.coastEdge === "north" ? centre.y - maskBounds.y
      : source.generation.coastEdge === "south" ? maskBounds.y + maskBounds.height - centre.y
        : source.generation.coastEdge === "west" ? centre.x - maskBounds.x
          : maskBounds.x + maskBounds.width - centre.x;
    const span = source.generation.coastEdge === "north" || source.generation.coastEdge === "south" ? maskBounds.height : maskBounds.width;
    waterfront = Math.max(0, 1 - edgeDistance / Math.max(1, span * 0.35));
  }
  const polygonArea = Math.abs(ringArea(polygon));
  const maskArea = Math.max(1, Math.abs(ringArea(mask)));
  const short = Math.max(1, Math.min(regionBounds.width, regionBounds.height));
  const long = Math.max(regionBounds.width, regionBounds.height);
  const hubProximity = Math.max(0, 1 - nearestHub / (diagonal * 0.55));
  return {
    hubProximity,
    hierarchy,
    waterfront,
    areaShare: Math.min(1, polygonArea / Math.max(1, maskArea * 0.2)),
    elongation: Math.min(1, Math.max(0, long / short - 1) / 4),
    peripheral: 1 - hubProximity
  };
}

function contextualMultiplier(typeId: DistrictTypeId, context: DistrictRegionContext): number {
  switch (typeId) {
    case "corporate-core": return 0.75 + context.hubProximity * 0.9 + context.hierarchy * 0.45 + context.areaShare * 0.2;
    case "commercial-highrise": return 0.8 + context.hubProximity * 0.7 + context.hierarchy * 0.55;
    case "mixed-use-centre": return 0.9 + context.hubProximity * 0.45 + context.hierarchy * 0.35;
    case "waterfront": return 0.65 + context.waterfront * 1.5 + context.elongation * 0.2;
    case "logistics-port": return 0.55 + context.waterfront * 1.1 + context.hierarchy * 0.35 + context.areaShare * 0.35;
    case "heavy-industrial": return 0.7 + context.peripheral * 0.6 + context.areaShare * 0.55;
    case "light-industrial": return 0.8 + context.peripheral * 0.35 + context.hierarchy * 0.25;
    case "utility-infrastructure": return 0.7 + context.peripheral * 0.45 + context.areaShare * 0.3;
    case "night-market": return 0.75 + context.hubProximity * 0.35 + context.hierarchy * 0.45 - context.areaShare * 0.15;
    case "entertainment-strip": return 0.75 + context.hierarchy * 0.55 + context.elongation * 0.45;
    case "residential-megablocks": return 0.75 + context.areaShare * 0.65 + context.peripheral * 0.25;
    case "dense-residential": return 0.9 + context.hubProximity * 0.25 - context.areaShare * 0.1;
    case "low-rise-residential": return 0.85 + context.peripheral * 0.55 - context.hierarchy * 0.15;
    case "old-city": return 0.85 + context.elongation * 0.2 + context.hubProximity * 0.2;
    case "civic-institutional": return 0.75 + context.hubProximity * 0.35 + context.areaShare * 0.35;
    case "derelict-reclamation": return 0.75 + context.peripheral * 0.65 + context.elongation * 0.25;
  }
}

function chooseDistrictType(
  source: CitySourceV3,
  blocks: readonly DerivedBlock[],
  polygon: Ring,
  lineage: string,
  pool: readonly DistrictTypeId[],
  counts: ReadonlyMap<DistrictTypeId, number>
): DistrictTypeId {
  const context = districtRegionContext(source, blocks, polygon);
  let winner = pool[0]!;
  let best = -Infinity;
  for (let index = 0; index < pool.length; index++) {
    const id = pool[index]!;
    const randomness = 0.88 + hashUnit(`${source.citySeed}/districts/v3/type/${lineage}/${id}`) * 0.24;
    const diversity = 1 / (1 + (counts.get(id) ?? 0) * 0.85);
    const score = contextualMultiplier(id, context) * randomness * diversity;
    if (score > best) {
      best = score;
      winner = id;
    }
  }
  return winner;
}

export function generateInitialDistricts(source: CitySourceV3): DistrictSource[] {
  const availability = districtGenerationAvailability(source);
  if (!availability.available) throw new Error(availability.reason ?? "Initial district generation is unavailable.");
  const plan = buildDistrictPlan(source);
  if (plan.blocks.length === 0) throw new Error("Initial district generation found no usable road-defined blocks.");
  const byId = new Map(plan.blocks.map((block) => [block.id, block]));
  const adjacent = adjacency(plan.blocks);
  const grown = components(plan.blocks, adjacent).flatMap((component) => growRegions(plan.blocks, component, adjacent, source.citySeed));
  const regions = resolveGeneratedRegions(plan.blocks, grown, adjacent, source.citySeed);
  const pool = enabledPool(source);
  if (pool.length === 0) throw new Error("Initial district generation has no valid enabled district types.");
  const districts: DistrictSource[] = [];
  const typeCounts = new Map<DistrictTypeId, number>();
  for (const region of regions) {
    const regionBlocks = region.map((id) => byId.get(id)!).filter(Boolean);
    const polygon = regionPolygon(regionBlocks, region);
    if (!polygon) throw new Error(`Generated district region "${region.join(",")}" is invalid.`);
    const lineage = region.join(",");
    const typeId = chooseDistrictType(source, regionBlocks, polygon, lineage, pool, typeCounts);
    typeCounts.set(typeId, (typeCounts.get(typeId) ?? 0) + 1);
    const definition = DISTRICT_TYPE_REGISTRY.get(typeId)!;
    districts.push({
      id: stableId("district", `${source.citySeed}/districts/v3/id/${lineage}`),
      polygon,
      seed: stableId("seed", `${source.citySeed}/districts/v3/seed/${lineage}`),
      typeId,
      paletteId: definition.defaultPaletteId,
      origin: "generated",
      locked: false,
      openSpaceOverride: null
    });
  }
  districts.sort((a, b) => a.id.localeCompare(b.id));
  validateDistrictCandidates({ ...source, districts }, districts);
  buildDistrictPlan({ ...source, districts });
  return districts;
}
