import { describe, expect, it } from "vitest";
import type { CityLoadResult } from "./documents.js";
import {
  TerrainActionQueue,
  TerrainSession,
  terrainBuildIsCurrent
} from "./terrain-session.js";
import { CITY_SCHEMA_VERSION, GENERATOR_VERSION } from "../constants.js";
import { DISTRICT_TYPE_IDS } from "../core/gen/district-registry.js";
import type { CityStateV4 } from "../core/gen/city.js";

function state(revision: number, seed = "session-seed"): CityStateV4 {
  return {
    kind: "city-generator-2",
    schemaVersion: CITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    revision,
    source: {
      origin: { x: 0, y: 0 },
      citySeed: seed,
      generation: {
        terrainMode: "rectangle",
        coastEdge: null,
        roadLayout: "european",
        hubMode: "single-centre",
        districtPool: [...DISTRICT_TYPE_IDS],
        openSpaceProfile: "medium"
      },
      terrain: {
        land: [
          { x: -10, y: -10 },
          { x: 10, y: -10 },
          { x: 10, y: 10 },
          { x: -10, y: 10 }
        ],
        urbanFootprint: null
      },
      roads: { nodes: [], routes: [], edges: [] },
      districts: [],
      architecture: {
        buildings: [{
          id: "bldg-session",
          lineage: "lineage-session-building",
          origin: "authored",
          protection: "manual-edit",
          seed: "building-structural-seed",
          appearanceSeed: "building-appearance-seed",
          grammarId: "narrow-shopfront",
          visualUse: "commercial",
          heightM: 30,
          paletteId: null,
          sitePolygon: [
            { x: -8, y: -8 },
            { x: 0, y: -8 },
            { x: 0, y: 0 },
            { x: -8, y: 0 }
          ],
          placement: { centre: { x: -4, y: -4 }, rotationRad: 0, widthM: 8, depthM: 8 },
          districtId: null,
          blockId: null
        }],
        places: [{
          id: "place-session",
          lineage: "lineage-session-place",
          origin: "generated",
          protection: "none",
          seed: "place-structural-seed",
          appearanceSeed: "place-appearance-seed",
          landmarkGrammarId: "hero-tower-plaza",
          paletteId: null,
          sitePolygon: [
            { x: 0, y: 0 },
            { x: 8, y: 0 },
            { x: 8, y: 8 },
            { x: 0, y: 8 }
          ],
          placement: { centre: { x: 4, y: 4 }, rotationRad: 0, widthM: 8, depthM: 8 },
          districtId: null,
          blockId: null
        }],
        overrides: [{
          targetKind: "building",
          targetId: "bldg-session",
          lineage: "lineage-session-building",
          protection: "manual-edit",
          snapshotSitePolygon: [
            { x: -8, y: -8 },
            { x: 0, y: -8 },
            { x: 0, y: 0 },
            { x: -8, y: 0 }
          ],
          appearanceSeed: "override-appearance-seed",
          paletteId: "corporate"
        }]
      }
    }
  };
}

function supported(value: CityStateV4): CityLoadResult {
  return { kind: "supported", state: value };
}

function createSession(): TerrainSession {
  const session = new TerrainSession();
  session.reset({ kind: "absent" });
  session.publishCreation(state(1));
  return session;
}

