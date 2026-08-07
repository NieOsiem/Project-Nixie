import { describe, expect, it } from "vitest";
import { allRoadEdgeIds, roadGenerationActionsHTML, roadGenerationAvailability } from "./generate.js";

describe("Generate workspace road generation state", () => {
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

  it("keeps generation disabled until the Scene is enabled", () => {
    expect(roadGenerationAvailability("supported", false, null)).toEqual({
      enabled: false,
      reason: "Enable Nixie on this Scene first.",
      roadCount: 0
    });
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
