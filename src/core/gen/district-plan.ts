import { compileRouteNetwork, type CompiledRouteNetwork } from "../graph/compiler.js";
import { difference, intersection, ringAsMulti, union } from "../geom/boolean.js";
import { rectRing, ringArea, ringBounds, ringCentroid, type MultiPolygon, type Ring, type Vec2 } from "../geom/types.js";
import { triangulate } from "../geom/tessellate.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV3, type DistrictOpenSpaceProfile, type DistrictSource, type OpenSpaceCategory, type OpenSpaceSize, type RouteClassId } from "./city.js";
import {
  BLOCK_GRAMMAR_IDS,
  DISTRICT_TYPE_REGISTRY,
  type BlockGrammarId,
  type DistrictPlanningBounds,
  type DistrictTypeDefinition
} from "./district-registry.js";
import { normalizeRing, validateRing } from "./terrain.js";

const GEOMETRY_EPSILON = 1e-6;
const KEY_SCALE = 1_000;
const MIN_CELL_AREA_M2 = 1;
const MAX_CELLS_PER_FRAGMENT = 384;
const CELL_GAP_M = 0.1;

export interface StructuralInputSignature {
  terrain: string;
  roads: string;
  districts: string;
  generation: string;
}

export interface DistrictBlockFragment {
  id: string;
  blockId: string;
  districtId: string | null;
  buildable: MultiPolygon;
}

export interface DerivedBlock {
  id: string;
  zoningFace: Ring;
  buildable: MultiPolygon;
  boundaryRoadIds: string[];
  districtFragments: DistrictBlockFragment[];
}

export interface DevelopmentCellPlan {
  id: string;
  blockId: string;
  fragmentId: string;
  districtId: string | null;
  grammarId: BlockGrammarId;
  polygon: Ring;
  localRole: string;
  rotationRad: number;
  frontageRoadId: string | null;
}

export interface BlockOpenSpaceIntent {
  blockId: string;
  fragmentId: string;
  districtId: string | null;
  category: OpenSpaceCategory | null;
  size: OpenSpaceSize | null;
  targetShare: number;
  seed: string;
}

export interface DistrictPlanDiagnostics {
  faceCount: number;
  blockCount: number;
  fragmentCount: number;
  developmentCellCount: number;
  discardedFaceCount: number;
  discardedCellCount: number;
  warnings: string[];
}

export interface DistrictPlan {
  revisionInputs: StructuralInputSignature;
  blocks: DerivedBlock[];
  developmentCells: DevelopmentCellPlan[];
  openSpaceIntents: BlockOpenSpaceIntent[];
  unzoned: MultiPolygon;
  wallCells: MultiPolygon;
  diagnostics: DistrictPlanDiagnostics;
}

interface PlanarSegment {
  a: Vec2;
  b: Vec2;
  roadIds: Set<string>;
  boundaryRoles: Set<string>;
}

interface GraphEdge extends PlanarSegment {
  id: number;
  aKey: string;
  bKey: string;
}

interface FaceCandidate {
  ring: Ring;
  boundaryRoadIds: string[];
  boundaryRoles: string[];
  geometrySignature: string;
}

interface GrammarShape {
  widthFactor: number;
  depthFactor: number;
  angleOffset: number;
  stagger: number;
  sparse: number;
}

const GRAMMAR_SHAPES: Readonly<Record<BlockGrammarId, GrammarShape>> = {
  "perimeter-courtyard": { widthFactor: 0.85, depthFactor: 0.72, angleOffset: 0, stagger: 0, sparse: 0.04 }, // Tuned: reduced skip rate for tighter residential grain
  "fine-grain-frontage": { widthFactor: 0.48, depthFactor: 0.72, angleOffset: 0, stagger: 0.5, sparse: 0 },
  "rotated-bands": { widthFactor: 0.72, depthFactor: 1.2, angleOffset: 0, stagger: 0.5, sparse: 0 }, // Tuned: aligned with street frontage
  "irregular-mosaic": { widthFactor: 0.78, depthFactor: 0.82, angleOffset: 0, stagger: 0.35, sparse: 0.08 },
  "superblock-compound": { widthFactor: 1.7, depthFactor: 1.55, angleOffset: 0, stagger: 0, sparse: 0.05 },
  "tower-podium-field": { widthFactor: 1.25, depthFactor: 1.25, angleOffset: 0, stagger: 0.25, sparse: 0.03 }, // Tuned: aligned with street frontage
  "industrial-yard": { widthFactor: 1.1, depthFactor: 1.1, angleOffset: 0, stagger: 0.5, sparse: 0.05 }, // Tuned: aligned with street frontage
  "logistics-sheds": { widthFactor: 0.92, depthFactor: 1.35, angleOffset: 0, stagger: 0.5, sparse: 0.08 },
  "campus-pavilions": { widthFactor: 1.25, depthFactor: 1.1, angleOffset: 0, stagger: 0.5, sparse: 0.18 }, // Tuned: aligned with street frontage
  "market-alley": { widthFactor: 0.38, depthFactor: 0.62, angleOffset: 0, stagger: 0.5, sparse: 0.05 },
  "radial-fan": { widthFactor: 1, depthFactor: 1, angleOffset: 0, stagger: 0, sparse: 0 },
  "waterfront-terraces": { widthFactor: 0.78, depthFactor: 1.45, angleOffset: 0, stagger: 0.5, sparse: 0.12 }
};

