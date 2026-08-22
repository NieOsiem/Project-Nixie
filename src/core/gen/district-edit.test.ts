import { describe, expect, it } from "vitest";
import { rectRing, ringBounds } from "../geom/types.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV3, type DistrictSource, type RoadEdgeSource } from "./city.js";
import {
  DistrictEditError,
  districtDeleteCandidate,
  districtDrawCandidate,
  districtFillCandidate,
  districtMergeCandidate,
  districtMoveVertexCandidate,
  districtSplitCandidate,
  districtUpdateCandidate,
  validateDistrictCandidates,
  reconcileDistrictsForRoadEdit
} from "./district-edit.js";
import { DISTRICT_TYPE_IDS } from "./district-registry.js";

const baseSource = (): CitySourceV3 => ({
  origin: { x: 0, y: 0 },
  citySeed: "district-edit",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
  terrain: { land: rectRing({ x: 0, y: 0, width: 200, height: 100 }), urbanFootprint: null },
  roads: { nodes: [], routes: [], edges: [] },
  districts: []
});

const district = (id: string, x: number, width: number, locked = false): DistrictSource => ({
  id,
  polygon: rectRing({ x, y: 0, width, height: 100 }),
  seed: `seed-${id}`,
  typeId: "mixed-use-centre",
  paletteId: "mixed-use",
  origin: "authored",
  locked,
  openSpaceOverride: null
});

const verticalRoad = (classId: RoadEdgeSource["classId"]): CitySourceV3["roads"] => ({
  nodes: [{ id: "n", x: 100, y: 0 }, { id: "s", x: 100, y: 100 }],
  routes: [{ id: "r", curvePreset: "standard" }],
  edges: [{ id: "e", a: "n", b: "s", routeId: "r", classId, name: null, locked: false, origin: "authored" }]
});

