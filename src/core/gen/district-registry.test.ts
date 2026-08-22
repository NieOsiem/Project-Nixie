import { describe, expect, it } from "vitest";
import { ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds } from "../geom/types.js";
import { BLOCK_GRAMMAR_IDS, DISTRICT_PALETTE_IDS, DISTRICT_TYPE_REGISTRY, DISTRICT_TYPES, DISTRICT_TYPE_IDS, validateDistrictRegistry } from "./district-registry.js";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY } from "./building-registry.js";
import { districtBreadthGallery, planDistrictFragmentWithGrammar, type DistrictBlockFragment } from "./district-plan.js";
import { validateRing } from "./terrain.js";

describe("district planning registry", () => {
  it("ships all stable types and grammars with valid distinct planning identities", () => {
    expect(DISTRICT_TYPES.map((entry) => entry.id)).toEqual(DISTRICT_TYPE_IDS);
    expect(DISTRICT_TYPE_IDS).toHaveLength(16);
    expect(BLOCK_GRAMMAR_IDS).toHaveLength(12);
    expect(new Set(DISTRICT_PALETTE_IDS).size).toBe(16);
    expect(validateDistrictRegistry()).toEqual({ ok: true, problems: [] });
    expect(DISTRICT_TYPES.every((entry) => BLOCK_GRAMMAR_IDS.filter((id) => entry.grammarWeights[id] > 0).length >= 3)).toBe(true);
  });

  it("provides fixed gallery coverage for every type and grammar", () => {
    const gallery = districtBreadthGallery();
    expect(new Set(gallery.map((entry) => entry.districtTypeId))).toEqual(new Set(DISTRICT_TYPE_IDS));
    expect(new Set(gallery.map((entry) => entry.grammarId))).toEqual(new Set(BLOCK_GRAMMAR_IDS));
    expect(new Set(gallery.map((entry) => entry.fixtureSeed)).size).toBe(gallery.length);
  });

  it("materializes every grammar as deterministic, accounted, hole-free, peer-disjoint local geometry", () => {
    const ring = rectRing({ x: 0, y: 0, width: 140, height: 110 });
    const fragment: DistrictBlockFragment = { id: "gallery-fragment", blockId: "gallery-block", districtId: "gallery-district", buildable: ringAsMulti(ring) };
    const definition = DISTRICT_TYPES.find((entry) => entry.id === "mixed-use-centre")!;
    const signatures: string[] = [];
    for (const grammarId of BLOCK_GRAMMAR_IDS) {
      const seed = `gallery/${grammarId}`;
      const cells = planDistrictFragmentWithGrammar(fragment, grammarId, definition.bounds, seed, ["frontage"]);
      expect(planDistrictFragmentWithGrammar(fragment, grammarId, definition.bounds, seed, ["frontage"])).toEqual(cells);
      expect(cells.length).toBeGreaterThan(0);
      const invalid = cells.find((cell) => !validateRing(cell.polygon).ok);
      expect(invalid ? `${grammarId}:${invalid.localRole}:${JSON.stringify(validateRing(invalid.polygon))}` : null).toBeNull();
      const accounted = union(cells.map((cell) => ringAsMulti(cell.polygon)));
      const accountedArea = accounted.reduce((sum, polygon) => sum + Math.abs(ringArea(polygon[0]!)), 0);
      expect(accountedArea).toBeCloseTo(15_400, 1);
      const summedCellArea = cells.reduce((sum, cell) => sum + Math.abs(ringArea(cell.polygon)), 0);
      expect(summedCellArea - accountedArea, grammarId).toBeLessThan(0.5);
      signatures.push(JSON.stringify({ count: cells.length, roles: [...new Set(cells.map((cell) => cell.localRole.replace(/-?\d+$/u, "")))].sort(), rotations: [...new Set(cells.map((cell) => cell.rotationRad.toFixed(4)))] }));
    }
    expect(new Set(signatures).size).toBe(BLOCK_GRAMMAR_IDS.length);
  }, 20_000);

  it("applies configured aspect bounds to sampled local cells", () => {
    const ring = rectRing({ x: 0, y: 0, width: 140, height: 110 });
    const fragment: DistrictBlockFragment = { id: "aspect-fragment", blockId: "aspect-block", districtId: "aspect-district", buildable: ringAsMulti(ring) };
    const cells = planDistrictFragmentWithGrammar(fragment, "fine-grain-frontage", { minCellWidthM: 10, maxCellWidthM: 10, minCellDepthM: 10, maxCellDepthM: 10, minAspect: 2, maxAspect: 2 }, "aspect", []);
    const centre = { x: 70, y: 55 };
    const ratios = cells.filter((cell) => cell.classification === "building").map((cell) => {
      const cosine = Math.cos(-cell.rotationRad);
      const sine = Math.sin(-cell.rotationRad);
      const local = cell.polygon.map((point) => {
        const x = point.x - centre.x;
        const y = point.y - centre.y;
        return { x: centre.x + x * cosine - y * sine, y: centre.y + x * sine + y * cosine };
      });
      const bounds = ringBounds(local);
      return bounds.width / bounds.height;
    });
    expect(ratios.some((ratio) => Math.abs(ratio - 2) < 0.05)).toBe(true);
  });

  it("deterministically decomposes and accounts for a holed derived fragment", () => {
    const fragment: DistrictBlockFragment = {
      id: "holed-fragment",
      blockId: "holed-block",
      districtId: "holed-district",
      buildable: [[rectRing({ x: 0, y: 0, width: 140, height: 110 }), rectRing({ x: 50, y: 40, width: 20, height: 20 })]]
    };
    const definition = DISTRICT_TYPES[0]!;
    const first = planDistrictFragmentWithGrammar(fragment, "campus-pavilions", definition.bounds, "holed", []);
    expect(planDistrictFragmentWithGrammar(fragment, "campus-pavilions", definition.bounds, "holed", [])).toEqual(first);
    const invalid = first.find((cell) => !validateRing(cell.polygon).ok);
    expect(invalid ? `${invalid.localRole}:${JSON.stringify(validateRing(invalid.polygon))}` : null).toBeNull();
    const accounted = union(first.map((cell) => ringAsMulti(cell.polygon)));
    const accountedArea = accounted.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);
    expect(accountedArea).toBeCloseTo(15_000, 1);
  }, 20_000);

  it("declares a valid ordinary height band for every district", () => {
    for (const entry of DISTRICT_TYPES) {
      expect(entry.heightBand.minM, entry.id).toBeGreaterThan(0);
      expect(entry.heightBand.minM, entry.id).toBeLessThanOrEqual(entry.heightBand.maxM);
    }
  });

  it("keeps commercial-highrise from weighting low-rise grammars anomalously", () => {
    const definition = DISTRICT_TYPE_REGISTRY.get("commercial-highrise")!;
    const lowRiseWeight = BUILDING_GRAMMAR_IDS.filter((id) => (BUILDING_GRAMMAR_REGISTRY.get(id)?.height.maxM ?? 0) <= 60)
      .reduce((sum, id) => sum + (definition.buildingGrammarWeights[id] ?? 0), 0);
    expect(lowRiseWeight).toBeLessThan(0.12);
    const tallWeight = BUILDING_GRAMMAR_IDS.filter((id) => (BUILDING_GRAMMAR_REGISTRY.get(id)?.height.maxM ?? 0) >= 100)
      .reduce((sum, id) => sum + (definition.buildingGrammarWeights[id] ?? 0), 0);
    expect(tallWeight).toBeGreaterThan(0.8);
  });
});