const PROFILE_RATES = { none: 0, "very-low": 0.025, low: 0.075, medium: 0.14, high: 0.23 } as const;
const categoryGate = (...categories: OpenSpaceCategory[]): readonly OpenSpaceCategory[] => Object.freeze(categories);
export const OPEN_SPACE_PROFILE_CATEGORY_GATES: Readonly<Record<DistrictOpenSpaceProfile, readonly OpenSpaceCategory[]>> = Object.freeze({
  none: categoryGate(),
  "very-low": categoryGate("park", "plaza"),
  low: categoryGate("park", "plaza", "landscaping"),
  medium: categoryGate("park", "plaza", "parking", "vacant", "landscaping", "service-yard"),
  high: categoryGate("park", "plaza", "parking", "vacant", "utility", "landscaping", "service-yard")
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

function pointKey(point: Vec2): string {
  return `${Math.round(point.x * KEY_SCALE)},${Math.round(point.y * KEY_SCALE)}`;
}

function keyPoint(key: string): Vec2 {
  const [x, y] = key.split(",").map(Number);
  return { x: x! / KEY_SCALE, y: y! / KEY_SCALE };
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= GEOMETRY_EPSILON;
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Vec2, a: Vec2, b: Vec2): boolean {
  if (Math.abs(cross(a, b, point)) > GEOMETRY_EPSILON) return false;
  return point.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON && point.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON && point.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON;
}

function pointInOrOnRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (pointOnSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

function canonicalRing(ring: Ring): Ring {
  const snapped: Ring = [];
  for (const point of ring) {
    const next = keyPoint(pointKey(point));
    const previous = snapped[snapped.length - 1];
    if (!previous || !samePoint(previous, next)) snapped.push(next);
  }
  if (snapped.length > 1 && samePoint(snapped[0]!, snapped[snapped.length - 1]!)) snapped.pop();
  const normalized = normalizeRing(snapped);
  if (normalized.length === 0) return [];
  let start = 0;
  for (let i = 1; i < normalized.length; i++) {
    const a = normalized[i]!;
    const b = normalized[start]!;
    if (a.x < b.x || (a.x === b.x && a.y < b.y)) start = i;
  }
  return [...normalized.slice(start), ...normalized.slice(0, start)];
}

function holeFreePieces(polygon: MultiPolygon[number]): Ring[] {
  if (polygon.length === 1 && validateRing(polygon[0]!).ok) return [polygon[0]!];
  const mesh = triangulate(polygon);
  const pieces: Ring[] = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const ring = [mesh.positions[mesh.indices[index]!]!, mesh.positions[mesh.indices[index + 1]!]!, mesh.positions[mesh.indices[index + 2]!]!];
    if (Math.abs(ringArea(ring)) > GEOMETRY_EPSILON) pieces.push(ring);
  }
  if (pieces.length === 0) {
    const sourceArea = multiArea([polygon]);
    if (sourceArea >= 0 && sourceArea < MIN_CELL_AREA_M2) return [];
    throw new Error("Unsupported holed planning geometry could not be decomposed.");
  }
  return pieces;
}

export function canonicalHoleFreePieces(polygon: MultiPolygon[number]): Ring[] {
  const pieces: Ring[] = [];
  let sourceArea = 0;
  for (const source of holeFreePieces(polygon)) {
    sourceArea += Math.abs(ringArea(source));
    const canonical = canonicalRing(source);
    if (validateRing(canonical).ok) {
      pieces.push(canonical);
      continue;
    }
    const mesh = triangulate([source]);
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const triangle = canonicalRing([
        mesh.positions[mesh.indices[index]!]!,
        mesh.positions[mesh.indices[index + 1]!]!,
        mesh.positions[mesh.indices[index + 2]!]!
      ]);
      if (Math.abs(ringArea(triangle)) <= GEOMETRY_EPSILON) continue;
      const validation = validateRing(triangle);
      if (!validation.ok) throw new Error(`Canonical planning geometry could not be decomposed: ${validation.reason}`);
      pieces.push(triangle);
    }
  }
  if (pieces.length === 0 && sourceArea >= MIN_CELL_AREA_M2) {
    throw new Error(`Canonical planning geometry of ${sourceArea} square metres could not be decomposed.`);
  }
  return pieces;
}

function ringSignature(ring: Ring): string {
  return canonicalRing(ring).map((point) => pointKey(point)).join(";");
}

function multiSignature(multi: MultiPolygon): string {
  return multi.map((polygon) => polygon.map(ringSignature).join("/")).sort().join("|");
}

function multiArea(multi: MultiPolygon): number {
  return multi.reduce((sum, polygon) => sum + polygon.reduce((polygonSum, ring, index) => polygonSum + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);
}

function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { point: Vec2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t < -GEOMETRY_EPSILON || t > 1 + GEOMETRY_EPSILON || u < -GEOMETRY_EPSILON || u > 1 + GEOMETRY_EPSILON) return null;
  return { point: { x: a.x + rx * t, y: a.y + ry * t }, t: Math.max(0, Math.min(1, t)), u: Math.max(0, Math.min(1, u)) };
}

function uniqueParameters(values: number[]): number[] {
  return [...values].sort((a, b) => a - b).filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]!) > GEOMETRY_EPSILON);
}

