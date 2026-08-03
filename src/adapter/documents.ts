import {
  CITY_SCHEMA_VERSION,
  FLAG_CITY,
  FLAG_ENABLED,
  FLAG_GENERATED,
  GENERATOR_VERSION,
  MODULE_ID
} from "../constants.js";
import type { CitySourceV2, CityStateV2, TerrainSource } from "../core/gen/terrain.js";
import { validateTerrain } from "../core/gen/terrain.js";
import type { WallSegment } from "../core/gen/walls.js";

export type CityLoadResult =
  | { kind: "absent" }
  | { kind: "legacy"; raw: unknown }
  | { kind: "supported"; state: CityStateV2 }
  | {
      kind: "unsupported";
      raw: unknown;
      schemaVersion: number;
      generatorVersion?: number;
    }
  | { kind: "malformed"; raw: unknown; reason: string };

export type SaveExpectation = "absent" | "legacy" | number;

type RecordValue = Record<string, unknown>;

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

function decodeSource(value: unknown): CitySourceV2 | null {
  if (!isRecord(value) || !has(value, "origin") || !has(value, "citySeed") || !has(value, "generation") || !has(value, "terrain")) return null;
  const origin = decodePoint(value.origin);
  if (origin === null || typeof value.citySeed !== "string" || value.citySeed.length === 0 || value.citySeed.trim() !== value.citySeed) return null;

  if (!isRecord(value.generation) || !has(value.generation, "terrainMode") || !has(value.generation, "coastEdge")) return null;
  const mode = value.generation.terrainMode;
  const edge = value.generation.coastEdge;
  if (mode !== "rectangle" && mode !== "coastal" && mode !== "custom") return null;
  if (edge !== null && edge !== "north" && edge !== "east" && edge !== "south" && edge !== "west") return null;
  if ((mode === "coastal") !== (edge !== null)) return null;

  const terrain = decodeTerrain(value.terrain);
  if (terrain === null) return null;
  return {
    origin,
    citySeed: value.citySeed,
    generation: { terrainMode: mode, coastEdge: edge },
    terrain
  };
}

function decodeSupported(raw: unknown): { state: CityStateV2 } | { reason: string } {
  if (!isRecord(raw)) return { reason: "state is not an object" };
  if (!has(raw, "kind") || raw.kind !== "city-generator-2") return { reason: "invalid city kind" };
  if (!has(raw, "schemaVersion") || raw.schemaVersion !== CITY_SCHEMA_VERSION) return { reason: "invalid schema version" };
  if (!has(raw, "generatorVersion") || !positiveInteger(raw.generatorVersion)) return { reason: "invalid generator version" };
  if (!has(raw, "revision") || !positiveInteger(raw.revision)) return { reason: "invalid city revision" };
  if (!has(raw, "source")) return { reason: "missing city source" };
  const source = decodeSource(raw.source);
  if (source === null) return { reason: "invalid city source" };
  const terrainResult = validateTerrain(source.terrain as TerrainSource);
  if (!terrainResult.ok) return { reason: terrainResult.reason };
  return {
    state: {
      kind: "city-generator-2",
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: raw.generatorVersion,
      revision: raw.revision,
      source
    }
  };
}

function classify(raw: unknown): CityLoadResult {
  if (raw === undefined) return { kind: "absent" };
  if (!isRecord(raw) || !has(raw, "kind") || raw.kind !== "city-generator-2") {
    return { kind: "legacy", raw };
  }
  if (!Number.isInteger(raw.schemaVersion)) {
    return { kind: "malformed", raw, reason: "schemaVersion must be an integer" };
  }
  if (raw.schemaVersion !== CITY_SCHEMA_VERSION) {
    return { kind: "unsupported", raw, schemaVersion: raw.schemaVersion as number };
  }
  if (positiveInteger(raw.generatorVersion) && raw.generatorVersion !== GENERATOR_VERSION) {
    return {
      kind: "unsupported",
      raw,
      schemaVersion: raw.schemaVersion as number,
      generatorVersion: raw.generatorVersion
    };
  }
  const decoded = decodeSupported(raw);
  return "state" in decoded
    ? { kind: "supported", state: decoded.state }
    : { kind: "malformed", raw, reason: decoded.reason };
}

export function loadCityState(): CityLoadResult {
  return classify(canvas?.scene?.getFlag(MODULE_ID, FLAG_CITY));
}

function validateCandidate(candidate: CityStateV2): CityStateV2 {
  const decoded = decodeSupported(candidate);
  if (!("state" in decoded)) throw new Error(`Invalid City Generator 2.0 state: ${decoded.reason}`);
  if (decoded.state.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(`City Generator state must use generator version ${GENERATOR_VERSION}.`);
  }
  return decoded.state;
}

export async function saveCityState(
  candidate: CityStateV2,
  expectation: SaveExpectation
): Promise<CityStateV2> {
  requireGM();
  const state = validateCandidate(candidate);
  const scene = requireScene();
  const current = classify(scene.getFlag(MODULE_ID, FLAG_CITY));
  const expectedRevision = expectation === "absent" || expectation === "legacy" ? 1 : expectation + 1;
  if (state.revision !== expectedRevision) {
    throw new Error(`Expected revision ${expectedRevision}, received ${state.revision}.`);
  }
  if (expectation === "absent" && current.kind !== "absent") {
    throw new Error("City flag appeared before creation; retry from the current Scene.");
  }
  if (expectation === "legacy" && current.kind !== "legacy") {
    throw new Error("Legacy city replacement is stale; retry from the current Scene.");
  }
  if (typeof expectation === "number" && (current.kind !== "supported" || current.state.revision !== expectation)) {
    throw new Error("City revision changed before save; retry from the current Scene.");
  }
  await scene.setFlag(MODULE_ID, FLAG_CITY, state);
  return state;
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

/**
 * Terrain walls: sight, light and sound LIMITED so the second crossing blocks rather
 * than the first, movement NORMAL so buildings stay solid. Matches Foundry's own
 * terrain wall tool, which is what makes a street read one block deep instead of
 * ending in a black wall.
 */
export async function replaceGeneratedWalls(
  segments: WallSegment[]
): Promise<{ created: number; deleted: number }> {
  requireGM();
  const deleted = await deleteGeneratedWalls();
  if (segments.length === 0) return { created: 0, deleted };

  const data = segments.map((s) => ({
    c: [s.x1, s.y1, s.x2, s.y2],
    sight: CONST.WALL_SENSE_TYPES.LIMITED,
    light: CONST.WALL_SENSE_TYPES.LIMITED,
    sound: CONST.WALL_SENSE_TYPES.LIMITED,
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL,
    flags: { [MODULE_ID]: { [FLAG_GENERATED]: true } }
  }));

  await requireScene().createEmbeddedDocuments("Wall", data);
  return { created: data.length, deleted };
}
