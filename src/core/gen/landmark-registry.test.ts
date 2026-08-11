import { describe, expect, it } from "vitest";
import { LANDMARK_GRAMMAR_IDS, LANDMARK_GRAMMARS, LANDMARK_GRAMMAR_REGISTRY, validateLandmarkRegistry } from "./landmark-registry.js";
import { DISTRICT_TYPES } from "./district-registry.js";

describe("landmark grammar registry", () => {
  it("ships exactly the four curated landmark grammars with valid distinct signatures", () => {
    expect(LANDMARK_GRAMMAR_IDS).toEqual(["hero-tower-plaza", "civic-corporate-compound", "infrastructure-utility-site", "monument-open-space"]);
    expect(LANDMARK_GRAMMARS.map((entry) => entry.id)).toEqual(LANDMARK_GRAMMAR_IDS);
    expect(validateLandmarkRegistry()).toEqual({ ok: true, problems: [] });
  });

  it("requires an approach plaza for the hero tower and valid templates everywhere", () => {
    const hero = LANDMARK_GRAMMAR_REGISTRY.get("hero-tower-plaza")!;
    expect(hero.requiredOpenSpace?.category).toBe("plaza");
    expect(hero.requiredOpenSpace?.minShare).toBeGreaterThan(0);
    for (const entry of LANDMARK_GRAMMARS) {
      expect(entry.massTemplates.length, entry.id).toBeGreaterThan(0);
      for (const template of entry.massTemplates) {
        expect(template.widthFactor, entry.id).toBeGreaterThan(0);
        expect(template.depthFactor, entry.id).toBeGreaterThan(0);
        expect(template.heightMinM, entry.id).toBeGreaterThan(0);
        expect(template.heightMinM, entry.id).toBeLessThanOrEqual(template.heightMaxM);
      }
      expect(entry.facadeProfiles.length, entry.id).toBeGreaterThan(0);
      expect(entry.rooflines.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("declares site area limits that keep all four grammars placeable on a large fixture", () => {
    const largest = Math.max(...LANDMARK_GRAMMARS.map((entry) => entry.minSiteAreaM2));
    expect(largest).toBeLessThanOrEqual(5000);
  });

  it("keeps every landmark grammar pairable with at least one shipping district tag", () => {
    const districtTags = new Set(DISTRICT_TYPES.flatMap((district) => district.compatibilityTags));
    for (const grammar of LANDMARK_GRAMMARS) {
      expect(grammar.compatibilityTags.length, grammar.id).toBeGreaterThan(0);
      expect(grammar.compatibilityTags.some((tag) => districtTags.has(tag)), grammar.id).toBe(true);
    }
  });
});
