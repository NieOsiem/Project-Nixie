import { describe, expect, it } from "vitest";
import { validateRouteTopology } from "../graph/topology.js";
import { intersection, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, ringArea, ringCentroid, type Ring } from "../geom/types.js";
import type { CitySourceV3, DistrictOpenSpaceOverride, DistrictSource, RoadEdgeSource, RoadNodeSource, RoadRouteSource } from "./city.js";
import { buildDistrictPlan, planDistrictFragmentWithGrammar, OPEN_SPACE_PROFILE_CATEGORY_GATES, type DistrictBlockFragment } from "./district-plan.js";
import { BLOCK_GRAMMAR_IDS, DISTRICT_TYPE_IDS, DISTRICT_TYPE_REGISTRY, type DistrictPlanningBounds } from "./district-registry.js";
import { generateInitialRoadNetwork } from "./road-generator.js";

const node = (id: string, x: number, y: number): RoadNodeSource => ({ id, x, y });
const route = (id: string): RoadRouteSource => ({ id, curvePreset: "standard" });
const edge = (id: string, a: string, b: string, routeId: string, classId: RoadEdgeSource["classId"] = "street"): RoadEdgeSource => ({ id, a, b, routeId, classId, name: null, locked: false, origin: "authored" });

const gridSource = (): CitySourceV3 => ({
  origin: { x: 700, y: 300 },
  citySeed: "district-plan-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null, roadLayout: "grid", hubMode: "single-centre", districtPool: [...DISTRICT_TYPE_IDS], openSpaceProfile: "medium" },
  terrain: { land: rectRing({ x: 0, y: 0, width: 200, height: 200 }), urbanFootprint: null },
  roads: {
    nodes: [node("n", 100, 0), node("w", 0, 100), node("c", 100, 100), node("e", 200, 100), node("s", 100, 200)],
    routes: [route("horizontal"), route("vertical")],
    edges: [edge("north", "n", "c", "vertical"), edge("west", "w", "c", "horizontal"), edge("east", "c", "e", "horizontal"), edge("south", "c", "s", "vertical")]
  },
  districts: []
});

const override = (rate = 0.4): DistrictOpenSpaceOverride => ({
  rate,
  categoryWeights: { park: 1, plaza: 0, parking: 0, vacant: 0, utility: 0, landscaping: 0, "service-yard": 0 },
  sizeWeights: { pocket: 1, small: 0, large: 0, "whole-block": 0 }
});

const area = (ring: Ring): number => Math.abs(ringArea(ring));

