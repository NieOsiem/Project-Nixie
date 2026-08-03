import type { Vec2 } from "../geom/types.js";
import { validateTerrain, type TerrainGeneration, type TerrainSource } from "./terrain.js";

export type RoadCurvePreset = "tight" | "standard" | "broad";
export type RoadOrigin = "generated" | "authored";
export type RoadLayout = "european" | "grid" | "mixed";
export type HubMode = "single-centre" | "multiple-hubs";

export const ROAD_CURVE_PRESETS: readonly RoadCurvePreset[] = ["tight", "standard", "broad"];
export const ROAD_LAYOUTS: readonly RoadLayout[] = ["european", "grid", "mixed"];
export const HUB_MODES: readonly HubMode[] = ["single-centre", "multiple-hubs"];

export const ROUTE_CLASS_IDS = [
  "highway",
  "arterial",
  "street",
  "narrow",
  "lane",
  "alley",
  "pedestrian-path",
  "park-path",
  "plaza-route",
  "public-passage",
  "waterfront-promenade",
  "cycleway"
] as const;
export type RouteClassId = (typeof ROUTE_CLASS_IDS)[number];

export type RouteSurface = "vehicle" | "non-vehicle";

export interface RouteClassDefinition {
  readonly id: RouteClassId;
  readonly vehicle: boolean;
  readonly widthM: number;
  readonly sidewalkM: number;
  readonly surface: RouteSurface;
  readonly centreMarking: boolean;
}

// WHY: Keeping the registry code-owned prevents width/material tables from leaking into every Scene flag.
export const ROUTE_CLASSES: readonly RouteClassDefinition[] = [
  { id: "highway", vehicle: true, widthM: 24, sidewalkM: 3, surface: "vehicle", centreMarking: true },
  { id: "arterial", vehicle: true, widthM: 16, sidewalkM: 3, surface: "vehicle", centreMarking: true },
  { id: "street", vehicle: true, widthM: 9, sidewalkM: 2.5, surface: "vehicle", centreMarking: true },
  { id: "narrow", vehicle: true, widthM: 6, sidewalkM: 2, surface: "vehicle", centreMarking: false },
  { id: "lane", vehicle: true, widthM: 4, sidewalkM: 1.5, surface: "vehicle", centreMarking: false },
  { id: "alley", vehicle: true, widthM: 2, sidewalkM: 0, surface: "vehicle", centreMarking: false },
  { id: "pedestrian-path", vehicle: false, widthM: 3, sidewalkM: 0, surface: "non-vehicle", centreMarking: false },
  { id: "park-path", vehicle: false, widthM: 2.5, sidewalkM: 0, surface: "non-vehicle", centreMarking: false },
  { id: "plaza-route", vehicle: false, widthM: 4, sidewalkM: 0, surface: "non-vehicle", centreMarking: false },
  { id: "public-passage", vehicle: false, widthM: 2, sidewalkM: 0, surface: "non-vehicle", centreMarking: false },
  { id: "waterfront-promenade", vehicle: false, widthM: 5, sidewalkM: 0, surface: "non-vehicle", centreMarking: false },
  { id: "cycleway", vehicle: false, widthM: 3, sidewalkM: 0, surface: "non-vehicle", centreMarking: false }
] as const;

export const ROUTE_CLASS_REGISTRY: ReadonlyMap<RouteClassId, RouteClassDefinition> = new Map(
  ROUTE_CLASSES.map((routeClass) => [routeClass.id, routeClass])
);

export interface RoadNodeSource extends Vec2 {
  id: string;
}

export interface RoadRouteSource {
  id: string;
  curvePreset: RoadCurvePreset;
}

export interface RoadEdgeSource {
  id: string;
  a: string;
  b: string;
  routeId: string;
  classId: RouteClassId;
  name: string | null;
  locked: boolean;
  origin: RoadOrigin;
}

export interface RoadSource {
  nodes: RoadNodeSource[];
  routes: RoadRouteSource[];
  edges: RoadEdgeSource[];
}

export interface CitySourceV2 {
  origin: Vec2;
  citySeed: string;
  generation: TerrainGeneration & { roadLayout: RoadLayout; hubMode: HubMode };
  terrain: TerrainSource;
  roads: RoadSource;
}

