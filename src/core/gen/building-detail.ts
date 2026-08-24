import {
  describeBuildingMassing,
  supportsRoofStructures,
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

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
};

/**
 * Deterministic unit roll on the v2 rooftop namespace. Every family owns its own path so
 * these streams never alias existing numeric salts or each other; geometry decisions use
 * `geo/...` slots and appearance (materials, accents) uses `mat/...` slots.
 */
const rooftopRoll = (spec: BuildingSpec, family: string, slot: string): number =>
  fnv1a(`${Math.round(spec.seed * 0x3fffffff)}/rooftops/v2/${family}/${slot}`) / 0x100000000;

/** District material for a slot in the building's own bank (planting, contrast roofs...). */
const bankSlotMaterial = (spec: BuildingSpec, slot: number): number =>
  Math.floor(spec.wallMaterial / BANK_SIZE) * BANK_SIZE + slot;

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

// ---------------------------------------------------------------------------
// v2 rooftop feature families (CRITIQUE #7).
//
// One prism-only vocabulary of rooftop sets, selected per architectural typology so
// corporate roofs stay clean, residential roofs cluttered-small, industrial heavy,
// market chaotic and derelict improvised. Every family draws randomness from its own
// `rooftops/v2/<family>` namespace (never the legacy numeric salts) and every footprint
// is corner-checked against the deck, so determinism and containment hold by construction.
// ---------------------------------------------------------------------------

type RoofFamilyId =
  | "access"
  | "antenna"
  | "billboard"
  | "garden"
  | "generator"
  | "hvac"
  | "pad"
  | "satdish"
  | "skylight"
  | "stacks"
  | "tank"
  | "vents";

interface RoofContext {
  spec: BuildingSpec;
  accent: number;
  pixelsPerMetre: number;
  roof: BuildingVolume;
  footprint: Ring;
  frame: RoofFrame;
}

interface RoofRect {
  centreU: number;
  centreV: number;
  halfU: number;
  halfV: number;
}

/** Families low enough to also serve as rate-gated utility-tier extras (≤5 m above deck). */
const LOW_PROFILE_FAMILIES: Readonly<Partial<Record<RoofFamilyId, true>>> = {
  access: true,
  hvac: true,
  satdish: true,
  skylight: true,
  vents: true
};

/**
 * Candidate menu per typology. Kept sorted by id so hashing never depends on authoring
 * order; "standard" deliberately stays empty — the legacy bounded utility boxes remain
 * its generic fallback look.
 */
const ROOFTOP_FAMILY_PLAN: Readonly<Record<ArchitecturalTypology, readonly RoofFamilyId[]>> = {
  corporate: ["access", "antenna", "garden", "hvac", "pad", "satdish"],
  residential: ["access", "garden", "hvac", "tank", "vents"],
  industrial: ["generator", "hvac", "skylight", "stacks", "tank"],
  market: ["access", "billboard", "generator", "hvac", "satdish", "skylight"],
  civic: ["antenna", "garden", "satdish"],
  derelict: ["antenna", "stacks", "tank", "vents"],
  standard: []
};

const framePoint = (frame: RoofFrame, uM: number, vM: number, pixelsPerMetre: number): Vec2 => {
  const along = uM * pixelsPerMetre;
  const across = vM * pixelsPerMetre;
  return {
    x: frame.centre.x + frame.ux * along - frame.uy * across,
    y: frame.centre.y + frame.uy * along + frame.ux * across
  };
};

