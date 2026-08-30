import { union, ringAsMulti } from "../geom/boolean.js";
import { ringArea, ringBounds, ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV4, type DistrictSource } from "./city.js";
import { validateDistrictCandidates } from "./district-edit.js";
import { buildDistrictPlan, type DerivedBlock } from "./district-plan.js";
import { DISTRICT_TYPE_REGISTRY, type DistrictTypeId } from "./district-registry.js";
import { LANDMARK_GRAMMAR_REGISTRY, type LandmarkGrammarId } from "./landmark-registry.js";
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

function vehicleRoadCount(source: CitySourceV4): number {
  return source.roads.edges.filter((edge) => ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle).length;
}

export function districtGenerationAvailability(source: CitySourceV4): DistrictGenerationAvailability {
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

function seedBlocks(
  blocks: readonly DerivedBlock[],
  component: readonly string[],
  source: CitySourceV4
): string[] {
  const preferred = component.length >= 4 ? Math.max(2, Math.ceil(component.length / 4)) : 1;
  const count = Math.max(1, Math.min(component.length, preferred, 8));
  if (count <= 1 || component.length <= 1) {
    return [...component]
      .sort((a, b) => fnv1a(`${source.citySeed}/districts/v3/seed-face/${a}`) - fnv1a(`${source.citySeed}/districts/v3/seed-face/${b}`) || a.localeCompare(b))
      .slice(0, count)
      .sort();
  }

  const blockMap = new Map(blocks.map((b) => [b.id, b]));
  const mask = source.terrain.urbanFootprint ?? source.terrain.land;
  const maskBounds = ringBounds(mask);
  const cityHubs = hubs(source, maskBounds);
  const diagonal = Math.max(1, Math.hypot(maskBounds.width, maskBounds.height));
  const edgeById = new Map(source.roads.edges.map((edge) => [edge.id, edge]));

  const blockMetrics = new Map<string, { centroid: Vec2; centrality: number; peripheral: number; waterfront: number }>();
  for (const id of component) {
    const block = blockMap.get(id);
    if (!block) continue;
    const centroid = ringCentroid(block.zoningFace);
    const minHubDist = Math.min(...cityHubs.map((hub) => distance(centroid, hub)));
    const hubProx = Math.max(0, 1 - minHubDist / (diagonal * 0.55));
    let hierarchy = 0;
    for (const rId of block.boundaryRoadIds) {
      const edge = edgeById.get(rId);
      if (edge && Object.hasOwn(ROAD_HIERARCHY, edge.classId)) {
        hierarchy = Math.max(hierarchy, ROAD_HIERARCHY[edge.classId as keyof typeof ROAD_HIERARCHY]);
      }
    }
    let waterfront = 0;
    if (source.generation.terrainMode === "coastal" && source.generation.coastEdge) {
      const edgeDistance = source.generation.coastEdge === "north" ? centroid.y - maskBounds.y
        : source.generation.coastEdge === "south" ? maskBounds.y + maskBounds.height - centroid.y
          : source.generation.coastEdge === "west" ? centroid.x - maskBounds.x
            : maskBounds.x + maskBounds.width - centroid.x;
      const span = source.generation.coastEdge === "north" || source.generation.coastEdge === "south" ? maskBounds.height : maskBounds.width;
      waterfront = Math.max(0, 1 - edgeDistance / Math.max(1, span * 0.35));
    }
    blockMetrics.set(id, {
      centroid,
      centrality: hubProx * 1.6 + hierarchy * 0.8,
      peripheral: 1 - hubProx,
      waterfront
    });
  }

  const candidates = [...component].sort((a, b) => {
    const mA = blockMetrics.get(a);
    const mB = blockMetrics.get(b);
    const scoreA = (mA ? mA.centrality : 0) + hashUnit(`${source.citySeed}/districts/v3/seed-central/${a}`) * 0.3;
    const scoreB = (mB ? mB.centrality : 0) + hashUnit(`${source.citySeed}/districts/v3/seed-central/${b}`) * 0.3;
    return scoreB - scoreA || a.localeCompare(b);
  });

  const selected: string[] = [candidates[0]!];
  const selectedCentroids: Vec2[] = [blockMetrics.get(candidates[0]!)?.centroid ?? { x: 0, y: 0 }];

  while (selected.length < count) {
    const remaining = component.filter((id) => !selected.includes(id));
    if (remaining.length === 0) break;
    let bestId = remaining[0]!;
    let bestScore = -Infinity;

    for (const id of remaining) {
      const metric = blockMetrics.get(id);
      if (!metric) continue;
      const minDist = Math.min(...selectedCentroids.map((c) => distance(metric.centroid, c)));
      const normDist = minDist / diagonal;
      const roleBonus = (selected.length === 1 && source.generation.terrainMode === "coastal")
        ? metric.waterfront * 0.8 + metric.peripheral * 0.4
        : metric.peripheral * 0.5 + metric.centrality * 0.3;
      const hashNoise = hashUnit(`${source.citySeed}/districts/v3/seed-tier/${selected.length}/${id}`) * 0.25;
      const score = normDist * 2.0 + roleBonus + hashNoise;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    selected.push(bestId);
    selectedCentroids.push(blockMetrics.get(bestId)?.centroid ?? { x: 0, y: 0 });
  }

  return selected.sort();
}

function growRegions(
  blocks: readonly DerivedBlock[],
  component: readonly string[],
  adjacent: ReadonlyMap<string, readonly string[]>,
  citySeed: string,
  source: CitySourceV4
): string[][] {
  const seeds = seedBlocks(blocks, component, source);
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

function enabledPool(source: CitySourceV4): DistrictTypeId[] {
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

function hubs(source: CitySourceV4, bounds: ReturnType<typeof ringBounds>): Vec2[] {
  if (source.generation.hubMode === "single-centre") return [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }];
  return Array.from({ length: 3 }, (_, index) => ({
    x: bounds.x + bounds.width * (0.2 + hashUnit(`${source.citySeed}/districts/v3/hub/${index}/x`) * 0.6),
    y: bounds.y + bounds.height * (0.2 + hashUnit(`${source.citySeed}/districts/v3/hub/${index}/y`) * 0.6)
  }));
}

function hashUnit(text: string): number {
  return fnv1a(text) / 0x1_0000_0000;
}

export function districtRegionContext(source: CitySourceV4, blocks: readonly DerivedBlock[], polygon: Ring): DistrictRegionContext {
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
    case "corporate-core":
      return Math.max(0.1, 0.40 + context.hubProximity * 1.50 + context.hierarchy * 0.65 + context.areaShare * 0.20 - context.peripheral * 0.70);
    case "commercial-highrise":
      return Math.max(0.1, 0.50 + context.hubProximity * 1.20 + context.hierarchy * 0.70 - context.peripheral * 0.40);
    case "mixed-use-centre":
      return Math.max(0.1, 0.65 + context.hubProximity * 0.80 + context.hierarchy * 0.45 + (1 - Math.abs(context.hubProximity - 0.60)) * 0.35);
    case "civic-institutional":
      return Math.max(0.1, 0.55 + context.hubProximity * 0.75 + context.areaShare * 0.50 + context.hierarchy * 0.35);
    case "dense-residential":
      return Math.max(0.1, 0.70 + context.hubProximity * 0.50 + (1 - Math.abs(context.hubProximity - 0.55)) * 0.45 - context.peripheral * 0.20);
    case "residential-megablocks":
      return Math.max(0.1, 0.60 + context.areaShare * 0.75 + context.peripheral * 0.50 + (1 - Math.abs(context.peripheral - 0.50)) * 0.30);
    case "low-rise-residential":
      return Math.max(0.1, 0.65 + context.peripheral * 0.90 - context.hierarchy * 0.30 - context.hubProximity * 0.40);
    case "waterfront":
      return Math.max(0.1, 0.40 + context.waterfront * 2.10 + context.elongation * 0.35);
    case "logistics-port":
      return Math.max(0.1, 0.30 + context.waterfront * 1.50 + context.peripheral * 0.70 + context.hierarchy * 0.40 + context.areaShare * 0.30);
    case "heavy-industrial":
      return Math.max(0.1, 0.40 + context.peripheral * 1.40 + context.areaShare * 0.55 - context.hubProximity * 0.75);
    case "light-industrial":
      return Math.max(0.1, 0.60 + context.peripheral * 0.85 + context.hierarchy * 0.35 - context.hubProximity * 0.25);
    case "utility-infrastructure":
      return Math.max(0.1, 0.45 + context.peripheral * 1.10 + context.areaShare * 0.40 - context.hubProximity * 0.50);
    case "entertainment-strip":
      return Math.max(0.1, 0.55 + context.hierarchy * 0.75 + context.elongation * 0.60 + context.hubProximity * 0.35);
    case "night-market":
      return Math.max(0.1, 0.65 + context.hubProximity * 0.50 + context.hierarchy * 0.40 + (1 - context.areaShare) * 0.30);
    case "old-city":
      return Math.max(0.1, 0.65 + context.hubProximity * 0.45 + context.elongation * 0.35 + (1 - context.hierarchy) * 0.25);
    case "derelict-reclamation":
      return Math.max(0.1, 0.50 + context.peripheral * 0.95 + context.elongation * 0.35 - context.hubProximity * 0.35);
  }
}

const ADJACENCY_AFFINITIES: Readonly<Record<DistrictTypeId, Partial<Record<DistrictTypeId, number>>>> = {
  "corporate-core": {
    "corporate-core": 1.25,
    "commercial-highrise": 1.50,
    "mixed-use-centre": 1.40,
    "civic-institutional": 1.45,
    "dense-residential": 1.20,
    "entertainment-strip": 1.25,
    "waterfront": 1.30,
    "old-city": 1.10,
    "night-market": 1.05,
    "residential-megablocks": 0.80,
    "low-rise-residential": 0.55,
    "light-industrial": 0.60,
    "logistics-port": 0.60,
    "utility-infrastructure": 0.50,
    "derelict-reclamation": 0.45,
    "heavy-industrial": 0.35
  },
  "commercial-highrise": {
    "corporate-core": 1.50,
    "commercial-highrise": 1.25,
    "mixed-use-centre": 1.50,
    "entertainment-strip": 1.45,
    "dense-residential": 1.35,
    "civic-institutional": 1.35,
    "waterfront": 1.35,
    "night-market": 1.25,
    "old-city": 1.15,
    "residential-megablocks": 0.90,
    "low-rise-residential": 0.65,
    "light-industrial": 0.70,
    "logistics-port": 0.70,
    "utility-infrastructure": 0.55,
    "derelict-reclamation": 0.50,
    "heavy-industrial": 0.40
  },
  "mixed-use-centre": {
    "corporate-core": 1.40,
    "commercial-highrise": 1.50,
    "mixed-use-centre": 1.20,
    "dense-residential": 1.45,
    "entertainment-strip": 1.40,
    "night-market": 1.45,
    "old-city": 1.35,
    "waterfront": 1.35,
    "civic-institutional": 1.35,
    "residential-megablocks": 1.20,
    "low-rise-residential": 0.90,
    "light-industrial": 0.80,
    "logistics-port": 0.75,
    "derelict-reclamation": 0.60,
    "utility-infrastructure": 0.60,
    "heavy-industrial": 0.45
  },
  "civic-institutional": {
    "corporate-core": 1.45,
    "commercial-highrise": 1.35,
    "mixed-use-centre": 1.35,
    "civic-institutional": 1.15,
    "dense-residential": 1.30,
    "residential-megablocks": 1.20,
    "old-city": 1.25,
    "waterfront": 1.25,
    "low-rise-residential": 1.10,
    "entertainment-strip": 1.05,
    "night-market": 1.00,
    "light-industrial": 0.70,
    "utility-infrastructure": 0.65,
    "logistics-port": 0.60,
    "derelict-reclamation": 0.50,
    "heavy-industrial": 0.40
  },
  "dense-residential": {
    "mixed-use-centre": 1.45,
    "commercial-highrise": 1.35,
    "residential-megablocks": 1.35,
    "dense-residential": 1.20,
    "civic-institutional": 1.30,
    "night-market": 1.35,
    "old-city": 1.30,
    "entertainment-strip": 1.25,
    "waterfront": 1.30,
    "low-rise-residential": 1.20,
    "corporate-core": 1.20,
    "light-industrial": 0.80,
    "derelict-reclamation": 0.65,
    "utility-infrastructure": 0.60,
    "logistics-port": 0.65,
    "heavy-industrial": 0.40
  },
  "residential-megablocks": {
    "dense-residential": 1.35,
    "residential-megablocks": 1.20,
    "low-rise-residential": 1.35,
    "mixed-use-centre": 1.20,
    "civic-institutional": 1.20,
    "night-market": 1.15,
    "waterfront": 1.15,
    "light-industrial": 0.95,
    "old-city": 1.05,
    "entertainment-strip": 1.00,
    "commercial-highrise": 0.90,
    "utility-infrastructure": 0.80,
    "derelict-reclamation": 0.75,
    "logistics-port": 0.70,
    "corporate-core": 0.80,
    "heavy-industrial": 0.50
  },
  "low-rise-residential": {
    "low-rise-residential": 1.25,
    "residential-megablocks": 1.35,
    "dense-residential": 1.20,
    "civic-institutional": 1.10,
    "old-city": 1.10,
    "waterfront": 1.15,
    "light-industrial": 1.05,
    "night-market": 1.00,
    "mixed-use-centre": 0.90,
    "derelict-reclamation": 0.85,
    "utility-infrastructure": 0.80,
    "entertainment-strip": 0.80,
    "logistics-port": 0.65,
    "commercial-highrise": 0.65,
    "heavy-industrial": 0.50,
    "corporate-core": 0.55
  },
  "heavy-industrial": {
    "heavy-industrial": 1.40,
    "light-industrial": 1.45,
    "utility-infrastructure": 1.50,
    "logistics-port": 1.45,
    "derelict-reclamation": 1.35,
    "low-rise-residential": 0.50,
    "residential-megablocks": 0.50,
    "dense-residential": 0.40,
    "mixed-use-centre": 0.45,
    "night-market": 0.45,
    "old-city": 0.40,
    "entertainment-strip": 0.45,
    "commercial-highrise": 0.40,
    "waterfront": 0.70,
    "civic-institutional": 0.40,
    "corporate-core": 0.35
  },
  "light-industrial": {
    "light-industrial": 1.30,
    "heavy-industrial": 1.45,
    "utility-infrastructure": 1.45,
    "logistics-port": 1.40,
    "derelict-reclamation": 1.35,
    "low-rise-residential": 1.05,
    "residential-megablocks": 0.95,
    "mixed-use-centre": 0.80,
    "dense-residential": 0.80,
    "waterfront": 0.85,
    "night-market": 0.75,
    "entertainment-strip": 0.70,
    "commercial-highrise": 0.70,
    "civic-institutional": 0.70,
    "old-city": 0.65,
    "corporate-core": 0.60
  },
  "logistics-port": {
    "logistics-port": 1.35,
    "waterfront": 1.40,
    "heavy-industrial": 1.45,
    "light-industrial": 1.40,
    "utility-infrastructure": 1.40,
    "derelict-reclamation": 1.25,
    "commercial-highrise": 0.70,
    "mixed-use-centre": 0.75,
    "low-rise-residential": 0.65,
    "residential-megablocks": 0.70,
    "dense-residential": 0.65,
    "entertainment-strip": 0.75,
    "night-market": 0.70,
    "civic-institutional": 0.60,
    "corporate-core": 0.60,
    "old-city": 0.60
  },
  "waterfront": {
    "waterfront": 1.25,
    "commercial-highrise": 1.35,
    "mixed-use-centre": 1.35,
    "dense-residential": 1.30,
    "entertainment-strip": 1.35,
    "logistics-port": 1.40,
    "corporate-core": 1.30,
    "civic-institutional": 1.25,
    "night-market": 1.25,
    "old-city": 1.20,
    "residential-megablocks": 1.15,
    "low-rise-residential": 1.15,
    "light-industrial": 0.85,
    "derelict-reclamation": 0.80,
    "utility-infrastructure": 0.70,
    "heavy-industrial": 0.70
  },
  "utility-infrastructure": {
    "utility-infrastructure": 1.30,
    "heavy-industrial": 1.50,
    "light-industrial": 1.45,
    "logistics-port": 1.40,
    "derelict-reclamation": 1.30,
    "low-rise-residential": 0.80,
    "residential-megablocks": 0.80,
    "mixed-use-centre": 0.60,
    "dense-residential": 0.60,
    "civic-institutional": 0.65,
    "commercial-highrise": 0.55,
    "corporate-core": 0.50,
    "night-market": 0.55,
    "entertainment-strip": 0.55,
    "old-city": 0.50,
    "waterfront": 0.70
  },
  "entertainment-strip": {
    "entertainment-strip": 1.20,
    "commercial-highrise": 1.45,
    "mixed-use-centre": 1.40,
    "night-market": 1.45,
    "dense-residential": 1.25,
    "waterfront": 1.35,
    "corporate-core": 1.25,
    "old-city": 1.25,
    "civic-institutional": 1.05,
    "residential-megablocks": 1.00,
    "low-rise-residential": 0.80,
    "light-industrial": 0.70,
    "logistics-port": 0.75,
    "derelict-reclamation": 0.65,
    "utility-infrastructure": 0.55,
    "heavy-industrial": 0.45
  },
  "night-market": {
    "night-market": 1.15,
    "mixed-use-centre": 1.45,
    "entertainment-strip": 1.45,
    "dense-residential": 1.35,
    "old-city": 1.40,
    "commercial-highrise": 1.25,
    "waterfront": 1.25,
    "residential-megablocks": 1.15,
    "civic-institutional": 1.00,
    "corporate-core": 1.05,
    "low-rise-residential": 1.00,
    "light-industrial": 0.75,
    "derelict-reclamation": 0.75,
    "logistics-port": 0.70,
    "utility-infrastructure": 0.55,
    "heavy-industrial": 0.45
  },
  "old-city": {
    "old-city": 1.20,
    "mixed-use-centre": 1.35,
    "night-market": 1.40,
    "dense-residential": 1.30,
    "civic-institutional": 1.25,
    "entertainment-strip": 1.25,
    "waterfront": 1.20,
    "commercial-highrise": 1.15,
    "low-rise-residential": 1.10,
    "corporate-core": 1.10,
    "residential-megablocks": 1.05,
    "derelict-reclamation": 0.85,
    "light-industrial": 0.65,
    "utility-infrastructure": 0.50,
    "logistics-port": 0.60,
    "heavy-industrial": 0.40
  },
  "derelict-reclamation": {
    "derelict-reclamation": 1.20,
    "heavy-industrial": 1.35,
    "light-industrial": 1.35,
    "utility-infrastructure": 1.30,
    "logistics-port": 1.25,
    "low-rise-residential": 0.85,
    "old-city": 0.85,
    "waterfront": 0.80,
    "night-market": 0.75,
    "residential-megablocks": 0.75,
    "dense-residential": 0.65,
    "entertainment-strip": 0.65,
    "mixed-use-centre": 0.60,
    "commercial-highrise": 0.50,
    "civic-institutional": 0.50,
    "corporate-core": 0.45
  }
};

function getAdjacencyAffinity(a: DistrictTypeId, b: DistrictTypeId): number {
  return ADJACENCY_AFFINITIES[a]?.[b] ?? ADJACENCY_AFFINITIES[b]?.[a] ?? 1.0;
}

const RESIDENTIAL_TYPES = new Set<DistrictTypeId>([
  "low-rise-residential",
  "dense-residential",
  "residential-megablocks"
]);

const INDUSTRIAL_TYPES = new Set<DistrictTypeId>([
  "heavy-industrial",
  "light-industrial",
  "logistics-port",
  "utility-infrastructure"
]);

export function generateInitialDistricts(source: CitySourceV4): DistrictSource[] {
  const availability = districtGenerationAvailability(source);
  if (!availability.available) throw new Error(availability.reason ?? "Initial district generation is unavailable.");
  const plan = buildDistrictPlan(source);
  if (plan.blocks.length === 0) throw new Error("Initial district generation found no usable road-defined blocks.");
  const byId = new Map(plan.blocks.map((block) => [block.id, block]));
  const adjacent = adjacency(plan.blocks);
  const grown = components(plan.blocks, adjacent).flatMap((component) => growRegions(plan.blocks, component, adjacent, source.citySeed, source));
  const regions = resolveGeneratedRegions(plan.blocks, grown, adjacent, source.citySeed);
  const pool = enabledPool(source);
  if (pool.length === 0) throw new Error("Initial district generation has no valid enabled district types.");

  // Build region adjacency graph across shared block boundary connections
  const regionAdjacent = new Map<number, Set<number>>();
  for (let i = 0; i < regions.length; i++) regionAdjacent.set(i, new Set());
  for (let i = 0; i < regions.length; i++) {
    const regI = new Set(regions[i]);
    for (let j = i + 1; j < regions.length; j++) {
      const isNeighbor = regions[j]!.some((bId) => {
        const neighbors = adjacent.get(bId) ?? [];
        return neighbors.some((nId) => regI.has(nId));
      });
      if (isNeighbor) {
        regionAdjacent.get(i)!.add(j);
        regionAdjacent.get(j)!.add(i);
      }
    }
  }

  // Precompute region polygons and contexts
  const regionData = regions.map((region, index) => {
    const regionBlocks = region.map((id) => byId.get(id)!).filter(Boolean);
    const polygon = regionPolygon(regionBlocks, region);
    if (!polygon) throw new Error(`Generated district region "${region.join(",")}" is invalid.`);
    const context = districtRegionContext(source, regionBlocks, polygon);
    const lineage = region.join(",");
    // Intentional metropolitan assignment priority: central core first, then prominent anchors, then transitions
    const priority = context.hubProximity * 2.0 + context.hierarchy + context.waterfront * 1.5 + (context.peripheral > 0.65 ? 0.8 : 0);
    return { index, region, regionBlocks, polygon, context, lineage, priority };
  });

  // Assign district types in order of metropolitan hierarchy priority
  const assignmentOrder = [...regionData].sort((a, b) =>
    b.priority - a.priority ||
    fnv1a(`${source.citySeed}/districts/v3/priority/${a.lineage}`) - fnv1a(`${source.citySeed}/districts/v3/priority/${b.lineage}`) ||
    a.lineage.localeCompare(b.lineage)
  );

  const assignedTypes = new Map<number, DistrictTypeId>();
  const typeCounts = new Map<DistrictTypeId, number>();

  for (const entry of assignmentOrder) {
    const neighborTypes = [...(regionAdjacent.get(entry.index) ?? [])]
      .map((neighborIndex) => assignedTypes.get(neighborIndex))
      .filter((t): t is DistrictTypeId => t !== undefined);

    let winner = pool[0]!;
    let best = -Infinity;

    for (let pIdx = 0; pIdx < pool.length; pIdx++) {
      const id = pool[pIdx]!;
      const baseContext = contextualMultiplier(id, entry.context);

      let adjacencyMultiplier = 1.0;
      if (neighborTypes.length > 0) {
        const totalAffinity = neighborTypes.reduce((sum, nType) => sum + getAdjacencyAffinity(id, nType), 0);
        const avgAffinity = totalAffinity / neighborTypes.length;
        adjacencyMultiplier = Math.pow(avgAffinity, 1.25);
      }

      const randomness = 0.90 + hashUnit(`${source.citySeed}/districts/v3/type/${entry.lineage}/${id}`) * 0.20;
      const count = typeCounts.get(id) ?? 0;
      const diversityK = RESIDENTIAL_TYPES.has(id) ? 0.30 : INDUSTRIAL_TYPES.has(id) ? 0.40 : 0.80;
      const diversity = 1 / (1 + count * diversityK);

      const score = baseContext * adjacencyMultiplier * randomness * diversity;
      if (score > best) {
        best = score;
        winner = id;
      }
    }

    assignedTypes.set(entry.index, winner);
    typeCounts.set(winner, (typeCounts.get(winner) ?? 0) + 1);
  }

  const districts: DistrictSource[] = regionData.map((entry) => {
    const typeId = assignedTypes.get(entry.index)!;
    const definition = DISTRICT_TYPE_REGISTRY.get(typeId)!;
    return {
      id: stableId("district", `${source.citySeed}/districts/v3/id/${entry.lineage}`),
      polygon: entry.polygon,
      seed: stableId("seed", `${source.citySeed}/districts/v3/seed/${entry.lineage}`),
      typeId,
      paletteId: definition.defaultPaletteId,
      origin: "generated",
      locked: false,
      openSpaceOverride: null
    };
  });

  districts.sort((a, b) => a.id.localeCompare(b.id));
  validateDistrictCandidates({ ...source, districts }, districts);
  buildDistrictPlan({ ...source, districts });
  return districts;
}

/** A major landmark site reserved before roads, with the grammar that will occupy it. */
export interface ReservedLandmarkRequirement {
  grammarId: LandmarkGrammarId;
  sitePolygon: Ring;
}

function pointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const crosses = a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Post-generation assignment used by full generation: every district containing a reserved
 * major landmark site centroid is given a district type (from the enabled pool) whose
 * compatibility tags satisfy every contained reservation — non-empty tag intersection per
 * grammar, matching `landmarkFitsDistrict`. District id/seed/geometry are preserved; the
 * palette is updated to the new type's default. The choice among several fitting types is a
 * deterministic labelled-seed pick. If no single enabled type satisfies a multi-site
 * conflict, the original type is kept as deterministic contrast and a warning is returned.
 */
export function assignLandmarkCompatibleDistrictTypes(
  districts: readonly DistrictSource[],
  requirements: readonly ReservedLandmarkRequirement[],
  pool: readonly DistrictTypeId[],
  seed: string
): { districts: DistrictSource[]; warnings: string[] } {
  if (requirements.length === 0) return { districts: [...districts], warnings: [] };
  const poolSet = new Set(pool);
  const requiredByDistrict = new Map<string, LandmarkGrammarId[]>();
  for (const requirement of requirements) {
    const definition = LANDMARK_GRAMMAR_REGISTRY.get(requirement.grammarId);
    if (!definition) continue;
    const centroid = ringCentroid(requirement.sitePolygon);
    const district = districts.find((candidate) => pointInRing(centroid, candidate.polygon));
    if (!district) continue;
    const current = requiredByDistrict.get(district.id) ?? [];
    current.push(requirement.grammarId);
    requiredByDistrict.set(district.id, current);
  }
  const warnings: string[] = [];
  const assigned = districts.map((district) => {
    const required = requiredByDistrict.get(district.id);
    if (!required || required.length === 0) return district;
    const fits = (typeId: DistrictTypeId): boolean => {
      const definition = DISTRICT_TYPE_REGISTRY.get(typeId);
      if (!definition) return false;
      return required.every((grammarId) => {
        const grammar = LANDMARK_GRAMMAR_REGISTRY.get(grammarId)!;
        return grammar.compatibilityTags.some((tag) => definition.compatibilityTags.includes(tag));
      });
    };
    if (fits(district.typeId)) return district;
    const candidates = [...poolSet].filter((typeId) => typeId !== district.typeId && fits(typeId)).sort();
    if (candidates.length === 0) {
      warnings.push(
        `District "${district.id}" cannot host landmark reservation(s) ${[...new Set(required)].sort().join(", ")} with any enabled district type; kept as deterministic contrast.`
      );
      return district;
    }
    let best = candidates[0]!;
    let bestValue = -1;
    for (const typeId of candidates) {
      const value = hashUnit(`${seed}/landmarks/v3/district-type/${district.id}/${typeId}`);
      if (value > bestValue) {
        bestValue = value;
        best = typeId;
      }
    }
    return { ...district, typeId: best, paletteId: DISTRICT_TYPE_REGISTRY.get(best)!.defaultPaletteId };
  });
  return { districts: assigned, warnings };
}
