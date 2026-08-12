import { difference, intersection, isSnapNoise, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, rectsIntersect, ringArea, ringBounds, ringCentroid, type MultiPolygon, type Rect, type Ring, type Vec2 } from "../geom/types.js";
import { compileRouteNetwork, type CompiledRouteNetwork } from "../graph/compiler.js";
import { BASE_BANK, BANK_COUNT, DISTRICT_SLOT, FIRST_ZONE_BANK, MATERIAL, materialIndex } from "../palette.js";
import { isRecord, ROUTE_CLASS_REGISTRY, type CitySourceV3, type DistrictOpenSpaceProfile, type DistrictSource, type OpenSpaceCategory, type OpenSpaceSize, type RouteClassId } from "./city.js";
import { buildDistrictPlan, canonicalHoleFreePieces, compiledRouteOccupancy, districtStructuralInputSignature, type DevelopmentCellPlan, type DistrictBlockFragment, type DistrictPlan, type RouteOccupancy, type StructuralInputSignature } from "./district-plan.js";
import { DISTRICT_TYPE_REGISTRY } from "./district-registry.js";
import { BUILDING_GRAMMAR_IDS, BUILDING_GRAMMAR_REGISTRY, BUILDING_USE_IDS, MICRO_BUILDING_GRAMMAR_IDS, UNZONED_BUILDING_GRAMMAR_WEIGHTS, type BuildingGrammarDefinition, type BuildingGrammarId, type BuildingUseId, type FootprintArchetypeId, type WeightPair, type WeightTriple } from "./building-registry.js";
import { LANDMARK_GRAMMAR_IDS, LANDMARK_GRAMMAR_REGISTRY, type LandmarkGrammarDefinition, type LandmarkGrammarId, type LandmarkMassTemplate } from "./landmark-registry.js";
import { normalizeRing, validateRing } from "./terrain.js";

const GEOMETRY_EPSILON = 1e-6;
const KEY_SCALE = 1_000;
// Lowered from 100 to 16 to match the smallest micro grammar (street-kiosk). The old
// 100 m² floor discarded the fine-grain fabric (night-market and old-city cells run
// 5-16 m wide), leaving those districts as empty ground; micro grammars now fill
// parcels down to 16 m² and everything smaller stays explicitly unbuilt.
export const MIN_PARCEL_AREA_M2 = 16;
const MIN_OPEN_SPACE_AREA_M2 = 25;

/** Deterministic open-space material slot per category (shared with the renderer contract). */
const OPEN_SPACE_SLOTS: Readonly<Record<OpenSpaceCategory, number>> = Object.freeze({
  park: DISTRICT_SLOT.ROOF_A,
  plaza: DISTRICT_SLOT.WALL_A,
  parking: DISTRICT_SLOT.WALL_B,
  vacant: DISTRICT_SLOT.WALL_C,
  utility: DISTRICT_SLOT.ROOF_B,
  landscaping: DISTRICT_SLOT.ROOF_C,
  "service-yard": DISTRICT_SLOT.ROOF_A
});

const OPEN_SPACE_SURFACE_STYLES: Readonly<Record<OpenSpaceCategory, string>> = Object.freeze({
  park: "grass",
  plaza: "paving",
  parking: "tarmac",
  vacant: "scrub",
  utility: "concrete",
  landscaping: "planting",
  "service-yard": "gravel"
});

const OPEN_SPACE_DETAIL_STYLES: Readonly<Record<OpenSpaceCategory, string>> = Object.freeze({
  park: "trees",
  plaza: "benches",
  parking: "markings",
  vacant: "none",
  utility: "utility-structures",
  landscaping: "planters",
  "service-yard": "bins"
});

const UNZONED_VISUAL_USE_WEIGHTS: Readonly<Record<BuildingUseId, number>> = Object.freeze({
  residential: 0.4,
  commercial: 0,
  "mixed-use": 0,
  industrial: 0.3,
  logistics: 0,
  civic: 0,
  entertainment: 0,
  utility: 0.3
});

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

function hashUnit(text: string): number {
  return fnv1a(text) / 0x1_0000_0000;
}

function stableId(prefix: string, material: string): string {
  return `${prefix}_${fnv1a(material).toString(16).padStart(8, "0")}`;
}

function range(seed: string, min: number, max: number): number {
  return min + (max - min) * hashUnit(seed);
}

function pointKey(point: Vec2): string {
  return `${Math.round(point.x * KEY_SCALE)},${Math.round(point.y * KEY_SCALE)}`;
}

/** Full canonical vertex signature of a hole-free piece; ids must never collide on it. */
function ringKey(ring: Ring): string {
  return ring.map((point) => pointKey(point)).join(";");
}

function rotatePoint(point: Vec2, origin: Vec2, angle: number): Vec2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  return { x: origin.x + x * cosine - y * sine, y: origin.y + x * sine + y * cosine };
}

function longestEdgeAngle(ring: Ring): number {
  let bestLength = -1;
  let bestAngle = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (length > bestLength + GEOMETRY_EPSILON || (Math.abs(length - bestLength) <= GEOMETRY_EPSILON && angle < bestAngle)) {
      bestLength = length;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

function multiArea(multi: MultiPolygon): number {
  return multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);
}

function largestPiece(multi: MultiPolygon): Ring | null {
  let best: Ring | null = null;
  let bestArea = 0;
  for (const polygon of multi) {
    if (polygon.length === 0) continue;
    const ring = polygon[0]!;
    const area = Math.abs(ringArea(ring));
    if (area > bestArea) {
      best = ring;
      bestArea = area;
    }
  }
  return best;
}

function rectAt(centre: Vec2, width: number, height: number, angle: number): Ring {
  const ring = rectRing({ x: centre.x - width / 2, y: centre.y - height / 2, width, height });
  return angle === 0 ? ring : ring.map((point) => rotatePoint(point, centre, angle));
}

function edgeQuad(a: Vec2, b: Vec2, halfWidth: number): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= GEOMETRY_EPSILON || halfWidth <= 0) return [];
  const nx = (-dy / length) * halfWidth;
  const ny = (dx / length) * halfWidth;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }];
}

function nodeDisc(center: Vec2, radius: number): Ring {
  return Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

function carriagewayPolygons(network: CompiledRouteNetwork): MultiPolygon {
  const parts: MultiPolygon[] = [];
  const radii = new Map<string, { point: Vec2; radius: number }>();
  for (const span of network.segments) {
    const cls = ROUTE_CLASS_REGISTRY.get(span.classId as RouteClassId);
    if (!cls || !cls.vehicle || span.lengthM <= GEOMETRY_EPSILON) continue;
    const halfWidth = cls.widthM / 2;
    parts.push(ringAsMulti(edgeQuad(span.a, span.b, halfWidth)));
    for (const point of [span.a, span.b]) {
      const key = pointKey(point);
      const previous = radii.get(key);
      if (!previous || halfWidth > previous.radius) radii.set(key, { point, radius: halfWidth });
    }
  }
  for (const endpoint of radii.values()) parts.push(ringAsMulti(nodeDisc(endpoint.point, endpoint.radius)));
  return union(parts);
}

function weightedChoice<T extends string>(weights: Readonly<Record<T, number>>, values: readonly T[], seed: string): T {
  const total = values.reduce((sum, value) => sum + Math.max(0, weights[value]), 0);
  let cursor = hashUnit(seed) * total;
  for (const value of values) {
    cursor -= Math.max(0, weights[value]);
    if (cursor < 0) return value;
  }
  return values[0]!;
}

/**
 * Pure district building-grammar selection used by the planner; exported so fixed
 * breadth fixtures can prove every shipping grammar is reachable deterministically.
 */
export function selectBuildingGrammar(weights: Readonly<Record<BuildingGrammarId, number>>, seed: string): BuildingGrammarId {
  const active = BUILDING_GRAMMAR_IDS.filter((id) => (weights[id] ?? 0) > 0);
  return weightedChoice(weights, active.length > 0 ? active : BUILDING_GRAMMAR_IDS, seed);
}

function weightedIndex(weights: readonly number[], seed: string): number {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  let cursor = hashUnit(seed) * total;
  for (let index = 0; index < weights.length; index++) {
    cursor -= Math.max(0, weights[index]!);
    if (cursor < 0) return index;
  }
  return weights.length - 1;
}

function parcelLocalBounds(parcel: { polygon: Ring; frontageAngleRad: number }): { width: number; depth: number } {
  const centre = ringCentroid(parcel.polygon);
  const local = parcel.polygon.map((point) => rotatePoint(point, centre, -parcel.frontageAngleRad));
  const bounds = ringBounds(local);
  return { width: bounds.width, depth: bounds.height };
}

/**
 * Strict declared-limits fit check shared by planning and the validator: parcel area,
 * local width/depth, aspect ratio, and declared-setback feasibility. No slack beyond the
 * declared contract, so a chosen grammar always genuinely fits its parcel.
 */
function grammarFitsParcel(
  grammar: BuildingGrammarDefinition,
  parcel: { polygon: Ring; frontageAngleRad: number; areaM2: number; seed: string }
): boolean {
  const limits = grammar.siteLimits;
  const { width, depth } = parcelLocalBounds(parcel);
  if (!(parcel.areaM2 >= limits.minAreaM2 && parcel.areaM2 <= limits.maxAreaM2)) return false;
  if (!(width >= limits.minWidthM && width <= limits.maxWidthM)) return false;
  if (!(depth >= limits.minDepthM && depth <= limits.maxDepthM)) return false;
  const aspect = width / depth;
  if (!(aspect >= limits.minAspect && aspect <= limits.maxAspect)) return false;
  const setbackM = range(`${parcel.seed}/setback`, grammar.footprint.setbackMin, grammar.footprint.setbackMax);
  return width - 2 * setbackM > GEOMETRY_EPSILON && depth - 2 * setbackM > GEOMETRY_EPSILON;
}

/** Shrink a rect toward its own centroid until it sits inside the container, or null. */
function fitRectInside(rect: Ring, container: MultiPolygon): Ring | null {
  const initialArea = Math.abs(ringArea(rect));
  if (initialArea <= GEOMETRY_EPSILON) return null;
  const centre = ringCentroid(rect);
  let current = rect;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (Math.abs(ringArea(current)) < initialArea * 0.5) return null;
    if (isSnapNoise(difference(ringAsMulti(current), [container]))) return current;
    const factor = attempt === 0 ? 0.92 : 0.88;
    current = current.map((point) => ({ x: centre.x + (point.x - centre.x) * factor, y: centre.y + (point.y - centre.y) * factor }));
  }
  return null;
}

/**
 * Which side of a parcel's local frame faces its frontage road. "u" is the parcel's
 * width axis (parallel to frontageAngleRad), "v" its depth axis; sign picks the
 * low/high side. Parcels without road contact (interior remainders) get null.
 * angleRad, when present, is the frontage edge's own direction (from the parcel edge
 * segment that borders the corridor) — fronted masses rotate to it so buildings sit
 * parallel to their street even when the cell frame is diagonal to it.
 */
export interface FrontageSide {
  axis: "u" | "v";
  sign: 1 | -1;
  angleRad?: number;
}

/** Re-express a frontage side from one local frame's angle into another's. */
function frontageInFrame(frontage: FrontageSide, fromAngleRad: number, toAngleRad: number): FrontageSide {
  const localDir = frontage.axis === "u" ? { x: frontage.sign, y: 0 } : { x: 0, y: frontage.sign };
  const world = rotatePoint(localDir, { x: 0, y: 0 }, fromAngleRad);
  const back = rotatePoint(world, { x: 0, y: 0 }, -toAngleRad);
  if (Math.abs(back.x) >= Math.abs(back.y)) return { axis: "u", sign: back.x >= 0 ? 1 : -1 };
  return { axis: "v", sign: back.y >= 0 ? 1 : -1 };
}

interface OccBox {
  box: Rect;
  polygon: MultiPolygon[number];
}

function occupancyBoxes(occupancy: MultiPolygon): OccBox[] {
  return occupancy
    .filter((polygon) => polygon.length > 0 && polygon[0]!.length >= 3)
    .map((polygon) => ({ box: ringBounds(polygon[0]!), polygon }));
}

/**
 * Deterministic frontage detection: probe each side of the parcel's local AABB outward
 * by 4 m and test overlap with the road clearance occupancy. The side whose probe
 * overlaps most is the frontage. Parcels were carved against the same occupancy, so a
 * road-adjacent side always overlaps; interior parcels overlap nothing and stay null.
 */
