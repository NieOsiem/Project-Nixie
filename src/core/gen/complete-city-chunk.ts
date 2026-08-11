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
import { BUILDING_GRAMMAR_REGISTRY } from "./building-registry.js";
import { LANDMARK_GRAMMAR_REGISTRY } from "./landmark-registry.js";
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
  buildingCount: number;
  landmarkCount: number;
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
    kerbs: []
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
    kerbs: intersection(surfaces.kerbs, box)
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
    kerbs: convert(surfaces.kerbs)
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
    const mesh = flatMesh(polygon, 0, material, shade);
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
    buildingCount: 0,
    landmarkCount: 0,
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
  const detail = mergeMeshes([
    buildingDetailMesh(detailBuildingSpecs, pixelsPerMetre),
    buildingDetailMesh(detailLandmarkSpecs, pixelsPerMetre),
    openSpaceDetailMesh(openSpaces, origin, pixelsPerMetre),
    ...silhouetteVolumeSpecs.map((spec) => extrudeBuilding(spec, pixelsPerMetre))
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
    buildingCount: ownedBuildings.length,
    landmarkCount: ownedLandmarks.length,
    openSpaceCount,
    waterTriangleCount: surfaceParts[0]!.triangleCount,
    exposedLandTriangleCount: surfaceParts[1]!.triangleCount,
    vehicleTriangleCount: surfaceParts[2]!.triangleCount,
    sidewalkTriangleCount: surfaceParts[3]!.triangleCount,
    nonVehicleTriangleCount: surfaceParts[4]!.triangleCount,
    markingTriangleCount:
      surfaceParts[5]!.triangleCount + surfaceParts[6]!.triangleCount + surfaceParts[7]!.triangleCount,
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