function localBoxRing(
  ctx: RoofContext,
  centreU: number,
  centreV: number,
  halfU: number,
  halfV: number
): Ring | null {
  if (halfU <= 0 || halfV <= 0) return null;
  const corner = (su: number, sv: number): Vec2 =>
    framePoint(ctx.frame, centreU + su * halfU, centreV + sv * halfV, ctx.pixelsPerMetre);
  const box = withPositiveArea([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  if (box.length !== 4) return null;
  return box.every((p) => pointInRing(p, ctx.footprint)) ? box : null;
}

/** Angled variant used for satellite dishes; same containment contract. */
function rotatedBoxRing(
  ctx: RoofContext,
  centreU: number,
  centreV: number,
  halfU: number,
  halfV: number,
  angle: number
): Ring | null {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corner = (su: number, sv: number): Vec2 =>
    framePoint(
      ctx.frame,
      centreU + su * halfU * cos - sv * halfV * sin,
      centreV + su * halfU * sin + sv * halfV * cos,
      ctx.pixelsPerMetre
    );
  const box = withPositiveArea([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  if (box.length !== 4) return null;
  return box.every((p) => pointInRing(p, ctx.footprint)) ? box : null;
}

/** Rolls a contained spot for one unit, optionally keeping clear of already-placed ones. */
function placeRoofUnit(
  ctx: RoofContext,
  family: string,
  unitKey: string | number,
  halfU: number,
  halfV: number,
  attempts = 6,
  avoid: readonly RoofRect[] = [],
  gap = 0.5
): RoofRect | null {
  if (halfU < 0.16 || halfV < 0.16) return null;
  const rangeU = Math.max(0, ctx.frame.extentU - halfU - 0.7);
  const rangeV = Math.max(0, ctx.frame.extentV - halfV - 0.7);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rect: RoofRect = {
      centreU: (rooftopRoll(ctx.spec, family, `geo/u/${unitKey}/${attempt}`) * 2 - 1) * rangeU,
      centreV: (rooftopRoll(ctx.spec, family, `geo/v/${unitKey}/${attempt}`) * 2 - 1) * rangeV,
      halfU,
      halfV
    };
    if (
      localBoxRing(ctx, rect.centreU, rect.centreV, halfU, halfV) !== null &&
      avoid.every(
        (other) =>
          Math.abs(other.centreU - rect.centreU) >= other.halfU + halfU + gap ||
          Math.abs(other.centreV - rect.centreV) >= other.halfV + halfV + gap
      )
    ) {
      return rect;
    }
  }
  return null;
}

/** Snaps a unit against the parapet on one deterministic edge (bulkheads hug the rim). */
function placeNearParapet(
  ctx: RoofContext,
  family: string,
  halfU: number,
  halfV: number
): RoofRect | null {
  const edge = Math.min(3, Math.floor(rooftopRoll(ctx.spec, family, "geo/edge") * 4));
  const t = rooftopRoll(ctx.spec, family, "geo/t") * 2 - 1;
  const insetU = Math.max(0, ctx.frame.extentU - halfU - 0.9);
  const insetV = Math.max(0, ctx.frame.extentV - halfV - 0.9);
  const candidates: RoofRect[] = [
    { centreU: t * insetU, centreV: insetV, halfU, halfV },
    { centreU: t * insetU, centreV: -insetV, halfU, halfV },
    { centreU: insetU, centreV: t * insetV, halfU, halfV },
    { centreU: -insetU, centreV: t * insetV, halfU, halfV }
  ];
  const candidate = candidates[edge]!;
  return localBoxRing(ctx, candidate.centreU, candidate.centreV, halfU, halfV) !== null
    ? candidate
    : null;
}

const addPrism = (
  prisms: DetailPrism[],
  ctx: RoofContext,
  ring: Ring,
  baseOffsetM: number,
  heightM: number,
  material: number,
  seedSlot: string
): void => {
  prisms.push({
    footprint: ring,
    baseHeight: ctx.roof.topHeight + baseOffsetM,
    topHeight: ctx.roof.topHeight + baseOffsetM + heightM,
    material,
    seed: rooftopRoll(ctx.spec, "seed", seedSlot)
  });
};

/** Rows of 2-6 low AC/chiller boxes in a spaced grid, some carrying fan cubes. */
function hvacBankFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const count = 2 + Math.floor(rooftopRoll(ctx.spec, "hvac", "geo/count") * 4.99);
  const cols = Math.min(count, 3);
  const rows = Math.ceil(count / cols);
  const unitU = 0.85 + rooftopRoll(ctx.spec, "hvac", "geo/unit-u") * 0.5;
  const unitV = 0.7 + rooftopRoll(ctx.spec, "hvac", "geo/unit-v") * 0.45;
  const gap = 0.55;
  const anchor = placeRoofUnit(
    ctx,
    "hvac",
    "bank",
    (cols * unitU * 2 + (cols - 1) * gap) / 2,
    (rows * unitV * 2 + (rows - 1) * gap) / 2,
    8
  );
  if (anchor === null) return prisms;
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cu = anchor.centreU + (col - (cols - 1) / 2) * (unitU * 2 + gap);
    const cv = anchor.centreV + (row - (rows - 1) / 2) * (unitV * 2 + gap);
    const ring = localBoxRing(ctx, cu, cv, unitU, unitV);
    if (ring === null) continue;
    const height = 0.9 + rooftopRoll(ctx.spec, "hvac", `geo/h/${i}`) * 1.0;
    addPrism(prisms, ctx, ring, 0.04, height, ctx.spec.roofMaterial, `hvac/unit/${i}`);
    if (rooftopRoll(ctx.spec, "hvac", `mat/fan/${i}`) < 0.45) {
      addPrism(
        prisms,
        ctx,
        scaledRing(ring, 0.52),
        0.04 + height,
        0.45 + rooftopRoll(ctx.spec, "hvac", `geo/fan/${i}`) * 0.35,
        ctx.spec.wallMaterial,
        `hvac/fan/${i}`
      );
    }
  }
  return prisms;
}

/** Loose ring/grid of 3-8 small vent stacks around a cluster centre. */
function ventClusterFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const count = 3 + Math.floor(rooftopRoll(ctx.spec, "vents", "geo/count") * 5.99);
  const radiusU = 1.1 + rooftopRoll(ctx.spec, "vents", "geo/radius-u") * 1.3;
  const radiusV = 1.1 + rooftopRoll(ctx.spec, "vents", "geo/radius-v") * 1.3;
  const anchor = placeRoofUnit(ctx, "vents", "cluster", radiusU, radiusV, 8);
  if (anchor === null) return prisms;
  const twist = rooftopRoll(ctx.spec, "vents", "geo/twist") * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const angle = twist + (i / count) * Math.PI * 2;
    const pull = 0.3 + rooftopRoll(ctx.spec, "vents", `geo/pull/${i}`) * 0.7;
    const half = 0.2 + rooftopRoll(ctx.spec, "vents", `geo/size/${i}`) * 0.2;
    const ring = localBoxRing(
      ctx,
      anchor.centreU + Math.cos(angle) * radiusU * pull,
      anchor.centreV + Math.sin(angle) * radiusV * pull,
      half,
      half
    );
    if (ring === null) continue;
    const core = i % 3 === 0;
    const height = core
      ? 1.0 + rooftopRoll(ctx.spec, "vents", `geo/h/${i}`) * 0.8
      : 0.45 + rooftopRoll(ctx.spec, "vents", `geo/h/${i}`) * 0.6;
    addPrism(prisms, ctx, ring, 0.04, height, ctx.spec.wallMaterial, `vents/${i}`);
  }
  return prisms;
}

/** 1-3 tall thin exhaust flues on collars; improvised scrap variants when derelict. */
function exhaustStackFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const count = 1 + Math.floor(rooftopRoll(ctx.spec, "stacks", "geo/count") * 2.99);
  const improvised = resolveArchitecturalTypology(ctx.spec) === "derelict";
  for (let i = 0; i < count; i++) {
    const half = 0.3 + rooftopRoll(ctx.spec, "stacks", `geo/size/${i}`) * 0.24;
    const spot = placeRoofUnit(ctx, "stacks", i, half * 1.9, half * 1.9, 7);
    if (spot === null) continue;
    const collar = localBoxRing(ctx, spot.centreU, spot.centreV, half * 1.9, half * 1.9);
    if (collar !== null) {
      addPrism(
        prisms,
        ctx,
        collar,
        0.04,
        0.7,
        improvised && i % 2 === 1 ? ctx.spec.roofMaterial : ctx.spec.wallMaterial,
        `stacks/collar/${i}`
      );
    }
    const flue = localBoxRing(ctx, spot.centreU, spot.centreV, half, half);
    if (flue !== null) {
      const height =
        (improvised ? 3.2 : 4.2) + rooftopRoll(ctx.spec, "stacks", `geo/h/${i}`) * (improvised ? 2.6 : 4.0);
      addPrism(
        prisms,
        ctx,
        flue,
        0.74,
        height,
        improvised && i % 2 === 0 ? ctx.spec.roofMaterial : ctx.spec.wallMaterial,
        `stacks/flue/${i}`
      );
    }
  }
  return prisms;
}

