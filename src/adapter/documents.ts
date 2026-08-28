import {
  CITY_SCHEMA_VERSION,
  FLAG_CITY,
  FLAG_ENABLED,
  FLAG_GENERATED,
  GENERATOR_VERSION,
  MODULE_ID
} from "../constants.js";
import { CITY_CACHE_FLAG } from "../core/gen/city-cache.js";
import {
  OPEN_SPACE_CATEGORIES,
  OPEN_SPACE_SIZES,
  type CitySourceV3,
  type CityStateV3,
  type DistrictOpenSpaceOverride,
  type DistrictSource,
  type OpenSpaceCategory,
  type OpenSpaceSize
} from "../core/gen/city.js";
import { validateCitySourceV3 } from "../core/gen/city.js";
import type { TerrainSource } from "../core/gen/terrain.js";
import type { WallSegment } from "../core/gen/walls.js";
import { validateRouteTopology } from "../core/graph/topology.js";

export type CityLoadResult =
  | { kind: "absent" }
  | { kind: "legacy"; raw: unknown }
  | { kind: "supported"; state: CityStateV3; raw?: unknown }
  | {
      kind: "obsolete-precomplete";
      raw: unknown;
      schemaVersion: 1 | 2 | 3;
      generatorVersion: 8 | 9 | 10;
      revision: number;
    }
  | {
      kind: "unsupported";
      raw: unknown;
      schemaVersion: number;
      generatorVersion?: number;
    }
  | { kind: "malformed"; raw: unknown; reason: string };

export type SaveExpectation = "absent" | number;

/**
 * Pins the Scene state that a destructive clear is allowed to remove. Only known
 * replaceable kinds match, and each carries the exact canonical identity of the raw
 * flag observed at confirmation time — kind + revision alone cannot tell a legacy
 * payload edit or a different supported source written at the same revision apart.
 * The identity is transient only (never persisted or Worker-transferred). "absent" is
 * its own identity and permits clearing an orphaned, non-authoritative city cache.
 * Unsupported and malformed flags are never cleared.
 */
export type ClearConfirmation =
  | "absent"
  | { kind: "legacy"; identity: string }
  | { kind: "obsolete-precomplete"; revision: number; identity: string }
  | { kind: "supported"; revision: number; identity: string };

type RecordValue = Record<string, unknown>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as RecordValue;
    const out: RecordValue = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key]);
    return out;
  }
  return value;
}

/**
 * Exact canonical JSON identity of the raw city flag. Transient only (never persisted or
 * Worker-transferred): a different payload — even at the same kind and revision — always
 * yields a different identity, so a same-revision source swap during confirmations is
 * never cleared. An absent flag has no payload and is represented by the "absent" case.
 */
export function cityFlagIdentity(raw: unknown): string {
  const canonical = canonicalize(raw);
  return canonical === undefined ? "undefined" : JSON.stringify(canonical);
}

function requireScene(): any {
  const scene = canvas?.scene;
  if (!scene) throw new Error("No active scene.");
  return scene;
}

function requireGM(): void {
  if (!game.user?.isGM) throw new Error("Only a GM may modify scene documents.");
}

export function isSceneEnabled(): boolean {
  return canvas?.scene?.getFlag(MODULE_ID, FLAG_ENABLED) === true;
}

export async function setSceneEnabledFlag(enabled: boolean): Promise<void> {
  requireGM();
  await requireScene().setFlag(MODULE_ID, FLAG_ENABLED, enabled);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

const ROUTE_CLASS_IDS = [
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

const CURVE_PRESETS = ["tight", "standard", "broad"] as const;

function decodePoint(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value) || !has(value, "x") || !has(value, "y") || !finiteNumber(value.x) || !finiteNumber(value.y)) return null;
  return { x: value.x, y: value.y };
}

function decodeRing(value: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const ring = value.map(decodePoint);
  return ring.every((point): point is { x: number; y: number } => point !== null) ? ring : null;
}

function decodeTerrain(value: unknown): TerrainSource | null {
  if (!isRecord(value) || !has(value, "land") || !has(value, "urbanFootprint")) return null;
  const land = decodeRing(value.land);
  if (land === null) return null;
  const urbanFootprint = value.urbanFootprint === null ? null : decodeRing(value.urbanFootprint);
  if (value.urbanFootprint !== null && urbanFootprint === null) return null;
  return { land, urbanFootprint } as TerrainSource;
}

