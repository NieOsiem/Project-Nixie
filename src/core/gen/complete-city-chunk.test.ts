import { describe, expect, it, vi } from "vitest";
import { intersection, ringAsMulti } from "../geom/boolean.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import {
  rectRing,
  ringArea,
  ringCentroid,
  type MultiPolygon,
  type Rect,
  type Ring
} from "../geom/types.js";
import { BANK_SIZE, DISTRICT_SLOT, FIRST_ZONE_BANK, materialIndex } from "../palette.js";
import { compileRouteNetwork } from "../graph/compiler.js";
import { compiledRouteOccupancy } from "./district-plan.js";
import { ROUTE_CLASS_REGISTRY, type CitySourceV3, type OpenSpaceCategory } from "./city.js";
import type { BuildingGrammarId } from "./building-registry.js";
import { citySurfaces, type CitySurfacePartitions } from "./city-chunk.js";
import { chunkId, chunkKeyAt, chunkRect, chunksCovering } from "./chunks.js";
import {
  buildCompleteCityChunk,
  buildCompleteCityChunks,
  openCompleteCityChunkBatch,
  type CompleteChunkBuild
} from "./complete-city-chunk.js";

// WHY: count surface compilations to prove the batch derives them once, not once per key.
vi.mock("./city-chunk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./city-chunk.js")>();
  return { ...actual, citySurfaces: vi.fn(actual.citySurfaces) };
});
import { visibleChunkIds, type ChunkGeometry } from "../../render/chunk-culling.js";
import type {
  BuildingMassPlan,
  BuildingPlan,
  CompleteCityPlan,
  LandmarkPlan,
  OpenSpacePlan,
  ParcelPlan
} from "./complete-city-plan.js";

/**
 * Fixture: a 512 x 512 m city on a 128 m chunk grid. Parcels sit inside chunk (0,0) and
 * chunk (1,0); parcel-b straddles the x = 128 m seam so its building overhangs chunk
 * (0,0) while being owned by chunk (1,0). The open space open-a straddles the same seam.
 */

const SCENE: Rect = { x: -256, y: -256, width: 512, height: 512 };
const PPM = 25;
const BANK = FIRST_ZONE_BANK;

const SOURCE: CitySourceV3 = {
  origin: { x: 1000, y: 800 },
  citySeed: "complete-chunk-fixture",
  generation: {
    terrainMode: "rectangle",
    coastEdge: null,
    roadLayout: "european",
    hubMode: "single-centre",
    districtPool: ["corporate-core"],
    openSpaceProfile: "medium"
  },
  terrain: { land: rectRing(SCENE), urbanFootprint: null },
  roads: {
    nodes: [
      { id: "west", x: -256, y: 0 },
      { id: "east", x: 256, y: 0 },
      { id: "path-west", x: -256, y: 20 },
      { id: "path-east", x: 256, y: 20 }
    ],
    routes: [
      { id: "road-route", curvePreset: "standard" },
      { id: "path-route", curvePreset: "standard" }
    ],
    edges: [
      { id: "road", a: "west", b: "east", routeId: "road-route", classId: "street", name: null, locked: false, origin: "authored" },
      { id: "path", a: "path-west", b: "path-east", routeId: "path-route", classId: "cycleway", name: null, locked: false, origin: "authored" }
    ]
  },
  districts: []
};

const WALL_A = materialIndex(BANK, DISTRICT_SLOT.WALL_A);
const WALL_B = materialIndex(BANK, DISTRICT_SLOT.WALL_B);
const ROOF_A = materialIndex(BANK, DISTRICT_SLOT.ROOF_A);
const ROOF_B = materialIndex(BANK, DISTRICT_SLOT.ROOF_B);

const mass = (
  id: string,
  buildingId: string,
  index: number,
  footprint: Ring,
  elevationM: number,
  heightM: number,
  detailPolicy: "coarse" | "detail" | "both",
  over: Partial<BuildingMassPlan> = {}
): BuildingMassPlan => ({
  id,
  buildingId,
  index,
  footprint,
  archetype: "rectangle",
  elevationM,
  heightM,
  roofline: "flat",
  facadeProfile: "office-grid",
  massing: "residential-slab",
  wallSlots: [1, 0, 0],
  roofSlots: [1, 0, 0],
  neonSlots: [1, 0],
  wallMaterial: WALL_A,
  roofMaterial: ROOF_A,
  facadeSeed: 0.25,
  signageRate: 0,
  rooftopUtilityRate: 0,
  wear: 0,
  detailPolicy,
  neonEnabled: detailPolicy === "both",
  seed: `${id}-seed`,
  ...over
});

