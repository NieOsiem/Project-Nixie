import { describe, expect, it } from "vitest";
import {
  DOLLY_LEAN_POINTS,
  LEAN_ZOOM_IN_CUTOFF,
  LEAN_ZOOM_OUT_CUTOFF,
  capOverviewLeanStrength,
  dollyLeanStrength
} from "./lean-curve.js";

describe("dollyLeanStrength", () => {
  it.each(DOLLY_LEAN_POINTS)("passes through $zoom -> $strength", ({ zoom, strength }) => {
    expect(dollyLeanStrength(zoom)).toBeCloseTo(strength, 12);
  });

  it("is monotone and stays inside each calibrated interval", () => {
    for (let i = 0; i < DOLLY_LEAN_POINTS.length - 1; i++) {
      const from = DOLLY_LEAN_POINTS[i]!;
      const to = DOLLY_LEAN_POINTS[i + 1]!;
      let previous = from.strength;
      for (let step = 1; step <= 100; step++) {
        const t = step / 100;
        const zoom = Math.exp(Math.log(from.zoom) * (1 - t) + Math.log(to.zoom) * t);
        const strength = dollyLeanStrength(zoom);
        expect(strength).toBeGreaterThanOrEqual(previous);
        expect(strength).toBeGreaterThanOrEqual(from.strength);
        expect(strength).toBeLessThanOrEqual(to.strength);
        previous = strength;
      }
    }
  });

  it("has matching slopes on both sides of every internal point", () => {
    const epsilon = 1e-5;
    for (const point of DOLLY_LEAN_POINTS.slice(1, -1)) {
      const left = dollyLeanStrength(point.zoom * Math.exp(-epsilon));
      const centre = dollyLeanStrength(point.zoom);
      const right = dollyLeanStrength(point.zoom * Math.exp(epsilon));
      expect((centre - left) / epsilon).toBeCloseTo((right - centre) / epsilon, 3);
    }
  });

  it("preserves the approved curve below the new high-zoom points", () => {
    expect(dollyLeanStrength(0.7290772227456292)).toBeCloseTo(3.351410554125601, 12);
  });

  it("holds the lowest sampled value below range and continues without a top cap", () => {
    expect(dollyLeanStrength(0.01)).toBeCloseTo(0.15, 12);
    expect(dollyLeanStrength(8)).toBeGreaterThan(32);
  });

  it("caps perceived facade height below the calibrated overview zoom", () => {
    expect(capOverviewLeanStrength(LEAN_ZOOM_OUT_CUTOFF, 1)).toBe(1);
    expect(capOverviewLeanStrength(LEAN_ZOOM_OUT_CUTOFF / 2, 1)).toBe(0.5);
    expect(capOverviewLeanStrength(LEAN_ZOOM_OUT_CUTOFF / 4, 3)).toBe(0.75);
  });

  it("scales perceived facade height above the calibrated zoom-in cutoff to prevent flattening", () => {
    expect(capOverviewLeanStrength(LEAN_ZOOM_IN_CUTOFF, 1)).toBe(1);
    expect(capOverviewLeanStrength(LEAN_ZOOM_IN_CUTOFF * 2, 1)).toBe(2);
    expect(capOverviewLeanStrength(LEAN_ZOOM_IN_CUTOFF * 4, 3)).toBe(12);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid zoom %s", (zoom) => {
    expect(() => dollyLeanStrength(zoom)).toThrow("Zoom must be finite and positive.");
  });
});
