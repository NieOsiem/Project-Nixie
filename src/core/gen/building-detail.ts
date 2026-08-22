import {
  describeBuildingMassing,
  wallShade,
  withPositiveArea,
  type BuildingMassing,
  type BuildingSpec,
  type BuildingVolume
} from "../geom/extrude.js";
import { KIND, MeshBuilder, mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { triangulate } from "../geom/tessellate.js";
import { ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT } from "../palette.js";
import { hash2 } from "./hash.js";

export const BUILDING_DETAIL_MIN_HEIGHT_M = 12;

export interface DetailPrism {
  footprint: Ring;
  baseHeight: number;
  topHeight: number;
  material: number;
  seed: number;
}

interface RoofFrame {
  centre: Vec2;
  ux: number;
  uy: number;
  extentU: number;
  extentV: number;
}

export type ArchitecturalTypology =
  | "corporate"
  | "residential"
  | "industrial"
  | "market"
  | "civic"
  | "derelict"
  | "standard";

const roll = (seed: number, salt: number): number =>
  hash2(Math.round(seed * 0x3fffffff), salt);

/**
 * Classifies a building into its architectural typology based on facadeProfile,
 * roofline, and wear.
 */
export function resolveArchitecturalTypology(spec: BuildingSpec): ArchitecturalTypology {
  const profile = spec.facadeProfile?.toLowerCase() ?? "";
  const roofline = spec.roofline?.toLowerCase() ?? "";
  const wear = spec.wear ?? 0;

  if (
    wear >= 0.65 ||
    profile.includes("derelict") ||
    profile.includes("shanty") ||
    profile.includes("slum") ||
    profile.includes("decay") ||
    profile.includes("ruin")
  ) {
    return "derelict";
  }

  if (
    profile.includes("shopfront") ||
    profile.includes("arcade") ||
    profile.includes("entertainment") ||
    profile.includes("market") ||
    profile.includes("commercial") ||
    profile.includes("marquee")
  ) {
    return "market";
  }

  if (
    profile.includes("civic") ||
    profile.includes("columns") ||
    profile.includes("monument") ||
    roofline === "domed"
  ) {
    return "civic";
  }

  if (
    profile.includes("office") ||
    profile.includes("glass") ||
    profile.includes("curtain") ||
    profile.includes("corporate") ||
    (roofline === "crown" && !profile.includes("balcony"))
  ) {
    return "corporate";
  }

  if (
    profile.includes("residential") ||
    profile.includes("balcony") ||
    profile.includes("masonry") ||
    roofline === "terrace"
  ) {
    return "residential";
  }

  if (
    profile.includes("industrial") ||
    profile.includes("warehouse") ||
    profile.includes("utility") ||
    profile.includes("louvre") ||
    profile.includes("ribs") ||
    profile.includes("logistics") ||
    roofline === "sawtooth" ||
    roofline === "shed"
  ) {
    return "industrial";
  }

  if (roofline === "sawtooth" || roofline === "shed") return "industrial";
  if (roofline === "crown") return "corporate";
  if (roofline === "terrace") return "residential";
  if (roofline === "domed") return "civic";

  return "standard";
}

function neonMaterial(spec: BuildingSpec, salt: number): number {
  if (spec.neonEnabled === false) {
    return spec.wallMaterial;
  }
  const bank = Math.floor(spec.wallMaterial / BANK_SIZE) * BANK_SIZE;
  const weights = spec.neonWeights ?? [0.5, 0.5];
  const slot =
    roll(spec.seed, salt) < weights[0]!
      ? DISTRICT_SLOT.NEON_A
      : DISTRICT_SLOT.NEON_B;
  return bank + slot;
}

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

function edgeStrip(
  a: Vec2,
  b: Vec2,
  start: number,
  end: number,
  insetM: number,
  outsetM: number,
  pixelsPerMetre: number
): Ring | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0 || end <= start) return null;

  const nx = dy / length;
  const ny = -dx / length;
  const p0 = { x: a.x + dx * start, y: a.y + dy * start };
  const p1 = { x: a.x + dx * end, y: a.y + dy * end };
  const outer = outsetM * pixelsPerMetre;
  const inner = insetM * pixelsPerMetre;
  return withPositiveArea([
    { x: p0.x + nx * outer, y: p0.y + ny * outer },
    { x: p1.x + nx * outer, y: p1.y + ny * outer },
    { x: p1.x - nx * inner, y: p1.y - ny * inner },
    { x: p0.x - nx * inner, y: p0.y - ny * inner }
  ]);
}

