import { describe, expect, it } from "vitest";
import { VERTEX_FLOATS } from "../geom/mesh.js";
import { nodeDegree, validateGraph } from "../graph/road-graph.js";
import { ringBounds, type Rect } from "../geom/types.js";
import { insertRoad } from "../graph/edit.js";
import {
  BANK_COUNT,
  BANK_SIZE,
  BASE_BANK,
  CITY_BANK,
  CITY_SURFACES,
  DEFAULT_DISTRICT_PALETTE,
  materialIndex,
  packPalette,
  PALETTE_PRESETS
} from "../palette.js";
import { buildingsForBlocks } from "./blocks.js";
import { CLUTTER_MAX_HEIGHT_M } from "./clutter.js";
import { buildRoadSurfaces } from "./roads.js";
import { DEFAULT_ZONE_PARAMS, lotRegions, type Zone } from "./zones.js";
import {
  buildCity,
  cityBounds,
  cityPaletteBanks,
  cityToPixels,
  demoCity,
  demoGraph,
  graphBounds,
  rectToPixels,
  ROAD_CLASSES,
  withRoadClasses,
  type CityParams
} from "./demo-city.js";

/** Scene world-pixel point at which city metre (0, 0) sits. */
const ORIGIN = { x: 5000, y: 4000 };
const PPM = 25;
/** Ten grid squares at the 2 m/square scene contract. */
const MARGIN_M = 20;

describe("demoGraph", () => {
  const graph = demoGraph();

  it("is structurally valid", () => {
    expect(validateGraph(graph)).toEqual([]);
  });

  it("covers every junction shape the surface pass has to handle", () => {
    expect(nodeDegree(graph, "E")).toBe(4);
    expect(nodeDegree(graph, "F")).toBe(3);
    expect(nodeDegree(graph, "H")).toBe(3);
    expect(nodeDegree(graph, "A")).toBe(2);
    expect(nodeDegree(graph, "B")).toBe(4);
    expect(nodeDegree(graph, "D")).toBe(4);
  });

  it("places nodes in metres relative to the city origin", () => {
    const e = graph.nodes.find((n) => n.id === "E");
    expect(e).toEqual({ id: "E", x: 0, y: 0 });
    const c = graph.nodes.find((n) => n.id === "C");
    expect(c).toEqual({ id: "C", x: 80, y: -52 });
  });
});

describe("graphBounds", () => {
  it("wraps every node with the requested margin", () => {
    const graph = demoGraph();
    const b = graphBounds(graph, MARGIN_M);
    for (const n of graph.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(b.x);
      expect(n.x).toBeLessThanOrEqual(b.x + b.width);
      expect(n.y).toBeGreaterThanOrEqual(b.y);
      expect(n.y).toBeLessThanOrEqual(b.y + b.height);
    }
    expect(b.width).toBe(160 + MARGIN_M * 2);
  });
});

describe("cityBounds", () => {
  it("grows to cover zones as well as roads", () => {
    const city = demoCity(ORIGIN);
    const roadsOnly = cityBounds(city, 0)!;
    const far = { x: roadsOnly.x + roadsOnly.width + 1000, y: roadsOnly.y, width: 500, height: 500 };
    const withZone = cityBounds({ ...city, zones: [{ ...city.base, id: "z1", bank: 2, rect: far }] }, 0)!;
    expect(withZone.x + withZone.width).toBeCloseTo(far.x + far.width, 6);
  });

  it("is null for a city with nothing in it", () => {
    expect(cityBounds({ origin: ORIGIN, graph: { nodes: [], edges: [], classes: [] }, base: demoCity(ORIGIN).base, zones: [] }, 10)).toBeNull();
  });
});

