import { KIND, MeshBuilder, type MeshBuffers } from "./mesh.js";
import { triangulate } from "./tessellate.js";
import { ringArea, ringCentroid, type Ring, type Vec2 } from "./types.js";

export interface BuildingSpec {
  /** Footprint in world pixels. Winding is normalised internally. */
  footprint: Ring;
  /** Height in metres. Stays in metres so geometry survives a grid-size change. */
  height: number;
  roofMaterial: number;
  wallMaterial: number;
  /** 0..1 building hash. Picks the facade style and seeds its per-cell hashes. */
  seed: number;
  /** WHY: opt-in keeps ad-hoc specs such as cars on their existing simple extrusion. */
  detailedMassing?: boolean;
}

export interface BuildingVolume {
  footprint: Ring;
  baseHeight: number;
  topHeight: number;
}

export interface BuildingMassing {
  volumes: BuildingVolume[];
}

/** Direction the key light arrives from, in world space (y grows downward). */
export const LIGHT_DIRECTION: Vec2 = { x: -0.5547, y: -0.8321 };
export const SHADOW_LENGTH = 0.65;
export const SHADE_MIN = 0.32;
export const SHADE_MAX = 0.72;
export const ROOF_SHADE = 1;

export const DETAILED_MASSING_MIN_HEIGHT_M = 34;
const DETAILED_MASSING_MIN_EDGE_M = 10;

function supportsRoofStructures(poly: Ring): boolean {
  if (poly.length !== 4) return false;
  return poly.every((p, i) => {
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const next = poly[(i + 1) % poly.length]!;
    const ax = prev.x - p.x;
    const ay = prev.y - p.y;
    const bx = next.x - p.x;
    const by = next.y - p.y;
    const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return scale > 0 && Math.abs(ax * bx + ay * by) / scale < 0.2;
  });
}