export interface CityStateV2 {
  kind: "city-generator-2";
  schemaVersion: 2;
  generatorVersion: 9;
  revision: number;
  source: CitySourceV2;
}

export interface LegacyCitySourceV1 {
  origin: Vec2;
  citySeed: string;
  generation: TerrainGeneration;
  terrain: TerrainSource;
}

export interface LegacyCityStateV1 {
  kind: "city-generator-2";
  schemaVersion: 1;
  generatorVersion: number;
  revision: number;
  source: LegacyCitySourceV1;
}

interface LegacyStateEnvelope {
  source: LegacyCitySourceV1;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteVec(value: unknown): value is Vec2 {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}

function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function validateRoadSource(roads: unknown, registry: ReadonlyMap<string, RouteClassDefinition> = ROUTE_CLASS_REGISTRY): string[] {
  const problems: string[] = [];
  if (!isRecord(roads)) return ["Road source must be an object."];
  const nodes = roads.nodes;
  const routes = roads.routes;
  const edges = roads.edges;
  if (!Array.isArray(nodes)) problems.push("Road nodes must be an array.");
  if (!Array.isArray(routes)) problems.push("Road routes must be an array.");
  if (!Array.isArray(edges)) problems.push("Road edges must be an array.");
  if (!Array.isArray(nodes) || !Array.isArray(routes) || !Array.isArray(edges)) return problems;

  const nodeIds = new Set<string>();
  for (const value of nodes) {
    if (!isRecord(value) || !nonEmptyId(value.id) || !finiteVec(value)) {
      problems.push("Road nodes require a non-empty id and finite x/y.");
      continue;
    }
    if (nodeIds.has(value.id)) problems.push(`Duplicate road node id "${value.id}".`);
    nodeIds.add(value.id);
  }
  const routeIds = new Set<string>();
  for (const value of routes) {
    if (!isRecord(value) || !nonEmptyId(value.id) || !enumValue(value.curvePreset, ROAD_CURVE_PRESETS)) {
      problems.push("Road routes require a non-empty id and valid curvePreset.");
      continue;
    }
    if (routeIds.has(value.id) || nodeIds.has(value.id)) problems.push(`Duplicate road route id "${value.id}".`);
    routeIds.add(value.id);
  }
  const edgeIds = new Set<string>();
  const edgeRouteUse = new Set<string>();
  for (const value of edges) {
    if (!isRecord(value) || !nonEmptyId(value.id)) {
      problems.push("Road edges require a non-empty id.");
      continue;
    }
    if (edgeIds.has(value.id) || nodeIds.has(value.id) || routeIds.has(value.id)) problems.push(`Duplicate road edge id "${value.id}".`);
    edgeIds.add(value.id);
    if (typeof value.a !== "string" || !nodeIds.has(value.a)) problems.push(`Road edge "${value.id}" references unknown node "${String(value.a)}".`);
    if (typeof value.b !== "string" || !nodeIds.has(value.b)) problems.push(`Road edge "${value.id}" references unknown node "${String(value.b)}".`);
    if (value.a === value.b) problems.push(`Road edge "${value.id}" is a self-loop.`);
    if (typeof value.routeId !== "string" || !routeIds.has(value.routeId)) problems.push(`Road edge "${value.id}" references unknown route "${String(value.routeId)}".`);
    else edgeRouteUse.add(value.routeId);
    if (typeof value.classId !== "string" || !registry.has(value.classId)) problems.push(`Road edge "${value.id}" references unknown route class "${String(value.classId)}".`);
    if (!(value.name === null || typeof value.name === "string")) problems.push(`Road edge "${value.id}" name must be text or null.`);
    if (typeof value.locked !== "boolean") problems.push(`Road edge "${value.id}" locked must be boolean.`);
    if (!enumValue(value.origin, ["generated", "authored"] as const)) problems.push(`Road edge "${value.id}" has invalid origin.`);
  }
  for (const id of routeIds) if (!edgeRouteUse.has(id)) problems.push(`Road route "${id}" is unreferenced.`);
  return problems;
}

export function validateCitySourceV2(source: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(source)) return ["City source must be an object."];
  if (!finiteVec(source.origin)) problems.push("City origin must have finite x/y.");
  if (typeof source.citySeed !== "string" || source.citySeed.trim().length === 0) problems.push("City seed must be non-empty text.");
  const generation = source.generation;
  if (!isRecord(generation)) problems.push("City generation must be an object.");
  else {
    if (!enumValue(generation.terrainMode, ["rectangle", "coastal", "custom"] as const)) problems.push("Invalid terrain mode.");
    if (!(generation.coastEdge === null || enumValue(generation.coastEdge, ["north", "east", "south", "west"] as const))) problems.push("Invalid coast edge.");
    if (!enumValue(generation.roadLayout, ROAD_LAYOUTS)) problems.push("Invalid road layout.");
    if (!enumValue(generation.hubMode, HUB_MODES)) problems.push("Invalid hub mode.");
  }
  const terrain = source.terrain;
  if (!isRecord(terrain)) problems.push("City terrain must be an object.");
  else {
    const terrainProblems = validateTerrain(terrain as unknown as TerrainSource);
    if (!terrainProblems.ok) problems.push(terrainProblems.reason);
  }
  problems.push(...validateRoadSource(source.roads));
  return problems;
}

