import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS, INFILL_BUILDING_GRAMMAR_IDS, MICRO_BUILDING_GRAMMAR_IDS, type BuildingGrammarDefinition, type BuildingGrammarId, type BuildingUseId } from "./building-registry.js";

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

/**
 * Deterministic height target for a district's ORDINARY buildings (metres). Blocks
 * scale this band by a per-block factor, and every non-tower, non-micro building in a
 * block draws its height from the scaled band (clamped to its grammar's declared
 * range). Tower grammars are deliberate outliers and never shaped into the band.
 */
export interface HeightBand {
  minM: number;
  maxM: number;
}

export interface DistrictTypeDefinition {
  id: DistrictTypeId;
  label: string;
  defaultPaletteId: string;
  grammarWeights: Readonly<Record<BlockGrammarId, number>>;
  /** Normalized Phase 4 building grammar weights; every non-zero entry is tag-compatible. */
  buildingGrammarWeights: Readonly<Record<BuildingGrammarId, number>>;
  /** Normalized Phase 4 visual-use weights; every non-zero entry is supported by an active grammar. */
  visualUseWeights: Readonly<Record<BuildingUseId, number>>;
  bounds: Readonly<DistrictPlanningBounds>;
  /** Ordinary-building height band, scaled per block by the planner. */
  heightBand: Readonly<HeightBand>;
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

const building = (values: Partial<Record<BuildingGrammarId, number>>): Readonly<Record<BuildingGrammarId, number>> =>
  Object.freeze(Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [id, values[id] ?? 0])) as Record<BuildingGrammarId, number>);

const uses = (values: Partial<Record<BuildingUseId, number>>): Readonly<Record<BuildingUseId, number>> =>
  Object.freeze(Object.fromEntries(BUILDING_USE_IDS.map((id) => [id, values[id] ?? 0])) as Record<BuildingUseId, number>);

const district = (
  id: DistrictTypeId,
  label: string,
  defaultPaletteId: string,
  grammarWeights: Partial<Record<BlockGrammarId, number>>,
  bounds: DistrictPlanningBounds,
  heightBand: HeightBand,
  openSpaceMultiplier: number,
  categoryWeights: Readonly<Record<RegistryOpenSpaceCategory, number>>,
  sizeWeights: Readonly<Record<RegistryOpenSpaceSize, number>>,
  compatibilityTags: readonly DistrictCompatibilityTag[],
  buildingGrammarWeights: Partial<Record<BuildingGrammarId, number>>,
  visualUseWeights: Partial<Record<BuildingUseId, number>>
): DistrictTypeDefinition => Object.freeze({
  id,
  label,
  defaultPaletteId,
  grammarWeights: weights(grammarWeights),
  buildingGrammarWeights: building(buildingGrammarWeights),
  visualUseWeights: uses(visualUseWeights),
  bounds: Object.freeze(bounds),
  heightBand: Object.freeze({ ...heightBand }),
  openSpaceMultiplier,
  categoryWeights,
  sizeWeights,
  compatibilityTags: Object.freeze([...compatibilityTags])
});

