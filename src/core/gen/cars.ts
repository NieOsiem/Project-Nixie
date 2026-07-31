import type { BuildingSpec } from "../geom/extrude.js";
import type { Ring, Vec2 } from "../geom/types.js";
import { BASE_BANK, DISTRICT_SLOT, materialIndex } from "../palette.js";
import { hash2, hashPick } from "./hash.js";
import type { ParkingSpan } from "./markings.js";
import { zoneAt, type Zone } from "./zones.js";

export const CAR_LENGTH_M = 4;
export const CAR_WIDTH_M = 2;
export const CAR_HEIGHT_M = 1.5;
export const CAR_RATE = 2 / 3;

const MIN_ROAD_WIDTH_M = 9;
const KERB_CLEARANCE_M = 0.35;
const MAX_JITTER_M = 1.25;
const WALL_SLOTS = [DISTRICT_SLOT.WALL_A, DISTRICT_SLOT.WALL_B, DISTRICT_SLOT.WALL_C] as const;

const fract = (value: number): number => value - Math.floor(value);
const roofStyle = (seed: number): number =>
  fract(Math.sin((seed + 12.59) * 78.233) * 43758.5453);

function stripedSeed(seed: number): number {
  for (let i = 0; i < 64; i++) {
    const candidate = fract(seed + i * 0.061);
    const style = roofStyle(candidate);
    if (style >= 0.48 && style <= 0.72) return candidate;
  }
  return seed;
}

const at = (span: ParkingSpan, t: number, c: number): Vec2 => ({
  x: span.origin.x + span.dir.x * t + span.normal.x * c,
  y: span.origin.y + span.dir.y * t + span.normal.y * c
});

/** One deterministic 4 x 2 m car on roughly two thirds of the 8 m kerb segments. */
export function parkedCars(
  spans: ParkingSpan[],
  originPx: Vec2,
  pixelsPerMetre: number,
  zonesPx: Zone[]
): BuildingSpec[] {
  const cars: BuildingSpec[] = [];
  const halfLength = (CAR_LENGTH_M * pixelsPerMetre) / 2;
  const halfWidth = (CAR_WIDTH_M * pixelsPerMetre) / 2;
  const kerbClearance = KERB_CLEARANCE_M * pixelsPerMetre;

  for (const span of spans) {
    const length = span.to - span.from;
    if (length < CAR_LENGTH_M * pixelsPerMetre) continue;
    if (span.roadHalf * 2 < MIN_ROAD_WIDTH_M * pixelsPerMetre) continue;

    const baseT = (span.from + span.to) / 2;
    const centreC =
      span.side * (span.roadHalf - halfWidth - kerbClearance);
    const baseCentre = at(span, baseT, centreC);
    const cx = Math.round(((baseCentre.x - originPx.x) / pixelsPerMetre) * 10);
    const cy = Math.round(((baseCentre.y - originPx.y) / pixelsPerMetre) * 10);
    if (hash2(cx, cy, 41) >= CAR_RATE) continue;

    const room = Math.max(0, length / 2 - halfLength);
    const jitter =
      (hash2(cx, cy, 42) * 2 - 1) * Math.min(room, MAX_JITTER_M * pixelsPerMetre);
    const centreT = baseT + jitter;
    const footprint: Ring = [
      at(span, centreT - halfLength, centreC - halfWidth),
      at(span, centreT + halfLength, centreC - halfWidth),
      at(span, centreT + halfLength, centreC + halfWidth),
      at(span, centreT - halfLength, centreC + halfWidth)
    ];
    const centre = at(span, centreT, centreC);
    const bank = zoneAt(zonesPx, centre)?.bank ?? BASE_BANK;
    const wallSlot = hashPick(WALL_SLOTS, cx, cy, 43);
    const roofSlot = hashPick(WALL_SLOTS, cx, cy, 44);

    cars.push({
      footprint,
      height: CAR_HEIGHT_M,
      wallMaterial: materialIndex(bank, wallSlot),
      roofMaterial: materialIndex(bank, roofSlot),
      seed: stripedSeed(hash2(cx, cy, 45))
    });
  }
  return cars;
}