/** Medium genset box paired with a low wide fuel tank and a thin exhaust pipe. */
function generatorSetFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const tankHalfU = 2.0 + rooftopRoll(ctx.spec, "generator", "geo/tank-u") * 1.0;
  const tankHalfV = 0.75 + rooftopRoll(ctx.spec, "generator", "geo/tank-v") * 0.35;
  const tank = placeRoofUnit(ctx, "generator", "tank", tankHalfU, tankHalfV, 8);
  if (tank === null) return prisms;
  const tankRing = localBoxRing(ctx, tank.centreU, tank.centreV, tank.halfU, tank.halfV);
  if (tankRing !== null) {
    addPrism(
      prisms,
      ctx,
      tankRing,
      0.04,
      0.75 + rooftopRoll(ctx.spec, "generator", "geo/tank-h") * 0.35,
      ctx.spec.roofMaterial,
      "generator/tank"
    );
  }
  const genset = placeRoofUnit(
    ctx,
    "generator",
    "genset",
    1.4 + rooftopRoll(ctx.spec, "generator", "geo/gen-u") * 0.6,
    0.95 + rooftopRoll(ctx.spec, "generator", "geo/gen-v") * 0.4,
    8,
    [tank],
    0.6
  );
  if (genset === null) return prisms;
  const genHeight = 1.6 + rooftopRoll(ctx.spec, "generator", "geo/gen-h") * 0.6;
  const genRing = localBoxRing(ctx, genset.centreU, genset.centreV, genset.halfU, genset.halfV);
  if (genRing === null) return prisms;
  addPrism(prisms, ctx, genRing, 0.04, genHeight, ctx.spec.wallMaterial, "generator/genset");
  const pipe = localBoxRing(
    ctx,
    genset.centreU + genset.halfU * 0.55,
    genset.centreV - genset.halfV * 0.55,
    0.15,
    0.15
  );
  if (pipe !== null) {
    addPrism(
      prisms,
      ctx,
      pipe,
      0.04 + genHeight,
      1.1 + rooftopRoll(ctx.spec, "generator", "geo/pipe-h") * 0.7,
      ctx.spec.roofMaterial,
      "generator/pipe"
    );
  }
  return prisms;
}

/** Ground-cluster squat tanks with lids (the stilted variant lives in the residential roof). */
function tankClusterFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const count = 2 + Math.floor(rooftopRoll(ctx.spec, "tank", "geo/count") * 1.99);
  const improvised = resolveArchitecturalTypology(ctx.spec) === "derelict";
  const placed: RoofRect[] = [];
  for (let i = 0; i < count; i++) {
    const half = 1.05 + rooftopRoll(ctx.spec, "tank", `geo/size/${i}`) * 0.7;
    const spot = placeRoofUnit(ctx, "tank", i, half, half, 7, placed, 0.55);
    if (spot === null) continue;
    const ring = localBoxRing(ctx, spot.centreU, spot.centreV, half, half);
    if (ring === null) continue;
    placed.push(spot);
    const height = 1.25 + rooftopRoll(ctx.spec, "tank", `geo/h/${i}`) * 0.9;
    const barrelMaterial = improvised && i % 2 === 1 ? ctx.spec.roofMaterial : ctx.spec.wallMaterial;
    addPrism(prisms, ctx, ring, 0.04, height, barrelMaterial, `tank/barrel/${i}`);
    addPrism(
      prisms,
      ctx,
      scaledRing(ring, 0.84),
      0.04 + height,
      0.22,
      barrelMaterial === ctx.spec.wallMaterial ? ctx.spec.roofMaterial : ctx.spec.wallMaterial,
      `tank/lid/${i}`
    );
  }
  return prisms;
}

/** 2-5 thin masts of varying height clustered near an anchor, rare beacon on the tallest. */
function antennaClusterFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const count = 2 + Math.floor(rooftopRoll(ctx.spec, "antenna", "geo/count") * 3.99);
  const anchor = placeRoofUnit(ctx, "antenna", "anchor", 1.1, 1.1, 8);
  if (anchor === null) return prisms;
  const baseRing = localBoxRing(ctx, anchor.centreU, anchor.centreV, 0.6, 0.6);
  if (baseRing !== null) {
    addPrism(prisms, ctx, baseRing, 0.04, 0.9, ctx.spec.wallMaterial, "antenna/base");
  }
  let tallestHeight = 0;
  let tallestCu = 0;
  let tallestCv = 0;
  let hasMast = false;
  for (let i = 0; i < count; i++) {
    const cu = anchor.centreU + (rooftopRoll(ctx.spec, "antenna", `geo/off-u/${i}`) * 2 - 1);
    const cv = anchor.centreV + (rooftopRoll(ctx.spec, "antenna", `geo/off-v/${i}`) * 2 - 1);
    const half = 0.08 + rooftopRoll(ctx.spec, "antenna", `geo/size/${i}`) * 0.1;
    const ring = localBoxRing(ctx, cu, cv, half, half);
    if (ring === null) continue;
    const height = 2.4 + rooftopRoll(ctx.spec, "antenna", `geo/h/${i}`) * 4.4;
    addPrism(prisms, ctx, ring, 0.04, height, ctx.spec.roofMaterial, `antenna/mast/${i}`);
    if (height > tallestHeight) {
      tallestHeight = height;
      tallestCu = cu;
      tallestCv = cv;
      hasMast = true;
    }
  }
  if (hasMast && ctx.spec.neonEnabled !== false && rooftopRoll(ctx.spec, "antenna", "mat/beacon") < 0.35) {
    const beacon = localBoxRing(ctx, tallestCu, tallestCv, 0.07, 0.07);
    if (beacon !== null) {
      addPrism(prisms, ctx, beacon, 0.04 + tallestHeight, 0.28, ctx.accent, "antenna/beacon");
    }
  }
  return prisms;
}