function decodeRoads(value: unknown): CitySourceV3["roads"] | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.routes) || !Array.isArray(value.edges)) return null;

  const nodes: CitySourceV3["roads"]["nodes"] = [];
  const nodeIds = new Set<string>();
  for (const item of value.nodes) {
    if (!isRecord(item) || !has(item, "id") || !has(item, "x") || !has(item, "y") || !nonEmptyText(item.id) || !finiteNumber(item.x) || !finiteNumber(item.y) || nodeIds.has(item.id)) return null;
    nodeIds.add(item.id);
    nodes.push({ id: item.id, x: item.x, y: item.y });
  }

  const routes: CitySourceV3["roads"]["routes"] = [];
  const routeIds = new Set<string>();
  for (const item of value.routes) {
    if (!isRecord(item) || !has(item, "id") || !has(item, "curvePreset") || !nonEmptyText(item.id) || !CURVE_PRESETS.includes(item.curvePreset as (typeof CURVE_PRESETS)[number]) || routeIds.has(item.id)) return null;
    routeIds.add(item.id);
    routes.push({ id: item.id, curvePreset: item.curvePreset as (typeof CURVE_PRESETS)[number] });
  }

  const edges: CitySourceV3["roads"]["edges"] = [];
  const edgeIds = new Set<string>();
  const referencedRoutes = new Set<string>();
  for (const item of value.edges) {
    if (
      !isRecord(item) ||
      !has(item, "id") ||
      !has(item, "a") ||
      !has(item, "b") ||
      !has(item, "routeId") ||
      !has(item, "classId") ||
      !has(item, "name") ||
      !has(item, "locked") ||
      !has(item, "origin") ||
      !nonEmptyText(item.id) ||
      !nonEmptyText(item.a) ||
      !nonEmptyText(item.b) ||
      item.a === item.b ||
      !nodeIds.has(item.a) ||
      !nodeIds.has(item.b) ||
      !nonEmptyText(item.routeId) ||
      !routeIds.has(item.routeId) ||
      !ROUTE_CLASS_IDS.includes(item.classId as (typeof ROUTE_CLASS_IDS)[number]) ||
      (item.name !== null && typeof item.name !== "string") ||
      typeof item.locked !== "boolean" ||
      (item.origin !== "generated" && item.origin !== "authored") ||
      edgeIds.has(item.id)
    ) return null;
    edgeIds.add(item.id);
    referencedRoutes.add(item.routeId);
    edges.push({
      id: item.id,
      a: item.a,
      b: item.b,
      routeId: item.routeId,
      classId: item.classId as (typeof ROUTE_CLASS_IDS)[number],
      name: item.name,
      locked: item.locked,
      origin: item.origin
    });
  }
  if (routes.some((route) => !referencedRoutes.has(route.id))) return null;
  return { nodes, routes, edges };
}

function decodeWeightTable(value: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const key of keys) {
    if (!has(value, key) || !finiteNumber(value[key]) || value[key] < 0) return null;
    out[key] = value[key];
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) return null;
  const total = keys.reduce((sum, key) => sum + out[key]!, 0);
  if (!Number.isFinite(total) || total <= 0 || Math.abs(total - 1) > 1e-6) return null;
  return out;
}

function decodeDistrictOpenSpaceOverride(value: unknown): DistrictOpenSpaceOverride | null {
  if (!isRecord(value) || !has(value, "rate") || !finiteNumber(value.rate) || value.rate < 0 || value.rate > 1) return null;
  const categoryWeights = decodeWeightTable(value.categoryWeights, OPEN_SPACE_CATEGORIES);
  const sizeWeights = decodeWeightTable(value.sizeWeights, OPEN_SPACE_SIZES);
  if (categoryWeights === null || sizeWeights === null) return null;
  return {
    rate: value.rate,
    categoryWeights: categoryWeights as Record<OpenSpaceCategory, number>,
    sizeWeights: sizeWeights as Record<OpenSpaceSize, number>
  };
}

