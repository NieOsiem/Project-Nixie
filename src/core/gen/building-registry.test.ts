import { describe, expect, it } from "vitest";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMARS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS, FOOTPRINT_ARCHETYPE_IDS, UNZONED_BUILDING_GRAMMAR_WEIGHTS, validateBuildingRegistry } from "./building-registry.js";
import { DISTRICT_TYPES } from "./district-registry.js";

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
});
