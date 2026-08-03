import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CITY_SCHEMA_VERSION,
  FLAG_CITY,
  GENERATOR_VERSION,
  MODULE_ID
} from "../constants.js";
import type { CityStateV2 } from "../core/gen/terrain.js";
import { loadCityState, saveCityState } from "./documents.js";

let stored: unknown;
let setFlag: ReturnType<typeof vi.fn>;

function installScene(flag: unknown, write: (value: unknown) => Promise<void> = async (value) => {
  stored = value;
}): void {
  stored = flag;
  setFlag = vi.fn(async (_module: string, key: string, value: unknown) => {
    if (key === FLAG_CITY) await write(value);
  });
  (globalThis as any).canvas = {
    scene: {
      getFlag: (module: string, key: string) =>
        module === MODULE_ID && key === FLAG_CITY ? stored : undefined,
      setFlag
    }
  };
  (globalThis as any).game = { user: { isGM: true } };
}

function state(revision = 1): CityStateV2 {
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision,
    source: {
      origin: { x: 5000, y: 4000 },
      citySeed: "phase1-seed",
      generation: { terrainMode: "rectangle", coastEdge: null },
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

afterEach(() => {
  delete (globalThis as any).canvas;
  delete (globalThis as any).game;
  vi.restoreAllMocks();
});

describe("loadCityState", () => {
  it("classifies an undefined flag as absent", () => {
    installScene(undefined);
    expect(loadCityState()).toEqual({ kind: "absent" });
  });

  it("classifies every existing non-2.0 flag as legacy", () => {
    const raw = { formatVersion: 4, origin: { x: 1, y: 2 } };
    installScene(raw);
    expect(loadCityState()).toEqual({ kind: "legacy", raw });
  });

  it("round-trips a valid schema-1 state without changing geometry", () => {
    const raw = state();
    installScene(raw);
    const result = loadCityState();
    expect(result.kind).toBe("supported");
    if (result.kind === "supported") expect(result.state).toEqual(raw);
  });

  it("refuses an unsupported integer schema and preserves the raw value", () => {
    const raw = { ...state(), schemaVersion: 2 };
    installScene(raw);
    expect(loadCityState()).toEqual({ kind: "unsupported", raw, schemaVersion: 2 });
  });

  it("refuses an unsupported generator without rebuilding it as version 8", () => {
    const raw = { ...state(), generatorVersion: GENERATOR_VERSION + 1 };
    installScene(raw);
    expect(loadCityState()).toEqual({
      kind: "unsupported",
      raw,
      schemaVersion: CITY_SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION + 1
    });
  });

  it("refuses malformed recognized schema metadata and source", () => {
    const metadata = { ...state(), schemaVersion: "1" };
    installScene(metadata);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw: metadata });

    const source = { ...state(), source: { ...state().source, terrain: { land: [], urbanFootprint: null } } };
    installScene(source);
    expect(loadCityState()).toMatchObject({ kind: "malformed", raw: source });
  });

  it("refuses inconsistent terrain mode and coast-edge configuration", () => {
    for (const generation of [
      { terrainMode: "coastal", coastEdge: null },
      { terrainMode: "rectangle", coastEdge: "north" },
      { terrainMode: "custom", coastEdge: "west" }
    ]) {
      const raw = { ...state(), source: { ...state().source, generation } };
      installScene(raw);
      expect(loadCityState()).toMatchObject({ kind: "malformed", raw });
    }
  });
});

describe("saveCityState", () => {
  it("creates an absent city at revision 1", async () => {
    installScene(undefined);
    const candidate = state();
    await expect(saveCityState(candidate, "absent")).resolves.toEqual(candidate);
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toEqual(candidate);
    expect((stored as any).formatVersion).toBeUndefined();
  });

  it("allows explicit replacement of legacy data only", async () => {
    const legacy = { formatVersion: 4, graph: {} };
    installScene(legacy);
    const candidate = state();
    await saveCityState(candidate, "legacy");
    expect(stored).toEqual(candidate);
  });

  it("refuses unsupported or malformed flags without writing", async () => {
    for (const raw of [
      { kind: "city-generator-2", schemaVersion: 2 },
      { kind: "city-generator-2", schemaVersion: 1, revision: 1 }
    ]) {
      installScene(raw);
      await expect(saveCityState(state(), "absent")).rejects.toThrow();
      expect(setFlag).not.toHaveBeenCalled();
      expect(stored).toBe(raw);
    }
  });

  it("rejects a stale revision immediately before writing", async () => {
    const current = state(2);
    installScene(current);
    await expect(saveCityState(state(2), 1)).rejects.toThrow(/revision/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(stored).toBe(current);
  });

  it("does not hide a failed Scene write", async () => {
    installScene(undefined, async () => {
      throw new Error("write failed");
    });
    await expect(saveCityState(state(), "absent")).rejects.toThrow("write failed");
    expect(setFlag).toHaveBeenCalledOnce();
    expect(stored).toBeUndefined();
  });
});
