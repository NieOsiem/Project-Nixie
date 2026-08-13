import { describe, expect, it } from "vitest";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMARS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS, FOOTPRINT_ARCHETYPE_IDS, MICRO_BUILDING_GRAMMAR_IDS, TOWER_BUILDING_GRAMMAR_IDS, UNZONED_BUILDING_GRAMMAR_WEIGHTS, validateBuildingRegistry, type BuildingGrammarId } from "./building-registry.js";
import { DISTRICT_TYPES } from "./district-registry.js";

/**
 * Worst-case main-mass minor dimension a grammar can produce on a parcel at its
 * declared minimum site limits (maximum setback, minimum occupancy). Mirrors the
 * planner's thin-floor feasibility check.
 */
const minMassMinorAtMinimum = (entry: (typeof BUILDING_GRAMMARS)[number]): number => {
  const usableW = entry.siteLimits.minWidthM - 2 * entry.footprint.setbackMax;
  const usableH = entry.siteLimits.minDepthM - 2 * entry.footprint.setbackMax;
  const mainW = usableW * entry.frontage.widthFill;
  const mainH = entry.frontage.mode === "street-wall"
    ? usableH * entry.frontage.depthFill
    : usableH * entry.massing.mainDepthFactor * Math.sqrt(entry.footprint.occupancyMin);
  return Math.min(mainW, mainH);
};

