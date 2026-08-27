import { describe, expect, it } from "vitest";
import { LANDMARK_GRAMMAR_IDS, LANDMARK_GRAMMARS, LANDMARK_GRAMMAR_REGISTRY, PRE_ROAD_LANDMARK_GRAMMAR_IDS, validateLandmarkRegistry } from "./landmark-registry.js";
import { DISTRICT_TYPES } from "./district-registry.js";

describe("landmark grammar registry", () => {
  it("ships exactly sixteen curated landmark grammars with valid distinct signatures", () => {
    expect(LANDMARK_GRAMMAR_IDS).toEqual([
      "hero-tower-plaza",
      "civic-corporate-compound",
      "infrastructure-utility-site",
      "monument-open-space",
      "circular-beacon-tower",
      "tri-spire",
      "megaframe-block",
      "comms-mast-field",
      "arcology-terraces",
      "transit-hall",
      "stadium-bowl",
      "cooling-tower-yard",
      "garden-arcology",
      "event-plaza-pylon",
      "hex-corporate-hq",
      "logo-gateway"
    ]);
    expect(LANDMARK_GRAMMARS.map((entry) => entry.id)).toEqual(LANDMARK_GRAMMAR_IDS);
    expect(validateLandmarkRegistry()).toEqual({ ok: true, problems: [] });
  });

  it("pins eight unique overview-critical grammars for pre-road reservation", () => {
    expect(PRE_ROAD_LANDMARK_GRAMMAR_IDS).toEqual([
      "hero-tower-plaza",
      "civic-corporate-compound",
      "circular-beacon-tower",
      "tri-spire",
      "megaframe-block",
      "arcology-terraces",
      "hex-corporate-hq",
      "logo-gateway"
    ]);
    expect(new Set(PRE_ROAD_LANDMARK_GRAMMAR_IDS).size).toBe(8);
    expect(PRE_ROAD_LANDMARK_GRAMMAR_IDS.every((id) => LANDMARK_GRAMMAR_REGISTRY.has(id))).toBe(true);
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

  it("declares site area limits that keep all sixteen grammars placeable on a large fixture", () => {
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

  it("declares valid polygonal shapes, including true hexagonal and octagonal landmarks", () => {
    const beacon = LANDMARK_GRAMMAR_REGISTRY.get("circular-beacon-tower")!;
    expect(beacon.massTemplates.some((template) => (template.polygonSides ?? 0) >= 10)).toBe(true);
    const spire = LANDMARK_GRAMMAR_REGISTRY.get("tri-spire")!;
    expect(spire.massTemplates.every((template) => template.polygonSides === 3)).toBe(true);
    const frame = LANDMARK_GRAMMAR_REGISTRY.get("megaframe-block")!;
    expect(frame.massTemplates).toHaveLength(1);
    expect(frame.massTemplates[0]!.kind).toBe("megaframe");
    expect(frame.massTemplates[0]!.polygonSides).toBeUndefined();
    const cooling = LANDMARK_GRAMMAR_REGISTRY.get("cooling-tower-yard")!;
    expect(cooling.massTemplates[0]!.polygonSides).toBe(8);
    const hex = LANDMARK_GRAMMAR_REGISTRY.get("hex-corporate-hq")!;
    expect(hex.massTemplates.every((template) => template.polygonSides === 6)).toBe(true);
    // Rect grammars must never mix in polygonal templates: one branch owns each grammar.
    for (const entry of LANDMARK_GRAMMARS) {
      const polygonal = entry.massTemplates.some((template) => template.polygonSides !== undefined || template.kind === "megaframe");
      if (!["circular-beacon-tower", "tri-spire", "megaframe-block", "cooling-tower-yard", "hex-corporate-hq"].includes(entry.id)) {
        expect(polygonal, entry.id).toBe(false);
      }
    }
  });
});