function clippedRoadSegments(network: CompiledRouteNetwork, mask: Ring): PlanarSegment[] {
  const segments: PlanarSegment[] = [];
  for (const span of network.segments) {
    if (!span.vehicle) continue;
    const ts = [0, 1];
    for (let i = 0; i < mask.length; i++) {
      const hit = segmentIntersection(span.a, span.b, mask[i]!, mask[(i + 1) % mask.length]!);
      if (hit) ts.push(hit.t);
    }
    const ordered = uniqueParameters(ts);
    for (let i = 0; i + 1 < ordered.length; i++) {
      const t0 = ordered[i]!;
      const t1 = ordered[i + 1]!;
      const middle = (t0 + t1) / 2;
      const midpoint = { x: span.a.x + (span.b.x - span.a.x) * middle, y: span.a.y + (span.b.y - span.a.y) * middle };
      if (!pointInOrOnRing(midpoint, mask)) continue;
      const a = { x: span.a.x + (span.b.x - span.a.x) * t0, y: span.a.y + (span.b.y - span.a.y) * t0 };
      const b = { x: span.a.x + (span.b.x - span.a.x) * t1, y: span.a.y + (span.b.y - span.a.y) * t1 };
      if (!samePoint(a, b)) segments.push({ a, b, roadIds: new Set([span.edgeId]), boundaryRoles: new Set() });
    }
  }
  return segments;
}

function splitPlanarSegments(roadSegments: PlanarSegment[], mask: Ring): PlanarSegment[] {
  const boundarySegments: PlanarSegment[] = mask.map((a, index) => {
    const b = mask[(index + 1) % mask.length]!;
    const role = `mask:${[pointKey(a), pointKey(b)].sort().join("-")}`;
    return { a, b, roadIds: new Set(), boundaryRoles: new Set([role]) };
  });
  const all = [...roadSegments, ...boundarySegments];
  const splits = all.map(() => [0, 1]);
  for (let i = 0; i < all.length; i++) {
    const first = all[i]!;
    const firstBounds = ringBounds([first.a, first.b]);
    for (let j = i + 1; j < all.length; j++) {
      const second = all[j]!;
      const secondBounds = ringBounds([second.a, second.b]);
      if (firstBounds.x > secondBounds.x + secondBounds.width + GEOMETRY_EPSILON || secondBounds.x > firstBounds.x + firstBounds.width + GEOMETRY_EPSILON ||
        firstBounds.y > secondBounds.y + secondBounds.height + GEOMETRY_EPSILON || secondBounds.y > firstBounds.y + firstBounds.height + GEOMETRY_EPSILON) continue;
      const hit = segmentIntersection(first.a, first.b, second.a, second.b);
      if (!hit) continue;
      splits[i]!.push(hit.t);
      splits[j]!.push(hit.u);
    }
  }
  const pieces: PlanarSegment[] = [];
  for (let i = 0; i < all.length; i++) {
    const segment = all[i]!;
    const ordered = uniqueParameters(splits[i]!);
    for (let j = 0; j + 1 < ordered.length; j++) {
      const t0 = ordered[j]!;
      const t1 = ordered[j + 1]!;
      const a = { x: segment.a.x + (segment.b.x - segment.a.x) * t0, y: segment.a.y + (segment.b.y - segment.a.y) * t0 };
      const b = { x: segment.a.x + (segment.b.x - segment.a.x) * t1, y: segment.a.y + (segment.b.y - segment.a.y) * t1 };
      if (!samePoint(a, b)) pieces.push({ a, b, roadIds: new Set(segment.roadIds), boundaryRoles: new Set(segment.boundaryRoles) });
    }
  }
  const deduped = new Map<string, PlanarSegment>();
  for (const piece of pieces) {
    const key = [pointKey(piece.a), pointKey(piece.b)].sort().join("|");
    const existing = deduped.get(key);
    if (existing) {
      for (const id of piece.roadIds) existing.roadIds.add(id);
      for (const role of piece.boundaryRoles) existing.boundaryRoles.add(role);
    } else deduped.set(key, piece);
  }
  return [...deduped.values()];
}

function removeBridges(segments: PlanarSegment[]): GraphEdge[] {
  const edges: GraphEdge[] = segments.map((segment, id) => ({ ...segment, id, aKey: pointKey(segment.a), bKey: pointKey(segment.b) }));
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    adjacency.set(edge.aKey, [...(adjacency.get(edge.aKey) ?? []), edge]);
    adjacency.set(edge.bKey, [...(adjacency.get(edge.bKey) ?? []), edge]);
  }
  const seen = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  let time = 0;
  const visit = (node: string, parentEdge: number): void => {
    seen.set(node, ++time);
    low.set(node, time);
    for (const edge of adjacency.get(node) ?? []) {
      if (edge.id === parentEdge) continue;
      const next = edge.aKey === node ? edge.bKey : edge.aKey;
      if (!seen.has(next)) {
        visit(next, edge.id);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
        if (low.get(next)! > seen.get(node)!) bridges.add(edge.id);
      } else low.set(node, Math.min(low.get(node)!, seen.get(next)!));
    }
  };
  for (const node of [...adjacency.keys()].sort()) if (!seen.has(node)) visit(node, -1);
  return edges.filter((edge) => !bridges.has(edge.id));
}

