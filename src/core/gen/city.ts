import type { Vec2 } from "../geom/types.js";
import { intersection, isSnapNoise, ringAsMulti } from "../geom/boolean.js";
import { ringArea, type Ring } from "../geom/types.js";
import { validateTerrain, validateRing, type TerrainGeneration, type TerrainSource } from "./terrain.js";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS, type BuildingGrammarId, type BuildingUseId } from "./building-registry.js";
import { LANDMARK_GRAMMAR_IDS, type LandmarkGrammarId } from "./landmark-registry.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_IDS, type DistrictTypeId } from "./district-registry.js";

export type ArchitectureOrigin = "generated" | "authored";
export type ArchitectureProtection = "none" | "explicit" | "manual-edit";

export const ARCHITECTURE_ORIGINS: readonly ArchitectureOrigin[] = ["generated", "authored"];
export const ARCHITECTURE_PROTECTIONS: readonly ArchitectureProtection[] = ["none", "explicit", "manual-edit"];
export const ARCHITECTURE_TARGET_KINDS = ["building", "place"] as const;
export type ArchitectureTargetKind = (typeof ARCHITECTURE_TARGET_KINDS)[number];

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
  { id: "highway", vehicle: true, widthM: 24, sidewalkM: 3.5, surface: "vehicle", centreMarking: true },
  { id: "arterial", vehicle: true, widthM: 16, sidewalkM: 3.0, surface: "vehicle", centreMarking: true },
  { id: "street", vehicle: true, widthM: 8, sidewalkM: 2.0, surface: "vehicle", centreMarking: true },
  { id: "narrow", vehicle: true, widthM: 5.5, sidewalkM: 1.5, surface: "vehicle", centreMarking: false },
  { id: "lane", vehicle: true, widthM: 3.5, sidewalkM: 1.0, surface: "vehicle", centreMarking: false },
  { id: "alley", vehicle: true, widthM: 2.5, sidewalkM: 0, surface: "vehicle", centreMarking: false },
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

export type DistrictPaletteId = string;
export type DistrictOpenSpaceProfile = "none" | "very-low" | "low" | "medium" | "high";
export type DistrictOpenSpaceOverride = {
  rate: number;
  categoryWeights: Record<OpenSpaceCategory, number>;
  sizeWeights: Record<OpenSpaceSize, number>;
};
export type OpenSpaceCategory =
  | "park"
  | "plaza"
  | "parking"
  | "vacant"
  | "utility"
  | "landscaping"
  | "service-yard";
export type OpenSpaceSize = "pocket" | "small" | "large" | "whole-block";

export const OPEN_SPACE_CATEGORIES: readonly OpenSpaceCategory[] = [
  "park",
  "plaza",
  "parking",
  "vacant",
  "utility",
  "landscaping",
  "service-yard"
];
export const OPEN_SPACE_SIZES: readonly OpenSpaceSize[] = ["pocket", "small", "large", "whole-block"];
export const OPEN_SPACE_PROFILES: readonly DistrictOpenSpaceProfile[] = ["none", "very-low", "low", "medium", "high"];

export interface DistrictSource {
  id: string;
  polygon: Ring;
  seed: string;
  typeId: DistrictTypeId;
  paletteId: DistrictPaletteId;
  origin: "generated" | "authored";
  locked: boolean;
  openSpaceOverride: DistrictOpenSpaceOverride | null;
}

export interface CitySourceV3 {
  origin: Vec2;
  citySeed: string;
  generation: TerrainGeneration & {
    roadLayout: RoadLayout;
    hubMode: HubMode;
    districtPool: DistrictTypeId[];
    openSpaceProfile: DistrictOpenSpaceProfile;
  };
  terrain: TerrainSource;
  roads: RoadSource;
  districts: DistrictSource[];
}

export interface CityStateV3 {
  kind: "city-generator-2";
  schemaVersion: 3;
  generatorVersion: 11;
  revision: number;
  source: CitySourceV3;
}

export interface PlacementFrame {
  centre: Vec2;
  rotationRad: number;
  widthM: number;
  depthM: number;
}