export const DISTRICT_TYPES: readonly DistrictTypeDefinition[] = Object.freeze([
  district("corporate-core", "Corporate Core", "corporate", { "tower-podium-field": 0.48, "perimeter-courtyard": 0.24, "campus-pavilions": 0.16, "rotated-bands": 0.12 }, { minCellWidthM: 24, maxCellWidthM: 54, minCellDepthM: 28, maxCellDepthM: 66, minAspect: 0.55, maxAspect: 2.4 }, { minM: 60, maxM: 130 }, 0.6, categories(2, 5, 1, 0.5, 0.5, 3, 0.5), sizes(1, 3, 4, 1), ["formal"], building({ "corporate-setback-tower": 0.18, "corporate-chamfered-tower": 0.14, "commercial-offset-tower": 0.11, "corporate-tower-podium": 0.12, "corporate-atrium-block": 0.08, "civic-tower-plinth": 0.04, "commercial-t-headquarters": 0.12, "civic-cross-tower": 0.08, "corporate-hex-tower": 0.13 }), uses({ commercial: 0.5, civic: 0.3, "mixed-use": 0.2 })),
  district("commercial-highrise", "Commercial Highrise", "commercial", { "tower-podium-field": 0.36, "fine-grain-frontage": 0.28, "perimeter-courtyard": 0.2, "rotated-bands": 0.16 }, { minCellWidthM: 14, maxCellWidthM: 44, minCellDepthM: 24, maxCellDepthM: 58, minAspect: 0.38, maxAspect: 2.9 }, { minM: 38, maxM: 84 }, 0.72, categories(1, 4, 2, 0.5, 0.5, 2, 1), sizes(2, 4, 3, 1), ["formal", "fine-grain"], building({ "corporate-setback-tower": 0.16, "corporate-chamfered-tower": 0.12, "commercial-offset-tower": 0.13, "corporate-tower-podium": 0.1, "commercial-twin-tower-podium": 0.05, "wedge-office": 0.04, "commercial-t-headquarters": 0.14, "civic-cross-tower": 0.08, "corporate-hex-tower": 0.1, "dense-perimeter-block": 0.08 }), uses({ commercial: 0.6, "mixed-use": 0.3, entertainment: 0.1 })),
  district("mixed-use-centre", "Mixed Use Centre", "mixed-use", { "fine-grain-frontage": 0.34, "perimeter-courtyard": 0.28, "irregular-mosaic": 0.22, "market-alley": 0.16 }, { minCellWidthM: 12, maxCellWidthM: 32, minCellDepthM: 14, maxCellDepthM: 42, minAspect: 0.3, maxAspect: 3.2 }, { minM: 28, maxM: 62 }, 0.9, categories(3, 4, 1.5, 1, 0.5, 2, 1), sizes(3, 5, 2, 0.5), ["fine-grain", "market"], building({ "market-bridge-complex": 0.14, "entertainment-cantilever-stack": 0.1, "entertainment-offset-stack": 0.1, "dense-perimeter-block": 0.14, "market-corner": 0.1, "narrow-shopfront": 0.08, "corner-flatiron": 0.05, "market-cross-complex": 0.12, "commercial-t-headquarters": 0.08, "residential-h-block": 0.09 }), uses({ "mixed-use": 0.5, commercial: 0.3, residential: 0.2 })),
  // Tuned: cell bounds, block grammar weights, building grammar weights
  district("residential-megablocks", "Residential Megablocks", "residential-mega", { "perimeter-courtyard": 0.6, "fine-grain-frontage": 0.25, "superblock-compound": 0.15 }, { minCellWidthM: 22, maxCellWidthM: 50, minCellDepthM: 22, maxCellDepthM: 50, minAspect: 0.5, maxAspect: 2.2 }, { minM: 34, maxM: 78 }, 1.05, categories(5, 1, 1.5, 0.5, 0.5, 4, 0.5), sizes(1, 4, 5, 2), ["residential", "campus"], building({ "megablock-ring": 0.22, "dense-perimeter-block": 0.14, "residential-court": 0.15, "residential-wing": 0.08, "civic-pavilion": 0.03, "campus-annex": 0.03, "residential-t-court": 0.13, "residential-h-block": 0.12, "campus-h-institute": 0.1 }), uses({ residential: 0.7, "mixed-use": 0.2, civic: 0.1 })),
  district("dense-residential", "Dense Residential", "residential-dense", { "perimeter-courtyard": 0.38, "fine-grain-frontage": 0.3, "irregular-mosaic": 0.2, "rotated-bands": 0.12 }, { minCellWidthM: 12, maxCellWidthM: 26, minCellDepthM: 16, maxCellDepthM: 38, minAspect: 0.3, maxAspect: 3.6 }, { minM: 26, maxM: 58 }, 0.86, categories(4, 1, 1, 0.5, 0.3, 3, 0.4), sizes(4, 5, 1, 0.2), ["residential", "fine-grain"], building({ "residential-court": 0.23, "residential-wing": 0.18, "old-city-courtyard": 0.16, "residential-slab": 0.1, "garage-unit": 0.04, "narrow-strip": 0.03, "residential-t-court": 0.18, "market-cross-complex": 0.08 }), uses({ residential: 0.8, "mixed-use": 0.2 })),
  // Tuned: open space multiplier
  district("low-rise-residential", "Low-Rise Residential", "residential-low", { "rotated-bands": 0.34, "fine-grain-frontage": 0.28, "irregular-mosaic": 0.2, "campus-pavilions": 0.18 }, { minCellWidthM: 12, maxCellWidthM: 30, minCellDepthM: 12, maxCellDepthM: 34, minAspect: 0.4, maxAspect: 2.8 }, { minM: 18, maxM: 42 }, 0.85, categories(5, 0.5, 1, 0.7, 0.3, 5, 0.3), sizes(6, 4, 1, 0.2), ["residential"], building({ "residential-wing": 0.22, "residential-court": 0.18, "residential-slab": 0.12, "dense-perimeter-block": 0.12, "garage-unit": 0.05, "residential-t-court": 0.16, "residential-h-block": 0.15 }), uses({ residential: 0.9, "mixed-use": 0.1 })),
  district("night-market", "Night Market", "night-market", { "market-alley": 0.44, "fine-grain-frontage": 0.32, "radial-fan": 0.14, "irregular-mosaic": 0.1 }, { minCellWidthM: 12, maxCellWidthM: 16, minCellDepthM: 10, maxCellDepthM: 24, minAspect: 0.22, maxAspect: 4.5 }, { minM: 16, maxM: 36 }, 0.82, categories(1, 6, 1, 0.5, 0.2, 1, 2), sizes(6, 4, 1, 0.2), ["market", "fine-grain"], building({ "market-corner": 0.32, "narrow-shopfront": 0.1, "entertainment-cantilever-stack": 0.28, "corner-flatiron": 0.08, "street-kiosk": 0.1, "narrow-strip": 0.06, "residential-slab": 0.06 }), uses({ entertainment: 0.4, commercial: 0.35, "mixed-use": 0.25 })),
  // Tuned: block grammar weights (removed logistics-sheds, added weight to fine-grain-frontage)
  district("entertainment-strip", "Entertainment Strip", "entertainment", { "fine-grain-frontage": 0.48, "market-alley": 0.26, "rotated-bands": 0.16, "perimeter-courtyard": 0.1 }, { minCellWidthM: 12, maxCellWidthM: 28, minCellDepthM: 20, maxCellDepthM: 48, minAspect: 0.2, maxAspect: 4.8 }, { minM: 24, maxM: 56 }, 1.0, categories(1, 5, 4, 0.5, 0.2, 1, 1), sizes(3, 5, 2, 0.5), ["market", "fine-grain"], building({ "entertainment-offset-stack": 0.16, "entertainment-cantilever-stack": 0.16, "entertainment-signage-podium": 0.15, "market-corner": 0.1, "narrow-shopfront": 0.07, "corner-flatiron": 0.05, "narrow-strip": 0.04, "market-cross-complex": 0.27 }), uses({ entertainment: 0.5, commercial: 0.3, "mixed-use": 0.2 })),
  district("old-city", "Old City", "old-city", { "irregular-mosaic": 0.4, "radial-fan": 0.28, "fine-grain-frontage": 0.2, "market-alley": 0.12 }, { minCellWidthM: 12, maxCellWidthM: 22, minCellDepthM: 12, maxCellDepthM: 30, minAspect: 0.24, maxAspect: 4 }, { minM: 18, maxM: 40 }, 0.78, categories(2, 4, 0.5, 1.5, 0.2, 2, 1), sizes(5, 4, 1, 0.2), ["irregular", "fine-grain"], building({ "old-city-courtyard": 0.22, "derelict-reclamation-cluster": 0.14, "market-corner": 0.12, "corner-flatiron": 0.06, "narrow-shopfront": 0.06, "street-kiosk": 0.06, "shack-shanty": 0.06, "narrow-strip": 0.03, "market-cross-complex": 0.25 }), uses({ "mixed-use": 0.4, residential: 0.35, commercial: 0.25 })),
  // Tuned: cell bounds, block grammar weights, building grammar weights
  district("heavy-industrial", "Heavy Industrial", "industrial-heavy", { "industrial-yard": 0.38, "logistics-sheds": 0.4, "rotated-bands": 0.22 }, { minCellWidthM: 20, maxCellWidthM: 48, minCellDepthM: 22, maxCellDepthM: 54, minAspect: 0.32, maxAspect: 3.8 }, { minM: 13, maxM: 28 }, 0.9, categories(0.2, 0.1, 2, 1.5, 5, 0.3, 6), sizes(0.5, 2, 5, 4), ["industrial"], building({ "industrial-skybridge-works": 0.16, "logistics-cantilever-works": 0.13, "industrial-loading-court": 0.14, "service-court-works": 0.1, "industrial-shed": 0.08, "stacked-workshop": 0.05, "industrial-sawtooth-works": 0.2, "logistics-comb-depot": 0.14 }), uses({ industrial: 0.6, logistics: 0.25, utility: 0.15 })),
  // Tuned: cell bounds, block grammar weights, building grammar weights
  district("light-industrial", "Light Industrial", "industrial-light", { "fine-grain-frontage": 0.4, "rotated-bands": 0.35, "industrial-yard": 0.25 }, { minCellWidthM: 14, maxCellWidthM: 34, minCellDepthM: 16, maxCellDepthM: 38, minAspect: 0.35, maxAspect: 3.4 }, { minM: 14, maxM: 32 }, 0.92, categories(0.5, 0.3, 3, 1, 4, 0.8, 5), sizes(1, 3, 5, 2), ["industrial"], building({ "stacked-workshop": 0.12, "logistics-cantilever-works": 0.14, "service-court-works": 0.14, "industrial-skybridge-works": 0.12, "industrial-shed": 0.08, "utility-service-cluster": 0.08, "garage-unit": 0.04, "utility-kiosk": 0.03, "industrial-sawtooth-works": 0.25 }), uses({ industrial: 0.55, logistics: 0.3, utility: 0.15 })),
  // Tuned: cell depth bounds
  district("logistics-port", "Logistics Port", "logistics-port", { "logistics-sheds": 0.5, "industrial-yard": 0.26, "waterfront-terraces": 0.16, "rotated-bands": 0.08 }, { minCellWidthM: 26, maxCellWidthM: 72, minCellDepthM: 36, maxCellDepthM: 72, minAspect: 0.18, maxAspect: 5.5 }, { minM: 12, maxM: 26 }, 1.0, categories(0.2, 0.2, 3, 1, 3, 0.3, 7), sizes(0.5, 2, 5, 5), ["industrial", "waterfront"], building({ "logistics-cantilever-works": 0.16, "industrial-skybridge-works": 0.13, "industrial-loading-court": 0.13, "industrial-shed": 0.08, "service-court-works": 0.08, "utility-service-cluster": 0.05, "industrial-sawtooth-works": 0.16, "logistics-comb-depot": 0.16, "waterfront-hex-pavilion": 0.05 }), uses({ logistics: 0.6, industrial: 0.3, utility: 0.1 })),
  // Tuned: open space multiplier
  district("waterfront", "Waterfront", "waterfront", { "waterfront-terraces": 0.46, "rotated-bands": 0.2, "fine-grain-frontage": 0.16, "campus-pavilions": 0.1, "perimeter-courtyard": 0.08 }, { minCellWidthM: 12, maxCellWidthM: 38, minCellDepthM: 16, maxCellDepthM: 50, minAspect: 0.32, maxAspect: 3.8 }, { minM: 28, maxM: 68 }, 1.05, categories(5, 4, 1, 0.5, 0.2, 4, 0.4), sizes(3, 5, 3, 1), ["waterfront"], building({ "waterfront-step": 0.12, "residential-slab": 0.08, "dense-perimeter-block": 0.13, "corporate-tower-podium": 0.1, "corner-flatiron": 0.05, "logistics-cantilever-works": 0.1, "waterfront-hex-pavilion": 0.2, "corporate-hex-tower": 0.1, "logistics-comb-depot": 0.12 }), uses({ "mixed-use": 0.4, residential: 0.3, entertainment: 0.2, commercial: 0.1 })),
  district("civic-institutional", "Civic and Institutional", "civic", { "campus-pavilions": 0.4, "radial-fan": 0.26, "perimeter-courtyard": 0.2, "tower-podium-field": 0.14 }, { minCellWidthM: 18, maxCellWidthM: 48, minCellDepthM: 20, maxCellDepthM: 54, minAspect: 0.5, maxAspect: 2.5 }, { minM: 24, maxM: 56 }, 1.45, categories(5, 5, 0.5, 0.2, 0.8, 5, 0.3), sizes(1, 4, 5, 2), ["formal", "campus"], building({ "civic-stepped-institute": 0.15, "civic-chamfered-hall": 0.13, "civic-entry-court": 0.11, "civic-pavilion": 0.06, "corporate-atrium-block": 0.07, "civic-tower-plinth": 0.07, "campus-annex": 0.04, "civic-cross-tower": 0.14, "campus-h-institute": 0.13, "commercial-t-headquarters": 0.1 }), uses({ civic: 0.7, commercial: 0.2, "mixed-use": 0.1 })),
  // Tuned: cell bounds, open space multiplier, building grammar weights
  district("utility-infrastructure", "Utility Infrastructure", "utility", { "industrial-yard": 0.42, "superblock-compound": 0.26, "campus-pavilions": 0.2, "irregular-mosaic": 0.12 }, { minCellWidthM: 16, maxCellWidthM: 38, minCellDepthM: 18, maxCellDepthM: 42, minAspect: 0.42, maxAspect: 3 }, { minM: 12, maxM: 26 }, 0.7, categories(0.1, 0.1, 1, 1, 8, 0.5, 5), sizes(0.5, 2, 5, 5), ["industrial", "campus"], building({ "logistics-cantilever-works": 0.12, "industrial-skybridge-works": 0.1, "utility-service-cluster": 0.12, "stacked-workshop": 0.08, "service-court-works": 0.09, "industrial-shed": 0.06, "utility-kiosk": 0.03, "garage-unit": 0.03, "industrial-sawtooth-works": 0.2, "logistics-comb-depot": 0.17 }), uses({ utility: 0.6, industrial: 0.3, logistics: 0.1 })),
  // Tuned: cell bounds, open space multiplier, building grammar weights
  district("derelict-reclamation", "Derelict Reclamation", "derelict", { "irregular-mosaic": 0.38, "industrial-yard": 0.24, "radial-fan": 0.18, "rotated-bands": 0.12, "fine-grain-frontage": 0.08 }, { minCellWidthM: 12, maxCellWidthM: 30, minCellDepthM: 14, maxCellDepthM: 34, minAspect: 0.26, maxAspect: 4.2 }, { minM: 12, maxM: 26 }, 0.9, categories(1, 0.5, 1, 6, 4, 1, 4), sizes(2, 4, 4, 3), ["irregular", "industrial"], building({ "derelict-reclamation-cluster": 0.2, "service-court-works": 0.15, "stacked-workshop": 0.08, "old-city-courtyard": 0.12, "logistics-cantilever-works": 0.1, "shack-shanty": 0.07, "garage-unit": 0.05, "industrial-sawtooth-works": 0.23 }), uses({ industrial: 0.4, utility: 0.3, residential: 0.2, "mixed-use": 0.1 }))
]);