function extractFaces(network: CompiledRouteNetwork, mask: Ring): { faces: FaceCandidate[]; discarded: number } {
  const edges = removeBridges(splitPlanarSegments(clippedRoadSegments(network, mask), mask));
  const outgoing = new Map<string, { edge: GraphEdge; to: string; angle: number }[]>();
  for (const edge of edges) {
    const a = keyPoint(edge.aKey);
    const b = keyPoint(edge.bKey);
    outgoing.set(edge.aKey, [...(outgoing.get(edge.aKey) ?? []), { edge, to: edge.bKey, angle: Math.atan2(b.y - a.y, b.x - a.x) }]);
    outgoing.set(edge.bKey, [...(outgoing.get(edge.bKey) ?? []), { edge, to: edge.aKey, angle: Math.atan2(a.y - b.y, a.x - b.x) }]);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.angle - b.angle || a.to.localeCompare(b.to));
  const visited = new Set<string>();
  const faces: FaceCandidate[] = [];
  let discarded = 0;
  for (const from of [...outgoing.keys()].sort()) {
    for (const start of outgoing.get(from) ?? []) {
      const startDart = `${from}>${start.to}`;
      if (visited.has(startDart)) continue;
      const ring: Ring = [];
      const roadIds = new Set<string>();
      const boundaryRoles = new Set<string>();
      let currentFrom = from;
      let currentTo = start.to;
      let closed = false;
      for (let steps = 0; steps <= edges.length * 2 + 2; steps++) {
        const dart = `${currentFrom}>${currentTo}`;
        if (visited.has(dart)) {
          closed = dart === startDart;
          break;
        }
        visited.add(dart);
        ring.push(keyPoint(currentFrom));
        const edge = (outgoing.get(currentFrom) ?? []).find((candidate) => candidate.to === currentTo)?.edge;
        if (!edge) break;
        for (const id of edge.roadIds) roadIds.add(id);
        for (const role of edge.boundaryRoles) boundaryRoles.add(role);
        const nextList = outgoing.get(currentTo) ?? [];
        const reverse = nextList.findIndex((candidate) => candidate.to === currentFrom);
        if (reverse < 0 || nextList.length === 0) break;
        const next = nextList[(reverse - 1 + nextList.length) % nextList.length]!;
        currentFrom = currentTo;
        currentTo = next.to;
      }
      if (!closed || ring.length < 3 || ringArea(ring) <= GEOMETRY_EPSILON) {
        discarded++;
        continue;
      }
      const canonical = canonicalRing(ring);
      faces.push({ ring: canonical, boundaryRoadIds: [...roadIds].sort(), boundaryRoles: [...boundaryRoles].sort(), geometrySignature: ringSignature(canonical) });
    }
  }
  return { faces: faces.sort((a, b) => a.geometrySignature.localeCompare(b.geometrySignature)), discarded };
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

export interface RouteOccupancy {
  vehicle: MultiPolygon;
  nonVehicle: MultiPolygon;
  all: MultiPolygon;
}

export function compiledRouteOccupancy(network: CompiledRouteNetwork): RouteOccupancy {
  const vehicle: MultiPolygon[] = [];
  const nonVehicle: MultiPolygon[] = [];
  const radii = new Map<string, { point: Vec2; radius: number; vehicle: boolean }>();
  for (const segment of network.segments) {
    const cls = ROUTE_CLASS_REGISTRY.get(segment.classId as RouteClassId);
    if (!cls || segment.lengthM <= GEOMETRY_EPSILON) continue;
    const halfWidth = cls.vehicle ? segment.clearanceM : segment.widthM / 2;
    const target = cls.vehicle ? vehicle : nonVehicle;
    target.push(ringAsMulti(edgeQuad(segment.a, segment.b, halfWidth)));
    for (const point of [segment.a, segment.b]) {
      const key = `${cls.vehicle ? "v" : "n"}:${pointKey(point)}`;
      const previous = radii.get(key);
      if (!previous || halfWidth > previous.radius) radii.set(key, { point, radius: halfWidth, vehicle: cls.vehicle });
    }
  }
  for (const endpoint of radii.values()) (endpoint.vehicle ? vehicle : nonVehicle).push(ringAsMulti(nodeDisc(endpoint.point, endpoint.radius)));
  const vehicleUnion = union(vehicle);
  const nonVehicleUnion = difference(union(nonVehicle), [vehicleUnion]);
  return { vehicle: vehicleUnion, nonVehicle: nonVehicleUnion, all: union([vehicleUnion, nonVehicleUnion]) };
}

export function districtStructuralInputSignature(source: CitySourceV3): StructuralInputSignature {
  const nodes = [...source.roads.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const routes = [...source.roads.routes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...source.roads.edges].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, a, b, routeId, classId }) => ({ id, a, b, routeId, classId }));
  const districts = [...source.districts].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, polygon, seed, typeId, openSpaceOverride }) => ({ id, polygon, seed, typeId, openSpaceOverride }));
  return {
    terrain: stableId("terrain", `${ringSignature(source.terrain.land)}|${source.terrain.urbanFootprint ? ringSignature(source.terrain.urbanFootprint) : ""}`),
    roads: stableId("roads", JSON.stringify({ nodes, routes, edges })),
    districts: stableId("districts", JSON.stringify(districts)),
    generation: stableId("generation", JSON.stringify({ districtPool: [...source.generation.districtPool].sort(), openSpaceProfile: source.generation.openSpaceProfile }))
  };
}

