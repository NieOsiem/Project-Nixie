import { describe, expect, it } from "vitest";
import { roadSelectionActionsEnabled } from "./roads.js";

describe("Roads workspace selection actions", () => {
  it("keeps road actions enabled for a multi-selection", () => {
    expect(roadSelectionActionsEnabled(true, 2)).toBe(true);
    expect(roadSelectionActionsEnabled(true, 0)).toBe(false);
    expect(roadSelectionActionsEnabled(false, 2)).toBe(false);
  });
});