function roofFrame(footprint: Ring, pixelsPerMetre: number): RoofFrame | null {
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

function containedRoofBox(
  footprint: Ring,
  pixelsPerMetre: number,
  seed: number,
  salt: number,
  targetHalfU?: number,
  targetHalfV?: number,
  offsetFactor = 0.7
): Ring | null {
  const frame = roofFrame(footprint, pixelsPerMetre);
  if (frame === null) return null;

  const halfU = Math.min(
    frame.extentU * 0.42,
    targetHalfU ?? (3.2 + roll(seed, salt) * 3.8)
  );
  const halfV = Math.min(
    frame.extentV * 0.42,
    targetHalfV ?? (2.4 + roll(seed, salt + 1) * 2.8)
  );
  if (halfU < 0.6 || halfV < 0.6) return null;

  const rangeU = Math.max(0, (frame.extentU - halfU - 0.5) * offsetFactor);
  const rangeV = Math.max(0, (frame.extentV - halfV - 0.5) * offsetFactor);

  for (let attempt = 0; attempt < 16; attempt++) {
    const centreU = attempt === 0 ? 0 : (roll(seed, salt + 2 + attempt * 2) * 2 - 1) * rangeU;
    const centreV = attempt === 0 ? 0 : (roll(seed, salt + 3 + attempt * 2) * 2 - 1) * rangeV;
    const corner = (su: number, sv: number): Vec2 => {
      const along = (centreU + su * halfU) * pixelsPerMetre;
      const across = (centreV + sv * halfV) * pixelsPerMetre;
      return {
        x: frame.centre.x + frame.ux * along - frame.uy * across,
        y: frame.centre.y + frame.uy * along + frame.ux * across
      };
    };
    const box = withPositiveArea([
      corner(-1, -1),
      corner(1, -1),
      corner(1, 1),
      corner(-1, 1)
    ]);
    if (box.every((p) => pointInRing(p, footprint))) return box;
  }
  return null;
}

function centeredRoofBox(
  footprint: Ring,
  pixelsPerMetre: number,
  halfUM: number,
  halfVM: number
): Ring | null {
  const frame = roofFrame(footprint, pixelsPerMetre);
  if (frame === null) return null;
  const halfU = Math.min(frame.extentU * 0.48, halfUM);
  const halfV = Math.min(frame.extentV * 0.48, halfVM);
  if (halfU < 0.5 || halfV < 0.5) return null;

  const corner = (su: number, sv: number): Vec2 => {
    const along = su * halfU * pixelsPerMetre;
    const across = sv * halfV * pixelsPerMetre;
    return {
      x: frame.centre.x + frame.ux * along - frame.uy * across,
      y: frame.centre.y + frame.uy * along + frame.ux * across
    };
  };
  const box = withPositiveArea([
    corner(-1, -1),
    corner(1, -1),
    corner(1, 1),
    corner(-1, 1)
  ]);
  if (box.every((p) => pointInRing(p, footprint))) return box;
  return null;
}

function scaledRing(ring: Ring, scale: number): Ring {
  const centre = ringCentroid(ring);
  return ring.map((p) => ({
    x: centre.x + (p.x - centre.x) * scale,
    y: centre.y + (p.y - centre.y) * scale
  }));
}

/**
 * Generates restrained corporate mechanical crown:
 * Sleek recessed mechanical screen, chiller units, communications mast/beacon.
 */
function generateCorporateCrown(
  roof: BuildingVolume,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec,
  accent: number
): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const deck = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 810, 4.5, 3.5, 0.4);
  if (deck !== null) {
    const deckHeight = roof.topHeight + 0.35;
    const screenHeight = deckHeight + 3.2 + roll(spec.seed, 811) * 2.8;
    const penthouse = scaledRing(deck, 0.72);

    prisms.push(
      {
        footprint: deck,
        baseHeight: roof.topHeight + 0.04,
        topHeight: deckHeight,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 812)
      },
      {
        footprint: penthouse,
        baseHeight: deckHeight,
        topHeight: screenHeight,
        material: spec.wallMaterial,
        seed: roll(spec.seed, 813)
      }
    );

    // Chiller unit on top of penthouse
    const chiller = scaledRing(penthouse, 0.45);
    prisms.push({
      footprint: chiller,
      baseHeight: screenHeight,
      topHeight: screenHeight + 1.2 + roll(spec.seed, 814) * 0.8,
      material: spec.roofMaterial,
      seed: roll(spec.seed, 815)
    });

    // Communications spire / beacon
    if (roll(spec.seed, 816) < 0.65) {
      prisms.push({
        footprint: scaledRing(deck, 0.09),
        baseHeight: screenHeight,
        topHeight: screenHeight + 4.5 + roll(spec.seed, 817) * 4.0,
        material: spec.neonEnabled === false ? spec.roofMaterial : accent,
        seed: roll(spec.seed, 818)
      });
    }
  }
  return prisms;
}

/**
 * Generates dense residential roof additions:
 * Rooftop stair/elevator access bulkhead, stilted water tank, terrace deck.
 */
