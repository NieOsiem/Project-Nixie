import { describe, expect, it } from "vitest";
import type { CityStateV2 } from "../core/gen/terrain.js";
import { rectangleLand } from "../core/gen/terrain.js";
import { TerrainSession } from "./terrain-session.js";
import {
  configuredPixelsPerMetre,
  enabledFlagChanged,
  sceneBoundsFromPixels
} from "./terrain-canvas.js";

function state(): CityStateV2 {
  return {
    kind: "city-generator-2",
    schemaVersion: 1,
    generatorVersion: 8,
    revision: 1,
    source: {
      origin: { x: 500, y: 400 },
      citySeed: "scale-fixture",
      generation: { terrainMode: "custom", coastEdge: null },
      terrain: {
        land: [
          { x: -100, y: -80 },
          { x: 100, y: -80 },
          { x: 100, y: 80 },
          { x: -100, y: 80 }
        ],
        urbanFootprint: null
      }
    }
  };
}

describe("terrain Scene scale mapping", () => {
  it("detects external Scene enable changes in nested update data", () => {
    expect(enabledFlagChanged({ flags: { "project-nixie": { enabled: true } } })).toBe(true);
    expect(enabledFlagChanged({ flags: { "project-nixie": { city: {} } } })).toBe(false);
  });

  it("uses numeric grid distance as metres per square", () => {
    expect(configuredPixelsPerMetre(100, 2)).toBe(50);
    expect(configuredPixelsPerMetre(70, 5)).toBe(14);
  });

  it("changes derived Scene bounds without mutating persisted metre geometry", () => {
    const city = state();
    const before = structuredClone(city.source);
    const scene = { x: 0, y: 0, width: 1000, height: 800 };
    expect(sceneBoundsFromPixels(scene, city.source.origin, 50)).toEqual({
      x: -10,
      y: -8,
      width: 20,
      height: 16
    });
    expect(sceneBoundsFromPixels(scene, city.source.origin, 25)).toEqual({
      x: -20,
      y: -16,
      width: 40,
      height: 32
    });
    expect(city.source).toEqual(before);
  });

  it("creates an exact Rectangle ring from converted Scene bounds", () => {
    const bounds = sceneBoundsFromPixels({ x: 100, y: 200, width: 800, height: 600 }, { x: 500, y: 500 }, 20);
    expect(rectangleLand(bounds)).toEqual([
      { x: -20, y: -15 },
      { x: 20, y: -15 },
      { x: 20, y: 15 },
      { x: -20, y: 15 }
    ]);
  });

  it("invalidates same-revision render work without changing source state", () => {
    const city = state();
    const session = new TerrainSession();
    session.reset({ kind: "supported", state: city });
    const before = session.current;
    const epoch = session.buildEpoch;
    session.invalidateRenderInputs();
    expect(session.current).toEqual(before);
    expect(session.buildEpoch).toBe(epoch + 1);
  });
});
