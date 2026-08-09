import { describe, expect, it, vi } from "vitest";
import { WallReplacementScheduler, wallSegmentsForPlan } from "./generated-walls.js";
import type { DistrictPlan } from "../core/gen/district-plan.js";

function plan(): DistrictPlan {
  return {
    revisionInputs: { terrain: "terrain", roads: "roads", districts: "districts", generation: "generation" },
    blocks: [],
    developmentCells: [],
    openSpaceIntents: [],
    unzoned: [],
    wallCells: [[[
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }
    ]]],
    diagnostics: { faceCount: 0, blockCount: 0, fragmentCount: 0, developmentCellCount: 0, discardedFaceCount: 0, discardedCellCount: 0, warnings: [] }
  };
}

describe("generated wall adapter", () => {
  it("simplifies metre cells before converting and emits integer world endpoints", () => {
    expect(wallSegmentsForPlan(plan(), { x: 100, y: 200 }, 10)).toEqual([
      { x1: 100, y1: 200, x2: 140, y2: 200 },
      { x1: 140, y1: 200, x2: 140, y2: 230 },
      { x1: 140, y1: 230, x2: 100, y2: 230 },
      { x1: 100, y1: 230, x2: 100, y2: 200 }
    ]);
  });

  it("debounces latest work, serializes in-flight replacement, and awaits retry work", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new WallReplacementScheduler();
      const events: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = scheduler.runNow(async (token) => {
        await gate;
        if (token === scheduler.token) events.push("stale-first");
      });
      scheduler.schedule(async (token) => {
        if (token === scheduler.token) events.push("latest");
      }, 400);
      release();
      await first;
      await vi.advanceTimersByTimeAsync(400);
      expect(events).toEqual(["latest"]);

      let retryDone = false;
      let retryRelease!: () => void;
      const retryGate = new Promise<void>((resolve) => { retryRelease = resolve; });
      const retry = scheduler.runNow(async () => { await retryGate; });
      retry.then(() => { retryDone = true; });
      await Promise.resolve();
      expect(retryDone).toBe(false);
      retryRelease();
      await retry;
      expect(retryDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

});