const parcel = (id: string, polygon: Ring): ParcelPlan => ({
  id,
  blockId: "block-0",
  fragmentId: "frag-0",
  districtId: "corporate-core",
  index: 0,
  polygon,
  frontageRoadId: null,
  frontageAngleRad: 0,
  role: "cell",
  seed: `${id}-seed`,
  areaM2: Math.abs(ringArea(polygon))
});

const parcelA = parcel("parcel-a", rectRing({ x: 60, y: 10, width: 20, height: 20 }));
const parcelB = parcel("parcel-b", rectRing({ x: 118, y: 10, width: 20, height: 20 }));
const parcelC = parcel("parcel-c", rectRing({ x: 10, y: 10, width: 20, height: 20 }));

const buildingA: BuildingPlan = {
  id: "building-a",
  parcelId: "parcel-a",
  blockId: "block-0",
  fragmentId: "frag-0",
  districtId: "corporate-core",
  grammarId: "residential-slab",
  visualUse: "residential",
  archetype: "rectangle",
  seed: "building-a-seed",
  appearanceSeed: "building-a-appearance",
  heightM: 48,
  masses: [
    mass("building-a-podium", "building-a", 0, rectRing({ x: 60, y: 10, width: 20, height: 11 }), 0, 8, "coarse"),
    mass(
      "building-a-tower",
      "building-a",
      1,
      rectRing({ x: 63, y: 22, width: 12, height: 7 }),
      8,
      40,
      "both",
      { signageRate: 1, wallMaterial: WALL_B, roofMaterial: ROOF_B }
    )
  ],
  areaM2: 220 + 84
};

const buildingB: BuildingPlan = {
  id: "building-b",
  parcelId: "parcel-b",
  blockId: "block-0",
  fragmentId: "frag-0",
  districtId: "corporate-core",
  grammarId: "residential-slab",
  visualUse: "residential",
  archetype: "rectangle",
  seed: "building-b-seed",
  appearanceSeed: "building-b-appearance",
  heightM: 30,
  masses: [
    mass("building-b-mass", "building-b", 0, rectRing({ x: 118, y: 10, width: 20, height: 20 }), 0, 30, "detail", { facadeSeed: 0.5 })
  ],
  areaM2: 400
};

const buildingC: BuildingPlan = {
  id: "building-c",
  parcelId: "parcel-c",
  blockId: "block-0",
  fragmentId: "frag-0",
  districtId: "corporate-core",
  grammarId: "residential-slab",
  visualUse: "residential",
  archetype: "rectangle",
  seed: "building-c-seed",
  appearanceSeed: "building-c-appearance",
  heightM: 14,
  masses: [
    mass("building-c-mass", "building-c", 0, rectRing({ x: 10, y: 10, width: 20, height: 20 }), 0, 14, "coarse")
  ],
  areaM2: 400
};

const landmark: LandmarkPlan = {
  id: "landmark-l",
  landmarkGrammarId: "monument-open-space",
  districtId: "corporate-core",
  blockId: "block-0",
  sitePolygon: rectRing({ x: 10, y: 60, width: 16, height: 16 }),
  placementLineage: "test",
  seed: "landmark-l-seed",
  appearanceSeed: "landmark-l-appearance",
  masses: [
    {
      id: "landmark-l-mass",
      landmarkId: "landmark-l",
      index: 0,
      kind: "obelisk",
      footprint: rectRing({ x: 12, y: 62, width: 12, height: 12 }),
      elevationM: 0,
      heightM: 50,
      wallSlots: [1, 0, 0],
      roofSlots: [1, 0, 0],
      neonSlots: [1, 0],
      wallMaterial: WALL_B,
      roofMaterial: ROOF_B,
      facadeSeed: 0.75,
      facadeProfile: "civic-columns",
      roofline: "crown",
      signageRate: 0.5,
      rooftopUtilityRate: 0,
      wear: 0,
      detailPolicy: "both",
      neonEnabled: true,
      seed: "landmark-l-mass-seed"
    }
  ],
  openSpaceIds: [],
  areaM2: 144
};

const openA: OpenSpacePlan = {
  id: "open-a",
  parcelId: null,
  blockId: "block-0",
  fragmentId: "frag-0",
  districtId: "corporate-core",
  landmarkId: null,
  category: "park",
  size: "large",
  polygon: rectRing({ x: 108, y: 40, width: 40, height: 20 }),
  surfaceStyle: "grass",
  detailStyle: "trees",
  lineage: "intent",
  seed: "open-a-seed",
  material: ROOF_A,
  areaM2: 800
};

