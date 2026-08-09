import { compileRouteNetwork } from "../graph/compiler.js";
import { difference, intersection, ringAsMulti, union } from "../geom/boolean.js";
import { ringArea, ringBounds, type MultiPolygon, type Ring, type Vec2 } from "../geom/types.js";
import {
  ROUTE_CLASS_REGISTRY,
  normalizeDistrictOpenSpaceOverride as normalizeModelDistrictOpenSpaceOverride,
  type CitySourceV3,
  type DistrictOpenSpaceOverride,
  type DistrictSource
} from "./city.js";
import { compiledRouteOccupancy } from "./district-plan.js";
import { DISTRICT_PALETTE_IDS, DISTRICT_TYPE_REGISTRY } from "./district-registry.js";
import { normalizeRing, validateRing } from "./terrain.js";

export const MIN_DISTRICT_AREA_M2 = 1;
const TOUCH_EPSILON_M = 0.01;

export class DistrictEditError extends Error {
  readonly affectedIds: string[];

  constructor(message: string, affectedIds: readonly string[] = []) {
    super(message);
    this.name = "DistrictEditError";
    this.affectedIds = [...affectedIds].sort();
  }
}

export type DistrictUpdatePatch = Partial<Pick<DistrictSource, "typeId" | "paletteId" | "seed" | "locked" | "openSpaceOverride">>;

function area(multi: MultiPolygon): number {
  return multi.reduce((sum, polygon) => sum + polygon.reduce((polygonArea, ring, index) => polygonArea + Math.abs(ringArea(ring)) * (index === 0 ? 1 : -1), 0), 0);
}

function developmentMask(source: CitySourceV3): MultiPolygon {
  return intersection(ringAsMulti(source.terrain.urbanFootprint ?? source.terrain.land), ringAsMulti(source.terrain.land));
}

function cloneDistrict(district: DistrictSource): DistrictSource {
  return {
    ...district,
    polygon: district.polygon.map((point) => ({ ...point })),
    openSpaceOverride: district.openSpaceOverride === null ? null : {
      rate: district.openSpaceOverride.rate,
      categoryWeights: { ...district.openSpaceOverride.categoryWeights },
      sizeWeights: { ...district.openSpaceOverride.sizeWeights }
    }
  };
}

function singleRing(result: MultiPolygon, action: string, affectedIds: readonly string[]): Ring {
  if (result.length !== 1 || result[0]!.length !== 1 || Math.abs(ringArea(result[0]![0]!)) < MIN_DISTRICT_AREA_M2) {
    throw new DistrictEditError(`${action} must leave one connected, hole-free district above the supported area floor.`, affectedIds);
  }
  return normalizeRing(result[0]![0]!);
}

export function normalizeDistrictOpenSpaceOverride(value: DistrictOpenSpaceOverride): DistrictOpenSpaceOverride {
  try {
    return normalizeModelDistrictOpenSpaceOverride(value);
  } catch (error) {
    throw new DistrictEditError(error instanceof Error ? error.message : String(error));
  }
}

export function validateDistrictCandidates(source: CitySourceV3, districts: readonly DistrictSource[]): void {
  void source;
  const ids = new Set<string>();
  const ordered = [...districts].sort((a, b) => a.id.localeCompare(b.id));
  for (const district of ordered) {
    if (district.id.trim().length === 0 || ids.has(district.id)) throw new DistrictEditError(`Duplicate or empty district id "${district.id}".`, [district.id]);
    ids.add(district.id);
    const validation = validateRing(district.polygon);
    if (!validation.ok) throw new DistrictEditError(validation.reason, [district.id]);
    if (Math.abs(ringArea(district.polygon)) < MIN_DISTRICT_AREA_M2) throw new DistrictEditError(`District "${district.id}" is below the supported area floor.`, [district.id]);
    if (!DISTRICT_TYPE_REGISTRY.has(district.typeId)) throw new DistrictEditError(`District "${district.id}" references an unknown district type.`, [district.id]);
    if (!DISTRICT_PALETTE_IDS.includes(district.paletteId)) throw new DistrictEditError(`District "${district.id}" references an unknown district palette.`, [district.id]);
    if (district.openSpaceOverride) normalizeDistrictOpenSpaceOverride(district.openSpaceOverride);
  }
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      if (area(intersection(ringAsMulti(ordered[i]!.polygon), ringAsMulti(ordered[j]!.polygon))) > 1e-5) {
        throw new DistrictEditError("Districts must not overlap.", [ordered[i]!.id, ordered[j]!.id]);
      }
    }
  }
}

