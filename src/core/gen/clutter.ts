import {
  describeBuildingMassing,
  wallShade,
  type BuildingSpec
} from "../geom/extrude.js";
import { KIND, MeshBuilder, type MeshBuffers } from "../geom/mesh.js";
import { ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
import { hash2 } from "./hash.js";

export const CLUTTER_MIN_BUILDING_M = 20;
export const CLUTTER_MAX_HEIGHT_M = 4.5;

const CLUTTER_MIN_HEIGHT_M = 2;
const TWO_BOX_RATE = 0.45;
const EDGE_CLEARANCE_M = 0.6;
const BOX_CLEARANCE_M = 0.5;

interface ClutterBox {
  corners: Ring;
  centreU: number;
  centreV: number;
  halfU: number;
  halfV: number;
  base: number;
  top: number;
  wallMaterial: number;
}

const LOCAL_U = [-1, 1, 1, -1];
const LOCAL_V = [-1, -1, 1, 1];

const roll = (seed: number, salt: number): number =>
  hash2(Math.round(seed * 0x3fffffff), salt);

function pointInRing(p: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) === (b.y > p.y)) continue;
    const crossingX = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (p.x < crossingX) inside = !inside;
  }
  return inside;
}

function overlaps(a: ClutterBox, b: ClutterBox): boolean {
  return (
    Math.abs(a.centreU - b.centreU) < a.halfU + b.halfU + BOX_CLEARANCE_M &&
    Math.abs(a.centreV - b.centreV) < a.halfV + b.halfV + BOX_CLEARANCE_M
  );
}

function boxesFor(spec: BuildingSpec, pixelsPerMetre: number): ClutterBox[] {
  if (spec.height < CLUTTER_MIN_BUILDING_M || spec.footprint.length < 3) return [];
  const roof = describeBuildingMassing(spec, pixelsPerMetre).volumes.at(-1)!;
  const footprint = roof.footprint;

  const centre = ringCentroid(footprint);
  let ux = 1;
  let uy = 0;
  let longest = 0;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!;
    const b = footprint[(i + 1) % footprint.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= longest) continue;
    longest = length;
    ux = (b.x - a.x) / length;
    uy = (b.y - a.y) / length;
  }
  if (longest <= 0) return [];

  let extentU = 0;
  let extentV = 0;
  for (const p of footprint) {
    const dx = (p.x - centre.x) / pixelsPerMetre;
    const dy = (p.y - centre.y) / pixelsPerMetre;
    extentU = Math.max(extentU, Math.abs(dx * ux + dy * uy));
    extentV = Math.max(extentV, Math.abs(-dx * uy + dy * ux));
  }

  const count = roll(spec.seed, 20) < TWO_BOX_RATE ? 2 : 1;
  const boxes: ClutterBox[] = [];
  for (let boxIndex = 0; boxIndex < count; boxIndex++) {
    const halfU = Math.min(
      1.25 + roll(spec.seed, 21 + boxIndex * 13) * 1.25,
      extentU * 0.32
    );
    const halfV = Math.min(
      0.9 + roll(spec.seed, 22 + boxIndex * 13) * 0.85,
      extentV * 0.32
    );
    if (halfU < 0.75 || halfV < 0.6) continue;

    const rangeU = Math.max(0, extentU - halfU - EDGE_CLEARANCE_M);
    const rangeV = Math.max(0, extentV - halfV - EDGE_CLEARANCE_M);
    for (let attempt = 0; attempt < 8; attempt++) {
      const salt = 23 + boxIndex * 13 + attempt * 31;
      const centreU = (roll(spec.seed, salt) * 2 - 1) * rangeU;
      const centreV = (roll(spec.seed, salt + 1) * 2 - 1) * rangeV;
      const corner = (su: number, sv: number): Vec2 => {
        const along = (centreU + su * halfU) * pixelsPerMetre;
        const across = (centreV + sv * halfV) * pixelsPerMetre;
        return {
          x: centre.x + ux * along - uy * across,
          y: centre.y + uy * along + ux * across
        };
      };
      const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      if (!corners.every((p) => pointInRing(p, footprint))) continue;

      const box: ClutterBox = {
        corners,
        centreU,
        centreV,
        halfU,
        halfV,
        base: roof.topHeight,
        top:
          roof.topHeight +
          CLUTTER_MIN_HEIGHT_M +
          roll(spec.seed, salt + 2) * (CLUTTER_MAX_HEIGHT_M - CLUTTER_MIN_HEIGHT_M),
        wallMaterial: spec.wallMaterial
      };
      if (boxes.some((other) => overlaps(box, other))) continue;
      boxes.push(box);
      break;
    }
  }
  return boxes;
}

/** Deterministic 10-triangle rooftop boxes, already clipped by corner containment. */
export function clutterMesh(buildings: BuildingSpec[], pixelsPerMetre: number): MeshBuffers {
  const boxes = buildings.flatMap((spec) => boxesFor(spec, pixelsPerMetre));
  const builder = new MeshBuilder(boxes.length * 20, boxes.length * 10);

  for (const box of boxes) {
    const roof = builder.vertexCount;
    for (let i = 0; i < box.corners.length; i++) {
      const p = box.corners[i]!;
      builder.vertex(
        p.x,
        p.y,
        box.top,
        box.wallMaterial,
        -1,
        KIND.CLUTTER,
        LOCAL_U[i]!,
        LOCAL_V[i]!
      );
    }
    builder.triangle(roof, roof + 1, roof + 2);
    builder.triangle(roof, roof + 2, roof + 3);

    for (let i = 0; i < 4; i++) {
      const a = box.corners[i]!;
      const b = box.corners[(i + 1) % 4]!;
      const shade = wallShade(a, b);
      const wall = builder.vertexCount;
      builder.vertex(a.x, a.y, box.base, box.wallMaterial, shade, KIND.CLUTTER);
      builder.vertex(b.x, b.y, box.base, box.wallMaterial, shade, KIND.CLUTTER);
      builder.vertex(b.x, b.y, box.top, box.wallMaterial, shade, KIND.CLUTTER);
      builder.vertex(a.x, a.y, box.top, box.wallMaterial, shade, KIND.CLUTTER);
      builder.triangle(wall, wall + 1, wall + 2);
      builder.triangle(wall, wall + 2, wall + 3);
    }
  }

  return builder.build();
}
