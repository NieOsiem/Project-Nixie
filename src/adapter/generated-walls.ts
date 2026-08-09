import { wallSegmentsFromMetreCells, type WallSegment } from "../core/gen/walls.js";
import type { DistrictPlan } from "../core/gen/district-plan.js";
import type { Vec2 } from "../core/geom/types.js";

export function wallSegmentsForPlan(plan: DistrictPlan, origin: Vec2, pixelsPerMetre: number): WallSegment[] {
  if (!Number.isFinite(pixelsPerMetre) || pixelsPerMetre <= 0) throw new Error("Pixels per metre must be positive.");
  return wallSegmentsFromMetreCells(plan.wallCells, { origin, pixelsPerMetre, toleranceM: 1 });
}

export class WallReplacementScheduler {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #tail: Promise<void> = Promise.resolve();
  #token = 0;

  get token(): number {
    return this.#token;
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#token++;
  }

  schedule(task: (token: number) => Promise<void>, delayMs = 400): number {
    this.cancel();
    const token = this.#token;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#enqueue(task, token);
    }, delayMs);
    return token;
  }

  runNow(task: (token: number) => Promise<void>): Promise<void> {
    this.cancel();
    const token = this.#token;
    return this.#enqueue(task, token);
  }

  #enqueue(task: (token: number) => Promise<void>, token: number): Promise<void> {
    const run = this.#tail.then(() => token === this.#token ? task(token) : undefined);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
