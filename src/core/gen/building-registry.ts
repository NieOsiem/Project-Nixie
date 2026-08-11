import type { DistrictCompatibilityTag } from "./district-registry.js";

/**
 * Phase 4 building grammar registry.
 *
 * 24 materially distinct grammars spanning the seven required footprint archetypes,
 * each declaring compatible district tags, site/parcel limits, footprint/setback rules,
 * height and skyline ranges, massing rules, roofline/facade/signage/rooftop/wear
 * profiles, compatible visual uses, material slot weights, and geometry policy.
 *
 * This registry is pure data: mass generation happens in complete-city-plan.ts and the
 * renderer consumes BuildingPlan only.
 */

export const FOOTPRINT_ARCHETYPE_IDS = [
  "rectangle",
  "trapezoid",
  "l-shape",
  "u-shape",
  "courtyard",
  "podium",
  "compound"
] as const;

export type FootprintArchetypeId = (typeof FOOTPRINT_ARCHETYPE_IDS)[number];

export const BUILDING_USE_IDS = [
  "residential",
  "commercial",
  "mixed-use",
  "industrial",
  "logistics",
  "civic",
  "entertainment",
  "utility"
] as const;

export type BuildingUseId = (typeof BUILDING_USE_IDS)[number];

export const BUILDING_GRAMMAR_IDS = [
  // rectangle
  "narrow-shopfront",
  "residential-slab",
  "stacked-workshop",
  "industrial-shed",
  "civic-pavilion",
  // trapezoid
  "corner-flatiron",
  "wedge-office",
  "waterfront-step",
  // l-shape
  "residential-wing",
  "market-corner",
  "service-court-works",
  // u-shape
  "residential-court",
  "civic-entry-court",
  "industrial-loading-court",
  // courtyard / perimeter
  "dense-perimeter-block",
  "old-city-courtyard",
  "megablock-ring",
  "corporate-atrium-block",
  // podium
  "corporate-tower-podium",
  "commercial-twin-tower-podium",
  "entertainment-signage-podium",
  "civic-tower-plinth",
  // clustered compound
  "utility-service-cluster",
  "derelict-reclamation-cluster"
] as const;

export type BuildingGrammarId = (typeof BUILDING_GRAMMAR_IDS)[number];

export const ROOFLINE_IDS = [
  "flat",
  "parapet",
  "stepped",
  "sawtooth",
  "gable",
  "curved",
  "terrace",
  "crown",
  "shed",
  "domed"
] as const;

export const FACADE_PROFILE_IDS = [
  "shopfront",
  "office-grid",
  "residential-balcony",
  "industrial-panel",
  "civic-columns",
  "warehouse-ribs",
  "entertainment-arcade",
  "utility-louvre",
  "glass-curtain",
  "masonry-window"
] as const;

export const SIGNAGE_PROFILE_IDS = [
  "none",
  "minimal",
  "storefront",
  "neon-bands",
  "marquee",
  "billboard",
  "utility-marking"
] as const;

export const ROOFTOP_UTILITY_IDS = [
  "none",
  "ac-unit",
  "water-tank",
  "antenna",
  "cooling-tower",
  "solar",
  "mechanical",
  "crane",
  "flare"
] as const;

export const WEAR_PROFILE_IDS = [
  "pristine",
  "clean",
  "worn",
  "weathered",
  "derelict"
] as const;

export interface BuildingSiteLimits {
  minWidthM: number;
  maxWidthM: number;
  minDepthM: number;
  maxDepthM: number;
  minAreaM2: number;
  maxAreaM2: number;
  minAspect: number;
  maxAspect: number;
}

export type WeightTriple = readonly [number, number, number];
export type WeightPair = readonly [number, number];

export interface BuildingGrammarDefinition {
  id: BuildingGrammarId;
  label: string;
  archetype: FootprintArchetypeId;
  compatibilityTags: readonly DistrictCompatibilityTag[];
  siteLimits: BuildingSiteLimits;
  footprint: { occupancyMin: number; occupancyMax: number; setbackMin: number; setbackMax: number };
  height: { minM: number; maxM: number; skylineBias: number };
  massing: { minMasses: number; maxMasses: number; mainWidthFactor: number; mainDepthFactor: number };
  rooflines: readonly string[];
  facadeProfiles: readonly string[];
  signage: { rateMin: number; rateMax: number };
  rooftopUtility: { rateMin: number; rateMax: number };
  wear: { min: number; max: number };
  compatibleUses: readonly BuildingUseId[];
  materialSlots: { wall: WeightTriple; roof: WeightTriple; neon: WeightPair };
  geometryPolicy: { coarse: "silhouette" | "volumes"; detail: "facade" | "rooftop" | "none"; neon: boolean };
}