function detectFrontage(parcel: { polygon: Ring; frontageAngleRad: number }, boxes: OccBox[]): FrontageSide | null {
  const centre = ringCentroid(parcel.polygon);
  const angle = parcel.frontageAngleRad;
  const local = parcel.polygon.map((point) => rotatePoint(point, centre, -angle));
  const bounds = ringBounds(local);
  const PROBE_DEPTH_M = 4;
  let bestSide: FrontageSide | null = null;
  let bestAreaM2 = 0;
  const probeArea = (axis: "u" | "v", sign: 1 | -1): number => {
    const rect: Ring =
      axis === "u"
        ? (sign < 0
          ? rectRing({ x: bounds.x - PROBE_DEPTH_M, y: bounds.y, width: PROBE_DEPTH_M, height: bounds.height })
          : rectRing({ x: bounds.x + bounds.width, y: bounds.y, width: PROBE_DEPTH_M, height: bounds.height }))
        : (sign < 0
          ? rectRing({ x: bounds.x, y: bounds.y - PROBE_DEPTH_M, width: bounds.width, height: PROBE_DEPTH_M })
          : rectRing({ x: bounds.x, y: bounds.y + bounds.height, width: bounds.width, height: PROBE_DEPTH_M }));
    const world = rect.map((point) => rotatePoint(point, centre, angle));
    const probeBox = ringBounds(world);
    let areaM2 = 0;
    for (const entry of boxes) {
      if (!rectsIntersect(probeBox, entry.box)) continue;
      areaM2 += multiArea(intersection(ringAsMulti(world), [entry.polygon]));
    }
    return areaM2;
  };
  for (const [axis, sign] of [["u", -1], ["u", 1], ["v", -1], ["v", 1]] as const) {
    const areaM2 = probeArea(axis, sign);
    if (areaM2 > 0.5 && areaM2 > bestAreaM2) {
      bestAreaM2 = areaM2;
      bestSide = { axis, sign };
    }
  }
  if (bestSide === null) return null;
  const winner: FrontageSide = bestSide;
  // The winning side's own edge direction: average the parcel edges that lie on that
  // side of the local AABB. Fronted masses rotate to this so buildings sit parallel
  // to their street even in diagonal cells.
  const sideLine = winner.axis === "u" ? (winner.sign < 0 ? bounds.x : bounds.x + bounds.width) : (winner.sign < 0 ? bounds.y : bounds.y + bounds.height);
  let dxSum = 0;
  let dySum = 0;
  for (let index = 0; index < parcel.polygon.length; index++) {
    const a = parcel.polygon[index]!;
    const b = parcel.polygon[(index + 1) % parcel.polygon.length]!;
    const la = rotatePoint(a, centre, -angle);
    const lb = rotatePoint(b, centre, -angle);
    const mid = winner.axis === "u" ? (la.y + lb.y) / 2 : (la.x + lb.x) / 2;
    if (Math.abs(mid - sideLine) > 1.5) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.5) continue;
    dxSum += (b.x - a.x) / len;
    dySum += (b.y - a.y) / len;
  }
  if (dxSum * dxSum + dySum * dySum > 1e-6) {
    winner.angleRad = Math.atan2(dySum, dxSum);
  }
  return winner;
}

/**
 * Shrink a rect toward its frontage edge (not its centroid) until it sits inside the
 * container, so street-wall masses stay flush to the road side while conforming to
 * irregular parcels. The lateral axis scales toward the rect's own midline.
 */
function fitRectPinned(rect: Ring, container: MultiPolygon, frontage: FrontageSide, angle: number, centre: Vec2): Ring | null {
  const initialArea = Math.abs(ringArea(rect));
  if (initialArea <= GEOMETRY_EPSILON) return null;
  let current = rect;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (Math.abs(ringArea(current)) < initialArea * 0.3) return null;
    if (isSnapNoise(difference(ringAsMulti(current), [container]))) return current;
    const local = current.map((point) => rotatePoint(point, centre, -angle));
    const lb = ringBounds(local);
    const factor = attempt === 0 ? 0.94 : 0.9;
    const next: Ring = local.map((point) => {
      const front = frontage.axis === "v" ? (frontage.sign < 0 ? lb.y : lb.y + lb.height) : (frontage.sign < 0 ? lb.x : lb.x + lb.width);
      const lateralC = frontage.axis === "v" ? lb.x + lb.width / 2 : lb.y + lb.height / 2;
      const pinned = frontage.axis === "v" ? point.y : point.x;
      const lateral = frontage.axis === "v" ? point.x : point.y;
      const p = front + (pinned - front) * factor;
      const l = lateralC + (lateral - lateralC) * factor;
      const x = frontage.axis === "v" ? l : p;
      const y = frontage.axis === "v" ? p : l;
      return rotatePoint({ x, y }, centre, angle);
    });
    current = next;
  }
  return null;
}

/** Local-frame rectangle: (x, y, w, h) are offsets inside `bounds`; the rect is rotated back to world. */
function localRect(bounds: Rect, angle: number, origin: Vec2, x: number, y: number, w: number, h: number): Ring {
  const rect = rectRing({ x: bounds.x + x, y: bounds.y + y, width: w, height: h });
  return angle === 0 ? rect : rect.map((point) => rotatePoint(point, origin, angle));
}

export interface PaletteBankEntry {
  paletteId: string;
  bank: number;
}

/** Deterministic palette-ID → bank mapping, sorted by palette id, never district order. */
export function derivePaletteBanks(source: CitySourceV3): PaletteBankEntry[] {
  const ids = [...new Set(source.districts.map((district) => district.paletteId))].sort();
  return ids.map((paletteId, index) => ({ paletteId, bank: FIRST_ZONE_BANK + index }));
}

export function completeCityStructuralInput(source: CitySourceV3): StructuralInputSignature {
  const base = districtStructuralInputSignature(source);
  const palettes = [...source.districts]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, paletteId }) => ({ id, paletteId }));
  return {
    ...base,
    districts: stableId("complete-districts", `${base.districts}|${JSON.stringify(palettes)}`)
  };
}

export interface MajorLandmarkSiteReservation {
  grammarId: LandmarkGrammarId;
  sitePolygon: Ring;
  lineage: string;
  seed: string;
}

const RESERVATION_GRID = 6;

/**
 * Deterministic pre-road major landmark sites for full generation. The Worker invokes
 * this before road generation so roads can route around the sites; the reserved site
 * polygons are then passed verbatim into `buildCompleteCityPlan`.
 */
export function reserveMajorLandmarkSites(source: CitySourceV3): MajorLandmarkSiteReservation[] {
  const mask = normalizeRing(source.terrain.urbanFootprint ?? source.terrain.land);
  const maskMulti = ringAsMulti(mask);
  const bounds = ringBounds(mask);
  const reservations: MajorLandmarkSiteReservation[] = [];
  const taken: Ring[] = [];
  for (const grammarId of LANDMARK_GRAMMAR_IDS) {
    const definition = LANDMARK_GRAMMAR_REGISTRY.get(grammarId)!;
    const cellWidth = bounds.width / RESERVATION_GRID;
    const cellHeight = bounds.height / RESERVATION_GRID;
    const cells: { index: number; x: number; y: number }[] = [];
    for (let row = 0; row < RESERVATION_GRID; row++) {
      for (let column = 0; column < RESERVATION_GRID; column++) {
        cells.push({ index: row * RESERVATION_GRID + column, x: column, y: row });
      }
    }
    const firstPick = fnv1a(`${source.citySeed}/landmarks/v3/site/${grammarId}`) % (RESERVATION_GRID * RESERVATION_GRID);
    const ordered = cells
      .map((cell) => ({ cell, distance: Math.abs(cell.index - firstPick) }))
      .sort((a, b) => a.distance - b.distance || a.cell.index - b.cell.index)
      .map(({ cell }) => cell);
    let chosen: Ring | null = null;
    let chosenLineage = "";
    for (const cell of ordered) {
      const centre = { x: bounds.x + (cell.x + 0.5) * cellWidth, y: bounds.y + (cell.y + 0.5) * cellHeight };
      const sizeFactor = 0.72 + hashUnit(`${source.citySeed}/landmarks/v3/size/${grammarId}/${cell.index}`) * 0.24;
      // Height is 0.8 × width, so the site area is 0.8 × width²; cap the width so the
      // site never exceeds the grammar's declared maximum site area.
      const width = Math.min(Math.min(cellWidth, cellHeight) * sizeFactor, Math.sqrt(definition.maxSiteAreaM2 / 0.8));
      const height = width * 0.8;
      const candidate = rectAt(centre, width, height, 0);
      const candidateArea = Math.abs(ringArea(candidate));
      if (candidateArea < definition.minSiteAreaM2) continue;
      if (multiArea(intersection(ringAsMulti(candidate), maskMulti)) < candidateArea * 0.92) continue;
      if (taken.some((ring) => multiArea(intersection(ringAsMulti(candidate), ringAsMulti(ring))) > GEOMETRY_EPSILON)) continue;
      chosen = candidate;
      chosenLineage = `major:${grammarId}:${cell.index}`;
      break;
    }
    if (!chosen) continue;
    taken.push(chosen);
    reservations.push({
      grammarId,
      sitePolygon: chosen,
      lineage: chosenLineage,
      seed: stableId("seed", `${source.citySeed}/landmarks/v3/seed/${grammarId}/${chosenLineage}`)
    });
  }
  return reservations;
}

export interface CompleteCityPlanIdentity {
  sourceRevision: number;
  actionToken: number | string;
  buildToken: number | string;
  epoch: number;
}

export interface ParcelPlan {
  id: string;
  blockId: string;
  fragmentId: string;
  districtId: string | null;
  index: number;
  polygon: Ring;
  frontageRoadId: string | null;
  frontageAngleRad: number;
  role: string;
  seed: string;
  areaM2: number;
}

export interface OpenSpacePlan {
  id: string;
  parcelId: string | null;
  blockId: string;
  fragmentId: string;
  districtId: string | null;
  landmarkId: string | null;
  category: OpenSpaceCategory;
  size: OpenSpaceSize;
  polygon: Ring;
  surfaceStyle: string;
  detailStyle: string;
  lineage: string;
  seed: string;
  areaM2: number;
  material: number;
}

export interface BuildingMassPlan {
  id: string;
  buildingId: string;
  index: number;
  footprint: Ring;
  archetype: FootprintArchetypeId;
  elevationM: number;
  heightM: number;
  roofline: string;
  facadeProfile: string;
  massing: string;
  wallSlots: WeightTriple;
  roofSlots: WeightTriple;
  neonSlots: WeightPair;
  wallMaterial: number;
  roofMaterial: number;
  facadeSeed: number;
  signageRate: number;
  rooftopUtilityRate: number;
  wear: number;
  detailPolicy: "coarse" | "detail" | "both";
  /** Explicit neon gate from the grammar's geometryPolicy; never overloaded from detailPolicy. */
  neonEnabled: boolean;
  seed: string;
}

export interface BuildingPlan {
  id: string;
  parcelId: string;
  blockId: string;
  fragmentId: string;
  districtId: string | null;
  grammarId: BuildingGrammarId;
  visualUse: BuildingUseId;
  archetype: FootprintArchetypeId;
  seed: string;
  appearanceSeed: string;
  /** Deterministically chosen declared setback (m) the masses respect; plan-side record of the enforced contract. */
  setbackM?: number;
  heightM: number;
  masses: BuildingMassPlan[];
  areaM2: number;
}

export interface LandmarkMassPlan {
  id: string;
  landmarkId: string;
  index: number;
  kind: string;
  footprint: Ring;
  elevationM: number;
  heightM: number;
  wallSlots: WeightTriple;
  roofSlots: WeightTriple;
  neonSlots: WeightPair;
  wallMaterial: number;
  roofMaterial: number;
  facadeSeed: number;
  facadeProfile: string;
  roofline: string;
  signageRate: number;
  rooftopUtilityRate: number;
  wear: number;
  detailPolicy: "coarse" | "detail" | "both";
  /** Explicit neon gate from the grammar's geometryPolicy; never overloaded from detailPolicy. */
  neonEnabled: boolean;
  seed: string;
}

export interface LandmarkPlan {
  id: string;
  landmarkGrammarId: LandmarkGrammarId;
  districtId: string | null;
  blockId: string | null;
  sitePolygon: Ring;
  placementLineage: string;
  seed: string;
  appearanceSeed: string;
  masses: LandmarkMassPlan[];
  openSpaceIds: string[];
  areaM2: number;
}

export interface CompleteCityDiagnostics {
  blockCount: number;
  fragmentCount: number;
  parcelCount: number;
  openSpaceCount: number;
  buildingCount: number;
  massCount: number;
  landmarkCount: number;
  landmarkSkipped: string[];
  /** Explicit structural landmark failures (un-carveable open space, empty masses; explicit sites never silently vanish). */
  landmarkFailures?: string[];
  /** Set when explicit reservations were supplied: the validator requires this many landmarks. */
  explicitReservationCount?: number;
  warnings: string[];
}

export interface CompleteCityPlan extends CompleteCityPlanIdentity {
  openSpaceProfile: DistrictOpenSpaceProfile;
  structuralInput: StructuralInputSignature;
  districtPlan: DistrictPlan;
  routeOccupancy: RouteOccupancy;
  carriageway: MultiPolygon;
  paletteBanks: PaletteBankEntry[];
  parcels: ParcelPlan[];
  openSpaces: OpenSpacePlan[];
  buildings: BuildingPlan[];
  landmarks: LandmarkPlan[];
  diagnostics: CompleteCityDiagnostics;
}

interface RawMass {
  footprint: Ring;
  elevationM: number;
  heightM: number;
  kind: string;
}

interface InternalLandmarkPlan extends LandmarkPlan {
  rawMasses: RawMass[];
}

/** A landmark site is illegal when the compiled route occupancy genuinely enters it. */
function siteOverlapsOccupancy(site: Ring, occupancyAll: MultiPolygon): boolean {
  return !isSnapNoise(intersection(ringAsMulti(site), occupancyAll));
}

/** Largest hole-free piece: outer rings of holed difference results must never leak. */
function largestHoleFreePiece(multi: MultiPolygon): Ring | null {
  let best: Ring | null = null;
  let bestArea = 0;
  for (const polygon of multi) {
    for (const piece of canonicalHoleFreePieces(polygon)) {
      const area = Math.abs(ringArea(piece));
      if (area > bestArea) {
        best = piece;
        bestArea = area;
      }
    }
  }
  return best;
}