describe("district edit candidates", () => {
  it("subtracts unlocked overlap and rejects locked or disconnecting subtraction atomically", () => {
    const source = { ...baseSource(), districts: [district("old", 0, 100)] };
    const incoming = district("new", 80, 80);
    const result = districtDrawCandidate(source, incoming);
    expect(result.map((value) => value.id)).toEqual(["new", "old"]);
    expect(ringBounds(result.find((value) => value.id === "old")!.polygon).width).toBe(80);
    expect(() => districtDrawCandidate({ ...source, districts: [district("old", 0, 100, true)] }, incoming)).toThrow(DistrictEditError);
    const cutting = { ...incoming, polygon: rectRing({ x: 40, y: 0, width: 20, height: 100 }) };
    expect(() => districtDrawCandidate(source, cutting)).toThrow(/connected, hole-free/);
    expect(source.districts[0]!.polygon).toEqual(rectRing({ x: 0, y: 0, width: 100, height: 100 }));
    expect(() => districtDrawCandidate(source, { ...incoming, id: "bad-palette", paletteId: "unknown" })).toThrow(/unknown district palette/);
  });

  it("fills, moves, splits, merges, updates, and deletes with explicit survivor semantics", () => {
    const source = { ...baseSource(), districts: [district("a", 0, 50)] };
    const filled = districtFillCandidate(source, rectRing({ x: 50, y: 0, width: 50, height: 100 }), { targetDistrictId: "a" });
    expect(ringBounds(filled[0]!.polygon).width).toBe(100);
    const moved = districtMoveVertexCandidate({ ...source, districts: filled }, "a", 1, { x: 110, y: 0 });
    expect(moved[0]!.polygon[1]).toEqual({ x: 110, y: 0 });
    const split = districtSplitCandidate({ ...source, districts: filled }, "a", { x: 50, y: -10 }, { x: 50, y: 110 }, "b");
    expect(split.map((value) => value.id)).toEqual(["a", "b"]);
    expect(split[0]!.seed).toBe(split[1]!.seed);
    const merged = districtMergeCandidate({ ...source, districts: split }, ["a", "b"], "b");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe("b");
    const updated = districtUpdateCandidate({ ...source, districts: merged }, ["b"], { paletteId: "corporate", locked: true });
    expect(updated[0]!.paletteId).toBe("corporate");
    expect(updated[0]!.locked).toBe(true);
    expect(() => districtDeleteCandidate({ ...source, districts: updated }, ["b"])).toThrow(/Locked/);
    const unlocked = districtUpdateCandidate({ ...source, districts: updated }, ["b"], { locked: false });
    expect(districtDeleteCandidate({ ...source, districts: unlocked }, ["b"])).toEqual([]);
    expect(() => districtDeleteCandidate({ ...source, districts: unlocked }, [])).toThrow(/selection is empty/);
  });

  it("deletes an unlocked predecessor emptied by complete-face Fill reassignment", () => {
    const source = { ...baseSource(), districts: [district("old", 0, 100)] };
    const replacement = district("new", 0, 100);
    const result = districtFillCandidate(source, replacement.polygon, { targetDistrictId: null, newDistrict: replacement });
    expect(result.map((value) => value.id)).toEqual(["new"]);
  });

  it("requires exactly two de-duplicated boundary crossings for split", () => {
    const source = { ...baseSource(), districts: [district("a", 0, 100)] };
    expect(() => districtSplitCandidate(source, "a", { x: -10, y: -10 }, { x: 110, y: -10 }, "miss")).toThrow(/found 0/);
    expect(() => districtSplitCandidate(source, "a", { x: -10, y: 10 }, { x: 10, y: -10 }, "tangent")).toThrow(/found 1/);
    const throughVertex = districtSplitCandidate(source, "a", { x: 0, y: 0 }, { x: 100, y: 50 }, "vertex");
    expect(throughVertex.map((value) => value.id)).toEqual(["a", "vertex"]);

    const concave: DistrictSource = {
      ...district("concave", 0, 100),
      polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }]
    };
    const split = districtSplitCandidate({ ...baseSource(), districts: [concave] }, "concave", { x: 20, y: -10 }, { x: 20, y: 110 }, "concave-b");
    expect(split).toHaveLength(2);
    expect(split.every((value) => value.polygon.length >= 4)).toBe(true);
  });

  it("applies the complete reclaimed corridor to one adjacent district and leaves multi-adjacent corridors unzoned", () => {
    const before = { ...baseSource(), roads: verticalRoad("street"), districts: [district("west", 0, 100)] };
    const after = { ...before, roads: { nodes: [], routes: [], edges: [] } };
    const one = reconcileDistrictsForRoadEdit(before, after);
    expect(ringBounds(one[0]!.polygon).width).toBeGreaterThan(100);
    const twoBefore = { ...before, districts: [district("west", 0, 100), district("east", 100, 100)] };
    const two = reconcileDistrictsForRoadEdit(twoBefore, { ...after, districts: twoBefore.districts });
    expect(ringBounds(two.find((value) => value.id === "west")!.polygon).width).toBeLessThan(100);
    expect(ringBounds(two.find((value) => value.id === "east")!.polygon).width).toBeLessThan(100);
  });

  it("absorbs reclaimed land into one unlocked neighbor without changing a merely adjacent lock", () => {
    const street = ROUTE_CLASS_REGISTRY.get("street")!;
    // Districts grow up to the road clearance corridor, so the reclaimed corridor exactly fills the
    // gap between them and touches the unlocked west district (and the locked east district).
    const corridorHalf = street.widthM / 2 + street.sidewalkM;
    const before = {
      ...baseSource(),
      roads: verticalRoad("street"),
      districts: [district("west", 0, 100 - corridorHalf), district("east", 100 + corridorHalf, 100 - corridorHalf, true)]
    };
    const after = { ...before, roads: { nodes: [], routes: [], edges: [] } };
    const result = reconcileDistrictsForRoadEdit(before, after);
    expect(ringBounds(result.find((value) => value.id === "west")!.polygon).width).toBeGreaterThan(100 - corridorHalf);
    expect(result.find((value) => value.id === "east")!.polygon).toEqual(before.districts[1]!.polygon);
  });

  it("rejects reclaimed land when keeping it unzoned would alter a locked district", () => {
    const before = { ...baseSource(), roads: verticalRoad("street"), districts: [district("locked", 0, 200, true)] };
    const after = { ...before, roads: { nodes: [], routes: [], edges: [] } };
    try {
      reconcileDistrictsForRoadEdit(before, after);
      throw new Error("Expected road reclamation to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(DistrictEditError);
      expect((error as DistrictEditError).affectedIds).toEqual(["e", "locked"]);
    }
  });

  it("keeps zoning masks valid outside a changed footprint while rejecting authoring with no effective land", () => {
    const source = baseSource();
    source.terrain.urbanFootprint = rectRing({ x: 0, y: 0, width: 80, height: 100 });
    const crossing = { ...district("crossing", 0, 120), polygon: rectRing({ x: 0, y: 0, width: 120, height: 100 }) };
    expect(() => validateDistrictCandidates(source, [crossing])).not.toThrow();
    const outside = { ...district("outside", 120, 60), polygon: rectRing({ x: 120, y: 0, width: 60, height: 100 }) };
    expect(() => districtDrawCandidate(source, outside)).toThrow(/no supported effective land/);
  });

  it("skips metadata-only road reconciliation and rejects new occupancy inside a lock", () => {
    const before = { ...baseSource(), roads: verticalRoad("street"), districts: [district("locked", 0, 200, true)] };
    const metadata = { ...before, roads: { ...before.roads, edges: before.roads.edges.map((value) => ({ ...value, name: "Renamed", locked: true })) } };
    expect(reconcileDistrictsForRoadEdit(before, metadata)).toEqual(before.districts);
    const empty = { ...baseSource(), districts: before.districts };
    expect(() => reconcileDistrictsForRoadEdit(empty, before)).toThrow(/locked districts/);
  });

  it("accepts sub-snap overlap noise when editing districts that share a diagonal edge", () => {
    const diagonal: DistrictSource = {
      ...district("old", 0, 100),
      polygon: [
        { x: 0, y: 0 },
        { x: 100.37, y: 0.11 },
        { x: 150.82, y: 40.53 },
        { x: 100.19, y: 100.64 },
        { x: -0.27, y: 99.88 }
      ]
    };
    const neighbor: DistrictSource = {
      ...district("nbr", 0, 100),
      polygon: [
        { x: 150.82, y: 40.53 },
        { x: 300.44, y: 60.17 },
        { x: 260.05, y: 130.9 },
        { x: 100.19, y: 100.64 }
      ]
    };
    const source = { ...baseSource(), districts: [diagonal, neighbor] };
    const split = districtSplitCandidate(source, "old", { x: 10.17, y: -20.33 }, { x: 140.66, y: 130.21 }, "new");
    expect(split.map((value) => value.id)).toEqual(["nbr", "new", "old"]);
    const drawn = districtDrawCandidate(source, {
      ...district("new", 0, 100),
      polygon: [
        { x: 120.05, y: 25.44 },
        { x: 190.62, y: 45.13 },
        { x: 185.44, y: 85.27 },
        { x: 115.88, y: 70.09 }
      ]
    });
    expect(drawn.map((value) => value.id)).toEqual(["nbr", "new", "old"]);
    const genuine = { ...district("gen", 0, 100), polygon: rectRing({ x: 20, y: 0, width: 80, height: 100 }) };
    expect(() => validateDistrictCandidates(source, [diagonal, neighbor, genuine])).toThrow(/must not overlap/);
  });
});