/** Pedestalled dish aimed at a deterministic angle, with feed arm. */
function satelliteDishFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const pad = placeRoofUnit(ctx, "satdish", "pad", 1.05, 1.05, 8);
  if (pad === null) return prisms;
  const pedestal = localBoxRing(ctx, pad.centreU, pad.centreV, 0.55, 0.55);
  if (pedestal === null) return prisms;
  addPrism(prisms, ctx, pedestal, 0.04, 0.5, ctx.spec.wallMaterial, "satdish/pedestal");
  const angle = rooftopRoll(ctx.spec, "satdish", "geo/tilt") * Math.PI;
  const half = 0.65 + rooftopRoll(ctx.spec, "satdish", "geo/size") * 0.3;
  const ring =
    rotatedBoxRing(
      ctx,
      pad.centreU + Math.cos(angle) * 0.28,
      pad.centreV + Math.sin(angle) * 0.28,
      half,
      half * 0.72,
      angle
    ) ?? localBoxRing(ctx, pad.centreU, pad.centreV, half, half * 0.72);
  if (ring === null) return prisms;
  const dishHeight = 0.45 + rooftopRoll(ctx.spec, "satdish", "geo/dish-h") * 0.3;
  addPrism(prisms, ctx, ring, 0.54, dishHeight, ctx.spec.roofMaterial, "satdish/dish");
  const arm = localBoxRing(ctx, pad.centreU, pad.centreV, 0.12, 0.12);
  if (arm !== null) {
    addPrism(prisms, ctx, arm, 0.54 + dishHeight, 0.3, ctx.spec.wallMaterial, "satdish/arm");
  }
  return prisms;
}

/** Long low glazed ridges running across the deck (market sheds, industrial sawtooth kin). */
function skylightRunFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const ridges = 1 + Math.floor(rooftopRoll(ctx.spec, "skylight", "geo/count") * 2.99);
  const lenHalf = Math.min(ctx.frame.extentU * 0.36, 2.4 + rooftopRoll(ctx.spec, "skylight", "geo/len") * 2.4);
  const depthHalf = Math.min(1.0, ctx.frame.extentV / (ridges * 2.4));
  if (lenHalf < 0.8 || depthHalf < 0.35) return prisms;
  for (let r = 0; r < ridges; r++) {
    const cv = (r - (ridges - 1) / 2) * ((ctx.frame.extentV * 0.66) / Math.max(1, ridges));
    const cu = (rooftopRoll(ctx.spec, "skylight", `geo/off/${r}`) * 2 - 1) *
      Math.max(0, ctx.frame.extentU - lenHalf - 1.0);
    const ring = localBoxRing(ctx, cu, cv, lenHalf, depthHalf);
    if (ring === null) continue;
    addPrism(
      prisms,
      ctx,
      ring,
      0.04,
      0.38 + rooftopRoll(ctx.spec, "skylight", `geo/h/${r}`) * 0.3,
      ctx.spec.wallMaterial,
      `skylight/${r}`
    );
  }
  return prisms;
}

/** Stairwell/elevator bulkhead hugging the parapet, occasional roof vent on top. */
function accessBulkheadFamily(ctx: RoofContext): DetailPrism[] {
  const prisms: DetailPrism[] = [];
  const spot = placeNearParapet(
    ctx,
    "access",
    1.25 + rooftopRoll(ctx.spec, "access", "geo/hu") * 0.6,
    1.0 + rooftopRoll(ctx.spec, "access", "geo/hv") * 0.5
  );
  if (spot === null) return prisms;
  const ring = localBoxRing(ctx, spot.centreU, spot.centreV, spot.halfU, spot.halfV);
  if (ring === null) return prisms;
  const height = 2.2 + rooftopRoll(ctx.spec, "access", "geo/h") * 0.6;
  addPrism(prisms, ctx, ring, 0.04, height, ctx.spec.wallMaterial, "access/bulkhead");
  if (rooftopRoll(ctx.spec, "access", "geo/vent") < 0.5) {
    addPrism(
      prisms,
      ctx,
      scaledRing(ring, 0.42),
      0.04 + height,
      0.5,
      ctx.spec.roofMaterial,
      "access/vent"
    );
  }
  return prisms;
}

/** Rare flat landing pad with contrast markings; big towers only, never glowing. */
function landingPadFamily(ctx: RoofContext): DetailPrism[] {
  if (Math.min(ctx.frame.extentU, ctx.frame.extentV) < 11) return [];
  if (ctx.spec.height < 70) return [];
  if (rooftopRoll(ctx.spec, "pad", "geo/on") >= 0.25) return [];
  const padRing = centeredRoofBox(ctx.footprint, ctx.pixelsPerMetre, 4.4, 4.4);
  if (padRing === null) return [];
  const prisms: DetailPrism[] = [];
  addPrism(prisms, ctx, padRing, 0.03, 0.26, ctx.spec.roofMaterial, "pad/deck");
  addPrism(prisms, ctx, scaledRing(padRing, 0.78), 0.31, 0.07, ctx.spec.wallMaterial, "pad/mark");
  const stripe = localBoxRing(ctx, 0, 0, 1.6, 0.22);
  if (stripe !== null) {
    addPrism(prisms, ctx, stripe, 0.4, 0.06, ctx.spec.wallMaterial, "pad/stripe");
  }
  return prisms;
}