const openB: OpenSpacePlan = {
  id: "open-b",
  parcelId: null,
  blockId: "block-0",
  fragmentId: "frag-0",
  districtId: "corporate-core",
  landmarkId: null,
  category: "plaza",
  size: "small",
  polygon: rectRing({ x: -40, y: 40, width: 30, height: 20 }),
  surfaceStyle: "paving",
  detailStyle: "benches",
  lineage: "intent",
  seed: "open-b-seed",
  material: WALL_A,
  areaM2: 600
};

const PLAN: CompleteCityPlan = {
  sourceRevision: 1,
  actionToken: "action-1",
  buildToken: "build-1",
  epoch: 0,
  openSpaceProfile: "medium",
  structuralInput: { terrain: "t", roads: "r", districts: "d", generation: "g" },
  districtPlan: {
    revisionInputs: { terrain: "t", roads: "r", districts: "d", generation: "g" },
    blocks: [
      {
        id: "block-0",
        zoningFace: rectRing({ x: -64, y: -64, width: 256, height: 160 }),
        buildable: ringAsMulti(rectRing({ x: -64, y: -64, width: 256, height: 160 })),
        boundaryRoadIds: [],
        districtFragments: [
          {
            id: "frag-0",
            blockId: "block-0",
            districtId: "corporate-core",
            buildable: ringAsMulti(rectRing({ x: -64, y: -64, width: 256, height: 160 }))
          }
        ]
      }
    ],
    developmentCells: [],
    openSpaceIntents: [],
    unzoned: [],
    wallCells: [],
    diagnostics: {
      faceCount: 0,
      blockCount: 1,
      fragmentCount: 0,
      developmentCellCount: 0,
      discardedFaceCount: 0,
      discardedCellCount: 0,
      warnings: []
    }
  },
  routeOccupancy: compiledRouteOccupancy(compileRouteNetwork(SOURCE.roads, ROUTE_CLASS_REGISTRY)),
  carriageway: [],
  paletteBanks: [{ paletteId: "corporate", bank: BANK }],
  parcels: [parcelA, parcelB, parcelC],
  openSpaces: [openA, openB],
  buildings: [buildingA, buildingB, buildingC],
  landmarks: [landmark],
  diagnostics: {
    blockCount: 1,
    fragmentCount: 0,
    parcelCount: 3,
    openSpaceCount: 2,
    buildingCount: 3,
    massCount: 5,
    landmarkCount: 1,
    landmarkSkipped: [],
    warnings: []
  }
};

function area(multi: MultiPolygon): number {
  return multi.reduce(
    (sum, polygon) =>
      sum +
      polygon.reduce(
        (part, ring, index) => part + (index === 0 ? 1 : -1) * Math.abs(ringArea(ring)),
        0
      ),
    0
  );
}

function combine(chunks: CitySurfacePartitions[]): CitySurfacePartitions {
  return {
    water: chunks.flatMap((chunk) => chunk.water),
    exposedLand: chunks.flatMap((chunk) => chunk.exposedLand),
    vehicleCarriageway: chunks.flatMap((chunk) => chunk.vehicleCarriageway),
    vehicleSidewalk: chunks.flatMap((chunk) => chunk.vehicleSidewalk),
    nonVehicleRoute: chunks.flatMap((chunk) => chunk.nonVehicleRoute),
    markings: chunks.flatMap((chunk) => chunk.markings),
    laneMarkings: chunks.flatMap((chunk) => chunk.laneMarkings),
    crossings: chunks.flatMap((chunk) => chunk.crossings),
    kerbs: chunks.flatMap((chunk) => chunk.kerbs)
  };
}

const kindsOf = (mesh: { vertices: Float32Array; vertexCount: number }): Set<number> =>
  new Set(
    Array.from({ length: mesh.vertexCount }, (_, i) => mesh.vertices[i * VERTEX_FLOATS + 5]!)
  );

function geometryOf(build: {
  id: string;
  mesh: MeshBuffers;
  detail: MeshBuffers;
  neon: MeshBuffers;
  boundsPx: Rect;
}): ChunkGeometry {
  return {
    id: build.id,
    mesh: build.mesh,
    detail: build.detail,
    neon: build.neon,
    boundsPx: build.boundsPx
  };
}

