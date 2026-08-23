import type { DistrictCompatibilityTag } from "./district-registry.js";
import type { OpenSpaceCategory } from "./city.js";

/**
 * Landmark grammar registry — ten curated landmark grammars: hero tower with required
 * approach plaza, civic/corporate multi-mass compound, infrastructure/utility site,
 * monument/special open-space composition, circular beacon tower, triangular spire,
 * megaframe block with courtyard void, communications mast field, arcology terraces,
 * and elevated transit hall.
 *
 * Pure data. Deterministic one-site placement and mass generation happen in
 * complete-city-plan.ts; every landmark uses exactly one derived site polygon.
 */

export const LANDMARK_GRAMMAR_IDS = [
  "hero-tower-plaza",
  "civic-corporate-compound",
  "infrastructure-utility-site",
  "monument-open-space",
  // New grammars are appended, never interleaved: reservation and fallback streams
  // iterate this tuple in order, so inserting before an existing id would reshuffle
  // which grid cells earlier grammars claim and silently change generated cities.
  "circular-beacon-tower",
  "tri-spire",
  "megaframe-block",
  "comms-mast-field",
  "arcology-terraces",
  "transit-hall"
] as const;

export type LandmarkGrammarId = (typeof LANDMARK_GRAMMAR_IDS)[number];

export interface LandmarkMassTemplate {
  kind: string;
  widthFactor: number;
  depthFactor: number;
  heightMinM: number;
  heightMaxM: number;
  /** 0 = sits on the ground; > 0 = stacked on top of the previous mass in the template chain. */
  elevationFactor: number;
  /**
   * Optional polygonal footprint override. When declared, the plan-side shape branch
   * emits this template's mass as a regular n-gon fitted into the template's oriented
   * bounding box instead of a rectangle; `widthFactor`/`depthFactor` keep their
   * bounding-box meaning. Members of one column share a seeded rotation, so stacked
   * setbacks stay aligned.
   */
  polygonSides?: number;
}

export interface LandmarkGrammarDefinition {
  id: LandmarkGrammarId;
  label: string;
  compatibilityTags: readonly DistrictCompatibilityTag[];
  minSiteAreaM2: number;
  maxSiteAreaM2: number;
  /** Open space the landmark requires inside its own site; overrides global `none`. */
  requiredOpenSpace: { category: OpenSpaceCategory; minShare: number } | null;
  massTemplates: readonly LandmarkMassTemplate[];
  facadeProfiles: readonly string[];
  rooflines: readonly string[];
  signage: { rateMin: number; rateMax: number };
  rooftopUtility: { rateMin: number; rateMax: number };
  wear: { min: number; max: number };
  materialSlots: { wall: readonly [number, number, number]; roof: readonly [number, number, number]; neon: readonly [number, number] };
  geometryPolicy: { coarse: "silhouette" | "volumes"; detail: "facade" | "rooftop" | "none"; neon: boolean };
}

const landmark = (
  id: LandmarkGrammarId,
  label: string,
  compatibilityTags: readonly DistrictCompatibilityTag[],
  minSiteAreaM2: number,
  maxSiteAreaM2: number,
  requiredOpenSpace: { category: OpenSpaceCategory; minShare: number } | null,
  massTemplates: readonly LandmarkMassTemplate[],
  facadeProfiles: readonly string[],
  rooflines: readonly string[],
  signage: { rateMin: number; rateMax: number },
  rooftopUtility: { rateMin: number; rateMax: number },
  wear: { min: number; max: number },
  materialSlots: { wall: readonly [number, number, number]; roof: readonly [number, number, number]; neon: readonly [number, number] },
  geometryPolicy: { coarse: "silhouette" | "volumes"; detail: "facade" | "rooftop" | "none"; neon: boolean }
): LandmarkGrammarDefinition => Object.freeze({
  id,
  label,
  compatibilityTags: Object.freeze([...compatibilityTags]),
  minSiteAreaM2,
  maxSiteAreaM2,
  requiredOpenSpace,
  massTemplates: Object.freeze(massTemplates.map((template) => Object.freeze({ ...template }))),
  facadeProfiles: Object.freeze([...facadeProfiles]),
  rooflines: Object.freeze([...rooflines]),
  signage: Object.freeze({ ...signage }),
  rooftopUtility: Object.freeze({ ...rooftopUtility }),
  wear: Object.freeze({ ...wear }),
  materialSlots: Object.freeze({
    wall: Object.freeze([...materialSlots.wall]) as readonly [number, number, number],
    roof: Object.freeze([...materialSlots.roof]) as readonly [number, number, number],
    neon: Object.freeze([...materialSlots.neon]) as readonly [number, number]
  }),
  geometryPolicy: Object.freeze({ ...geometryPolicy })
});