const grammar = (
  id: BuildingGrammarId,
  label: string,
  archetype: FootprintArchetypeId,
  compatibilityTags: readonly DistrictCompatibilityTag[],
  siteLimits: BuildingSiteLimits,
  footprint: { occupancyMin: number; occupancyMax: number; setbackMin: number; setbackMax: number },
  height: { minM: number; maxM: number; skylineBias: number },
  massing: { minMasses: number; maxMasses: number; mainWidthFactor: number; mainDepthFactor: number },
  rooflines: readonly string[],
  facadeProfiles: readonly string[],
  signage: { rateMin: number; rateMax: number },
  rooftopUtility: { rateMin: number; rateMax: number },
  wear: { min: number; max: number },
  compatibleUses: readonly BuildingUseId[],
  materialSlots: { wall: WeightTriple; roof: WeightTriple; neon: WeightPair },
  geometryPolicy: { coarse: "silhouette" | "volumes"; detail: "facade" | "rooftop" | "none"; neon: boolean }
): BuildingGrammarDefinition => Object.freeze({
  id,
  label,
  archetype,
  compatibilityTags: Object.freeze([...compatibilityTags]),
  siteLimits: Object.freeze({ ...siteLimits }),
  footprint: Object.freeze({ ...footprint }),
  height: Object.freeze({ ...height }),
  massing: Object.freeze({ ...massing }),
  rooflines: Object.freeze([...rooflines]),
  facadeProfiles: Object.freeze([...facadeProfiles]),
  signage: Object.freeze({ ...signage }),
  rooftopUtility: Object.freeze({ ...rooftopUtility }),
  wear: Object.freeze({ ...wear }),
  compatibleUses: Object.freeze([...compatibleUses]),
  materialSlots: Object.freeze({
    wall: Object.freeze([...materialSlots.wall]) as WeightTriple,
    roof: Object.freeze([...materialSlots.roof]) as WeightTriple,
    neon: Object.freeze([...materialSlots.neon]) as WeightPair
  }),
  geometryPolicy: Object.freeze({ ...geometryPolicy })
});