function generateResidentialRoof(
  roof: BuildingVolume,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec
): DetailPrism[] {
  const prisms: DetailPrism[] = [];

  // Stair/elevator core bulkhead
  const bulkhead = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 820, 2.6, 2.0, 0.6);
  if (bulkhead !== null) {
    prisms.push({
      footprint: bulkhead,
      baseHeight: roof.topHeight + 0.04,
      topHeight: roof.topHeight + 2.8 + roll(spec.seed, 821) * 0.8,
      material: spec.wallMaterial,
      seed: roll(spec.seed, 822)
    });
  }

  // Stilted rooftop water cistern
  const tankBase = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 824, 1.4, 1.4, 0.8);
  if (tankBase !== null) {
    const stiltTop = roof.topHeight + 1.2;
    const tankTop = stiltTop + 2.2 + roll(spec.seed, 825) * 1.0;
    prisms.push(
      {
        footprint: scaledRing(tankBase, 0.55),
        baseHeight: roof.topHeight + 0.04,
        topHeight: stiltTop,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 826)
      },
      {
        footprint: tankBase,
        baseHeight: stiltTop,
        topHeight: tankTop,
        material: spec.wallMaterial,
        seed: roll(spec.seed, 827)
      },
      {
        footprint: scaledRing(tankBase, 0.7),
        baseHeight: tankTop,
        topHeight: tankTop + 0.35,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 828)
      }
    );
  }

  return prisms;
}

/**
 * Generates industrial directional/service structures:
 * Directional monitor ridges / sawtooth skylights, heavy ventilation plenums, cooling units.
 */
function generateIndustrialRoof(
  roof: BuildingVolume,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec
): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const frame = roofFrame(footprint, pixelsPerMetre);
  if (frame === null) return prisms;

  // Directional sawtooth / monitor ridges
  const ridgeCount = Math.min(3, Math.max(1, Math.floor(frame.extentV / 4)));
  const ridgeHalfU = Math.min(frame.extentU * 0.38, 5.0 + roll(spec.seed, 830) * 3.0);
  const ridgeHalfV = Math.min(1.2, frame.extentV / (ridgeCount * 3));

  for (let r = 0; r < ridgeCount; r++) {
    const offsetV = (r - (ridgeCount - 1) / 2) * (frame.extentV * 0.55 / Math.max(1, ridgeCount));
    const corner = (su: number, sv: number): Vec2 => {
      const along = su * ridgeHalfU * pixelsPerMetre;
      const across = (offsetV + sv * ridgeHalfV) * pixelsPerMetre;
      return {
        x: frame.centre.x + frame.ux * along - frame.uy * across,
        y: frame.centre.y + frame.uy * along + frame.ux * across
      };
    };
    const ridgeBox = withPositiveArea([
      corner(-1, -1),
      corner(1, -1),
      corner(1, 1),
      corner(-1, 1)
    ]);
    if (ridgeBox.every((p) => pointInRing(p, footprint))) {
      prisms.push({
        footprint: ridgeBox,
        baseHeight: roof.topHeight + 0.04,
        topHeight: roof.topHeight + 1.8 + roll(spec.seed, 831 + r) * 1.2,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 832 + r)
      });
    }
  }

  // Industrial heavy ventilation housing / blower plenum
  const plenum = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 835, 2.2, 1.8, 0.7);
  if (plenum !== null) {
    prisms.push({
      footprint: plenum,
      baseHeight: roof.topHeight + 0.04,
      topHeight: roof.topHeight + 2.5 + roll(spec.seed, 836) * 1.5,
      material: spec.wallMaterial,
      seed: roll(spec.seed, 837)
    });
  }

  return prisms;
}

/**
 * Generates market & entertainment rooftop features:
 * Rooftop sign / billboard backing frame, refrigeration condensers, marquee pylon.
 */
function generateMarketRoof(
  roof: BuildingVolume,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec,
  accent: number
): DetailPrism[] {
  const prisms: DetailPrism[] = [];

  // Rooftop billboard / sign frame
  const signBase = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 840, 4.2, 1.2, 0.7);
  if (signBase !== null) {
    const frameHeight = roof.topHeight + 1.2;
    const signTop = frameHeight + 3.0 + roll(spec.seed, 841) * 2.2;
    prisms.push(
      // Support footing
      {
        footprint: scaledRing(signBase, 0.4),
        baseHeight: roof.topHeight + 0.04,
        topHeight: frameHeight,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 842)
      },
      // Signboard panel
      {
        footprint: signBase,
        baseHeight: frameHeight,
        topHeight: signTop,
        material: spec.wallMaterial,
        seed: roll(spec.seed, 843)
      }
    );
    // Illuminated sign border frame (if neon is enabled)
    if (spec.neonEnabled !== false) {
      prisms.push({
        footprint: scaledRing(signBase, 1.08),
        baseHeight: signTop - 0.35,
        topHeight: signTop,
        material: accent,
        seed: roll(spec.seed, 844)
      });
    }
  }

  // Commercial AC / refrigeration compressor units
  const compressor = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 845, 1.8, 1.5, 0.8);
  if (compressor !== null) {
    prisms.push({
      footprint: compressor,
      baseHeight: roof.topHeight + 0.04,
      topHeight: roof.topHeight + 1.4 + roll(spec.seed, 846) * 0.8,
      material: spec.roofMaterial,
      seed: roll(spec.seed, 847)
    });
  }

  return prisms;
}

