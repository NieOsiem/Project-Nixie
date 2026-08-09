import { describe, expect, it } from "vitest";
import { diagnosticsTrayHTML } from "./diagnostics.js";

describe("Diagnostics workspace", () => {
  it("retains degraded wall diagnostics with a retry action", () => {
    const html = diagnosticsTrayHTML([{ subsystem: "walls", retry: "walls", message: "Wall replacement failed." }]);
    expect(html).toContain("Wall replacement failed.");
    expect(html).toContain('data-action="diagnostics-retry-walls"');
  });

  it("renders the empty state", () => {
    expect(diagnosticsTrayHTML([])).toContain("No diagnostics recorded");
  });
});
