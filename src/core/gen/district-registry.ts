export const DISTRICT_TYPE_IDS = [
  "corporate-core",
  "commercial-highrise",
  "mixed-use-centre",
  "residential-megablocks",
  "dense-residential",
  "low-rise-residential",
  "night-market",
  "entertainment-strip",
  "old-city",
  "heavy-industrial",
  "light-industrial",
  "logistics-port",
  "waterfront",
  "civic-institutional",
  "utility-infrastructure",
  "derelict-reclamation"
] as const;

export type DistrictTypeId = (typeof DISTRICT_TYPE_IDS)[number];

export const BLOCK_GRAMMAR_IDS = [
  "perimeter-courtyard",
  "fine-grain-frontage",
  "rotated-bands",
  "irregular-mosaic",
  "superblock-compound",
  "tower-podium-field",
  "industrial-yard",
  "logistics-sheds",
  "campus-pavilions",
  "market-alley",
  "radial-fan",
  "waterfront-terraces"
] as const;

export type BlockGrammarId = (typeof BLOCK_GRAMMAR_IDS)[number];
export type DistrictCompatibilityTag = "formal" | "fine-grain" | "industrial" | "waterfront" | "campus" | "market" | "residential" | "irregular";
export type RegistryOpenSpaceCategory = "park" | "plaza" | "parking" | "vacant" | "utility" | "landscaping" | "service-yard";
export type RegistryOpenSpaceSize = "pocket" | "small" | "large" | "whole-block";

export interface DistrictPlanningBounds {
  minCellWidthM: number;
  maxCellWidthM: number;
  minCellDepthM: number;
  maxCellDepthM: number;
  minAspect: number;
  maxAspect: number;
}

export interface DistrictTypeDefinition {
  id: DistrictTypeId;
  label: string;
  defaultPaletteId: string;
  grammarWeights: Readonly<Record<BlockGrammarId, number>>;
  bounds: Readonly<DistrictPlanningBounds>;
  openSpaceMultiplier: number;
  categoryWeights: Readonly<Record<RegistryOpenSpaceCategory, number>>;
  sizeWeights: Readonly<Record<RegistryOpenSpaceSize, number>>;
  compatibilityTags: readonly DistrictCompatibilityTag[];
}

const weights = (values: Partial<Record<BlockGrammarId, number>>): Readonly<Record<BlockGrammarId, number>> =>
  Object.freeze(Object.fromEntries(BLOCK_GRAMMAR_IDS.map((id) => [id, values[id] ?? 0])) as Record<BlockGrammarId, number>);

const categories = (
  park: number,
  plaza: number,
  parking: number,
  vacant: number,
  utility: number,
  landscaping: number,
  serviceYard: number
): Readonly<Record<RegistryOpenSpaceCategory, number>> =>
  Object.freeze({ park, plaza, parking, vacant, utility, landscaping, "service-yard": serviceYard });

const sizes = (pocket: number, small: number, large: number, wholeBlock: number): Readonly<Record<RegistryOpenSpaceSize, number>> =>
  Object.freeze({ pocket, small, large, "whole-block": wholeBlock });

const district = (
  id: DistrictTypeId,
  label: string,
  defaultPaletteId: string,
  grammarWeights: Partial<Record<BlockGrammarId, number>>,
  bounds: DistrictPlanningBounds,
  openSpaceMultiplier: number,
  categoryWeights: Readonly<Record<RegistryOpenSpaceCategory, number>>,
  sizeWeights: Readonly<Record<RegistryOpenSpaceSize, number>>,
  compatibilityTags: readonly DistrictCompatibilityTag[]
): DistrictTypeDefinition => Object.freeze({
  id,
  label,
  defaultPaletteId,
  grammarWeights: weights(grammarWeights),
  bounds: Object.freeze(bounds),
  openSpaceMultiplier,
  categoryWeights,
  sizeWeights,
  compatibilityTags: Object.freeze([...compatibilityTags])
});

