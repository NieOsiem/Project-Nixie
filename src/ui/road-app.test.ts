import { describe, expect, it } from "vitest";
import { allRoadEdgeIds, roadGenerationActionsHTML, roadGenerationAvailability, roadSelectionActionsEnabled } from "./road-app.js";

describe("Roads application generation state", () => {
  it("requires terrain before enabling initial road generation", () => {
    expect(roadGenerationAvailability("supported", true, null)).toEqual({
      enabled: false,
      reason: "Create a rectangle or coastal terrain first.",
      roadCount: 0
    });
  });

  it("explains why an existing network cannot be regenerated", () => {
    const city = { source: { roads: { edges: [{ id: "edge-1" }, { id: "edge-2" }] } } };
    expect(roadGenerationAvailability("supported", true, city)).toEqual({
      enabled: false,
      reason: "This Scene already has 2 road segments. Delete them before generating an initial network.",
      roadCount: 2
    });
  });

  it("enables generation only for an empty supported Scene", () => {
    expect(roadGenerationAvailability("supported", true, { source: { roads: { edges: [] } } })).toEqual({
      enabled: true,
      reason: "Terrain is ready. Generate the initial network once, then edit it in Roads.",
      roadCount: 0
    });
  });

  it("keeps road actions enabled for a multi-selection", () => {
    expect(roadSelectionActionsEnabled(true, 2)).toBe(true);
    expect(roadSelectionActionsEnabled(true, 0)).toBe(false);
    expect(roadSelectionActionsEnabled(false, 2)).toBe(false);
  });

  it("collects every persisted edge for delete-all", () => {
    const city = { source: { roads: { edges: [{ id: "edge-1" }, { id: "edge-2" }] } } };
    expect(allRoadEdgeIds(city)).toEqual(["edge-1", "edge-2"]);
    expect(allRoadEdgeIds(null)).toEqual([]);
  });

  it("renders visible footer buttons for generation and delete-all", () => {
    const html = roadGenerationActionsHTML({ enabled: false, reason: "Roads exist.", roadCount: 2 }, true);
    expect(html).toContain('class="form-footer"');
    expect(html).toContain('data-action="generate-roads" disabled');
    expect(html).toContain('data-action="delete-all-roads">Delete all roads</button>');
  });
});
