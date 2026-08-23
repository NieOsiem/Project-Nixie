import {
  describeBuildingMassing,
  supportsRoofStructures,
  wallShade,
  type BuildingSpec
} from "../geom/extrude.js";
import { KIND, MeshBuilder, type MeshBuffers } from "../geom/mesh.js";
import { ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
import { resolveArchitecturalTypology, type ArchitecturalTypology } from "./building-detail.js";
import { hash2 } from "./hash.js";

export const CLUTTER_MIN_BUILDING_M = 20;
export const CLUTTER_MAX_HEIGHT_M = 4.5;

const CLUTTER_MIN_HEIGHT_M = 2;
const TWO_BOX_RATE = 0.45;
const EDGE_CLEARANCE_M = 0.6;
const BOX_CLEARANCE_M = 0.5;

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
};

/**
 * Deterministic unit roll on the v2 rooftop-clutter namespace. Separate path space from
 * both the legacy numeric salts and the detail-tier `rooftops/v2/<family>` streams.
 */
const clutterRoll = (spec: BuildingSpec, family: string, slot: string): number =>
  fnv1a(`${Math.round(spec.seed * 0x3fffffff)}/rooftops/v2/clutter/${family}/${slot}`) /
  0x100000000;

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

interface RoofPlane {
  centre: Vec2;
  ux: number;
  uy: number;
  extentU: number;
  extentV: number;
}

function roofPlane(footprint: Ring, pixelsPerMetre: number): RoofPlane | null {
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
  if (longest <= 0) return null;

  let extentU = 0;
  let extentV = 0;
  for (const p of footprint) {
    const dx = (p.x - centre.x) / pixelsPerMetre;
    const dy = (p.y - centre.y) / pixelsPerMetre;
    extentU = Math.max(extentU, Math.abs(dx * ux + dy * uy));
    extentV = Math.max(extentV, Math.abs(-dx * uy + dy * ux));
  }
  return { centre, ux, uy, extentU, extentV };
}

