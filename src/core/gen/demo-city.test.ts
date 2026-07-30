import { describe, expect, it } from "vitest";
import { VERTEX_FLOATS } from "../geom/mesh.js";
import { nodeDegree, validateGraph } from "../graph/road-graph.js";
import { buildCity, demoGraph, graphBounds, lotOptionsFromMetres } from "./demo-city.js";

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

describe("lotOptionsFromMetres", () => {
  it("scales with pixels per metre", () => {
    const a = lotOptionsFromMetres(25);
    const b = lotOptionsFromMetres(50);
    expect(b.lotSizePx).toBe(a.lotSizePx * 2);
    expect(b.minAreaPx2).toBe(a.minAreaPx2 * 4);
    expect(b.maxHeightM).toBe(a.maxHeightM);
  });
});

describe("buildCity", () => {
  const graph = demoGraph(ORIGIN, GRID);
  const bounds = graphBounds(graph, 10 * GRID);
  const build = buildCity(graph, bounds, PPM, lotOptionsFromMetres(PPM));

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
    const again = buildCity(graph, bounds, PPM, lotOptionsFromMetres(PPM));
    expect(again.buildingCount).toBe(build.buildingCount);
    expect(again.mesh.triangleCount).toBe(build.mesh.triangleCount);
    expect(Array.from(again.mesh.vertices)).toEqual(Array.from(build.mesh.vertices));
  });
});
