import { intersection, ringAsMulti } from "../geom/boolean.js";
import {
  LIGHT_DIRECTION,
  SHADOW_LENGTH,
  extrudeBuilding,
  type BuildingSpec
} from "../geom/extrude.js";
import {
  VERTEX_FLOATS,
  emptyMesh,
  mergeMeshes,
  type MeshBuffers
} from "../geom/mesh.js";
import { flatMesh } from "../geom/tessellate.js";
import {
  rectRing,
  ringBounds,
  ringCentroid,
  unionRect,
  type MultiPolygon,
  type Rect,
  type Ring,
  type Vec2
} from "../geom/types.js";
import {
  BANK_SIZE,
  MATERIAL,
  OPEN_SPACE_SURFACE_SHADES,
  OPEN_SPACE_SURFACE_SLOTS,
  materialIndex
} from "../palette.js";
import { CLUTTER_MAX_HEIGHT_M, CLUTTER_MIN_BUILDING_M, clutterMesh } from "./clutter.js";
import { buildingDetailMesh, prismMesh, type DetailPrism } from "./building-detail.js";
import { hash2 } from "./hash.js";
import { neonMesh } from "./neon.js";
import { chunkId, chunkRect, type ChunkKey } from "./chunks.js";
import { citySurfaces, type CitySurfacePartitions } from "./city-chunk.js";
import type { CitySourceV3 } from "./city.js";
import type {
  BuildingMassPlan,
  BuildingPlan,
  CompleteCityPlan,
  LandmarkMassPlan,
  LandmarkPlan,
  OpenSpacePlan
} from "./complete-city-plan.js";
import {
  BUILDING_GRAMMAR_REGISTRY,
  MICRO_BUILDING_GRAMMAR_IDS,
  type BuildingUseId
} from "./building-registry.js";
import { LANDMARK_GRAMMAR_REGISTRY } from "./landmark-registry.js";
import { type DistrictTypeId } from "./district-registry.js";
import { validateCompleteCityPlan } from "./complete-city-plan.js";

/**
 * Final chunk builder for generator 11.
 *
 * Consumes `CompleteCityPlan` exactly once per batch: every chunk clips the batch's
 * surface partitions and filters the plan's buildings and landmarks, never replanning.
 * Metres become pixels here and nowhere else in the plan pipeline — the plan is
 * metre-space, the renderer and the 11-float vertex payload are pixel-space.
 *
 * Surface partitions (terrain, carriageway, sidewalk, non-vehicle routes, markings)
 * come from the existing `citySurfaces(source, sceneBoundsM)` — the same derivation and
 * the same single compile per batch as the Phase 1-3 `buildCityChunks` — so the flat
 * road/ground behaviour is preserved exactly. The plan contributes the built world:
 * open spaces, building masses and landmark masses.
 *
 * Ownership is deterministic and duplicate-free:
 * - Terrain, roads, markings and open spaces are flat surfaces, clipped to the chunk
 *   rect. Clipping is seamless and disjoint, so a seam never shows and no triangle is
 *   emitted twice.
 * - Buildings are owned by the centroid of their parcel, landmarks by the centroid of
 *   their site, half-open on the max edges (matching `chunkRect`). A kept building is
 *   emitted uncut in its owner chunk — it may overhang the chunk rect, and `boundsPx`
 *   grows to cover the overhang, its shadows, its detail tier and its neon glow so
 *   culling never drops it.
 * - Elevated connectors (skybridges, circulation bridges, service conduits) are planned
 *   once per plan, capped per block, and owned by the midpoint between their two
 *   endpoint buildings, half-open like everything else, so each connector is emitted by
 *   exactly one chunk and never duplicated.
 *
 * The three mesh outputs match the renderer's `ChunkGeometry` split: everything opaque
 * in `mesh`, higher-quality architecture in `detail`, and additive neon quads in `neon`.
 * The grammar's `geometryPolicy.coarse` picks the motion representation: "volumes"
 * emits every mass in `mesh`; "silhouette" emits only the primary mass there and defers
 * remaining masses to settled `detail`. Per-mass architectural detail follows
 * `detailPolicy`. Neon is depth-tested against opaque geometry and stays in `neon`.
 */

export interface CompleteChunkBuild {
  key: ChunkKey;
  id: string;
  /** Real extent in METRES, including everything overhanging the chunk rect. */
  boundsM: Rect;
  /** Real extent in WORLD PIXELS, for `ChunkGeometry.boundsPx` culling. */
  boundsPx: Rect;
  /** Complete opaque scene: terrain, roads, open spaces, buildings, landmarks, clutter. */
  mesh: MeshBuffers;
  /** Additional geometry reserved for higher render-quality tiers. */
  detail: MeshBuffers;
  /** Additive neon quads, drawn after the opaque pass over the same bounds. */
  neon: MeshBuffers;
  /** Flat surfaces already clipped to the chunk rect. Disjoint between chunks. */
  surfaces: CitySurfacePartitions;
  /** Ids of the buildings this chunk owns, uncut. Disjoint across chunks. */
  buildingIds: string[];
  /** Ids of the landmarks this chunk owns, uncut. Disjoint across chunks. */
  landmarkIds: string[];
  /**
   * Elevated connectors this chunk owns by midpoint, uncut. Disjoint across chunks:
   * every plan connector is emitted by exactly the chunk containing its midpoint.
   */
  connectors: BlockConnector[];
  buildingCount: number;
  landmarkCount: number;
  connectorCount: number;
  openSpaceCount: number;
  waterTriangleCount: number;
  exposedLandTriangleCount: number;
  vehicleTriangleCount: number;
  sidewalkTriangleCount: number;
  nonVehicleTriangleCount: number;
  markingTriangleCount: number;
  openSpaceTriangleCount: number;
}

export interface CompleteChunksBuild {
  chunks: CompleteChunkBuild[];
  buildingCount: number;
  landmarkCount: number;
  connectorCount: number;
  openSpaceCount: number;
  markingTriangleCount: number;
  /** Geometry totals across mesh + detail + neon (the whole transferred payload). */
  vertexCount: number;
  triangleCount: number;
  bytes: number;
}