export const BUILDING_GRAMMARS: readonly BuildingGrammarDefinition[] = Object.freeze([
  grammar("narrow-shopfront", "Narrow Shopfront", "rectangle", ["fine-grain", "market"], { minWidthM: 8, maxWidthM: 16, minDepthM: 12, maxDepthM: 30, minAreaM2: 100, maxAreaM2: 480, minAspect: 0.25, maxAspect: 3.2 }, { occupancyMin: 0.88, occupancyMax: 0.98, setbackMin: 0.2, setbackMax: 0.8 }, { minM: 6, maxM: 26, skylineBias: 0.15 }, { minMasses: 1, maxMasses: 1, mainWidthFactor: 0.96, mainDepthFactor: 0.92 }, ["parapet", "gable", "shed"], ["shopfront", "masonry-window", "entertainment-arcade"], { rateMin: 0.5, rateMax: 0.95 }, { rateMin: 0.05, rateMax: 0.35 }, { min: 0.25, max: 0.6 }, ["commercial", "entertainment", "mixed-use"], { wall: [0.55, 0.3, 0.15], roof: [0.6, 0.25, 0.15], neon: [0.35, 0.65] }, { coarse: "silhouette", detail: "facade", neon: true }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("residential-slab", "Residential Slab", "rectangle", ["residential", "fine-grain", "waterfront"], { minWidthM: 12, maxWidthM: 50, minDepthM: 10, maxDepthM: 29, minAreaM2: 140, maxAreaM2: 1450, minAspect: 0.6, maxAspect: 4 }, { occupancyMin: 0.7, occupancyMax: 0.9, setbackMin: 0.5, setbackMax: 1.8 }, { minM: 14, maxM: 90, skylineBias: 0.45 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.94, mainDepthFactor: 0.84 }, ["flat", "parapet", "stepped"], ["residential-balcony", "masonry-window", "office-grid"], { rateMin: 0.02, rateMax: 0.2 }, { rateMin: 0.5, rateMax: 0.95 }, { min: 0.1, max: 0.45 }, ["residential", "mixed-use"], { wall: [0.62, 0.26, 0.12], roof: [0.65, 0.25, 0.1], neon: [0.62, 0.38] }, { coarse: "volumes", detail: "facade", neon: false }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("stacked-workshop", "Stacked Workshop", "rectangle", ["industrial", "irregular"], { minWidthM: 10, maxWidthM: 36, minDepthM: 14, maxDepthM: 50, minAreaM2: 150, maxAreaM2: 1800, minAspect: 0.3, maxAspect: 2.6 }, { occupancyMin: 0.78, occupancyMax: 0.94, setbackMin: 0.5, setbackMax: 1.8 }, { minM: 8, maxM: 42, skylineBias: 0.25 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.94, mainDepthFactor: 0.88 }, ["sawtooth", "flat", "shed"], ["industrial-panel", "utility-louvre", "warehouse-ribs"], { rateMin: 0.02, rateMax: 0.18 }, { rateMin: 0.6, rateMax: 1 }, { min: 0.35, max: 0.75 }, ["industrial", "utility", "logistics"], { wall: [0.7, 0.2, 0.1], roof: [0.56, 0.3, 0.14], neon: [0.6, 0.4] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  // Tuned: capped size so sheds don't become 70m monoliths
  grammar("industrial-shed", "Industrial Shed", "rectangle", ["industrial"], { minWidthM: 20, maxWidthM: 50, minDepthM: 24, maxDepthM: 55, minAreaM2: 500, maxAreaM2: 2500, minAspect: 0.35, maxAspect: 2.8 }, { occupancyMin: 0.75, occupancyMax: 0.94, setbackMin: 0.5, setbackMax: 2 }, { minM: 7, maxM: 22, skylineBias: 0.05 }, { minMasses: 1, maxMasses: 3, mainWidthFactor: 0.9, mainDepthFactor: 0.85 }, ["sawtooth", "shed", "gable"], ["warehouse-ribs", "industrial-panel", "utility-louvre"], { rateMin: 0.01, rateMax: 0.12 }, { rateMin: 0.7, rateMax: 1 }, { min: 0.4, max: 0.8 }, ["industrial", "logistics", "utility"], { wall: [0.66, 0.22, 0.12], roof: [0.5, 0.32, 0.18], neon: [0.55, 0.45] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  grammar("civic-pavilion", "Civic Pavilion", "rectangle", ["formal", "campus"], { minWidthM: 16, maxWidthM: 46, minDepthM: 12, maxDepthM: 34, minAreaM2: 220, maxAreaM2: 1500, minAspect: 0.5, maxAspect: 3 }, { occupancyMin: 0.55, occupancyMax: 0.8, setbackMin: 1.5, setbackMax: 4 }, { minM: 10, maxM: 42, skylineBias: 0.3 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.82, mainDepthFactor: 0.76 }, ["flat", "curved", "crown"], ["civic-columns", "glass-curtain", "masonry-window"], { rateMin: 0.02, rateMax: 0.2 }, { rateMin: 0.3, rateMax: 0.7 }, { min: 0.05, max: 0.3 }, ["civic", "mixed-use", "commercial"], { wall: [0.78, 0.17, 0.05], roof: [0.76, 0.2, 0.04], neon: [0.72, 0.28] }, { coarse: "volumes", detail: "facade", neon: false }),
  grammar("corner-flatiron", "Corner Flatiron", "trapezoid", ["fine-grain", "market", "irregular", "waterfront"], { minWidthM: 8, maxWidthM: 26, minDepthM: 12, maxDepthM: 36, minAreaM2: 100, maxAreaM2: 900, minAspect: 0.3, maxAspect: 2.8 }, { occupancyMin: 0.8, occupancyMax: 0.95, setbackMin: 0.3, setbackMax: 1.5 }, { minM: 12, maxM: 58, skylineBias: 0.6 }, { minMasses: 1, maxMasses: 1, mainWidthFactor: 0.9, mainDepthFactor: 0.86 }, ["parapet", "stepped", "crown"], ["glass-curtain", "masonry-window", "shopfront"], { rateMin: 0.15, rateMax: 0.6 }, { rateMin: 0.3, rateMax: 0.8 }, { min: 0.1, max: 0.5 }, ["commercial", "mixed-use", "entertainment", "residential"], { wall: [0.5, 0.32, 0.18], roof: [0.52, 0.3, 0.18], neon: [0.4, 0.6] }, { coarse: "silhouette", detail: "facade", neon: true }),
  grammar("wedge-office", "Wedge Office", "trapezoid", ["formal", "fine-grain"], { minWidthM: 14, maxWidthM: 40, minDepthM: 18, maxDepthM: 52, minAreaM2: 260, maxAreaM2: 2000, minAspect: 0.4, maxAspect: 2.4 }, { occupancyMin: 0.6, occupancyMax: 0.84, setbackMin: 2, setbackMax: 5 }, { minM: 24, maxM: 96, skylineBias: 0.75 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.84, mainDepthFactor: 0.8 }, ["flat", "stepped", "crown"], ["glass-curtain", "office-grid", "civic-columns"], { rateMin: 0.05, rateMax: 0.3 }, { rateMin: 0.4, rateMax: 0.85 }, { min: 0.05, max: 0.25 }, ["commercial", "civic", "mixed-use"], { wall: [0.6, 0.28, 0.12], roof: [0.62, 0.26, 0.12], neon: [0.58, 0.42] }, { coarse: "volumes", detail: "facade", neon: false }),
  grammar("waterfront-step", "Waterfront Step Building", "trapezoid", ["waterfront", "formal"], { minWidthM: 16, maxWidthM: 48, minDepthM: 12, maxDepthM: 40, minAreaM2: 200, maxAreaM2: 1900, minAspect: 0.35, maxAspect: 3.4 }, { occupancyMin: 0.55, occupancyMax: 0.82, setbackMin: 1, setbackMax: 3 }, { minM: 16, maxM: 68, skylineBias: 0.5 }, { minMasses: 1, maxMasses: 3, mainWidthFactor: 0.8, mainDepthFactor: 0.74 }, ["terrace", "stepped", "curved"], ["glass-curtain", "residential-balcony", "office-grid"], { rateMin: 0.05, rateMax: 0.35 }, { rateMin: 0.25, rateMax: 0.7 }, { min: 0.08, max: 0.4 }, ["mixed-use", "commercial", "residential", "entertainment"], { wall: [0.54, 0.3, 0.16], roof: [0.58, 0.28, 0.14], neon: [0.45, 0.55] }, { coarse: "volumes", detail: "facade", neon: true }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("residential-wing", "Residential Wing", "l-shape", ["residential", "campus"], { minWidthM: 18, maxWidthM: 62, minDepthM: 16, maxDepthM: 53, minAreaM2: 300, maxAreaM2: 3286, minAspect: 0.45, maxAspect: 2.6 }, { occupancyMin: 0.5, occupancyMax: 0.78, setbackMin: 1, setbackMax: 3 }, { minM: 12, maxM: 68, skylineBias: 0.35 }, { minMasses: 1, maxMasses: 1, mainWidthFactor: 0.84, mainDepthFactor: 0.78 }, ["flat", "parapet", "stepped"], ["residential-balcony", "masonry-window"], { rateMin: 0.02, rateMax: 0.15 }, { rateMin: 0.45, rateMax: 0.9 }, { min: 0.1, max: 0.45 }, ["residential", "mixed-use"], { wall: [0.6, 0.28, 0.12], roof: [0.64, 0.26, 0.1], neon: [0.65, 0.35] }, { coarse: "silhouette", detail: "facade", neon: false }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("market-corner", "Market Corner", "l-shape", ["market", "fine-grain", "irregular"], { minWidthM: 14, maxWidthM: 38, minDepthM: 14, maxDepthM: 41, minAreaM2: 200, maxAreaM2: 1558, minAspect: 0.35, maxAspect: 2.8 }, { occupancyMin: 0.78, occupancyMax: 0.94, setbackMin: 0.3, setbackMax: 1.2 }, { minM: 8, maxM: 38, skylineBias: 0.4 }, { minMasses: 1, maxMasses: 1, mainWidthFactor: 0.94, mainDepthFactor: 0.88 }, ["gable", "parapet", "shed"], ["shopfront", "entertainment-arcade", "masonry-window"], { rateMin: 0.4, rateMax: 0.9 }, { rateMin: 0.2, rateMax: 0.6 }, { min: 0.3, max: 0.7 }, ["commercial", "entertainment", "mixed-use"], { wall: [0.52, 0.32, 0.16], roof: [0.55, 0.3, 0.15], neon: [0.3, 0.7] }, { coarse: "silhouette", detail: "facade", neon: true }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("service-court-works", "Service Court Works", "l-shape", ["industrial"], { minWidthM: 22, maxWidthM: 72, minDepthM: 20, maxDepthM: 67, minAreaM2: 480, maxAreaM2: 4824, minAspect: 0.4, maxAspect: 2.4 }, { occupancyMin: 0.6, occupancyMax: 0.86, setbackMin: 1.5, setbackMax: 5 }, { minM: 6, maxM: 18, skylineBias: 0.05 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.86, mainDepthFactor: 0.8 }, ["sawtooth", "flat", "shed"], ["warehouse-ribs", "industrial-panel", "utility-louvre"], { rateMin: 0.01, rateMax: 0.1 }, { rateMin: 0.65, rateMax: 1 }, { min: 0.45, max: 0.85 }, ["industrial", "logistics", "utility"], { wall: [0.68, 0.22, 0.1], roof: [0.55, 0.3, 0.15], neon: [0.58, 0.42] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("residential-court", "Residential Court", "u-shape", ["residential", "campus", "fine-grain", "waterfront"], { minWidthM: 24, maxWidthM: 77, minDepthM: 20, maxDepthM: 62, minAreaM2: 520, maxAreaM2: 4774, minAspect: 0.45, maxAspect: 2.6 }, { occupancyMin: 0.48, occupancyMax: 0.76, setbackMin: 0.8, setbackMax: 2.5 }, { minM: 12, maxM: 60, skylineBias: 0.3 }, { minMasses: 1, maxMasses: 1, mainWidthFactor: 0.82, mainDepthFactor: 0.76 }, ["flat", "parapet", "stepped"], ["residential-balcony", "masonry-window"], { rateMin: 0.02, rateMax: 0.12 }, { rateMin: 0.4, rateMax: 0.85 }, { min: 0.1, max: 0.4 }, ["residential", "mixed-use"], { wall: [0.58, 0.3, 0.12], roof: [0.62, 0.27, 0.11], neon: [0.64, 0.36] }, { coarse: "silhouette", detail: "facade", neon: false }),
  grammar("civic-entry-court", "Civic Entry Court", "u-shape", ["formal", "campus"], { minWidthM: 30, maxWidthM: 72, minDepthM: 24, maxDepthM: 60, minAreaM2: 760, maxAreaM2: 4300, minAspect: 0.45, maxAspect: 2.4 }, { occupancyMin: 0.42, occupancyMax: 0.7, setbackMin: 2, setbackMax: 5 }, { minM: 14, maxM: 56, skylineBias: 0.35 }, { minMasses: 1, maxMasses: 1, mainWidthFactor: 0.8, mainDepthFactor: 0.74 }, ["flat", "crown", "curved"], ["civic-columns", "glass-curtain", "masonry-window"], { rateMin: 0.02, rateMax: 0.18 }, { rateMin: 0.3, rateMax: 0.7 }, { min: 0.04, max: 0.25 }, ["civic", "mixed-use"], { wall: [0.74, 0.2, 0.06], roof: [0.72, 0.22, 0.06], neon: [0.7, 0.3] }, { coarse: "volumes", detail: "facade", neon: false }),
  grammar("industrial-loading-court", "Industrial Loading Court", "u-shape", ["industrial"], { minWidthM: 34, maxWidthM: 84, minDepthM: 28, maxDepthM: 72, minAreaM2: 1000, maxAreaM2: 6000, minAspect: 0.4, maxAspect: 2.6 }, { occupancyMin: 0.5, occupancyMax: 0.8, setbackMin: 1, setbackMax: 3 }, { minM: 7, maxM: 20, skylineBias: 0.05 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.84, mainDepthFactor: 0.78 }, ["sawtooth", "shed", "flat"], ["warehouse-ribs", "industrial-panel", "utility-louvre"], { rateMin: 0.01, rateMax: 0.08 }, { rateMin: 0.7, rateMax: 1 }, { min: 0.4, max: 0.8 }, ["logistics", "industrial", "utility"], { wall: [0.65, 0.24, 0.11], roof: [0.52, 0.31, 0.17], neon: [0.57, 0.43] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("dense-perimeter-block", "Dense Perimeter Block", "courtyard", ["fine-grain", "residential", "market", "waterfront"], { minWidthM: 30, maxWidthM: 96, minDepthM: 26, maxDepthM: 84, minAreaM2: 820, maxAreaM2: 8064, minAspect: 0.4, maxAspect: 2.8 }, { occupancyMin: 0.7, occupancyMax: 0.92, setbackMin: 0.4, setbackMax: 1.8 }, { minM: 16, maxM: 78, skylineBias: 0.5 }, { minMasses: 3, maxMasses: 4, mainWidthFactor: 0.96, mainDepthFactor: 0.9 }, ["parapet", "stepped", "flat"], ["masonry-window", "residential-balcony", "shopfront", "office-grid"], { rateMin: 0.2, rateMax: 0.65 }, { rateMin: 0.35, rateMax: 0.85 }, { min: 0.15, max: 0.55 }, ["mixed-use", "residential", "commercial"], { wall: [0.56, 0.3, 0.14], roof: [0.6, 0.28, 0.12], neon: [0.42, 0.58] }, { coarse: "silhouette", detail: "facade", neon: true }),
  grammar("old-city-courtyard", "Old City Courtyard", "courtyard", ["irregular", "fine-grain", "market"], { minWidthM: 20, maxWidthM: 56, minDepthM: 18, maxDepthM: 50, minAreaM2: 380, maxAreaM2: 2800, minAspect: 0.4, maxAspect: 2.8 }, { occupancyMin: 0.68, occupancyMax: 0.9, setbackMin: 0.3, setbackMax: 1 }, { minM: 10, maxM: 40, skylineBias: 0.35 }, { minMasses: 3, maxMasses: 4, mainWidthFactor: 0.9, mainDepthFactor: 0.86 }, ["gable", "shed", "parapet"], ["masonry-window", "shopfront", "industrial-panel"], { rateMin: 0.15, rateMax: 0.55 }, { rateMin: 0.3, rateMax: 0.8 }, { min: 0.35, max: 0.75 }, ["residential", "commercial", "mixed-use", "entertainment"], { wall: [0.48, 0.34, 0.18], roof: [0.5, 0.32, 0.18], neon: [0.38, 0.62] }, { coarse: "silhouette", detail: "facade", neon: true }),
  // Tuned: near-zero setback enables enclosed courtyard formation
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("megablock-ring", "Residential Megablock Ring", "courtyard", ["residential", "campus"], { minWidthM: 48, maxWidthM: 120, minDepthM: 40, maxDepthM: 100, minAreaM2: 2000, maxAreaM2: 12000, minAspect: 0.45, maxAspect: 2.6 }, { occupancyMin: 0.4, occupancyMax: 0.68, setbackMin: 0.5, setbackMax: 2.5 }, { minM: 22, maxM: 110, skylineBias: 0.65 }, { minMasses: 3, maxMasses: 4, mainWidthFactor: 0.88, mainDepthFactor: 0.84 }, ["flat", "stepped", "parapet"], ["residential-balcony", "masonry-window", "glass-curtain"], { rateMin: 0.02, rateMax: 0.15 }, { rateMin: 0.5, rateMax: 0.95 }, { min: 0.08, max: 0.35 }, ["residential", "mixed-use"], { wall: [0.6, 0.28, 0.12], roof: [0.63, 0.26, 0.11], neon: [0.6, 0.4] }, { coarse: "volumes", detail: "facade", neon: false }),
  grammar("corporate-atrium-block", "Corporate Atrium Block", "courtyard", ["formal", "campus"], { minWidthM: 36, maxWidthM: 96, minDepthM: 30, maxDepthM: 84, minAreaM2: 1100, maxAreaM2: 8000, minAspect: 0.4, maxAspect: 2.8 }, { occupancyMin: 0.55, occupancyMax: 0.82, setbackMin: 2, setbackMax: 6 }, { minM: 28, maxM: 110, skylineBias: 0.8 }, { minMasses: 3, maxMasses: 4, mainWidthFactor: 0.9, mainDepthFactor: 0.86 }, ["flat", "crown", "curved"], ["glass-curtain", "office-grid", "civic-columns"], { rateMin: 0.05, rateMax: 0.25 }, { rateMin: 0.45, rateMax: 0.9 }, { min: 0.03, max: 0.2 }, ["commercial", "civic", "mixed-use"], { wall: [0.64, 0.26, 0.1], roof: [0.66, 0.24, 0.1], neon: [0.55, 0.45] }, { coarse: "volumes", detail: "facade", neon: false }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("corporate-tower-podium", "Corporate Tower and Podium", "podium", ["formal", "waterfront"], { minWidthM: 30, maxWidthM: 70, minDepthM: 28, maxDepthM: 66, minAreaM2: 900, maxAreaM2: 4600, minAspect: 0.45, maxAspect: 2.2 }, { occupancyMin: 0.62, occupancyMax: 0.88, setbackMin: 1, setbackMax: 3 }, { minM: 48, maxM: 240, skylineBias: 0.95 }, { minMasses: 2, maxMasses: 2, mainWidthFactor: 0.92, mainDepthFactor: 0.88 }, ["flat", "crown", "stepped"], ["glass-curtain", "office-grid", "civic-columns"], { rateMin: 0.08, rateMax: 0.4 }, { rateMin: 0.5, rateMax: 0.95 }, { min: 0.02, max: 0.15 }, ["commercial", "civic", "mixed-use"], { wall: [0.72, 0.2, 0.08], roof: [0.7, 0.22, 0.08], neon: [0.62, 0.38] }, { coarse: "volumes", detail: "facade", neon: false }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("commercial-twin-tower-podium", "Commercial Twin Towers on Podium", "podium", ["formal", "fine-grain", "waterfront"], { minWidthM: 36, maxWidthM: 84, minDepthM: 30, maxDepthM: 72, minAreaM2: 1100, maxAreaM2: 6000, minAspect: 0.45, maxAspect: 2.4 }, { occupancyMin: 0.58, occupancyMax: 0.85, setbackMin: 1, setbackMax: 3.5 }, { minM: 42, maxM: 200, skylineBias: 0.9 }, { minMasses: 3, maxMasses: 3, mainWidthFactor: 0.9, mainDepthFactor: 0.86 }, ["flat", "crown", "parapet"], ["glass-curtain", "office-grid", "shopfront"], { rateMin: 0.1, rateMax: 0.45 }, { rateMin: 0.45, rateMax: 0.9 }, { min: 0.03, max: 0.2 }, ["commercial", "mixed-use", "entertainment"], { wall: [0.66, 0.24, 0.1], roof: [0.64, 0.26, 0.1], neon: [0.5, 0.5] }, { coarse: "volumes", detail: "facade", neon: true }),
  // Scale boost: cyberpunk metropolis vertical scale
  grammar("entertainment-signage-podium", "Entertainment Signage Podium", "podium", ["market", "fine-grain", "waterfront"], { minWidthM: 24, maxWidthM: 72, minDepthM: 22, maxDepthM: 67, minAreaM2: 560, maxAreaM2: 4824, minAspect: 0.4, maxAspect: 2.6 }, { occupancyMin: 0.7, occupancyMax: 0.92, setbackMin: 0.5, setbackMax: 2.5 }, { minM: 18, maxM: 105, skylineBias: 0.7 }, { minMasses: 2, maxMasses: 3, mainWidthFactor: 0.9, mainDepthFactor: 0.86 }, ["parapet", "curved", "crown"], ["entertainment-arcade", "shopfront", "glass-curtain"], { rateMin: 0.5, rateMax: 1 }, { rateMin: 0.4, rateMax: 0.9 }, { min: 0.15, max: 0.5 }, ["entertainment", "commercial", "mixed-use"], { wall: [0.5, 0.32, 0.18], roof: [0.54, 0.3, 0.16], neon: [0.2, 0.8] }, { coarse: "volumes", detail: "facade", neon: true }),
  grammar("civic-tower-plinth", "Civic Tower on Plinth", "podium", ["formal", "campus"], { minWidthM: 28, maxWidthM: 66, minDepthM: 26, maxDepthM: 62, minAreaM2: 760, maxAreaM2: 4000, minAspect: 0.45, maxAspect: 2.3 }, { occupancyMin: 0.55, occupancyMax: 0.82, setbackMin: 2.5, setbackMax: 7 }, { minM: 34, maxM: 130, skylineBias: 0.85 }, { minMasses: 2, maxMasses: 2, mainWidthFactor: 0.88, mainDepthFactor: 0.84 }, ["flat", "crown", "domed"], ["civic-columns", "glass-curtain", "masonry-window"], { rateMin: 0.04, rateMax: 0.2 }, { rateMin: 0.4, rateMax: 0.85 }, { min: 0.04, max: 0.2 }, ["civic", "commercial", "mixed-use"], { wall: [0.76, 0.18, 0.06], roof: [0.74, 0.2, 0.06], neon: [0.66, 0.34] }, { coarse: "volumes", detail: "facade", neon: false }),
  // Tuned: was fragmenting large parcels into 4-8m micro-sheds; updated site limits to match tuned cell sizes
  grammar("utility-service-cluster", "Utility and Service Cluster", "compound", ["industrial", "campus"], { minWidthM: 16, maxWidthM: 60, minDepthM: 18, maxDepthM: 60, minAreaM2: 300, maxAreaM2: 3600, minAspect: 0.4, maxAspect: 2.8 }, { occupancyMin: 0.65, occupancyMax: 0.88, setbackMin: 1, setbackMax: 3 }, { minM: 6, maxM: 26, skylineBias: 0.1 }, { minMasses: 1, maxMasses: 2, mainWidthFactor: 0.8, mainDepthFactor: 0.74 }, ["flat", "shed", "sawtooth"], ["utility-louvre", "industrial-panel", "warehouse-ribs"], { rateMin: 0.02, rateMax: 0.2 }, { rateMin: 0.8, rateMax: 1 }, { min: 0.3, max: 0.7 }, ["utility", "industrial", "logistics"], { wall: [0.7, 0.2, 0.1], roof: [0.58, 0.28, 0.14], neon: [0.6, 0.4] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  // Tuned: 12m setback was exceeding 11m min cell width; updated site limits to match tuned cell sizes
  grammar("derelict-reclamation-cluster", "Derelict Reclamation Cluster", "compound", ["irregular", "industrial"], { minWidthM: 12, maxWidthM: 50, minDepthM: 14, maxDepthM: 50, minAreaM2: 180, maxAreaM2: 2500, minAspect: 0.35, maxAspect: 3 }, { occupancyMin: 0.55, occupancyMax: 0.8, setbackMin: 0.5, setbackMax: 2.5 }, { minM: 5, maxM: 22, skylineBias: 0.05 }, { minMasses: 1, maxMasses: 3, mainWidthFactor: 0.76, mainDepthFactor: 0.7 }, ["shed", "gable", "sawtooth"], ["industrial-panel", "warehouse-ribs", "masonry-window"], { rateMin: 0.01, rateMax: 0.12 }, { rateMin: 0.5, rateMax: 0.95 }, { min: 0.6, max: 1 }, ["industrial", "utility", "residential"], { wall: [0.62, 0.26, 0.12], roof: [0.55, 0.3, 0.15], neon: [0.55, 0.45] }, { coarse: "silhouette", detail: "rooftop", neon: false })
]);

export const BUILDING_GRAMMAR_REGISTRY: ReadonlyMap<BuildingGrammarId, BuildingGrammarDefinition> = new Map(
  BUILDING_GRAMMARS.map((entry) => [entry.id, entry])
);

/** Fallback weights for fragments with no district (unzoned land). */
export const UNZONED_BUILDING_GRAMMAR_WEIGHTS: Readonly<Record<BuildingGrammarId, number>> = Object.freeze(
  Object.fromEntries(BUILDING_GRAMMAR_IDS.map((id) => [
    id,
    id === "residential-slab" ? 0.28
      : id === "stacked-workshop" ? 0.22
        : id === "old-city-courtyard" ? 0.18
          : id === "derelict-reclamation-cluster" ? 0.16
            : id === "narrow-shopfront" ? 0.1
              : id === "service-court-works" ? 0.06
                : 0
  ])) as Record<BuildingGrammarId, number>
);

export interface BuildingRegistryValidation {
  ok: boolean;
  problems: string[];
}

export function validateBuildingRegistry(entries: readonly BuildingGrammarDefinition[] = BUILDING_GRAMMARS): BuildingRegistryValidation {
  const problems: string[] = [];
  const ids = new Set<BuildingGrammarId>();
  const signatures = new Map<string, BuildingGrammarId>();
  const archetypes = new Set<FootprintArchetypeId>();
  const uses = new Set<BuildingUseId>();
  const rooflines = new Set<string>();
  const facades = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push(`Duplicate building grammar id "${entry.id}".`);
    ids.add(entry.id);
    archetypes.add(entry.archetype);
    for (const use of entry.compatibleUses) uses.add(use);
    for (const id of entry.rooflines) rooflines.add(id);
    for (const id of entry.facadeProfiles) facades.add(id);
    const limits = entry.siteLimits;
    if (!(limits.minWidthM > 0 && limits.minWidthM <= limits.maxWidthM)) problems.push(`Grammar "${entry.id}" has invalid site width limits.`);
    if (!(limits.minDepthM > 0 && limits.minDepthM <= limits.maxDepthM)) problems.push(`Grammar "${entry.id}" has invalid site depth limits.`);
    if (!(limits.minAreaM2 > 0 && limits.minAreaM2 <= limits.maxAreaM2)) problems.push(`Grammar "${entry.id}" has invalid site area limits.`);
    if (!(limits.minAspect > 0 && limits.minAspect <= limits.maxAspect)) problems.push(`Grammar "${entry.id}" has invalid site aspect limits.`);
    if (!(entry.footprint.occupancyMin >= 0 && entry.footprint.occupancyMin <= entry.footprint.occupancyMax && entry.footprint.occupancyMax <= 1)) {
      problems.push(`Grammar "${entry.id}" has invalid footprint occupancy limits.`);
    }
    if (!(entry.footprint.setbackMin >= 0 && entry.footprint.setbackMin <= entry.footprint.setbackMax)) problems.push(`Grammar "${entry.id}" has invalid setback limits.`);
    if (!(entry.height.minM > 0 && entry.height.minM <= entry.height.maxM)) problems.push(`Grammar "${entry.id}" has invalid height limits.`);
    if (!(entry.height.skylineBias >= 0 && entry.height.skylineBias <= 1)) problems.push(`Grammar "${entry.id}" has an invalid skyline bias.`);
    if (!(entry.massing.minMasses >= 1 && entry.massing.minMasses <= entry.massing.maxMasses)) problems.push(`Grammar "${entry.id}" has invalid mass-count limits.`);
    if (!(entry.massing.mainWidthFactor > 0 && entry.massing.mainDepthFactor > 0)) problems.push(`Grammar "${entry.id}" has invalid massing factors.`);
    if (entry.rooflines.length === 0) problems.push(`Grammar "${entry.id}" declares no rooflines.`);
    if (entry.facadeProfiles.length === 0) problems.push(`Grammar "${entry.id}" declares no facade profiles.`);
    if (entry.compatibleUses.length === 0) problems.push(`Grammar "${entry.id}" declares no compatible visual uses.`);
    if (!(entry.signage.rateMin >= 0 && entry.signage.rateMin <= entry.signage.rateMax && entry.signage.rateMax <= 1)) problems.push(`Grammar "${entry.id}" has invalid signage rates.`);
    if (!(entry.rooftopUtility.rateMin >= 0 && entry.rooftopUtility.rateMin <= entry.rooftopUtility.rateMax && entry.rooftopUtility.rateMax <= 1)) {
      problems.push(`Grammar "${entry.id}" has invalid rooftop-utility rates.`);
    }
    if (!(entry.wear.min >= 0 && entry.wear.min <= entry.wear.max && entry.wear.max <= 1)) problems.push(`Grammar "${entry.id}" has invalid wear limits.`);
    const wall = entry.materialSlots.wall;
    const roof = entry.materialSlots.roof;
    const neon = entry.materialSlots.neon;
    if (wall.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(wall.reduce((sum, value) => sum + Math.abs(value), 0) - 1) > 1e-6) problems.push(`Grammar "${entry.id}" has invalid wall slot weights.`);
    if (roof.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(roof.reduce((sum, value) => sum + Math.abs(value), 0) - 1) > 1e-6) problems.push(`Grammar "${entry.id}" has invalid roof slot weights.`);
    if (neon.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(neon.reduce((sum, value) => sum + Math.abs(value), 0) - 1) > 1e-6) problems.push(`Grammar "${entry.id}" has invalid neon slot weights.`);
    const signature = JSON.stringify([
      entry.archetype,
      entry.compatibilityTags,
      entry.siteLimits,
      entry.footprint,
      entry.height,
      entry.massing,
      entry.rooflines,
      entry.facadeProfiles,
      entry.signage,
      entry.rooftopUtility,
      entry.wear,
      entry.compatibleUses,
      entry.materialSlots,
      entry.geometryPolicy
    ]);
    const previous = signatures.get(signature);
    if (previous) problems.push(`Building grammars "${previous}" and "${entry.id}" have identical complete signatures.`);
    signatures.set(signature, entry.id);
  }
  for (const id of BUILDING_GRAMMAR_IDS) if (!ids.has(id)) problems.push(`Building grammar "${id}" is unreachable.`);
  if (BUILDING_GRAMMAR_IDS.length < 24) problems.push(`At least 24 building grammars are required, found ${BUILDING_GRAMMAR_IDS.length}.`);
  for (const archetype of FOOTPRINT_ARCHETYPE_IDS) if (!archetypes.has(archetype)) problems.push(`Footprint archetype "${archetype}" is unreachable.`);
  for (const use of BUILDING_USE_IDS) if (!uses.has(use)) problems.push(`Building use "${use}" is unreachable.`);
  return { ok: problems.length === 0, problems };
}

export function buildingGrammarById(id: BuildingGrammarId): BuildingGrammarDefinition {
  const entry = BUILDING_GRAMMAR_REGISTRY.get(id);
  if (!entry) throw new Error(`Unknown building grammar "${id}".`);
  return entry;
}