function sourceWithDistricts(source: CitySourceV3, districts: DistrictSource[]): CitySourceV3 {
  return { ...source, districts };
}

function districtDrawCandidateInternal(source: CitySourceV3, incoming: DistrictSource, replacingId: string | null, deleteEmptiedPredecessors: boolean): DistrictSource[] {
  const incomingValidation = validateRing(incoming.polygon);
  if (!incomingValidation.ok) throw new DistrictEditError(incomingValidation.reason, [incoming.id]);
  if (area(intersection(ringAsMulti(incoming.polygon), developmentMask(source))) < MIN_DISTRICT_AREA_M2) throw new DistrictEditError(`District "${incoming.id}" has no supported effective land in the current development mask.`, [incoming.id]);
  const output: DistrictSource[] = [];
  for (const current of [...source.districts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (current.id === replacingId) continue;
    const overlap = intersection(ringAsMulti(current.polygon), ringAsMulti(incoming.polygon));
    if (area(overlap) <= 1e-5) {
      output.push(cloneDistrict(current));
      continue;
    }
    if (current.locked) throw new DistrictEditError(`Locked district "${current.id}" blocks overlap subtraction.`, [current.id, incoming.id]);
    const remainder = difference(ringAsMulti(current.polygon), [ringAsMulti(incoming.polygon)]);
    if (remainder.length === 0 && deleteEmptiedPredecessors) continue;
    const polygon = singleRing(remainder, "Overlap subtraction", [current.id, incoming.id]);
    output.push({ ...cloneDistrict(current), polygon });
  }
  output.push({ ...cloneDistrict(incoming), polygon: normalizeRing(incoming.polygon), openSpaceOverride: incoming.openSpaceOverride ? normalizeDistrictOpenSpaceOverride(incoming.openSpaceOverride) : null });
  output.sort((a, b) => a.id.localeCompare(b.id));
  validateDistrictCandidates(sourceWithDistricts(source, output), output);
  return output;
}

export function districtDrawCandidate(source: CitySourceV3, incoming: DistrictSource, replacingId: string | null = null): DistrictSource[] {
  return districtDrawCandidateInternal(source, incoming, replacingId, false);
}

export interface DistrictFillOptions {
  targetDistrictId: string | null;
  newDistrict?: DistrictSource;
}

export function districtFillCandidate(source: CitySourceV3, zoningFace: Ring, options: DistrictFillOptions): DistrictSource[] {
  if (options.targetDistrictId === null) {
    if (!options.newDistrict) throw new DistrictEditError("Fill without a target requires a complete new district source.");
    return districtDrawCandidateInternal(source, { ...options.newDistrict, polygon: zoningFace }, null, true);
  }
  const target = source.districts.find((district) => district.id === options.targetDistrictId);
  if (!target) throw new DistrictEditError(`Unknown target district "${options.targetDistrictId}".`, [options.targetDistrictId]);
  if (target.locked) throw new DistrictEditError(`Locked district "${target.id}" cannot be filled.`, [target.id]);
  const polygon = singleRing(union([ringAsMulti(target.polygon), ringAsMulti(zoningFace)]), "Fill", [target.id]);
  return districtDrawCandidateInternal(source, { ...cloneDistrict(target), polygon }, target.id, true);
}

export function districtMoveVertexCandidate(source: CitySourceV3, districtId: string, vertexIndex: number, point: Vec2): DistrictSource[] {
  const district = source.districts.find((candidate) => candidate.id === districtId);
  if (!district) throw new DistrictEditError(`Unknown district "${districtId}".`, [districtId]);
  if (district.locked) throw new DistrictEditError(`Locked district "${districtId}" cannot be edited.`, [districtId]);
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= district.polygon.length) throw new DistrictEditError("District vertex index is out of range.", [districtId]);
  const polygon = district.polygon.map((current, index) => index === vertexIndex ? { ...point } : { ...current });
  return districtDrawCandidate(source, { ...cloneDistrict(district), polygon }, district.id);
}