/**
 * Generates civic symmetrical roof crown:
 * Stepped central cupola / pavilion, symmetrical lantern, finial spire.
 */
function generateCivicRoof(
  roof: BuildingVolume,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec
): DetailPrism[] {
  const prisms: DetailPrism[] = [];

  // Centered primary stepped pavilion
  const pavilion = centeredRoofBox(footprint, pixelsPerMetre, 4.0, 4.0);
  if (pavilion !== null) {
    const tier1Top = roof.topHeight + 2.8 + roll(spec.seed, 850) * 1.5;
    const tier2Top = tier1Top + 2.0 + roll(spec.seed, 851) * 1.2;
    const spireTop = tier2Top + 3.5 + roll(spec.seed, 852) * 3.0;

    const lantern = scaledRing(pavilion, 0.58);
    const finial = scaledRing(pavilion, 0.14);

    prisms.push(
      {
        footprint: pavilion,
        baseHeight: roof.topHeight + 0.04,
        topHeight: tier1Top,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 853)
      },
      {
        footprint: lantern,
        baseHeight: tier1Top,
        topHeight: tier2Top,
        material: spec.wallMaterial,
        seed: roll(spec.seed, 854)
      },
      {
        footprint: finial,
        baseHeight: tier2Top,
        topHeight: spireTop,
        material: spec.roofMaterial,
        seed: roll(spec.seed, 855)
      }
    );
  }

  return prisms;
}

/**
 * Generates derelict patched cluster roof:
 * Asymmetric patchwork shacks, makeshift lean-tos, scavenged water drums.
 */
function generateDerelictRoof(
  roof: BuildingVolume,
  footprint: Ring,
  pixelsPerMetre: number,
  spec: BuildingSpec
): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const shackCount = Math.min(3, 1 + Math.floor(roll(spec.seed, 860) * 2.8));

  for (let s = 0; s < shackCount; s++) {
    const halfU = 1.4 + roll(spec.seed, 861 + s * 7) * 1.8;
    const halfV = 1.2 + roll(spec.seed, 862 + s * 7) * 1.6;
    const shack = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 863 + s * 11, halfU, halfV, 0.85);
    if (shack !== null) {
      prisms.push({
        footprint: shack,
        baseHeight: roof.topHeight + 0.04,
        topHeight: roof.topHeight + 1.8 + roll(spec.seed, 864 + s * 7) * 1.4,
        material: s % 2 === 0 ? spec.wallMaterial : spec.roofMaterial,
        seed: roll(spec.seed, 865 + s * 7)
      });
    }
  }

  // Makeshift antenna / pole
  const pole = containedRoofBox(footprint, pixelsPerMetre, spec.seed, 870, 0.4, 0.4, 0.9);
  if (pole !== null) {
    prisms.push({
      footprint: pole,
      baseHeight: roof.topHeight + 0.04,
      topHeight: roof.topHeight + 3.5 + roll(spec.seed, 871) * 2.5,
      material: spec.roofMaterial,
      seed: roll(spec.seed, 872)
    });
  }

  return prisms;
}

/**
 * Bounded rooftop utility boxes (AC units, vents) for the detail tier, gated on the
 * grammar's rooftop-utility rate. At most 3 prisms — 30 triangles — per building, and
 * every corner stays inside the roof footprint.
 */