function seedRoll(seed: number, salt: number): number {
  let h = (Math.round(seed * 0xffffffff) ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function quadPoint(poly: Ring, u: number, v: number): Vec2 {
  const a = poly[0]!;
  const b = poly[1]!;
  const c = poly[2]!;
  const d = poly[3]!;
  const iu = 1 - u;
  const iv = 1 - v;
  return {
    x: a.x * iu * iv + b.x * u * iv + c.x * u * v + d.x * iu * v,
    y: a.y * iu * iv + b.y * u * iv + c.y * u * v + d.y * iu * v
  };
}

export function describeBuildingMassing(
  spec: BuildingSpec,
  pixelsPerMetre: number
): BuildingMassing {
  const footprint = withPositiveArea(spec.footprint);
  const simple = (): BuildingMassing => ({
    volumes: [{ footprint, baseHeight: 0, topHeight: spec.height }]
  });
  if (
    spec.detailedMassing !== true ||
    spec.height < DETAILED_MASSING_MIN_HEIGHT_M ||
    pixelsPerMetre <= 0 ||
    !supportsRoofStructures(footprint)
  ) {
    return simple();
  }

  const edgeU =
    (Math.hypot(footprint[1]!.x - footprint[0]!.x, footprint[1]!.y - footprint[0]!.y) +
      Math.hypot(footprint[2]!.x - footprint[3]!.x, footprint[2]!.y - footprint[3]!.y)) /
    (2 * pixelsPerMetre);
  const edgeV =
    (Math.hypot(footprint[3]!.x - footprint[0]!.x, footprint[3]!.y - footprint[0]!.y) +
      Math.hypot(footprint[2]!.x - footprint[1]!.x, footprint[2]!.y - footprint[1]!.y)) /
    (2 * pixelsPerMetre);
  if (Math.min(edgeU, edgeV) < DETAILED_MASSING_MIN_EDGE_M) return simple();

  const scaleU = 0.58 + seedRoll(spec.seed, 101) * 0.18;
  const scaleV = 0.58 + seedRoll(spec.seed, 102) * 0.18;
  const offset = seedRoll(spec.seed, 103) < 0.35 ? 0 : 1;
  const shiftU = (seedRoll(spec.seed, 104) * 2 - 1) * ((1 - scaleU) / 2) * 0.7 * offset;
  const shiftV = (seedRoll(spec.seed, 105) * 2 - 1) * ((1 - scaleV) / 2) * 0.7 * offset;
  const u0 = (1 - scaleU) / 2 + shiftU;
  const v0 = (1 - scaleV) / 2 + shiftV;
  const u1 = u0 + scaleU;
  const v1 = v0 + scaleV;
  const upper = [
    quadPoint(footprint, u0, v0),
    quadPoint(footprint, u1, v0),
    quadPoint(footprint, u1, v1),
    quadPoint(footprint, u0, v1)
  ];
  const baseHeight = spec.height * (0.55 + seedRoll(spec.seed, 106) * 0.17);

  return {
    volumes: [
      { footprint, baseHeight: 0, topHeight: baseHeight },
      { footprint: upper, baseHeight, topHeight: spec.height }
    ]
  };
}

/**
 * Normalise winding so `ringArea` is positive, which makes (dy, -dx) the outward edge
 * normal. Avoids reasoning about clockwise-ness in a y-down coordinate system, where
 * the visual and mathematical senses are opposite.
 */
export function withPositiveArea(ring: Ring): Ring {
  return ringArea(ring) < 0 ? [...ring].reverse() : ring;
}

/** Lambert-ish shade for a wall, from the outward normal of one footprint edge. */
export function wallShade(edgeStart: Vec2, edgeEnd: Vec2): number {
  const dx = edgeEnd.x - edgeStart.x;
  const dy = edgeEnd.y - edgeStart.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return SHADE_MIN;

  const nx = dy / len;
  const ny = -dx / len;
  const facing = 0.5 + 0.5 * (nx * LIGHT_DIRECTION.x + ny * LIGHT_DIRECTION.y);
  return SHADE_MIN + (SHADE_MAX - SHADE_MIN) * facing;
}

/** Footprint is world pixels, height is metres, so wall-U needs the scene's scale. */
function appendVolume(
  builder: MeshBuilder,
  volume: BuildingVolume,
  spec: BuildingSpec,
  pixelsPerMetre: number,
  seed: number
): void {
  const poly = volume.footprint;
  const n = poly.length;
  if (n < 3) throw new Error(`Footprint needs at least 3 points, got ${n}.`);

  const height = volume.topHeight;
  const centre = ringCentroid(poly);
  let roofAngle = 0;
  let longestEdge = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= longestEdge) continue;
    longestEdge = length;
    roofAngle = Math.atan2(dy, dx);
  }
  const ux = Math.cos(roofAngle);
  const uy = Math.sin(roofAngle);
  let halfWidthPx = 0;
  let halfHeightPx = 0;
  for (const p of poly) {
    const dx = p.x - centre.x;
    const dy = p.y - centre.y;
    halfWidthPx = Math.max(halfWidthPx, Math.abs(dx * ux + dy * uy));
    halfHeightPx = Math.max(halfHeightPx, Math.abs(-dx * uy + dy * ux));
  }
  const halfWidthM = halfWidthPx / pixelsPerMetre;
  const halfHeightM = halfHeightPx / pixelsPerMetre;
  const roofHalfHeight = supportsRoofStructures(poly) ? halfHeightM : -Math.max(halfHeightM, 1e-6);

  const roof = triangulate([poly]);
  const roofBase = builder.vertexCount;
  for (const p of roof.positions) {
    builder.vertex(
      p.x,
      p.y,
      height,
      spec.roofMaterial,
      roofHalfHeight,
      KIND.ROOF,
      halfWidthM,
      roofAngle,
      seed,
      centre.x,
      centre.y
    );
  }
  for (let i = 0; i < roof.indices.length; i += 3) {
    builder.triangle(
      roofBase + roof.indices[i]!,
      roofBase + roof.indices[i + 1]!,
      roofBase + roof.indices[i + 2]!
    );
  }

  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const shade = wallShade(a, b);
    const w = spec.wallMaterial;
    const end = Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMetre;

    const base = builder.vertex(
      a.x,
      a.y,
      volume.baseHeight,
      w,
      shade,
      KIND.WALL,
      0,
      height,
      seed
    );
    builder.vertex(b.x, b.y, volume.baseHeight, w, shade, KIND.WALL, end, height, seed);
    builder.vertex(b.x, b.y, height, w, shade, KIND.WALL, end, height, seed);
    builder.vertex(a.x, a.y, height, w, shade, KIND.WALL, 0, height, seed);

    builder.triangle(base, base + 1, base + 2);
    builder.triangle(base, base + 2, base + 3);
  }
}

/** Footprint is world pixels, heights are metres, so each tier shares the scene scale. */
export function extrudeBuilding(spec: BuildingSpec, pixelsPerMetre: number): MeshBuffers {
  if (spec.footprint.length < 3) {
    throw new Error(`Footprint needs at least 3 points, got ${spec.footprint.length}.`);
  }
  const massing = describeBuildingMassing(spec, pixelsPerMetre);
  const maxVertices = massing.volumes.reduce(
    (sum, volume) => sum + volume.footprint.length * 5,
    0
  );
  const maxTriangles = massing.volumes.reduce(
    (sum, volume) => sum + volume.footprint.length * 3 - 2,
    0
  );
  const builder = new MeshBuilder(maxVertices, maxTriangles);
  for (let i = 0; i < massing.volumes.length; i++) {
    const seed = i === 0 ? spec.seed : seedRoll(spec.seed, 200 + i);
    appendVolume(builder, massing.volumes[i]!, spec, pixelsPerMetre, seed);
  }
  return builder.build();
}