export interface PersistentBuildingSource {
  id: string;
  lineage: string;
  origin: ArchitectureOrigin;
  protection: ArchitectureProtection;
  seed: string;
  appearanceSeed: string;
  grammarId: BuildingGrammarId;
  visualUse: BuildingUseId;
  heightM: number;
  paletteId: string | null;
  sitePolygon: Ring;
  placement: PlacementFrame;
  districtId: string | null;
  blockId: string | null;
}

export interface PersistentPlaceSource {
  id: string;
  lineage: string;
  origin: ArchitectureOrigin;
  protection: ArchitectureProtection;
  seed: string;
  appearanceSeed: string;
  landmarkGrammarId: LandmarkGrammarId;
  paletteId: string | null;
  sitePolygon: Ring;
  placement: PlacementFrame;
  districtId: string | null;
  blockId: string | null;
}

export interface ArchitectureOverrideSource {
  targetKind: ArchitectureTargetKind;
  targetId: string;
  lineage: string;
  protection: ArchitectureProtection;
  snapshotSitePolygon: Ring;
  appearanceSeed?: string;
  paletteId?: string | null;
}

export interface ArchitectureSource {
  buildings: PersistentBuildingSource[];
  places: PersistentPlaceSource[];
  overrides: ArchitectureOverrideSource[];
}

export interface CitySourceV4 {
  origin: Vec2;
  citySeed: string;
  generation: TerrainGeneration & {
    roadLayout: RoadLayout;
    hubMode: HubMode;
    districtPool: DistrictTypeId[];
    openSpaceProfile: DistrictOpenSpaceProfile;
  };
  terrain: TerrainSource;
  roads: RoadSource;
  districts: DistrictSource[];
  architecture: ArchitectureSource;
}