describe("building grammar registry", () => {
  it("ships at least 24 stable grammars across all seven archetypes and all eight uses", () => {
    expect(BUILDING_GRAMMAR_IDS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(BUILDING_GRAMMAR_IDS).size).toBe(BUILDING_GRAMMAR_IDS.length);
    expect(BUILDING_GRAMMARS.map((entry) => entry.id)).toEqual(BUILDING_GRAMMAR_IDS);
    expect(new Set(BUILDING_GRAMMARS.map((entry) => entry.archetype))).toEqual(new Set(FOOTPRINT_ARCHETYPE_IDS));
    const uses = new Set(BUILDING_GRAMMARS.flatMap((entry) => entry.compatibleUses));
    expect([...uses].sort()).toEqual([...BUILDING_USE_IDS].sort());
    expect(validateBuildingRegistry()).toEqual({ ok: true, problems: [] });
  });

  it("declares valid limits, profiles, rates, and normalized material slots for every grammar", () => {
    for (const entry of BUILDING_GRAMMARS) {
      expect(entry.siteLimits.minWidthM, entry.id).toBeGreaterThan(0);
      expect(entry.siteLimits.minWidthM, entry.id).toBeLessThanOrEqual(entry.siteLimits.maxWidthM);
      expect(entry.siteLimits.minAreaM2, entry.id).toBeGreaterThan(0);
      expect(entry.footprint.occupancyMin, entry.id).toBeGreaterThanOrEqual(0);
      expect(entry.footprint.occupancyMin, entry.id).toBeLessThanOrEqual(entry.footprint.occupancyMax);
      expect(entry.height.minM, entry.id).toBeGreaterThan(0);
      expect(entry.height.minM, entry.id).toBeLessThanOrEqual(entry.height.maxM);
      expect(entry.rooflines.length, entry.id).toBeGreaterThan(0);
      expect(entry.facadeProfiles.length, entry.id).toBeGreaterThan(0);
      expect(entry.compatibleUses.length, entry.id).toBeGreaterThan(0);
      const wallSum = entry.materialSlots.wall.reduce((sum, value) => sum + value, 0);
      const roofSum = entry.materialSlots.roof.reduce((sum, value) => sum + value, 0);
      const neonSum = entry.materialSlots.neon.reduce((sum, value) => sum + value, 0);
      expect(wallSum, entry.id).toBeCloseTo(1, 6);
      expect(roofSum, entry.id).toBeCloseTo(1, 6);
      expect(neonSum, entry.id).toBeCloseTo(1, 6);
    }
  });

  it("keeps every grammar reachable from at least one shipping district and every district at four or more grammars", () => {
    const reachable = new Set<string>();
    for (const district of DISTRICT_TYPES) {
      const active = BUILDING_GRAMMAR_IDS.filter((id) => (district.buildingGrammarWeights[id] ?? 0) > 0);
      expect(active.length, district.id).toBeGreaterThanOrEqual(4);
      for (const id of active) reachable.add(id);
    }
    expect([...reachable].sort()).toEqual([...BUILDING_GRAMMAR_IDS].sort());
  });

  it("provides a valid fallback weight table for unzoned land", () => {
    const keys = Object.keys(UNZONED_BUILDING_GRAMMAR_WEIGHTS).sort();
    expect(keys).toEqual([...BUILDING_GRAMMAR_IDS].sort());
    const total = BUILDING_GRAMMAR_IDS.reduce((sum, id) => sum + UNZONED_BUILDING_GRAMMAR_WEIGHTS[id], 0);
    expect(total).toBeGreaterThan(0);
    expect(BUILDING_GRAMMAR_IDS.every((id) => UNZONED_BUILDING_GRAMMAR_WEIGHTS[id] >= 0)).toBe(true);
  });

  it("resolves every grammar id through the registry", () => {
    for (const id of BUILDING_GRAMMAR_IDS) {
      expect(BUILDING_GRAMMAR_REGISTRY.get(id)?.id).toBe(id);
    }
  });

  it("raises the low/middle height floors while preserving every maximum cap", () => {
    const floors: Partial<Record<BuildingGrammarId, number>> = {
      "narrow-shopfront": 20,
      "market-corner": 18,
      "old-city-courtyard": 18,
      "narrow-strip": 12,
      "industrial-shed": 14,
      "service-court-works": 12,
      "industrial-loading-court": 12,
      "utility-service-cluster": 12,
      "derelict-reclamation-cluster": 11,
      "street-kiosk": 6,
      "garage-unit": 6,
      "shack-shanty": 6,
      "utility-kiosk": 6,
      "campus-annex": 10
    };
    for (const [id, floor] of Object.entries(floors) as [BuildingGrammarId, number][]) {
      expect(BUILDING_GRAMMAR_REGISTRY.get(id)!.height.minM, id).toBeGreaterThanOrEqual(floor);
    }
    // Maximum caps are untouched: the tallest shipping caps stay exactly where they are.
    const caps: Partial<Record<BuildingGrammarId, number>> = {
      "corporate-tower-podium": 400,
      "commercial-twin-tower-podium": 360,
      "corporate-atrium-block": 200,
      "corner-flatiron": 190,
      "wedge-office": 180,
      "residential-slab": 170,
      "narrow-shopfront": 48,
      "street-kiosk": 14
    };
    for (const [id, cap] of Object.entries(caps) as [BuildingGrammarId, number][]) {
      expect(BUILDING_GRAMMAR_REGISTRY.get(id)!.height.maxM, id).toBe(cap);
    }
  });

  it("pins the deliberate tower outliers that escape block height coherence", () => {
    expect([...TOWER_BUILDING_GRAMMAR_IDS].sort()).toEqual([
      "civic-tower-plinth",
      "commercial-twin-tower-podium",
      "corporate-atrium-block",
      "corporate-tower-podium",
      "entertainment-signage-podium"
    ]);
  });

  it("keeps every non-micro grammar able to host a six-metre mass at its declared minimum limits", () => {
    // The emission floor (MIN_MASS_MINOR_DIMENSION_M = 6) applies to every ordinary
    // grammar: even at its declared maximum setback and minimum occupancy, a parcel at
    // the grammar's minimum site size must still produce a mass whose oriented minor
    // dimension reaches 6 m. Micro grammars fill sub-floor slivers intentionally.
    for (const entry of BUILDING_GRAMMARS) {
      if (MICRO_BUILDING_GRAMMAR_IDS.has(entry.id)) continue;
      expect(minMassMinorAtMinimum(entry), entry.id).toBeGreaterThanOrEqual(6);
    }
  });

  it("raises the narrow-strip floor into a visually credible width range", () => {
    const limits = BUILDING_GRAMMAR_REGISTRY.get("narrow-strip")!.siteLimits;
    expect(limits.minWidthM).toBeGreaterThanOrEqual(7);
    expect(limits.maxWidthM).toBeLessThanOrEqual(14);
    expect(limits.minWidthM).toBeLessThanOrEqual(limits.maxWidthM);
    // Still a strip grammar: depth runs at least twice the width, so it hugs long
    // narrow parcels between parallel roads instead of squat boxes.
    expect(limits.minAspect).toBeLessThanOrEqual(0.5);
    expect(limits.maxAspect).toBeLessThanOrEqual(0.5);
    expect(limits.minDepthM).toBeGreaterThanOrEqual(2 * limits.minWidthM);
  });
});