function blockCandidates(source: CitySourceV3, network: CompiledRouteNetwork, wallCells: MultiPolygon): { blocks: DerivedBlock[]; discarded: number; warnings: string[] } {
  const mask = normalizeRing(source.terrain.urbanFootprint ?? source.terrain.land);
  const extracted = extractFaces(network, mask);
  const rejected = new Set<number>();
  const bridgeAttached = (face: FaceCandidate): boolean => {
    const boundaryRoadIds = new Set(face.boundaryRoadIds);
    const boundaryNodeIds = new Set<string>();
    for (const edge of source.roads.edges) {
      if (!boundaryRoadIds.has(edge.id)) continue;
      boundaryNodeIds.add(edge.a);
      boundaryNodeIds.add(edge.b);
    }
    return source.roads.edges.some((edge) =>
      !boundaryRoadIds.has(edge.id) &&
      ROUTE_CLASS_REGISTRY.get(edge.classId)?.vehicle === true &&
      (boundaryNodeIds.has(edge.a) || boundaryNodeIds.has(edge.b))
    );
  };
  for (let first = 0; first < extracted.faces.length; first++) for (let second = first + 1; second < extracted.faces.length; second++) {
    const overlap = multiArea(intersection(ringAsMulti(extracted.faces[first]!.ring), ringAsMulti(extracted.faces[second]!.ring)));
    if (overlap <= GEOMETRY_EPSILON) continue;
    const firstArea = Math.abs(ringArea(extracted.faces[first]!.ring));
    const secondArea = Math.abs(ringArea(extracted.faces[second]!.ring));
    const tolerance = Math.max(GEOMETRY_EPSILON, Math.min(firstArea, secondArea) * 1e-8);
    let enclosing: number;
    let enclosed: number;
    if (firstArea > secondArea + tolerance && Math.abs(overlap - secondArea) <= tolerance) {
      enclosing = first;
      enclosed = second;
    } else if (secondArea > firstArea + tolerance && Math.abs(overlap - firstArea) <= tolerance) {
      enclosing = second;
      enclosed = first;
    } else throw new Error("Canonical route topology produced ambiguous overlapping planar faces.");
    if (!bridgeAttached(extracted.faces[enclosed]!)) {
      throw new Error("Canonical route topology produced unsupported nested planar faces.");
    }
    rejected.add(enclosing);
  }
  const lineageGroups = new Map<string, FaceCandidate[]>();
  for (let index = 0; index < extracted.faces.length; index++) {
    if (rejected.has(index)) continue;
    const face = extracted.faces[index]!;
    const key = `${face.boundaryRoadIds.join(",")}|${face.boundaryRoles.join(",")}`;
    lineageGroups.set(key, [...(lineageGroups.get(key) ?? []), face]);
  }
  const blocks: DerivedBlock[] = [];
  for (const [lineage, faces] of [...lineageGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    faces.sort((a, b) => a.geometrySignature.localeCompare(b.geometrySignature));
    for (let index = 0; index < faces.length; index++) {
      const face = faces[index]!;
      const buildable = intersection(ringAsMulti(face.ring), wallCells);
      if (buildable.length === 0) continue;
      blocks.push({
        id: stableId("block", `${lineage}|${index}|${face.geometrySignature}`),
        zoningFace: face.ring,
        buildable,
        boundaryRoadIds: face.boundaryRoadIds,
        districtFragments: []
      });
    }
  }
  blocks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    blocks,
    discarded: extracted.discarded + rejected.size,
    warnings: rejected.size === 0
      ? []
      : [`Discarded ${rejected.size} enclosing planar face${rejected.size === 1 ? "" : "s"} because bridge-attached route cycles would require unsupported holes; the affected region is excluded from district planning.`]
  };
}

function fragmentFor(block: DerivedBlock, districtId: string | null, buildable: MultiPolygon): DistrictBlockFragment {
  return {
    id: stableId("fragment", `${block.id}|${districtId ?? "unzoned"}|${multiSignature(buildable)}`),
    blockId: block.id,
    districtId,
    buildable
  };
}

function addFragments(blocks: DerivedBlock[], districts: readonly DistrictSource[]): MultiPolygon {
  const ordered = [...districts].sort((a, b) => a.id.localeCompare(b.id));
  const masks = ordered.map((district) => ringAsMulti(district.polygon));
  const assigned = union(masks);
  const allUnzoned: MultiPolygon = [];
  for (const block of blocks) {
    const fragments: DistrictBlockFragment[] = [];
    for (const district of ordered) {
      const clipped = intersection(block.buildable, ringAsMulti(district.polygon));
      for (const polygon of clipped) fragments.push(fragmentFor(block, district.id, [polygon]));
    }
    const unzoned = difference(block.buildable, assigned.length > 0 ? [assigned] : []);
    for (const polygon of unzoned) {
      fragments.push(fragmentFor(block, null, [polygon]));
      allUnzoned.push(polygon);
    }
    block.districtFragments = fragments.sort((a, b) => a.id.localeCompare(b.id));
  }
  return allUnzoned;
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

function weightedGrammar(definition: DistrictTypeDefinition, seed: string): BlockGrammarId {
  const total = BLOCK_GRAMMAR_IDS.reduce((sum, id) => sum + definition.grammarWeights[id], 0);
  let cursor = hashUnit(seed) * total;
  for (const id of BLOCK_GRAMMAR_IDS) {
    cursor -= definition.grammarWeights[id];
    if (cursor < 0) return id;
  }
  return BLOCK_GRAMMAR_IDS[0];
}

function range(seed: string, min: number, max: number): number {
  return min + (max - min) * hashUnit(seed);
}

function rotate(point: Vec2, origin: Vec2, angle: number): Vec2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  return { x: origin.x + x * cosine - y * sine, y: origin.y + x * sine + y * cosine };
}

