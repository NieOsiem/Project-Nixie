import { describe, expect, it } from "vitest";
import { VERTEX_FLOATS } from "../geom/mesh.js";
import { nodeDegree, validateGraph } from "../graph/road-graph.js";
import { ringBounds } from "../geom/types.js";
import { insertRoad } from "../graph/edit.js";
import { buildingsForBlocks } from "./blocks.js";
import { buildRoadSurfaces } from "./roads.js";
import { lotRegions } from "./zones.js";
import {
  buildCity,
  cityBounds,
  demoCity,
  demoGraph,
  graphBounds,
  ROAD_CLASSES,
  withRoadClasses
} from "./demo-city.js";

const ORIGIN = { x: 5000, y: 4000 };
const GRID = 50;
const PPM = GRID / 2;

describe("demoGraph", () => {
  const graph = demoGraph(ORIGIN, GRID);

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

  it("places nodes relative to the origin in grid units", () => {
    const e = graph.nodes.find((n) => n.id === "E");
    expect(e).toEqual({ id: "E", x: ORIGIN.x, y: ORIGIN.y });
    const c = graph.nodes.find((n) => n.id === "C");
    expect(c).toEqual({ id: "C", x: ORIGIN.x + 40 * GRID, y: ORIGIN.y - 26 * GRID });
  });
});

describe("graphBounds", () => {
  it("wraps every node with the requested margin", () => {
    const graph = demoGraph(ORIGIN, GRID);
    const b = graphBounds(graph, 10 * GRID);
    for (const n of graph.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(b.x);
      expect(n.x).toBeLessThanOrEqual(b.x + b.width);
      expect(n.y).toBeGreaterThanOrEqual(b.y);
      expect(n.y).toBeLessThanOrEqual(b.y + b.height);
    }
    expect(b.width).toBe(80 * GRID + 20 * GRID);
  });
});

describe("cityBounds", () => {
  it("grows to cover zones as well as roads", () => {
    const city = demoCity(ORIGIN, GRID);
    const roadsOnly = cityBounds(city, 0)!;
    const far = { x: roadsOnly.x + roadsOnly.width + 1000, y: roadsOnly.y, width: 500, height: 500 };
    const withZone = cityBounds({ ...city, zones: [{ ...city.base, id: "z1", rect: far }] }, 0)!;
    expect(withZone.x + withZone.width).toBeCloseTo(far.x + far.width, 6);
  });

  it("is null for a city with nothing in it", () => {
    expect(cityBounds({ graph: { nodes: [], edges: [], classes: [] }, base: demoCity(ORIGIN, GRID).base, zones: [] }, 10)).toBeNull();
  });
});

describe("buildCity", () => {
  const city = demoCity(ORIGIN, GRID);
  const bounds = graphBounds(city.graph, 10 * GRID);
  const build = buildCity(city, bounds, PPM);

  it("produces blocks and buildings", () => {
    expect(build.blockCount).toBeGreaterThan(3);
    expect(build.buildingCount).toBeGreaterThan(20);
  });

  it("produces a well-formed mesh", () => {
    expect(build.mesh.vertexCount).toBeGreaterThan(0);
    expect(build.mesh.vertices.length).toBe(build.mesh.vertexCount * VERTEX_FLOATS);
    expect(build.mesh.indices.length).toBe(build.mesh.triangleCount * 3);
    for (const i of build.mesh.indices) expect(i).toBeLessThan(build.mesh.vertexCount);
  });

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
      expect(h).toBeLessThanOrEqual(140);
    }
  });

  it("stays well inside the 150k triangle budget", () => {
    expect(build.mesh.triangleCount).toBeLessThan(20000);
  });

  it("is deterministic", () => {
    const again = buildCity(city, bounds, PPM);
    expect(again.buildingCount).toBe(build.buildingCount);
    expect(again.mesh.triangleCount).toBe(build.mesh.triangleCount);
    expect(Array.from(again.mesh.vertices)).toEqual(Array.from(build.mesh.vertices));
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
  const city = demoCity(ORIGIN, GRID);

  // Blocks inside the road network are carved by roads on every side, so they cannot be
  // touched by the bounds rect moving. Their buildings must survive an extension exactly.
  const core = graphBounds(city.graph, 0);
  const specsInsideNetwork = (params: typeof city): string[] => {
    const bounds = cityBounds(params, 10 * GRID)!;
    const surfaces = buildRoadSurfaces(params.graph, bounds, PPM);
    const specs = buildingsForBlocks(surfaces.blocks, lotRegions(params.base, params.zones, bounds, PPM));
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
      graph: insertRoad(
        city.graph,
        { x: ORIGIN.x + 60 * GRID, y: ORIGIN.y - 60 * GRID },
        { x: ORIGIN.x + 60 * GRID, y: ORIGIN.y + 60 * GRID },
        "street",
        { snapPx: GRID * 0.4 }
      )
    };

    expect(cityBounds(grown, 10 * GRID)!.width).toBeGreaterThan(cityBounds(city, 10 * GRID)!.width);
    expect(before.length).toBeGreaterThan(20);
    expect(specsInsideNetwork(grown)).toEqual(before);
  });
});