function openSpacePolygonForIntent(base: MultiPolygon, intentSeed: string, size: OpenSpaceSize, targetShare: number): Ring | null {
  const ring = largestHoleFreePiece(base);
  if (!ring) return null;
  const frameArea = Math.abs(ringArea(ring));
  const angle = longestEdgeAngle(ring);
  const centre = ringCentroid(ring);
  const bounds = ringBounds(ring.map((point) => rotatePoint(point, centre, -angle)));
  const available = base;
  const random = (salt: string): number => hashUnit(`${intentSeed}/open/${salt}`);
  if (size === "whole-block") {
    return largestHoleFreePiece(available);
  }
  let rect: Ring;
  if (size === "pocket") {
    const corner = Math.floor(random("corner") * 4);
    const w = bounds.width * (0.2 + random("w") * 0.14);
    const h = bounds.height * (0.2 + random("h") * 0.14);
    const x = corner === 0 || corner === 3 ? 0 : bounds.width - w;
    const y = corner < 2 ? 0 : bounds.height - h;
    rect = localRect(bounds, angle, centre, x, y, w, h);
  } else if (size === "small") {
    const areaScale = Math.sqrt(Math.min(1, targetShare * 6));
    const edge = Math.floor(random("edge") * 4);
    const depth = (0.14 + random("depth") * 0.12) * areaScale;
    if (edge === 0 || edge === 2) {
      const h = bounds.height * depth;
      rect = localRect(bounds, angle, centre, 0, edge === 0 ? 0 : bounds.height - h, bounds.width, h);
    } else {
      const w = bounds.width * depth;
      rect = localRect(bounds, angle, centre, edge === 1 ? 0 : bounds.width - w, 0, w, bounds.height);
    }
  } else {
    // Scale dimensions proportionally to targetShare so carved area matches profile intent.
    const areaScale = Math.sqrt(Math.min(1, targetShare * 6));
    const w = bounds.width * (0.48 + random("w") * 0.16) * areaScale;
    const h = bounds.height * (0.48 + random("h") * 0.16) * areaScale;
    rect = localRect(bounds, angle, centre, (bounds.width - w) / 2, (bounds.height - h) / 2, w, h);
  }
  const piece = largestHoleFreePiece(intersection(available, ringAsMulti(rect)));
  if (!piece || Math.abs(ringArea(piece)) < MIN_OPEN_SPACE_AREA_M2) return null;
  if (Math.abs(ringArea(piece)) < targetShare * frameArea * 0.35) return null;
  return piece;
}

function landmarkSiteForBlock(blockBuildable: MultiPolygon, minSiteAreaM2: number, maxSiteAreaM2 = Number.POSITIVE_INFINITY): Ring | null {
  const ring = largestPiece(blockBuildable);
  if (!ring) return null;
  const angle = longestEdgeAngle(ring);
  const centre = ringCentroid(ring);
  const bounds = ringBounds(ring);
  const width = Math.min(bounds.width, bounds.height * 1.6);
  const height = Math.min(bounds.height, width * 0.8);
  if (width * height < minSiteAreaM2) return null;
  let rect = rectAt(centre, width * 0.9, height * 0.9, angle);
  const rawArea = Math.abs(ringArea(rect));
  if (rawArea > maxSiteAreaM2) {
    const factor = Math.sqrt(maxSiteAreaM2 / rawArea);
    rect = rectAt(centre, width * 0.9 * factor, height * 0.9 * factor, angle);
    if (Math.abs(ringArea(rect)) < minSiteAreaM2) return null;
  }
  return fitRectInside(rect, blockBuildable) ?? largestPiece(intersection(blockBuildable, ringAsMulti(rect)));
}

function landmarkMassRects(site: Ring, definition: LandmarkGrammarDefinition, seed: string, region: MultiPolygon): RawMass[] {
  // The required open space band is carved from the site before masses are placed, so
  // masses are arranged in the REMAINING region's own frame — never over the band.
  const frame = largestPiece(region) ?? site;
  const angle = longestEdgeAngle(frame);
  const centre = ringCentroid(frame);
  const bounds = ringBounds(frame.map((point) => rotatePoint(point, centre, -angle)));
  const chains: LandmarkMassTemplate[][] = [];
  let current: LandmarkMassTemplate[] = [];
  for (const template of definition.massTemplates) {
    if (template.elevationFactor > 0) {
      current.push(template);
    } else {
      if (current.length > 0) chains.push(current);
      current = [template];
    }
  }
  if (current.length > 0) chains.push(current);

  const output: RawMass[] = [];
  const columnCount = chains.length;
  let totalWidth = 0;
  for (const chain of chains) {
    const ground = chain[0]!;
    totalWidth += Math.min(ground.widthFactor, 0.8 / Math.max(1, columnCount));
  }
  const gap = 0.03;
  const usable = Math.min(1, 1 - gap * Math.max(0, columnCount - 1));
  const scale = Math.min(1, usable / Math.max(GEOMETRY_EPSILON, totalWidth));
  let cursor = 0;
  for (let column = 0; column < columnCount; column++) {
    const chain = chains[column]!;
    const ground = chain[0]!;
    const width = Math.min(ground.widthFactor, 0.8 / Math.max(1, columnCount)) * scale;
    const depth = Math.min(ground.depthFactor, 0.7);
    const x = (cursor + width / 2 - 0.5) * bounds.width;
    let elevationM = 0;
    for (let index = 0; index < chain.length; index++) {
      const template = chain[index]!;
      const w = bounds.width * width * (index === 0 ? 1 : Math.max(0.25, template.widthFactor / ground.widthFactor));
      const h = bounds.height * depth * (index === 0 ? 1 : Math.max(0.25, template.depthFactor / ground.depthFactor));
      const heightM = range(`${seed}/height/${column}/${index}`, template.heightMinM, template.heightMaxM);
      const rect = localRect(bounds, angle, centre, bounds.width / 2 + x - w / 2, bounds.height / 2 - h / 2, w, h);
      const fitted = fitRectInside(rect, region);
      if (!fitted) continue;
      output.push({ footprint: fitted, elevationM, heightM, kind: template.kind });
      elevationM += heightM;
    }
    cursor += width + gap;
  }
  return output;
}

const EMPTY_COMPATIBILITY_TAGS: ReadonlySet<string> = new Set();

function districtCompatibilityTags(districtId: string | null, districtById: Map<string, DistrictSource>): ReadonlySet<string> {
  if (districtId === null) return EMPTY_COMPATIBILITY_TAGS;
  const district = districtById.get(districtId);
  const definition = district ? DISTRICT_TYPE_REGISTRY.get(district.typeId) : undefined;
  return definition ? new Set(definition.compatibilityTags) : EMPTY_COMPATIBILITY_TAGS;
}

function landmarkFitsDistrict(grammar: LandmarkGrammarDefinition, tags: ReadonlySet<string>): boolean {
  return grammar.compatibilityTags.some((tag) => tags.has(tag));
}