/** Low planter beds in the district's planting slot (ROOF_C), shrubs included. */
function roofGardenFamily(ctx: RoofContext): DetailPrism[] {
  if (rooftopRoll(ctx.spec, "garden", "geo/on") >
    (resolveArchitecturalTypology(ctx.spec) === "civic" ? 0.55 : 0.4)
  ) {
    return [];
  }
  const planting = bankSlotMaterial(ctx.spec, DISTRICT_SLOT.ROOF_C);
  const prisms: DetailPrism[] = [];
  const beds = 1 + Math.floor(rooftopRoll(ctx.spec, "garden", "geo/beds") * 2.99);
  const placed: RoofRect[] = [];
  for (let i = 0; i < beds; i++) {
    const spot = placeRoofUnit(
      ctx,
      "garden",
      i,
      1.1 + rooftopRoll(ctx.spec, "garden", `geo/u/${i}`) * 1.2,
      0.7 + rooftopRoll(ctx.spec, "garden", `geo/v/${i}`) * 0.6,
      7,
      placed,
      0.7
    );
    if (spot === null) continue;
    const ring = localBoxRing(ctx, spot.centreU, spot.centreV, spot.halfU, spot.halfV);
    if (ring === null) continue;
    placed.push(spot);
    addPrism(prisms, ctx, ring, 0.04, 0.32, planting, `garden/bed/${i}`);
    if (rooftopRoll(ctx.spec, "garden", `geo/shrub/${i}`) < 0.6) {
      addPrism(prisms, ctx, scaledRing(ring, 0.4), 0.36, 0.28, planting, `garden/shrub/${i}`);
    }
  }
  return prisms;
}

/** Post-supported billboard rig — the second market sign style beside the wall-mounted one. */
function billboardFrameFamily(ctx: RoofContext): DetailPrism[] {
  const spanHalf = 2.4 + rooftopRoll(ctx.spec, "billboard", "geo/span") * 1.2;
  const spot = placeRoofUnit(ctx, "billboard", "rig", spanHalf + 0.5, 1.3, 8);
  if (spot === null) return [];
  const leftPost = localBoxRing(ctx, spot.centreU - spanHalf * 0.8, spot.centreV, 0.22, 0.22);
  const rightPost = localBoxRing(ctx, spot.centreU + spanHalf * 0.8, spot.centreV, 0.22, 0.22);
  if (leftPost === null || rightPost === null) return [];
  const prisms: DetailPrism[] = [];
  const postHeight = 2.4 + rooftopRoll(ctx.spec, "billboard", "geo/post-h") * 1.6;
  addPrism(prisms, ctx, leftPost, 0.04, postHeight, ctx.spec.roofMaterial, "billboard/post-l");
  addPrism(prisms, ctx, rightPost, 0.04, postHeight, ctx.spec.roofMaterial, "billboard/post-r");
  const panelHalfV = 0.32 + rooftopRoll(ctx.spec, "billboard", "geo/panel-v") * 0.18;
  const panel = localBoxRing(ctx, spot.centreU, spot.centreV, spanHalf, panelHalfV);
  if (panel === null) return prisms;
  const panelHeight = 1.0 + rooftopRoll(ctx.spec, "billboard", "geo/panel-h") * 0.6;
  addPrism(prisms, ctx, panel, 0.04 + postHeight, panelHeight, ctx.spec.wallMaterial, "billboard/panel");
  if (ctx.spec.neonEnabled !== false) {
    addPrism(
      prisms,
      ctx,
      scaledRing(panel, 1.14),
      0.04 + postHeight + panelHeight - 0.3,
      0.3,
      ctx.accent,
      "billboard/border"
    );
  }
  return prisms;
}

const FAMILY_BUILDERS: Readonly<Record<RoofFamilyId, (ctx: RoofContext) => DetailPrism[]>> = {
  access: accessBulkheadFamily,
  antenna: antennaClusterFamily,
  billboard: billboardFrameFamily,
  garden: roofGardenFamily,
  generator: generatorSetFamily,
  hvac: hvacBankFamily,
  pad: landingPadFamily,
  satdish: satelliteDishFamily,
  skylight: skylightRunFamily,
  stacks: exhaustStackFamily,
  tank: tankClusterFamily,
  vents: ventClusterFamily
};

/** How many always-on sets a typology ships with: clean corporate, crowded residential... */
function familyPickCount(typology: ArchitecturalTypology, spec: BuildingSpec): number {
  switch (typology) {
    case "corporate":
      return rooftopRoll(spec, "plan", "count/corporate") < 0.62 ? 1 : 0;
    case "residential":
      return 1 + (rooftopRoll(spec, "plan", "count/residential") < 0.5 ? 1 : 0);
    case "industrial":
      return 2;
    case "market":
      return 1 + (rooftopRoll(spec, "plan", "count/market") < 0.55 ? 1 : 0);
    case "civic":
      return rooftopRoll(spec, "plan", "count/civic") < 0.7 ? 1 : 0;
    case "derelict":
      return 1 + (rooftopRoll(spec, "plan", "count/derelict") < 0.35 ? 1 : 0);
    default:
      return 0;
  }
}

/** Draws `count` distinct ids from an already-sorted pool without replacement. */
function pickFamilies(spec: BuildingSpec, menu: readonly RoofFamilyId[], count: number): RoofFamilyId[] {
  const pool = [...menu].sort();
  const picked: RoofFamilyId[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const rollValue = rooftopRoll(spec, "plan", `pick/${pool.length}/${i}`);
    picked.push(pool.splice(Math.min(pool.length - 1, Math.floor(rollValue * pool.length)), 1)[0]!);
  }
  return picked;
}

/**
 * The v2 variety stream: typology-aware rooftop sets, plus one extra low-profile set
 * bought by the grammar's rooftop-utility rate. Appended after every existing stream so
 * legacy draw order is untouched.
 */
