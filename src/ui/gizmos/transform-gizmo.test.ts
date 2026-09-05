import { describe, expect, it, vi } from "vitest";
import type { PlacementFrame } from "../../core/gen/city.js";
import {
  TransformGizmo,
  localToWorld,
  moveSiteVertex,
  resizePlacement,
  rotatePlacement,
  transformSitePolygon,
  translatePlacement,
  worldToLocal,
  zoomHitRadius
} from "./transform-gizmo.js";
const placement = (overrides: Partial<PlacementFrame> = {}): PlacementFrame => ({
  centre: { x: 100, y: 80 },
  rotationRad: 0,
  widthM: 20,
  depthM: 10,
  ...overrides
});

describe("transform gizmo math", () => {
  it("translates a placement without mutating the source", () => {
    const source = placement();
    const moved = translatePlacement(source, { x: 7, y: -3 });

    expect(moved.centre).toEqual({ x: 107, y: 77 });
    expect(source.centre).toEqual({ x: 100, y: 80 });
  });

  it("moves the reserved site with frame transforms", () => {
    const source = placement();
    const site = [{ x: 90, y: 75 }, { x: 110, y: 75 }, { x: 110, y: 85 }];
    const moved = transformSitePolygon(site, source, translatePlacement(source, { x: 5, y: -2 }));

    expect(moved).toEqual([{ x: 95, y: 73 }, { x: 115, y: 73 }, { x: 115, y: 83 }]);
    expect(site).toEqual([{ x: 90, y: 75 }, { x: 110, y: 75 }, { x: 110, y: 85 }]);
  });

  it("rotates around the placement centre from the frontage handle", () => {
    const source = placement({ rotationRad: 0 });
    const rotated = rotatePlacement(source, { x: 120, y: 80 }, { x: 100, y: 100 });

    expect(rotated.rotationRad).toBeCloseTo(Math.PI / 2);
    expect(rotated.centre).toEqual(source.centre);
  });

  it("resizes along local axes, including a rotated frame, and clamps dimensions", () => {
    const source = placement({ rotationRad: Math.PI / 2 });
    const start = localToWorld(source.centre, source.rotationRad, { x: source.widthM / 2, y: 0 });
    const moved = resizePlacement(source, "resize-width", start, { x: start.x, y: start.y + 4 });
    const clamped = resizePlacement(source, "resize-depth", { x: 100, y: 85 }, { x: 300, y: 85 }, 2);
    expect(moved.widthM).toBeCloseTo(28);
    expect(moved.depthM).toBe(source.depthM);
    expect(clamped.depthM).toBe(2);
    expect(worldToLocal(source.centre, source.rotationRad, start).x).toBeCloseTo(10);
  });

  it("moves only an existing site vertex", () => {
    const ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const moved = moveSiteVertex(ring, 1, { x: 12, y: 3 });

    expect(moved).toEqual([{ x: 0, y: 0 }, { x: 12, y: 3 }, { x: 10, y: 10 }]);
    expect(ring[1]).toEqual({ x: 10, y: 0 });
  });

  it("keeps hit targets constant in screen space as zoom changes", () => {
    expect(zoomHitRadius(18, 1)).toBe(18);
    expect(zoomHitRadius(18, 2)).toBe(9);
    expect(zoomHitRadius(18, 0)).toBe(18);
  });
});

describe("transform gizmo lifecycle", () => {
  it("keeps drag updates local and commits once on pointer up", () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const gizmo = new TransformGizmo({
      kind: "building",
      placement: placement(),
      onPreview: preview,
      onCommit: commit
    });

    expect(gizmo.beginDrag("translate", { x: 100, y: 80 })).toBe(true);
    expect(gizmo.updateDrag({ x: 112, y: 75 })).toBe(true);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(gizmo.endDrag({ x: 115, y: 76 })?.placement.centre).toEqual({ x: 115, y: 76 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(gizmo.endDrag({ x: 120, y: 70 })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("offers only existing vertex handles in site mode", () => {
    const gizmo = new TransformGizmo({
      kind: "building",
      mode: "site",
      placement: placement(),
      sitePolygon: [{ x: 90, y: 75 }, { x: 110, y: 75 }, { x: 110, y: 85 }]
    });

    expect(gizmo.getControl("translate")).toBeUndefined();
    expect(gizmo.getControl("rotate")).toBeUndefined();
    expect(gizmo.getControl("resize-width")).toBeUndefined();
    expect(gizmo.beginDrag("translate", { x: 100, y: 80 })).toBe(false);
    expect(gizmo.beginDrag("vertex", { x: 110, y: 85 }, 2)).toBe(true);
    expect(gizmo.beginDrag("vertex", { x: 0, y: 0 }, 3)).toBe(false);
  });

  it("restores the exact committed state when a drag is cancelled", () => {
    const cancel = vi.fn();
    const gizmo = new TransformGizmo({ kind: "building", placement: placement(), onCancel: cancel });

    gizmo.beginDrag("resize-width", { x: 110, y: 80 });
    gizmo.updateDrag({ x: 140, y: 80 });
    expect(gizmo.cancel()?.placement).toEqual(placement());
    expect(gizmo.state.placement).toEqual(placement());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("omits resize controls for fixed places while retaining accessible labels", () => {
    const gizmo = new TransformGizmo({
      kind: "place",
      placement: placement(),
      sitePolygon: [{ x: 90, y: 75 }, { x: 110, y: 75 }, { x: 110, y: 85 }]
    });

    expect(gizmo.getControl("resize-width")).toBeUndefined();
    expect(gizmo.getControl("resize-depth")).toBeUndefined();
    expect(gizmo.beginDrag("resize-width", { x: 110, y: 80 })).toBe(false);
    const move = gizmo.getControl("translate");
    expect(gizmo.getVertexControl(1)).toBeUndefined();
    expect(move?.accessibleTitle).toBe("Move object");
    expect(move?.ariaLabel).toBe("Move object");
    expect(move?.eventMode).toBe("static");
  });

  it("moves an existing vertex through the same provisional/commit lifecycle", () => {
    const commit = vi.fn();
    const gizmo = new TransformGizmo({
      kind: "building",
      placement: placement(),
      mode: "site",
      sitePolygon: [{ x: 90, y: 75 }, { x: 110, y: 75 }, { x: 110, y: 85 }],
      onCommit: commit
    });

    gizmo.beginDrag("vertex", { x: 110, y: 75 }, 1);
    gizmo.updateDrag({ x: 115, y: 77 });
    const result = gizmo.endDrag();
    expect(result?.sitePolygon?.[1]).toEqual({ x: 115, y: 77 });
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