function utilityPrisms(
  spec: BuildingSpec,
  massing: BuildingMassing,
  pixelsPerMetre: number,
  accent: number
): DetailPrism[] {
  const rate = spec.rooftopUtilityRate;
  if (!(rate !== undefined && Number.isFinite(rate) && rate > 0)) return [];
  if (roll(spec.seed, 940) >= Math.min(1, Math.max(0, rate))) return [];

  const roof = massing.volumes.at(-1)!;
  const footprint = withPositiveArea(roof.footprint);
  const frame = roofFrame(footprint, pixelsPerMetre);
  if (frame === null) return [];

  const count = Math.min(3, 1 + Math.floor(roll(spec.seed, 941) * 2.6));
  const prisms: DetailPrism[] = [];
  for (let boxIndex = 0; boxIndex < count; boxIndex++) {
    const halfU = Math.min(0.5 + roll(spec.seed, 942 + boxIndex * 13) * 0.7, frame.extentU * 0.28);
    const halfV = Math.min(0.4 + roll(spec.seed, 943 + boxIndex * 13) * 0.6, frame.extentV * 0.28);
    if (halfU < 0.45 || halfV < 0.35) continue;
    const rangeU = Math.max(0, frame.extentU - halfU - 0.7);
    const rangeV = Math.max(0, frame.extentV - halfV - 0.7);
    for (let attempt = 0; attempt < 8; attempt++) {
      const salt = 944 + boxIndex * 13 + attempt * 31;
      const centreU = (roll(spec.seed, salt) * 2 - 1) * rangeU;
      const centreV = (roll(spec.seed, salt + 1) * 2 - 1) * rangeV;
      const corner = (su: number, sv: number): Vec2 => {
        const along = (centreU + su * halfU) * pixelsPerMetre;
        const across = (centreV + sv * halfV) * pixelsPerMetre;
        return {
          x: frame.centre.x + frame.ux * along - frame.uy * across,
          y: frame.centre.y + frame.uy * along + frame.ux * across
        };
      };
      const box = withPositiveArea([
        corner(-1, -1),
        corner(1, -1),
        corner(1, 1),
        corner(-1, 1)
      ]);
      if (!box.every((p) => pointInRing(p, footprint))) continue;
      prisms.push({
        footprint: box,
        baseHeight: roof.topHeight + 0.05,
        topHeight: roof.topHeight + 1.5 + roll(spec.seed, salt + 2) * 2.2,
        material: boxIndex % 2 === 0 && spec.neonEnabled !== false ? accent : spec.wallMaterial,
        seed: roll(spec.seed, salt + 3)
      });
      break;
    }
  }
  return prisms;
}