/** The shared per-mass fields both building and landmark masses carry. */
type PlanMass = BuildingMassPlan | LandmarkMassPlan;

function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(Math.min(a.x, a.x + a.width), Math.min(b.x, b.x + b.width));
  const y = Math.max(Math.min(a.y, a.y + a.height), Math.min(b.y, b.y + b.height));
  const right = Math.min(Math.max(a.x, a.x + a.width), Math.max(b.x, b.x + b.width));
  const bottom = Math.min(Math.max(a.y, a.y + a.height), Math.max(b.y, b.y + b.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Metre rect to world pixels, mirroring `toPixels`. */
function toPixelsRect(rect: Rect, origin: Vec2, pixelsPerMetre: number): Rect {
  return {
    x: origin.x + rect.x * pixelsPerMetre,
    y: origin.y + rect.y * pixelsPerMetre,
    width: rect.width * pixelsPerMetre,
    height: rect.height * pixelsPerMetre
  };
}

/** World pixels to metres. */
function toMetresRect(rect: Rect, origin: Vec2, pixelsPerMetre: number): Rect {
  return {
    x: (rect.x - origin.x) / pixelsPerMetre,
    y: (rect.y - origin.y) / pixelsPerMetre,
    width: rect.width / pixelsPerMetre,
    height: rect.height / pixelsPerMetre
  };
}

function toPixelsRing(ring: Ring, origin: Vec2, pixelsPerMetre: number): Ring {
  return ring.map((p) => ({
    x: origin.x + p.x * pixelsPerMetre,
    y: origin.y + p.y * pixelsPerMetre
  }));
}

/** Half-open on the max edges, matching `chunkRect`, so nothing is owned twice. */
function ownsCentroid(chunkM: Rect, p: Vec2): boolean {
  return (
    p.x >= chunkM.x &&
    p.x < chunkM.x + chunkM.width &&
    p.y >= chunkM.y &&
    p.y < chunkM.y + chunkM.height
  );
}

/**
 * The rect the shadow pass can reach past a footprint: the building body translated
 * along the light direction by `topHeight * SHADOW_LENGTH`. Same rule as the whole-city
 * bounds in the Phase 1-3 chunk builder, in world pixels.
 */
function shadowRectPx(footprintPx: Rect, topHeightM: number, pixelsPerMetre: number): Rect {
  const reachX = LIGHT_DIRECTION.x * topHeightM * SHADOW_LENGTH * pixelsPerMetre;
  const reachY = LIGHT_DIRECTION.y * topHeightM * SHADOW_LENGTH * pixelsPerMetre;
  return {
    x: footprintPx.x - reachX,
    y: footprintPx.y - reachY,
    width: footprintPx.width,
    height: footprintPx.height
  };
}

/** Positional extent of a mesh in world pixels. Neon quads reach past the footprints they sit on. */
function meshBoundsPx(mesh: MeshBuffers): Rect | null {
  if (mesh.vertexCount === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.vertices[i * VERTEX_FLOATS]!;
    const y = mesh.vertices[i * VERTEX_FLOATS + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function meshMaxHeightM(mesh: MeshBuffers): number {
  let height = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    height = Math.max(height, mesh.vertices[i * VERTEX_FLOATS + 2]!);
  }
  return height;
}

function emptySurfaces(): CitySurfacePartitions {
  return {
    water: [],
    exposedLand: [],
    vehicleCarriageway: [],
    vehicleSidewalk: [],
    nonVehicleRoute: [],
    markings: [],
    laneMarkings: [],
    crossings: [],
    kerbs: [],
    gutters: [],
    curbHighlights: [],
    drains: [],
    repairs: [],
    repairHighlights: []
  };
}

function clipSurfaces(surfaces: CitySurfacePartitions, clip: Rect): CitySurfacePartitions {
  if (clip.width <= 0 || clip.height <= 0) return emptySurfaces();
  const box = ringAsMulti(rectRing(clip));
  return {
    water: intersection(surfaces.water, box),
    exposedLand: intersection(surfaces.exposedLand, box),
    vehicleCarriageway: intersection(surfaces.vehicleCarriageway, box),
    vehicleSidewalk: intersection(surfaces.vehicleSidewalk, box),
    nonVehicleRoute: intersection(surfaces.nonVehicleRoute, box),
    markings: intersection(surfaces.markings, box),
    laneMarkings: intersection(surfaces.laneMarkings, box),
    crossings: intersection(surfaces.crossings, box),
    kerbs: intersection(surfaces.kerbs, box),
    gutters: intersection(surfaces.gutters, box),
    curbHighlights: intersection(surfaces.curbHighlights, box),
    drains: intersection(surfaces.drains, box),
    repairs: intersection(surfaces.repairs, box),
    repairHighlights: intersection(surfaces.repairHighlights, box)
  };
}

function toPixelsSurfaces(surfaces: CitySurfacePartitions, origin: Vec2, pixelsPerMetre: number): CitySurfacePartitions {
  const convert = (multi: MultiPolygon): MultiPolygon =>
    multi.map((polygon) => polygon.map((ring) => toPixelsRing(ring, origin, pixelsPerMetre)));
  return {
    water: convert(surfaces.water),
    exposedLand: convert(surfaces.exposedLand),
    vehicleCarriageway: convert(surfaces.vehicleCarriageway),
    vehicleSidewalk: convert(surfaces.vehicleSidewalk),
    nonVehicleRoute: convert(surfaces.nonVehicleRoute),
    markings: convert(surfaces.markings),
    laneMarkings: convert(surfaces.laneMarkings),
    crossings: convert(surfaces.crossings),
    kerbs: convert(surfaces.kerbs),
    gutters: convert(surfaces.gutters),
    curbHighlights: convert(surfaces.curbHighlights),
    drains: convert(surfaces.drains),
    repairs: convert(surfaces.repairs),
    repairHighlights: convert(surfaces.repairHighlights)
  };
}

/**
 * One flat mesh per open space, coloured by the plan's resolved bank and the surface
 * style's slot. The plan already resolved each open space's absolute palette index
 * (district bank from its palette id, BASE_BANK for unzoned); the surface style picks
 * the slot inside that same bank so the ground stays district-retintable and the two
 * categories sharing a plan slot (park and service-yard both ROOF_A) separate here.
 * The per-style shade keeps every category's flat tone distinct.
 */
function openSpaceMaterialAndShade(plan: OpenSpacePlan): { material: number; shade: number } {
  // WHY: Ground-backed residuals must not be remapped through an open-space style slot.
  if (plan.material === MATERIAL.GROUND) {
    return { material: MATERIAL.GROUND, shade: 1 };
  }
  // WHY: materialIndex expects a bank number; plan.material is already bank * BANK_SIZE + slot.
  const bank = Math.floor(plan.material / BANK_SIZE);
  const slot =
    OPEN_SPACE_SURFACE_SLOTS[plan.surfaceStyle] ??
    (plan.material - bank * BANK_SIZE);
  return {
    material: materialIndex(bank, Math.min(BANK_SIZE - 1, Math.max(0, slot))),
    shade: OPEN_SPACE_SURFACE_SHADES[plan.surfaceStyle] ?? 1
  };
}

/** Height offset in metres for open space polygons to prevent z-fighting with exposed ground at height 0. */
export const OPEN_SPACE_HEIGHT_M = 0.02;

function openSpaceMeshes(
  openSpaces: { plan: OpenSpacePlan; polygon: MultiPolygon }[],
  origin: Vec2,
  pixelsPerMetre: number
): { meshes: MeshBuffers[]; triangles: number; count: number } {
  const meshes: MeshBuffers[] = [];
  let triangles = 0;
  let count = 0;
  for (const openSpace of openSpaces) {
    const polygon = openSpace.polygon.map((rings) =>
      rings.map((ring) => toPixelsRing(ring, origin, pixelsPerMetre))
    );
    if (polygon.length === 0) continue;
    const { material, shade } = openSpaceMaterialAndShade(openSpace.plan);
    // WHY: Open spaces sit on top of base exposed land (height 0). Drawing them at height 0
    // causes z-fighting (coplanar polygon artifacts) at high zoom levels. Elevating by
    // OPEN_SPACE_HEIGHT_M (0.02 m) gives them depth clearance over ground while keeping them below
    // road markings (0.05 m).
    const mesh = flatMesh(polygon, OPEN_SPACE_HEIGHT_M, material, shade);
    if (mesh.triangleCount === 0) continue;
    meshes.push(mesh);
    triangles += mesh.triangleCount;
    count++;
  }
  return { meshes, triangles, count };
}

/** Bounded per-open-space prop budget, keyed by the plan's detail style. */
const OPEN_SPACE_DETAIL_PROPS: Readonly<
  Record<string, { countMax: number; halfM: number; heightMinM: number; heightMaxM: number }>
> = Object.freeze({
  trees: { countMax: 5, halfM: 1.1, heightMinM: 2.2, heightMaxM: 4.2 },
  benches: { countMax: 3, halfM: 0.8, heightMinM: 0.4, heightMaxM: 0.55 },
  markings: { countMax: 4, halfM: 0.7, heightMinM: 0.07, heightMaxM: 0.09 },
  "utility-structures": { countMax: 3, halfM: 0.9, heightMinM: 2.5, heightMaxM: 5 },
  planters: { countMax: 4, halfM: 0.75, heightMinM: 0.5, heightMaxM: 0.7 },
  bins: { countMax: 4, halfM: 0.45, heightMinM: 1, heightMaxM: 1.3 }
});

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

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/**
 * Small deterministic props for the detail tier, one set per detail style. Every prop is
 * a 10-triangle prism placed inside this chunk's clipped piece of the open space, so the
 * set is disjoint across chunks and bounded (at most 5 prisms per piece per style).
 */
function openSpaceDetailMesh(
  openSpaces: { plan: OpenSpacePlan; polygon: MultiPolygon }[],
  origin: Vec2,
  pixelsPerMetre: number
): MeshBuffers {
  const prisms: DetailPrism[] = [];
  for (const openSpace of openSpaces) {
    const budget = OPEN_SPACE_DETAIL_PROPS[openSpace.plan.detailStyle];
    if (budget === undefined) continue;
    const material = openSpaceMaterialAndShade(openSpace.plan).material;
    const seed = fnv1a(openSpace.plan.seed);
    for (const polygon of openSpace.polygon) {
      const ring = polygon[0];
      if (ring === undefined) continue;
      const bounds = ringBounds(ring);
      if (bounds.width < 3 || bounds.height < 3) continue;
      const count = Math.min(
        budget.countMax,
        Math.max(1, Math.floor(hash2(seed, 60) * budget.countMax))
      );
      for (let prop = 0; prop < count; prop++) {
        const halfU = budget.halfM * (0.6 + hash2(seed, 61 + prop * 7) * 0.8);
        const halfV = budget.halfM * (0.6 + hash2(seed, 62 + prop * 7) * 0.8);
        const rangeU = Math.max(0, bounds.width / 2 - halfU - 0.4);
        const rangeV = Math.max(0, bounds.height / 2 - halfV - 0.4);
        for (let attempt = 0; attempt < 6; attempt++) {
          const salt = 63 + prop * 7 + attempt * 11;
          const cx = bounds.x + bounds.width / 2 + (hash2(seed, salt) * 2 - 1) * rangeU;
          const cy = bounds.y + bounds.height / 2 + (hash2(seed, salt + 1) * 2 - 1) * rangeV;
          const box: Ring = [
            { x: cx - halfU, y: cy - halfV },
            { x: cx + halfU, y: cy - halfV },
            { x: cx + halfU, y: cy + halfV },
            { x: cx - halfU, y: cy + halfV }
          ];
          if (!box.every((p) => pointInRing(p, ring))) continue;
          prisms.push({
            footprint: box.map((p) => ({
              x: origin.x + p.x * pixelsPerMetre,
              y: origin.y + p.y * pixelsPerMetre
            })),
            baseHeight: 0,
            topHeight: budget.heightMinM + hash2(seed, salt + 2) * (budget.heightMaxM - budget.heightMinM),
            material,
            seed: hash2(seed, salt + 3)
          });
          break;
        }
      }
    }
  }
  return mergeMeshes(prisms.map(prismMesh));
}

/**
 * The plan already decomposed each building into disjoint masses (podium, tower, ...),
 * so every mass is one simple extruded volume sitting on its own elevation.
 */
function massSpec(mass: PlanMass, origin: Vec2, pixelsPerMetre: number): BuildingSpec {
  return {
    footprint: toPixelsRing(mass.footprint, origin, pixelsPerMetre),
    height: mass.heightM,
    baseHeight: mass.elevationM,
    roofMaterial: mass.roofMaterial,
    wallMaterial: mass.wallMaterial,
    seed: mass.facadeSeed,
    detailedMassing: false,
    facadeRate: mass.signageRate,
    neonWeights: mass.neonSlots,
    facadeProfile: mass.facadeProfile,
    roofline: mass.roofline,
    wear: mass.wear,
    rooftopUtilityRate: mass.rooftopUtilityRate,
    neonEnabled: mass.neonEnabled
  };
}


/**
 * Extent a kept mass's geometry can reach: footprint, shadow of its full height, and the
 * clutter boxes that sit on top of tall building masses (never landmark masses).
 */
function massOverhangPx(spec: BuildingSpec, pixelsPerMetre: number, withClutter: boolean): Rect[] {
  const footprint = ringBounds(spec.footprint);
  const topHeight =
    (spec.baseHeight ?? 0) + spec.height;
  const shadowHeight =
    topHeight + (withClutter && spec.height >= CLUTTER_MIN_BUILDING_M ? CLUTTER_MAX_HEIGHT_M : 0);
  return [footprint, shadowRectPx(footprint, shadowHeight, pixelsPerMetre)];
}

/**
 * Phase 4 block-scale infrastructure: bounded elevated connectors between compatible
 * nearby buildings inside one block. Deliberately sparse and typology-aware — never a
 * universal decoration. No signs, cars, street props or elevated citywide rail: every
 * connector is one `DetailPrism` deck rendered in the detail tier, so shadows and
 * culling bounds ride along with the existing detail pass.
 */
export type ConnectorKind = "skybridge" | "circulation" | "conduit";

/** One deterministic elevated connector between two buildings of the same block. */
export interface BlockConnector {
  id: string;
  blockId: string;
  kind: ConnectorKind;
  /** Endpoint building ids, in stable plan order. */
  aId: string;
  bId: string;
  /** Deck slab endpoints in plan metre space (world frame, same as mass footprints). */
  start: Vec2;
  end: Vec2;
  /** Deck slab vertical band in world metres. */
  deckBaseM: number;
  deckTopM: number;
  /** Deck slab width across the span, metres. */
  widthM: number;
  /** Horizontal deck length, metres. */
  spanM: number;
  material: number;
  seed: number;
  /**
   * Deterministic owner point. The chunk containing it (half-open, matching
   * `ownsCentroid`) emits the connector uncut, exactly like building ownership, so no
   * connector is ever duplicated across chunks.
   */
  midpoint: Vec2;
}

interface ConnectorConfig {
  kind: ConnectorKind;
  /** Deck slab width across the span, metres. */
  deckWidthM: number;
  /** Deck slab thickness, metres. */
  deckHeightM: number;
  /** Minimum shared vertical range between the two buildings, metres. */
  minOverlapM: number;
  /** Maximum horizontal span (centroid distance and deck length), metres. */
  maxSpanM: number;
  /** Deck bottom must clear the ground by at least this much, metres. */
  minClearanceM: number;
  /** Sparse per-block cap per kind. */
  budgetPerBlock: number;
  /** Both endpoint buildings must use one of these uses. */
  uses: Readonly<Partial<Record<BuildingUseId, true>>>;
}

/**
 * District families: corporate/commercial/civic may carry restrained enclosed
 * skybridges, residential megablocks/dense blocks utilitarian shared circulation
 * bridges, and industrial/logistics/utility sparse service conduits. Everything else
 * (night-market, old-city, waterfront, derelict, mixed-use, low-rise, unzoned) gets no
 * connectors.
 */
const SKYBRIDGE_DISTRICT_IDS: Readonly<Partial<Record<DistrictTypeId, true>>> = Object.freeze({
  "corporate-core": true,
  "commercial-highrise": true,
  "civic-institutional": true
});
const CIRCULATION_DISTRICT_IDS: Readonly<Partial<Record<DistrictTypeId, true>>> = Object.freeze({
  "residential-megablocks": true,
  "dense-residential": true
});
const CONDUIT_DISTRICT_IDS: Readonly<Partial<Record<DistrictTypeId, true>>> = Object.freeze({
  "heavy-industrial": true,
  "light-industrial": true,
  "logistics-port": true,
  "utility-infrastructure": true
});

const CONNECTOR_CONFIGS: Readonly<Record<ConnectorKind, ConnectorConfig>> = Object.freeze({
  skybridge: Object.freeze({
    kind: "skybridge",
    deckWidthM: 5.5,
    deckHeightM: 3.4,
    minOverlapM: 14,
    maxSpanM: 60,
    minClearanceM: 6,
    budgetPerBlock: 2,
    uses: Object.freeze({ commercial: true, civic: true, "mixed-use": true })
  }),
  circulation: Object.freeze({
    kind: "circulation",
    deckWidthM: 4,
    deckHeightM: 0.7,
    minOverlapM: 10,
    maxSpanM: 50,
    minClearanceM: 4.5,
    budgetPerBlock: 2,
    uses: Object.freeze({ residential: true, "mixed-use": true })
  }),
  conduit: Object.freeze({
    kind: "conduit",
    deckWidthM: 2.4,
    deckHeightM: 0.9,
    minOverlapM: 7,
    maxSpanM: 45,
    minClearanceM: 2.5,
    budgetPerBlock: 2,
    uses: Object.freeze({ industrial: true, logistics: true, utility: true })
  })
});

function connectorKindForDistrict(districtId: string | null): ConnectorKind | null {
  if (districtId !== null && SKYBRIDGE_DISTRICT_IDS[districtId as DistrictTypeId] === true) return "skybridge";
  if (districtId !== null && CIRCULATION_DISTRICT_IDS[districtId as DistrictTypeId] === true) return "circulation";
  if (districtId !== null && CONDUIT_DISTRICT_IDS[districtId as DistrictTypeId] === true) return "conduit";
  return null;
}

/** Union of every mass footprint of a building, in plan metre space. */
function buildingBoundsM(building: BuildingPlan): Rect {
  let bounds: Rect | null = null;
  for (const mass of building.masses) {
    const part = ringBounds(mass.footprint);
    bounds = bounds === null ? part : unionRect(bounds, part);
  }
  return bounds ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** Lowest base and highest top across a building's masses, in world metres. */
function buildingVerticalM(building: BuildingPlan): { baseM: number; topM: number } {
  let baseM = Number.POSITIVE_INFINITY;
  let topM = Number.NEGATIVE_INFINITY;
  for (const mass of building.masses) {
    baseM = Math.min(baseM, mass.elevationM);
    topM = Math.max(topM, mass.elevationM + mass.heightM);
  }
  return Number.isFinite(baseM) ? { baseM, topM } : { baseM: 0, topM: 0 };
}

/**
 * Both endpoints must share one district family (they may still sit in different
 * fragments of a mixed block), carry a compatible use, and be real buildings — micro
 * filler grammars never anchor infrastructure.
 */
function pairConnectorKind(a: BuildingPlan, b: BuildingPlan): ConnectorKind | null {
  if (MICRO_BUILDING_GRAMMAR_IDS.has(a.grammarId) || MICRO_BUILDING_GRAMMAR_IDS.has(b.grammarId)) {
    return null;
  }
  const kind = connectorKindForDistrict(a.districtId);
  if (kind === null || connectorKindForDistrict(b.districtId) !== kind) return null;
  const uses = CONNECTOR_CONFIGS[kind].uses;
  if (uses[a.visualUse] !== true || uses[b.visualUse] !== true) return null;
  return kind;
}

/**
 * Build one connector if the pair is plausible: a bounded horizontal span, a shared
 * vertical band deep enough for the deck, and a deck elevation deterministically placed
 * inside that band clear of the ground and of the lower roof.
 */
function makeConnector(
  a: BuildingPlan,
  b: BuildingPlan,
  kind: ConnectorKind,
  config: ConnectorConfig
): BlockConnector | null {
  const aRange = buildingVerticalM(a);
  const bRange = buildingVerticalM(b);
  const overlapM = Math.min(aRange.topM, bRange.topM) - Math.max(aRange.baseM, bRange.baseM);
  if (overlapM < config.minOverlapM) return null;

  const aBounds = buildingBoundsM(a);
  const bBounds = buildingBoundsM(b);
  const aCentre = { x: aBounds.x + aBounds.width / 2, y: aBounds.y + aBounds.height / 2 };
  const bCentre = { x: bBounds.x + bBounds.width / 2, y: bBounds.y + bBounds.height / 2 };
  const dx = bCentre.x - aCentre.x;
  const dy = bCentre.y - aCentre.y;
  const centreSpanM = Math.hypot(dx, dy);
  if (centreSpanM < 1e-6 || centreSpanM > config.maxSpanM) return null;
  const u = { x: dx / centreSpanM, y: dy / centreSpanM };

  // Support of each building's AABB along the span (exact for axis-aligned footprints,
  // conservative otherwise). The deck pokes 0.8 m past the facade line so the slab reads
  // attached instead of floating; buildings are opaque so the poke is hidden.
  const supportA = (aBounds.width / 2) * Math.abs(u.x) + (aBounds.height / 2) * Math.abs(u.y);
  const supportB = (bBounds.width / 2) * Math.abs(u.x) + (bBounds.height / 2) * Math.abs(u.y);
  const start = { x: aCentre.x + u.x * (supportA - 0.8), y: aCentre.y + u.y * (supportA - 0.8) };
  const end = { x: bCentre.x - u.x * (supportB - 0.8), y: bCentre.y - u.y * (supportB - 0.8) };
  const spanM = Math.hypot(end.x - start.x, end.y - start.y);
  if (spanM < 2 || spanM > config.maxSpanM) return null;

  const pairKey = `${a.id}|${b.id}`;
  const salt = fnv1a(pairKey);
  const ratio = 0.35 + hash2(salt, 11) * 0.4;
  const maxBaseM = Math.max(aRange.baseM, bRange.baseM);
  const minTopM = Math.min(aRange.topM, bRange.topM);
  const deckBaseM = maxBaseM + ratio * (overlapM - config.deckHeightM);
  const deckTopM = deckBaseM + config.deckHeightM;
  if (deckBaseM - maxBaseM < config.minClearanceM) return null;
  if (deckTopM > minTopM - 0.5) return null;

  // Deterministic anchor building for the deck material; the material itself is the
  // grammar-produced mass finish (roof for conduits, wall for enclosed decks).
  const anchor = a.id < b.id ? a : b;
  const primary = anchor.masses[0]!;
  return {
    id: `con_${fnv1a(pairKey).toString(16).padStart(8, "0")}`,
    blockId: a.blockId,
    kind,
    aId: a.id,
    bId: b.id,
    start,
    end,
    deckBaseM,
    deckTopM,
    widthM: config.deckWidthM,
    spanM,
    material: kind === "conduit" ? primary.roofMaterial : primary.wallMaterial,
    seed: hash2(salt, 5),
    midpoint: { x: (aCentre.x + bCentre.x) / 2, y: (aCentre.y + bCentre.y) / 2 }
  };
}

/**
 * The plan-wide connector set: same-block eligible pairs, ranked by a pure hash of the
 * pair id and cut at each kind's sparse per-block budget. Blocks are road-network faces,
 * so a same-block pair can never have a vehicle road between its endpoints. Deterministic
 * in every chunk, which is what lets one owner emit each connector.
 */
function planConnectors(plan: CompleteCityPlan): readonly BlockConnector[] {
  const byBlock = new Map<string, BuildingPlan[]>();
  for (const building of plan.buildings) {
    const list = byBlock.get(building.blockId);
    if (list === undefined) byBlock.set(building.blockId, [building]);
    else list.push(building);
  }
  const kept: BlockConnector[] = [];
  for (const [, buildings] of byBlock) {
    const eligible: BlockConnector[] = [];
    for (let i = 0; i < buildings.length; i++) {
      const a = buildings[i]!;
      if (a.masses.length === 0) continue;
      for (let j = i + 1; j < buildings.length; j++) {
        const b = buildings[j]!;
        if (b.masses.length === 0) continue;
        const kind = pairConnectorKind(a, b);
        if (kind === null) continue;
        const connector = makeConnector(a, b, kind, CONNECTOR_CONFIGS[kind]);
        if (connector !== null) eligible.push(connector);
      }
    }
    eligible.sort(
      (p, q) =>
        hash2(fnv1a(p.id), 3) - hash2(fnv1a(q.id), 3) ||
        (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)
    );
    const spent: Partial<Record<ConnectorKind, number>> = {};
    for (const connector of eligible) {
      const used = spent[connector.kind] ?? 0;
      if (used >= CONNECTOR_CONFIGS[connector.kind].budgetPerBlock) continue;
      spent[connector.kind] = used + 1;
      kept.push(connector);
    }
  }
  return kept;
}

/**
 * The connector set depends only on the plan, so it is derived once per plan object and
 * shared by every chunk build of that plan (the batch already shares the surface
 * derivation the same way). The WeakMap key keeps the public chunk signature unchanged.
 */
const planConnectorCache = new WeakMap<CompleteCityPlan, readonly BlockConnector[]>();

function connectorsForPlan(plan: CompleteCityPlan): readonly BlockConnector[] {
  let connectors = planConnectorCache.get(plan);
  if (connectors === undefined) {
    connectors = planConnectors(plan);
    planConnectorCache.set(plan, connectors);
  }
  return connectors;
}

/**
 * One elevated connector as a single `DetailPrism` slab: a solid deck (enclosed for
 * skybridges, a thin deck for circulation bridges, a narrow box for conduits) rendered
 * in the detail tier with the standard 10-triangle prism.
 */
function connectorPrism(connector: BlockConnector, origin: Vec2, pixelsPerMetre: number): MeshBuffers {
  const ux = (connector.end.x - connector.start.x) / connector.spanM;
  const uy = (connector.end.y - connector.start.y) / connector.spanM;
  const halfWidth = connector.widthM / 2;
  const footprint: Ring = [
    { x: connector.start.x - uy * halfWidth, y: connector.start.y + ux * halfWidth },
    { x: connector.start.x + uy * halfWidth, y: connector.start.y - ux * halfWidth },
    { x: connector.end.x + uy * halfWidth, y: connector.end.y - ux * halfWidth },
    { x: connector.end.x - uy * halfWidth, y: connector.end.y + ux * halfWidth }
  ];
  return prismMesh({
    footprint: toPixelsRing(footprint, origin, pixelsPerMetre),
    baseHeight: connector.deckBaseM,
    topHeight: connector.deckTopM,
    material: connector.material,
    seed: connector.seed
  });
}

export function buildCompleteCityChunk(
  source: CitySourceV3,
  plan: CompleteCityPlan,
  key: ChunkKey,
  sceneBoundsM: Rect,
  pixelsPerMetre: number,
  surfaces?: CitySurfacePartitions
): CompleteChunkBuild {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) {
    throw new Error("Pixels per metre must be positive and finite.");
  }
  const origin = source.origin;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    throw new Error("City origin must be finite.");
  }

  const boundsM = chunkRect(key);
  const chunkPx = toPixelsRect(boundsM, origin, pixelsPerMetre);
  const empty: CompleteChunkBuild = {
    key,
    id: chunkId(key),
    boundsM,
    boundsPx: chunkPx,
    mesh: emptyMesh(),
    detail: emptyMesh(),
    neon: emptyMesh(),
    surfaces: emptySurfaces(),
    buildingIds: [],
    landmarkIds: [],
    connectors: [],
    buildingCount: 0,
    landmarkCount: 0,
    connectorCount: 0,
    openSpaceCount: 0,
    waterTriangleCount: 0,
    exposedLandTriangleCount: 0,
    vehicleTriangleCount: 0,
    sidewalkTriangleCount: 0,
    nonVehicleTriangleCount: 0,
    markingTriangleCount: 0,
    openSpaceTriangleCount: 0
  };

  const clip = intersectRect(boundsM, sceneBoundsM);
  if (clip.width <= 0 || clip.height <= 0) return empty;

  // Flat surfaces are seamless, so a hard clip at the chunk edge cannot show.
  const all = surfaces ?? citySurfaces(source, sceneBoundsM);
  const clipped = toPixelsSurfaces(clipSurfaces(all, clip), origin, pixelsPerMetre);
  const openSpaces: { plan: OpenSpacePlan; polygon: MultiPolygon }[] = [];
  for (const openSpace of plan.openSpaces) {
    const polygon = intersection(ringAsMulti(openSpace.polygon), ringAsMulti(rectRing(clip)));
    if (polygon.length > 0) openSpaces.push({ plan: openSpace, polygon });
  }
  const { meshes: openSpaceMeshes_, triangles: openSpaceTriangles, count: openSpaceCount } = openSpaceMeshes(openSpaces, origin, pixelsPerMetre);

  // Buildings are owned by their parcel's centroid, landmarks by their site's, never
  // clipped: a lot straddling the seam has to be cut by the road, not by the chunk.
  const parcelByBuilding = new Map(plan.parcels.map((parcel) => [parcel.id, parcel]));
  const ownedBuildings: BuildingPlan[] = [];
  const ownedLandmarks: LandmarkPlan[] = [];
  for (const building of plan.buildings) {
    const parcel = parcelByBuilding.get(building.parcelId);
    if (parcel !== undefined && ownsCentroid(boundsM, ringCentroid(parcel.polygon))) {
      ownedBuildings.push(building);
    }
  }
  for (const landmark of plan.landmarks) {
    if (ownsCentroid(boundsM, ringCentroid(landmark.sitePolygon))) ownedLandmarks.push(landmark);
  }

  const buildingSpecs = ownedBuildings.flatMap((building) =>
    building.masses.map((mass) => massSpec(mass, origin, pixelsPerMetre))
  );
  const landmarkSpecs = ownedLandmarks.flatMap((landmark) =>
    landmark.masses.map((mass) => massSpec(mass, origin, pixelsPerMetre))
  );

  // WHY: silhouette policy keeps motion cheap without leaving false opaque geometry in the settled view.
  const silhouetteBuildings = new Set(
    ownedBuildings
      .filter((building) => (BUILDING_GRAMMAR_REGISTRY.get(building.grammarId)?.geometryPolicy.coarse ?? "volumes") === "silhouette")
      .map((building) => building.id)
  );
  const silhouetteLandmarks = new Set(
    ownedLandmarks
      .filter((landmark) => (LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId)?.geometryPolicy.coarse ?? "volumes") === "silhouette")
      .map((landmark) => landmark.id)
  );
  const coarseBuildingSpecs = ownedBuildings.flatMap((building) =>
    (silhouetteBuildings.has(building.id) ? building.masses.slice(0, 1) : building.masses)
      .map((mass) => massSpec(mass, origin, pixelsPerMetre))
  );
  const coarseLandmarkSpecs = ownedLandmarks.flatMap((landmark) =>
    (silhouetteLandmarks.has(landmark.id) ? landmark.masses.slice(0, 1) : landmark.masses)
      .map((mass) => massSpec(mass, origin, pixelsPerMetre))
  );
  const silhouetteVolumeSpecs = [
    ...ownedBuildings
      .filter((building) => silhouetteBuildings.has(building.id))
      .flatMap((building) => building.masses.slice(1).map((mass) => massSpec(mass, origin, pixelsPerMetre))),
    ...ownedLandmarks
      .filter((landmark) => silhouetteLandmarks.has(landmark.id))
      .flatMap((landmark) => landmark.masses.slice(1).map((mass) => massSpec(mass, origin, pixelsPerMetre)))
  ];

  const surfaceParts = [
    flatMesh(clipped.water, 0, MATERIAL.WATER, 1),
    flatMesh(clipped.exposedLand, 0, MATERIAL.GROUND, 1),
    flatMesh(clipped.vehicleCarriageway, 0, MATERIAL.ROAD, 1),
    flatMesh(clipped.vehicleSidewalk, 0, MATERIAL.SIDEWALK, 1),
    flatMesh(clipped.nonVehicleRoute, 0, MATERIAL.NON_VEHICLE_ROUTE, 1),
    flatMesh(clipped.gutters, 0.021, MATERIAL.ROAD, 0.62),
    flatMesh(clipped.repairs, 0.022, MATERIAL.ROAD, 0.82),
    flatMesh(clipped.repairHighlights, 0.023, MATERIAL.ROAD, 1.12),
    flatMesh(clipped.drains, 0.03, MATERIAL.GROUND, 0.52),
    flatMesh(clipped.curbHighlights, 0.04, MATERIAL.KERB, 1.08),
    flatMesh(clipped.laneMarkings, 0.05, MATERIAL.LANE_MARK, 1),
    flatMesh(clipped.crossings, 0.05, MATERIAL.CROSSING, 1),
    flatMesh(clipped.kerbs, 0.05, MATERIAL.KERB, 1)
  ];
  const mesh = mergeMeshes([
    ...surfaceParts,
    ...openSpaceMeshes_,
    ...coarseBuildingSpecs.map((spec) => extrudeBuilding(spec, pixelsPerMetre)),
    ...coarseLandmarkSpecs.map((spec) => extrudeBuilding(spec, pixelsPerMetre)),
    clutterMesh(buildingSpecs, pixelsPerMetre)
  ]);
  const detailBuildingSpecs = ownedBuildings.flatMap((building) =>
    building.masses
      .filter((mass) => mass.detailPolicy === "detail" || mass.detailPolicy === "both")
      .map((mass) => massSpec(mass, origin, pixelsPerMetre))
  );
  const detailLandmarkSpecs = ownedLandmarks.flatMap((landmark) =>
    landmark.masses
      .filter((mass) => mass.detailPolicy === "detail" || mass.detailPolicy === "both")
      .map((mass) => massSpec(mass, origin, pixelsPerMetre))
  );
  // Connectors are owned by their midpoint's chunk, never clipped, exactly like
  // buildings — a connector spanning the seam is emitted uncut by its owner.
  const connectors = connectorsForPlan(plan).filter((connector) =>
    ownsCentroid(boundsM, connector.midpoint)
  );
  const detail = mergeMeshes([
    buildingDetailMesh(detailBuildingSpecs, pixelsPerMetre),
    buildingDetailMesh(detailLandmarkSpecs, pixelsPerMetre),
    openSpaceDetailMesh(openSpaces, origin, pixelsPerMetre),
    ...silhouetteVolumeSpecs.map((spec) => extrudeBuilding(spec, pixelsPerMetre)),
    ...connectors.map((connector) => connectorPrism(connector, origin, pixelsPerMetre))
  ]);
  const neon = neonMesh([...buildingSpecs, ...landmarkSpecs], pixelsPerMetre);

  // Culling bounds: the nominal chunk rect plus everything that overhangs it — kept
  // footprints, their shadows, the detail tier and the neon glow quads.
  let boundsPx = chunkPx;
  for (const spec of buildingSpecs) {
    for (const part of massOverhangPx(spec, pixelsPerMetre, true)) boundsPx = unionRect(boundsPx, part);
  }
  for (const spec of landmarkSpecs) {
    for (const part of massOverhangPx(spec, pixelsPerMetre, false)) boundsPx = unionRect(boundsPx, part);
  }
  const detailBounds = meshBoundsPx(detail);
  if (detailBounds !== null) {
    boundsPx = unionRect(boundsPx, detailBounds);
    boundsPx = unionRect(boundsPx, shadowRectPx(detailBounds, meshMaxHeightM(detail), pixelsPerMetre));
  }
  const neonBounds = meshBoundsPx(neon);
  if (neonBounds !== null) boundsPx = unionRect(boundsPx, neonBounds);

  return {
    key,
    id: chunkId(key),
    boundsM: toMetresRect(boundsPx, origin, pixelsPerMetre),
    boundsPx,
    mesh,
    detail,
    neon,
    surfaces: clipSurfaces(all, clip),
    buildingIds: ownedBuildings.map((building) => building.id),
    landmarkIds: ownedLandmarks.map((landmark) => landmark.id),
    connectors,
    buildingCount: ownedBuildings.length,
    landmarkCount: ownedLandmarks.length,
    connectorCount: connectors.length,
    openSpaceCount,
    waterTriangleCount: surfaceParts[0]!.triangleCount,
    exposedLandTriangleCount: surfaceParts[1]!.triangleCount,
    vehicleTriangleCount: surfaceParts[2]!.triangleCount,
    sidewalkTriangleCount: surfaceParts[3]!.triangleCount,
    nonVehicleTriangleCount: surfaceParts[4]!.triangleCount,
    markingTriangleCount: surfaceParts.slice(5).reduce((sum, part) => sum + part.triangleCount, 0),
    openSpaceTriangleCount: openSpaceTriangles
  };
}

/**
 * Incremental handle over one complete-city-chunk batch: the plan is validated and the
 * shared city surfaces compiled exactly once at open, then `buildNext` produces one chunk
 * at a time in stable key order. Workers drain this to post each chunk as soon as it is
 * built; `buildCompleteCityChunks` is the plain full-batch aggregation over the same path.
 */
export interface CompleteChunkBatch {
  /** Chunks not yet produced, including the one `buildNext` returns next. */
  readonly remaining: number;
  /** Build the next chunk in stable key order; throws once exhausted. */
  buildNext(): CompleteChunkBuild;
}

export function openCompleteCityChunkBatch(
  source: CitySourceV3,
  plan: CompleteCityPlan,
  keys: ChunkKey[],
  sceneBoundsM: Rect,
  pixelsPerMetre: number
): CompleteChunkBatch {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) {
    throw new Error("Pixels per metre must be positive and finite.");
  }
  const origin = source.origin;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    throw new Error("City origin must be finite.");
  }
  const problems = validateCompleteCityPlan(plan);
  if (problems.length > 0) {
    throw new Error(`Complete city plan is invalid: ${problems[0]}`);
  }

  // One surface derivation per batch, exactly like the Phase 1-3 chunk batch.
  const surfaces = citySurfaces(source, sceneBoundsM);
  let next = 0;
  return {
    get remaining(): number {
      return keys.length - next;
    },
    buildNext(): CompleteChunkBuild {
      if (next >= keys.length) {
        throw new Error("Complete city chunk batch is exhausted.");
      }
      const build = buildCompleteCityChunk(
        source,
        plan,
        keys[next]!,
        sceneBoundsM,
        pixelsPerMetre,
        surfaces
      );
      next += 1;
      return build;
    }
  };
}

