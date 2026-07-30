import { describe, expect, it } from "vitest";
import {
  classMap,
  edgeLength,
  edgeVector,
  incidentEdges,
  nodeDegree,
  nodeMap,
  validateGraph,
  type RoadGraph
} from "./road-graph.js";

const graph = (): RoadGraph => ({
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 100, y: 0 },
    { id: "c", x: 100, y: 100 }
  ],
  edges: [
    { id: "ab", a: "a", b: "b", classId: "street" },
    { id: "bc", a: "b", b: "c", classId: "street" }
  ],
  classes: [{ id: "street", widthM: 9, sidewalkM: 2.5 }]
});

describe("lookups", () => {
  it("indexes nodes and classes by id", () => {
    expect(nodeMap(graph()).get("b")).toEqual({ id: "b", x: 100, y: 0 });
    expect(classMap(graph()).get("street")?.widthM).toBe(9);
  });

  it("finds edges at a node from either end", () => {
    expect(incidentEdges(graph(), "b").map((e) => e.id)).toEqual(["ab", "bc"]);
    expect(incidentEdges(graph(), "a").map((e) => e.id)).toEqual(["ab"]);
    expect(incidentEdges(graph(), "nope")).toEqual([]);
  });

  it("counts degree", () => {
    expect(nodeDegree(graph(), "b")).toBe(2);
    expect(nodeDegree(graph(), "a")).toBe(1);
  });
});

describe("edge geometry", () => {
  it("computes vector and length", () => {
    const a = { id: "a", x: 10, y: 20 };
    const b = { id: "b", x: 13, y: 24 };
    expect(edgeVector(a, b)).toEqual({ x: 3, y: 4 });
    expect(edgeLength(a, b)).toBe(5);
  });
});

describe("validateGraph", () => {
  it("accepts a well-formed graph", () => {
    expect(validateGraph(graph())).toEqual([]);
  });

  it("flags an unknown node reference", () => {
    const g = graph();
    g.edges.push({ id: "zz", a: "a", b: "missing", classId: "street" });
    expect(validateGraph(g).join(" ")).toMatch(/unknown node "missing"/);
  });

  it("flags an unknown class reference", () => {
    const g = graph();
    g.edges.push({ id: "zz", a: "a", b: "c", classId: "motorway" });
    expect(validateGraph(g).join(" ")).toMatch(/unknown class "motorway"/);
  });

  it("flags self-loops and zero-length edges", () => {
    const g = graph();
    g.nodes.push({ id: "d", x: 0, y: 0 });
    g.edges.push({ id: "loop", a: "a", b: "a", classId: "street" });
    g.edges.push({ id: "zero", a: "a", b: "d", classId: "street" });
    const problems = validateGraph(g).join(" ");
    expect(problems).toMatch(/self-loop/);
    expect(problems).toMatch(/zero length/);
  });

  it("flags duplicate ids", () => {
    const g = graph();
    g.nodes.push({ id: "a", x: 5, y: 5 });
    g.edges.push({ id: "ab", a: "a", b: "c", classId: "street" });
    const problems = validateGraph(g).join(" ");
    expect(problems).toMatch(/Duplicate node id "a"/);
    expect(problems).toMatch(/Duplicate edge id "ab"/);
  });

  it("flags non-finite positions", () => {
    const g = graph();
    g.nodes.push({ id: "nan", x: Number.NaN, y: 0 });
    expect(validateGraph(g).join(" ")).toMatch(/non-finite/);
  });

  it("flags bad class dimensions", () => {
    const g = graph();
    g.classes.push({ id: "bad", widthM: 0, sidewalkM: -1 });
    const problems = validateGraph(g).join(" ");
    expect(problems).toMatch(/non-positive width/);
    expect(problems).toMatch(/negative pavement/);
  });
});