function prismsForBuilding(spec: BuildingSpec, pixelsPerMetre: number): DetailPrism[] {
  if (
    spec.height < BUILDING_DETAIL_MIN_HEIGHT_M ||
    spec.footprint.length < 3 ||
    pixelsPerMetre <= 0
  ) {
    return [];
  }

  const prisms: DetailPrism[] = [];
  const massing = describeBuildingMassing(spec, pixelsPerMetre);
  const accent = neonMaterial(spec, 901);
  const typology = resolveArchitecturalTypology(spec);

  // Facade & massing detail per volume
  for (let volumeIndex = 0; volumeIndex < massing.volumes.length; volumeIndex++) {
    const volume = massing.volumes[volumeIndex]!;
    const footprint = withPositiveArea(volume.footprint);
    const span = volume.topHeight - volume.baseHeight;
    if (span <= 1) continue;

    const isBaseVolume = volumeIndex === 0;

    for (let edgeIndex = 0; edgeIndex < footprint.length; edgeIndex++) {
      const a = footprint[edgeIndex]!;
      const b = footprint[(edgeIndex + 1) % footprint.length]!;
      const edgeLengthM = Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMetre;
      if (edgeLengthM < 2.2) continue;
      const edgeSalt = 1000 + volumeIndex * 101 + edgeIndex * 17;

      const addStrip = (
        start: number,
        end: number,
        insetM: number,
        outsetM: number,
        baseHeight: number,
        topHeight: number,
        material: number,
        salt: number
      ): void => {
        const strip = edgeStrip(a, b, start, end, insetM, outsetM, pixelsPerMetre);
        if (strip === null) return;
        prisms.push({
          footprint: strip,
          baseHeight,
          topHeight,
          material,
          seed: roll(spec.seed, salt)
        });
      };

      // 1. BASE READABILITY: Ground plinth & water table on base volume
      if (isBaseVolume) {
        addStrip(
          0.01,
          0.99,
          0.06,
          0.22,
          volume.baseHeight,
          volume.baseHeight + Math.min(1.2, span * 0.15),
          spec.roofMaterial,
          edgeSalt + 1
        );
      }

      // 2. CROWN / STORY READABILITY: Volume transition cornice & parapet capping
      addStrip(
        0.015,
        0.985,
        0.18,
        0.38,
        volume.topHeight - 0.28,
        volume.topHeight + 0.22,
        spec.roofMaterial,
        edgeSalt + 2
      );

      // Low parapet upstand
      const parapetInset = typology === "corporate" ? 0.35 : 0.25;
      const parapetHeight = typology === "corporate" ? 1.4 : 1.1;
      addStrip(
        0.03,
        0.97,
        parapetInset,
        0.08,
        volume.topHeight + 0.2,
        volume.topHeight + parapetHeight,
        spec.wallMaterial,
        edgeSalt + 3
      );

      // 3. BODY READABILITY: Typology-responsive facade articulation
      switch (typology) {
        case "market": {
          // Storefront canopy / awning projection at base
          if (isBaseVolume && edgeLengthM >= 4.0 && edgeIndex === 0) {
            addStrip(
              0.08,
              0.92,
              0.08,
              1.4,
              volume.baseHeight + 3.0,
              volume.baseHeight + 3.4,
              spec.roofMaterial,
              edgeSalt + 20
            );
            // Signage band above awning
            addStrip(
              0.12,
              0.88,
              0.06,
              0.32,
              volume.baseHeight + 3.6,
              volume.baseHeight + 4.8,
              spec.wallMaterial,
              edgeSalt + 21
            );
          }
          // Horizontal beltcourses
          if (span >= 16) {
            addStrip(
              0.02,
              0.98,
              0.08,
              0.28,
              volume.baseHeight + span * 0.5,
              volume.baseHeight + span * 0.5 + 0.35,
              spec.roofMaterial,
              edgeSalt + 22
            );
          }
          break;
        }

        case "corporate": {
          // Crisp spandrel bands & vertical structural fins
          const bandCount = Math.min(2, Math.max(1, Math.floor(span / 16)));
          for (let band = 0; band < bandCount; band++) {
            const t = (band + 1) / (bandCount + 1);
            const height = volume.baseHeight + span * t;
            addStrip(
              0.02,
              0.98,
              0.06,
              0.3,
              height - 0.18,
              height + 0.22,
              spec.roofMaterial,
              edgeSalt + 30 + band
            );
          }
          if (span >= 8 && edgeLengthM >= 4) {
            const finCount = Math.min(3, Math.max(1, Math.floor(edgeLengthM / 7)));
            const finWidthM = 0.45;
            const halfT = Math.min(0.06, finWidthM / edgeLengthM / 2);
            for (let fin = 0; fin < finCount; fin++) {
              const centreT = (fin + 0.5) / finCount;
              addStrip(
                centreT - halfT,
                centreT + halfT,
                0.08,
                0.45,
                volume.baseHeight + 2.0,
                volume.topHeight - 0.5,
                spec.wallMaterial,
                edgeSalt + 40 + fin
              );
            }
          }
          break;
        }

        case "civic": {
          // Monumental vertical pilaster columns & grand entablature
          if (span >= 6 && edgeLengthM >= 4) {
            const columnCount = Math.min(4, Math.max(2, Math.floor(edgeLengthM / 5)));
            const colWidthM = 0.55;
            const halfT = Math.min(0.08, colWidthM / edgeLengthM / 2);
            for (let col = 0; col < columnCount; col++) {
              const centreT = (col + 0.5) / columnCount;
              addStrip(
                centreT - halfT,
                centreT + halfT,
                0.1,
                0.55,
                volume.baseHeight + 1.2,
                volume.topHeight - 1.2,
                spec.wallMaterial,
                edgeSalt + 50 + col
              );
            }
          }
          // Classical entablature frieze below top cornice
          addStrip(
            0.02,
            0.98,
            0.12,
            0.42,
            volume.topHeight - 1.4,
            volume.topHeight - 0.4,
            spec.roofMaterial,
            edgeSalt + 60
          );
          break;
        }

        case "residential": {
          // Balcony projections on facade
          if (span >= 8 && edgeLengthM >= 4.5) {
            const balconyCount = Math.min(2, Math.max(1, Math.floor(span / 12)));
            for (let bIndex = 0; bIndex < balconyCount; bIndex++) {
              const bHeight = volume.baseHeight + (span * (bIndex + 1)) / (balconyCount + 1);
              // Balcony slab
              addStrip(
                0.15,
                0.85,
                0.1,
                0.95,
                bHeight,
                bHeight + 0.3,
                spec.roofMaterial,
                edgeSalt + 70 + bIndex
              );
              // Balcony guard rail
              addStrip(
                0.15,
                0.85,
                0.85,
                0.95,
                bHeight + 0.3,
                bHeight + 1.15,
                spec.wallMaterial,
                edgeSalt + 75 + bIndex
              );
            }
          }
          break;
        }

        case "industrial": {
          // Heavy buttress ribs and louvred band
          if (span >= 6 && edgeLengthM >= 4) {
            const ribCount = Math.min(3, Math.max(1, Math.floor(edgeLengthM / 6)));
            const halfT = Math.min(0.07, 0.5 / edgeLengthM / 2);
            for (let rib = 0; rib < ribCount; rib++) {
              const centreT = (rib + 0.5) / ribCount;
              addStrip(
                centreT - halfT,
                centreT + halfT,
                0.1,
                0.65,
                volume.baseHeight + 0.8,
                volume.topHeight - 0.6,
                spec.wallMaterial,
                edgeSalt + 80 + rib
              );
            }
          }
          // Heavy loading dock canopy on base volume
          if (isBaseVolume && edgeLengthM >= 5 && edgeIndex === 0) {
            addStrip(
              0.1,
              0.9,
              0.1,
              1.5,
              volume.baseHeight + 3.2,
              volume.baseHeight + 3.7,
              spec.roofMaterial,
              edgeSalt + 90
            );
          }
          break;
        }

        case "derelict": {
          // Asymmetrical makeshift scrap ledges & patched buttresses
          if (roll(spec.seed, edgeSalt + 95) < 0.6) {
            const startT = 0.15 + roll(spec.seed, edgeSalt + 96) * 0.3;
            const endT = Math.min(0.95, startT + 0.25 + roll(spec.seed, edgeSalt + 97) * 0.3);
            addStrip(
              startT,
              endT,
              0.05,
              0.75,
              volume.baseHeight + span * 0.4,
              volume.baseHeight + span * 0.4 + 0.4,
              spec.roofMaterial,
              edgeSalt + 98
            );
          }
          break;
        }

        case "standard":
        default: {
          if (span >= 18) {
            addStrip(
              0.025,
              0.975,
              0.08,
              0.32,
              volume.baseHeight + span * 0.5 - 0.18,
              volume.baseHeight + span * 0.5 + 0.24,
              spec.roofMaterial,
              edgeSalt + 100
            );
          }
          if (span >= 7 && edgeLengthM >= 4) {
            const finCount = Math.min(2, Math.max(1, Math.floor(edgeLengthM / 8)));
            const halfT = Math.min(0.06, 0.42 / edgeLengthM / 2);
            for (let fin = 0; fin < finCount; fin++) {
              const centreT = (fin + 0.5) / finCount;
              addStrip(
                centreT - halfT,
                centreT + halfT,
                0.08,
                0.5,
                volume.baseHeight + 2.4,
                volume.topHeight - 0.65,
                spec.wallMaterial,
                edgeSalt + 110 + fin
              );
            }
          }
          break;
        }
      }
    }
  }

  // Feature bay projection on base volume
  const featureVolume = massing.volumes[0]!;
  const featureFootprint = withPositiveArea(featureVolume.footprint);
  const candidates = featureFootprint
    .map((a, index) => {
      const b = featureFootprint[(index + 1) % featureFootprint.length]!;
      return { index, length: Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMetre };
    })
    .filter((edge) => edge.length >= 7)
    .sort((a, b) => b.length - a.length);

  if (
    (typology === "market" || typology === "corporate" || typology === "standard") &&
    candidates.length > 0 &&
    featureVolume.topHeight - featureVolume.baseHeight >= 12
  ) {
    const chosen = candidates[Math.min(candidates.length - 1, Math.floor(roll(spec.seed, 700) * 2))]!;
    const a = featureFootprint[chosen.index]!;
    const b = featureFootprint[(chosen.index + 1) % featureFootprint.length]!;
    const width = 0.32 + roll(spec.seed, 701) * 0.24;
    const centre = 0.28 + roll(spec.seed, 702) * 0.44;
    const bay = edgeStrip(
      a,
      b,
      Math.max(0.04, centre - width / 2),
      Math.min(0.96, centre + width / 2),
      0.08,
      0.9 + roll(spec.seed, 703) * 0.8,
      pixelsPerMetre
    );
    if (bay !== null) {
      prisms.push({
        footprint: bay,
        baseHeight: featureVolume.baseHeight + Math.min(3.5, spec.height * 0.12),
        topHeight: featureVolume.baseHeight +
          (featureVolume.topHeight - featureVolume.baseHeight) * (0.68 + roll(spec.seed, 704) * 0.2),
        material: spec.roofMaterial,
        seed: roll(spec.seed, 705)
      });
    }
  }

  // 4. FUNCTIONALLY ZONED ROOFS on the top volume
  const roof = massing.volumes.at(-1)!;
  const roofFootprint = withPositiveArea(roof.footprint);

  switch (typology) {
    case "corporate":
      prisms.push(...generateCorporateCrown(roof, roofFootprint, pixelsPerMetre, spec, accent));
      break;
    case "residential":
      prisms.push(...generateResidentialRoof(roof, roofFootprint, pixelsPerMetre, spec));
      break;
    case "industrial":
      prisms.push(...generateIndustrialRoof(roof, roofFootprint, pixelsPerMetre, spec));
      break;
    case "market":
      prisms.push(...generateMarketRoof(roof, roofFootprint, pixelsPerMetre, spec, accent));
      break;
    case "civic":
      prisms.push(...generateCivicRoof(roof, roofFootprint, pixelsPerMetre, spec));
      break;
    case "derelict":
      prisms.push(...generateDerelictRoof(roof, roofFootprint, pixelsPerMetre, spec));
      break;
    case "standard":
    default: {
      const deck = containedRoofBox(roofFootprint, pixelsPerMetre, spec.seed, 800);
      if (deck !== null && roll(spec.seed, 829) >= 0.18) {
        const deckTop = roof.topHeight + 0.38;
        const penthouseTop = deckTop + 3.2 + roll(spec.seed, 830) * 4.2;
        const penthouse = scaledRing(deck, 0.66);
        prisms.push(
          {
            footprint: deck,
            baseHeight: roof.topHeight + 0.04,
            topHeight: deckTop,
            material: spec.roofMaterial,
            seed: roll(spec.seed, 831)
          },
          {
            footprint: penthouse,
            baseHeight: deckTop,
            topHeight: penthouseTop,
            material: spec.wallMaterial,
            seed: roll(spec.seed, 832)
          }
        );
        if (roll(spec.seed, 833) < 0.48) {
          prisms.push({
            footprint: scaledRing(deck, 0.12),
            baseHeight: penthouseTop,
            topHeight: penthouseTop + 2.5 + roll(spec.seed, 834) * 3.5,
            material: spec.neonEnabled === false ? spec.roofMaterial : accent,
            seed: roll(spec.seed, 835)
          });
        }
      }
      break;
    }
  }

  // Controlled rooftop illuminated feature on market / standard when neonEnabled
  if (typology === "market" || typology === "standard") {
    const roofEdges = roofFootprint
      .map((a, index) => {
        const b = roofFootprint[(index + 1) % roofFootprint.length]!;
        return { index, length: Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMetre };
      })
      .filter((edge) => edge.length >= 4)
      .sort((a, b) => b.length - a.length);

    if (roofEdges.length > 0 && roll(spec.seed, 849) < 0.35 && spec.neonEnabled !== false) {
      const edge = roofEdges[0]!;
      const a = roofFootprint[edge.index]!;
      const b = roofFootprint[(edge.index + 1) % roofFootprint.length]!;
      const strip = edgeStrip(a, b, 0.2, 0.8, 0.06, 0.16, pixelsPerMetre);
      if (strip !== null) {
        prisms.push({
          footprint: strip,
          baseHeight: roof.topHeight + 1.24,
          topHeight: roof.topHeight + 1.52,
          material: accent,
          seed: roll(spec.seed, 851)
        });
      }
    }
  }

  // 5. Rooftop utility prisms
  prisms.push(...utilityPrisms(spec, massing, pixelsPerMetre, accent));
  return prisms;
}