export function buildCompleteCityChunks(
  source: CitySourceV3,
  plan: CompleteCityPlan,
  keys: ChunkKey[],
  sceneBoundsM: Rect,
  pixelsPerMetre: number
): CompleteChunksBuild {
  const batch = openCompleteCityChunkBatch(source, plan, keys, sceneBoundsM, pixelsPerMetre);
  const chunks: CompleteChunkBuild[] = [];
  while (batch.remaining > 0) chunks.push(batch.buildNext());
  return {
    chunks,
    buildingCount: chunks.reduce((sum, chunk) => sum + chunk.buildingCount, 0),
    landmarkCount: chunks.reduce((sum, chunk) => sum + chunk.landmarkCount, 0),
    connectorCount: chunks.reduce((sum, chunk) => sum + chunk.connectorCount, 0),
    openSpaceCount: chunks.reduce((sum, chunk) => sum + chunk.openSpaceCount, 0),
    markingTriangleCount: chunks.reduce((sum, chunk) => sum + chunk.markingTriangleCount, 0),
    vertexCount: chunks.reduce(
      (sum, chunk) => sum + chunk.mesh.vertexCount + chunk.detail.vertexCount + chunk.neon.vertexCount,
      0
    ),
    triangleCount: chunks.reduce(
      (sum, chunk) => sum + chunk.mesh.triangleCount + chunk.detail.triangleCount + chunk.neon.triangleCount,
      0
    ),
    bytes: chunks.reduce(
      (sum, chunk) =>
        sum +
        chunk.mesh.vertices.byteLength +
        chunk.mesh.indices.byteLength +
        chunk.detail.vertices.byteLength +
        chunk.detail.indices.byteLength +
        chunk.neon.vertices.byteLength +
        chunk.neon.indices.byteLength,
      0
    )
  };
}