function halfPlanes(ring: Ring, a: Vec2, b: Vec2): [Ring, Ring] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-6) throw new DistrictEditError("Split points must be distinct.");
  const direction = { x: dx / length, y: dy / length };
  const normal = { x: -direction.y, y: direction.x };
  const bounds = ringBounds(ring);
  const extent = Math.hypot(bounds.width, bounds.height) * 4 + length * 2 + 10;
  const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const p1 = { x: centre.x - direction.x * extent, y: centre.y - direction.y * extent };
  const p2 = { x: centre.x + direction.x * extent, y: centre.y + direction.y * extent };
  const left = [p1, p2, { x: p2.x + normal.x * extent * 2, y: p2.y + normal.y * extent * 2 }, { x: p1.x + normal.x * extent * 2, y: p1.y + normal.y * extent * 2 }];
  const right = [p2, p1, { x: p1.x - normal.x * extent * 2, y: p1.y - normal.y * extent * 2 }, { x: p2.x - normal.x * extent * 2, y: p2.y - normal.y * extent * 2 }];
  return [left, right];
}

function splitBoundaryIntersections(ring: Ring, a: Vec2, b: Vec2): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) <= 1e-6) throw new DistrictEditError("Split points must be distinct.");
  const hits = new Map<string, Vec2>();
  for (let index = 0; index < ring.length; index++) {
    const c = ring[index]!;
    const d = ring[(index + 1) % ring.length]!;
    const sx = d.x - c.x;
    const sy = d.y - c.y;
    const denominator = dx * sy - dy * sx;
    const collinear = Math.abs((c.x - a.x) * dy - (c.y - a.y) * dx) <= 1e-7;
    if (Math.abs(denominator) <= 1e-9) {
      if (collinear) throw new DistrictEditError("Split line must not coincide with a district boundary.");
      continue;
    }
    const qx = c.x - a.x;
    const qy = c.y - a.y;
    const lineT = (qx * sy - qy * sx) / denominator;
    const edgeT = (qx * dy - qy * dx) / denominator;
    if (edgeT < -1e-7 || edgeT > 1 + 1e-7) continue;
    const point = { x: a.x + dx * lineT, y: a.y + dy * lineT };
    hits.set(`${Math.round(point.x * 1_000_000)},${Math.round(point.y * 1_000_000)}`, point);
  }
  return [...hits.values()];
}

function pointInRing(point: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const first = ring[i]!;
    const second = ring[(i + 1) % ring.length]!;
    if ((first.y > point.y) !== (second.y > point.y) && point.x < ((second.x - first.x) * (point.y - first.y)) / (second.y - first.y) + first.x) inside = !inside;
  }
  return inside;
}

export function districtSplitCandidate(source: CitySourceV3, districtId: string, a: Vec2, b: Vec2, newDistrictId: string): DistrictSource[] {
  const district = source.districts.find((candidate) => candidate.id === districtId);
  if (!district) throw new DistrictEditError(`Unknown district "${districtId}".`, [districtId]);
  if (district.locked) throw new DistrictEditError(`Locked district "${districtId}" cannot be split.`, [districtId]);
  if (source.districts.some((candidate) => candidate.id === newDistrictId)) throw new DistrictEditError(`District id "${newDistrictId}" already exists.`, [newDistrictId]);
  const intersections = splitBoundaryIntersections(district.polygon, a, b);
  if (intersections.length !== 2) throw new DistrictEditError(`Split line must cross the district boundary exactly twice; found ${intersections.length}.`, [districtId]);
  const [left, right] = halfPlanes(district.polygon, a, b);
  const first = singleRing(intersection(ringAsMulti(district.polygon), ringAsMulti(left)), "Split", [districtId]);
  const second = singleRing(intersection(ringAsMulti(district.polygon), ringAsMulti(right)), "Split", [districtId]);
  const anchor = normalizeRing(district.polygon)[0]!;
  const survivor = pointInRing(anchor, first) ? first : second;
  const created = survivor === first ? second : first;
  const output = source.districts.filter((candidate) => candidate.id !== districtId).map(cloneDistrict);
  output.push({ ...cloneDistrict(district), polygon: survivor }, { ...cloneDistrict(district), id: newDistrictId, polygon: created });
  output.sort((x, y) => x.id.localeCompare(y.id));
  validateDistrictCandidates(sourceWithDistricts(source, output), output);
  return output;
}

