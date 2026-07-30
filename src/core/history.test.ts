import { describe, expect, it } from "vitest";
import { History } from "./history.js";

describe("History", () => {
  it("starts with nothing to undo or redo", () => {
    const h = new History<string>();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo("a")).toBeNull();
    expect(h.redo("a")).toBeNull();
  });

  it("walks back and forward through pushed states", () => {
    const h = new History<string>();
    h.push("a");
    h.push("b");
    expect(h.undo("c")).toBe("b");
    expect(h.undo("b")).toBe("a");
    expect(h.canUndo).toBe(false);
    expect(h.redo("a")).toBe("b");
    expect(h.redo("b")).toBe("c");
    expect(h.canRedo).toBe(false);
  });

  it("discards the redo branch when a new state is pushed", () => {
    const h = new History<string>();
    h.push("a");
    h.undo("b");
    expect(h.canRedo).toBe(true);
    h.push("a");
    expect(h.canRedo).toBe(false);
  });

  it("drops the oldest state past the limit", () => {
    const h = new History<number>(2);
    h.push(1);
    h.push(2);
    h.push(3);
    expect(h.depth).toBe(2);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.canUndo).toBe(false);
  });

  it("clears both directions", () => {
    const h = new History<string>();
    h.push("a");
    h.undo("b");
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});