function planLandmarks(
  source: CitySourceV3,
  districtPlan: DistrictPlan,
  reserved: readonly MajorLandmarkSiteReservation[],
  districtById: Map<string, DistrictSource>,
  explicit: boolean
): { landmarks: InternalLandmarkPlan[]; skipped: string[]; failures: string[]; warnings: string[]; reservedLandmarkIds: ReadonlySet<string> } {
  const landmarks: InternalLandmarkPlan[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const usedBlocks = new Set<string>();
  const placedGrammars = new Set<LandmarkGrammarId>();
  const sitesByBlock = new Map<string, Ring[]>();
  const reservedLandmarkIds = new Set<string>();
  for (const reservation of reserved) {
    const definition = LANDMARK_GRAMMAR_REGISTRY.get(reservation.grammarId)!;
    const containingBlock = districtPlan.blocks.find((block) =>
      block.districtFragments.some((fragment) => multiArea(intersection(ringAsMulti(reservation.sitePolygon), fragment.buildable)) > GEOMETRY_EPSILON)
    );
    let blockId: string | null = null;
    let districtId: string | null = null;
    if (containingBlock) {
      // The reserved site is associated with a compatible containing fragment when one
      // exists; the containing fragment otherwise.
      const fragments = containingBlock.districtFragments
        .filter((fragment) => multiArea(intersection(ringAsMulti(reservation.sitePolygon), fragment.buildable)) > GEOMETRY_EPSILON)
        .sort((a, b) => a.id.localeCompare(b.id));
      const compatible = fragments.find((fragment) => landmarkFitsDistrict(definition, districtCompatibilityTags(fragment.districtId, districtById)));
      if (compatible) {
        blockId = containingBlock.id;
        districtId = compatible.districtId;
        usedBlocks.add(containingBlock.id);
      } else if (explicit) {
        // Spec: explicit full-generation sites are usually district-compatible with
        // occasional rare contrast — the reservation stays verbatim either way, and a
        // tag mismatch is deterministic contrast reported as a warning, never a drop.
        blockId = containingBlock.id;
        districtId = fragments[0]!.districtId;
        usedBlocks.add(containingBlock.id);
        warnings.push(`Explicit landmark reservation for "${reservation.grammarId}" (${reservation.lineage}) sits in a district with no matching compatibility tag; kept verbatim as deterministic contrast.`);
      }
    } else if (explicit) {
      // The pre-road site lies outside every block; keep it verbatim and unassociated.
      warnings.push(`Explicit landmark reservation for "${reservation.grammarId}" (${reservation.lineage}) is not contained in any district block; kept verbatim as deterministic contrast.`);
    }
    if (blockId === null && !explicit) {
      // Internal reservations may drop here; the fallback pass reselects them.
      continue;
    }
    const landmarkId = stableId("landmark", `${reservation.grammarId}|${reservation.lineage}|${pointKey(reservation.sitePolygon[0]!)}`);
    landmarks.push({
      id: landmarkId,
      landmarkGrammarId: reservation.grammarId,
      districtId,
      blockId,
      sitePolygon: reservation.sitePolygon,
      placementLineage: reservation.lineage,
      seed: reservation.seed,
      appearanceSeed: `${reservation.seed}/appearance`,
      masses: [],
      openSpaceIds: [],
      areaM2: Math.abs(ringArea(reservation.sitePolygon)),
      rawMasses: []
    });
    placedGrammars.add(reservation.grammarId);
    reservedLandmarkIds.add(landmarkId);
    if (blockId !== null) sitesByBlock.set(blockId, [...(sitesByBlock.get(blockId) ?? []), reservation.sitePolygon]);
  }
  for (const grammarId of LANDMARK_GRAMMAR_IDS) {
    if (placedGrammars.has(grammarId)) continue;
    const definition = LANDMARK_GRAMMAR_REGISTRY.get(grammarId)!;
    // Prefer blocks that do not already host a landmark; in single-block cities every
    // block is used by reservations, so fall back to any block with a compatible fragment
    // and inscribe the site away from the existing landmark sites.
    const unused = districtPlan.blocks.filter((block) => !usedBlocks.has(block.id));
    const candidates = (unused.length > 0 ? unused : districtPlan.blocks)
      .filter((block) =>
        block.districtFragments.some((fragment) => landmarkFitsDistrict(definition, districtCompatibilityTags(fragment.districtId, districtById)))
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    let placed = false;
    for (const block of candidates) {
      const existing = sitesByBlock.get(block.id) ?? [];
      // Inscribe the site inside the union of the block's compatible fragments so the
      // placement always has a compatible district to associate with, instead of landing
      // in an incompatible strip of a mixed block.
      const compatibleFragments = block.districtFragments.filter((fragment) =>
        landmarkFitsDistrict(definition, districtCompatibilityTags(fragment.districtId, districtById))
      );
      const compatibleArea = union(compatibleFragments.map((fragment) => fragment.buildable));
      const available = existing.length > 0 ? difference(compatibleArea, [union(existing.map((ring) => ringAsMulti(ring)))]) : compatibleArea;
      if (multiArea(available) < definition.minSiteAreaM2) continue;
      const site = landmarkSiteForBlock(available, definition.minSiteAreaM2, definition.maxSiteAreaM2);
      if (!site) continue;
      const fragments = block.districtFragments
        .filter((fragment) => multiArea(intersection(ringAsMulti(site), fragment.buildable)) > GEOMETRY_EPSILON)
        .sort((a, b) => a.id.localeCompare(b.id));
      const compatible = fragments.find((fragment) => landmarkFitsDistrict(definition, districtCompatibilityTags(fragment.districtId, districtById)));
      if (!compatible) continue;
      const blockSeed = stableId("seed", `${source.citySeed}/landmarks/v3/fallback/${grammarId}/${block.id}`);
      landmarks.push({
        id: stableId("landmark", `${grammarId}|fallback|${block.id}|${pointKey(site[0]!)}`),
        landmarkGrammarId: grammarId,
        districtId: compatible.districtId,
        blockId: block.id,
        sitePolygon: site,
        placementLineage: `fallback:${grammarId}:${block.id}`,
        seed: blockSeed,
        appearanceSeed: `${blockSeed}/appearance`,
        masses: [],
        openSpaceIds: [],
        areaM2: Math.abs(ringArea(site)),
        rawMasses: []
      });
      usedBlocks.add(block.id);
      sitesByBlock.set(block.id, [...existing, site]);
      placed = true;
      break;
    }
    if (!placed) {
      skipped.push(grammarId);
      if (explicit) failures.push(`Landmark grammar "${grammarId}" could not be placed in any compatible block.`);
    }
  }
  landmarks.sort((a, b) => a.id.localeCompare(b.id));
  return { landmarks, skipped, failures, warnings, reservedLandmarkIds };
}

function carveLandmarkOpenSpaces(
  landmarks: InternalLandmarkPlan[],
  districtById: Map<string, DistrictSource>,
  banks: Map<string, number>
): { openSpaces: OpenSpacePlan[]; regions: Map<string, MultiPolygon>; failedLandmarkIds: Set<string>; failures: string[] } {
  const openSpaces: OpenSpacePlan[] = [];
  const regions = new Map<string, MultiPolygon>();
  const failedLandmarkIds = new Set<string>();
  const failures: string[] = [];
  for (const landmark of landmarks) {
    const definition = LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId)!;
    const site = ringAsMulti(landmark.sitePolygon);
    if (!definition.requiredOpenSpace) {
      regions.set(landmark.id, site);
      continue;
    }
    const requirement = definition.requiredOpenSpace;
    const siteArea = Math.abs(ringArea(landmark.sitePolygon));
    const angle = longestEdgeAngle(landmark.sitePolygon);
    const centre = ringCentroid(landmark.sitePolygon);
    const bounds = ringBounds(landmark.sitePolygon.map((point) => rotatePoint(point, centre, -angle)));
    const share = Math.max(requirement.minShare, range(`${landmark.seed}/open/share`, requirement.minShare, Math.min(0.5, requirement.minShare + 0.2)));
    // The required open space is a full-height band along one end of the site covering at
    // least minShare of the site area, so the landmark's own masses keep the rest of the
    // site to fit into (approach plaza / park frontage) and the validator's minShare rule
    // always holds for the carved piece.
    const band = localRect(bounds, angle, centre, 0, 0, bounds.width * share, bounds.height);
    const piece = largestPiece(intersection(site, ringAsMulti(band)));
    if (!piece || Math.abs(ringArea(piece)) + 0.5 < requirement.minShare * siteArea) {
      failures.push(`Landmark "${landmark.landmarkGrammarId}" at "${landmark.placementLineage}" could not carve its required ${requirement.category} open space; the landmark is dropped and its site returns to parcel accounting.`);
      failedLandmarkIds.add(landmark.id);
      continue;
    }
    const category = requirement.category;
    const district = landmark.districtId ? districtById.get(landmark.districtId) : undefined;
    const bank = district ? (banks.get(district.paletteId) ?? BASE_BANK) : BASE_BANK;
    const openSpace: OpenSpacePlan = {
      id: stableId("open", `${landmark.id}|${category}|${landmark.placementLineage}|${pointKey(piece[0]!)}`),
      parcelId: null,
      blockId: landmark.blockId ?? "",
      fragmentId: "",
      districtId: landmark.districtId,
      landmarkId: landmark.id,
      category,
      size: "large",
      polygon: piece,
      surfaceStyle: OPEN_SPACE_SURFACE_STYLES[category],
      detailStyle: OPEN_SPACE_DETAIL_STYLES[category],
      lineage: landmark.placementLineage,
      seed: `${landmark.seed}/open`,
      areaM2: Math.abs(ringArea(piece)),
      material: materialIndex(bank, OPEN_SPACE_SLOTS[category])
    };
    landmark.openSpaceIds.push(openSpace.id);
    openSpaces.push(openSpace);
    // The mass region is the site minus the band, so masses never overlap their own
    // required open space and can never extend past an irregular fallback site.
    const regionRect = ringAsMulti(localRect(bounds, angle, centre, bounds.width * share, 0, bounds.width * (1 - share), bounds.height));
    regions.set(landmark.id, intersection(site, regionRect));
  }
  return { openSpaces, regions, failedLandmarkIds, failures };
}

function planFragments(
  districtPlan: DistrictPlan,
  landmarkSites: Map<string, Ring>,
  districtById: Map<string, DistrictSource>,
  banks: Map<string, number>
): { parcels: ParcelPlan[]; openSpaces: OpenSpacePlan[]; warnings: string[] } {
  const cellsByFragment = new Map<string, DevelopmentCellPlan[]>();
  for (const cell of districtPlan.developmentCells) {
    cellsByFragment.set(cell.fragmentId, [...(cellsByFragment.get(cell.fragmentId) ?? []), cell]);
  }
  const intentByFragment = new Map(districtPlan.openSpaceIntents.map((intent) => [intent.fragmentId, intent]));
  const parcels: ParcelPlan[] = [];
  const openSpaces: OpenSpacePlan[] = [];
  const warnings: string[] = [];
  for (const block of districtPlan.blocks) {
    for (const fragment of block.districtFragments) {
      let available = fragment.buildable;
      for (const site of landmarkSites.values()) {
        if (intersection(available, ringAsMulti(site)).length > 0) available = difference(available, [ringAsMulti(site)]);
      }
      const intent = intentByFragment.get(fragment.id);
      let openPiece: Ring | null = null;
      if (intent && intent.targetShare > 0 && intent.category) {
        openPiece = openSpacePolygonForIntent(available, intent.seed, intent.size ?? "small", intent.targetShare);
        if (openPiece) {
          available = difference(available, [ringAsMulti(openPiece)]);
        } else if (intent.targetShare > 0.55) {
          warnings.push(`Fragment "${fragment.id}" open-space intent could not carve final geometry.`);
        }
      }
      const cells = (cellsByFragment.get(fragment.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
      const indexByCell = new Map(cells.map((cell, index) => [cell.id, index]));
      const placed: { bounds: Rect; multi: MultiPolygon }[] = [];
      const localParcels: ParcelPlan[] = [];
      let parcelIndex = 0;
      for (const cell of cells) {
        // Sequential carving: each parcel subtracts only the already-placed parcels whose
        // bounds overlap this cell (bbox prefilter), so sub-snap cell protrusions can
        // never make final parcels overlap while the boolean work stays linear.
        const cellBounds = ringBounds(cell.polygon);
        const relevant = placed.filter((entry) => rectsIntersect(cellBounds, entry.bounds));
        const cuts = relevant.length > 0 ? [union(relevant.map((entry) => entry.multi))] : [];
        const clipped = difference(intersection(cell.polygon.length > 0 ? ringAsMulti(cell.polygon) : [], available), cuts);
        for (const polygon of clipped) {
          for (const piece of canonicalHoleFreePieces(polygon)) {
            const area = Math.abs(ringArea(piece));
            if (area < MIN_PARCEL_AREA_M2) continue;
            const index = indexByCell.get(cell.id) ?? parcelIndex;
            localParcels.push({
              id: stableId("parcel", `${fragment.id}|${index}|${cell.localRole}|${ringKey(piece)}`),
              blockId: block.id,
              fragmentId: fragment.id,
              districtId: fragment.districtId,
              index,
              polygon: piece,
              frontageRoadId: cell.frontageRoadId,
              frontageAngleRad: cell.rotationRad,
              role: cell.localRole,
              seed: `${fragment.id}/parcel/${index}`,
              areaM2: area
            });
            placed.push({ bounds: ringBounds(piece), multi: ringAsMulti(piece) });
          }
        }
        parcelIndex++;
      }
      const occupied = union(placed.map((entry) => entry.multi));
      const remainder = difference(available, occupied.length > 0 ? [occupied] : []);
      for (const polygon of remainder) {
        for (const piece of canonicalHoleFreePieces(polygon)) {
          const area = Math.abs(ringArea(piece));
          if (area < MIN_PARCEL_AREA_M2) continue;
          localParcels.push({
            id: stableId("parcel", `${fragment.id}|remainder-${parcelIndex}|${ringKey(piece)}`),
            blockId: block.id,
            fragmentId: fragment.id,
            districtId: fragment.districtId,
            index: 1000 + parcelIndex,
            polygon: piece,
            frontageRoadId: null,
            frontageAngleRad: longestEdgeAngle(piece),
            role: `planning-band-remainder-${parcelIndex}`,
            seed: `${fragment.id}/parcel/remainder-${parcelIndex}`,
            areaM2: area
          });
          parcelIndex++;
        }
      }
      localParcels.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
      parcels.push(...localParcels);
      if (openPiece && intent) {
        const district = fragment.districtId ? districtById.get(fragment.districtId) : undefined;
        const bank = district ? (banks.get(district.paletteId) ?? BASE_BANK) : BASE_BANK;
        openSpaces.push({
          id: stableId("open", `${fragment.id}|${intent.category}|${intent.seed}|${pointKey(openPiece[0]!)}`),
          parcelId: null,
          blockId: block.id,
          fragmentId: fragment.id,
          districtId: fragment.districtId,
          landmarkId: null,
          category: intent.category!,
          size: intent.size ?? "small",
          polygon: openPiece,
          surfaceStyle: OPEN_SPACE_SURFACE_STYLES[intent.category!],
          detailStyle: OPEN_SPACE_DETAIL_STYLES[intent.category!],
          lineage: intent.seed,
          seed: `${intent.seed}/open`,
          areaM2: Math.abs(ringArea(openPiece)),
          material: materialIndex(bank, OPEN_SPACE_SLOTS[intent.category!])
        });
      }
    }
  }
  parcels.sort((a, b) => a.id.localeCompare(b.id));
  openSpaces.sort((a, b) => a.id.localeCompare(b.id));
  return { parcels, openSpaces, warnings };
}

function parcelBank(district: DistrictSource | undefined, banks: Map<string, number>): number {
  return district ? (banks.get(district.paletteId) ?? BASE_BANK) : BASE_BANK;
}

function archetypeMasses(
  parcel: { polygon: Ring; frontageAngleRad: number },
  definition: BuildingGrammarDefinition,
  seed: string,
  heightM: number,
  setbackM: number,
  frontage: FrontageSide | null
): RawMass[] {
  // Fronted masses rotate to their street: when the frontage detection found the road
  // edge's direction, that direction becomes the massing frame's width axis, so
  // buildings sit parallel to the road even when the cell frame is diagonal to it.
  const angle = frontage?.angleRad ?? parcel.frontageAngleRad;
  const centre = ringCentroid(parcel.polygon);
  const local = parcel.polygon.map((point) => rotatePoint(point, centre, -angle));
  const bounds = ringBounds(local);
  const localFrontage = frontage === null ? null : frontage.angleRad === undefined ? frontage : frontageInFrame(frontage, parcel.frontageAngleRad, angle);
  const occupancy = range(`${seed}/occupancy`, definition.footprint.occupancyMin, definition.footprint.occupancyMax);
  const occupancyFactor = Math.sqrt(occupancy);
  // The declared setback is applied as an inset band on all sides before the main mass
  // rect is drawn, so every mass sits at least `setbackM` (and therefore `setbackMin`)
  // back from the parcel's local bounds.
  const usableW = Math.max(0, bounds.width - 2 * setbackM);
  const usableH = Math.max(0, bounds.height - 2 * setbackM);
  // Size always comes from the frontage policy so every building spans its parcel
  // width (no side moats anywhere, interior or fronted): street-wall fills both axes,
  // setback keeps the depth on the declared occupancy so the back yard varies. Only
  // the OFFSET depends on frontage detection: fronted parcels are pushed to the road
  // (flush for street-wall, a front plaza for setback); interior parcels center.
  const streetWall = definition.frontage.mode === "street-wall";
  const mainW = usableW * definition.frontage.widthFill;
  const mainH = usableH * (streetWall ? definition.frontage.depthFill : definition.massing.mainDepthFactor * occupancyFactor);
  if (!(mainW > 0.5 && mainH > 0.5)) return [];
  const container = ringAsMulti(parcel.polygon);
  let baseX = (bounds.width - mainW) / 2;
  let baseY = (bounds.height - mainH) / 2;
  if (localFrontage !== null) {
    const front = streetWall
      ? range(`${seed}/front`, definition.frontage.frontSetback[0], definition.frontage.frontSetback[1])
      : Math.max(setbackM, range(`${seed}/front`, definition.frontage.frontSetback[0], definition.frontage.frontSetback[1]));
    if (localFrontage.axis === "v") baseY = localFrontage.sign < 0 ? front : bounds.height - mainH - front;
    else baseX = localFrontage.sign < 0 ? front : bounds.width - mainW - front;
  }
  const gap = 0.04;
  // WHY: the first peer pins the declared total height; later peers must not raise the peak.
  const peerHeight = (salt: string, index: number): number =>
    index === 0 ? heightM : heightM * (0.8 + hashUnit(`${seed}/mass/${salt}`) * 0.2);
  const put = (rect: Ring, kind: string, elevationM: number, height: number): RawMass | null => {
    // Fronted masses shrink toward the road edge (keeping the flush front); unfronted
    // masses keep the centroid shrink.
    const fitted = localFrontage === null ? fitRectInside(rect, container) : fitRectPinned(rect, container, localFrontage, angle, centre);
    if (!fitted) return null;
    return { footprint: fitted, elevationM, heightM: height, kind };
  };
  const mergePieces = (rings: readonly Ring[]): Ring | null => largestHoleFreePiece(union(rings.map((ring) => ringAsMulti(ring))));
  const archetype = definition.archetype;
  const count = definition.massing.minMasses + Math.floor(hashUnit(`${seed}/mass-count`) * (definition.massing.maxMasses - definition.massing.minMasses + 1));

  if (archetype === "rectangle") {
    const masses: RawMass[] = [];
    const barH = (mainH - gap * (count - 1)) / count;
    for (let index = 0; index < count; index++) {
      const mass = put(localRect(bounds, angle, centre, baseX, baseY + index * (barH + gap), mainW, barH), "slab", 0, peerHeight(`slab-${index}`, index));
      if (!mass) return [];
      masses.push(mass);
    }
    return masses;
  }
  if (archetype === "trapezoid") {
    const masses: RawMass[] = [];
    const wedgeW = (mainW - gap * (count - 1)) / count;
    for (let index = 0; index < count; index++) {
      const rect = localRect(bounds, angle, centre, baseX + index * (wedgeW + gap), baseY, wedgeW, mainH);
      const fitted = fitRectInside(rect, container);
      if (!fitted) return [];
      const skew = range(`${seed}/skew/${index}`, 0.05, 0.2);
      const [a, b, c, d] = fitted;
      if (!a || !b || !c || !d) return [];
      const topLength = Math.hypot(c.x - d.x, c.y - d.y);
      const inset = Math.min(skew * topLength, topLength * 0.4);
      const unitC = topLength > GEOMETRY_EPSILON ? { x: (d.x - c.x) / topLength, y: (d.y - c.y) / topLength } : { x: 0, y: 0 };
      masses.push({
        footprint: [a, b, { x: c.x + unitC.x * inset, y: c.y + unitC.y * inset }, { x: d.x - unitC.x * inset, y: d.y - unitC.y * inset }],
        elevationM: 0,
        heightM: peerHeight(`wedge-${index}`, index),
        kind: "wedge"
      });
    }
    return masses;
  }
  if (archetype === "l-shape") {
    const wingW = mainW * 0.58;
    const wingH = mainH * 0.65;
    const side = hashUnit(`${seed}/wing`) < 0.5 ? -1 : 1;
    // WHY: one concave base prevents an L grammar from rendering as unrelated rectangles.
    const bottomBar = localRect(bounds, angle, centre, baseX, baseY + wingH, mainW, mainH - wingH);
    const sideBarX = side < 0 ? baseX : baseX + mainW - wingW;
    const sideBar = localRect(bounds, angle, centre, sideBarX, baseY, wingW, wingH);
    const merged = mergePieces([bottomBar, sideBar]);
    if (!merged) return [];
    const base = fitRectInside(merged, container);
    if (!base || base.length <= 4) return [];
    if (count < 2) return [{ footprint: base, elevationM: 0, heightM, kind: "l-shape" }];
    // WHY: the upper slab must complete, not exceed, the grammar's declared total height.
    const baseShare = 0.6 + hashUnit(`${seed}/stack-share`) * 0.2;
    const slabRect = localRect(bounds, angle, centre, baseX + mainW * 0.12, baseY + wingH, mainW * 0.76, (mainH - wingH) * 0.55);
    const slab = fitRectInside(slabRect, ringAsMulti(base)) ?? fitRectInside(slabRect, container);
    if (!slab) return [];
    return [
      { footprint: base, elevationM: 0, heightM: heightM * baseShare, kind: "l-shape" },
      { footprint: slab, elevationM: heightM * baseShare, heightM: heightM * (1 - baseShare), kind: "slab" }
    ];
  }
  if (archetype === "u-shape") {
    const barH = mainH * 0.38;
    const barW = mainW * 0.36;
    const left = localRect(bounds, angle, centre, baseX, baseY, barW, mainH);
    const right = localRect(bounds, angle, centre, baseX + mainW - barW, baseY, barW, mainH);
    const cross = localRect(bounds, angle, centre, baseX + barW, baseY, mainW - 2 * barW, barH);
    // The base is ALWAYS the single concave U ring of all three bars; declared extra
    // masses (industrial-loading-court 1-2) stack above the cross bar.
    const merged = mergePieces([left, right, cross]);
    if (!merged) return [];
    const base = fitRectInside(merged, container);
    if (!base || base.length <= 4) return [];
    if (count < 2) return [{ footprint: base, elevationM: 0, heightM, kind: "u-shape" }];
    // The base takes most of the declared height and the stacked slab completes it exactly,
    // so base + slab can never leave the grammar's declared total range.
    const baseShare = 0.6 + hashUnit(`${seed}/stack-share`) * 0.2;
    const slabRect = localRect(bounds, angle, centre, baseX + barW, baseY, mainW - 2 * barW, barH);
    const slab = fitRectInside(slabRect, ringAsMulti(base)) ?? fitRectInside(slabRect, container);
    if (!slab) return [];
    return [
      { footprint: base, elevationM: 0, heightM: heightM * baseShare, kind: "u-shape" },
      { footprint: slab, elevationM: heightM * baseShare, heightM: heightM * (1 - baseShare), kind: "slab" }
    ];
  }
  if (archetype === "courtyard") {
    const barW = mainW * 0.28;
    const barH = mainH * 0.28;
    const top = localRect(bounds, angle, centre, baseX, baseY, mainW, barH);
    const bottom = localRect(bounds, angle, centre, baseX, baseY + mainH - barH, mainW, barH);
    const left = localRect(bounds, angle, centre, baseX, baseY + barH, barW, mainH - 2 * barH);
    const right = localRect(bounds, angle, centre, baseX + mainW - barW, baseY + barH, barW, mainH - 2 * barH);
    const bars = [top, bottom, left, right] as const;
    const kept = count < 4 ? bars.filter((_, index) => index !== Math.floor(hashUnit(`${seed}/court-drop`) * 4)) : bars;
    const masses: RawMass[] = [];
    for (let index = 0; index < kept.length; index++) {
      const mass = put(kept[index]!, "ring-bar", 0, peerHeight("ring-bar", index));
      if (!mass) return [];
      masses.push(mass);
    }
    return masses;
  }
  if (archetype === "podium") {
    const baseHeight = heightM * range(`${seed}/podium`, 0.34, 0.46);
    const podium = fitRectInside(localRect(bounds, angle, centre, baseX, baseY, mainW, mainH), container);
    if (!podium) return [];
    const podiumMulti = ringAsMulti(podium);
    const masses: RawMass[] = [{ footprint: podium, elevationM: 0, heightM: baseHeight, kind: "podium" }];
    const towerCount = count - 1;
    const towerHeight = heightM - baseHeight;
    if (towerCount === 1) {
      const towerW = mainW * 0.55;
      const towerH = mainH * 0.55;
      const tower = fitRectInside(localRect(bounds, angle, centre, baseX + (mainW - towerW) / 2, baseY + (mainH - towerH) / 2, towerW, towerH), podiumMulti);
      if (!tower) return [];
      masses.push({ footprint: tower, elevationM: baseHeight, heightM: towerHeight, kind: "tower" });
    } else {
      // Twin towers: two sibling masses at the same podium elevation, side by side and
      // disjoint, both contained in the podium footprint.
      const towerW = mainW * 0.42;
      const towerH = mainH * 0.5;
      const towerGap = mainW * 0.06;
      const startX = baseX + (mainW - 2 * towerW - towerGap) / 2;
      for (let index = 0; index < towerCount; index++) {
        const tower = fitRectInside(localRect(bounds, angle, centre, startX + index * (towerW + towerGap), baseY + (mainH - towerH) / 2, towerW, towerH), podiumMulti);
        if (!tower) return [];
        masses.push({ footprint: tower, elevationM: baseHeight, heightM: towerHeight, kind: "tower" });
      }
    }
    return masses;
  }
  // clustered compound
  const masses: RawMass[] = [];
  const unit = (1 - gap * (count - 1)) / count;
  for (let index = 0; index < count; index++) {
    // Tighter internal fill: compounds now cover 0.78-1.0 x 0.55-0.9 of their cell so
    // utility/derelict clusters read as built yards instead of scattered sheds.
    const w = mainW * unit * (0.78 + hashUnit(`${seed}/compound/${index}`) * 0.22);
    const h = mainH * (0.55 + hashUnit(`${seed}/compound/d/${index}`) * 0.35);
    const x = baseX + index * mainW * (unit + gap) + (mainW * unit - w) / 2;
    const mass = put(localRect(bounds, angle, centre, x, baseY + (mainH - h) / 2, w, h), index % 3 === 0 ? "shed" : "pavilion", 0, peerHeight(`compound-${index}`, index));
    if (!mass) return [];
    masses.push(mass);
  }
  return masses;
}

export interface ParcelBuildingInput {
  id: string;
  blockId: string;
  fragmentId: string;
  districtId: string | null;
  polygon: Ring;
  frontageAngleRad: number;
  seed: string;
  areaM2: number;
}

/**
 * Deterministically plan one parcel into a BuildingPlan or null. A null result means no
 * shipping grammar's declared limits genuinely fit the parcel, and the parcel must be
 * left as an explicitly classified unbuilt open parcel. The chosen grammar always fits
 * (strict area/width/depth/aspect/setback checks), the visual use is always one of the
 * grammar's compatibleUses, and its mass count and total height stay within declared
 * ranges. Geometry and IDs derive from the parcel geometry stream; rendered appearance
 * derives only from the appearance stream.
 * This is the production per-parcel materializer: planBuildings and the fixed breadth
 * gallery both run through it.
 */
export function planParcelBuilding(
  parcel: ParcelBuildingInput,
  weights: Readonly<Record<BuildingGrammarId, number>>,
  useWeights: Readonly<Record<BuildingUseId, number>>,
  district: DistrictSource | undefined,
  banks: Map<string, number>,
  appearanceSeedOverride?: string,
  frontage: FrontageSide | null = null
): BuildingPlan | null {
  const active = BUILDING_GRAMMAR_IDS.filter((id) => (weights[id] ?? 0) > 0);
  const fitting = active.filter((id) => grammarFitsParcel(BUILDING_GRAMMAR_REGISTRY.get(id)!, parcel));
  if (fitting.length === 0) return null;
  const primary = selectBuildingGrammar(weights, `${parcel.seed}/grammar`);
  let grammarId: BuildingGrammarId;
  if (fitting.includes(primary)) {
    grammarId = primary;
  } else {
    // Micro grammars fill slivers only: a parcel that fits any main grammar must get a
    // main grammar, or every mid-size parcel floods with kiosks/annexes.
    const fittingMain = fitting.filter((id) => !MICRO_BUILDING_GRAMMAR_IDS.has(id));
    const pool = fittingMain.length > 0 ? fittingMain : fitting;
    grammarId = weightedChoice(weights, pool, `${parcel.seed}/grammar-fit`);
  }
  const grammar = BUILDING_GRAMMAR_REGISTRY.get(grammarId)!;
  const supportedUses = grammar.compatibleUses.filter((use) => (useWeights[use] ?? 0) > 0);
  const compatibleWeights = Object.fromEntries(
    BUILDING_USE_IDS.map((use) => [use, grammar.compatibleUses.includes(use) ? (useWeights[use] ?? 0) : 0])
  ) as Record<BuildingUseId, number>;
  const visualUse = supportedUses.length > 0 ? weightedChoice(compatibleWeights, supportedUses, `${parcel.seed}/use`) : grammar.compatibleUses[0]!;
  const geometrySeed = `${parcel.seed}/geometry`;
  const appearanceSeed = appearanceSeedOverride ?? `${parcel.seed}/appearance`;
  const heightM = range(`${geometrySeed}/height`, grammar.height.minM, grammar.height.maxM) * (1 - grammar.height.skylineBias) +
    range(`${geometrySeed}/height-sky`, grammar.height.minM, grammar.height.maxM) * grammar.height.skylineBias;
  const setbackM = range(`${parcel.seed}/setback`, grammar.footprint.setbackMin, grammar.footprint.setbackMax);
  const rawMasses = archetypeMasses(parcel, grammar, geometrySeed, heightM, setbackM, frontage);
  if (rawMasses.length === 0) return null;
  const bank = parcelBank(district, banks);
  const buildingId = stableId("building", `${parcel.id}|${grammarId}|${rawMasses.map((mass) => pointKey(mass.footprint[0]!)).join("+")}`);
  const masses: BuildingMassPlan[] = rawMasses.map((raw, index) => {
    const massSeed = `${geometrySeed}/mass/${index}`;
    // WHY: appearance rerolls must not move geometry, IDs, or associations.
    const appearanceMassSeed = `${appearanceSeed}/mass/${index}`;
    const wallSlot = weightedIndex([...grammar.materialSlots.wall], `${appearanceMassSeed}/wall`);
    const roofSlot = weightedIndex([...grammar.materialSlots.roof], `${appearanceMassSeed}/roof`);
    const facadeProfile = grammar.facadeProfiles[fnv1a(`${appearanceMassSeed}/facade`) % grammar.facadeProfiles.length]!;
    const roofline = grammar.rooflines[fnv1a(`${appearanceMassSeed}/roofline`) % grammar.rooflines.length]!;
    return {
      id: stableId("mass", `${buildingId}|m${index}`),
      buildingId,
      index,
      footprint: raw.footprint,
      archetype: grammar.archetype,
      elevationM: raw.elevationM,
      heightM: raw.heightM,
      roofline,
      facadeProfile,
      massing: raw.kind,
      wallSlots: grammar.materialSlots.wall,
      roofSlots: grammar.materialSlots.roof,
      neonSlots: grammar.materialSlots.neon,
      wallMaterial: materialIndex(bank, wallSlot),
      roofMaterial: materialIndex(bank, 3 + roofSlot),
      facadeSeed: hashUnit(`${appearanceMassSeed}/facade-seed`),
      signageRate: range(`${appearanceMassSeed}/signage`, grammar.signage.rateMin, grammar.signage.rateMax),
      rooftopUtilityRate: range(`${appearanceMassSeed}/rooftop`, grammar.rooftopUtility.rateMin, grammar.rooftopUtility.rateMax),
      wear: range(`${appearanceMassSeed}/wear`, grammar.wear.min, grammar.wear.max),
      detailPolicy: grammar.geometryPolicy.detail === "none" ? "coarse" : grammar.geometryPolicy.neon ? "both" : "detail",
      neonEnabled: grammar.geometryPolicy.neon,
      seed: massSeed
    };
  });
  return {
    id: buildingId,
    parcelId: parcel.id,
    blockId: parcel.blockId,
    fragmentId: parcel.fragmentId,
    districtId: parcel.districtId,
    grammarId,
    visualUse,
    archetype: grammar.archetype,
    seed: geometrySeed,
    appearanceSeed,
    setbackM,
    heightM: Math.max(...masses.map((mass) => mass.elevationM + mass.heightM)),
    masses,
    areaM2: masses.reduce((sum, mass) => sum + Math.abs(ringArea(mass.footprint)), 0)
  };
}

interface ParcelPartition {
  angleRad: number;
  orientation: number;
  grammarId: BuildingGrammarId;
  bounds: Rect;
  centre: Vec2;
  columns: number;
  rows: number;
  widthM: number;
  depthM: number;
  score: number;
}

interface RefinedParcelResult {
  parcels: ParcelPlan[];
  buildings: BuildingPlan[];
  unbuilt: Ring[];
  areaM2: number;
}

function parcelPartitionCandidates(
  parcel: ParcelPlan,
  weights: Readonly<Record<BuildingGrammarId, number>>
): ParcelPartition[] {
  const centre = ringCentroid(parcel.polygon);
  const candidates: ParcelPartition[] = [];
  for (let orientation = 0; orientation < 2; orientation++) {
    const angleRad = parcel.frontageAngleRad + orientation * Math.PI / 2;
    const local = parcel.polygon.map((point) => rotatePoint(point, centre, -angleRad));
    const bounds = ringBounds(local);
    const grammarCandidates: ParcelPartition[] = [];
    for (const grammarId of BUILDING_GRAMMAR_IDS) {
      const weight = weights[grammarId] ?? 0;
      if (weight <= 0) continue;
      // Micro grammars never partition a parcel: a big parcel should split into
      // main-grammar-sized cells (towers/slabs), not a grid of kiosks.
      if (MICRO_BUILDING_GRAMMAR_IDS.has(grammarId)) continue;
      const limits = BUILDING_GRAMMAR_REGISTRY.get(grammarId)!.siteLimits;
      let best: ParcelPartition | null = null;
      const maxColumns = Math.min(64, Math.ceil(bounds.width / limits.minWidthM));
      const maxRows = Math.min(64, Math.ceil(bounds.height / limits.minDepthM));
      for (let columns = 1; columns <= maxColumns; columns++) {
        const widthM = bounds.width / columns;
        if (widthM < limits.minWidthM || widthM > limits.maxWidthM) continue;
        for (let rows = 1; rows <= maxRows; rows++) {
          const depthM = bounds.height / rows;
          const areaM2 = widthM * depthM;
          const aspect = widthM / depthM;
          if (areaM2 < limits.minAreaM2 || areaM2 > limits.maxAreaM2) continue;
          if (aspect < limits.minAspect || aspect > limits.maxAspect) continue;
          const targetAreaM2 = Math.sqrt(limits.minAreaM2 * limits.maxAreaM2);
          const score = Math.abs(Math.log(areaM2 / targetAreaM2)) - Math.log(weight + 0.01) * 0.08;
          if (best === null || score < best.score) {
            best = {
              angleRad,
              orientation,
              grammarId,
              bounds,
              centre,
              columns,
              rows,
              widthM,
              depthM,
              score
            };
          }
        }
      }
      if (best !== null) grammarCandidates.push(best);
    }
    grammarCandidates.sort((a, b) => a.score - b.score || a.grammarId.localeCompare(b.grammarId));
    candidates.push(...grammarCandidates.slice(0, 3));
  }
  return candidates;
}

function refineParcelVariant(
  parcel: ParcelPlan,
  partition: ParcelPartition,
  offsetX: number,
  offsetY: number,
  weights: Readonly<Record<BuildingGrammarId, number>>,
  useWeights: Readonly<Record<BuildingUseId, number>>,
  district: DistrictSource | undefined,
  banks: Map<string, number>,
  frontage: FrontageSide | null
): RefinedParcelResult | null {
  const parcels: ParcelPlan[] = [];
  const buildings: BuildingPlan[] = [];
  const unbuilt: Ring[] = [];
  // Every cell of a partition inherits the parent's frontage direction re-expressed in
  // the partition's frame, so the whole partition reads as one continuous street front.
  const cellFrontage = frontage === null ? null : frontageInFrame(frontage, parcel.frontageAngleRad, partition.angleRad);
  const startX = partition.bounds.x - partition.widthM * offsetX / 3;
  const startY = partition.bounds.y - partition.depthM * offsetY / 3;
  const columns = Math.ceil((partition.bounds.x + partition.bounds.width - startX) / partition.widthM);
  const rows = Math.ceil((partition.bounds.y + partition.bounds.height - startY) / partition.depthM);
  let candidateIndex = 0;
  let areaM2 = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const rect = localRect(
        partition.bounds,
        partition.angleRad,
        partition.centre,
        startX - partition.bounds.x + column * partition.widthM,
        startY - partition.bounds.y + row * partition.depthM,
        partition.widthM,
        partition.depthM
      );
      let clipped: MultiPolygon;
      try {
        clipped = intersection(ringAsMulti(rect), ringAsMulti(parcel.polygon));
      } catch {
        return null;
      }
      for (const polygon of clipped) {
        let pieceIndex = 0;
        for (const piece of canonicalHoleFreePieces(polygon)) {
          const pieceAreaM2 = Math.abs(ringArea(piece));
          if (pieceAreaM2 < MIN_PARCEL_AREA_M2) {
            if (pieceAreaM2 > GEOMETRY_EPSILON) unbuilt.push(piece);
            pieceIndex++;
            continue;
          }
          const lineage = `${partition.orientation}/${partition.grammarId}/${offsetX}/${offsetY}/${row}/${column}/${pieceIndex}`;
          const candidate: ParcelPlan = {
            id: stableId("parcel", `${parcel.id}|refined|${lineage}|${ringKey(piece)}`),
            blockId: parcel.blockId,
            fragmentId: parcel.fragmentId,
            districtId: parcel.districtId,
            index: parcel.index * 10_000 + candidateIndex,
            polygon: piece,
            frontageRoadId: parcel.frontageRoadId,
            frontageAngleRad: partition.angleRad,
            role: `${parcel.role}-refined`,
            seed: `${parcel.seed}/refined/${lineage}`,
            areaM2: pieceAreaM2
          };
          const building = planParcelBuilding(candidate, weights, useWeights, district, banks, undefined, cellFrontage);
          if (building !== null) {
            parcels.push(candidate);
            buildings.push(building);
            areaM2 += pieceAreaM2;
          } else {
            unbuilt.push(piece);
          }
          candidateIndex++;
          pieceIndex++;
        }
      }
    }
  }
  return { parcels, buildings, unbuilt, areaM2 };
}
function refineParcel(
  parcel: ParcelPlan,
  weights: Readonly<Record<BuildingGrammarId, number>>,
  useWeights: Readonly<Record<BuildingUseId, number>>,
  district: DistrictSource | undefined,
  banks: Map<string, number>,
  frontage: FrontageSide | null
): RefinedParcelResult | null {
  let best: RefinedParcelResult | null = null;
  for (const partition of parcelPartitionCandidates(parcel, weights)) {
    for (let offsetX = 0; offsetX < 3; offsetX++) {
      for (let offsetY = 0; offsetY < 3; offsetY++) {
        const result = refineParcelVariant(parcel, partition, offsetX, offsetY, weights, useWeights, district, banks, frontage);
        if (result !== null && (best === null || result.areaM2 > best.areaM2)) best = result;
        if (best !== null && best.areaM2 >= parcel.areaM2 * 0.97) return best;
      }
    }
  }
  return best?.areaM2 ? best : null;
}

function residualParcelPlans(
  parcel: ParcelPlan,
  refined: RefinedParcelResult
): { parcels: ParcelPlan[]; openSpaces: OpenSpacePlan[] } {
  const parcels: ParcelPlan[] = [];
  const openSpaces: OpenSpacePlan[] = [];
  let index = 0;
  for (const piece of refined.unbuilt) {
    const areaM2 = Math.abs(ringArea(piece));
    if (areaM2 <= GEOMETRY_EPSILON) continue;
    const seed = `${parcel.seed}/residual/${index}`;
    const residualParcel: ParcelPlan = {
      id: stableId("parcel", `${parcel.id}|residual|${index}|${ringKey(piece)}`),
      blockId: parcel.blockId,
      fragmentId: parcel.fragmentId,
      districtId: parcel.districtId,
      index: parcel.index * 10_000 + 9_000 + index,
      polygon: piece,
      frontageRoadId: parcel.frontageRoadId,
      frontageAngleRad: parcel.frontageAngleRad,
      role: `${parcel.role}-residual`,
      seed,
      areaM2
    };
    parcels.push(residualParcel);
    openSpaces.push({
      id: stableId("open", `${residualParcel.id}|${ringKey(piece)}`),
      parcelId: residualParcel.id,
      blockId: parcel.blockId,
      fragmentId: parcel.fragmentId,
      districtId: parcel.districtId,
      landmarkId: null,
      category: "vacant",
      size: areaM2 < 800 ? "small" : "large",
      polygon: piece,
      surfaceStyle: OPEN_SPACE_SURFACE_STYLES.vacant,
      detailStyle: OPEN_SPACE_DETAIL_STYLES.vacant,
      lineage: seed,
      seed,
      areaM2,
      material: MATERIAL.GROUND
    });
    index++;
  }
  return { parcels, openSpaces };
}

function planBuildings(
  sourceParcels: ParcelPlan[],
  districtById: Map<string, DistrictSource>,
  banks: Map<string, number>,
  occupancy: MultiPolygon
): { parcels: ParcelPlan[]; buildings: BuildingPlan[]; openSpaces: OpenSpacePlan[]; warnings: string[] } {
  const parcels: ParcelPlan[] = [];
  const buildings: BuildingPlan[] = [];
  const openSpaces: OpenSpacePlan[] = [];
  const warnings: string[] = [];
  let refinedCount = 0;
  let unbuiltCount = 0;
  const occBoxes = occupancyBoxes(occupancy);
  for (const parcel of sourceParcels) {
    const district = parcel.districtId ? districtById.get(parcel.districtId) : undefined;
    const definition = district ? DISTRICT_TYPE_REGISTRY.get(district.typeId) : undefined;
    const weights = definition ? definition.buildingGrammarWeights : UNZONED_BUILDING_GRAMMAR_WEIGHTS;
    const useWeights = definition ? definition.visualUseWeights : UNZONED_VISUAL_USE_WEIGHTS;
    const frontage = detectFrontage(parcel, occBoxes);
    const building = planParcelBuilding(parcel, weights, useWeights, district, banks, undefined, frontage);
    if (building !== null) {
      parcels.push(parcel);
      buildings.push(building);
      continue;
    }
    const refined = refineParcel(parcel, weights, useWeights, district, banks, frontage);
    if (refined !== null) {
      const residual = residualParcelPlans(parcel, refined);
      parcels.push(...refined.parcels, ...residual.parcels);
      buildings.push(...refined.buildings);
      openSpaces.push(...residual.openSpaces);
      refinedCount++;
      unbuiltCount += residual.parcels.length;
      continue;
    }
    parcels.push(parcel);
    unbuiltCount++;
    // Unbuilt parcels (too small or no fitting grammar) become landscaping rather
    // than vacant scrub, so they blend with sidewalk surface instead of looking derelict.
    openSpaces.push({
      id: stableId("open", `unbuilt|${parcel.id}|${ringKey(parcel.polygon)}`),
      parcelId: parcel.id,
      blockId: parcel.blockId,
      fragmentId: parcel.fragmentId,
      districtId: parcel.districtId,
      landmarkId: null,
      category: "landscaping",
      size: "large",
      polygon: parcel.polygon,
      surfaceStyle: "paving",
      detailStyle: OPEN_SPACE_DETAIL_STYLES.landscaping,
      lineage: parcel.seed,
      seed: `${parcel.seed}/unbuilt`,
      areaM2: parcel.areaM2,
      material: MATERIAL.GROUND
    });
  }
  if (refinedCount > 0) warnings.push(`${refinedCount} planning parcels were partitioned into building-compatible final parcels.`);
  if (unbuiltCount > 0) warnings.push(`${unbuiltCount} parcels have no fitting building grammar and remain explicitly unbuilt.`);
  parcels.sort((a, b) => a.id.localeCompare(b.id));
  buildings.sort((a, b) => a.id.localeCompare(b.id));
  openSpaces.sort((a, b) => a.id.localeCompare(b.id));
  return { parcels, buildings, openSpaces, warnings };
}

function materializeLandmarkMasses(
  landmarks: InternalLandmarkPlan[],
  regions: Map<string, MultiPolygon>,
  districtById: Map<string, DistrictSource>,
  banks: Map<string, number>
): void {
  for (const landmark of landmarks) {
    const definition = LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId)!;
    const district = landmark.districtId ? districtById.get(landmark.districtId) : undefined;
    const bank = parcelBank(district, banks);
    landmark.rawMasses = landmarkMassRects(landmark.sitePolygon, definition, landmark.seed, regions.get(landmark.id) ?? ringAsMulti(landmark.sitePolygon));
    landmark.masses = landmark.rawMasses.map((raw, index) => {
      const massSeed = `${landmark.seed}/mass/${index}`;
      // WHY: landmark appearance changes must not move geometry or IDs.
      const appearanceMassSeed = `${landmark.appearanceSeed}/mass/${index}`;
      const wallSlot = weightedIndex([...definition.materialSlots.wall], `${appearanceMassSeed}/wall`);
      const roofSlot = weightedIndex([...definition.materialSlots.roof], `${appearanceMassSeed}/roof`);
      const facadeProfile = definition.facadeProfiles[fnv1a(`${appearanceMassSeed}/facade`) % definition.facadeProfiles.length]!;
      const roofline = definition.rooflines[fnv1a(`${appearanceMassSeed}/roofline`) % definition.rooflines.length]!;
      return {
        id: stableId("lmass", `${landmark.id}|m${index}`),
        landmarkId: landmark.id,
        index,
        kind: raw.kind,
        footprint: raw.footprint,
        elevationM: raw.elevationM,
        heightM: raw.heightM,
        wallSlots: definition.materialSlots.wall,
        roofSlots: definition.materialSlots.roof,
        neonSlots: definition.materialSlots.neon,
        wallMaterial: materialIndex(bank, wallSlot),
        roofMaterial: materialIndex(bank, 3 + roofSlot),
        facadeSeed: hashUnit(`${appearanceMassSeed}/facade-seed`),
        facadeProfile,
        roofline,
        signageRate: range(`${appearanceMassSeed}/signage`, definition.signage.rateMin, definition.signage.rateMax),
        rooftopUtilityRate: range(`${appearanceMassSeed}/rooftop`, definition.rooftopUtility.rateMin, definition.rooftopUtility.rateMax),
        wear: range(`${appearanceMassSeed}/wear`, definition.wear.min, definition.wear.max),
        detailPolicy: definition.geometryPolicy.detail === "none" ? "coarse" : definition.geometryPolicy.neon ? "both" : "detail",
        neonEnabled: definition.geometryPolicy.neon,
        seed: massSeed
      };
    });
  }
}

