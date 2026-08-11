import {
  describeBuildingMassing,
  wallShade,
  withPositiveArea,
  type BuildingMassing,
  type BuildingSpec
} from "../geom/extrude.js";
import { KIND, MeshBuilder, mergeMeshes, type MeshBuffers } from "../geom/mesh.js";
import { triangulate } from "../geom/tessellate.js";
import { ringBounds, ringCentroid, type Ring, type Vec2 } from "../geom/types.js";
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
  salt: number
): Ring | null {
  const frame = roofFrame(footprint, pixelsPerMetre);
  if (frame === null) return null;
  const halfU = Math.min(frame.extentU * 0.34, 3.2 + roll(seed, salt) * 3.8);
  const halfV = Math.min(frame.extentV * 0.34, 2.4 + roll(seed, salt + 1) * 2.8);
  if (halfU < 1.4 || halfV < 1.2) return null;

  const rangeU = Math.max(0, frame.extentU - halfU - 0.9);
  const rangeV = Math.max(0, frame.extentV - halfV - 0.9);
  for (let attempt = 0; attempt < 12; attempt++) {
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

function scaledRing(ring: Ring, scale: number): Ring {
  const centre = ringCentroid(ring);
  return ring.map((p) => ({
    x: centre.x + (p.x - centre.x) * scale,
    y: centre.y + (p.y - centre.y) * scale
  }));
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
        material: boxIndex % 2 === 0 ? accent : spec.wallMaterial,
        seed: roll(spec.seed, salt + 3)
      });
      break;
    }
  }
  return prisms;
}

function neonMaterial(spec: BuildingSpec, salt: number): number {
  const bank = Math.floor(spec.wallMaterial / BANK_SIZE) * BANK_SIZE;
  const weights = spec.neonWeights ?? [0.5, 0.5];
  const slot =
    roll(spec.seed, salt) < weights[0]!
      ? DISTRICT_SLOT.NEON_A
      : DISTRICT_SLOT.NEON_B;
  return bank + slot;
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
  const style = Math.min(3, Math.floor(roll(spec.seed, 900) * 4));
  for (let volumeIndex = 0; volumeIndex < massing.volumes.length; volumeIndex++) {
    const volume = massing.volumes[volumeIndex]!;
    const footprint = withPositiveArea(volume.footprint);
    const span = volume.topHeight - volume.baseHeight;
    if (span <= 1) continue;

    const bandCount =
      style === 1
        ? Math.min(2, Math.max(1, Math.floor(span / 18)))
        : style === 2 && span >= 24
          ? 1
          : style === 3
            ? 1
            : 0;
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

      addStrip(
        0.015,
        0.985,
        0.18,
        0.42,
        volume.topHeight - 0.28,
        volume.topHeight + 0.22,
        spec.roofMaterial,
        edgeSalt
      );
      addStrip(
        0.03,
        0.97,
        0.42,
        0.08,
        volume.topHeight + 0.2,
        volume.topHeight + 1.25,
        spec.wallMaterial,
        edgeSalt + 1
      );

      for (let band = 0; band < bandCount; band++) {
        const t = (band + 1) / (bandCount + 1);
        const height = volume.baseHeight + span * t;
        addStrip(
          0.025,
          0.975,
          0.08,
          0.32,
          height - 0.18,
          height + 0.24,
          spec.roofMaterial,
          edgeSalt + 10 + band
        );
      }

      if (style !== 1 && span >= 7 && edgeLengthM >= 4) {
        const finLimit = style === 0 ? 3 : 2;
        const finCount = Math.min(finLimit, Math.max(1, Math.floor(edgeLengthM / 8)));
        const finWidthM = 0.42 + roll(spec.seed, edgeSalt + 20) * 0.36;
        const halfT = Math.min(0.08, finWidthM / edgeLengthM / 2);
        for (let fin = 0; fin < finCount; fin++) {
          const centreT = (fin + 0.5) / finCount;
          addStrip(
            centreT - halfT,
            centreT + halfT,
            0.08,
            0.5 + roll(spec.seed, edgeSalt + 21 + fin) * 0.35,
            volume.baseHeight + Math.min(2.4, span * 0.12),
            volume.topHeight - 0.65,
            spec.wallMaterial,
            edgeSalt + 30 + fin
          );
        }
      }
    }
  }

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
    (style === 1 || style === 3) &&
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

  const roof = massing.volumes.at(-1)!;
  const roofFootprint = withPositiveArea(roof.footprint);
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
        material: accent,
        seed: roll(spec.seed, 835)
      });
    }
  }

  const roofEdges = roofFootprint
    .map((a, index) => {
      const b = roofFootprint[(index + 1) % roofFootprint.length]!;
      return { index, length: Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMetre };
    })
    .filter((edge) => edge.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (let rail = 0; rail < Math.min(2, roofEdges.length); rail++) {
    if (rail === 0 && roll(spec.seed, 849) >= 0.78) break;
    if (rail > 0 && style !== 3) break;
    const edge = roofEdges[rail]!;
    const a = roofFootprint[edge.index]!;
    const b = roofFootprint[(edge.index + 1) % roofFootprint.length]!;
    const strip = edgeStrip(a, b, 0.16, 0.84, 0.06, 0.16, pixelsPerMetre);
    if (strip === null) continue;
    prisms.push({
      footprint: strip,
      baseHeight: roof.topHeight + 1.24,
      topHeight: roof.topHeight + 1.52,
      material: accent,
      seed: roll(spec.seed, 851 + rail)
    });
  }

  prisms.push(...utilityPrisms(spec, massing, pixelsPerMetre, accent));
  return prisms;
}

export function prismMesh(prism: DetailPrism): MeshBuffers {
  const footprint = withPositiveArea(prism.footprint);
  const cap = triangulate([footprint]);
  const bounds = ringBounds(footprint);
  const builder = new MeshBuilder(footprint.length * 5, footprint.length * 3 - 2);
  const capBase = builder.vertexCount;
  for (const p of cap.positions) {
    const u = bounds.width > 0 ? ((p.x - bounds.x) / bounds.width) * 2 - 1 : 0;
    const v = bounds.height > 0 ? ((p.y - bounds.y) / bounds.height) * 2 - 1 : 0;
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