describe("buildDistrictPlan", () => {
  it("walks the four exact interior faces and discards the exterior", () => {
    const plan = buildDistrictPlan(gridSource());
    expect(plan.blocks).toHaveLength(4);
    expect(plan.blocks.map((block) => block.id)).toEqual(["block_22a1a0cc", "block_4b41ea78", "block_77873fa4", "block_c618de54"]);
    expect(plan.blocks.every((block) => area(block.zoningFace) === 10_000)).toBe(true);
    expect(plan.blocks.every((block) => block.boundaryRoadIds.length === 2)).toBe(true);
    expect(plan.diagnostics.discardedFaceCount).toBeGreaterThanOrEqual(1);
  });

  it("uses compiled curve points instead of the source chords", () => {
    const source = gridSource();
    source.roads = {
      nodes: [node("w", 0, 80), node("bend", 100, 120), node("e", 200, 80)],
      routes: [route("curve")],
      edges: [edge("curve-a", "w", "bend", "curve"), edge("curve-b", "bend", "e", "curve")]
    };
    const plan = buildDistrictPlan(source);
    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks.map((block) => block.id)).toEqual(["block_04c7284b", "block_0a6a1471"]);
    expect(plan.blocks.some((block) => block.zoningFace.some((point) => point.x > 70 && point.x < 130 && point.y !== 80 && point.y !== 120))).toBe(true);
  });

  it("extracts T-junction faces while a cul-de-sac bridge does not invent a block", () => {
    const source = gridSource();
    source.roads = {
      nodes: [node("w", 0, 100), node("c", 100, 100), node("e", 200, 100), node("n", 100, 0)],
      routes: [route("horizontal"), route("branch")],
      edges: [edge("west", "w", "c", "horizontal"), edge("east", "c", "e", "horizontal"), edge("north", "n", "c", "branch")]
    };
    expect(buildDistrictPlan(source).blocks).toHaveLength(3);
    source.roads.nodes.push(node("dead", 100, 160));
    source.roads.routes.push(route("dead-route"));
    source.roads.edges.push(edge("dead-edge", "c", "dead", "dead-route"));
    const withCulDeSac = buildDistrictPlan(source);
    expect(withCulDeSac.blocks).toHaveLength(3);
    expect(withCulDeSac.blocks.every((block) => !block.boundaryRoadIds.includes("dead-edge"))).toBe(true);
  });

  it("extracts acute curved faces and rejects an unsupported disconnected ring-road face", () => {
    const source = gridSource();
    source.roads = {
      nodes: [node("w", 0, 100), node("tip", 100, 30), node("e", 200, 100)],
      routes: [route("acute")],
      edges: [edge("acute-a", "w", "tip", "acute"), edge("acute-b", "tip", "e", "acute")]
    };
    expect(buildDistrictPlan(source).blocks).toHaveLength(2);
    source.roads = {
      nodes: [node("a", 60, 60), node("b", 140, 60), node("c", 140, 140), node("d", 60, 140)],
      routes: [route("ring")],
      edges: [edge("ab", "a", "b", "ring"), edge("bc", "b", "c", "ring"), edge("cd", "c", "d", "ring"), edge("da", "d", "a", "ring")]
    };
    expect(() => buildDistrictPlan(source)).toThrow(/unsupported nested planar faces/);
  });

  it("opens the exact generated closed cycle from the Phase 2 City Test scene", () => {
    const source = gridSource();
    source.citySeed = "nixie-3";
    source.terrain = {
      land: [
        { x: -584, y: -390 }, { x: 916, y: -390 }, { x: 844.3109123679628, y: -247.14285714285714 },
        { x: 790.8775815673339, y: -104.28571428571428 }, { x: 723.4404882724248, y: 38.571428571428555 },
        { x: 730.4566461992597, y: 181.42857142857144 }, { x: 750.5169146124144, y: 324.28571428571433 },
        { x: 812.8451638077853, y: 467.1428571428571 }, { x: 916, y: 610 }, { x: -584, y: 610 }
      ],
      urbanFootprint: [
        { x: 891.779404704865, y: -381.52973613849537 }, { x: 710.6880945512929, y: -129.5638472324889 },
        { x: 687.258914916373, y: -6.683827688629463 }, { x: 631.2175751721769, y: 175.15176512896034 },
        { x: 887.5128829547923, y: 593.0193081299268 }, { x: -580.4798432756484, y: 607.2917144265454 },
        { x: -578.5614809162789, y: -383.2698899726773 }
      ]
    };
    source.roads = {
      nodes: [
        node("gn_19b811ab", -81.22831558686761, 118.5644059586641),
        node("gn_a5c1e86b", -89.75466356257255, 118.9840179639569),
        node("gn_aa5a69df", -105.54144866657757, 120.465673034543),
        node("gn_ab5a6b72", -80.70528992864487, 139.6423871416929),
        node("gn_a6bfab67", -144.09406695218286, 124.08399570067886)
      ],
      routes: [
        { id: "gr_0ad65577", curvePreset: "tight" }, { id: "gr_b4cdb3ba", curvePreset: "tight" },
        { id: "gr_e812b107", curvePreset: "tight" }, { id: "gr_f2d52041", curvePreset: "tight" },
        { id: "gr_e2d75ce1", curvePreset: "tight" }
      ],
      edges: [
        edge("ge_2e9db316", "gn_aa5a69df", "gn_ab5a6b72", "gr_e812b107", "arterial"),
        edge("ge_744687bc", "gn_19b811ab", "gn_ab5a6b72", "gr_f2d52041"),
        edge("ge_3271da7e", "gn_aa5a69df", "gn_a5c1e86b", "gr_0ad65577", "arterial"),
        edge("ge_0fa11a10", "gn_a5c1e86b", "gn_19b811ab", "gr_b4cdb3ba", "arterial"),
        edge("ge_19228b5e", "gn_a6bfab67", "gn_aa5a69df", "gr_e2d75ce1", "arterial")
      ]
    };
    expect(validateRouteTopology(source.roads)).toMatchObject({ ok: true });
    const plan = buildDistrictPlan(source);
    expect(plan.diagnostics.warnings).toEqual([
      "Discarded 1 enclosing planar face because bridge-attached route cycles would require unsupported holes; the affected region is excluded from district planning."
    ]);
    expect(plan.diagnostics.discardedFaceCount).toBeGreaterThanOrEqual(2);
    expect(buildDistrictPlan({
      ...source,
      roads: { nodes: [...source.roads.nodes].reverse(), routes: [...source.roads.routes].reverse(), edges: [...source.roads.edges].reverse() }
    })).toEqual(plan);
  });

  it("extracts stable hole-free faces from a ring road connected to the development boundary", () => {
    const source = gridSource();
    source.roads = {
      nodes: [node("left", 0, 60), node("a", 60, 60), node("b", 140, 60), node("right", 200, 60), node("c", 140, 140), node("d", 60, 140)],
      routes: [route("ring")],
      edges: [edge("left-a", "left", "a", "ring"), edge("ab", "a", "b", "ring"), edge("b-right", "b", "right", "ring"), edge("bc", "b", "c", "ring"), edge("cd", "c", "d", "ring"), edge("da", "d", "a", "ring")]
    };
    const first = buildDistrictPlan(source);
    expect(first.blocks).toHaveLength(3);
    expect(first.blocks.map((block) => block.id)).toEqual(["block_9b8cfa70", "block_c9224224", "block_e40f31cd"]);
    expect(first.blocks.map((block) => Math.round(area(block.zoningFace) * 100) / 100).sort((a, b) => a - b)).toEqual([6_207.51, 12_000, 21_792.49]);
    const permuted = buildDistrictPlan({ ...source, roads: { nodes: [...source.roads.nodes].reverse(), routes: [...source.roads.routes].reverse(), edges: [...source.roads.edges].reverse() } });
    expect(permuted.blocks).toEqual(first.blocks);
  });

  it("plans the Phase 2 generated route fixtures without treating internal rings as fatal", () => {
    for (const [citySeed, roadLayout] of [["phase2-grid-fixture", "grid"], ["phase2-mixed-fixture", "mixed"], ["phase2-organic-european", "european"]] as const) {
      const source = gridSource();
      source.citySeed = citySeed;
      source.generation.roadLayout = roadLayout;
      source.terrain.land = rectRing({ x: -300, y: -240, width: 600, height: 480 });
      source.roads = generateInitialRoadNetwork({
        citySeed,
        mask: source.terrain.land,
        land: source.terrain.land,
        layout: roadLayout,
        hubMode: "single-centre",
        sceneBounds: { x: -300, y: -240, width: 600, height: 480 }
      }).roads;
      expect(() => buildDistrictPlan(source), `${roadLayout}/${citySeed}`).not.toThrow();
    }
  }, 20_000);

  it("is independent of road and district source order", () => {
    const source = gridSource();
    source.districts = [
      { id: "west-district", polygon: rectRing({ x: 0, y: 0, width: 100, height: 200 }), seed: "west", typeId: "old-city", paletteId: "old-city", origin: "authored", locked: false, openSpaceOverride: null },
      { id: "east-district", polygon: rectRing({ x: 100, y: 0, width: 100, height: 200 }), seed: "east", typeId: "corporate-core", paletteId: "corporate", origin: "authored", locked: false, openSpaceOverride: null }
    ];
    const first = buildDistrictPlan(source);
    const permuted = buildDistrictPlan({ ...source, roads: { nodes: [...source.roads.nodes].reverse(), routes: [...source.roads.routes].reverse(), edges: [...source.roads.edges].reverse() }, districts: [...source.districts].reverse() });
    expect(permuted.blocks).toEqual(first.blocks);
    expect(permuted.developmentCells).toEqual(first.developmentCells);
  });

  it("keeps unrelated block and cell lineage stable under a localized district planning edit", () => {
    const source = gridSource();
    const district: DistrictSource = { id: "local", polygon: rectRing({ x: 0, y: 0, width: 100, height: 100 }), seed: "before", typeId: "old-city", paletteId: "old-city", origin: "authored", locked: false, openSpaceOverride: null };
    const before = buildDistrictPlan({ ...source, districts: [district] });
    const changedDistrict: DistrictSource = { ...district, seed: "after", typeId: "corporate-core", openSpaceOverride: override(0.65) };
    const after = buildDistrictPlan({ ...source, districts: [changedDistrict] });
    const affectedBlockIds = new Set(before.blocks.filter((block) => block.districtFragments.some((fragment) => fragment.districtId === district.id)).map((block) => block.id));
    expect(affectedBlockIds.size).toBe(1);
    expect(after.blocks.map((block) => block.id)).toEqual(before.blocks.map((block) => block.id));
    expect(after.developmentCells.filter((cell) => !affectedBlockIds.has(cell.blockId))).toEqual(before.developmentCells.filter((cell) => !affectedBlockIds.has(cell.blockId)));
    expect(after.developmentCells.filter((cell) => affectedBlockIds.has(cell.blockId))).not.toEqual(before.developmentCells.filter((cell) => affectedBlockIds.has(cell.blockId)));
  });

  it("preserves unaffected face lineage under a localized road topology edit", () => {
    const source = gridSource();
    const before = buildDistrictPlan(source);
    source.roads.nodes.push(node("north-west", 0, 0));
    source.roads.routes.push(route("local-diagonal"));
    source.roads.edges.push(edge("north-west-centre", "north-west", "c", "local-diagonal"));
    const after = buildDistrictPlan(source);
    const beforeIds = new Set(before.blocks.map((block) => block.id));
    expect(after.blocks).toHaveLength(5);
    expect(after.blocks.map((block) => block.id).filter((id) => beforeIds.has(id))).toEqual(["block_22a1a0cc", "block_4b41ea78", "block_c618de54"]);
    expect(after.blocks.some((block) => block.id === "block_77873fa4")).toBe(false);
    const permuted = buildDistrictPlan({ ...source, roads: { nodes: [...source.roads.nodes].reverse(), routes: [...source.roads.routes].reverse(), edges: [...source.roads.edges].reverse() } });
    expect(permuted.blocks).toEqual(after.blocks);
  });

  it("keeps local planning cells peer-disjoint", () => {
    const source = gridSource();
    const district: DistrictSource = { id: "district-a", polygon: rectRing({ x: 0, y: 0, width: 100, height: 100 }), seed: "cells", typeId: "mixed-use-centre", paletteId: "mixed", origin: "authored", locked: false, openSpaceOverride: null };
    const plan = buildDistrictPlan({ ...source, districts: [district] });
    const cells = plan.developmentCells.filter((cell) => cell.districtId === district.id);
    expect(cells.length).toBeGreaterThan(1);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      const overlap = intersection(ringAsMulti(cells[i]!.polygon), ringAsMulti(cells[j]!.polygon));
      const overlapArea = overlap.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0]!)), 0);
      expect(overlapArea, `${cells[i]!.localRole} ${cells[j]!.localRole}`).toBeLessThan(1e-5);
    }
  });

  it("never reserves an orthogonal full-span cross of planning bands", () => {
    // WHY: superblock-compound, campus-pavilions and market-alley used to reserve two
    // full-span bands crossing at right angles (spine+crossing, walk+green,
    // alley+cross-alley). Those reserves resolved into thin bar parcels that read as an
    // accidental plus/red-cross across the block, with the surrounding grid clipped into
    // incoherent slivers. A coherent yard/quad/alley reserve either spans both axes as a
    // solid block or spans only one axis as a street band — never two thin full-span arms.
    const fragment: DistrictBlockFragment = {
      id: "cross-fixture",
      blockId: "block",
      districtId: null,
      buildable: [[rectRing({ x: 0, y: 0, width: 240, height: 240 })]]
    };
    const bounds: DistrictPlanningBounds = { minCellWidthM: 12, maxCellWidthM: 28, minCellDepthM: 14, maxCellDepthM: 34, minAspect: 0.4, maxAspect: 3 };
    for (const grammar of BLOCK_GRAMMAR_IDS) {
      const cells = planDistrictFragmentWithGrammar(fragment, grammar, bounds, `fixture/${grammar}`, ["road-1"]);
      const bands = cells.filter((cell) => cell.localRole.startsWith("planning-band") && !cell.localRole.startsWith("planning-band-remainder") && !/^planning-band--?\d+-/.test(cell.localRole) && Math.abs(ringArea(cell.polygon)) >= 1);
      if (bands.length === 0) continue;
      const bandUnion = union(bands.map((cell) => ringAsMulti(cell.polygon)));
      const xs: number[] = [];
      const ys: number[] = [];
      for (const polygon of bandUnion) for (const point of polygon[0]!) {
        xs.push(point.x);
        ys.push(point.y);
      }
      const bandWidth = Math.max(...xs) - Math.min(...xs);
      const bandHeight = Math.max(...ys) - Math.min(...ys);
      const bandArea = bandUnion.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0]!)), 0);
      const spansBothAxes = bandWidth >= 0.8 * 240 && bandHeight >= 0.8 * 240;
      const thinArms = bandArea < 0.6 * bandWidth * bandHeight;
      expect(spansBothAxes && thinArms, `${grammar} reserved bands form an orthogonal full-span cross`).toBe(false);
    }
  });

  it("enforces global none, explicit override precedence, and very-low category gating", () => {
    const base = gridSource();
    const district: DistrictSource = { id: "district-a", polygon: rectRing({ x: 0, y: 0, width: 100, height: 100 }), seed: "open", typeId: "heavy-industrial", paletteId: "industrial", origin: "authored", locked: false, openSpaceOverride: null };
    const none = buildDistrictPlan({ ...base, generation: { ...base.generation, openSpaceProfile: "none" }, districts: [district] });
    expect(none.openSpaceIntents.filter((intent) => intent.districtId === district.id).every((intent) => intent.targetShare === 0 && intent.category === null)).toBe(true);
    const explicit = buildDistrictPlan({ ...base, generation: { ...base.generation, openSpaceProfile: "none" }, districts: [{ ...district, openSpaceOverride: override() }] });
    expect(explicit.openSpaceIntents.filter((intent) => intent.districtId === district.id).every((intent) => intent.targetShare === 0.4 && intent.category === "park")).toBe(true);
    const veryLow = buildDistrictPlan({ ...base, generation: { ...base.generation, openSpaceProfile: "very-low" }, districts: [district] });
    expect(veryLow.openSpaceIntents.filter((intent) => intent.districtId === district.id).every((intent) => intent.category === null || intent.category === "park" || intent.category === "plaza")).toBe(true);
    const profiles = ["very-low", "low", "medium", "high"] as const;
    const shares = profiles.map((profile) => buildDistrictPlan({ ...base, generation: { ...base.generation, openSpaceProfile: profile }, districts: [district] }).openSpaceIntents.find((intent) => intent.districtId === district.id)!.targetShare);
    expect(shares).toEqual([...shares].sort((a, b) => a - b));
    const wholeBlockOverride: DistrictOpenSpaceOverride = { ...override(), sizeWeights: { pocket: 0, small: 0, large: 0, "whole-block": 1 } };
    const wholeBlock = buildDistrictPlan({ ...base, districts: [{ ...district, openSpaceOverride: wholeBlockOverride }] });
    expect(wholeBlock.developmentCells.filter((cell) => cell.districtId === district.id).every((cell) => cell.localRole === "planning-band-whole-block-open-space")).toBe(true);
    const gates = ["very-low", "low", "medium", "high"] as const;
    for (let index = 1; index < gates.length; index++) {
      expect(OPEN_SPACE_PROFILE_CATEGORY_GATES[gates[index - 1]!].every((category) => OPEN_SPACE_PROFILE_CATEGORY_GATES[gates[index]!].includes(category))).toBe(true);
      expect(OPEN_SPACE_PROFILE_CATEGORY_GATES[gates[index]!].length).toBeGreaterThan(OPEN_SPACE_PROFILE_CATEGORY_GATES[gates[index - 1]!].length);
    }
  });

  it("keeps cell geometry and identity stable under palette and lock-only changes", () => {
    const base = gridSource();
    const district: DistrictSource = { id: "district-a", polygon: rectRing({ x: 0, y: 0, width: 100, height: 100 }), seed: "stable", typeId: "mixed-use-centre", paletteId: "mixed-use", origin: "authored", locked: false, openSpaceOverride: null };
    const before = buildDistrictPlan({ ...base, districts: [district] });
    const after = buildDistrictPlan({ ...base, districts: [{ ...district, paletteId: "corporate", locked: true }] });
    expect(after.developmentCells).toEqual(before.developmentCells);
    expect(after.revisionInputs.districts).toBe(before.revisionInputs.districts);
  });

  it("excludes road metadata from structural signatures and geometry", () => {
    const source = gridSource();
    const before = buildDistrictPlan(source);
    const metadata = {
      ...source,
      roads: {
        ...source.roads,
        edges: source.roads.edges.map((value) => ({ ...value, name: `Renamed ${value.id}`, locked: !value.locked, origin: value.origin === "authored" ? "generated" as const : "authored" as const }))
      }
    };
    const after = buildDistrictPlan(metadata);
    expect(after.revisionInputs.roads).toBe(before.revisionInputs.roads);
    expect(after.blocks).toEqual(before.blocks);
    expect(after.developmentCells).toEqual(before.developmentCells);
  });

  it("clips effective district land after a footprint change without rewriting the district source identity", () => {
    const base = gridSource();
    const district: DistrictSource = { id: "persistent-mask", polygon: rectRing({ x: -20, y: -20, width: 240, height: 240 }), seed: "persistent", typeId: "old-city", paletteId: "old-city", origin: "authored", locked: false, openSpaceOverride: null };
    const source = { ...base, districts: [district] };
    const before = buildDistrictPlan(source);
    const changed = { ...source, terrain: { ...source.terrain, urbanFootprint: rectRing({ x: 0, y: 0, width: 100, height: 200 }) } };
    const after = buildDistrictPlan(changed);
    expect(changed.districts).toEqual([district]);
    expect(after.blocks.flatMap((block) => block.districtFragments).filter((fragment) => fragment.districtId === district.id).length).toBeGreaterThan(0);
    expect(after.wallCells).not.toEqual(before.wallCells);
  });

  it("handles a concave coastal-style development mask without leaking cells", () => {
    const source = gridSource();
    source.terrain.land = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 200 }, { x: 0, y: 200 }];
    source.roads = { nodes: [node("w", 0, 40), node("e", 200, 40)], routes: [route("coast-road")], edges: [edge("coast-edge", "w", "e", "coast-road")] };
    const plan = buildDistrictPlan(source);
    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks.every((block) => intersection(ringAsMulti(block.zoningFace), ringAsMulti(source.terrain.land)).length > 0)).toBe(true);
  });

  it("subtracts non-vehicle occupancy from wall cells without changing block identity", () => {
    const source = gridSource();
    source.roads = {
      nodes: [node("w", 0, 100), node("e", 200, 100)],
      routes: [route("vehicle")],
      edges: [edge("vehicle-edge", "w", "e", "vehicle")]
    };
    const vehicleOnly = buildDistrictPlan(source);
    source.roads.nodes.push(node("n", 50, 0), node("s", 50, 200));
    source.roads.routes.push(route("path"));
    source.roads.edges.push(edge("path-edge", "n", "s", "path", "pedestrian-path"));
    const withPath = buildDistrictPlan(source);
    expect(withPath.blocks.map((block) => block.id)).toEqual(vehicleOnly.blocks.map((block) => block.id));
    const multiArea = (multi: ReturnType<typeof buildDistrictPlan>["wallCells"]) => multi.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0]!)), 0);
    expect(multiArea(withPath.wallCells)).toBeLessThan(multiArea(vehicleOnly.wallCells));
  });
});