function rooftopFamilyLayer(
  spec: BuildingSpec,
  massing: BuildingMassing,
  pixelsPerMetre: number,
  accent: number
): DetailPrism[] {
  const roof = massing.volumes.at(-1)!;
  const footprint = withPositiveArea(roof.footprint);
  // WHY: extrude flags non-rectangular decks as structure-free (negative ROOF shade);
  // keep painted and physical rooftops in agreement by honouring that flag here too.
  if (!supportsRoofStructures(footprint)) return [];
  const frame = roofFrame(footprint, pixelsPerMetre);
  if (frame === null) return [];

  const typology = resolveArchitecturalTypology(spec);
  const menu = ROOFTOP_FAMILY_PLAN[typology];
  if (menu.length === 0) return [];

  const ctx: RoofContext = { spec, accent, pixelsPerMetre, roof, footprint, frame };
  const prisms: DetailPrism[] = [];
  const runFamily = (family: RoofFamilyId): void => {
    prisms.push(...FAMILY_BUILDERS[family](ctx));
  };

  const used = pickFamilies(spec, menu, familyPickCount(typology, spec));
  for (const family of used) runFamily(family);

  const rate = spec.rooftopUtilityRate;
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0 &&
    rooftopRoll(spec, "gate", "bonus") < Math.min(1, rate)
  ) {
    const remaining = menu.filter(
      (family) => LOW_PROFILE_FAMILIES[family] === true && !used.includes(family)
    );
    for (const family of pickFamilies(spec, remaining, 1)) runFamily(family);
  }
  return prisms;
}

interface FrontageEdge {
  a: Vec2;
  b: Vec2;
  lengthM: number;
}

const FACADE_ENTRY_MAX_PROJECTION_M = 1.8;
const FACADE_ENTRY_SIDE_MARGIN_M = 0.5;
const FACADE_ENTRY_ALIGNMENT_COS = Math.cos((35 * Math.PI) / 180);

/** All entrance decisions live in their own stable namespace, separate from rooftop salts. */
const facadeEntryRoll = (spec: BuildingSpec, slot: string): number =>
  fnv1a(`${Math.round(spec.seed * 0x3fffffff)}/facade-entry/v1/${slot}`) / 0x100000000;

const facadeEntryNeonMaterial = (spec: BuildingSpec, slot: string): number => {
  if (spec.neonEnabled === false) return spec.wallMaterial;
  const bank = Math.floor(spec.wallMaterial / BANK_SIZE) * BANK_SIZE;
  const weights = spec.neonWeights ?? [0.5, 0.5];
  return bank +
    (facadeEntryRoll(spec, `mat/${slot}`) < weights[0]!
      ? DISTRICT_SLOT.NEON_A
      : DISTRICT_SLOT.NEON_B);
};

/**
 * Pick only a wall parallel to the planned road tangent, then choose the wall furthest
 * toward the road. A long back wall is never used as a fallback when no aligned wall exists.
 */
function roadFacingEdge(spec: BuildingSpec, pixelsPerMetre: number): FrontageEdge | null {
  const frontage = spec.frontage;
  if (
    frontage === null ||
    frontage === undefined ||
    !Number.isFinite(frontage.angleRad) ||
    !Number.isFinite(frontage.outward.x) ||
    !Number.isFinite(frontage.outward.y)
  ) {
    return null;
  }
  const normalLength = Math.hypot(frontage.outward.x, frontage.outward.y);
  if (normalLength <= 0) return null;
  const nx = frontage.outward.x / normalLength;
  const ny = frontage.outward.y / normalLength;
  const tx = Math.cos(frontage.angleRad);
  const ty = Math.sin(frontage.angleRad);
  let selected: FrontageEdge | null = null;
  let selectedScore = -Infinity;
  const footprint = withPositiveArea(spec.footprint);
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!;
    const b = footprint[(i + 1) % footprint.length]!;
    const lengthPx = Math.hypot(b.x - a.x, b.y - a.y);
    if (lengthPx <= 0) continue;
    const ux = (b.x - a.x) / lengthPx;
    const uy = (b.y - a.y) / lengthPx;
    if (Math.abs(ux * tx + uy * ty) < FACADE_ENTRY_ALIGNMENT_COS) continue;
    const score = ((a.x + b.x) * 0.5) * nx + ((a.y + b.y) * 0.5) * ny;
    if (score > selectedScore) {
      selected = { a, b, lengthM: lengthPx / pixelsPerMetre };
      selectedScore = score;
    }
  }
  return selected;
}

/** Rectangle measured along the selected wall and outward toward the road, never inward. */
function frontageBox(
  edge: FrontageEdge,
  outward: Vec2,
  startM: number,
  endM: number,
  nearM: number,
  farM: number,
  pixelsPerMetre: number
): Ring {
  const lengthPx = edge.lengthM * pixelsPerMetre;
  const ux = (edge.b.x - edge.a.x) / lengthPx;
  const uy = (edge.b.y - edge.a.y) / lengthPx;
  const normalLength = Math.hypot(outward.x, outward.y);
  const nx = outward.x / normalLength;
  const ny = outward.y / normalLength;
  const point = (alongM: number, outM: number): Vec2 => ({
    x: edge.a.x + (ux * alongM + nx * outM) * pixelsPerMetre,
    y: edge.a.y + (uy * alongM + ny * outM) * pixelsPerMetre
  });
  return withPositiveArea([
    point(startM, nearM),
    point(endM, nearM),
    point(endM, farM),
    point(startM, farM)
  ]);
}

/**
 * Ground-level, street-facing entrance vocabulary. Every prism lies on the outward side
 * of the selected facade, projects at most 1.8 m, and ends below this mass's roof.
 */