export function buildCompleteCityPlan(
  source: CitySourceV3,
  revision = 1,
  epoch = 0,
  reservedSites?: readonly MajorLandmarkSiteReservation[]
): CompleteCityPlan {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Complete plan source revision must be a positive integer.");
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("Complete plan epoch must be a non-negative integer.");
  const districtPlan = buildDistrictPlan(source);
  const network = compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY);
  const occupancy = compiledRouteOccupancy(network);
  const carriageway = carriagewayPolygons(network);
  const banks = new Map(derivePaletteBanks(source).map((entry) => [entry.paletteId, entry.bank]));
  const districtById = new Map(source.districts.map((district) => [district.id, district]));
  const reserved = reservedSites ?? reserveMajorLandmarkSites(source);
  // EXPLICIT reservations (the Worker's full-generation flow) are honored verbatim and
  // any road overlap is structural failure — never filtered here. Only INTERNALLY
  // derived reservations (ordinary planning without reservedSites) may be dropped when
  // the roads did not leave their site road-free; the grammar then falls back to a
  // legal block-inscribed site instead of failing the city.
  const explicitReservations = reservedSites !== undefined;
  const honored: MajorLandmarkSiteReservation[] = [];
  const droppedReservations: string[] = [];
  for (const reservation of reserved) {
    if (!explicitReservations && siteOverlapsOccupancy(reservation.sitePolygon, occupancy.all)) {
      droppedReservations.push(reservation.grammarId);
    } else {
      honored.push(reservation);
    }
  }
  const { landmarks: internalLandmarks, skipped, failures: associationFailures, warnings: landmarkWarnings, reservedLandmarkIds } = planLandmarks(source, districtPlan, honored, districtById, explicitReservations);
  const { openSpaces: landmarkOpenSpaces, regions, failedLandmarkIds, failures: carveFailures } = carveLandmarkOpenSpaces(internalLandmarks, districtById, banks);
  // Explicit full-generation reservation sites must always materialize: an un-carveable
  // required open space or empty masses is a structural error, never a silent drop.
  // Fallback (reselect) sites are ordinary planning and drop with accounting instead.
  if ([...failedLandmarkIds].some((id) => reservedLandmarkIds.has(id))) {
    throw new Error(`Explicit landmark reservation could not materialize: ${carveFailures[0]!}`);
  }
  const carvedLandmarks = internalLandmarks.filter((landmark) => !failedLandmarkIds.has(landmark.id));
  materializeLandmarkMasses(carvedLandmarks, regions, districtById, banks);
  const emptyLandmarks = carvedLandmarks.filter((landmark) => landmark.masses.length === 0);
  const emptyReservation = emptyLandmarks.find((landmark) => reservedLandmarkIds.has(landmark.id));
  if (emptyReservation) {
    throw new Error(`Explicit landmark reservation "${emptyReservation.landmarkGrammarId}" produced no masses; full-generation sites must materialize.`);
  }
  const landmarks = carvedLandmarks
    .filter((landmark) => landmark.masses.length > 0)
    .map(({ rawMasses: _rawMasses, ...landmark }) => landmark);
  const allSkipped = [...skipped, ...emptyLandmarks.map((landmark) => landmark.landmarkGrammarId)];
  // Only kept landmark sites are carved from fragments: a dropped landmark's reserved
  // region returns to explicit parcel/open-space/remainder accounting instead of
  // leaving an unexplained void in the city.
  const landmarkSites = new Map(landmarks.map((landmark) => [landmark.id, landmark.sitePolygon]));
  const { parcels: planningParcels, openSpaces, warnings } = planFragments(districtPlan, landmarkSites, districtById, banks);
  const { parcels, buildings, openSpaces: unbuiltOpenSpaces, warnings: buildingWarnings } = planBuildings(planningParcels, districtById, banks, occupancy.all);
  const placedLandmarkIds = new Set(landmarks.map((landmark) => landmark.id));
  const keptLandmarkOpenSpaces = landmarkOpenSpaces.filter((openSpace) => openSpace.landmarkId === null || placedLandmarkIds.has(openSpace.landmarkId));
  const allOpenSpaces = [...keptLandmarkOpenSpaces, ...openSpaces, ...unbuiltOpenSpaces].sort((a, b) => a.id.localeCompare(b.id));
  const landmarkFailures = [
    ...associationFailures,
    ...carveFailures,
    ...emptyLandmarks.map((landmark) => `Landmark "${landmark.landmarkGrammarId}" at "${landmark.placementLineage}" produced no masses and was dropped.`)
  ];
  const structuralInput = completeCityStructuralInput(source);
  const fragmentCount = districtPlan.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0);
  const contentSignature = JSON.stringify({
    structuralInput,
    parcelIds: parcels.map((parcel) => parcel.id),
    openSpaceIds: allOpenSpaces.map((openSpace) => openSpace.id),
    buildingIds: buildings.map((building) => building.id),
    landmarkIds: landmarks.map((landmark) => landmark.id)
  });
  const diagnostics: CompleteCityDiagnostics = {
    blockCount: districtPlan.blocks.length,
    fragmentCount,
    parcelCount: parcels.length,
    openSpaceCount: allOpenSpaces.length,
    buildingCount: buildings.length,
    massCount: buildings.reduce((sum, building) => sum + building.masses.length, 0) + landmarks.reduce((sum, landmark) => sum + landmark.masses.length, 0),
    landmarkCount: landmarks.length,
    landmarkSkipped: allSkipped,
    landmarkFailures,
    explicitReservationCount: explicitReservations && honored.length > 0 ? honored.length : undefined,
    warnings: [
      ...districtPlan.diagnostics.warnings,
      ...landmarkWarnings,
      ...droppedReservations.map((grammarId) => `Major landmark reservation for "${grammarId}" overlaps road occupancy and was dropped; the grammar falls back to a legal block-inscribed site.`),
      ...warnings,
      ...buildingWarnings
    ]
  };
  return {
    openSpaceProfile: source.generation.openSpaceProfile,
    sourceRevision: revision,
    actionToken: stableId("action", `${revision}|${JSON.stringify(structuralInput)}`),
    buildToken: stableId("build", contentSignature),
    epoch,
    structuralInput,
    districtPlan,
    routeOccupancy: occupancy,
    carriageway,
    paletteBanks: derivePaletteBanks(source),
    parcels,
    openSpaces: allOpenSpaces,
    buildings,
    landmarks,
    diagnostics
  };
}