describe("planning cell minor-dimension floor", () => {
  const cellMinor = (ring: Ring): number => {
    const angle = Math.atan2(ring[1]!.y - ring[0]!.y, ring[1]!.x - ring[0]!.x);
    const centre = ringCentroid(ring);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of ring) {
      const localX = (point.x - centre.x) * Math.cos(angle) + (point.y - centre.y) * Math.sin(angle);
      const localY = -(point.x - centre.x) * Math.sin(angle) + (point.y - centre.y) * Math.cos(angle);
      if (localX < minX) minX = localX;
      if (localX > maxX) maxX = localX;
      if (localY < minY) minY = localY;
      if (localY > maxY) maxY = localY;
    }
    return Math.min(maxX - minX, maxY - minY);
  };

  it("keeps ordinary fine-grain and market cells above the six-metre minor-dimension floor", () => {
    const ring = rectRing({ x: 0, y: 0, width: 120, height: 120 });
    const fragment: DistrictBlockFragment = { id: "floor-fragment", blockId: "floor-block", districtId: "floor-district", buildable: ringAsMulti(ring) };
    const bounds = DISTRICT_TYPE_REGISTRY.get("night-market")!.bounds;
    for (const grammarId of ["fine-grain-frontage", "market-alley", "irregular-mosaic", "rotated-bands"] as const) {
      const cells = planDistrictFragmentWithGrammar(fragment, grammarId, bounds, `floor/${grammarId}`, []);
      const ordinary = cells.filter((cell) =>
        !cell.localRole.startsWith("planning-band") && !cell.localRole.startsWith("edge-sliver")
      );
      expect(ordinary.length, grammarId).toBeGreaterThan(0);
      for (const cell of ordinary) {
        expect(cellMinor(cell.polygon), `${grammarId} ${cell.localRole}`).toBeGreaterThanOrEqual(6);
      }
    }
  });
});
