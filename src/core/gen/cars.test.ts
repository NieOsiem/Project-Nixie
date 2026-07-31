import { describe, expect, it } from "vitest";
import { extrudeBuilding } from "../geom/extrude.js";
import { ringArea } from "../geom/types.js";
import { BANK_SIZE } from "../palette.js";
import {
  CAR_HEIGHT_M,
  CAR_LENGTH_M,
  CAR_RATE,
  CAR_WIDTH_M,
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

const shaderRoofStyle = (seed: number): number => {
  const value = Math.sin((seed + 12.59) * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

describe("parkedCars", () => {
  it("is deterministic and emits 4 x 2 x 1.5 m specs", () => {
    const a = carsAt(PPM);
    const b = carsAt(PPM);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(20);
    for (const car of a) {
      expect(car.footprint).toHaveLength(4);
      expect(Math.hypot(
        car.footprint[1]!.x - car.footprint[0]!.x,
        car.footprint[1]!.y - car.footprint[0]!.y
      ) / PPM).toBeCloseTo(CAR_LENGTH_M, 6);
      expect(Math.hypot(
        car.footprint[2]!.x - car.footprint[1]!.x,
        car.footprint[2]!.y - car.footprint[1]!.y
      ) / PPM).toBeCloseTo(CAR_WIDTH_M, 6);
      expect(Math.abs(ringArea(car.footprint)) / (PPM * PPM)).toBeCloseTo(
        CAR_LENGTH_M * CAR_WIDTH_M,
        6
      );
      expect(car.height).toBe(CAR_HEIGHT_M);
      expect(extrudeBuilding(car, PPM).triangleCount).toBe(10);
    }
  });

  it("occupies roughly two thirds of eligible kerb segments", () => {
    const px = cityToPixels(CITY, PPM);
    const spans = buildRoadDetails(px.graph, PPM).parkingSpans.filter(
      (span) => span.to - span.from >= CAR_LENGTH_M * PPM && span.roadHalf * 2 >= 9 * PPM
    );
    const rate = carsAt(PPM).length / spans.length;
    expect(CAR_RATE).toBeCloseTo(2 / 3, 9);
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(0.8);
  });

  it("uses the local district bank and forces the roof's lit-strip variant", () => {
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
      expect(shaderRoofStyle(car.seed)).toBeGreaterThanOrEqual(0.42);
      expect(shaderRoofStyle(car.seed)).toBeLessThan(0.78);
    }
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
          car.seed.toFixed(8)
        ].join("|")
      );
    expect(key(fine, PPM * 2)).toEqual(key(coarse, PPM));
  });
});