export function facadeEntryPrisms(
  spec: BuildingSpec,
  pixelsPerMetre: number
): DetailPrism[] {
  const base = spec.baseHeight ?? 0;
  if (
    spec.primaryFrontage !== true ||
    base > 0.5 ||
    spec.height <= 0 ||
    spec.footprint.length < 3 ||
    pixelsPerMetre <= 0
  ) {
    return [];
  }
  const edge = roadFacingEdge(spec, pixelsPerMetre);
  if (edge === null) return [];

  const typology = resolveArchitecturalTypology(spec);
  const outward = spec.frontage!.outward;
  const topLimit = base + spec.height - 0.15;
  const dark = bankSlotMaterial(spec, DISTRICT_SLOT.WALL_C);
  const trim = spec.roofMaterial;
  const light = facadeEntryNeonMaterial(spec, typology);
  const prisms: DetailPrism[] = [];
  let prismIndex = 0;
  const add = (
    startM: number,
    endM: number,
    nearM: number,
    farM: number,
    bottom: number,
    top: number,
    material: number,
    role: string
  ): void => {
    if (
      endM <= startM ||
      nearM < 0 ||
      farM <= nearM ||
      farM > FACADE_ENTRY_MAX_PROJECTION_M + 1e-6 ||
      top <= bottom ||
      bottom < base ||
      top > topLimit
    ) {
      return;
    }
    prisms.push({
      footprint: frontageBox(edge, outward, startM, endM, nearM, farM, pixelsPerMetre),
      baseHeight: bottom,
      topHeight: top,
      material,
      seed: facadeEntryRoll(spec, `prism/${role}/${prismIndex++}`)
    });
  };
  const place = (widthM: number): number | null => {
    const spare = edge.lengthM - widthM - FACADE_ENTRY_SIDE_MARGIN_M * 2;
    if (spare < 0) return null;
    return FACADE_ENTRY_SIDE_MARGIN_M + facadeEntryRoll(spec, "geo/position") * spare;
  };
  const commonPortal = (
    widthM: number,
    minHeightM: number,
    targetHeightM: number,
    canopyProjectionM: number,
    glowingTransom: boolean
  ): { start: number; end: number; doorTop: number } | null => {
    const postWidth = Math.min(0.22, Math.max(0.14, widthM * 0.07));
    const startWithPosts = place(widthM + postWidth * 2);
    if (startWithPosts === null || topLimit - base < minHeightM + 0.28) return null;
    const start = startWithPosts + postWidth;
    const end = start + widthM;
    const doorTop = Math.min(base + targetHeightM, topLimit - 0.24);
    if (doorTop < base + minHeightM) return null;
    add(start, end, 0.03, 0.06, base + 0.03, doorTop, dark, "portal");
    add(start - postWidth, start, 0.025, 0.2, base, doorTop + 0.08, trim, "post-left");
    add(end, end + postWidth, 0.025, 0.2, base, doorTop + 0.08, trim, "post-right");
    const canopyTop = Math.min(topLimit, doorTop + 0.24);
    add(
      start - postWidth,
      end + postWidth,
      0.025,
      Math.min(FACADE_ENTRY_MAX_PROJECTION_M, canopyProjectionM),
      canopyTop - 0.16,
      canopyTop,
      trim,
      "canopy"
    );
    if (glowingTransom) {
      add(start + 0.12, end - 0.12, 0.061, 0.1, doorTop - 0.44, doorTop - 0.08, light, "light");
      // A shallow threshold spill reads from the module's top-down camera without turning
      // the whole pavement into emissive material. It stays under the canopy and within
      // the facade-entry projection budget.
      add(
        start + 0.08,
        end - 0.08,
        0.1,
        Math.min(0.75, Math.max(0.35, canopyProjectionM * 0.55)),
        base + 0.01,
        base + 0.05,
        light,
        "threshold-spill"
      );
    }
    return { start, end, doorTop };
  };

  switch (typology) {
    case "corporate":
    case "civic": {
      const minWidth = typology === "civic" ? 3 : 2.5;
      const width = Math.min(
        minWidth + facadeEntryRoll(spec, "geo/portal-width") * (5 - minWidth),
        edge.lengthM - FACADE_ENTRY_SIDE_MARGIN_M * 2 - 0.44
      );
      if (width < minWidth) return [];
      const portal = commonPortal(
        width,
        2.7,
        2.8 + facadeEntryRoll(spec, "geo/portal-height") * 0.4,
        1.2 + facadeEntryRoll(spec, "geo/canopy-depth") * 0.6,
        true
      );
      if (
        portal !== null &&
        facadeEntryRoll(spec, "geo/security-vestibule") < (typology === "civic" ? 0.22 : 0.14)
      ) {
        const rail = 0.1;
        const vestibuleDepth = 0.72;
        add(portal.start, portal.start + rail, 0.2, vestibuleDepth, base, base + 1.15, trim, "vestibule-left");
        add(portal.end - rail, portal.end, 0.2, vestibuleDepth, base, base + 1.15, trim, "vestibule-right");
      }
      break;
    }

    case "residential": {
      const width = Math.min(
        1.5 + facadeEntryRoll(spec, "geo/portal-width") * 1,
        edge.lengthM - FACADE_ENTRY_SIDE_MARGIN_M * 2 - 0.44
      );
      if (width < 1.5) return [];
      const portal = commonPortal(
        width,
        2.2,
        2.25 + facadeEntryRoll(spec, "geo/portal-height") * 0.45,
        0.8 + facadeEntryRoll(spec, "geo/canopy-depth") * 0.3,
        true
      );
      if (portal !== null) {
        add(portal.start - 0.12, portal.end + 0.12, 0.08, 0.7, base, base + 0.16, trim, "stoop");
      }
      break;
    }

    case "industrial": {
      const serviceWidth = 1.2 + facadeEntryRoll(spec, "geo/service-width") * 0.4;
      const gap = 0.55;
      const maxGarage = edge.lengthM -
        FACADE_ENTRY_SIDE_MARGIN_M * 2 -
        serviceWidth -
        gap -
        0.2;
      const garageWidth = Math.min(
        4 + facadeEntryRoll(spec, "geo/garage-width") * 3,
        maxGarage
      );
      if (garageWidth < 4 || topLimit - base < 3.78) return [];
      const totalWidth = garageWidth + gap + serviceWidth;
      const startWithPost = place(totalWidth + 0.2);
      if (startWithPost === null) return [];
      const start = startWithPost + 0.2;
      const garageEnd = start + garageWidth;
      const serviceStart = garageEnd + gap;
      const serviceEnd = serviceStart + serviceWidth;
      const garageTop = Math.min(
        base + 3.5 + facadeEntryRoll(spec, "geo/garage-height") * 1.5,
        topLimit - 0.24
      );
      if (garageTop < base + 3.5) return [];
      const serviceTop = Math.min(base + 2.5, garageTop - 0.25);
      add(start, garageEnd, 0.03, 0.06, base + 0.04, garageTop, dark, "garage");
      const segments = 4 + Math.floor(facadeEntryRoll(spec, "geo/segments") * 3);
      for (let segment = 1; segment < segments; segment++) {
        const y = base + ((garageTop - base) * segment) / segments;
        add(start + 0.08, garageEnd - 0.08, 0.061, 0.09, y - 0.035, y + 0.035, trim, `garage-seam-${segment}`);
      }
      add(serviceStart, serviceEnd, 0.03, 0.06, base + 0.04, serviceTop, dark, "service-door");
      add(start - 0.2, start, 0.025, 0.22, base, garageTop + 0.08, trim, "garage-post-left");
      add(garageEnd, garageEnd + 0.2, 0.025, 0.22, base, garageTop + 0.08, trim, "garage-post-right");
      const awningTop = Math.min(topLimit, garageTop + 0.24);
      add(
        start - 0.2,
        garageEnd + 0.2,
        0.025,
        1 + facadeEntryRoll(spec, "geo/awning-depth") * 0.6,
        awningTop - 0.18,
        awningTop,
        trim,
        "dock-awning"
      );
      add(
        serviceStart,
        serviceEnd,
        0.061,
        0.12,
        serviceTop - 0.18,
        serviceTop - 0.06,
        light,
        "service-light"
      );
      break;
    }

    case "market": {
      const paneCount = 2 + Math.floor(facadeEntryRoll(spec, "geo/pane-count") * 3);
      const minWidth = paneCount * 1.35;
      const width = Math.min(
        paneCount * (1.65 + facadeEntryRoll(spec, "geo/pane-width") * 0.35),
        edge.lengthM - FACADE_ENTRY_SIDE_MARGIN_M * 2 - 0.32
      );
      if (width < minWidth || topLimit - base < 2.78) return [];
      const startWithPosts = place(width + 0.32);
      if (startWithPosts === null) return [];
      const start = startWithPosts + 0.16;
      const end = start + width;
      const paneTop = Math.min(
        base + 2.5 + facadeEntryRoll(spec, "geo/pane-height") * 0.5,
        topLimit - 0.24
      );
      const gap = 0.08;
      const paneWidth = width / paneCount;
      for (let pane = 0; pane < paneCount; pane++) {
        add(
          start + pane * paneWidth + gap,
          start + (pane + 1) * paneWidth - gap,
          0.03,
          0.06,
          base + 0.05,
          paneTop,
          dark,
          `shopfront-${pane}`
        );
      }
      for (let mullion = 1; mullion < paneCount; mullion++) {
        const x = start + mullion * paneWidth;
        add(x - 0.055, x + 0.055, 0.025, 0.15, base, paneTop + 0.08, trim, `mullion-${mullion}`);
      }
      add(start - 0.16, start, 0.025, 0.18, base, paneTop + 0.08, trim, "post-left");
      add(end, end + 0.16, 0.025, 0.18, base, paneTop + 0.08, trim, "post-right");
      const awningTop = Math.min(topLimit, paneTop + 0.24);
      add(
        start - 0.16,
        end + 0.16,
        0.025,
        0.9 + facadeEntryRoll(spec, "geo/awning-depth") * 0.5,
        awningTop - 0.18,
        awningTop,
        trim,
        "awning"
      );
      add(start + 0.15, end - 0.15, 0.061, 0.11, paneTop - 0.24, paneTop - 0.08, light, "header");
      break;
    }

    case "derelict": {
      const width = Math.min(
        1.2 + facadeEntryRoll(spec, "geo/portal-width") * 0.6,
        edge.lengthM - FACADE_ENTRY_SIDE_MARGIN_M * 2 - 0.44
      );
      if (width < 1.2) return [];
      const portal = commonPortal(
        width,
        2.2,
        2.2 + facadeEntryRoll(spec, "geo/portal-height") * 0.35,
        0.8 + facadeEntryRoll(spec, "geo/hood-depth") * 0.25,
        false
      );
      if (portal !== null) {
        const shutterBands = 3 + Math.floor(facadeEntryRoll(spec, "geo/shutter-bands") * 3);
        for (let band = 1; band < shutterBands; band++) {
          const y = base + ((portal.doorTop - base) * band) / shutterBands;
          add(portal.start + 0.04, portal.end - 0.04, 0.061, 0.09, y - 0.03, y + 0.03, trim, `shutter-${band}`);
        }
      }
      break;
    }

    case "standard":
    default: {
      const width = Math.min(
        1.8 + facadeEntryRoll(spec, "geo/portal-width") * 0.6,
        edge.lengthM - FACADE_ENTRY_SIDE_MARGIN_M * 2 - 0.44
      );
      if (width < 1.8) return [];
      commonPortal(
        width,
        2.3,
        2.4 + facadeEntryRoll(spec, "geo/portal-height") * 0.45,
        0.9 + facadeEntryRoll(spec, "geo/canopy-depth") * 0.35,
        true
      );
      break;
    }
  }
  return prisms;
}

function prismsForBuilding(spec: BuildingSpec, pixelsPerMetre: number): DetailPrism[] {
  const entryPrisms = facadeEntryPrisms(spec, pixelsPerMetre);
  if (
    spec.facadeEntryOnly === true ||
    spec.height < BUILDING_DETAIL_MIN_HEIGHT_M ||
    spec.footprint.length < 3 ||
    pixelsPerMetre <= 0
  ) {
    return entryPrisms;
  }

  const prisms: DetailPrism[] = [...entryPrisms];
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

  // 6. v2 typology-aware rooftop feature families (appended: legacy draw order untouched).
  prisms.push(...rooftopFamilyLayer(spec, massing, pixelsPerMetre, accent));
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