function finiteRing(ring: unknown): ring is Ring {
  return Array.isArray(ring) && ring.length >= 3 && ring.every((point) => isRecord(point) && typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y));
}

function validRing(ring: Ring): boolean {
  return finiteRing(ring) && validateRing(ring).ok;
}

// WHY: the boolean pipeline snaps to 1 mm (boolean.ts SNAP), so any absolute threshold
// smaller than SNAP × shared length misreads legitimate adjacency as overlap or a real
// containment deficiency as an escape. isSnapNoise is the project's canonical gate.
function ringOverlaps(a: Ring, b: Ring): boolean {
  return !isSnapNoise(intersection(ringAsMulti(a), ringAsMulti(b)));
}

function ringContained(inner: Ring, outer: Ring): boolean {
  return isSnapNoise(difference(ringAsMulti(inner), [ringAsMulti(outer)]));
}

function ringCountsAsContained(inner: Ring, container: MultiPolygon): boolean {
  return isSnapNoise(difference(ringAsMulti(inner), [container]));
}

export function validateCompleteCityPlan(plan: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(plan)) return ["Complete city plan must be an object."];
  if (typeof plan.sourceRevision !== "number" || !Number.isInteger(plan.sourceRevision) || plan.sourceRevision < 1) problems.push("Plan sourceRevision must be a positive integer.");
  if (typeof plan.epoch !== "number" || !Number.isInteger(plan.epoch) || plan.epoch < 0) problems.push("Plan epoch must be a non-negative integer.");
  if (typeof plan.actionToken !== "string" || plan.actionToken.length === 0) problems.push("Plan actionToken must be non-empty text.");
  if (typeof plan.buildToken !== "string" || plan.buildToken.length === 0) problems.push("Plan buildToken must be non-empty text.");
  const structuralInput = plan.structuralInput;
  if (!isRecord(structuralInput) || typeof structuralInput.terrain !== "string" || typeof structuralInput.roads !== "string" || typeof structuralInput.districts !== "string" || typeof structuralInput.generation !== "string") {
    problems.push("Plan structuralInput signature is incomplete.");
  }
  if (!isRecord(plan.districtPlan) || !Array.isArray(plan.districtPlan.blocks) || !Array.isArray(plan.districtPlan.developmentCells) || !Array.isArray(plan.districtPlan.openSpaceIntents)) {
    return [...problems, "Plan districtPlan is incomplete."];
  }
  // Validated above: plan.districtPlan is a record with blocks/developmentCells/openSpaceIntents arrays.
  const districtPlan = plan.districtPlan as unknown as DistrictPlan;
  if (!isRecord(plan.routeOccupancy) || !Array.isArray(plan.routeOccupancy.vehicle) || !Array.isArray(plan.routeOccupancy.nonVehicle) || !Array.isArray(plan.routeOccupancy.all) || !Array.isArray(plan.carriageway)) {
    problems.push("Plan route occupancy must be present.");
  }
  if (!Array.isArray(plan.paletteBanks)) problems.push("Plan palette banks must be an array.");
  else {
    const seenBanks = new Set<number>();
    const seenPalettes = new Set<string>();
    let previousPalette: string | null = null;
    for (const entry of plan.paletteBanks) {
      if (!isRecord(entry)) {
        problems.push("Palette bank entry must be an object.");
        continue;
      }
      const paletteId = typeof entry.paletteId === "string" ? entry.paletteId : null;
      if (paletteId === null || paletteId.length === 0) problems.push("Palette bank entry has an invalid palette id.");
      else {
        if (seenPalettes.has(paletteId)) problems.push(`Duplicate palette bank entry for "${paletteId}".`);
        seenPalettes.add(paletteId);
        if (previousPalette !== null && paletteId < previousPalette) problems.push("Palette banks must be sorted by palette id.");
        previousPalette = paletteId;
      }
      const bank = typeof entry.bank === "number" ? entry.bank : NaN;
      if (!Number.isInteger(bank) || bank < FIRST_ZONE_BANK || bank >= BANK_COUNT) problems.push(`Palette bank entry for "${String(entry.paletteId)}" has an out-of-range bank.`);
      else if (seenBanks.has(bank)) problems.push(`Palette bank entries share bank ${bank}.`);
      seenBanks.add(bank);
    }
  }
  const parcels = Array.isArray(plan.parcels) ? (plan.parcels as ParcelPlan[]) : [];
  const openSpaces = Array.isArray(plan.openSpaces) ? (plan.openSpaces as OpenSpacePlan[]) : [];
  const buildings = Array.isArray(plan.buildings) ? (plan.buildings as BuildingPlan[]) : [];
  const landmarks = Array.isArray(plan.landmarks) ? (plan.landmarks as LandmarkPlan[]) : [];
  // `all` was validated as an array in the route-occupancy check above; the landmark site legality check reads it.
  const occupancyAll: MultiPolygon | null = isRecord(plan.routeOccupancy) && Array.isArray(plan.routeOccupancy.all) ? (plan.routeOccupancy.all as MultiPolygon) : null;
  if (!Array.isArray(plan.parcels)) problems.push("Plan parcels must be an array.");
  if (!Array.isArray(plan.openSpaces)) problems.push("Plan openSpaces must be an array.");
  if (!Array.isArray(plan.buildings)) problems.push("Plan buildings must be an array.");
  if (!Array.isArray(plan.landmarks)) problems.push("Plan landmarks must be an array.");
  const diagnostics = plan.diagnostics;
  if (!isRecord(diagnostics)) problems.push("Plan diagnostics must be an object.");
  else {
    if (diagnostics.blockCount !== districtPlan.blocks.length) problems.push("Diagnostics blockCount does not match the district plan.");
    if (diagnostics.parcelCount !== parcels.length) problems.push("Diagnostics parcelCount does not match the parcels array.");
    if (diagnostics.openSpaceCount !== openSpaces.length) problems.push("Diagnostics openSpaceCount does not match the openSpaces array.");
    if (diagnostics.buildingCount !== buildings.length) problems.push("Diagnostics buildingCount does not match the buildings array.");
    if (diagnostics.landmarkCount !== landmarks.length) problems.push("Diagnostics landmarkCount does not match the landmarks array.");
    if (typeof diagnostics.explicitReservationCount === "number" && landmarks.length < diagnostics.explicitReservationCount) {
      problems.push(`Plan has ${landmarks.length} landmarks but ${diagnostics.explicitReservationCount} explicit reservations were required.`);
    }
  }
  const fragmentById = new Map<string, DistrictBlockFragment>();
  const blockById = new Map<string, { buildable: MultiPolygon }>();
  for (const block of districtPlan.blocks) {
    blockById.set(block.id, { buildable: block.buildable });
    for (const fragment of block.districtFragments) {
      fragmentById.set(fragment.id, fragment);
    }
  }
  const parcelIds = new Set<string>();
  for (const parcel of parcels) {
    if (parcelIds.has(parcel.id)) problems.push(`Duplicate parcel id "${parcel.id}".`);
    parcelIds.add(parcel.id);
    if (!validRing(parcel.polygon)) problems.push(`Parcel "${parcel.id}" has an invalid polygon.`);
    const fragment = fragmentById.get(parcel.fragmentId);
    if (!fragment) problems.push(`Parcel "${parcel.id}" references unknown fragment "${parcel.fragmentId}".`);
    else if (validRing(parcel.polygon) && !ringCountsAsContained(parcel.polygon, fragment.buildable)) {
      problems.push(`Parcel "${parcel.id}" is not contained in its fragment buildable.`);
    }
    if (!(parcel.frontageRoadId === null || typeof parcel.frontageRoadId === "string")) problems.push(`Parcel "${parcel.id}" has an invalid frontage road id.`);
    if (!Number.isFinite(parcel.frontageAngleRad)) problems.push(`Parcel "${parcel.id}" has an invalid frontage angle.`);
  }
  const openSpaceIds = new Set<string>();
  for (const openSpace of openSpaces) {
    if (openSpaceIds.has(openSpace.id)) problems.push(`Duplicate open-space id "${openSpace.id}".`);
    openSpaceIds.add(openSpace.id);
    if (!validRing(openSpace.polygon)) problems.push(`Open space "${openSpace.id}" has an invalid polygon.`);
    if (!(openSpace.landmarkId === null || landmarks.some((landmark) => landmark.id === openSpace.landmarkId))) problems.push(`Open space "${openSpace.id}" references unknown landmark "${openSpace.landmarkId}".`);
    if (openSpace.parcelId !== null) {
      const parcel = parcels.find((candidate) => candidate.id === openSpace.parcelId);
      if (!parcel) problems.push(`Open space "${openSpace.id}" references unknown parcel "${openSpace.parcelId}".`);
      else if (validRing(openSpace.polygon) && !ringContained(openSpace.polygon, parcel.polygon)) problems.push(`Open space "${openSpace.id}" is not contained in its parcel "${parcel.id}".`);
    }
    if (typeof openSpace.material !== "number" || !Number.isFinite(openSpace.material) || openSpace.material < 0 || openSpace.material >= BANK_COUNT * 8) problems.push(`Open space "${openSpace.id}" has an invalid material index.`);
  }
  const buildingIds = new Set<string>();
  for (const building of buildings) {
    if (buildingIds.has(building.id)) problems.push(`Duplicate building id "${building.id}".`);
    buildingIds.add(building.id);
    if (!parcelIds.has(building.parcelId)) problems.push(`Building "${building.id}" references unknown parcel "${building.parcelId}".`);
    if (!BUILDING_GRAMMAR_REGISTRY.has(building.grammarId)) problems.push(`Building "${building.id}" references unknown grammar "${building.grammarId}".`);
    if (!Array.isArray(building.masses) || building.masses.length === 0) problems.push(`Building "${building.id}" has no masses.`);
    const parcel = parcels.find((candidate) => candidate.id === building.parcelId);
    const grammar = BUILDING_GRAMMAR_REGISTRY.get(building.grammarId);
    if (grammar && parcel && !grammarFitsParcel(grammar, parcel)) {
      problems.push(`Building "${building.id}" grammar "${building.grammarId}" does not fit its parcel "${parcel.id}".`);
    }
    if (grammar && Array.isArray(building.masses) && !(building.masses.length >= grammar.massing.minMasses && building.masses.length <= grammar.massing.maxMasses)) {
      problems.push(`Building "${building.id}" has ${building.masses.length} masses outside grammar "${building.grammarId}" declared range ${grammar.massing.minMasses}-${grammar.massing.maxMasses}.`);
    }
    // WHY: grammar height describes the whole building, not each stacked mass independently.
    if (grammar && Number.isFinite(building.heightM) && Array.isArray(building.masses) && building.masses.length > 0) {
      const peak = Math.max(...building.masses.map((mass) => mass.elevationM + mass.heightM));
      if (Math.abs(peak - building.heightM) > GEOMETRY_EPSILON) {
        problems.push(`Building "${building.id}" total height ${building.heightM} does not match its masses' peak ${peak}.`);
      }
    }
    if (grammar && Number.isFinite(building.heightM) && !(building.heightM >= grammar.height.minM - GEOMETRY_EPSILON && building.heightM <= grammar.height.maxM + GEOMETRY_EPSILON)) {
      problems.push(`Building "${building.id}" total height ${building.heightM} is outside grammar "${building.grammarId}" declared range ${grammar.height.minM}-${grammar.height.maxM}.`);
    }
    for (const mass of building.masses) {
      if (!validRing(mass.footprint)) problems.push(`Building "${building.id}" mass ${mass.index} has an invalid footprint.`);
      if (!Number.isFinite(mass.elevationM) || mass.elevationM < 0 || !(mass.heightM > 0)) problems.push(`Building "${building.id}" mass ${mass.index} has invalid elevation or height.`);
      if (grammar && mass.elevationM + mass.heightM > grammar.height.maxM + GEOMETRY_EPSILON) {
        problems.push(`Building "${building.id}" mass ${mass.index} top exceeds grammar "${building.grammarId}" declared maximum height.`);
      }
      if (parcel && validRing(mass.footprint) && !ringContained(mass.footprint, parcel.polygon)) problems.push(`Building "${building.id}" mass ${mass.index} is not contained in its parcel.`);
      if (typeof mass.neonEnabled !== "boolean") problems.push(`Building "${building.id}" mass ${mass.index} has an invalid neon flag.`);
    }
    for (let left = 0; left < building.masses.length; left++) {
      for (let right = left + 1; right < building.masses.length; right++) {
        const a = building.masses[left]!;
        const b = building.masses[right]!;
        // WHY: stacked volumes may share footprint only when their elevation spans do not overlap.
        const spansOverlap = a.elevationM < b.elevationM + b.heightM && b.elevationM < a.elevationM + a.heightM;
        if (spansOverlap && ringOverlaps(a.footprint, b.footprint)) {
          problems.push(`Building "${building.id}" masses ${left} and ${right} overlap.`);
        }
      }
    }
  }
  for (const landmark of landmarks) {
    if (!LANDMARK_GRAMMAR_REGISTRY.has(landmark.landmarkGrammarId)) problems.push(`Landmark "${landmark.id}" references unknown grammar "${landmark.landmarkGrammarId}".`);
    if (!validRing(landmark.sitePolygon)) problems.push(`Landmark "${landmark.id}" has an invalid site polygon.`);
    if (!Array.isArray(landmark.masses) || landmark.masses.length === 0) problems.push(`Landmark "${landmark.id}" has no masses.`);
    const block = landmark.blockId ? blockById.get(landmark.blockId) : undefined;
    if (landmark.blockId && !block) problems.push(`Landmark "${landmark.id}" references unknown block "${landmark.blockId}".`);
    if (block && validRing(landmark.sitePolygon) && !ringCountsAsContained(landmark.sitePolygon, block.buildable)) {
      problems.push(`Landmark "${landmark.id}" site is not contained in its block buildable.`);
    }
    for (const mass of landmark.masses) {
      if (!validRing(mass.footprint)) problems.push(`Landmark "${landmark.id}" mass ${mass.index} has an invalid footprint.`);
      if (validRing(mass.footprint) && !ringContained(mass.footprint, landmark.sitePolygon)) problems.push(`Landmark "${landmark.id}" mass ${mass.index} is not contained in its site.`);
      if (typeof mass.neonEnabled !== "boolean") problems.push(`Landmark "${landmark.id}" mass ${mass.index} has an invalid neon flag.`);
    }
    for (const openSpaceId of landmark.openSpaceIds) {
      if (!openSpaceIds.has(openSpaceId)) problems.push(`Landmark "${landmark.id}" references unknown open space "${openSpaceId}".`);
    }
    if (validRing(landmark.sitePolygon) && occupancyAll !== null && siteOverlapsOccupancy(landmark.sitePolygon, occupancyAll)) {
      problems.push(`Landmark "${landmark.id}" site overlaps road occupancy; the reservation is not legal.`);
    }
    const landmarkGrammar = LANDMARK_GRAMMAR_REGISTRY.get(landmark.landmarkGrammarId);
    if (landmarkGrammar && validRing(landmark.sitePolygon) && Math.abs(ringArea(landmark.sitePolygon)) > landmarkGrammar.maxSiteAreaM2 + 0.5) {
      problems.push(`Landmark "${landmark.id}" site exceeds the declared maximum area of its grammar.`);
    }
    // Required open space is enforced for sites meeting the grammar's declared minimum;
    // a below-minimum site (hand-built fixtures) is already outside the grammar contract.
    const requirement = landmarkGrammar?.requiredOpenSpace;
    if (requirement) {
      const siteArea = validRing(landmark.sitePolygon) ? Math.abs(ringArea(landmark.sitePolygon)) : 0;
      if (siteArea >= (landmarkGrammar?.minSiteAreaM2 ?? 0)) {
        const owned = (landmark.openSpaceIds ?? [])
          .map((id) => openSpaces.find((openSpace) => openSpace.id === id))
          .filter((openSpace): openSpace is OpenSpacePlan => openSpace !== undefined);
        const matching = owned.filter((openSpace) => openSpace.category === requirement.category);
        if (matching.length === 0) {
          problems.push(`Landmark "${landmark.id}" grammar "${landmark.landmarkGrammarId}" requires ${requirement.category} open space but has none.`);
        } else {
          const covered = matching.reduce((sum, openSpace) => sum + openSpace.areaM2, 0);
          if (covered + 0.5 < requirement.minShare * siteArea) {
            problems.push(`Landmark "${landmark.id}" required ${requirement.category} open space covers too little of its site.`);
          }
        }
      }
    }
  }
  for (const openSpace of openSpaces) {
    if (openSpace.landmarkId === null) continue;
    const landmark = landmarks.find((candidate) => candidate.id === openSpace.landmarkId);
    if (landmark && validRing(openSpace.polygon) && validRing(landmark.sitePolygon) && !ringContained(openSpace.polygon, landmark.sitePolygon)) {
      problems.push(`Landmark open space "${openSpace.id}" is not contained in its landmark site.`);
    }
    if (landmark && validRing(openSpace.polygon)) {
      for (const mass of landmark.masses) {
        if (validRing(mass.footprint) && ringOverlaps(mass.footprint, openSpace.polygon)) {
          problems.push(`Landmark "${landmark.id}" mass ${mass.index} overlaps its own required open space.`);
        }
      }
    }
  }
  // Bbox prefilters keep the peer-disjointness checks linear in practice: the boolean
  // intersection only runs for pairs whose bounds can actually touch.
  const parcelBounds = parcels.map((parcel) => ringBounds(parcel.polygon));
  const openSpaceBounds = openSpaces.map((openSpace) => ringBounds(openSpace.polygon));
  for (let left = 0; left < parcels.length; left++) {
    for (let right = left + 1; right < parcels.length; right++) {
      if (!rectsIntersect(parcelBounds[left]!, parcelBounds[right]!)) continue;
      if (ringOverlaps(parcels[left]!.polygon, parcels[right]!.polygon)) problems.push(`Parcels "${parcels[left]!.id}" and "${parcels[right]!.id}" overlap.`);
    }
  }
  for (let left = 0; left < parcels.length; left++) {
    for (let right = 0; right < openSpaces.length; right++) {
      const openSpace = openSpaces[right]!;
      // Parcel-linked open spaces ARE the parcel's own classification; only other open
      // spaces must be disjoint from the parcel.
      if (openSpace.landmarkId !== null || openSpace.parcelId !== null) continue;
      if (!rectsIntersect(parcelBounds[left]!, openSpaceBounds[right]!)) continue;
      if (ringOverlaps(parcels[left]!.polygon, openSpace.polygon)) problems.push(`Parcel "${parcels[left]!.id}" overlaps open space "${openSpace.id}".`);
    }
  }
  for (let left = 0; left < openSpaces.length; left++) {
    for (let right = left + 1; right < openSpaces.length; right++) {
      if (!rectsIntersect(openSpaceBounds[left]!, openSpaceBounds[right]!)) continue;
      if (ringOverlaps(openSpaces[left]!.polygon, openSpaces[right]!.polygon)) problems.push(`Open spaces "${openSpaces[left]!.id}" and "${openSpaces[right]!.id}" overlap.`);
    }
  }
  for (const building of buildings) {
    for (let right = 0; right < openSpaces.length; right++) {
      const openSpace = openSpaces[right]!;
      if (openSpace.landmarkId !== null) continue;
      // An unbuilt parcel's own vacant open space is the parcel itself, not a foreign obstacle.
      if (openSpace.parcelId === building.parcelId) continue;
      for (const mass of building.masses) {
        if (!rectsIntersect(ringBounds(mass.footprint), openSpaceBounds[right]!)) continue;
        if (ringOverlaps(mass.footprint, openSpace.polygon)) problems.push(`Building "${building.id}" mass overlaps open space "${openSpace.id}".`);
      }
    }
  }
  // Bbox-prefiltered cross-occupancy: parcels and ordinary masses must never enter a
  // landmark site, and ordinary masses must stay disjoint from landmark masses unless
  // their elevation spans do not overlap (the stacked-podium exception).
  const landmarkSiteBounds = landmarks.map((landmark) => ringBounds(landmark.sitePolygon));
  for (const parcel of parcels) {
    if (!validRing(parcel.polygon)) continue;
    const parcelBound = ringBounds(parcel.polygon);
    for (let index = 0; index < landmarks.length; index++) {
      if (!rectsIntersect(parcelBound, landmarkSiteBounds[index]!)) continue;
      if (ringOverlaps(parcel.polygon, landmarks[index]!.sitePolygon)) problems.push(`Parcel "${parcel.id}" overlaps landmark site "${landmarks[index]!.id}".`);
    }
  }
  for (const building of buildings) {
    for (const mass of building.masses) {
      if (!validRing(mass.footprint)) continue;
      const massBound = ringBounds(mass.footprint);
      for (let index = 0; index < landmarks.length; index++) {
        const landmark = landmarks[index]!;
        if (!rectsIntersect(massBound, landmarkSiteBounds[index]!)) continue;
        if (ringOverlaps(mass.footprint, landmark.sitePolygon)) problems.push(`Building "${building.id}" mass ${mass.index} overlaps landmark site "${landmark.id}".`);
        for (const landmarkMass of landmark.masses) {
          if (!validRing(landmarkMass.footprint) || !rectsIntersect(massBound, ringBounds(landmarkMass.footprint))) continue;
          const spansOverlap = mass.elevationM < landmarkMass.elevationM + landmarkMass.heightM && landmarkMass.elevationM < mass.elevationM + mass.heightM;
          if (spansOverlap && ringOverlaps(mass.footprint, landmarkMass.footprint)) {
            problems.push(`Building "${building.id}" mass ${mass.index} overlaps landmark "${landmark.id}" mass ${landmarkMass.index}.`);
          }
        }
      }
    }
  }
  return problems;
}
