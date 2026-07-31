import { describe, expect, it } from "vitest";
import { ringArea, ringCentroid } from "../geom/types.js";
import { BANK_SIZE } from "../palette.js";
import {
  CAR_FAMILIES,
  CAR_RATE,
  MAX_PARKING_ANGLE_DEG,
  WRONG_WAY_RATE,
  parkedCars
} from "./cars.js";
import { cityToPixels, demoCity } from "./demo-city.js";
import { buildRoadDetails } from "./markings.js";
import { DEFAULT_ZONE_PARAMS, type Zone } from "./zones.js";

const ORIGIN = { x: 5000, y: 4000 };
const PPM = 25;
const CITY = demoCity(ORIGIN);

const carsAt = (pixelsPerMetre: number, zones: Zone[] = []) => {
  const params = { ...CITY, zones };
  const px = cityToPixels(params, pixelsPerMetre);
  return parkedCars(
    buildRoadDetails(px.graph, pixelsPerMetre).parkingSpans,
    ORIGIN,
    pixelsPerMetre,
    px.zones
  );
};

describe("parkedCars", () => {
  it("is deterministic and emits varied, dimensionally correct vehicle specs", () => {
    const a = carsAt(PPM);
    const b = carsAt(PPM);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(20);
    expect(new Set(a.map((car) => car.family)).size).toBeGreaterThanOrEqual(5);
    for (const car of a) {
      expect(car.footprint).toHaveLength(4);
      expect(Math.hypot(
        car.footprint[1]!.x - car.footprint[0]!.x,
        car.footprint[1]!.y - car.footprint[0]!.y
      ) / PPM).toBeCloseTo(car.lengthM, 6);
      expect(Math.hypot(
        car.footprint[2]!.x - car.footprint[1]!.x,
        car.footprint[2]!.y - car.footprint[1]!.y
      ) / PPM).toBeCloseTo(car.widthM, 6);
      expect(Math.abs(ringArea(car.footprint)) / (PPM * PPM)).toBeCloseTo(
        car.lengthM * car.widthM,
        6
      );
      expect(car.height).toBe(CAR_FAMILIES.find((family) => family.id === car.family)!.heightM);
      expect(Math.hypot(car.forward.x, car.forward.y)).toBeCloseTo(1, 9);
    }
  });

  it("occupies roughly two thirds of eligible kerb segments", () => {
    const px = cityToPixels(CITY, PPM);
    const spans = buildRoadDetails(px.graph, PPM).parkingSpans.filter(
      (span) => span.to - span.from >= CAR_FAMILIES[0].lengthM * PPM && span.roadHalf * 2 >= 9 * PPM
    );
    const rate = carsAt(PPM).length / spans.length;
    expect(CAR_RATE).toBeCloseTo(2 / 3, 9);
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(0.8);
  });

  it("uses the local district bank for both body materials", () => {
    const zone: Zone = {
      ...DEFAULT_ZONE_PARAMS,
      id: "z1",
      bank: 7,
      rect: { x: -500, y: -500, width: 1000, height: 1000 }
    };
    const cars = carsAt(PPM, [zone]);
    expect(cars.length).toBeGreaterThan(0);
    for (const car of cars) {
      expect(Math.floor(car.wallMaterial / BANK_SIZE)).toBe(7);
      expect(Math.floor(car.roofMaterial / BANK_SIZE)).toBe(7);
    }
  });

  it("follows right-hand traffic with a small deterministic wrong-way minority", () => {
    const spans = Array.from({ length: 2000 }, (_, i) => ({
      origin: { x: i * 12 * PPM, y: 0 },
      dir: { x: 1, y: 0 },
      normal: { x: 0, y: 1 },
      from: 0,
      to: 8 * PPM,
      side: (i % 2 === 0 ? 1 : -1) as 1 | -1,
      roadHalf: 4.5 * PPM
    }));
    const cars = parkedCars(spans, { x: 0, y: 0 }, PPM, []);
    expect(cars.length).toBeGreaterThan(1000);

    for (const car of cars) {
      const side = Math.sign(ringCentroid(car.footprint).y) || 1;
      const withTraffic = car.forward.x * side;
      expect(withTraffic > 0).toBe(!car.wrongWay);
      expect(Math.abs(car.parkingAngleRad)).toBeLessThanOrEqual(
        MAX_PARKING_ANGLE_DEG * Math.PI / 180
      );
    }
    const wrongWayRate = cars.filter((car) => car.wrongWay).length / cars.length;
    expect(WRONG_WAY_RATE).toBe(0.075);
    expect(wrongWayRate).toBeGreaterThan(0.05);
    expect(wrongWayRate).toBeLessThan(0.1);
    expect(cars.some((car) => Math.abs(car.parkingAngleRad) > Math.PI / 180)).toBe(true);
  });

  it("survives a scene regrid without moving or rerolling", () => {
    const coarse = carsAt(PPM);
    const fine = carsAt(PPM * 2);
    const key = (cars: typeof coarse, ppm: number): string[] =>
      cars.map((car) =>
        [
          ...car.footprint.map(
            (p) => `${((p.x - ORIGIN.x) / ppm).toFixed(5)},${((p.y - ORIGIN.y) / ppm).toFixed(5)}`
          ),
          car.wallMaterial,
          car.roofMaterial,
          car.seed.toFixed(8),
          car.family,
          car.forward.x.toFixed(8),
          car.forward.y.toFixed(8),
          car.wrongWay,
          car.parkingAngleRad.toFixed(8)
        ].join("|")
      );
    expect(key(fine, PPM * 2)).toEqual(key(coarse, PPM));
  });
});
