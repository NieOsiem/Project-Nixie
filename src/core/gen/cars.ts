import type { BuildingSpec } from "../geom/extrude.js";
import type { Ring, Vec2 } from "../geom/types.js";
import { BASE_BANK, DISTRICT_SLOT, materialIndex } from "../palette.js";
import { hash2, hashPick } from "./hash.js";
import type { ParkingSpan } from "./markings.js";
import { zoneAt, type Zone } from "./zones.js";

export const CAR_RATE = 2 / 3;
export const WRONG_WAY_RATE = 0.075;
export const MAX_PARKING_ANGLE_DEG = 3;

export const CAR_FAMILIES = [
  { id: "compact", lengthM: 3.8, widthM: 1.75, heightM: 1.42 },
  { id: "sedan", lengthM: 4.5, widthM: 1.9, heightM: 1.45 },
  { id: "hatchback", lengthM: 4.1, widthM: 1.85, heightM: 1.5 },
  { id: "wagon", lengthM: 4.7, widthM: 1.95, heightM: 1.55 },
  { id: "coupe", lengthM: 4.3, widthM: 1.85, heightM: 1.3 },
  { id: "minivan", lengthM: 4.8, widthM: 1.98, heightM: 1.9 },
  { id: "van", lengthM: 5.2, widthM: 2.1, heightM: 2.25 },
  { id: "pickup", lengthM: 5.1, widthM: 2.05, heightM: 1.85 }
] as const;

export type CarFamily = (typeof CAR_FAMILIES)[number]["id"];

export interface ParkedCar extends BuildingSpec {
  family: CarFamily;
  lengthM: number;
  widthM: number;
  forward: Vec2;
  wrongWay: boolean;
  parkingAngleRad: number;
}

const MIN_ROAD_WIDTH_M = 9;
const KERB_CLEARANCE_M = 0.35;
const MAX_JITTER_M = 1.25;
const WALL_SLOTS = [DISTRICT_SLOT.WALL_A, DISTRICT_SLOT.WALL_B, DISTRICT_SLOT.WALL_C] as const;

const at = (span: ParkingSpan, t: number, c: number): Vec2 => ({
  x: span.origin.x + span.dir.x * t + span.normal.x * c,
  y: span.origin.y + span.dir.y * t + span.normal.y * c
});

/** Deterministic right-hand-traffic vehicles on roughly two thirds of eligible kerb segments. */
export function parkedCars(
  spans: ParkingSpan[],
  originPx: Vec2,
  pixelsPerMetre: number,
  zonesPx: Zone[]
): ParkedCar[] {
  const cars: ParkedCar[] = [];
  const kerbClearance = KERB_CLEARANCE_M * pixelsPerMetre;

  for (const span of spans) {
    const length = span.to - span.from;
    if (span.roadHalf * 2 < MIN_ROAD_WIDTH_M * pixelsPerMetre) continue;

    const baseT = (span.from + span.to) / 2;
    const baseCentre = at(span, baseT, 0);
    const cx = Math.round(((baseCentre.x - originPx.x) / pixelsPerMetre) * 10);
    const cy = Math.round(((baseCentre.y - originPx.y) / pixelsPerMetre) * 10);
    if (hash2(cx, cy, 41) >= CAR_RATE) continue;

    const eligible = CAR_FAMILIES.filter(
      (candidate) => candidate.lengthM * pixelsPerMetre <= length
    );
    if (eligible.length === 0) continue;
    const family = eligible[Math.min(
      eligible.length - 1,
      Math.floor(hash2(cx, cy, 46) * eligible.length)
    )]!;
    const halfLength = (family.lengthM * pixelsPerMetre) / 2;
    const halfWidth = (family.widthM * pixelsPerMetre) / 2;
    const wrongWay = hash2(cx, cy, 47) < WRONG_WAY_RATE;
    const trafficSign = span.side * (wrongWay ? -1 : 1);
    const baseForward = {
      x: span.dir.x * trafficSign,
      y: span.dir.y * trafficSign
    };
    const parkingAngleRad =
      (hash2(cx, cy, 48) * 2 - 1) * MAX_PARKING_ANGLE_DEG * Math.PI / 180;
    const cos = Math.cos(parkingAngleRad);
    const sin = Math.sin(parkingAngleRad);
    const forward = {
      x: baseForward.x * cos - baseForward.y * sin,
      y: baseForward.x * sin + baseForward.y * cos
    };
    const right = { x: -forward.y, y: forward.x };
    const alongHalf = halfLength * Math.abs(cos) + halfWidth * Math.abs(sin);
    if (alongHalf * 2 > length) continue;
    const lateralHalf = halfWidth * Math.abs(cos) + halfLength * Math.abs(sin);
    const centreC = span.side * (span.roadHalf - lateralHalf - kerbClearance);
    const room = Math.max(0, length / 2 - alongHalf);
    const jitter =
      (hash2(cx, cy, 42) * 2 - 1) * Math.min(room, MAX_JITTER_M * pixelsPerMetre);
    const centreT = baseT + jitter;
    const centre = at(span, centreT, centreC);
    const corner = (longitudinal: number, lateral: number): Vec2 => ({
      x: centre.x + forward.x * longitudinal + right.x * lateral,
      y: centre.y + forward.y * longitudinal + right.y * lateral
    });
    const footprint: Ring = [
      corner(-halfLength, -halfWidth),
      corner(halfLength, -halfWidth),
      corner(halfLength, halfWidth),
      corner(-halfLength, halfWidth)
    ];
    const bank = zoneAt(zonesPx, centre)?.bank ?? BASE_BANK;
    const wallSlot = hashPick(WALL_SLOTS, cx, cy, 43);
    const roofSlot = hash2(cx, cy, 44) < 0.72 ? wallSlot : hashPick(WALL_SLOTS, cx, cy, 49);

    cars.push({
      footprint,
      height: family.heightM,
      wallMaterial: materialIndex(bank, wallSlot),
      roofMaterial: materialIndex(bank, roofSlot),
      seed: hash2(cx, cy, 45),
      family: family.id,
      lengthM: family.lengthM,
      widthM: family.widthM,
      forward,
      wrongWay,
      parkingAngleRad
    });
  }
  return cars;
}
