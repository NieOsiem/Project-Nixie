/**
 * Undo/redo over whole immutable snapshots.
 *
 * Snapshots rather than inverse operations: a city's params are small enough that
 * storing fifty copies is cheaper than getting every edit's inverse right, and an
 * edit that planarises the graph has no clean inverse anyway.
 */
export class History<T> {
  #past: T[] = [];
  #future: T[] = [];
  readonly #limit: number;

  constructor(limit = 50) {
    this.#limit = Math.max(1, limit);
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  get depth(): number {
    return this.#past.length;
  }

  get undoTarget(): T | null {
    return this.#past.at(-1) ?? null;
  }

  get redoTarget(): T | null {
    return this.#future.at(-1) ?? null;
  }

  /** Record the state being replaced. Discards any redo branch. */
  push(previous: T): void {
    this.#past.push(previous);
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future.length = 0;
  }

  undo(current: T): T | null {
    const previous = this.#past.pop();
    if (previous === undefined) return null;
    this.#future.push(current);
    return previous;
  }

  redo(current: T): T | null {
    const next = this.#future.pop();
    if (next === undefined) return null;
    this.#past.push(current);
    return next;
  }

  clear(): void {
    this.#past.length = 0;
    this.#future.length = 0;
  }
}