describe("buildCompleteCityChunk", () => {
  it("owns each building and landmark in exactly one deterministic chunk", () => {
    const batch = buildCompleteCityChunks(SOURCE, PLAN, chunksCovering(SCENE), SCENE, PPM);
    const buildingIds = batch.chunks.flatMap((chunk) => chunk.buildingIds);
    expect(new Set(buildingIds).size).toBe(buildingIds.length);
    expect([...buildingIds].sort()).toEqual(PLAN.buildings.map((b) => b.id).sort());

    const landmarkIds = batch.chunks.flatMap((chunk) => chunk.landmarkIds);
    expect(new Set(landmarkIds).size).toBe(landmarkIds.length);
    expect([...landmarkIds].sort()).toEqual(PLAN.landmarks.map((l) => l.id).sort());

    const byId = new Map(PLAN.parcels.map((p) => [p.id, p]));
    for (const building of PLAN.buildings) {
      const centroid = ringCentroid(byId.get(building.parcelId)!.polygon);
      const owners = batch.chunks.filter((chunk) => chunk.buildingIds.includes(building.id));
      expect(owners).toHaveLength(1);
      expect(owners[0]!.key).toEqual(chunkKeyAt(centroid));
    }
    expect(
      batch.chunks.filter((chunk) => chunk.landmarkIds.includes("landmark-l"))
    ).toHaveLength(1);
  });

  it("clips surfaces and open spaces at seams without gaps or overlaps", () => {
    const batch = buildCompleteCityChunks(SOURCE, PLAN, chunksCovering(SCENE), SCENE, PPM);
    const whole = citySurfaces(SOURCE, SCENE);
    const combined = combine(batch.chunks.map((chunk) => chunk.surfaces));
    for (const key of ["water", "exposedLand", "vehicleCarriageway", "vehicleSidewalk", "nonVehicleRoute", "markings"] as const) {
      expect(area(combined[key])).toBeCloseTo(area(whole[key]), 4);
    }
    for (const openSpace of PLAN.openSpaces) {
      const pieces = batch.chunks
        .map((chunk) => intersection(ringAsMulti(openSpace.polygon), ringAsMulti(rectRing(chunkRect(chunk.key)))))
        .filter((polygon) => polygon.length > 0);
      expect(pieces.reduce((sum, polygon) => sum + area(polygon), 0)).toBeCloseTo(
        area(ringAsMulti(openSpace.polygon)),
        4
      );
    }
    expect(
      batch.chunks.reduce((sum, chunk) => sum + chunk.openSpaceTriangleCount, 0)
    ).toBeGreaterThan(0);
  });

  it("grows culling bounds over every emitted vertex, including overhang, shadow and neon", () => {
    // Chunk (1,0) owns parcel-b, whose building reaches west into chunk (0,0)'s rect.
    const owner = buildCompleteCityChunk(SOURCE, PLAN, { cx: 1, cy: 0 }, SCENE, PPM);
    expect(owner.buildingIds).toEqual(["building-b"]);

    const footprintPx: Rect = {
      x: SOURCE.origin.x + 118 * PPM,
      y: SOURCE.origin.y + 10 * PPM,
      width: 20 * PPM,
      height: 20 * PPM
    };
    // The nominal chunk rect starts at x = 128 m, so the west overhang (footprint plus its
    // shadow reach) is what forces the culling bounds further out.
    expect(owner.boundsPx.x).toBeLessThanOrEqual(footprintPx.x);
    expect(owner.boundsPx.x).toBeLessThanOrEqual(SOURCE.origin.x + 128 * PPM);

    // Every emitted vertex — opaque, detail and neon — sits inside the culling bounds.
    for (const mesh of [owner.mesh, owner.detail, owner.neon]) {
      for (let i = 0; i < mesh.vertexCount; i++) {
        const x = mesh.vertices[i * VERTEX_FLOATS]!;
        const y = mesh.vertices[i * VERTEX_FLOATS + 1]!;
        expect(x).toBeGreaterThanOrEqual(owner.boundsPx.x - 1e-3);
        expect(x).toBeLessThanOrEqual(owner.boundsPx.x + owner.boundsPx.width + 1e-3);
        expect(y).toBeGreaterThanOrEqual(owner.boundsPx.y - 1e-3);
        expect(y).toBeLessThanOrEqual(owner.boundsPx.y + owner.boundsPx.height + 1e-3);
      }
    }

    // A view that only sees the overhang must still draw the owner chunk.
    const overhangView: Rect = {
      x: SOURCE.origin.x + 128 * PPM,
      y: SOURCE.origin.y + 10 * PPM,
      width: PPM,
      height: 20 * PPM
    };
    expect(visibleChunkIds([geometryOf(owner)], overhangView)).toEqual([owner.id]);
    // A view far away must cull it.
    expect(
      visibleChunkIds([geometryOf(owner)], { x: SOURCE.origin.x, y: SOURCE.origin.y + 200 * PPM, width: 100, height: 100 })
    ).toEqual([]);
  });

  it("keeps the opaque, detail and neon meshes kind-separated on the 11-float payload", () => {
    const build = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM);
    for (const mesh of [build.mesh, build.detail, build.neon]) {
      expect(mesh.vertices.length).toBe(mesh.vertexCount * VERTEX_FLOATS);
      expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
    }
    expect(kindsOf(build.mesh).has(KIND.NEON)).toBe(false);
    expect(kindsOf(build.mesh).has(KIND.DETAIL)).toBe(false);
    expect(build.mesh.vertexCount).toBeGreaterThan(0);
    expect(kindsOf(build.detail).has(KIND.NEON)).toBe(false);
    expect([...kindsOf(build.neon)].every((kind) => kind === KIND.NEON)).toBe(true);
    // The neon-signature tower earns glow; the coarse podium never leaks into the neon pass.
    expect(build.neon.vertexCount).toBeGreaterThan(0);
    expect(build.detail.vertexCount).toBeGreaterThan(0);
  });

  it("returns exclusively-owned exact-sized buffers the worker can transfer", () => {
    const build = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM);
    for (const mesh of [build.mesh, build.detail, build.neon]) {
      expect(mesh.vertices).toBeInstanceOf(Float32Array);
      expect(mesh.indices).toBeInstanceOf(Uint32Array);
      for (const view of [mesh.vertices, mesh.indices]) {
        expect(view.byteOffset).toBe(0);
        expect(view.buffer.byteLength).toBe(view.byteLength);
      }
    }
  });

  it("is deterministic across repeated builds", () => {
    const a = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM);
    const b = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM);
    expect([...b.mesh.vertices]).toEqual([...a.mesh.vertices]);
    expect([...b.mesh.indices]).toEqual([...a.mesh.indices]);
    expect([...b.detail.vertices]).toEqual([...a.detail.vertices]);
    expect([...b.neon.vertices]).toEqual([...a.neon.vertices]);
  });

  it("honours precomputed surfaces passed by the batch", () => {
    const surfaces = citySurfaces(SOURCE, SCENE);
    const direct = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM, surfaces);
    const selfDerived = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM);
    expect([...direct.mesh.vertices]).toEqual([...selfDerived.mesh.vertices]);
  });

  it("returns empty meshes and nominal bounds for a chunk outside the scene", () => {
    const far = buildCompleteCityChunk(SOURCE, PLAN, { cx: 50, cy: 50 }, SCENE, PPM);
    expect(far.mesh.vertexCount).toBe(0);
    expect(far.detail.vertexCount).toBe(0);
    expect(far.neon.vertexCount).toBe(0);
    expect(far.buildingCount).toBe(0);
    expect(far.landmarkCount).toBe(0);
    expect(far.openSpaceCount).toBe(0);
    expect(far.boundsM).toEqual({ x: 50 * 128, y: 50 * 128, width: 128, height: 128 });
    expect(far.boundsPx).toEqual({
      x: SOURCE.origin.x + 50 * 128 * PPM,
      y: SOURCE.origin.y + 50 * 128 * PPM,
      width: 128 * PPM,
      height: 128 * PPM
    });
  });

  it("rejects non-positive pixels per metre", () => {
    expect(() =>
      buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, 0)
    ).toThrow(/pixels per metre/i);
    expect(() =>
      buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, Number.NaN)
    ).toThrow(/pixels per metre/i);
  });

  it("makes grammar appearance profiles observable in the final payload", () => {
    const base = buildCompleteCityChunk(SOURCE, PLAN, { cx: 0, cy: 0 }, SCENE, PPM);
    const withAppearance = (over: Partial<BuildingMassPlan>): CompleteCityPlan => ({
      ...PLAN,
      buildings: PLAN.buildings.map((building) =>
        building.id === "building-a"
          ? {
              ...building,
              masses: building.masses.map((m) =>
                m.id === "building-a-tower" ? { ...m, ...over } : m
              )
            }
          : building
      )
    });
    const positionsOf = (build: CompleteChunkBuild): string[] =>
      Array.from({ length: build.mesh.vertexCount }, (_, i) => {
        const at = i * VERTEX_FLOATS;
        return `${build.mesh.vertices[at]},${build.mesh.vertices[at + 1]},${build.mesh.vertices[at + 2]}`;
      });
    const seedsOf = (build: CompleteChunkBuild, kind: number): number[] =>
      Array.from({ length: build.mesh.vertexCount }, (_, i) => {
        const at = i * VERTEX_FLOATS;
        return build.mesh.vertices[at + 5] === kind ? build.mesh.vertices[at + 8]! : NaN;
      }).filter((seed) => Number.isFinite(seed));

    const profiled = buildCompleteCityChunk(
      SOURCE,
      withAppearance({ facadeProfile: "glass-curtain" }),
      { cx: 0, cy: 0 },
      SCENE,
      PPM
    );
    // Geometry is untouched; only the shader-driving seeds move.
    expect(profiled.mesh.triangleCount).toBe(base.mesh.triangleCount);
    expect(positionsOf(profiled)).toEqual(positionsOf(base));
    expect(seedsOf(profiled, KIND.WALL)).not.toEqual(seedsOf(base, KIND.WALL));
    expect(seedsOf(profiled, KIND.ROOF)).toEqual(seedsOf(base, KIND.ROOF));

    const worn = buildCompleteCityChunk(
      SOURCE,
      withAppearance({ facadeProfile: "glass-curtain", roofline: "crown", wear: 0.55 }),
      { cx: 0, cy: 0 },
      SCENE,
      PPM
    );
    expect(worn.mesh.triangleCount).toBe(base.mesh.triangleCount);
    expect([...worn.mesh.vertices]).not.toEqual([...base.mesh.vertices]);
    expect(seedsOf(worn, KIND.WALL)).not.toEqual(seedsOf(profiled, KIND.WALL));
    expect(seedsOf(worn, KIND.ROOF)).not.toEqual(seedsOf(base, KIND.ROOF));
  });

  it("keeps neon zero for a detail-enabled, neon-disabled mass despite signageRate 1", () => {
    const onlyTower = (towerOver: Partial<BuildingMassPlan>): CompleteCityPlan => ({
      ...PLAN,
      landmarks: [],
      openSpaces: [],
      buildings: PLAN.buildings
        .filter((b) => b.id === "building-a")
        .map((b) => ({
          ...b,
          masses: b.masses.map((m) =>
            m.id === "building-a-tower" ? { ...m, signageRate: 1, ...towerOver } : m
          )
        })),
      diagnostics: {
        ...PLAN.diagnostics,
        buildingCount: 1,
        landmarkCount: 0,
        openSpaceCount: 0,
        massCount: 2
      }
    });
    const enabled = buildCompleteCityChunk(SOURCE, onlyTower({ detailPolicy: "both", neonEnabled: true }), { cx: 0, cy: 0 }, SCENE, PPM);
    expect(enabled.neon.vertexCount).toBeGreaterThan(0);

    const disabled = buildCompleteCityChunk(SOURCE, onlyTower({ detailPolicy: "both", neonEnabled: false }), { cx: 0, cy: 0 }, SCENE, PPM);
    expect(disabled.neon.vertexCount).toBe(0);
    expect(disabled.neon.triangleCount).toBe(0);
    // Detail and neon are independent renderer policies: the mass still earns its detail tier.
    expect(disabled.detail.vertexCount).toBeGreaterThan(0);
  });

  it("gives every required open-space category a distinct treatment and separates park from service-yard", () => {
    const styles: {
      category: OpenSpaceCategory;
      surfaceStyle: string;
      detailStyle: string;
      slot: number;
    }[] = [
      { category: "park", surfaceStyle: "grass", detailStyle: "trees", slot: DISTRICT_SLOT.ROOF_A },
      { category: "plaza", surfaceStyle: "paving", detailStyle: "benches", slot: DISTRICT_SLOT.WALL_A },
      { category: "parking", surfaceStyle: "tarmac", detailStyle: "markings", slot: DISTRICT_SLOT.WALL_B },
      { category: "vacant", surfaceStyle: "scrub", detailStyle: "none", slot: DISTRICT_SLOT.WALL_C },
      { category: "utility", surfaceStyle: "concrete", detailStyle: "utility-structures", slot: DISTRICT_SLOT.ROOF_B },
      { category: "landscaping", surfaceStyle: "planting", detailStyle: "planters", slot: DISTRICT_SLOT.ROOF_C },
      { category: "service-yard", surfaceStyle: "gravel", detailStyle: "bins", slot: DISTRICT_SLOT.ROOF_A }
    ];
    const treatments = styles.map(({ category, surfaceStyle, detailStyle, slot }) => {
      const openSpace: OpenSpacePlan = {
        id: `os-${category}`,
        parcelId: null,
        blockId: "block-0",
        fragmentId: "frag-0",
        districtId: "corporate-core",
        landmarkId: null,
        category,
        size: "small",
        polygon: rectRing({ x: 20, y: 80, width: 40, height: 30 }),
        surfaceStyle,
        detailStyle,
        lineage: "intent",
        seed: `os-${category}-seed`,
        material: materialIndex(BANK, slot),
        areaM2: 1200
      };
      const only = {
        ...PLAN,
        parcels: [],
        buildings: [],
        landmarks: [],
        openSpaces: [openSpace],
        diagnostics: { ...PLAN.diagnostics, parcelCount: 0, buildingCount: 0, landmarkCount: 0, openSpaceCount: 1, massCount: 0 }
      };
      const build = buildCompleteCityChunk(SOURCE, only, { cx: 0, cy: 0 }, SCENE, PPM);
      const flatPairs = new Set<string>();
      for (let i = 0; i < build.mesh.vertexCount; i++) {
        const at = i * VERTEX_FLOATS;
        const kind = build.mesh.vertices[at + 5]!;
        const material = build.mesh.vertices[at + 3]!;
        if (kind !== KIND.FLAT || material < BANK * BANK_SIZE) continue;
        flatPairs.add(`${material}:${build.mesh.vertices[at + 4]!}`);
      }
      expect(flatPairs.size).toBe(1);
      return { category, pair: [...flatPairs][0]!, hasDetail: build.detail.vertexCount > 0 };
    });

    const signatures = treatments.map((t) => `${t.pair}|${t.hasDetail}`);
    expect(new Set(signatures).size).toBe(styles.length);
    const park = treatments.find((t) => t.category === "park")!;
    const yard = treatments.find((t) => t.category === "service-yard")!;
    expect(park.pair).not.toBe(yard.pair);
    expect(yard.hasDetail).toBe(true);
    expect(treatments.find((t) => t.category === "vacant")!.hasDetail).toBe(false);
  });

  it("keeps the geometry budget: one 4-vertex 14 m mass is exactly 10 opaque triangles", () => {
    const onlyC = (): CompleteCityPlan => ({
      ...PLAN,
      buildings: PLAN.buildings.filter((b) => b.id === "building-c"),
      landmarks: [],
      openSpaces: []
    });
    const withC = buildCompleteCityChunk(SOURCE, onlyC(), { cx: 0, cy: 0 }, SCENE, PPM);
    const bare = buildCompleteCityChunk(
      SOURCE,
      { ...onlyC(), buildings: [] },
      { cx: 0, cy: 0 },
      SCENE,
      PPM
    );
    // 2 roof triangles + 8 wall triangles for a 4-vertex footprint; no clutter (14 m <
    // 20 m), no detail (coarse policy) and no neon (signageRate 0).
    expect(withC.mesh.triangleCount - bare.mesh.triangleCount).toBe(10);
    expect(withC.detail.triangleCount).toBe(0);
    expect(withC.neon.triangleCount).toBe(0);
    expect(withC.buildingCount).toBe(1);
  });

  it("splits coarse and settled geometry by the grammar's geometryPolicy.coarse", () => {
    const podium = mass("s-podium", "s", 0, rectRing({ x: 60, y: 10, width: 20, height: 11 }), 0, 12, "detail");
    const tower = mass("s-tower", "s", 1, rectRing({ x: 63, y: 13, width: 12, height: 6 }), 12, 12, "detail", {
      facadeProfile: "glass-curtain",
      roofline: "flat"
    });
    const withGrammar = (grammarId: BuildingGrammarId, heightM: number): CompleteCityPlan => ({
      ...PLAN,
      landmarks: [],
      openSpaces: [],
      buildings: [
        {
          id: "s",
          parcelId: "parcel-a",
          blockId: "block-0",
          fragmentId: "frag-0",
          districtId: "corporate-core",
          grammarId,
          visualUse: "industrial",
          archetype: "rectangle",
          seed: "s-seed",
          appearanceSeed: "s-appearance",
          heightM,
          masses: [podium, tower],
          areaM2: 220 + 72
        }
      ],
      diagnostics: { ...PLAN.diagnostics, buildingCount: 1, landmarkCount: 0, openSpaceCount: 0, massCount: 2 }
    });
    const wallVertices = (mesh: MeshBuffers): number => {
      let count = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (mesh.vertices[i * VERTEX_FLOATS + 5] === KIND.WALL) count++;
      }
      return count;
    };
    const volumes = buildCompleteCityChunk(
      SOURCE,
      withGrammar("residential-slab", 24),
      { cx: 0, cy: 0 },
      SCENE,
      PPM
    );
    const silhouette = buildCompleteCityChunk(
      SOURCE,
      withGrammar("stacked-workshop", 24),
      { cx: 0, cy: 0 },
      SCENE,
      PPM
    );
    expect(wallVertices(volumes.mesh)).toBe(32);
    expect(wallVertices(silhouette.mesh)).toBe(16);
    expect(kindsOf(silhouette.detail).has(KIND.WALL)).toBe(true);
    expect(kindsOf(volumes.detail).has(KIND.WALL)).toBe(false);
    expect(silhouette.detail.triangleCount).toBeGreaterThan(0);
    expect(silhouette.buildingIds).toEqual(volumes.buildingIds);
  });
});

