import { describe, expect, it } from "vitest";
import { classChipsForGroup, roadSelectionActionsEnabled, roadStagedDirty, routeClassLabel } from "./roads.js";

describe("Roads workspace selection actions", () => {
  it("keeps road actions enabled for a multi-selection", () => {
    expect(roadSelectionActionsEnabled(true, 2)).toBe(true);
    expect(roadSelectionActionsEnabled(true, 0)).toBe(false);
    expect(roadSelectionActionsEnabled(false, 2)).toBe(false);
  });
});

describe("Roads class chip groups", () => {
  it("splits classes into vehicle and non-vehicle groups", () => {
    const vehicles = classChipsForGroup("vehicle");
    const routes = classChipsForGroup("non-vehicle");
    expect(vehicles.every((routeClass) => routeClass.vehicle)).toBe(true);
    expect(routes.every((routeClass) => !routeClass.vehicle)).toBe(true);
    expect(vehicles.map((routeClass) => routeClass.id)).toEqual(["highway", "arterial", "street", "narrow", "lane", "alley"]);
    expect(routes.some((routeClass) => routeClass.id === "cycleway")).toBe(true);
  });
});

describe("Roads inspector staging", () => {
  it("is dirty only while at least one property is staged", () => {
    expect(roadStagedDirty(undefined, undefined, undefined)).toBe(false);
    expect(roadStagedDirty("street", undefined, undefined)).toBe(true);
    expect(roadStagedDirty(undefined, "broad", undefined)).toBe(true);
    expect(roadStagedDirty(undefined, undefined, "")).toBe(true);
  });

  it("labels route class ids for display", () => {
    expect(routeClassLabel("street")).toBe("Street");
    expect(routeClassLabel("pedestrian-path")).toBe("Pedestrian Path");
    expect(routeClassLabel("waterfront-promenade")).toBe("Waterfront Promenade");
  });
});