export function prismMesh(prism: DetailPrism): MeshBuffers {
  const footprint = withPositiveArea(prism.footprint);
  const cap = triangulate([footprint]);
  const frame = roofFrame(footprint, 1);
  const builder = new MeshBuilder(footprint.length * 5, footprint.length * 3 - 2);
  const capBase = builder.vertexCount;
  for (const p of cap.positions) {
    const dx = frame === null ? 0 : p.x - frame.centre.x;
    const dy = frame === null ? 0 : p.y - frame.centre.y;
    const u = frame === null || frame.extentU <= 0
      ? 0
      : (dx * frame.ux + dy * frame.uy) / frame.extentU;
    const v = frame === null || frame.extentV <= 0
      ? 0
      : (-dx * frame.uy + dy * frame.ux) / frame.extentV;
    builder.vertex(
      p.x,
      p.y,
      prism.topHeight,
      prism.material,
      -1,
      KIND.DETAIL,
      u,
      v,
      prism.seed
    );
  }
  for (let i = 0; i < cap.indices.length; i += 3) {
    builder.triangle(
      capBase + cap.indices[i]!,
      capBase + cap.indices[i + 1]!,
      capBase + cap.indices[i + 2]!
    );
  }

  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!;
    const b = footprint[(i + 1) % footprint.length]!;
    const shade = wallShade(a, b);
    const wall = builder.vertexCount;
    builder.vertex(a.x, a.y, prism.baseHeight, prism.material, shade, KIND.DETAIL, 0, 0, prism.seed);
    builder.vertex(b.x, b.y, prism.baseHeight, prism.material, shade, KIND.DETAIL, 1, 0, prism.seed);
    builder.vertex(b.x, b.y, prism.topHeight, prism.material, shade, KIND.DETAIL, 1, 1, prism.seed);
    builder.vertex(a.x, a.y, prism.topHeight, prism.material, shade, KIND.DETAIL, 0, 1, prism.seed);
    builder.triangle(wall, wall + 1, wall + 2);
    builder.triangle(wall, wall + 2, wall + 3);
  }
  return builder.build();
}

export function buildingDetailMesh(
  buildings: BuildingSpec[],
  pixelsPerMetre: number
): MeshBuffers {
  return mergeMeshes(
    buildings.flatMap((spec) => prismsForBuilding(spec, pixelsPerMetre)).map(prismMesh)
  );
}