describe("buildCompleteCityChunks", () => {
  const KEYS = chunksCovering(SCENE);

  it("builds every requested key and echoes totals", () => {
    const batch = buildCompleteCityChunks(SOURCE, PLAN, KEYS, SCENE, PPM);
    expect(batch.chunks.map((chunk) => chunk.id)).toEqual(KEYS.map(chunkId));
    expect(batch.buildingCount).toBe(3);
    expect(batch.landmarkCount).toBe(1);
    expect(batch.openSpaceCount).toBeGreaterThan(0);
    expect(batch.markingTriangleCount).toBe(
      batch.chunks.reduce((sum, chunk) => sum + chunk.markingTriangleCount, 0)
    );
    expect(batch.vertexCount).toBe(
      batch.chunks.reduce(
        (sum, chunk) => sum + chunk.mesh.vertexCount + chunk.detail.vertexCount + chunk.neon.vertexCount,
        0
      )
    );
    expect(batch.triangleCount).toBe(
      batch.chunks.reduce(
        (sum, chunk) => sum + chunk.mesh.triangleCount + chunk.detail.triangleCount + chunk.neon.triangleCount,
        0
      )
    );
    expect(batch.bytes).toBe(
      batch.chunks.reduce(
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
    );
  });

  it("rejects a plan the validator rejects", () => {
    const broken: CompleteCityPlan = {
      ...PLAN,
      buildings: [{ ...buildingA, masses: [] }]
    };
    expect(() => buildCompleteCityChunks(SOURCE, broken, KEYS, SCENE, PPM)).toThrow(/invalid/i);
  });
});

describe("openCompleteCityChunkBatch", () => {
  const KEYS = chunksCovering(SCENE);

  it("builds one chunk at a time in stable key order and reports remaining", () => {
    const batch = openCompleteCityChunkBatch(SOURCE, PLAN, KEYS, SCENE, PPM);
    expect(batch.remaining).toBe(KEYS.length);
    const ids: string[] = [];
    while (batch.remaining > 0) {
      ids.push(batch.buildNext().id);
    }
    expect(ids).toEqual(KEYS.map(chunkId));
    expect(batch.remaining).toBe(0);
  });

  it("throws once the batch is exhausted", () => {
    const batch = openCompleteCityChunkBatch(SOURCE, PLAN, KEYS, SCENE, PPM);
    while (batch.remaining > 0) batch.buildNext();
    expect(() => batch.buildNext()).toThrow(/exhausted/i);
  });

  it("produces exactly the same chunks as the full-batch aggregate", () => {
    const batch = openCompleteCityChunkBatch(SOURCE, PLAN, KEYS, SCENE, PPM);
    const aggregate = buildCompleteCityChunks(SOURCE, PLAN, KEYS, SCENE, PPM);
    const incremental = KEYS.map(() => batch.buildNext());
    expect(incremental.map((chunk) => chunk.id)).toEqual(aggregate.chunks.map((chunk) => chunk.id));
    for (let i = 0; i < incremental.length; i++) {
      expect([...incremental[i]!.mesh.vertices]).toEqual([...aggregate.chunks[i]!.mesh.vertices]);
      expect([...incremental[i]!.mesh.indices]).toEqual([...aggregate.chunks[i]!.mesh.indices]);
      expect(incremental[i]!.buildingIds).toEqual(aggregate.chunks[i]!.buildingIds);
      expect(incremental[i]!.boundsPx).toEqual(aggregate.chunks[i]!.boundsPx);
    }
  });

  it("compiles the shared city surfaces exactly once for the whole batch", () => {
    vi.mocked(citySurfaces).mockClear();
    const batch = openCompleteCityChunkBatch(SOURCE, PLAN, KEYS, SCENE, PPM);
    while (batch.remaining > 0) batch.buildNext();
    expect(citySurfaces).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid plan at open before any chunk is built", () => {
    const broken: CompleteCityPlan = {
      ...PLAN,
      buildings: [{ ...buildingA, masses: [] }]
    };
    expect(() => openCompleteCityChunkBatch(SOURCE, broken, KEYS, SCENE, PPM)).toThrow(/invalid/i);
  });
});