describe("TerrainSession", () => {
  it("rejects stale revisions and same-revision local epochs independently", () => {
    expect(terrainBuildIsCurrent(4, 9, 4, 9)).toBe(true);
    expect(terrainBuildIsCurrent(3, 9, 4, 9)).toBe(false);
    expect(terrainBuildIsCurrent(4, 8, 4, 9)).toBe(false);
    expect(terrainBuildIsCurrent(4, 9, null, 9)).toBe(false);
  });

  it("resets to a discriminated load status and exposes an empty history", () => {
    const session = new TerrainSession();
    session.reset({ kind: "legacy", raw: { formatVersion: 4 } });
    expect(session.status).toEqual({ kind: "legacy", raw: { formatVersion: 4 } });
    expect(session.current).toBeNull();
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
    expect(session.historyDepth).toBe(0);
  });

  it("treats an obsolete-precomplete load as read-only until the flag is cleared", () => {
    const session = new TerrainSession();
    session.reset({
      kind: "obsolete-precomplete",
      raw: { kind: "city-generator-2", schemaVersion: 3, generatorVersion: 10, revision: 6 },
      schemaVersion: 3,
      generatorVersion: 10,
      revision: 6
    });
    expect(session.status).toMatchObject({ kind: "obsolete-precomplete", revision: 6 });
    expect(session.current).toBeNull();
    expect(session.canUndo).toBe(false);
    expect(session.historyDepth).toBe(0);
    expect(() => session.publishCreation(state(1))).toThrow(/cleared/i);
    expect(session.current).toBeNull();
    expect(session.historyDepth).toBe(0);
  });

  it("supports the post-clear history baseline: reset to absent then creation with an empty history", () => {
    const session = new TerrainSession();
    session.reset({ kind: "obsolete-precomplete", raw: {}, schemaVersion: 2, generatorVersion: 9, revision: 3 });
    const before = { epoch: session.buildEpoch, draft: session.draftVersion };
    session.reset({ kind: "absent" });
    session.publishCreation(state(1));
    expect(session.current?.revision).toBe(1);
    expect(session.status.kind).toBe("supported");
    expect(session.historyDepth).toBe(0);
    expect(session.canUndo).toBe(false);
    expect(session.buildEpoch).toBeGreaterThan(before.epoch);
    expect(session.draftVersion).toBeGreaterThan(before.draft);
  });

  it("refuses direct creation over legacy data without a clear", () => {
    const session = new TerrainSession();
    session.reset({ kind: "legacy", raw: { formatVersion: 4 } });
    expect(() => session.publishCreation(state(1))).toThrow(/cleared/i);
    expect(session.current).toBeNull();
    expect(session.historyDepth).toBe(0);
  });

  it("publishes creation only after a successful save and starts at revision 1", () => {
    const session = new TerrainSession();
    session.reset({ kind: "absent" });
    const before = { epoch: session.buildEpoch, draft: session.draftVersion };
    const candidate = state(1);
    session.publishCreation(candidate);
    expect(session.current?.revision).toBe(1);
    expect(session.status.kind).toBe("supported");
    expect(session.historyDepth).toBe(0);
    expect(session.buildEpoch).toBe(before.epoch + 1);
    expect(session.draftVersion).toBe(before.draft + 1);

    candidate.source.citySeed = "mutated-after-publication";
    candidate.source.architecture.buildings[0]!.heightM = 999;
    candidate.source.architecture.places[0]!.appearanceSeed = "mutated-after-publication";
    candidate.source.architecture.overrides[0]!.paletteId = "mutated-after-publication";
    expect(session.current?.source.citySeed).toBe("session-seed");
    expect(session.current?.source.architecture.buildings[0]!.heightM).toBe(30);
    expect(session.current?.source.architecture.places[0]!.appearanceSeed).toBe("place-appearance-seed");
    expect(session.current?.source.architecture.overrides[0]!.paletteId).toBe("corporate");
  });
  it("preserves architecture snapshots across commit, undo, and redo", () => {
    const session = createSession();
    const committed = state(2, "committed-session-seed");
    committed.source.architecture.buildings[0]!.heightM = 42;
    committed.source.architecture.places[0]!.appearanceSeed = "committed-place-appearance";
    committed.source.architecture.overrides[0]!.paletteId = "market";
    const initialArchitecture = state(1).source.architecture;
    const committedArchitecture = structuredClone(committed.source.architecture);

    session.publishCommit(committed);
    expect(session.current?.source.architecture).toEqual(committedArchitecture);
    expect(session.undoTarget?.source.architecture).toEqual(initialArchitecture);

    session.publishUndo(session.undoTarget!);
    expect(session.current?.source.architecture).toEqual(initialArchitecture);
    expect(session.redoTarget?.source.architecture).toEqual(committedArchitecture);

    session.publishRedo(session.redoTarget!);
    expect(session.current?.source.architecture).toEqual(committedArchitecture);
  });


  it("leaves state, history, and epochs unchanged when a failed save is not published", () => {
    const session = createSession();
    const before = {
      current: session.current,
      epoch: session.buildEpoch,
      draft: session.draftVersion,
      depth: session.historyDepth
    };
    // The caller invokes publishCommit only after saveCityState resolves.
    expect(() => session.publishCommit(state(1))).toThrow(/revision/i);
    expect(before.current?.revision).toBe(1);
    expect(session.current).toEqual(before.current);
    expect(session.buildEpoch).toBe(before.epoch);
    expect(session.draftVersion).toBe(before.draft);
    expect(session.historyDepth).toBe(before.depth);
  });

  it("increments one revision per commit and rewrites history targets", () => {
    const session = createSession();
    session.publishCommit(state(2));
    expect(session.current?.revision).toBe(2);
    expect(session.historyDepth).toBe(1);
    expect(session.undoTarget?.revision).toBe(3);
    expect(session.undoTarget?.source.citySeed).toBe("session-seed");
  });

  it("publishes undo transactionally and exposes a rewritten redo target", () => {
    const session = createSession();
    session.publishCommit(state(2));
    const target = session.undoTarget!;
    session.publishUndo(target);
    expect(session.current?.revision).toBe(3);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(true);
    expect(session.redoTarget?.revision).toBe(4);
    expect(session.redoTarget?.source.citySeed).toBe("session-seed");
  });

  it("publishes redo transactionally and rejects mismatched history targets", () => {
    const session = createSession();
    session.publishCommit(state(2));
    const undo = session.undoTarget!;
    session.publishUndo(undo);
    const redo = session.redoTarget!;
    const wrong = { ...redo, source: { ...redo.source, citySeed: "wrong" } };
    expect(() => session.publishRedo(wrong)).toThrow(/target/i);
    expect(session.current?.revision).toBe(3);
    expect(session.historyDepth).toBe(0);
    session.publishRedo(redo);
    expect(session.current?.revision).toBe(4);
    expect(session.historyDepth).toBe(1);
  });

  it("adopts only a newer supported external revision and clears session state", () => {
    const session = createSession();
    session.publishCommit(state(2));
    const beforeEpoch = session.buildEpoch;
    const beforeDraft = session.draftVersion;
    expect(session.adoptExternal(supported(state(2)))).toBe(false);
    expect(session.adoptExternal(supported(state(1)))).toBe(false);
    expect(session.current?.revision).toBe(2);
    expect(session.adoptExternal(supported(state(7, "external")))).toBe(true);
    expect(session.current?.revision).toBe(7);
    expect(session.current?.source.citySeed).toBe("external");
    expect(session.historyDepth).toBe(0);
    expect(session.buildEpoch).toBe(beforeEpoch + 1);
    expect(session.draftVersion).toBe(beforeDraft + 1);
    expect(session.adoptExternal({ kind: "malformed", raw: {}, reason: "bad" })).toBe(false);
  });

  it("invalidates render inputs at the same revision without changing drafts", () => {
    const session = createSession();
    const epoch = session.buildEpoch;
    const draft = session.draftVersion;
    session.invalidateRenderInputs();
    expect(session.buildEpoch).toBe(epoch + 1);
    expect(session.draftVersion).toBe(draft);
    expect(session.current?.revision).toBe(1);
  });
});

describe("TerrainActionQueue", () => {
  it("serializes source actions and continues after a rejected action", async () => {
    const queue = new TerrainActionQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
      throw new Error("rejected");
    });
    const second = queue.run(async () => {
      events.push("second");
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    release();
    await expect(first).rejects.toThrow("rejected");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});