function radialCells(fragment: DistrictBlockFragment, ring: Ring, grammarId: BlockGrammarId, rotation: number, seed: string, frontageRoadId: string | null): DevelopmentCellPlan[] {
  const centre = ringCentroid(ring);
  const count = Math.max(5, Math.min(14, ring.length + Math.floor(hashUnit(`${seed}/count`) * 5)));
  const radius = Math.max(ringBounds(ring).width, ringBounds(ring).height) * 2 + 1;
  const planningArea = ringAsMulti(ring);
  const cells: DevelopmentCellPlan[] = [];
  let occupied: MultiPolygon = [];
  for (let index = 0; index < count; index++) {
    const a = rotation + (index / count) * Math.PI * 2;
    const b = rotation + ((index + 1) / count) * Math.PI * 2;
    const wedge = [centre, { x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius }, { x: centre.x + Math.cos(b) * radius, y: centre.y + Math.sin(b) * radius }];
    const available = difference(intersection(planningArea, ringAsMulti(wedge)), occupied.length > 0 ? [occupied] : []);
    for (const polygon of available) {
      for (const cellRing of canonicalHoleFreePieces(polygon)) {
        if (Math.abs(ringArea(cellRing)) < MIN_CELL_AREA_M2) continue;
        cells.push({ id: stableId("cell", `${fragment.id}|${grammarId}|fan-${index}|${seed}|${ringSignature(cellRing)}`), blockId: fragment.blockId, fragmentId: fragment.id, districtId: fragment.districtId, grammarId, polygon: cellRing, localRole: `fan-${index}`, rotationRad: rotation, frontageRoadId });
        occupied = union([occupied, ringAsMulti(cellRing)]);
      }
    }
  }
  const remainder = difference(planningArea, occupied.length > 0 ? [occupied] : []);
  for (let index = 0; index < remainder.length; index++) {
    const polygon = remainder[index]!;
    for (const cellRing of canonicalHoleFreePieces(polygon)) {
      if (Math.abs(ringArea(cellRing)) <= GEOMETRY_EPSILON) continue;
      cells.push({ id: stableId("cell", `${fragment.id}|${grammarId}|planning-band-remainder-${index}|${seed}|${ringSignature(cellRing)}`), blockId: fragment.blockId, fragmentId: fragment.id, districtId: fragment.districtId, grammarId, polygon: cellRing, localRole: `planning-band-remainder-${index}`, rotationRad: rotation, frontageRoadId });
    }
  }
  return cells.sort((a, b) => a.id.localeCompare(b.id));
}

function gridCells(
  fragment: DistrictBlockFragment,
  ring: Ring,
  grammarId: BlockGrammarId,
  rotation: number,
  bounds: DistrictPlanningBounds,
  seed: string,
  frontageRoadId: string | null
): DevelopmentCellPlan[] {
  const shape = GRAMMAR_SHAPES[grammarId];
  const centre = ringCentroid(ring);
  const localRing = ring.map((point) => rotate(point, centre, -rotation));
  const localBounds = ringBounds(localRing);
  const planningArea = ringAsMulti(ring);
  let width = range(`${seed}/width`, bounds.minCellWidthM, bounds.maxCellWidthM) * shape.widthFactor;
  let depth = range(`${seed}/depth`, bounds.minCellDepthM, bounds.maxCellDepthM) * shape.depthFactor;
  const aspect = width / depth;
  if (aspect < bounds.minAspect) width = depth * bounds.minAspect;
  else if (aspect > bounds.maxAspect) depth = width / bounds.maxAspect;
  const estimated = Math.ceil(localBounds.width / width) * Math.ceil(localBounds.height / depth);
  if (estimated > MAX_CELLS_PER_FRAGMENT) {
    const scale = Math.sqrt(estimated / MAX_CELLS_PER_FRAGMENT);
    width *= scale;
    depth *= scale;
  }
  const cells: DevelopmentCellPlan[] = [];
  let occupied: MultiPolygon = [];
  const addCandidate = (candidate: Ring, localRole: string, minimumArea = MIN_CELL_AREA_M2): void => {
    const available = difference(intersection(planningArea, ringAsMulti(candidate)), occupied.length > 0 ? [occupied] : []);
    for (const polygon of available) {
      for (const cellRing of canonicalHoleFreePieces(polygon)) {
        if (Math.abs(ringArea(cellRing)) < minimumArea) continue;
        cells.push({ id: stableId("cell", `${fragment.id}|${grammarId}|${localRole}|${seed}|${ringSignature(cellRing)}`), blockId: fragment.blockId, fragmentId: fragment.id, districtId: fragment.districtId, grammarId, polygon: cellRing, localRole, rotationRad: rotation, frontageRoadId });
        occupied = union([occupied, ringAsMulti(cellRing)]);
      }
    }
  };
  const localRect = (x: number, y: number, widthM: number, heightM: number): Ring =>
    rectRing({ x, y, width: Math.max(CELL_GAP_M, widthM), height: Math.max(CELL_GAP_M, heightM) }).map((point) => rotate(point, centre, rotation));
  const reserveBand = (x: number, y: number, widthM: number, heightM: number, role: string): void =>
    addCandidate(localRect(x, y, widthM, heightM), `planning-band-${role}`, GEOMETRY_EPSILON);

  if (grammarId === "perimeter-courtyard") {
    reserveBand(localBounds.x + localBounds.width * 0.31, localBounds.y + localBounds.height * 0.31, localBounds.width * 0.38, localBounds.height * 0.38, "courtyard");
  } else if (grammarId === "superblock-compound") {
    reserveBand(localBounds.x + localBounds.width * 0.47, localBounds.y, localBounds.width * 0.06, localBounds.height, "compound-spine");
    reserveBand(localBounds.x, localBounds.y + localBounds.height * 0.47, localBounds.width, localBounds.height * 0.06, "compound-crossing");
  } else if (grammarId === "tower-podium-field") {
    addCandidate(localRect(localBounds.x + localBounds.width * 0.27, localBounds.y + localBounds.height * 0.27, localBounds.width * 0.46, localBounds.height * 0.46), "podium-anchor");
  } else if (grammarId === "industrial-yard") {
    reserveBand(localBounds.x, localBounds.y, localBounds.width, localBounds.height * 0.12, "service-yard");
  } else if (grammarId === "logistics-sheds") {
    reserveBand(localBounds.x, localBounds.y, localBounds.width * 0.08, localBounds.height, "loading-spine");
  } else if (grammarId === "campus-pavilions") {
    reserveBand(localBounds.x + localBounds.width * 0.43, localBounds.y, localBounds.width * 0.08, localBounds.height, "campus-walk");
    reserveBand(localBounds.x, localBounds.y + localBounds.height * 0.43, localBounds.width, localBounds.height * 0.08, "campus-green");
  } else if (grammarId === "market-alley") {
    reserveBand(localBounds.x, localBounds.y + localBounds.height * 0.45, localBounds.width, localBounds.height * 0.1, "market-alley");
    reserveBand(localBounds.x + localBounds.width * 0.63, localBounds.y, localBounds.width * 0.07, localBounds.height, "market-cross-alley");
  } else if (grammarId === "waterfront-terraces") {
    reserveBand(localBounds.x, localBounds.y, localBounds.width, localBounds.height * 0.16, "promenade");
  }
  const columns = Math.max(1, Math.ceil(localBounds.width / width));
  const rows = Math.max(1, Math.ceil(localBounds.height / depth));
  for (let row = 0; row < rows; row++) {
    const rowOffset = row % 2 === 1 ? width * shape.stagger : 0;
    for (let column = -1; column <= columns; column++) {
      const role = `${row}-${column}`;
      const random = hashUnit(`${seed}/cell/${role}`);
      const variation = grammarId === "irregular-mosaic" ? 0.72 + random * 0.28 : 1;
      const localCell = rectRing({
        x: localBounds.x + column * width + rowOffset + CELL_GAP_M / 2,
        y: localBounds.y + row * depth + CELL_GAP_M / 2,
        width: Math.max(CELL_GAP_M, width * variation - CELL_GAP_M),
        height: Math.max(CELL_GAP_M, depth * (grammarId === "waterfront-terraces" ? 0.72 + (row % 3) * 0.12 : 1) - CELL_GAP_M)
      }).map((point) => rotate(point, centre, rotation));
      const sparse = random < shape.sparse;
      const localRole = sparse ? `planning-band-${role}` : `${grammarId}-${role}`;
      addCandidate(localCell, localRole);
    }
  }
  const remainder = difference(planningArea, occupied.length > 0 ? [occupied] : []);
  for (let index = 0; index < remainder.length; index++) {
    const polygon = remainder[index]!;
    for (const cellRing of canonicalHoleFreePieces(polygon)) {
      if (Math.abs(ringArea(cellRing)) <= GEOMETRY_EPSILON) continue;
      cells.push({ id: stableId("cell", `${fragment.id}|${grammarId}|planning-band-remainder-${index}|${seed}|${ringSignature(cellRing)}`), blockId: fragment.blockId, fragmentId: fragment.id, districtId: fragment.districtId, grammarId, polygon: cellRing, localRole: `planning-band-remainder-${index}`, rotationRad: rotation, frontageRoadId });
    }
  }
  return cells.sort((a, b) => a.id.localeCompare(b.id));
}

