import { describe, expect, it } from "vitest";
import { CAR_SURFACE, KIND, VERTEX_FLOATS } from "../geom/mesh.js";
import type { Ring } from "../geom/types.js";
import { materialIndex, BASE_BANK, DISTRICT_SLOT } from "../palette.js";
import { carBodyMesh, carDetailMesh } from "./car-geometry.js";
import { CAR_FAMILIES, type ParkedCar } from "./cars.js";

const ORIGIN = { x: 5000, y: 4000 };

function fixtureCars(pixelsPerMetre: number): ParkedCar[] {
  return CAR_FAMILIES.map((family, i) => {
    const centreX = ORIGIN.x + i * 8 * pixelsPerMetre;
    const halfLength = family.lengthM * pixelsPerMetre / 2;
    const halfWidth = family.widthM * pixelsPerMetre / 2;
    const footprint: Ring = [
      { x: centreX - halfLength, y: ORIGIN.y - halfWidth },
      { x: centreX + halfLength, y: ORIGIN.y - halfWidth },
      { x: centreX + halfLength, y: ORIGIN.y + halfWidth },
      { x: centreX - halfLength, y: ORIGIN.y + halfWidth }
    ];
    return {
      footprint,
      height: family.heightM,
      wallMaterial: materialIndex(BASE_BANK, DISTRICT_SLOT.WALL_A),
      roofMaterial: materialIndex(BASE_BANK, DISTRICT_SLOT.WALL_B),
      seed: i / CAR_FAMILIES.length,
      family: family.id,
      lengthM: family.lengthM,
      widthM: family.widthM,
      forward: { x: 1, y: 0 },
      wrongWay: false,
      parkingAngleRad: 0
    };
  });
}

const valuesAt = (mesh: ReturnType<typeof carBodyMesh>, offset: number): Set<number> => {
  const out = new Set<number>();
  for (let i = 0; i < mesh.vertexCount; i++) out.add(mesh.vertices[i * VERTEX_FLOATS + offset]!);
  return out;
};

describe("car geometry", () => {
  it("keeps a readable chamfered body, glass cabin and family silhouette in the coarse tier", () => {
    const cars = fixtureCars(25);
    const body = carBodyMesh(cars, 25);
    expect(body.triangleCount).toBeGreaterThan(cars.length * 40);
    expect(valuesAt(body, 5)).toEqual(new Set([KIND.CAR]));

    const surfaces = valuesAt(body, 4);
    for (const surface of [
      CAR_SURFACE.CAP,
      CAR_SURFACE.GLASS,
      CAR_SURFACE.BED
    ]) {
      expect(surfaces).toContain(surface);
    }
  });

  it("keeps wheels, lamps, mirrors, seams, rails, spoilers and bed ribs in the detail tier", () => {
    const cars = fixtureCars(25);
    const body = carBodyMesh(cars, 25);
    const detail = carDetailMesh(cars, 25);
    expect(detail.triangleCount).toBeGreaterThan(cars.length * 100);
    expect(body.triangleCount + detail.triangleCount).toBeGreaterThan(cars.length * 150);
    expect(valuesAt(detail, 5)).toEqual(new Set([KIND.CAR]));
    const surfaces = valuesAt(detail, 4);
    for (const surface of [
      CAR_SURFACE.FRONT_LIGHT,
      CAR_SURFACE.REAR_LIGHT,
      CAR_SURFACE.TIRE,
      CAR_SURFACE.TRIM
    ]) {
      expect(surfaces).toContain(surface);
    }
  });

  it("is metre-stable across a scene regrid", () => {
    const coarse = carBodyMesh(fixtureCars(25), 25);
    const fine = carBodyMesh(fixtureCars(50), 50);
    expect(fine.vertexCount).toBe(coarse.vertexCount);
    expect(fine.indices).toEqual(coarse.indices);
    for (let i = 0; i < coarse.vertexCount; i++) {
      const at = i * VERTEX_FLOATS;
      expect((fine.vertices[at]! - ORIGIN.x) / 50).toBeCloseTo(
        (coarse.vertices[at]! - ORIGIN.x) / 25,
        4
      );
      expect((fine.vertices[at + 1]! - ORIGIN.y) / 50).toBeCloseTo(
        (coarse.vertices[at + 1]! - ORIGIN.y) / 25,
        4
      );
      expect(fine.vertices.slice(at + 2, at + VERTEX_FLOATS)).toEqual(
        coarse.vertices.slice(at + 2, at + VERTEX_FLOATS)
      );
    }
  });

  it("returns empty buffers for an invalid scene scale", () => {
    expect(carBodyMesh(fixtureCars(25), 0).triangleCount).toBe(0);
    expect(carDetailMesh(fixtureCars(25), 0).triangleCount).toBe(0);
  });
});
