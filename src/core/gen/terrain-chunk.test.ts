import { describe, expect, it } from "vitest";
import { chunksCovering } from "./chunks.js";
import {
  buildTerrainChunk,
  terrainChunks,
  terrainSurfaces,
  type TerrainSurfaces
} from "./terrain-chunk.js";
import { rectangleLand, type CitySourceV2 } from "./terrain.js";
import { ringArea, rectRing, type MultiPolygon, type Rect } from "../geom/types.js";
import { intersection } from "../geom/boolean.js";
import { MATERIAL } from "../palette.js";

const SCENE: Rect = { x: -192, y: -64, width: 384, height: 256 };
const SOURCE: CitySourceV2 = {
  origin: { x: 1000, y: 800 },
  citySeed: "terrain-fixture",
  generation: { terrainMode: "rectangle", coastEdge: null },
  terrain: { land: rectangleLand({ x: -80, y: -32, width: 220, height: 160 }), urbanFootprint: null }
};
const PPM = 2;

function area(multi: MultiPolygon): number {
  return multi.reduce(
    (sum, polygon) =>
      sum + polygon.reduce((part, ring, i) => part + (i === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring))), 0),
    0
  );
}

function sumSurfaces(chunks: TerrainSurfaces[]): TerrainSurfaces {
  return {
    land: chunks.flatMap((chunk) => chunk.land),
    water: chunks.flatMap((chunk) => chunk.water)
  };
}

describe("terrain chunk generation", () => {
  it("builds flat land and water with shared chunk geometry", () => {
    const build = buildTerrainChunk(SOURCE, { cx: -1, cy: 0 }, SCENE, PPM);
    expect(build.mesh.vertexCount).toBeGreaterThan(0);
    expect(build.mesh.triangleCount).toBeGreaterThan(0);
    expect(build.landTriangleCount).toBeGreaterThan(0);
    expect(build.waterTriangleCount).toBeGreaterThan(0);
    expect(build.mesh.indices.length).toBe(build.mesh.triangleCount * 3);
    expect(build.mesh.vertices.length).toBe(build.mesh.vertexCount * 11);
    const materials = new Set<number>();
    for (let i = 0; i < build.mesh.vertexCount; i++) {
      materials.add(build.mesh.vertices[i * 11 + 3]!);
    }
    expect(materials).toEqual(new Set([MATERIAL.GROUND, MATERIAL.WATER]));
  });

  it("partitions scene land and water exactly across 128m chunks", () => {
    const whole = terrainSurfaces(SOURCE, SCENE);
    const chunks = terrainChunks(SOURCE, SCENE, PPM);
    const combined = sumSurfaces(chunks.map((chunk) => chunk.surfaces));
    expect(chunks.length).toBe(chunksCovering(SCENE).length);
    expect(area(combined.land)).toBeCloseTo(area(whole.land), 6);
    expect(area(combined.water)).toBeCloseTo(area(whole.water), 6);
    expect(area(whole.land) + area(whole.water)).toBeCloseTo(SCENE.width * SCENE.height, 6);
    for (let i = 0; i < chunks.length; i++) {
      for (let j = i + 1; j < chunks.length; j++) {
        expect(area(intersection(chunks[i]!.surfaces.land, chunks[j]!.surfaces.land))).toBe(0);
        expect(area(intersection(chunks[i]!.surfaces.water, chunks[j]!.surfaces.water))).toBe(0);
      }
    }

    const triangles = chunks.flatMap((chunk) => {
      const { vertices, indices } = chunk.mesh;
      const points = (index: number): string => {
        const offset = index * 11;
        return `${vertices[offset]!.toFixed(6)},${vertices[offset + 1]!.toFixed(6)}`;
      };
      const keys: string[] = [];
      for (let i = 0; i < indices.length; i += 3) {
        keys.push(
          [points(indices[i]!), points(indices[i + 1]!), points(indices[i + 2]!)].sort().join("|")
        );
      }
      return keys;
    });
    expect(new Set(triangles).size).toBe(triangles.length);
  });

  it("keeps world-pixel conversion tied to the source origin", () => {
    const build = buildTerrainChunk(SOURCE, { cx: -1, cy: -1 }, SCENE, PPM);
    const xs = Array.from({ length: build.mesh.vertexCount }, (_, i) => build.mesh.vertices[i * 11]!);
    const ys = Array.from({ length: build.mesh.vertexCount }, (_, i) => build.mesh.vertices[i * 11 + 1]!);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(SOURCE.origin.x + SCENE.x * PPM - 1e-6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(SOURCE.origin.y + SCENE.y * PPM - 1e-6);
  });

  it("returns an empty mesh for chunks outside the scene", () => {
    const build = buildTerrainChunk(SOURCE, { cx: 10, cy: 10 }, SCENE, PPM);
    expect(build.mesh.vertexCount).toBe(0);
    expect(build.mesh.triangleCount).toBe(0);
    expect(build.surfaces).toEqual({ land: [], water: [] });
  });

  it("rejects invalid source terrain before clipping", () => {
    const invalid = {
      ...SOURCE,
      terrain: { land: rectRing({ x: 0, y: 0, width: 1, height: 1 }).slice(0, 2), urbanFootprint: null }
    } as CitySourceV2;
    expect(() => buildTerrainChunk(invalid, { cx: 0, cy: 0 }, SCENE, PPM)).toThrow(/Land/);
  });
});
