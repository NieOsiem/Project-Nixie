import { wallShade, withPositiveArea } from "../geom/extrude.js";
import { CAR_SURFACE, KIND, MeshBuilder, type MeshBuffers } from "../geom/mesh.js";
import { ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
import type { ParkedCar } from "./cars.js";

interface CarPrism {
  footprint: Ring;
  baseHeight: number;
  topHeight: number;
  material: number;
  sideSurface: number | null;
  capSurface: number;
  seed: number;
}

interface CabinProfile {
  rear: number;
  front: number;
  rearHalfWidth: number;
  frontHalfWidth: number;
  baseHeight: number;
  roofHeight: number;
}

const localPoint = (car: ParkedCar, longitudinal: number, lateral: number): Vec2 => {
  const centre = ringCentroid(car.footprint);
  const right = { x: -car.forward.y, y: car.forward.x };
  const a = car.footprint[0]!;
  const b = car.footprint[1]!;
  const pixelsPerMetre = Math.hypot(b.x - a.x, b.y - a.y) / car.lengthM;
  return {
    x: centre.x + (car.forward.x * longitudinal + right.x * lateral) * pixelsPerMetre,
    y: centre.y + (car.forward.y * longitudinal + right.y * lateral) * pixelsPerMetre
  };
};

function localRing(car: ParkedCar, points: ReadonlyArray<readonly [number, number]>): Ring {
  return withPositiveArea(points.map(([x, y]) => localPoint(car, x, y)));
}

function rectRing(
  car: ParkedCar,
  rear: number,
  front: number,
  left: number,
  right: number
): Ring {
  return localRing(car, [
    [rear, left],
    [front, left],
    [front, right],
    [rear, right]
  ]);
}

function bodyRing(car: ParkedCar): Ring {
  const halfLength = car.lengthM / 2;
  const halfWidth = car.widthM / 2;
  const cut = Math.min(0.32, car.widthM * 0.14);
  return localRing(car, [
    [-halfLength + cut, -halfWidth],
    [halfLength - cut, -halfWidth],
    [halfLength, -halfWidth + cut],
    [halfLength, halfWidth - cut],
    [halfLength - cut, halfWidth],
    [-halfLength + cut, halfWidth],
    [-halfLength, halfWidth - cut],
    [-halfLength, -halfWidth + cut]
  ]);
}

function cabinProfile(car: ParkedCar): CabinProfile {
  const halfWidth = car.widthM / 2;
  switch (car.family) {
    case "compact":
      return {
        rear: -1.15, front: 0.72,
        rearHalfWidth: halfWidth * 0.74, frontHalfWidth: halfWidth * 0.66,
        baseHeight: 0.68, roofHeight: car.height
      };
    case "sedan":
      return {
        rear: -0.9, front: 1.02,
        rearHalfWidth: halfWidth * 0.75, frontHalfWidth: halfWidth * 0.68,
        baseHeight: 0.7, roofHeight: car.height
      };
    case "hatchback":
      return {
        rear: -1.35, front: 0.76,
        rearHalfWidth: halfWidth * 0.78, frontHalfWidth: halfWidth * 0.67,
        baseHeight: 0.7, roofHeight: car.height
      };
    case "wagon":
      return {
        rear: -1.55, front: 0.86,
        rearHalfWidth: halfWidth * 0.79, frontHalfWidth: halfWidth * 0.69,
        baseHeight: 0.72, roofHeight: car.height
      };
    case "coupe":
      return {
        rear: -0.72, front: 0.96,
        rearHalfWidth: halfWidth * 0.7, frontHalfWidth: halfWidth * 0.62,
        baseHeight: 0.66, roofHeight: car.height
      };
    case "minivan":
      return {
        rear: -1.45, front: 1.22,
        rearHalfWidth: halfWidth * 0.82, frontHalfWidth: halfWidth * 0.72,
        baseHeight: 0.76, roofHeight: car.height
      };
    case "van":
      return {
        rear: 0.34, front: 1.7,
        rearHalfWidth: halfWidth * 0.84, frontHalfWidth: halfWidth * 0.7,
        baseHeight: 0.78, roofHeight: car.height
      };
    case "pickup":
      return {
        rear: -0.08, front: 1.48,
        rearHalfWidth: halfWidth * 0.76, frontHalfWidth: halfWidth * 0.67,
        baseHeight: 0.72, roofHeight: car.height
      };
  }
}

function prism(
  car: ParkedCar,
  footprint: Ring,
  baseHeight: number,
  topHeight: number,
  material: number,
  surface: number | null,
  capSurface = surface ?? CAR_SURFACE.CAP,
  salt = 0
): CarPrism {
  return {
    footprint,
    baseHeight,
    topHeight,
    material,
    sideSurface: surface,
    capSurface,
    seed: car.seed + salt * 0.001
  };
}

function baselinePrisms(car: ParkedCar): CarPrism[] {
  const halfLength = car.lengthM / 2;
  const halfWidth = car.widthM / 2;
  const hullHeight = car.family === "van" || car.family === "minivan" ? 0.82 : 0.72;
  const profile = cabinProfile(car);
  const out: CarPrism[] = [
    prism(car, bodyRing(car), 0.16, hullHeight, car.wallMaterial, null)
  ];

  if (car.family === "van") {
    out.push(prism(
      car,
      rectRing(car, -halfLength + 0.2, profile.rear + 0.18, -halfWidth * 0.86, halfWidth * 0.86),
      hullHeight - 0.02,
      car.height - 0.08,
      car.roofMaterial,
      null,
      CAR_SURFACE.CAP,
      50
    ));
  }

  const glass = localRing(car, [
    [profile.rear, -profile.rearHalfWidth],
    [profile.front, -profile.frontHalfWidth],
    [profile.front, profile.frontHalfWidth],
    [profile.rear, profile.rearHalfWidth]
  ]);
  out.push(prism(
    car,
    glass,
    profile.baseHeight,
    profile.roofHeight - 0.07,
    car.wallMaterial,
    CAR_SURFACE.GLASS,
    CAR_SURFACE.GLASS,
    60
  ));

  const roofInset = car.family === "coupe" ? 0.25 : 0.2;
  out.push(prism(
    car,
    localRing(car, [
      [profile.rear + 0.24, -Math.max(0.2, profile.rearHalfWidth - roofInset)],
      [profile.front - 0.24, -Math.max(0.2, profile.frontHalfWidth - roofInset)],
      [profile.front - 0.24, Math.max(0.2, profile.frontHalfWidth - roofInset)],
      [profile.rear + 0.24, Math.max(0.2, profile.rearHalfWidth - roofInset)]
    ]),
    profile.roofHeight - 0.08,
    profile.roofHeight,
    car.roofMaterial,
    null,
    CAR_SURFACE.CAP,
    61
  ));

  if (car.family === "pickup") {
    const bedRear = -halfLength + 0.3;
    const bedFront = profile.rear - 0.18;
    out.push(
      prism(
        car,
        rectRing(car, bedRear + 0.12, bedFront - 0.1, -halfWidth * 0.65, halfWidth * 0.65),
        hullHeight + 0.018, hullHeight + 0.05,
        car.wallMaterial, CAR_SURFACE.BED, CAR_SURFACE.BED, 70
      ),
      prism(
        car, rectRing(car, bedRear, bedFront, -halfWidth * 0.82, -halfWidth * 0.67),
        hullHeight, hullHeight + 0.28, car.wallMaterial, null, CAR_SURFACE.CAP, 71
      ),
      prism(
        car, rectRing(car, bedRear, bedFront, halfWidth * 0.67, halfWidth * 0.82),
        hullHeight, hullHeight + 0.28, car.wallMaterial, null, CAR_SURFACE.CAP, 72
      ),
      prism(
        car,
        rectRing(car, bedRear, bedRear + 0.16, -halfWidth * 0.82, halfWidth * 0.82),
        hullHeight, hullHeight + 0.28, car.wallMaterial, null, CAR_SURFACE.CAP, 73
      )
    );
  }

  return out;
}

function detailPrisms(car: ParkedCar): CarPrism[] {
  const halfLength = car.lengthM / 2;
  const halfWidth = car.widthM / 2;
  const profile = cabinProfile(car);
  const hullHeight = car.family === "van" || car.family === "minivan" ? 0.82 : 0.72;
  const out: CarPrism[] = [];

  for (const axle of [-halfLength * 0.56, halfLength * 0.56]) {
    for (const side of [-1, 1]) {
      const lateral = side * (halfWidth + 0.035);
      out.push(prism(
        car,
        rectRing(car, axle - 0.31, axle + 0.31, lateral - 0.13, lateral + 0.13),
        0.08,
        0.43,
        car.wallMaterial,
        CAR_SURFACE.TIRE,
        CAR_SURFACE.TIRE,
        10 + out.length
      ));
    }
  }

  out.push(
    prism(
      car,
      rectRing(car, halfLength - 0.16, halfLength + 0.02, -halfWidth * 0.78, halfWidth * 0.78),
      0.2, 0.36, car.wallMaterial, CAR_SURFACE.TRIM, CAR_SURFACE.TRIM, 20
    ),
    prism(
      car,
      rectRing(car, -halfLength - 0.02, -halfLength + 0.16, -halfWidth * 0.78, halfWidth * 0.78),
      0.2, 0.36, car.wallMaterial, CAR_SURFACE.TRIM, CAR_SURFACE.TRIM, 21
    )
  );

  const lightHalfWidth = Math.min(0.18, car.widthM * 0.09);
  const lightOffset = halfWidth * 0.56;
  for (const side of [-1, 1]) {
    const lateral = side * lightOffset;
    out.push(
      prism(
        car,
        rectRing(car, halfLength - 0.28, halfLength - 0.06, lateral - lightHalfWidth, lateral + lightHalfWidth),
        hullHeight + 0.015, hullHeight + 0.075,
        car.wallMaterial, CAR_SURFACE.FRONT_LIGHT, CAR_SURFACE.FRONT_LIGHT, 30 + side
      ),
      prism(
        car,
        rectRing(car, -halfLength + 0.06, -halfLength + 0.27, lateral - lightHalfWidth, lateral + lightHalfWidth),
        hullHeight + 0.015, hullHeight + 0.075,
        car.wallMaterial, CAR_SURFACE.REAR_LIGHT, CAR_SURFACE.REAR_LIGHT, 40 + side
      )
    );
  }

  for (const side of [-1, 1]) {
    const lateral = side * (profile.frontHalfWidth + 0.12);
    out.push(prism(
      car,
      rectRing(car, profile.front - 0.23, profile.front + 0.05, lateral - 0.12, lateral + 0.12),
      hullHeight + 0.1,
      hullHeight + 0.3,
      car.wallMaterial,
      CAR_SURFACE.TRIM,
      CAR_SURFACE.TRIM,
      100 + side
    ));

    const seamLateral = side * (halfWidth - 0.08);
    out.push(prism(
      car,
      rectRing(car, profile.rear + 0.12, profile.front - 0.12, seamLateral - 0.035, seamLateral + 0.035),
      hullHeight + 0.018,
      hullHeight + 0.04,
      car.wallMaterial,
      CAR_SURFACE.TRIM,
      CAR_SURFACE.TRIM,
      110 + side
    ));
  }

  if (["wagon", "minivan", "van"].includes(car.family)) {
    for (const side of [-1, 1]) {
      const lateral = side * Math.min(profile.rearHalfWidth, profile.frontHalfWidth) * 0.58;
      out.push(prism(
        car,
        rectRing(car, profile.rear + 0.28, profile.front - 0.28, lateral - 0.045, lateral + 0.045),
        car.height + 0.015,
        car.height + 0.07,
        car.roofMaterial,
        CAR_SURFACE.TRIM,
        CAR_SURFACE.TRIM,
        120 + side
      ));
    }
  }

  if (car.family === "coupe") {
    out.push(prism(
      car,
      rectRing(car, -halfLength + 0.3, -halfLength + 0.45, -halfWidth * 0.72, halfWidth * 0.72),
      hullHeight + 0.08,
      hullHeight + 0.18,
      car.roofMaterial,
      CAR_SURFACE.TRIM,
      CAR_SURFACE.TRIM,
      130
    ));
  }

  if (car.family === "pickup") {
    for (const t of [0.3, 0.5, 0.7]) {
      const x = -halfLength + 0.3 + (profile.rear + halfLength - 0.55) * t;
      out.push(prism(
        car,
        rectRing(car, x - 0.035, x + 0.035, -halfWidth * 0.62, halfWidth * 0.62),
        hullHeight + 0.052,
        hullHeight + 0.075,
        car.wallMaterial,
        CAR_SURFACE.TRIM,
        CAR_SURFACE.TRIM,
        140 + Math.round(t * 10)
      ));
    }
  }

  return out;
}

function meshForPrisms(prisms: CarPrism[]): MeshBuffers {
  const maxVertices = prisms.reduce((sum, part) => sum + part.footprint.length * 5, 0);
  const maxTriangles = prisms.reduce((sum, part) => sum + part.footprint.length * 3 - 2, 0);
  const builder = new MeshBuilder(maxVertices, maxTriangles);

  for (const part of prisms) {
    const ring = withPositiveArea(part.footprint);
    const roofBase = builder.vertexCount;
    for (const p of ring) {
      builder.vertex(
        p.x,
        p.y,
        part.topHeight,
        part.material,
        part.capSurface,
        KIND.CAR,
        0,
        0,
        part.seed
      );
    }
    for (let i = 1; i + 1 < ring.length; i++) {
      builder.triangle(roofBase, roofBase + i, roofBase + i + 1);
    }

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const shade = part.sideSurface ?? wallShade(a, b);
      const base = builder.vertex(a.x, a.y, part.baseHeight, part.material, shade, KIND.CAR, 0, 0, part.seed);
      builder.vertex(b.x, b.y, part.baseHeight, part.material, shade, KIND.CAR, 0, 0, part.seed);
      builder.vertex(b.x, b.y, part.topHeight, part.material, shade, KIND.CAR, 0, 0, part.seed);
      builder.vertex(a.x, a.y, part.topHeight, part.material, shade, KIND.CAR, 0, 0, part.seed);
      builder.triangle(base, base + 1, base + 2);
      builder.triangle(base, base + 2, base + 3);
    }
  }

  return builder.build();
}

export function carBodyMesh(cars: ParkedCar[], pixelsPerMetre: number): MeshBuffers {
  if (pixelsPerMetre <= 0) return meshForPrisms([]);
  return meshForPrisms(cars.flatMap(baselinePrisms));
}

export function carDetailMesh(cars: ParkedCar[], pixelsPerMetre: number): MeshBuffers {
  if (pixelsPerMetre <= 0) return meshForPrisms([]);
  return meshForPrisms(cars.flatMap(detailPrisms));
}