export function validateCityStateV2(state: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(state)) return ["City state must be an object."];
  if (state.kind !== "city-generator-2") problems.push("Invalid city kind.");
  if (state.schemaVersion !== 2) problems.push("Unsupported city schema version.");
  if (state.generatorVersion !== 9) problems.push("Unsupported city generator version.");
  if (typeof state.revision !== "number" || !Number.isInteger(state.revision) || state.revision < 1) problems.push("City revision must be a positive integer.");
  problems.push(...validateCitySourceV2(state.source));
  return problems;
}

export function migrateSchema1ToSchema2(input: LegacyCityStateV1 | LegacyStateEnvelope | LegacyCitySourceV1, revision?: number): CityStateV2 {
  const isState = "source" in input;
  const source: LegacyCitySourceV1 = isState ? input.source : input;
  const migratedRevision = isState ? input.revision : revision;
  if (migratedRevision === undefined || !Number.isInteger(migratedRevision) || migratedRevision < 1) throw new Error("Schema-1 revision must be a positive integer.");
  const out: CitySourceV2 = {
    origin: { ...source.origin },
    citySeed: source.citySeed,
    generation: {
      terrainMode: source.generation.terrainMode,
      coastEdge: source.generation.coastEdge,
      roadLayout: "european",
      hubMode: "single-centre"
    },
    terrain: {
      land: source.terrain.land.map((p) => ({ ...p })),
      urbanFootprint: source.terrain.urbanFootprint?.map((p) => ({ ...p })) ?? null
    },
    roads: { nodes: [], routes: [], edges: [] }
  };
  return { kind: "city-generator-2", schemaVersion: 2, generatorVersion: 9, revision: migratedRevision, source: out };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function idFrom(prefix: string, material: string, used: ReadonlySet<string>): string {
  const base = `${prefix}_${fnv1a(material).toString(16).padStart(8, "0")}`;
  if (!used.has(base)) return base;
  for (let suffix = 1; ; suffix++) {
    const id = `${base}_${suffix}`;
    if (!used.has(id)) return id;
  }
}

export function allocateGeneratedId(kind: "node" | "edge" | "route", citySeed: string, role: string, index: number, used: ReadonlySet<string> = new Set()): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Generated ID index must be a non-negative integer.");
  return idFrom(`g${kind[0]}`, `${citySeed}\0roads/${kind}\0${role}\0${index}`, used);
}

export function allocateManualId(kind: "node" | "edge" | "route", revision: number, sequence: number, lineage: string, used: ReadonlySet<string> = new Set()): string {
  if (!Number.isInteger(revision) || revision < 0 || !Number.isInteger(sequence) || sequence < 0) throw new Error("Manual ID revision and sequence must be non-negative integers.");
  return idFrom(`m${kind[0]}`, `${revision}\0${sequence}\0${lineage}`, used);
}

export function emptyRoadSource(): RoadSource {
  return { nodes: [], routes: [], edges: [] };
}

export const BUILTIN_ROUTE_CLASSES = ROUTE_CLASSES;