export const DISTRICT_TYPES: readonly DistrictTypeDefinition[] = Object.freeze([
  district("corporate-core", "Corporate Core", "corporate", { "tower-podium-field": 0.48, "perimeter-courtyard": 0.24, "campus-pavilions": 0.16, "rotated-bands": 0.12 }, { minCellWidthM: 24, maxCellWidthM: 54, minCellDepthM: 28, maxCellDepthM: 66, minAspect: 0.55, maxAspect: 2.4 }, 0.6, categories(2, 5, 1, 0.5, 0.5, 3, 0.5), sizes(1, 3, 4, 1), ["formal"]),
  district("commercial-highrise", "Commercial Highrise", "commercial", { "tower-podium-field": 0.36, "fine-grain-frontage": 0.28, "perimeter-courtyard": 0.2, "rotated-bands": 0.16 }, { minCellWidthM: 14, maxCellWidthM: 44, minCellDepthM: 24, maxCellDepthM: 58, minAspect: 0.38, maxAspect: 2.9 }, 0.72, categories(1, 4, 2, 0.5, 0.5, 2, 1), sizes(2, 4, 3, 1), ["formal", "fine-grain"]),
  district("mixed-use-centre", "Mixed Use Centre", "mixed-use", { "fine-grain-frontage": 0.34, "perimeter-courtyard": 0.28, "irregular-mosaic": 0.22, "market-alley": 0.16 }, { minCellWidthM: 9, maxCellWidthM: 32, minCellDepthM: 14, maxCellDepthM: 42, minAspect: 0.3, maxAspect: 3.2 }, 0.9, categories(3, 4, 1.5, 1, 0.5, 2, 1), sizes(3, 5, 2, 0.5), ["fine-grain", "market"]),
  district("residential-megablocks", "Residential Megablocks", "residential-mega", { "superblock-compound": 0.42, "perimeter-courtyard": 0.28, "rotated-bands": 0.18, "campus-pavilions": 0.12 }, { minCellWidthM: 28, maxCellWidthM: 68, minCellDepthM: 30, maxCellDepthM: 74, minAspect: 0.5, maxAspect: 2.2 }, 1.05, categories(5, 1, 1.5, 0.5, 0.5, 4, 0.5), sizes(1, 4, 5, 2), ["residential", "campus"]),
  district("dense-residential", "Dense Residential", "residential-dense", { "perimeter-courtyard": 0.38, "fine-grain-frontage": 0.3, "irregular-mosaic": 0.2, "rotated-bands": 0.12 }, { minCellWidthM: 8, maxCellWidthM: 26, minCellDepthM: 16, maxCellDepthM: 38, minAspect: 0.3, maxAspect: 3.6 }, 0.86, categories(4, 1, 1, 0.5, 0.3, 3, 0.4), sizes(4, 5, 1, 0.2), ["residential", "fine-grain"]),
  district("low-rise-residential", "Low-Rise Residential", "residential-low", { "rotated-bands": 0.34, "fine-grain-frontage": 0.28, "irregular-mosaic": 0.2, "campus-pavilions": 0.18 }, { minCellWidthM: 10, maxCellWidthM: 30, minCellDepthM: 12, maxCellDepthM: 34, minAspect: 0.4, maxAspect: 2.8 }, 1.2, categories(5, 0.5, 1, 0.7, 0.3, 5, 0.3), sizes(6, 4, 1, 0.2), ["residential"]),
  district("night-market", "Night Market", "night-market", { "market-alley": 0.44, "fine-grain-frontage": 0.32, "radial-fan": 0.14, "irregular-mosaic": 0.1 }, { minCellWidthM: 5, maxCellWidthM: 16, minCellDepthM: 8, maxCellDepthM: 24, minAspect: 0.22, maxAspect: 4.5 }, 0.82, categories(1, 6, 1, 0.5, 0.2, 1, 2), sizes(6, 4, 1, 0.2), ["market", "fine-grain"]),
  district("entertainment-strip", "Entertainment Strip", "entertainment", { "fine-grain-frontage": 0.3, "market-alley": 0.26, "logistics-sheds": 0.18, "rotated-bands": 0.16, "perimeter-courtyard": 0.1 }, { minCellWidthM: 8, maxCellWidthM: 28, minCellDepthM: 18, maxCellDepthM: 48, minAspect: 0.2, maxAspect: 4.8 }, 1.0, categories(1, 5, 4, 0.5, 0.2, 1, 1), sizes(3, 5, 2, 0.5), ["market", "fine-grain"]),
  district("old-city", "Old City", "old-city", { "irregular-mosaic": 0.4, "radial-fan": 0.28, "fine-grain-frontage": 0.2, "market-alley": 0.12 }, { minCellWidthM: 6, maxCellWidthM: 22, minCellDepthM: 9, maxCellDepthM: 30, minAspect: 0.24, maxAspect: 4 }, 0.78, categories(2, 4, 0.5, 1.5, 0.2, 2, 1), sizes(5, 4, 1, 0.2), ["irregular", "fine-grain"]),
  district("heavy-industrial", "Heavy Industrial", "industrial-heavy", { "industrial-yard": 0.52, "logistics-sheds": 0.28, "superblock-compound": 0.14, "rotated-bands": 0.06 }, { minCellWidthM: 36, maxCellWidthM: 92, minCellDepthM: 42, maxCellDepthM: 112, minAspect: 0.32, maxAspect: 3.8 }, 0.9, categories(0.2, 0.1, 2, 1.5, 5, 0.3, 6), sizes(0.5, 2, 5, 4), ["industrial"]),
  district("light-industrial", "Light Industrial", "industrial-light", { "industrial-yard": 0.36, "logistics-sheds": 0.28, "rotated-bands": 0.22, "irregular-mosaic": 0.14 }, { minCellWidthM: 22, maxCellWidthM: 58, minCellDepthM: 26, maxCellDepthM: 68, minAspect: 0.35, maxAspect: 3.4 }, 0.92, categories(0.5, 0.3, 3, 1, 4, 0.8, 5), sizes(1, 3, 5, 2), ["industrial"]),
  district("logistics-port", "Logistics Port", "logistics-port", { "logistics-sheds": 0.5, "industrial-yard": 0.26, "waterfront-terraces": 0.16, "rotated-bands": 0.08 }, { minCellWidthM: 26, maxCellWidthM: 72, minCellDepthM: 54, maxCellDepthM: 132, minAspect: 0.18, maxAspect: 5.5 }, 1.0, categories(0.2, 0.2, 3, 1, 3, 0.3, 7), sizes(0.5, 2, 5, 5), ["industrial", "waterfront"]),
  district("waterfront", "Waterfront", "waterfront", { "waterfront-terraces": 0.46, "rotated-bands": 0.2, "fine-grain-frontage": 0.16, "campus-pavilions": 0.1, "perimeter-courtyard": 0.08 }, { minCellWidthM: 12, maxCellWidthM: 38, minCellDepthM: 16, maxCellDepthM: 50, minAspect: 0.32, maxAspect: 3.8 }, 1.35, categories(5, 4, 1, 0.5, 0.2, 4, 0.4), sizes(3, 5, 3, 1), ["waterfront"]),
  district("civic-institutional", "Civic and Institutional", "civic", { "campus-pavilions": 0.4, "radial-fan": 0.26, "perimeter-courtyard": 0.2, "tower-podium-field": 0.14 }, { minCellWidthM: 18, maxCellWidthM: 48, minCellDepthM: 20, maxCellDepthM: 54, minAspect: 0.5, maxAspect: 2.5 }, 1.45, categories(5, 5, 0.5, 0.2, 0.8, 5, 0.3), sizes(1, 4, 5, 2), ["formal", "campus"]),
  district("utility-infrastructure", "Utility Infrastructure", "utility", { "industrial-yard": 0.42, "superblock-compound": 0.26, "campus-pavilions": 0.2, "irregular-mosaic": 0.12 }, { minCellWidthM: 30, maxCellWidthM: 76, minCellDepthM: 34, maxCellDepthM: 84, minAspect: 0.42, maxAspect: 3 }, 1.15, categories(0.1, 0.1, 1, 1, 8, 0.5, 5), sizes(0.5, 2, 5, 5), ["industrial", "campus"]),
  district("derelict-reclamation", "Derelict Reclamation", "derelict", { "irregular-mosaic": 0.38, "industrial-yard": 0.24, "radial-fan": 0.18, "rotated-bands": 0.12, "fine-grain-frontage": 0.08 }, { minCellWidthM: 11, maxCellWidthM: 46, minCellDepthM: 13, maxCellDepthM: 58, minAspect: 0.26, maxAspect: 4.2 }, 1.55, categories(1, 0.5, 1, 6, 4, 1, 4), sizes(2, 4, 4, 3), ["irregular", "industrial"])
]);