export function districtMergeCandidate(source: CitySourceV3, districtIds: readonly string[], survivorId: string): DistrictSource[] {
  const ids = [...new Set(districtIds)].sort();
  if (ids.length < 2 || !ids.includes(survivorId)) throw new DistrictEditError("Merge requires at least two districts and an included survivor.", ids);
  const selected = ids.map((id) => source.districts.find((district) => district.id === id));
  const missing = ids.filter((_, index) => !selected[index]);
  if (missing.length > 0) throw new DistrictEditError("Merge selection contains unknown districts.", missing);
  const locked = selected.filter((district) => district!.locked).map((district) => district!.id);
  if (locked.length > 0) throw new DistrictEditError("Locked districts cannot be merged.", locked);
  const polygon = singleRing(union(selected.map((district) => ringAsMulti(district!.polygon))), "Merge", ids);
  const survivor = selected.find((district) => district!.id === survivorId)!;
  const output = source.districts.filter((district) => !ids.includes(district.id)).map(cloneDistrict);
  output.push({ ...cloneDistrict(survivor!), polygon });
  output.sort((a, b) => a.id.localeCompare(b.id));
  validateDistrictCandidates(sourceWithDistricts(source, output), output);
  return output;
}

export function districtUpdateCandidate(source: CitySourceV3, districtIds: readonly string[], patch: DistrictUpdatePatch): DistrictSource[] {
  const ids = [...new Set(districtIds)].sort();
  if (ids.length === 0) throw new DistrictEditError("District update selection is empty.");
  const missing = ids.filter((id) => !source.districts.some((district) => district.id === id));
  if (missing.length > 0) throw new DistrictEditError("District update selection contains unknown districts.", missing);
  const explicitUnlockOnly = Object.keys(patch).every((key) => key === "locked") && patch.locked === false;
  const locked = source.districts.filter((district) => ids.includes(district.id) && district.locked).map((district) => district.id);
  if (locked.length > 0 && !explicitUnlockOnly) throw new DistrictEditError("Locked districts must be explicitly unlocked before editing.", locked);
  const normalizedOverride = patch.openSpaceOverride === undefined || patch.openSpaceOverride === null ? patch.openSpaceOverride : normalizeDistrictOpenSpaceOverride(patch.openSpaceOverride);
  const output = source.districts.map((district) => {
    if (!ids.includes(district.id)) return cloneDistrict(district);
    return cloneDistrict({ ...district, ...patch, ...(patch.openSpaceOverride !== undefined ? { openSpaceOverride: normalizedOverride! } : {}) });
  }).sort((a, b) => a.id.localeCompare(b.id));
  validateDistrictCandidates(sourceWithDistricts(source, output), output);
  return output;
}

export function districtDeleteCandidate(source: CitySourceV3, districtIds: readonly string[]): DistrictSource[] {
  const ids = [...new Set(districtIds)].sort();
  if (ids.length === 0) throw new DistrictEditError("District delete selection is empty.");
  const missing = ids.filter((id) => !source.districts.some((district) => district.id === id));
  if (missing.length > 0) throw new DistrictEditError("District delete selection contains unknown districts.", missing);
  const locked = source.districts.filter((district) => ids.includes(district.id) && district.locked).map((district) => district.id);
  if (locked.length > 0) throw new DistrictEditError("Locked districts cannot be deleted.", locked);
  return source.districts.filter((district) => !ids.includes(district.id)).map(cloneDistrict).sort((a, b) => a.id.localeCompare(b.id));
}