function decodeDistrict(value: unknown): DistrictSource | null {
  if (!isRecord(value) || !has(value, "id") || !has(value, "polygon") || !has(value, "seed") || !has(value, "typeId") || !has(value, "paletteId") || !has(value, "origin") || !has(value, "locked") || !has(value, "openSpaceOverride")) return null;
  const polygon = decodeRing(value.polygon);
  if (polygon === null || !nonEmptyText(value.id) || !nonEmptyText(value.seed) || !nonEmptyText(value.paletteId)) return null;
  if ((value.origin !== "generated" && value.origin !== "authored") || typeof value.locked !== "boolean") return null;
  const openSpaceOverride = value.openSpaceOverride === null ? null : decodeDistrictOpenSpaceOverride(value.openSpaceOverride);
  if (value.openSpaceOverride !== null && openSpaceOverride === null) return null;
  return {
    id: value.id,
    polygon,
    seed: value.seed,
    typeId: value.typeId as DistrictSource["typeId"],
    paletteId: value.paletteId,
    origin: value.origin,
    locked: value.locked,
    openSpaceOverride
  };
}

function decodeV3Generation(value: unknown): CitySourceV3["generation"] | null {
  if (!isRecord(value) || !has(value, "terrainMode") || !has(value, "coastEdge") || !has(value, "roadLayout") || !has(value, "hubMode") || !has(value, "districtPool") || !has(value, "openSpaceProfile")) return null;
  const mode = value.terrainMode;
  const edge = value.coastEdge;
  if (mode !== "rectangle" && mode !== "coastal" && mode !== "custom") return null;
  if (edge !== null && edge !== "north" && edge !== "east" && edge !== "south" && edge !== "west") return null;
  if ((mode === "coastal") !== (edge !== null)) return null;
  if (value.roadLayout !== "european" && value.roadLayout !== "grid" && value.roadLayout !== "mixed") return null;
  if (value.hubMode !== "single-centre" && value.hubMode !== "multiple-hubs") return null;
  if (!Array.isArray(value.districtPool) || value.districtPool.some((id) => typeof id !== "string")) return null;
  if (value.openSpaceProfile !== "none" && value.openSpaceProfile !== "very-low" && value.openSpaceProfile !== "low" && value.openSpaceProfile !== "medium" && value.openSpaceProfile !== "high") return null;
  return {
    terrainMode: mode,
    coastEdge: edge,
    roadLayout: value.roadLayout,
    hubMode: value.hubMode,
    districtPool: [...value.districtPool] as CitySourceV3["generation"]["districtPool"],
    openSpaceProfile: value.openSpaceProfile
  };
}

function decodeV3Source(value: unknown): CitySourceV3 | null {
  if (!isRecord(value) || !has(value, "origin") || !has(value, "citySeed") || !has(value, "generation") || !has(value, "terrain") || !has(value, "roads") || !has(value, "districts")) return null;
  const origin = decodePoint(value.origin);
  if (origin === null || !nonEmptyText(value.citySeed)) return null;
  const generation = decodeV3Generation(value.generation);
  const terrain = decodeTerrain(value.terrain);
  const roads = decodeRoads(value.roads);
  if (generation === null || terrain === null || roads === null || !Array.isArray(value.districts)) return null;
  const districts = value.districts.map(decodeDistrict);
  if (districts.some((district): district is null => district === null)) return null;
  return {
    origin,
    citySeed: value.citySeed,
    generation,
    terrain,
    roads,
    districts: districts as DistrictSource[]
  };
}