function boxesFor(spec: BuildingSpec, pixelsPerMetre: number): ClutterBox[] {
  if (spec.height < CLUTTER_MIN_BUILDING_M || spec.footprint.length < 3) return [];
  const roof = describeBuildingMassing(spec, pixelsPerMetre).volumes.at(-1)!;
  const footprint = roof.footprint;
  const plane = roofPlane(footprint, pixelsPerMetre);
  if (plane === null) return [];

  // CRITIQUE #7: typology-aware rooftop furniture carries variety at overview zoom,
  // where the detail tier is hidden. Quad decks only, matching the structure-free flag
  // extrude paints into non-rectangular roofs; generic boxes stay as the fallback.
  const typology = resolveArchitecturalTypology(spec);
  if (typology !== "standard" && supportsRoofStructures(footprint)) {
    const family = familyClutterBoxes(
      typology,
      spec,
      plane,
      pixelsPerMetre,
      roof.topHeight,
      footprint
    );
    if (family !== null) return family;
  }

  const count = roll(spec.seed, 20) < TWO_BOX_RATE ? 2 : 1;
  const boxes: ClutterBox[] = [];
  for (let boxIndex = 0; boxIndex < count; boxIndex++) {
    const halfU = Math.min(
      1.25 + roll(spec.seed, 21 + boxIndex * 13) * 1.25,
      plane.extentU * 0.32
    );
    const halfV = Math.min(
      0.9 + roll(spec.seed, 22 + boxIndex * 13) * 0.85,
      plane.extentV * 0.32
    );
    if (halfU < 0.75 || halfV < 0.6) continue;

    const rangeU = Math.max(0, plane.extentU - halfU - EDGE_CLEARANCE_M);
    const rangeV = Math.max(0, plane.extentV - halfV - EDGE_CLEARANCE_M);
    for (let attempt = 0; attempt < 8; attempt++) {
      const salt = 23 + boxIndex * 13 + attempt * 31;
      const centreU = (roll(spec.seed, salt) * 2 - 1) * rangeU;
      const centreV = (roll(spec.seed, salt + 1) * 2 - 1) * rangeV;
      const corner = (su: number, sv: number): Vec2 => {
        const along = (centreU + su * halfU) * pixelsPerMetre;
        const across = (centreV + sv * halfV) * pixelsPerMetre;
        return {
          x: plane.centre.x + plane.ux * along - plane.uy * across,
          y: plane.centre.y + plane.uy * along + plane.ux * across
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

interface FamilySpot {
  centreU: number;
  centreV: number;
  halfU: number;
  halfV: number;
}

/** Rolls one contained, collision-free family box on the deck; null when there is no room. */
function placeFamilyBox(
  plane: RoofPlane,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec,
  family: string,
  key: string,
  halfU: number,
  halfV: number,
  heightM: number,
  material: number,
  base: number,
  placed: readonly FamilySpot[]
): ClutterBox | null {
  const rangeU = Math.max(0, plane.extentU - halfU - EDGE_CLEARANCE_M);
  const rangeV = Math.max(0, plane.extentV - halfV - EDGE_CLEARANCE_M);
  for (let attempt = 0; attempt < 8; attempt++) {
    const centreU = (clutterRoll(spec, family, `${key}/u/${attempt}`) * 2 - 1) * rangeU;
    const centreV = (clutterRoll(spec, family, `${key}/v/${attempt}`) * 2 - 1) * rangeV;
    if (
      placed.some(
        (other) =>
          Math.abs(other.centreU - centreU) < other.halfU + halfU + BOX_CLEARANCE_M &&
          Math.abs(other.centreV - centreV) < other.halfV + halfV + BOX_CLEARANCE_M
      )
    ) {
      continue;
    }
    const corner = (su: number, sv: number): Vec2 => {
      const along = (centreU + su * halfU) * pixelsPerMetre;
      const across = (centreV + sv * halfV) * pixelsPerMetre;
      return {
        x: plane.centre.x + plane.ux * along - plane.uy * across,
        y: plane.centre.y + plane.uy * along + plane.ux * across
      };
    };
    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    if (!corners.every((p) => pointInRing(p, footprint))) continue;
    return {
      corners,
      centreU,
      centreV,
      halfU,
      halfV,
      base,
      top: base + Math.min(heightM, CLUTTER_MAX_HEIGHT_M),
      wallMaterial: material
    };
  }
  return null;
}

/**
 * Per-typology clutter recipes for overview zoom. Corporate keeps a fixed neat pair —
 * clean character AND a stable two-box budget per deck; the other typologies vary count
 * within small bounded ranges. Returns null when nothing fits so the generic fallback
 * boxes can take over.
 */
function familyClutterBoxes(
  typology: ArchitecturalTypology,
  spec: BuildingSpec,
  plane: RoofPlane,
  pixelsPerMetre: number,
  base: number,
  footprint: Ring
): ClutterBox[] | null {
  const boxes: ClutterBox[] = [];
  const placed: FamilySpot[] = [];
  const put = (
    family: string,
    key: string,
    halfU: number,
    halfV: number,
    heightM: number,
    material: number
  ): void => {
    const box = placeFamilyBox(
      plane, footprint, pixelsPerMetre, spec, family, key, halfU, halfV, heightM, material, base, placed
    );
    if (box === null) return;
    boxes.push(box);
    placed.push({
      centreU: box.centreU,
      centreV: box.centreV,
      halfU: box.halfU,
      halfV: box.halfV
    });
  };

  switch (typology) {
    case "corporate": {
      // Neat paired chiller set.
      const halfU = 1.0 + clutterRoll(spec, "hvac", "hu") * 0.35;
      const halfV = 0.8 + clutterRoll(spec, "hvac", "hv") * 0.3;
      const heightM = 1.4 + clutterRoll(spec, "hvac", "h") * 1.2;
      put("hvac", "unit-0", halfU, halfV, heightM, spec.wallMaterial);
      put("hvac", "unit-1", halfU, halfV, heightM, spec.roofMaterial);
      break;
    }
    case "residential": {
      // Crowded-small: drum cluster plus a vent pair.
      const drums = 2 + Math.floor(clutterRoll(spec, "drums", "count") * 1.99);
      for (let i = 0; i < drums; i++) {
        const half = 0.5 + clutterRoll(spec, "drums", `size/${i}`) * 0.3;
        put(
          "drums",
          `${i}`,
          half,
          half,
          1.0 + clutterRoll(spec, "drums", `h/${i}`) * 0.6,
          i % 2 === 0 ? spec.roofMaterial : spec.wallMaterial
        );
      }
      put("vents", "pair-0", 0.45, 0.45, 0.7 + clutterRoll(spec, "vents", "h0") * 0.4, spec.wallMaterial);
      put("vents", "pair-1", 0.45, 0.45, 0.6 + clutterRoll(spec, "vents", "h1") * 0.4, spec.wallMaterial);
      break;
    }
    case "industrial": {
      // Heavy functional plenum row.
      const units = 2 + Math.floor(clutterRoll(spec, "plenum", "count") * 1.99);
      for (let i = 0; i < units; i++) {
        put(
          "plenum",
          `${i}`,
          1.4 + clutterRoll(spec, "plenum", `u/${i}`) * 0.6,
          1.0 + clutterRoll(spec, "plenum", `v/${i}`) * 0.5,
          2.2 + clutterRoll(spec, "plenum", `h/${i}`) * 1.4,
          i % 2 === 0 ? spec.wallMaterial : spec.roofMaterial
        );
      }
      break;
    }
    case "market": {
      // Chaotic compressor/crate scatter.
      const units = 2 + Math.floor(clutterRoll(spec, "compressor", "count") * 2.99);
      for (let i = 0; i < units; i++) {
        put(
          "compressor",
          `${i}`,
          0.8 + clutterRoll(spec, "compressor", `u/${i}`) * 0.4,
          0.7 + clutterRoll(spec, "compressor", `v/${i}`) * 0.35,
          1.2 + clutterRoll(spec, "compressor", `h/${i}`) * 0.8,
          i % 2 === 0 ? spec.roofMaterial : spec.wallMaterial
        );
      }
      break;
    }
    case "civic": {
      // Formal decks stay nearly bare: one low service box at most.
      if (clutterRoll(spec, "service", "on") < 0.5) {
        put("service", "box", 0.9, 0.7, 1.1 + clutterRoll(spec, "service", "h") * 0.6, spec.wallMaterial);
      }
      break;
    }
    case "derelict": {
      // Improvised junk piles in alternating scrap materials.
      const junk = 2 + Math.floor(clutterRoll(spec, "junk", "count") * 2.99);
      for (let i = 0; i < junk; i++) {
        put(
          "junk",
          `${i}`,
          0.5 + clutterRoll(spec, "junk", `u/${i}`) * 0.9,
          0.45 + clutterRoll(spec, "junk", `v/${i}`) * 0.7,
          0.8 + clutterRoll(spec, "junk", `h/${i}`) * 1.6,
          i % 2 === 0 ? spec.roofMaterial : spec.wallMaterial
        );
      }
      break;
    }
    default:
      return null;
  }
  return boxes.length > 0 ? boxes : null;
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