function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function regionsTouch(a: Ring, multi: MultiPolygon): boolean {
  for (const polygon of multi) for (const ring of polygon) {
    for (const point of a) for (let i = 0; i < ring.length; i++) if (distanceToSegment(point, ring[i]!, ring[(i + 1) % ring.length]!) <= TOUCH_EPSILON_M) return true;
    for (const point of ring) for (let i = 0; i < a.length; i++) if (distanceToSegment(point, a[i]!, a[(i + 1) % a.length]!) <= TOUCH_EPSILON_M) return true;
  }
  return false;
}

function changedRoadIds(before: CitySourceV3["roads"], after: CitySourceV3["roads"]): string[] {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, `${node.x},${node.y}`]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, `${node.x},${node.y}`]));
  const beforeRoutes = new Map(before.routes.map((route) => [route.id, route.curvePreset]));
  const afterRoutes = new Map(after.routes.map((route) => [route.id, route.curvePreset]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  return [...new Set([...beforeEdges.keys(), ...afterEdges.keys()])].filter((id) => {
    const left = beforeEdges.get(id);
    const right = afterEdges.get(id);
    if (!left || !right) return true;
    return left.a !== right.a || left.b !== right.b || left.routeId !== right.routeId || left.classId !== right.classId ||
      beforeNodes.get(left.a) !== afterNodes.get(right.a) || beforeNodes.get(left.b) !== afterNodes.get(right.b) ||
      beforeRoutes.get(left.routeId) !== afterRoutes.get(right.routeId);
  }).sort();
}

export function reconcileDistrictsForRoadEdit(before: CitySourceV3, after: CitySourceV3): DistrictSource[] {
  const oldOccupancy = compiledRouteOccupancy(compileRouteNetwork(before.roads, ROUTE_CLASS_REGISTRY));
  const newOccupancy = compiledRouteOccupancy(compileRouteNetwork(after.roads, ROUTE_CLASS_REGISTRY));
  const mask = developmentMask(before);
  const roadIds = changedRoadIds(before.roads, after.roads);
  const reclaimed = intersection(difference(oldOccupancy.all, [newOccupancy.all]), mask);
  const newlyOccupied = intersection(difference(newOccupancy.all, [oldOccupancy.all]), mask);
  const lockedOccupied = before.districts.filter((district) => district.locked && area(intersection(ringAsMulti(district.polygon), newlyOccupied)) > 1e-5).map((district) => district.id);
  if (lockedOccupied.length > 0) throw new DistrictEditError("Road geometry would change effective land inside locked districts.", [...lockedOccupied, ...roadIds]);
  let districts = before.districts.map(cloneDistrict).sort((a, b) => a.id.localeCompare(b.id));
  for (const region of reclaimed) {
    if (region.length !== 1) throw new DistrictEditError("Reclaimed road geometry contains an unsupported hole.", roadIds);
    const adjacent = districts.filter((district) => {
      const effective = difference(intersection(ringAsMulti(district.polygon), mask), [oldOccupancy.all]);
      return regionsTouch(region[0]!, effective);
    });
    const unlocked = adjacent.filter((district) => !district.locked);
    if (unlocked.length === 1) {
      const target = unlocked[0]!;
      target.polygon = singleRing(union([ringAsMulti(target.polygon), [region]]), "Road reclamation", [target.id, ...roadIds]);
    } else {
      districts = districts.map((district) => {
        const result = difference(ringAsMulti(district.polygon), [[region]]);
        if (area(result) >= area(ringAsMulti(district.polygon)) - 1e-5) return district;
        if (district.locked) throw new DistrictEditError("Road reclamation would change a locked district.", [district.id, ...roadIds]);
        return { ...district, polygon: singleRing(result, "Road reclamation", [district.id, ...roadIds]) };
      });
    }
  }
  validateDistrictCandidates(sourceWithDistricts(after, districts), districts);
  return districts;
}