export interface CityStateV4 {
  kind: "city-generator-2";
  schemaVersion: 4;
  generatorVersion: 12;
  revision: number;
  source: CitySourceV4;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteVec(value: unknown): value is Vec2 {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}

function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, expected: readonly string[], label: string): string[] {
  const allowed = new Set(expected);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label} has unknown field "${key}".`);
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasValidPlacementFields(value: unknown): value is PlacementFrame {
  return isObject(value)
    && finiteVec(value.centre)
    && typeof value.rotationRad === "number"
    && Number.isFinite(value.rotationRad)
    && finitePositive(value.widthM)
    && finitePositive(value.depthM);
}

function nullableId(value: unknown, label: string): string[] {
  return value === null || nonEmptyId(value) ? [] : [`${label} must be non-empty text or null.`];
}

function paletteProblems(value: unknown, label: string, nullable: boolean): string[] {
  if (nullable && value === null) return [];
  if (!nonEmptyText(value) || !(DISTRICT_PALETTE_IDS as readonly string[]).includes(value)) {
    return [`${label} must be a known palette id${nullable ? " or null" : ""}.`];
  }
  return [];
}

function ringProblems(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [`${label} must be a ring.`];
  const validation = validateRing(value as Ring);
  return validation.ok ? [] : [`${label}: ${validation.reason}`];
}

function placementFootprint(frame: PlacementFrame): Ring {
  const halfWidth = frame.widthM / 2;
  const halfDepth = frame.depthM / 2;
  const cosine = Math.cos(frame.rotationRad);
  const sine = Math.sin(frame.rotationRad);
  const axisX = { x: cosine * halfWidth, y: sine * halfWidth };
  const axisY = { x: -sine * halfDepth, y: cosine * halfDepth };
  return [
    { x: frame.centre.x - axisX.x - axisY.x, y: frame.centre.y - axisX.y - axisY.y },
    { x: frame.centre.x + axisX.x - axisY.x, y: frame.centre.y + axisX.y - axisY.y },
    { x: frame.centre.x + axisX.x + axisY.x, y: frame.centre.y + axisX.y + axisY.y },
    { x: frame.centre.x - axisX.x + axisY.x, y: frame.centre.y - axisX.y + axisY.y }
  ];
}

function placementContainedBySite(frame: PlacementFrame, sitePolygon: Ring): boolean {
  const footprint = placementFootprint(frame);
  const footprintArea = frame.widthM * frame.depthM;
  if (!Number.isFinite(footprintArea) || footprintArea <= 0) return false;
  try {
    const overlap = intersection(ringAsMulti(footprint), ringAsMulti(sitePolygon));
    let overlapArea = 0;
    for (const polygon of overlap) {
      if (polygon.length === 0) continue;
      overlapArea += Math.abs(ringArea(polygon[0]!));
      for (const hole of polygon.slice(1)) overlapArea -= Math.abs(ringArea(hole));
    }
    const tolerance = Math.max(1e-4, footprintArea * 1e-6);
    return overlapArea + tolerance >= footprintArea;
  } catch {
    return false;
  }
}

export function validatePlacementFrame(value: unknown): string[] {
  if (!isObject(value)) return ["Placement frame must be an object."];
  const problems = unknownKeys(value, ["centre", "rotationRad", "widthM", "depthM"], "Placement frame");
  if (!finiteVec(value.centre)) problems.push("Placement centre must have finite x/y.");
  if (typeof value.rotationRad !== "number" || !Number.isFinite(value.rotationRad)) problems.push("Placement rotationRad must be finite.");
  if (!finitePositive(value.widthM)) problems.push("Placement widthM must be finite and positive.");
  if (!finitePositive(value.depthM)) problems.push("Placement depthM must be finite and positive.");
  return problems;
}

export function validatePersistentBuildingSource(value: unknown): string[] {
  if (!isObject(value)) return ["Persistent building source must be an object."];
  const problems = unknownKeys(
    value,
    [
      "id", "lineage", "origin", "protection", "seed", "appearanceSeed", "grammarId", "visualUse",
      "heightM", "paletteId", "sitePolygon", "placement", "districtId", "blockId"
    ],
    "Persistent building source"
  );
  if (!nonEmptyId(value.id)) problems.push("Persistent building id must be non-empty text.");
  if (!nonEmptyText(value.lineage)) problems.push("Persistent building lineage must be non-empty stable text.");
  if (!enumValue(value.origin, ARCHITECTURE_ORIGINS)) problems.push("Persistent building origin is invalid.");
  if (!enumValue(value.protection, ARCHITECTURE_PROTECTIONS)) problems.push("Persistent building protection is invalid.");
  if (!nonEmptyText(value.seed)) problems.push("Persistent building seed must be non-empty text.");
  if (!nonEmptyText(value.appearanceSeed)) problems.push("Persistent building appearanceSeed must be non-empty text.");
  if (!enumValue(value.grammarId, BUILDING_GRAMMAR_IDS)) problems.push(`Unknown building grammar "${String(value.grammarId)}".`);
  if (!enumValue(value.visualUse, BUILDING_USE_IDS)) problems.push(`Unknown building visual use "${String(value.visualUse)}".`);
  if (enumValue(value.grammarId, BUILDING_GRAMMAR_IDS) && enumValue(value.visualUse, BUILDING_USE_IDS)) {
    const grammar = BUILDING_GRAMMAR_REGISTRY.get(value.grammarId);
    if (grammar && !grammar.compatibleUses.includes(value.visualUse)) {
      problems.push(`Building grammar "${value.grammarId}" does not support visual use "${value.visualUse}".`);
    }
  }
  if (!finitePositive(value.heightM)) problems.push("Persistent building heightM must be finite and positive.");
  problems.push(...paletteProblems(value.paletteId, "Persistent building paletteId", true));
  const siteProblems = ringProblems(value.sitePolygon, "Persistent building sitePolygon");
  problems.push(...siteProblems);
  const placementProblems = validatePlacementFrame(value.placement);
  problems.push(...placementProblems.map((problem) => `Persistent building: ${problem}`));
  const siteValidation = Array.isArray(value.sitePolygon) ? validateRing(value.sitePolygon as Ring) : { ok: false as const, reason: "" };
  if (siteValidation.ok && placementProblems.length === 0 && isObject(value.placement) && hasValidPlacementFields(value.placement) && !placementContainedBySite(value.placement, value.sitePolygon as Ring)) {
    problems.push("Persistent building placement frame footprint must be contained within sitePolygon.");
  }
  problems.push(...nullableId(value.districtId, "Persistent building districtId"));
  problems.push(...nullableId(value.blockId, "Persistent building blockId"));
  return problems;
}

export function validatePersistentPlaceSource(value: unknown): string[] {
  if (!isObject(value)) return ["Persistent place source must be an object."];
  const problems = unknownKeys(
    value,
    [
      "id", "lineage", "origin", "protection", "seed", "appearanceSeed", "landmarkGrammarId",
      "paletteId", "sitePolygon", "placement", "districtId", "blockId"
    ],
    "Persistent place source"
  );
  if (!nonEmptyId(value.id)) problems.push("Persistent place id must be non-empty text.");
  if (!nonEmptyText(value.lineage)) problems.push("Persistent place lineage must be non-empty stable text.");
  if (!enumValue(value.origin, ARCHITECTURE_ORIGINS)) problems.push("Persistent place origin is invalid.");
  if (!enumValue(value.protection, ARCHITECTURE_PROTECTIONS)) problems.push("Persistent place protection is invalid.");
  if (!nonEmptyText(value.seed)) problems.push("Persistent place seed must be non-empty text.");
  if (!nonEmptyText(value.appearanceSeed)) problems.push("Persistent place appearanceSeed must be non-empty text.");
  if (!enumValue(value.landmarkGrammarId, LANDMARK_GRAMMAR_IDS)) problems.push(`Unknown landmark grammar "${String(value.landmarkGrammarId)}".`);
  problems.push(...paletteProblems(value.paletteId, "Persistent place paletteId", true));
  const siteProblems = ringProblems(value.sitePolygon, "Persistent place sitePolygon");
  problems.push(...siteProblems);
  const placementProblems = validatePlacementFrame(value.placement);
  problems.push(...placementProblems.map((problem) => `Persistent place: ${problem}`));
  const siteValidation = Array.isArray(value.sitePolygon) ? validateRing(value.sitePolygon as Ring) : { ok: false as const, reason: "" };
  if (siteValidation.ok && placementProblems.length === 0 && isObject(value.placement) && hasValidPlacementFields(value.placement) && !placementContainedBySite(value.placement, value.sitePolygon as Ring)) {
    problems.push("Persistent place placement frame footprint must be contained within sitePolygon.");
  }
  problems.push(...nullableId(value.districtId, "Persistent place districtId"));
  problems.push(...nullableId(value.blockId, "Persistent place blockId"));
  return problems;
}

export function validateArchitectureOverrideSource(value: unknown): string[] {
  if (!isObject(value)) return ["Architecture override must be an object."];
  const problems = unknownKeys(
    value,
    ["targetKind", "targetId", "lineage", "protection", "snapshotSitePolygon", "appearanceSeed", "paletteId"],
    "Architecture override"
  );
  if (!enumValue(value.targetKind, ARCHITECTURE_TARGET_KINDS)) problems.push("Architecture override targetKind is invalid.");
  if (!nonEmptyId(value.targetId)) problems.push("Architecture override targetId must be non-empty text.");
  if (!nonEmptyText(value.lineage)) problems.push("Architecture override lineage must be non-empty stable text.");
  if (!enumValue(value.protection, ARCHITECTURE_PROTECTIONS)) problems.push("Architecture override protection is invalid.");
  problems.push(...ringProblems(value.snapshotSitePolygon, "Architecture override snapshotSitePolygon"));
  if (Object.prototype.hasOwnProperty.call(value, "appearanceSeed") && !nonEmptyText(value.appearanceSeed)) {
    problems.push("Architecture override appearanceSeed must be non-empty text when present.");
  }
  if (Object.prototype.hasOwnProperty.call(value, "paletteId")) {
    problems.push(...paletteProblems(value.paletteId, "Architecture override paletteId", true));
  }
  return problems;
}

export function validateArchitectureSource(value: unknown): string[] {
  if (!isObject(value)) return ["Architecture source must be an object."];
  const problems = unknownKeys(value, ["buildings", "places", "overrides"], "Architecture source");
  if (!Array.isArray(value.buildings)) problems.push("Architecture buildings must be an array.");
  if (!Array.isArray(value.places)) problems.push("Architecture places must be an array.");
  if (!Array.isArray(value.overrides)) problems.push("Architecture overrides must be an array.");
  if (!Array.isArray(value.buildings) || !Array.isArray(value.places) || !Array.isArray(value.overrides)) return problems;

  const ids = new Set<string>();
  const lineages = new Set<string>();
  for (let index = 0; index < value.buildings.length; index++) {
    const building = value.buildings[index];
    problems.push(...validatePersistentBuildingSource(building).map((problem) => `Architecture building[${index}]: ${problem}`));
    if (!isObject(building)) continue;
    if (nonEmptyId(building.id)) {
      if (ids.has(building.id)) problems.push(`Duplicate architecture object id "${building.id}".`);
      ids.add(building.id);
    }
    if (nonEmptyText(building.lineage)) {
      if (lineages.has(building.lineage)) problems.push(`Duplicate architecture lineage "${building.lineage}".`);
      lineages.add(building.lineage);
    }
  }
  for (let index = 0; index < value.places.length; index++) {
    const place = value.places[index];
    problems.push(...validatePersistentPlaceSource(place).map((problem) => `Architecture place[${index}]: ${problem}`));
    if (!isObject(place)) continue;
    if (nonEmptyId(place.id)) {
      if (ids.has(place.id)) problems.push(`Duplicate architecture object id "${place.id}".`);
      ids.add(place.id);
    }
    if (nonEmptyText(place.lineage)) {
      if (lineages.has(place.lineage)) problems.push(`Duplicate architecture lineage "${place.lineage}".`);
      lineages.add(place.lineage);
    }
  }
  const overrideKeys = new Set<string>();
  for (let index = 0; index < value.overrides.length; index++) {
    const override = value.overrides[index];
    problems.push(...validateArchitectureOverrideSource(override).map((problem) => `Architecture override[${index}]: ${problem}`));
    if (!isObject(override)) continue;
    if (enumValue(override.targetKind, ARCHITECTURE_TARGET_KINDS) && nonEmptyId(override.targetId)) {
      const key = `${override.targetKind}:${override.targetId}`;
      if (overrideKeys.has(key)) problems.push(`Duplicate architecture override target "${key}".`);
      overrideKeys.add(key);
    }
  }
  return problems;
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

function weightTableProblems(value: unknown, keys: readonly string[], label: string): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return [`${label} must be an object.`];
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) problems.push(`${label} has unknown key "${key}".`);
  for (const key of keys) {
    const weight = value[key];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      problems.push(`${label}.${key} must be a finite non-negative number.`);
    }
  }
  const total = keys.reduce((sum, key) => sum + (typeof value[key] === "number" ? value[key] : 0), 0);
  if (!Number.isFinite(total) || total <= 0) problems.push(`${label} must not be all zero.`);
  return problems;
}

export function validateDistrictOpenSpaceOverride(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["District open-space override must be an object."];
  if (typeof value.rate !== "number" || !Number.isFinite(value.rate) || value.rate < 0 || value.rate > 1) {
    problems.push("District open-space rate must be finite and between 0 and 1.");
  }
  problems.push(...weightTableProblems(value.categoryWeights, OPEN_SPACE_CATEGORIES, "District category weights"));
  problems.push(...weightTableProblems(value.sizeWeights, OPEN_SPACE_SIZES, "District size weights"));
  return problems;
}

function normalizeWeightTable(value: unknown, keys: readonly string[], label: string): Record<string, number> {
  const problems = weightTableProblems(value, keys, label);
  if (problems.length > 0) throw new Error(problems.join(" "));
  const input = value as Record<string, unknown>;
  const total = keys.reduce((sum, key) => sum + (input[key] as number), 0);
  return Object.fromEntries(keys.map((key) => [key, (input[key] as number) / total]));
}

export function normalizeDistrictOpenSpaceOverride(value: DistrictOpenSpaceOverride): DistrictOpenSpaceOverride {
  const problems = validateDistrictOpenSpaceOverride(value);
  if (problems.length > 0) throw new Error(problems.join(" "));
  return {
    rate: value.rate,
    categoryWeights: normalizeWeightTable(value.categoryWeights, OPEN_SPACE_CATEGORIES, "District category weights") as Record<OpenSpaceCategory, number>,
    sizeWeights: normalizeWeightTable(value.sizeWeights, OPEN_SPACE_SIZES, "District size weights") as Record<OpenSpaceSize, number>
  };
}

function districtTypeKnown(value: unknown): value is DistrictTypeId {
  return typeof value === "string" && (DISTRICT_TYPE_IDS as readonly string[]).includes(value);
}

function validateDistrictPool(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["District pool must be a non-empty array."];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (!districtTypeKnown(id)) {
      problems.push(`Unknown district type "${String(id)}".`);
      continue;
    }
    if (seen.has(id)) problems.push(`Duplicate district type "${id}".`);
    seen.add(id);
  }
  const order = new Map(DISTRICT_TYPE_IDS.map((id, index) => [id, index]));
  const sorted = [...value].filter(districtTypeKnown).sort((a, b) => order.get(a)! - order.get(b)!);
  if (sorted.some((id, index) => id !== value[index])) problems.push("District pool must use stable built-in ID order.");
  return problems;
}

export function validateDistrictSource(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["District source must be an object."];
  if (!nonEmptyId(value.id)) problems.push("District id must be non-empty text.");
  if (!Array.isArray(value.polygon)) problems.push("District polygon must be a ring.");
  else {
    const ring = validateRing(value.polygon as Ring);
    if (!ring.ok) problems.push(`District polygon: ${ring.reason}`);
  }
  if (!nonEmptyText(value.seed)) problems.push("District seed must be non-empty text.");
  if (!districtTypeKnown(value.typeId)) problems.push(`Unknown district type "${String(value.typeId)}".`);
  if (!nonEmptyText(value.paletteId) || !(DISTRICT_PALETTE_IDS as readonly string[]).includes(value.paletteId)) problems.push(`Unknown district palette id "${String(value.paletteId)}".`);
  if (value.origin !== "generated" && value.origin !== "authored") problems.push("District origin is invalid.");
  if (typeof value.locked !== "boolean") problems.push("District locked must be boolean.");
  if (value.openSpaceOverride !== null) problems.push(...validateDistrictOpenSpaceOverride(value.openSpaceOverride));
  return problems;
}

export function validateCitySourceV3(source: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(source)) return ["City source must be an object."];
  if (!finiteVec(source.origin)) problems.push("City origin must have finite x/y.");
  if (!nonEmptyText(source.citySeed)) problems.push("City seed must be non-empty text.");
  const generation = source.generation;
  if (!isRecord(generation)) problems.push("City generation must be an object.");
  else {
    if (!enumValue(generation.terrainMode, ["rectangle", "coastal", "custom"] as const)) problems.push("Invalid terrain mode.");
    if (!(generation.coastEdge === null || enumValue(generation.coastEdge, ["north", "east", "south", "west"] as const))) problems.push("Invalid coast edge.");
    if ((generation.terrainMode === "coastal") !== (generation.coastEdge !== null)) problems.push("Coastal terrain requires exactly one coast edge.");
    if (!enumValue(generation.roadLayout, ROAD_LAYOUTS)) problems.push("Invalid road layout.");
    if (!enumValue(generation.hubMode, HUB_MODES)) problems.push("Invalid hub mode.");
    problems.push(...validateDistrictPool(generation.districtPool));
    if (!enumValue(generation.openSpaceProfile, OPEN_SPACE_PROFILES)) problems.push("Invalid open-space profile.");
  }
  const terrain = source.terrain;
  if (!isRecord(terrain)) problems.push("City terrain must be an object.");
  else {
    const terrainProblems = validateTerrain(terrain as unknown as TerrainSource);
    if (!terrainProblems.ok) problems.push(terrainProblems.reason);
  }
  problems.push(...validateRoadSource(source.roads));
  if (!Array.isArray(source.districts)) problems.push("Districts must be an array.");
  else {
    const ids = new Set<string>();
    for (const district of source.districts) {
      problems.push(...validateDistrictSource(district).map((problem) => `District: ${problem}`));
      if (!isRecord(district) || !nonEmptyId(district.id)) continue;
      if (ids.has(district.id)) problems.push(`Duplicate district id "${district.id}".`);
      ids.add(district.id);
    }
    for (let i = 0; i < source.districts.length; i++) {
      const left = source.districts[i];
      if (!isRecord(left) || !Array.isArray(left.polygon)) continue;
      for (let j = i + 1; j < source.districts.length; j++) {
        const right = source.districts[j];
        if (!isRecord(right) || !Array.isArray(right.polygon)) continue;
        try {
          if (!isSnapNoise(intersection(ringAsMulti(left.polygon as Ring), ringAsMulti(right.polygon as Ring)))) {
            problems.push(`Districts "${String(left.id)}" and "${String(right.id)}" overlap.`);
          }
        } catch {
          problems.push(`Districts "${String(left.id)}" and "${String(right.id)}" have invalid overlap geometry.`);
        }
      }
    }
  }
  return problems;
}

export function validateCityStateV3(state: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(state)) return ["City state must be an object."];
  if (state.kind !== "city-generator-2") problems.push("Invalid city kind.");
  if (state.schemaVersion !== 3) problems.push("Unsupported city schema version.");
  if (state.generatorVersion !== 11) problems.push("Unsupported city generator version.");
  if (typeof state.revision !== "number" || !Number.isInteger(state.revision) || state.revision < 1) problems.push("City revision must be a positive integer.");
  problems.push(...validateCitySourceV3(state.source));
  return problems;
}
export function validateCitySourceV4(source: unknown): string[] {
  const problems = validateCitySourceV3(source);
  if (!isObject(source)) return problems;
  if (!Object.prototype.hasOwnProperty.call(source, "architecture")) {
    problems.push("City architecture source is required for schema 4.");
    return problems;
  }
  problems.push(...validateArchitectureSource(source.architecture));
  return problems;
}

export function validateCityStateV4(state: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(state)) return ["City state must be an object."];
  if (state.kind !== "city-generator-2") problems.push("Invalid city kind.");
  if (state.schemaVersion !== 4) problems.push("Unsupported city schema version.");
  if (state.generatorVersion !== 12) problems.push("Unsupported city generator version.");
  if (typeof state.revision !== "number" || !Number.isInteger(state.revision) || state.revision < 1) problems.push("City revision must be a positive integer.");
  problems.push(...validateCitySourceV4(state.source));
  return problems;
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

type CityObjectKind = "node" | "edge" | "route" | "bldg" | "plc";

const GENERATED_ID_PREFIX: Readonly<Record<CityObjectKind, string>> = {
  node: "gn",
  edge: "ge",
  route: "gr",
  bldg: "g_bldg",
  plc: "g_plc"
};

const MANUAL_ID_PREFIX: Readonly<Record<CityObjectKind, string>> = {
  node: "mn",
  edge: "me",
  route: "mr",
  bldg: "m_bldg",
  plc: "m_plc"
};

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function allocateGeneratedId(kind: CityObjectKind, citySeed: string, role: string, index: number, used: ReadonlySet<string> = new Set()): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Generated ID index must be a non-negative integer.");
  const hierarchy = kind === "bldg" || kind === "plc" ? "architecture" : "roads";
  return idFrom(GENERATED_ID_PREFIX[kind], `${citySeed}\0${hierarchy}/${kind}\0${role}\0${index}`, used);
}

export function allocateManualId(kind: CityObjectKind, revision: number, sequence: number, lineage: string, used: ReadonlySet<string> = new Set()): string {
  if (!Number.isInteger(revision) || revision < 0 || !Number.isInteger(sequence) || sequence < 0) throw new Error("Manual ID revision and sequence must be non-negative integers.");
  return idFrom(MANUAL_ID_PREFIX[kind], `${revision}\0${sequence}\0${lineage}`, used);
}

export function allocateManualLineage(
  kind: "bldg" | "plc",
  revision: number,
  sequence: number,
  ...placementParameters: readonly unknown[]
): string {
  if (!Number.isInteger(revision) || revision < 0 || !Number.isInteger(sequence) || sequence < 0) {
    throw new Error("Manual lineage revision and sequence must be non-negative integers.");
  }
  const material = `${kind}\0${revision}\0${sequence}\0${stableSerialize(placementParameters)}`;
  return `manual/${kind}/${revision}/${sequence}/${fnv1a(material).toString(16).padStart(8, "0")}`;
}

export function emptyRoadSource(): RoadSource {
  return { nodes: [], routes: [], edges: [] };
}

export const BUILTIN_ROUTE_CLASSES = ROUTE_CLASSES;