export const DISTRICT_PALETTE_IDS = Object.freeze(DISTRICT_TYPES.map((entry) => entry.defaultPaletteId));

export const DISTRICT_TYPE_REGISTRY: ReadonlyMap<DistrictTypeId, DistrictTypeDefinition> = new Map(
  DISTRICT_TYPES.map((entry) => [entry.id, entry])
);

export interface DistrictRegistryValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Whether some parcel inside the district's cell envelope can satisfy the grammar's
 * declared site limits: width, depth, area, and aspect must each be jointly reachable.
 */
function buildingFitsEnvelope(bounds: DistrictPlanningBounds, grammar: BuildingGrammarDefinition): boolean {
  const limits = grammar.siteLimits;
  const w0 = Math.max(bounds.minCellWidthM, limits.minWidthM);
  const w1 = Math.min(bounds.maxCellWidthM, limits.maxWidthM);
  if (w0 > w1) return false;
  const d0 = Math.max(bounds.minCellDepthM, limits.minDepthM);
  const d1 = Math.min(bounds.maxCellDepthM, limits.maxDepthM);
  if (d0 > d1) return false;
  if (w1 * d1 < limits.minAreaM2 || w0 * d0 > limits.maxAreaM2) return false;
  if (w1 / d0 < limits.minAspect || w0 / d1 > limits.maxAspect) return false;
  return true;
}

