import {
  CITY_FORMAT_VERSION,
  FLAG_CITY,
  FLAG_ENABLED,
  FLAG_GENERATED,
  GENERATOR_VERSION,
  MODULE_ID
} from "../constants.js";
import { withRoadClasses, type CityParams } from "../core/gen/demo-city.js";
import type { WallSegment } from "../core/gen/walls.js";
import { normalizeZoneParams } from "../core/gen/zones.js";
import { zoneBank } from "../core/palette.js";

export interface CityState extends CityParams {
  formatVersion: number;
  generatorVersion: number;
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

/**
 * Format 3 knew nothing of palette banks. Ignoring it would throw away a hand-drawn city,
 * so it is upgraded instead: banks in stored order, palettes filled in by the load below.
 */
function migrateV3toV4(raw: any): any {
  const zones = Array.isArray(raw.zones) ? raw.zones : [];
  return {
    ...raw,
    formatVersion: 4,
    zones: zones.map((z: any, i: number) => ({ ...z, bank: zoneBank(i) }))
  };
}

export function loadCityState(): CityState | null {
  const raw = canvas?.scene?.getFlag(MODULE_ID, FLAG_CITY);
  if (!raw || typeof raw !== "object") return null;

  const stored = raw.formatVersion === 3 ? migrateV3toV4(raw) : raw;
  if (stored.formatVersion !== CITY_FORMAT_VERSION) {
    console.warn(
      `${MODULE_ID} | ignoring stored city in format ${raw.formatVersion}, expected ${CITY_FORMAT_VERSION}`
    );
    return null;
  }

  const zones = Array.isArray(stored.zones) ? stored.zones : [];
  return {
    ...stored,
    // Road classes are module presets, so a stored city adopts the current list instead
    // of keeping its own — otherwise adding a class strands old cities without it.
    graph: withRoadClasses(stored.graph),
    // A stored palette that is short, absent or half-written still has to yield a full
    // bank, or the shader samples slots that were never packed.
    base: normalizeZoneParams(stored.base),
    zones: zones.map((z: any, i: number) => ({
      ...z,
      bank: typeof z.bank === "number" ? z.bank : zoneBank(i),
      ...normalizeZoneParams(z),
      ...(typeof z.name === "string" ? { name: z.name } : {})
    }))
  } as CityState;
}

export async function saveCityState(params: CityParams): Promise<CityState> {
  requireGM();
  const state: CityState = {
    formatVersion: CITY_FORMAT_VERSION,
    generatorVersion: GENERATOR_VERSION,
    ...params
  };
  // Foundry replaces arrays wholesale on merge, so deleting a road or a zone persists
  // correctly rather than leaving the removed entry behind.
  await requireScene().setFlag(MODULE_ID, FLAG_CITY, state);
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
