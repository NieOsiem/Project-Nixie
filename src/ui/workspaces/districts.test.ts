import { describe, expect, it } from "vitest";
import { BLOCK_GRAMMAR_IDS } from "../../core/gen/district-registry.js";
import { DISTRICT_TYPE_IDS } from "../editor-state.js";
import { allDistrictIds, districtEmptyTrayHTML, districtGalleryHTML, districtGalleryPreviews, districtGenerationAvailability, districtInspectorControlState, districtOverrideInputProblems } from "./districts.js";

describe("Districts workspace helpers", () => {
  it("requires a vehicle network and an empty district source", () => {
    expect(districtGenerationAvailability("supported", true, null).enabled).toBe(false);
    const city: any = { source: { roads: { edges: [] as any[] }, districts: [] as any[] } };
    expect(districtGenerationAvailability("supported", true, city).reason).toContain("vehicle road");
    city.source.roads.edges.push({ classId: "street" });
    expect(districtGenerationAvailability("supported", true, city).enabled).toBe(true);
    city.source.districts.push({ id: "d1" });
    expect(districtGenerationAvailability("supported", true, city).reason).toContain("already exist");
  });

  it("rejects an empty district pool", () => {
    const city = { source: { roads: { edges: [{ classId: "street" }] }, districts: [] } };
    expect(districtGenerationAvailability("supported", true, city, []).reason).toContain("at least one");
  });

  it("ships the fixed breadth IDs", () => {
    expect(DISTRICT_TYPE_IDS).toHaveLength(16);
    expect(new Set(DISTRICT_TYPE_IDS).size).toBe(16);
  });

  it("collects all district ids for the explicit destructive action", () => {
    expect(allDistrictIds({ source: { districts: [{ id: "b" }, { id: "a" }, { id: 4 }] } })).toEqual(["b", "a"]);
    expect(allDistrictIds(null)).toEqual([]);
    expect(districtEmptyTrayHTML()).toContain('data-action="district-delete-all"');
  });

  it("keeps the deterministic gallery broad across types and grammars", () => {
    const overview = districtGalleryPreviews("overview");
    const play = districtGalleryPreviews("play");
    expect(overview).toEqual(districtGalleryPreviews("overview"));
    expect(play).toEqual(districtGalleryPreviews("play"));
    expect(new Set(overview.map((entry) => entry.districtTypeId))).toEqual(new Set(DISTRICT_TYPE_IDS));
    expect(new Set(overview.map((entry) => entry.grammarId))).toEqual(new Set(BLOCK_GRAMMAR_IDS));
    expect(overview.every((entry) => entry.cellCount > 0 && entry.polygons.length === entry.cellCount)).toBe(true);
    expect(overview.every((entry, index) => entry.scale === 0.35 && play[index]?.scale === 1)).toBe(true);
  });

  it("renders the gallery as an in-tray, escaped, non-persistent view", () => {
    const html = districtGalleryHTML("overview");
    expect(html).toContain('data-panel="district-gallery"');
    expect(html).toContain('data-action="district-gallery-back"');
    expect(html).toContain('data-action="district-gallery-mode" data-mode="overview"');
    expect(html).toContain('data-action="district-gallery-mode" data-mode="play"');
    expect(html).toContain("No Scene data is changed.");
    expect(html).toContain("<svg");
    expect(html).toContain("aria-label=\"Corporate Core");
    expect(html).not.toContain("<script");
  });

  it("blocks Apply for malformed or invalid open-space overrides", () => {
    expect(districtOverrideInputProblems(0.3, "{", "{}")).toContain("Category weights must be valid JSON.");
    expect(districtOverrideInputProblems(0.3, "{}", "{}").length).toBeGreaterThan(0);
    expect(districtInspectorControlState(1, true, true, "explicit", undefined, true).applyEnabled).toBe(false);
  });
});