export const LANDMARK_GRAMMARS: readonly LandmarkGrammarDefinition[] = Object.freeze([
  landmark("hero-tower-plaza", "Hero Tower with Approach Plaza", ["formal", "waterfront"], 900, 6500, { category: "plaza", minShare: 0.18 }, [
    { kind: "podium", widthFactor: 0.62, depthFactor: 0.62, heightMinM: 9, heightMaxM: 16, elevationFactor: 0 },
    { kind: "tower", widthFactor: 0.24, depthFactor: 0.24, heightMinM: 72, heightMaxM: 150, elevationFactor: 0.55 },
    { kind: "crown", widthFactor: 0.14, depthFactor: 0.14, heightMinM: 8, heightMaxM: 18, elevationFactor: 0.92 }
  ], ["glass-curtain", "civic-columns", "office-grid"], ["flat", "crown", "curved"], { rateMin: 0.2, rateMax: 0.7 }, { rateMin: 0.5, rateMax: 0.95 }, { min: 0.02, max: 0.15 }, { wall: [0.7, 0.2, 0.1], roof: [0.68, 0.22, 0.1], neon: [0.55, 0.45] }, { coarse: "volumes", detail: "facade", neon: true }),
  landmark("civic-corporate-compound", "Civic or Corporate Compound", ["formal", "campus"], 1100, 8000, { category: "plaza", minShare: 0.12 }, [
    { kind: "hall", widthFactor: 0.52, depthFactor: 0.4, heightMinM: 14, heightMaxM: 28, elevationFactor: 0 },
    { kind: "pavilion", widthFactor: 0.3, depthFactor: 0.3, heightMinM: 8, heightMaxM: 16, elevationFactor: 0 },
    { kind: "tower", widthFactor: 0.18, depthFactor: 0.18, heightMinM: 36, heightMaxM: 84, elevationFactor: 0.2 }
  ], ["civic-columns", "glass-curtain", "masonry-window"], ["flat", "crown", "domed"], { rateMin: 0.05, rateMax: 0.35 }, { rateMin: 0.4, rateMax: 0.85 }, { min: 0.04, max: 0.25 }, { wall: [0.76, 0.18, 0.06], roof: [0.74, 0.2, 0.06], neon: [0.68, 0.32] }, { coarse: "volumes", detail: "facade", neon: false }),
  landmark("infrastructure-utility-site", "Infrastructure and Utility Site", ["industrial"], 1400, 11000, null, [
    { kind: "shed", widthFactor: 0.44, depthFactor: 0.32, heightMinM: 5, heightMaxM: 10, elevationFactor: 0 },
    { kind: "tank", widthFactor: 0.3, depthFactor: 0.3, heightMinM: 6, heightMaxM: 14, elevationFactor: 0 },
    { kind: "silo", widthFactor: 0.14, depthFactor: 0.14, heightMinM: 16, heightMaxM: 34, elevationFactor: 0 },
    { kind: "stack", widthFactor: 0.06, depthFactor: 0.06, heightMinM: 28, heightMaxM: 60, elevationFactor: 0 }
  ], ["utility-louvre", "industrial-panel", "warehouse-ribs"], ["flat", "shed", "sawtooth"], { rateMin: 0.02, rateMax: 0.2 }, { rateMin: 0.85, rateMax: 1 }, { min: 0.3, max: 0.7 }, { wall: [0.7, 0.2, 0.1], roof: [0.58, 0.28, 0.14], neon: [0.6, 0.4] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  landmark("monument-open-space", "Monument and Open Space Composition", ["irregular", "campus"], 800, 7000, { category: "park", minShare: 0.35 }, [
    { kind: "mound", widthFactor: 0.6, depthFactor: 0.6, heightMinM: 1.5, heightMaxM: 4, elevationFactor: 0 },
    { kind: "ring", widthFactor: 0.42, depthFactor: 0.42, heightMinM: 2, heightMaxM: 5, elevationFactor: 0.08 },
    { kind: "obelisk", widthFactor: 0.08, depthFactor: 0.08, heightMinM: 16, heightMaxM: 40, elevationFactor: 0.12 }
  ], ["masonry-window", "industrial-panel", "civic-columns"], ["flat", "curved", "crown"], { rateMin: 0.01, rateMax: 0.12 }, { rateMin: 0.1, rateMax: 0.4 }, { min: 0.25, max: 0.6 }, { wall: [0.58, 0.3, 0.12], roof: [0.6, 0.28, 0.12], neon: [0.62, 0.38] }, { coarse: "silhouette", detail: "none", neon: false }),
  // Polygonal grammars below are emitted by the plan-side shape branch: templates
  // declaring polygonSides become regular n-gons (one seeded rotation per column so
  // stacked setbacks align), and the single "megaframe" template expands into four
  // L-shaped corner masses tiling a rectangular frame around an open courtyard.
  landmark("circular-beacon-tower", "Circular Beacon Tower", ["formal", "waterfront"], 900, 6500, { category: "plaza", minShare: 0.15 }, [
    { kind: "podium", widthFactor: 0.58, depthFactor: 0.58, heightMinM: 8, heightMaxM: 14, elevationFactor: 0, polygonSides: 18 },
    { kind: "shaft", widthFactor: 0.34, depthFactor: 0.34, heightMinM: 64, heightMaxM: 140, elevationFactor: 0.6, polygonSides: 12 },
    { kind: "beacon", widthFactor: 0.16, depthFactor: 0.16, heightMinM: 10, heightMaxM: 22, elevationFactor: 0.9, polygonSides: 12 }
  ], ["glass-curtain", "office-grid", "civic-columns"], ["curved", "crown", "flat"], { rateMin: 0.25, rateMax: 0.75 }, { rateMin: 0.4, rateMax: 0.9 }, { min: 0.02, max: 0.12 }, { wall: [0.68, 0.22, 0.1], roof: [0.66, 0.24, 0.1], neon: [0.5, 0.5] }, { coarse: "volumes", detail: "facade", neon: true }),
  landmark("tri-spire", "Triangular Spire Tower", ["formal"], 800, 6000, null, [
    { kind: "base", widthFactor: 0.52, depthFactor: 0.52, heightMinM: 18, heightMaxM: 30, elevationFactor: 0, polygonSides: 3 },
    { kind: "mid-spire", widthFactor: 0.34, depthFactor: 0.34, heightMinM: 48, heightMaxM: 110, elevationFactor: 0.85, polygonSides: 3 },
    { kind: "tip", widthFactor: 0.14, depthFactor: 0.14, heightMinM: 12, heightMaxM: 28, elevationFactor: 0.92, polygonSides: 3 }
  ], ["glass-curtain", "office-grid"], ["crown", "flat", "stepped"], { rateMin: 0.15, rateMax: 0.55 }, { rateMin: 0.35, rateMax: 0.8 }, { min: 0.02, max: 0.14 }, { wall: [0.72, 0.2, 0.08], roof: [0.7, 0.22, 0.08], neon: [0.58, 0.42] }, { coarse: "volumes", detail: "facade", neon: true }),
  landmark("megaframe-block", "Megaframe Block", ["residential", "campus"], 1200, 9000, { category: "plaza", minShare: 0.08 }, [
    { kind: "megaframe", widthFactor: 0.86, depthFactor: 0.88, heightMinM: 26, heightMaxM: 64, elevationFactor: 0 }
  ], ["residential-balcony", "masonry-window", "glass-curtain"], ["flat", "parapet", "stepped"], { rateMin: 0.05, rateMax: 0.3 }, { rateMin: 0.5, rateMax: 0.9 }, { min: 0.06, max: 0.28 }, { wall: [0.6, 0.28, 0.12], roof: [0.62, 0.26, 0.12], neon: [0.55, 0.45] }, { coarse: "volumes", detail: "facade", neon: false }),
  landmark("comms-mast-field", "Communications Mast Field", ["industrial", "campus"], 1200, 10000, null, [
    { kind: "bunker", widthFactor: 0.4, depthFactor: 0.26, heightMinM: 5, heightMaxM: 9, elevationFactor: 0 },
    { kind: "mast", widthFactor: 0.05, depthFactor: 0.05, heightMinM: 90, heightMaxM: 210, elevationFactor: 0 },
    { kind: "equipment-shed", widthFactor: 0.3, depthFactor: 0.2, heightMinM: 4, heightMaxM: 8, elevationFactor: 0 },
    { kind: "dish-pad", widthFactor: 0.18, depthFactor: 0.18, heightMinM: 6, heightMaxM: 12, elevationFactor: 0 }
  ], ["utility-louvre", "industrial-panel", "warehouse-ribs"], ["flat", "shed"], { rateMin: 0.02, rateMax: 0.15 }, { rateMin: 0.85, rateMax: 1 }, { min: 0.25, max: 0.6 }, { wall: [0.66, 0.24, 0.1], roof: [0.56, 0.3, 0.14], neon: [0.6, 0.4] }, { coarse: "silhouette", detail: "rooftop", neon: false }),
  landmark("arcology-terraces", "Arcology Terraces", ["residential"], 1600, 9500, { category: "park", minShare: 0.12 }, [
    { kind: "terrace-base", widthFactor: 0.82, depthFactor: 0.74, heightMinM: 10, heightMaxM: 16, elevationFactor: 0 },
    { kind: "terrace-2", widthFactor: 0.68, depthFactor: 0.62, heightMinM: 10, heightMaxM: 16, elevationFactor: 0.9 },
    { kind: "terrace-3", widthFactor: 0.54, depthFactor: 0.5, heightMinM: 12, heightMaxM: 18, elevationFactor: 0.9 },
    { kind: "terrace-4", widthFactor: 0.4, depthFactor: 0.38, heightMinM: 14, heightMaxM: 20, elevationFactor: 0.9 },
    { kind: "terrace-crown", widthFactor: 0.26, depthFactor: 0.26, heightMinM: 16, heightMaxM: 26, elevationFactor: 0.9 }
  ], ["residential-balcony", "masonry-window", "office-grid"], ["terrace", "stepped", "flat"], { rateMin: 0.08, rateMax: 0.35 }, { rateMin: 0.45, rateMax: 0.85 }, { min: 0.04, max: 0.18 }, { wall: [0.58, 0.3, 0.12], roof: [0.56, 0.32, 0.12], neon: [0.52, 0.48] }, { coarse: "volumes", detail: "facade", neon: true }),
  landmark("transit-hall", "Elevated Transit Hall", ["waterfront", "market"], 1300, 8500, { category: "plaza", minShare: 0.2 }, [
    { kind: "vault", widthFactor: 0.3, depthFactor: 0.88, heightMinM: 12, heightMaxM: 20, elevationFactor: 0 },
    { kind: "vault", widthFactor: 0.3, depthFactor: 0.88, heightMinM: 12, heightMaxM: 20, elevationFactor: 0 },
    { kind: "vault", widthFactor: 0.3, depthFactor: 0.88, heightMinM: 12, heightMaxM: 20, elevationFactor: 0 }
  ], ["industrial-panel", "glass-curtain", "utility-louvre"], ["curved", "flat", "gable"], { rateMin: 0.1, rateMax: 0.4 }, { rateMin: 0.3, rateMax: 0.7 }, { min: 0.05, max: 0.2 }, { wall: [0.64, 0.26, 0.1], roof: [0.62, 0.28, 0.1], neon: [0.55, 0.45] }, { coarse: "silhouette", detail: "rooftop", neon: true })
]);

export const LANDMARK_GRAMMAR_REGISTRY: ReadonlyMap<LandmarkGrammarId, LandmarkGrammarDefinition> = new Map(
  LANDMARK_GRAMMARS.map((entry) => [entry.id, entry])
);

export interface LandmarkRegistryValidation {
  ok: boolean;
  problems: string[];
}

export function validateLandmarkRegistry(entries: readonly LandmarkGrammarDefinition[] = LANDMARK_GRAMMARS): LandmarkRegistryValidation {
  const problems: string[] = [];
  const ids = new Set<LandmarkGrammarId>();
  const signatures = new Map<string, LandmarkGrammarId>();
  const tags = new Set<DistrictCompatibilityTag>();
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push(`Duplicate landmark grammar id "${entry.id}".`);
    ids.add(entry.id);
    for (const tag of entry.compatibilityTags) tags.add(tag);
    if (!(entry.minSiteAreaM2 > 0 && entry.minSiteAreaM2 <= entry.maxSiteAreaM2)) problems.push(`Landmark grammar "${entry.id}" has invalid site area limits.`);
    if (entry.massTemplates.length === 0) problems.push(`Landmark grammar "${entry.id}" declares no mass templates.`);
    if (entry.facadeProfiles.length === 0) problems.push(`Landmark grammar "${entry.id}" declares no facade profiles.`);
    if (entry.rooflines.length === 0) problems.push(`Landmark grammar "${entry.id}" declares no rooflines.`);
    if (!(entry.signage.rateMin >= 0 && entry.signage.rateMin <= entry.signage.rateMax && entry.signage.rateMax <= 1)) problems.push(`Landmark grammar "${entry.id}" has invalid signage rates.`);
    if (!(entry.rooftopUtility.rateMin >= 0 && entry.rooftopUtility.rateMin <= entry.rooftopUtility.rateMax && entry.rooftopUtility.rateMax <= 1)) {
      problems.push(`Landmark grammar "${entry.id}" has invalid rooftop-utility rates.`);
    }
    if (!(entry.wear.min >= 0 && entry.wear.min <= entry.wear.max && entry.wear.max <= 1)) problems.push(`Landmark grammar "${entry.id}" has invalid wear limits.`);
    for (const template of entry.massTemplates) {
      if (!(template.widthFactor > 0 && template.depthFactor > 0 && template.heightMinM > 0 && template.heightMinM <= template.heightMaxM)) {
        problems.push(`Landmark grammar "${entry.id}" has an invalid mass template.`);
      }
      if (template.polygonSides !== undefined && !(Number.isInteger(template.polygonSides) && template.polygonSides >= 3 && template.polygonSides <= 24)) {
        problems.push(`Landmark grammar "${entry.id}" has an invalid polygonal mass template.`);
      }
    }
    const wall = entry.materialSlots.wall;
    const roof = entry.materialSlots.roof;
    const neon = entry.materialSlots.neon;
    if (wall.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(wall.reduce((sum, value) => sum + Math.abs(value), 0) - 1) > 1e-6) problems.push(`Landmark grammar "${entry.id}" has invalid wall slot weights.`);
    if (roof.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(roof.reduce((sum, value) => sum + Math.abs(value), 0) - 1) > 1e-6) problems.push(`Landmark grammar "${entry.id}" has invalid roof slot weights.`);
    if (neon.some((value) => !Number.isFinite(value) || value < 0) || Math.abs(neon.reduce((sum, value) => sum + Math.abs(value), 0) - 1) > 1e-6) problems.push(`Landmark grammar "${entry.id}" has invalid neon slot weights.`);
    const signature = JSON.stringify([
      entry.compatibilityTags,
      entry.minSiteAreaM2,
      entry.maxSiteAreaM2,
      entry.requiredOpenSpace,
      entry.massTemplates,
      entry.facadeProfiles,
      entry.rooflines,
      entry.signage,
      entry.rooftopUtility,
      entry.wear,
      entry.materialSlots,
      entry.geometryPolicy
    ]);
    const previous = signatures.get(signature);
    if (previous) problems.push(`Landmark grammars "${previous}" and "${entry.id}" have identical complete signatures.`);
    signatures.set(signature, entry.id);
  }
  for (const id of LANDMARK_GRAMMAR_IDS) if (!ids.has(id)) problems.push(`Landmark grammar "${id}" is unreachable.`);
  // The curated set grows over time; the invariant is a healthy minimum, not an exact
  // count. Reachability of every declared id is checked above.
  if (LANDMARK_GRAMMAR_IDS.length < 4) problems.push(`At least four landmark grammars are required, found ${LANDMARK_GRAMMAR_IDS.length}.`);
  const hero = LANDMARK_GRAMMAR_REGISTRY.get("hero-tower-plaza");
  if (hero && hero.requiredOpenSpace?.category !== "plaza") problems.push("The hero tower landmark grammar must require an approach plaza.");
  return { ok: problems.length === 0, problems };
}

export function landmarkGrammarById(id: LandmarkGrammarId): LandmarkGrammarDefinition {
  const entry = LANDMARK_GRAMMAR_REGISTRY.get(id);
  if (!entry) throw new Error(`Unknown landmark grammar "${id}".`);
  return entry;
}