export function planDistrictFragmentWithGrammar(
  fragment: DistrictBlockFragment,
  grammarId: BlockGrammarId,
  bounds: DistrictPlanningBounds,
  seed: string,
  boundaryRoadIds: readonly string[] = []
): DevelopmentCellPlan[] {
  const cells: DevelopmentCellPlan[] = [];
  for (const polygon of fragment.buildable) {
    const decomposed = polygon.length !== 1 || !validateRing(polygon[0]!).ok;
    for (const [pieceIndex, ring] of holeFreePieces(polygon).entries()) {
      if (ring.length < 3) throw new Error(`Fragment "${fragment.id}" contains unsupported planning geometry.`);
      const pieceSeed = `${seed}/piece/${pieceIndex}`;
      const pieceFragment = { ...fragment, buildable: ringAsMulti(ring) };
      const baseAngle = longestEdgeAngle(ring);
      const rotation = baseAngle + GRAMMAR_SHAPES[grammarId].angleOffset;
      const frontageRoadId = boundaryRoadIds.length > 0 ? boundaryRoadIds[fnv1a(pieceSeed) % boundaryRoadIds.length]! : null;
      if (decomposed) {
        const cellRing = canonicalRing(ring);
        if (!validateRing(cellRing).ok) throw new Error(`Fragment "${fragment.id}" could not be decomposed into valid planning bands.`);
        cells.push({ id: stableId("cell", `${fragment.id}|${grammarId}|planning-band-hole-${pieceIndex}|${pieceSeed}|${ringSignature(cellRing)}`), blockId: fragment.blockId, fragmentId: fragment.id, districtId: fragment.districtId, grammarId, polygon: cellRing, localRole: `planning-band-hole-decomposition-${pieceIndex}`, rotationRad: rotation, frontageRoadId });
        continue;
      }
      cells.push(...(grammarId === "radial-fan"
        ? radialCells(pieceFragment, ring, grammarId, rotation, pieceSeed, frontageRoadId)
        : gridCells(pieceFragment, ring, grammarId, rotation, bounds, pieceSeed, frontageRoadId)));
    }
  }
  return cells.sort((a, b) => a.id.localeCompare(b.id));
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

function openSpaceIntent(source: CitySourceV3, block: DerivedBlock, fragment: DistrictBlockFragment, district: DistrictSource | undefined, definition: DistrictTypeDefinition | undefined): BlockOpenSpaceIntent {
  const seed = `${district?.seed ?? source.citySeed}/districts/v3/open-space/${fragment.id}`;
  if (!district || !definition) return { blockId: block.id, fragmentId: fragment.id, districtId: null, category: null, size: null, targetShare: 0, seed };
  const override = district.openSpaceOverride;
  const targetShare = Math.max(0, Math.min(1, override ? override.rate : PROFILE_RATES[source.generation.openSpaceProfile] * definition.openSpaceMultiplier));
  if (targetShare <= 0) return { blockId: block.id, fragmentId: fragment.id, districtId: district.id, category: null, size: null, targetShare: 0, seed };

  // Gate: for very-low profiles, only ~(targetShare * 8) fraction of fragments
  // actually generate an open space intent, preventing every block from
  // contributing open space when the profile calls for minimal coverage.
  if (targetShare < 0.10 && hashUnit(`${seed}/gate`) > targetShare * 8) {
    return { blockId: block.id, fragmentId: fragment.id, districtId: district.id, category: null, size: null, targetShare: 0, seed };
  }

  const categoryValues: readonly OpenSpaceCategory[] = ["park", "plaza", "parking", "vacant", "utility", "landscaping", "service-yard"];
  const sizeValues: readonly OpenSpaceSize[] = ["pocket", "small", "large", "whole-block"];
  const allowedCategories = new Set(OPEN_SPACE_PROFILE_CATEGORY_GATES[source.generation.openSpaceProfile]);
  const inheritedCategories = Object.fromEntries(categoryValues.map((category) => [category, allowedCategories.has(category) ? definition.categoryWeights[category] : 0])) as Record<OpenSpaceCategory, number>;
  const categoryWeights = override?.categoryWeights ?? inheritedCategories;
  const sizeWeights = { ...(override?.sizeWeights ?? definition.sizeWeights) };

  // Suppress large-area sizes when targetShare is very low to prevent
  // single open spaces from consuming entire block fragments.
  if (targetShare < 0.05) {
    sizeWeights["whole-block"] = 0;
    sizeWeights["large"] = Math.min(sizeWeights["large"] ?? 0, 0.5);
  }

  return {
    blockId: block.id,
    fragmentId: fragment.id,
    districtId: district.id,
    category: weightedChoice(categoryWeights, categoryValues, `${seed}/category`),
    size: weightedChoice(sizeWeights, sizeValues, `${seed}/size`),
    targetShare,
    seed
  };
}

function planFragments(source: CitySourceV3, blocks: DerivedBlock[]): { cells: DevelopmentCellPlan[]; intents: BlockOpenSpaceIntent[] } {
  const districtById = new Map(source.districts.map((district) => [district.id, district]));
  const cells: DevelopmentCellPlan[] = [];
  const intents: BlockOpenSpaceIntent[] = [];
  for (const block of blocks) {
    for (const fragment of block.districtFragments) {
      const district = fragment.districtId ? districtById.get(fragment.districtId) : undefined;
      const definition = district ? DISTRICT_TYPE_REGISTRY.get(district.typeId) : undefined;
      const intent = openSpaceIntent(source, block, fragment, district, definition);
      intents.push(intent);
      const grammarSeed = `${district?.seed ?? source.citySeed}/districts/v3/grammar/${fragment.id}`;
      const grammarId = definition ? weightedGrammar(definition, grammarSeed) : "irregular-mosaic";
      const planningBounds = definition?.bounds ?? { minCellWidthM: 12, maxCellWidthM: 28, minCellDepthM: 14, maxCellDepthM: 34, minAspect: 0.4, maxAspect: 3 };
      const planned = planDistrictFragmentWithGrammar(fragment, grammarId, planningBounds, grammarSeed, block.boundaryRoadIds);
      cells.push(...(intent.size === "whole-block" && intent.targetShare > 0
        ? planned.map((cell) => ({ ...cell, id: stableId("cell", `${cell.id}|whole-block-open-space`), localRole: "planning-band-whole-block-open-space" }))
        : planned));
    }
  }
  return { cells: cells.sort((a, b) => a.id.localeCompare(b.id)), intents: intents.sort((a, b) => a.fragmentId.localeCompare(b.fragmentId)) };
}

export function buildDistrictPlan(source: CitySourceV3): DistrictPlan {
  const network = compileRouteNetwork(source.roads, ROUTE_CLASS_REGISTRY);
  const mask = ringAsMulti(normalizeRing(source.terrain.urbanFootprint ?? source.terrain.land));
  const land = ringAsMulti(normalizeRing(source.terrain.land));
  const developmentMask = intersection(mask, land);
  const occupancy = compiledRouteOccupancy(network);
  const wallCells = difference(developmentMask, [occupancy.all]);
  const base = blockCandidates(source, network, wallCells);
  const unzoned = addFragments(base.blocks, source.districts);
  const planned = planFragments(source, base.blocks);
  const fragments = base.blocks.reduce((sum, block) => sum + block.districtFragments.length, 0);
  return {
    revisionInputs: districtStructuralInputSignature(source),
    blocks: base.blocks,
    developmentCells: planned.cells,
    openSpaceIntents: planned.intents,
    unzoned,
    wallCells,
    diagnostics: {
      faceCount: base.blocks.length,
      blockCount: base.blocks.length,
      fragmentCount: fragments,
      developmentCellCount: planned.cells.length,
      discardedFaceCount: base.discarded,
      discardedCellCount: 0,
      warnings: base.warnings
    }
  };
}

export interface DistrictBreadthGalleryEntry {
  districtTypeId: DistrictTypeDefinition["id"];
  grammarId: BlockGrammarId;
  fixtureSeed: string;
  overviewScale: number;
  playScale: number;
}

export function districtBreadthGallery(): DistrictBreadthGalleryEntry[] {
  const entries: DistrictBreadthGalleryEntry[] = [];
  for (const definition of DISTRICT_TYPE_REGISTRY.values()) {
    for (const grammarId of BLOCK_GRAMMAR_IDS) {
      if (definition.grammarWeights[grammarId] <= 0) continue;
      entries.push({ districtTypeId: definition.id, grammarId, fixtureSeed: `gallery/v3/${definition.id}/${grammarId}`, overviewScale: 0.35, playScale: 1 });
    }
  }
  return entries;
}
