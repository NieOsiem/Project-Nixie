import { describe, expect, it } from "vitest";
import { simplifyRing } from "./simplify.js";
import { rectRing, ringArea, type Ring } from "./types.js";

const polygonRing = (segments: number, radius = 100): Ring =>
  Array.from({ length: segments }, (_, i) => ({
    x: radius * Math.cos((i / segments) * Math.PI * 2),
    y: radius * Math.sin((i / segments) * Math.PI * 2)
  }));

const rotate = (ring: Ring, by: number): Ring => [...ring.slice(by), ...ring.slice(0, by)];

const keySet = (ring: Ring): Set<string> =>
  new Set(ring.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));

describe("simplifyRing", () => {
  it("leaves a rectangle alone", () => {
    const r = rectRing({ x: 0, y: 0, width: 100, height: 50 });
    expect(simplifyRing(r, 1)).toHaveLength(4);
    expect(Math.abs(ringArea(simplifyRing(r, 1)))).toBeCloseTo(5000, 6);
  });

  it("removes collinear points even at zero tolerance", () => {
    const withMidpoints: Ring = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 50 },
      { x: 0, y: 50 }
    ];
    const s = simplifyRing(withMidpoints, 0);
    expect(s).toHaveLength(4);
    expect(Math.abs(ringArea(s))).toBeCloseTo(5000, 6);
  });

  it("collapses arc detail as tolerance grows", () => {
    const arc = polygonRing(32);
    const counts = [0.01, 1, 5, 20, 60].map((t) => simplifyRing(arc, t).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
    }
    expect(counts[0]).toBe(32);
    expect(counts[counts.length - 1]!).toBeLessThan(10);
  });

  it("keeps the enclosed area within the tolerance band", () => {
    const arc = polygonRing(64);
    const original = Math.abs(ringArea(arc));
    const simplified = Math.abs(ringArea(simplifyRing(arc, 2)));
    expect(simplified).toBeLessThanOrEqual(original);
    expect(simplified / original).toBeGreaterThan(0.97);
  });

  it("is independent of where the ring starts", () => {
    const arc = polygonRing(24);
    const base = simplifyRing(arc, 6);
    for (const by of [1, 7, 13, 23]) {
      expect(keySet(simplifyRing(rotate(arc, by), 6))).toEqual(keySet(base));
    }
  });

  it("never drops below three points", () => {
    for (const t of [100, 1000, 1e6]) {
      expect(simplifyRing(polygonRing(16), t).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("passes tiny rings through untouched", () => {
    const tri: Ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 }
    ];
    expect(simplifyRing(tri, 50)).toEqual(tri);
  });

  it("keeps every output point present in the input", () => {
    const arc = polygonRing(40);
    const inputKeys = keySet(arc);
    for (const p of simplifyRing(arc, 8)) {
      expect(inputKeys.has(`${p.x.toFixed(6)},${p.y.toFixed(6)}`)).toBe(true);
    }
  });
});