export function validateDistrictRegistry(entries: readonly DistrictTypeDefinition[] = DISTRICT_TYPES): DistrictRegistryValidation {
  const problems: string[] = [];
  const ids = new Set<DistrictTypeId>();
  const signatures = new Map<string, DistrictTypeId>();
  const reachable = new Set<BlockGrammarId>();
  const reachableBuildings = new Set<BuildingGrammarId>();
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
    if (!(entry.heightBand.minM > 0 && entry.heightBand.minM <= entry.heightBand.maxM)) {
      problems.push(`District type "${entry.id}" has an invalid height band.`);
    }
    const signature = JSON.stringify([BLOCK_GRAMMAR_IDS.map((id) => entry.grammarWeights[id]), entry.bounds]);
    const previous = signatures.get(signature);
    if (previous) problems.push(`District types "${previous}" and "${entry.id}" have identical planning signatures.`);
    signatures.set(signature, entry.id);

    const activeBuildings = BUILDING_GRAMMAR_IDS.filter((id) => Number.isFinite(entry.buildingGrammarWeights[id]) && entry.buildingGrammarWeights[id] > 0);
    if (activeBuildings.length < 4) problems.push(`District type "${entry.id}" must weight at least four compatible building grammars.`);
    const invalidBuildingWeight = BUILDING_GRAMMAR_IDS.find((id) => !Number.isFinite(entry.buildingGrammarWeights[id]) || entry.buildingGrammarWeights[id] < 0);
    if (invalidBuildingWeight) problems.push(`District type "${entry.id}" has an invalid building grammar weight.`);
    for (const id of activeBuildings) {
      reachableBuildings.add(id);
      const definition = BUILDING_GRAMMAR_REGISTRY.get(id);
      if (!definition) {
        problems.push(`District type "${entry.id}" references unknown building grammar "${id}".`);
        continue;
      }
      const compatible = definition.compatibilityTags.some((tag) => entry.compatibilityTags.includes(tag));
      if (!compatible) problems.push(`District type "${entry.id}" weights incompatible building grammar "${id}".`);
      if (!buildingFitsEnvelope(entry.bounds, definition)) {
        problems.push(`District type "${entry.id}" weights building grammar "${id}" that cannot fit its planning envelope.`);
      }
    }
    const nonMicroWeight = activeBuildings.reduce((sum, id) =>
      sum + (MICRO_BUILDING_GRAMMAR_IDS.has(id) ? 0 : entry.buildingGrammarWeights[id]), 0);
    const rectangularWeight = activeBuildings.reduce((sum, id) => {
      if (MICRO_BUILDING_GRAMMAR_IDS.has(id)) return sum;
      const archetype = BUILDING_GRAMMAR_REGISTRY.get(id)?.archetype;
      return sum + (archetype === "rectangle" || archetype === "trapezoid" ? entry.buildingGrammarWeights[id] : 0);
    }, 0);
    if (nonMicroWeight > 0 && rectangularWeight / nonMicroWeight > 0.35 + 1e-9) {
      problems.push(`District type "${entry.id}" assigns more than 35% of its non-micro building weight to rectangle and trapezoid archetypes.`);
    }
    const invalidUse = BUILDING_USE_IDS.find((id) => !Number.isFinite(entry.visualUseWeights[id]) || entry.visualUseWeights[id] < 0);
    if (invalidUse) problems.push(`District type "${entry.id}" has an invalid visual-use weight.`);
    for (const use of BUILDING_USE_IDS) {
      if (!(entry.visualUseWeights[use] > 0)) continue;
      const supported = activeBuildings.some((id) => BUILDING_GRAMMAR_REGISTRY.get(id)?.compatibleUses.includes(use));
      if (!supported) problems.push(`District type "${entry.id}" weights visual use "${use}" that none of its active building grammars support.`);
    }
    const architectureSignature = JSON.stringify([
      BUILDING_GRAMMAR_IDS.map((id) => entry.buildingGrammarWeights[id]),
      BUILDING_USE_IDS.map((id) => entry.visualUseWeights[id]),
      BLOCK_GRAMMAR_IDS.map((id) => entry.grammarWeights[id]),
      entry.bounds
    ]);
    const previousArchitecture = signatures.get(`architecture:${architectureSignature}`);
    if (previousArchitecture) problems.push(`District types "${previousArchitecture}" and "${entry.id}" have identical complete architecture signatures.`);
    signatures.set(`architecture:${architectureSignature}`, entry.id);
  }
  // Density infill grammars are intentionally absent from ordinary district weights:
  // they are reachable only through the bounded anonymous-residual pass. Validate that
  // each still has at least one compatible district envelope before counting it.
  for (const id of INFILL_BUILDING_GRAMMAR_IDS) {
    const definition = BUILDING_GRAMMAR_REGISTRY.get(id)!;
    const compatible = entries.some((entry) =>
      definition.compatibilityTags.some((tag) => entry.compatibilityTags.includes(tag))
      && buildingFitsEnvelope(entry.bounds, definition)
    );
    if (compatible) reachableBuildings.add(id);
    else problems.push(`Density infill building grammar "${id}" has no compatible district envelope.`);
  }
  for (const id of DISTRICT_TYPE_IDS) if (!ids.has(id)) problems.push(`District type "${id}" is unreachable.`);
  for (const id of BLOCK_GRAMMAR_IDS) if (!reachable.has(id)) problems.push(`Block grammar "${id}" is unreachable.`);
  for (const id of BUILDING_GRAMMAR_IDS) if (!reachableBuildings.has(id)) problems.push(`Building grammar "${id}" is unreachable.`);
  return { ok: problems.length === 0, problems };
}

export function districtTypeById(id: DistrictTypeId): DistrictTypeDefinition {
  const entry = DISTRICT_TYPE_REGISTRY.get(id);
  if (!entry) throw new Error(`Unknown district type "${id}".`);
  return entry;
}