function decodeSupported(raw: unknown): { state: CityStateV3 } | { reason: string } {
  if (!isRecord(raw)) return { reason: "state is not an object" };
  if (!has(raw, "kind") || raw.kind !== "city-generator-2") return { reason: "invalid city kind" };
  if (!has(raw, "schemaVersion") || raw.schemaVersion !== CITY_SCHEMA_VERSION) return { reason: "invalid schema version" };
  if (!has(raw, "generatorVersion") || !positiveInteger(raw.generatorVersion)) return { reason: "invalid generator version" };
  if (raw.generatorVersion !== GENERATOR_VERSION) return { reason: "unsupported generator version" };
  if (!has(raw, "revision") || !positiveInteger(raw.revision)) return { reason: "invalid city revision" };
  if (!has(raw, "source")) return { reason: "missing city source" };
  const source = decodeV3Source(raw.source);
  if (source === null) return { reason: "invalid city source" };
  const problems = validateCitySourceV3(source);
  if (problems.length > 0) return { reason: problems.join(" ") };
  try {
    const topology = validateRouteTopology(source.roads);
    if (!topology.ok) return { reason: topology.problems.join(" ") };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  return {
    state: {
      kind: "city-generator-2",
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      revision: raw.revision,
      source
    }
  };
}

// WHY: Schema 1/gen 8, schema 2/gen 9, and schema 3/gen 10 are the known pre-complete
// generations. They are read-only: raw data and version evidence are preserved so the
// campaign can be recovered, but nothing is migrated or rewritten at open time.
const OBSOLETE_PRECOMPLETE_GENERATOR = new Map<number, number>([
  [1, 8],
  [2, 9],
  [3, 10]
]);

function classify(raw: unknown): CityLoadResult {
  if (raw === undefined) return { kind: "absent" };
  if (!isRecord(raw) || !has(raw, "kind") || raw.kind !== "city-generator-2") {
    return { kind: "legacy", raw };
  }
  if (!Number.isInteger(raw.schemaVersion)) {
    return { kind: "malformed", raw, reason: "schemaVersion must be an integer" };
  }
  if (!positiveInteger(raw.generatorVersion)) {
    return { kind: "malformed", raw, reason: "invalid generator version" };
  }
  // WHY: schema 3 is the CURRENT schema and is shared by the obsolete generator 10 and the
  // current generator 11, so the obsolete entry only applies when the generator version
  // matches it; a current-schema/current-generator state must fall through to supported.
  const obsoleteGenerator = OBSOLETE_PRECOMPLETE_GENERATOR.get(raw.schemaVersion as number);
  if (obsoleteGenerator !== undefined && raw.generatorVersion === obsoleteGenerator) {
    if (!positiveInteger(raw.revision)) return { kind: "malformed", raw, reason: "invalid city revision" };
    return {
      kind: "obsolete-precomplete",
      raw,
      schemaVersion: raw.schemaVersion as 1 | 2 | 3,
      generatorVersion: raw.generatorVersion as 8 | 9 | 10,
      revision: raw.revision as number
    };
  }
  if (raw.schemaVersion !== CITY_SCHEMA_VERSION) {
    // Known pre-complete schemas (1/2) carry their generator version as evidence of
    // the unknown variant; future schemas only expose the schema version.
    return obsoleteGenerator !== undefined
      ? {
          kind: "unsupported",
          raw,
          schemaVersion: raw.schemaVersion as number,
          generatorVersion: raw.generatorVersion as number
        }
      : { kind: "unsupported", raw, schemaVersion: raw.schemaVersion as number };
  }
  if (raw.generatorVersion !== GENERATOR_VERSION) {
    return {
      kind: "unsupported",
      raw,
      schemaVersion: raw.schemaVersion as number,
      generatorVersion: raw.generatorVersion
    };
  }
  const decoded = decodeSupported(raw);
  return "state" in decoded
    ? { kind: "supported", state: decoded.state, raw }
    : { kind: "malformed", raw, reason: decoded.reason };
}

export function loadCityState(): CityLoadResult {
  return classify(canvas?.scene?.getFlag(MODULE_ID, FLAG_CITY));
}

function validateCandidate(candidate: CityStateV3): CityStateV3 {
  const decoded = decodeSupported(candidate);
  if (!("state" in decoded)) throw new Error(`Invalid City Generator 2.0 state: ${decoded.reason}`);
  if (decoded.state.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(`City Generator state must use generator version ${GENERATOR_VERSION}.`);
  }
  return decoded.state;
}

export async function saveCityState(
  candidate: CityStateV3,
  expectation: SaveExpectation
): Promise<CityStateV3> {
  requireGM();
  const state = validateCandidate(candidate);
  const scene = requireScene();
  const current = classify(scene.getFlag(MODULE_ID, FLAG_CITY));
  const expectedBaseRevision = typeof expectation === "number" ? expectation : null;
  const expectedRevision = expectedBaseRevision === null ? 1 : expectedBaseRevision + 1;
  if (state.revision !== expectedRevision) {
    throw new Error(`Expected revision ${expectedRevision}, received ${state.revision}.`);
  }
  // WHY: creation must follow the confirmed clear; otherwise existing or future data could be overwritten.
  if (state.revision === 1 && current.kind !== "absent") {
    throw new Error("City creation requires an absent Scene state.");
  }
  if (expectation === "absent" && current.kind !== "absent") {
    throw new Error("City flag appeared before creation; retry from the current Scene.");
  }
  if (typeof expectation === "number") {
    if (current.kind !== "supported" || current.state.revision !== expectation) {
      throw new Error("City revision changed before save; retry from the current Scene.");
    }
  }
  await scene.setFlag(MODULE_ID, FLAG_CITY, state);
  return state;
}

/**
 * Destructive clear of the city flag and its non-authoritative plan cache, guarded by
 * the caller's confirmation of the current Scene state. Only known replaceable kinds
 * are removed — legacy 1.0 data, obsolete-precomplete generations at an exact revision,
 * and a supported city at an exact revision — and each must still carry the exact raw
 * identity that was confirmed; a payload swap at the same kind and revision is never
 * cleared. Unsupported and malformed flags are never cleared. An "absent" confirmation
 * may remove an orphaned cache. The authoritative city flag is always cleared before
 * its cache. The clear and the follow-up revision-1 save stay separate so the
 * destructive step happens immediately after confirmation and a later planning failure
 * never leaves an authoritative flag behind.
 */
export async function clearCityState(confirmation: ClearConfirmation): Promise<void> {
  requireGM();
  const scene = requireScene();
  const raw = scene.getFlag(MODULE_ID, FLAG_CITY);
  const current = classify(raw);
  if (confirmation === "absent") {
    if (current.kind !== "absent") {
      throw new Error("City flag appeared before clearing; retry from the current Scene.");
    }
    await scene.unsetFlag(MODULE_ID, CITY_CACHE_FLAG);
    return;
  }
  if (confirmation.kind === "legacy") {
    if (current.kind !== "legacy" || cityFlagIdentity(raw) !== confirmation.identity) {
      throw new Error("City flag changed before clearing; retry from the current Scene.");
    }
  } else if (confirmation.kind === "obsolete-precomplete") {
    if (current.kind !== "obsolete-precomplete" || current.revision !== confirmation.revision || cityFlagIdentity(raw) !== confirmation.identity) {
      throw new Error("Obsolete city flag changed before clearing; retry from the current Scene.");
    }
  } else if (current.kind !== "supported" || current.state.revision !== confirmation.revision || cityFlagIdentity(raw) !== confirmation.identity) {
    throw new Error("City revision changed before clearing; retry from the current Scene.");
  }
  await scene.unsetFlag(MODULE_ID, FLAG_CITY);
  await scene.unsetFlag(MODULE_ID, CITY_CACHE_FLAG);
}

export function generatedWallIds(): string[] {
  const scene = canvas?.scene;
  if (!scene) return [];
  return scene.walls
    .filter((w: any) => w.getFlag(MODULE_ID, FLAG_GENERATED) === true)
    .map((w: any) => w.id);
}

export async function deleteGeneratedWalls(): Promise<number> {
  requireGM();
  const ids = generatedWallIds();
  if (ids.length === 0) return 0;
  await requireScene().deleteEmbeddedDocuments("Wall", ids);
  return ids.length;
}

// WHY: LIMITED senses block on the second crossing while NORMAL movement keeps planned cells solid.
export async function replaceGeneratedWalls(
  segments: WallSegment[],
  isCurrent: () => boolean = () => true
): Promise<{ created: number; deleted: number }> {
  requireGM();
  if (!isCurrent()) return { created: 0, deleted: 0 };
  const deleted = await deleteGeneratedWalls();
  if (segments.length === 0 || !isCurrent()) return { created: 0, deleted };
  const senseTypes = CONST.EDGE_SENSE_TYPES ?? CONST.WALL_SENSE_TYPES;

  const data = segments.map((s) => ({
    c: [s.x1, s.y1, s.x2, s.y2],
    sight: senseTypes.LIMITED,
    light: senseTypes.LIMITED,
    sound: senseTypes.LIMITED,
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL,
    flags: { [MODULE_ID]: { [FLAG_GENERATED]: true } }
  }));

  const created = await requireScene().createEmbeddedDocuments("Wall", data);
  if (!isCurrent()) {
    const ids = Array.isArray(created) ? created.map((wall: any) => wall?.id).filter((id: unknown): id is string => typeof id === "string") : [];
    if (ids.length > 0) await requireScene().deleteEmbeddedDocuments("Wall", ids);
    return { created: 0, deleted };
  }
  return { created: data.length, deleted };
}