describe("buildCity", () => {
  const city = demoCity(ORIGIN);
  const boundsM = graphBounds(city.graph, MARGIN_M);
  const bounds = rectToPixels(boundsM, ORIGIN, PPM);
  const build = buildCity(city, boundsM, PPM);

  it("produces blocks and buildings", () => {
    expect(build.blockCount).toBeGreaterThan(3);
    expect(build.buildingCount).toBeGreaterThan(20);
    expect(build.carCount).toBeGreaterThan(20);
  });

  it("produces a well-formed mesh", () => {
    expect(build.mesh.vertexCount).toBeGreaterThan(0);
    expect(build.mesh.vertices.length).toBe(build.mesh.vertexCount * VERTEX_FLOATS);
    expect(build.mesh.indices.length).toBe(build.mesh.triangleCount * 3);
    for (const i of build.mesh.indices) expect(i).toBeLessThan(build.mesh.vertexCount);
  });

  // Bounds are metres; the mesh is world pixels, so the comparison converts.
  it("keeps every vertex inside the city bounds", () => {
    for (let i = 0; i < build.mesh.vertexCount; i++) {
      const x = build.mesh.vertices[i * VERTEX_FLOATS]!;
      const y = build.mesh.vertices[i * VERTEX_FLOATS + 1]!;
      expect(x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(x).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(y).toBeGreaterThanOrEqual(bounds.y - 1);
      expect(y).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    }
  });

  it("keeps heights non-negative and bounded", () => {
    for (let i = 0; i < build.mesh.vertexCount; i++) {
      const h = build.mesh.vertices[i * VERTEX_FLOATS + 2]!;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(DEFAULT_ZONE_PARAMS.maxHeightM + CLUTTER_MAX_HEIGHT_M);
    }
  });

  it("stays well inside the 150k triangle budget", () => {
    expect(build.mesh.triangleCount).toBeLessThan(20000);
  });

  it("is deterministic", () => {
    const again = buildCity(city, boundsM, PPM);
    expect(again.buildingCount).toBe(build.buildingCount);
    expect(again.carCount).toBe(build.carCount);
    expect(again.mesh.triangleCount).toBe(build.mesh.triangleCount);
    expect(Array.from(again.mesh.vertices)).toEqual(Array.from(build.mesh.vertices));
  });
});

describe("demoCity", () => {
  it("starts the unzoned remainder on the default district palette", () => {
    expect(demoCity(ORIGIN).base.palette).toBe(DEFAULT_DISTRICT_PALETTE);
  });
});

describe("cityPaletteBanks", () => {
  const zone = (id: string, bank: number, palette = DEFAULT_DISTRICT_PALETTE): Zone => ({
    ...DEFAULT_ZONE_PARAMS,
    id,
    bank,
    palette,
    rect: { x: 0, y: 0, width: 10, height: 10 }
  });

  it("puts the shared surfaces in bank 0 and the base palette in bank 1", () => {
    const banks = cityPaletteBanks(demoCity(ORIGIN));
    expect(banks[CITY_BANK]).toBe(CITY_SURFACES);
    expect(banks[BASE_BANK]).toBe(DEFAULT_DISTRICT_PALETTE.materials);
  });

  it("puts each zone's palette at its own bank", () => {
    const preset = PALETTE_PRESETS[2]!;
    const city = { ...demoCity(ORIGIN), zones: [zone("z1", 7, preset), zone("z2", 3)] };
    const banks = cityPaletteBanks(city);
    expect(banks[7]).toBe(preset.materials);
    expect(banks[3]).toBe(DEFAULT_DISTRICT_PALETTE.materials);
  });

  it("fills every bank, so no chunk can sample a hole or read past the end", () => {
    const city = { ...demoCity(ORIGIN), zones: [zone("z1", 7, PALETTE_PRESETS[2]!)] };
    const banks = cityPaletteBanks(city);
    expect(banks).toHaveLength(BANK_COUNT);
    for (let bank = 0; bank < BANK_COUNT; bank++) expect(banks[bank]).toBeDefined();

    // Base-row alpha is written only for a material `packPalette` actually saw, so this
    // catches a hole the `toBeDefined` loop above would miss if the fill ever shortens.
    const data = packPalette(banks);
    for (let bank = 0; bank < BANK_COUNT; bank++) {
      expect(data[materialIndex(bank, 0) * 4 + 3]).toBe(255);
    }
  });
});

describe("district banks", () => {
  const zone = (id: string, bank: number, rect: Rect, seed: number): Zone => ({
    ...DEFAULT_ZONE_PARAMS,
    id,
    bank,
    rect,
    seed
  });

  const WEST: Rect = { x: -110, y: -80, width: 110, height: 160 };
  const EAST: Rect = { x: 0, y: -80, width: 110, height: 160 };
  const EAST_MOVED: Rect = { x: 30, y: -80, width: 110, height: 160 };
  /** Fixed, so the only thing changing between runs is the zone under test. */
  const BOUNDS_M: Rect = { x: -140, y: -100, width: 300, height: 200 };

  const specsFor = (zones: Zone[]) => {
    const params: CityParams = { ...demoCity(ORIGIN), zones };
    const bounds = rectToPixels(BOUNDS_M, ORIGIN, PPM);
    const px = cityToPixels(params, PPM);
    const surfaces = buildRoadSurfaces(px.graph, bounds, PPM);
    return buildingsForBlocks(
      surfaces.blocks,
      lotRegions(params.base, px.zones, bounds, PPM, params.origin),
      { originPx: ORIGIN, pixelsPerMetre: PPM }
    );
  };

  const inBank = (specs: ReturnType<typeof specsFor>, bank: number): string[] =>
    specs
      .filter((s) => Math.floor(s.wallMaterial / BANK_SIZE) === bank)
      .map((s) => {
        const b = ringBounds(s.footprint);
        return `${Math.round(b.x)},${Math.round(b.y)}:${s.wallMaterial}/${s.roofMaterial}`;
      })
      .sort();

  it("bands each district into its own bank and leaves the remainder on the base bank", () => {
    const specs = specsFor([zone("z1", 4, WEST, 1), zone("z2", 9, EAST, 2)]);
    const banks = new Set(specs.map((s) => Math.floor(s.wallMaterial / BANK_SIZE)));
    expect(banks).toEqual(new Set([BASE_BANK, 4, 9]));
  });

  it("cannot let one district's reseed or move reach another's material indices", () => {
    const before = specsFor([zone("z1", 4, WEST, 1), zone("z2", 9, EAST, 2)]);
    const reseeded = specsFor([zone("z1", 4, WEST, 1), zone("z2", 9, EAST, 55)]);
    const moved = specsFor([zone("z1", 4, WEST, 1), zone("z2", 9, EAST_MOVED, 2)]);

    expect(inBank(before, 4).length).toBeGreaterThan(5);
    expect(inBank(reseeded, 4)).toEqual(inBank(before, 4));
    expect(inBank(moved, 4)).toEqual(inBank(before, 4));
    expect(inBank(reseeded, 9)).not.toEqual(inBank(before, 9));
  });
});

describe("ROAD_CLASSES", () => {
  it("has unique ids and sane widths", () => {
    expect(new Set(ROAD_CLASSES.map((c) => c.id)).size).toBe(ROAD_CLASSES.length);
    for (const c of ROAD_CLASSES) {
      expect(c.widthM).toBeGreaterThan(0);
      expect(c.sidewalkM).toBeGreaterThanOrEqual(0);
    }
  });

  it("runs widest to narrowest", () => {
    const widths = ROAD_CLASSES.map((c) => c.widthM);
    expect([...widths].sort((a, b) => b - a)).toEqual(widths);
  });

  it("adopts the current presets onto a stored graph", () => {
    const stale = { nodes: [], edges: [], classes: [{ id: "street", widthM: 1, sidewalkM: 0 }] };
    expect(withRoadClasses(stale).classes).toEqual(ROAD_CLASSES);
  });
});

describe("growing the city", () => {
  const city = demoCity(ORIGIN);

  // Blocks inside the road network are carved by roads on every side, so they cannot be
  // touched by the bounds rect moving. Their buildings must survive an extension exactly.
  const core = rectToPixels(graphBounds(city.graph, 0), ORIGIN, PPM);
  const specsInsideNetwork = (params: CityParams): string[] => {
    const bounds = rectToPixels(cityBounds(params, MARGIN_M)!, params.origin, PPM);
    const px = cityToPixels(params, PPM);
    const surfaces = buildRoadSurfaces(px.graph, bounds, PPM);
    const specs = buildingsForBlocks(
      surfaces.blocks,
      lotRegions(params.base, px.zones, bounds, PPM, params.origin),
      { originPx: params.origin, pixelsPerMetre: PPM }
    );
    return specs
      .filter((s) => {
        const b = ringBounds(s.footprint);
        return (
          b.x >= core.x &&
          b.y >= core.y &&
          b.x + b.width <= core.x + core.width &&
          b.y + b.height <= core.y + core.height
        );
      })
      .map((s) => `${Math.round(s.footprint[0]!.x)},${Math.round(s.footprint[0]!.y)},${s.height.toFixed(4)},${s.wallMaterial}`)
      .sort();
  };

  it("leaves the existing buildings exactly where they were", () => {
    const before = specsInsideNetwork(city);
    const grown = {
      ...city,
      graph: insertRoad(city.graph, { x: 120, y: -120 }, { x: 120, y: 120 }, "street", {
        snapM: 0.8
      })
    };

    expect(cityBounds(grown, MARGIN_M)!.width).toBeGreaterThan(cityBounds(city, MARGIN_M)!.width);
    expect(before.length).toBeGreaterThan(20);
    expect(specsInsideNetwork(grown)).toEqual(before);
  });
});

// The whole point of storing the city in metres: a scene regrid rescales it, never
// regenerates it. Positions, heights and materials all have to survive.
describe("changing the scene grid size", () => {
  const city = demoCity(ORIGIN);
  const boundsM = cityBounds(city, MARGIN_M)!;

  const specsAt = (ppm: number) => {
    const bounds = rectToPixels(boundsM, ORIGIN, ppm);
    const px = cityToPixels(city, ppm);
    const surfaces = buildRoadSurfaces(px.graph, bounds, ppm);
    return buildingsForBlocks(
      surfaces.blocks,
      lotRegions(city.base, px.zones, bounds, ppm, ORIGIN),
      { originPx: ORIGIN, pixelsPerMetre: ppm }
    );
  };

  const coarse = specsAt(25);
  const fine = specsAt(60);

  it("produces the same buildings in the same metre positions", () => {
    const metres = (specs: typeof coarse, ppm: number): string[] =>
      specs.map((s) =>
        s.footprint
          .map((p) => `${((p.x - ORIGIN.x) / ppm).toFixed(3)},${((p.y - ORIGIN.y) / ppm).toFixed(3)}`)
          .join(" ")
      );
    expect(coarse.length).toBeGreaterThan(20);
    expect(fine).toHaveLength(coarse.length);
    expect(metres(fine, 60)).toEqual(metres(coarse, 25));
  });

  it("keeps every height and material identical", () => {
    expect(fine.map((s) => s.height)).toEqual(coarse.map((s) => s.height));
    expect(fine.map((s) => s.wallMaterial)).toEqual(coarse.map((s) => s.wallMaterial));
    expect(fine.map((s) => s.roofMaterial)).toEqual(coarse.map((s) => s.roofMaterial));
  });
});
