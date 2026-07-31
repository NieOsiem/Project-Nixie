import { describe, expect, it } from "vitest";
import { describeBuildingMassing, type BuildingSpec } from "../geom/extrude.js";
import { KIND, VERTEX_FLOATS, type MeshBuffers } from "../geom/mesh.js";
import { rectRing, type Ring, type Vec2 } from "../geom/types.js";
import { hash2 } from "./hash.js";
import {
  CLUTTER_MAX_HEIGHT_M,
  CLUTTER_MIN_BUILDING_M,
  clutterMesh
} from "./clutter.js";

const PPM = 25;

const spec = (seed: number, footprint: Ring = rectRing({ x: 0, y: 0, width: 20 * PPM, height: 16 * PPM })): BuildingSpec => ({
  footprint,
  height: 60,
  roofMaterial: 4,
  wallMaterial: 1,
  seed
});

const vertexAt = (mesh: MeshBuffers, index: number) => {
  const at = index * VERTEX_FLOATS;
  return {
    x: mesh.vertices[at]!,
    y: mesh.vertices[at + 1]!,
    height: mesh.vertices[at + 2]!,
    material: mesh.vertices[at + 3]!,
    shade: mesh.vertices[at + 4]!,
    kind: mesh.vertices[at + 5]!,
    u: mesh.vertices[at + 6]!,
    top: mesh.vertices[at + 7]!
  };
};

function pointInRing(p: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a.y > p.y) === (b.y > p.y)) continue;
    if (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

describe("clutterMesh", () => {
  it("is deterministic and emits exact 10-triangle boxes", () => {
    const buildings = Array.from({ length: 100 }, (_, i) => spec(hash2(i, 1, 7)));
    const a = clutterMesh(buildings, PPM);
    const b = clutterMesh(buildings, PPM);
    expect([...b.vertices]).toEqual([...a.vertices]);
    expect([...b.indices]).toEqual([...a.indices]);
    expect(a.vertexCount % 20).toBe(0);
    expect(a.triangleCount).toBe((a.vertexCount / 20) * 10);
    expect(a.triangleCount / 10).toBeGreaterThanOrEqual(buildings.length);
    expect(a.triangleCount / 10).toBeLessThanOrEqual(buildings.length * 2);
  });

  it("gates short buildings and tags every emitted surface as clutter", () => {
    expect(clutterMesh([{ ...spec(0.5), height: CLUTTER_MIN_BUILDING_M - 0.01 }], PPM).vertexCount).toBe(0);
    const mesh = clutterMesh([spec(0.5)], PPM);
    expect(mesh.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vertexAt(mesh, i);
      expect(v.kind).toBe(KIND.CLUTTER);
      expect(v.height).toBeGreaterThanOrEqual(60);
      expect(v.height).toBeLessThanOrEqual(60 + CLUTTER_MAX_HEIGHT_M);
      expect(v.material).toBe(1);
    }
    for (let box = 0; box < mesh.vertexCount / 20; box++) {
      const cap = Array.from({ length: 4 }, (_, i) => vertexAt(mesh, box * 20 + i));
      expect(cap.map((v) => v.shade)).toEqual([-1, -1, -1, -1]);
      expect(cap.map((v) => v.u)).toEqual([-1, 1, 1, -1]);
      expect(cap.map((v) => v.top)).toEqual([-1, -1, 1, 1]);
    }
  });

  it("keeps every box corner inside concave and clipped footprints", () => {
    const footprint: Ring = [
      { x: 0, y: 0 },
      { x: 20 * PPM, y: 0 },
      { x: 20 * PPM, y: 7 * PPM },
      { x: 12 * PPM, y: 7 * PPM },
      { x: 12 * PPM, y: 18 * PPM },
      { x: 0, y: 18 * PPM }
    ];
    let boxes = 0;
    for (let i = 0; i < 100; i++) {
      const mesh = clutterMesh([spec(hash2(i, 2, 9), footprint)], PPM);
      boxes += mesh.vertexCount / 20;
      for (let box = 0; box < mesh.vertexCount / 20; box++) {
        for (let corner = 0; corner < 4; corner++) {
          const v = vertexAt(mesh, box * 20 + corner);
          expect(pointInRing(v, footprint)).toBe(true);
        }
      }
    }
    expect(boxes).toBeGreaterThan(0);
  });

  it("places clutter on the inset top roof of a stepped building", () => {
    const building = { ...spec(0.37), detailedMassing: true };
    const roof = describeBuildingMassing(building, PPM).volumes.at(-1)!;
    const mesh = clutterMesh([building], PPM);

    expect(mesh.vertexCount).toBeGreaterThan(0);
    for (let box = 0; box < mesh.vertexCount / 20; box++) {
      for (let corner = 0; corner < 4; corner++) {
        expect(pointInRing(vertexAt(mesh, box * 20 + corner), roof.footprint)).toBe(true);
      }
      for (const bottom of [4, 5, 8, 9, 12, 13, 16, 17]) {
        expect(vertexAt(mesh, box * 20 + bottom).height).toBe(roof.topHeight);
      }
    }
  });

  it("survives a scene regrid without changing metre positions", () => {
    const coarse = clutterMesh([spec(0.37)], PPM);
    const fineSpec = spec(
      0.37,
      rectRing({ x: 0, y: 0, width: 20 * PPM * 2, height: 16 * PPM * 2 })
    );
    const fine = clutterMesh([fineSpec], PPM * 2);
    expect(fine.indices).toEqual(coarse.indices);
    expect(fine.vertexCount).toBe(coarse.vertexCount);
    for (let i = 0; i < coarse.vertexCount; i++) {
      const a = vertexAt(coarse, i);
      const b = vertexAt(fine, i);
      expect(b.x / (PPM * 2)).toBeCloseTo(a.x / PPM, 5);
      expect(b.y / (PPM * 2)).toBeCloseTo(a.y / PPM, 5);
      expect(b.height).toBe(a.height);
    }
  });
});