export const DISTRICT_PALETTE_IDS = Object.freeze(DISTRICT_TYPES.map((entry) => entry.defaultPaletteId));

export const DISTRICT_TYPE_REGISTRY: ReadonlyMap<DistrictTypeId, DistrictTypeDefinition> = new Map(
  DISTRICT_TYPES.map((entry) => [entry.id, entry])
);

export interface DistrictRegistryValidation {
  ok: boolean;
  problems: string[];
}

export function validateDistrictRegistry(entries: readonly DistrictTypeDefinition[] = DISTRICT_TYPES): DistrictRegistryValidation {
  const problems: string[] = [];
  const ids = new Set<DistrictTypeId>();
  const signatures = new Map<string, DistrictTypeId>();
  const reachable = new Set<BlockGrammarId>();
  const paletteIds = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push(`Duplicate district type id "${entry.id}".`);
    ids.add(entry.id);
    if (entry.defaultPaletteId.trim().length === 0 || paletteIds.has(entry.defaultPaletteId)) problems.push(`District type "${entry.id}" has an empty or duplicate default palette id.`);
    paletteIds.add(entry.defaultPaletteId);
    const active = BLOCK_GRAMMAR_IDS.filter((id) => Number.isFinite(entry.grammarWeights[id]) && entry.grammarWeights[id] > 0);
    if (active.length < 3) problems.push(`District type "${entry.id}" must weight at least three grammars.`);
    for (const id of active) reachable.add(id);
    const invalidWeight = BLOCK_GRAMMAR_IDS.find((id) => !Number.isFinite(entry.grammarWeights[id]) || entry.grammarWeights[id] < 0);
    if (invalidWeight) problems.push(`District type "${entry.id}" has an invalid grammar weight.`);
    const signature = JSON.stringify([BLOCK_GRAMMAR_IDS.map((id) => entry.grammarWeights[id]), entry.bounds]);
    const previous = signatures.get(signature);
    if (previous) problems.push(`District types "${previous}" and "${entry.id}" have identical planning signatures.`);
    signatures.set(signature, entry.id);
  }
  for (const id of DISTRICT_TYPE_IDS) if (!ids.has(id)) problems.push(`District type "${id}" is unreachable.`);
  for (const id of BLOCK_GRAMMAR_IDS) if (!reachable.has(id)) problems.push(`Block grammar "${id}" is unreachable.`);
  return { ok: problems.length === 0, problems };
}

export function districtTypeById(id: DistrictTypeId): DistrictTypeDefinition {
  const entry = DISTRICT_TYPE_REGISTRY.get(id);
  if (!entry) throw new Error(`Unknown district type "${id}".`);
  return entry;
}
