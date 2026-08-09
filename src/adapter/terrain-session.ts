import type { CityLoadResult } from "./documents.js";
import type { CityStateV3 } from "../core/gen/city.js";
import { CITY_SCHEMA_VERSION, GENERATOR_VERSION } from "../constants.js";
import { History } from "../core/history.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function supported(result: CityLoadResult): result is Extract<CityLoadResult, { kind: "supported" }> {
  return result.kind === "supported";
}

function withoutRevision(state: CityStateV3): Omit<CityStateV3, "revision"> {
  const { revision: _revision, ...rest } = state;
  return rest;
}

function sameSource(a: CityStateV3, b: CityStateV3): boolean {
  return JSON.stringify(withoutRevision(a)) === JSON.stringify(withoutRevision(b));
}

function rewritten(state: CityStateV3, revision: number): CityStateV3 {
  return { ...copy(state), revision };
}

export function terrainBuildIsCurrent(
  sourceRevision: number,
  buildEpoch: number,
  currentRevision: number | null,
  currentEpoch: number
): boolean {
  return sourceRevision === currentRevision && buildEpoch === currentEpoch;
}

export class TerrainActionQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export class TerrainSession {
  #status: CityLoadResult = { kind: "absent" };
  #current: CityStateV3 | null = null;
  #history = new History<CityStateV3>();
  #buildEpoch = 0;
  #draftVersion = 0;

  get status(): CityLoadResult {
    return copy(this.#status);
  }

  get current(): CityStateV3 | null {
    return this.#current === null ? null : copy(this.#current);
  }

  get buildEpoch(): number {
    return this.#buildEpoch;
  }

  get draftVersion(): number {
    return this.#draftVersion;
  }

  get canUndo(): boolean {
    return this.#history.canUndo;
  }

  get canRedo(): boolean {
    return this.#history.canRedo;
  }

  get historyDepth(): number {
    return this.#history.depth;
  }

  reset(result: CityLoadResult): void {
    this.#status = copy(result);
    this.#current = supported(result) ? copy(result.state) : null;
    this.#history.clear();
    this.#buildEpoch++;
    this.#draftVersion++;
  }

  publishCreation(saved: CityStateV3): void {
    if (this.#status.kind !== "absent" && this.#status.kind !== "legacy") {
      throw new Error("City creation requires an absent or legacy Scene state.");
    }
    this.#assertSaved(saved, 1);
    this.#publish(saved);
  }

  publishCommit(saved: CityStateV3): void {
    const current = this.#requireCurrent();
    this.#assertSaved(saved, current.revision + 1);
    this.#history.push(copy(current));
    this.#publish(saved);
  }

  get undoTarget(): CityStateV3 | null {
    return this.#target(this.#history.undoTarget);
  }

  get redoTarget(): CityStateV3 | null {
    return this.#target(this.#history.redoTarget);
  }

  publishUndo(saved: CityStateV3): void {
    const current = this.#requireCurrent();
    const target = this.#history.undoTarget;
    if (target === null) throw new Error("Nothing to undo.");
    this.#assertSaved(saved, current.revision + 1);
    if (!sameSource(saved, target)) throw new Error("Undo target no longer matches history.");
    this.#history.undo(copy(current));
    this.#publish(saved);
  }

  publishRedo(saved: CityStateV3): void {
    const current = this.#requireCurrent();
    const target = this.#history.redoTarget;
    if (target === null) throw new Error("Nothing to redo.");
    this.#assertSaved(saved, current.revision + 1);
    if (!sameSource(saved, target)) throw new Error("Redo target no longer matches history.");
    this.#history.redo(copy(current));
    this.#publish(saved);
  }

  invalidateRenderInputs(): void {
    this.#buildEpoch++;
  }

  adoptExternal(result: CityLoadResult): boolean {
    if (!supported(result)) return false;
    if (this.#current !== null && result.state.revision <= this.#current.revision) return false;
    this.#status = copy(result);
    this.#current = copy(result.state);
    this.#history.clear();
    this.#buildEpoch++;
    this.#draftVersion++;
    return true;
  }

  #target(target: CityStateV3 | null): CityStateV3 | null {
    if (target === null || this.#current === null) return null;
    return rewritten(target, this.#current.revision + 1);
  }

  #requireCurrent(): CityStateV3 {
    if (this.#current === null) throw new Error("No supported city is loaded.");
    return this.#current;
  }

  #assertSaved(saved: CityStateV3, revision: number): void {
    if (
      saved.kind !== "city-generator-2" ||
      saved.schemaVersion !== CITY_SCHEMA_VERSION ||
      saved.generatorVersion !== GENERATOR_VERSION
    ) {
      throw new Error(`Saved state is not City Generator 2.0 schema ${CITY_SCHEMA_VERSION}.`);
    }
    if (!Number.isInteger(saved.revision) || saved.revision !== revision) {
      throw new Error(`Saved revision must be ${revision}.`);
    }
  }

  #publish(saved: CityStateV3): void {
    this.#current = copy(saved);
    this.#status = { kind: "supported", state: copy(saved) };
    this.#buildEpoch++;
    this.#draftVersion++;
  }
}
