import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { BLOCK_GRAMMAR_IDS } from "../../core/gen/district-registry.js";
import { DISTRICT_TYPE_IDS } from "../editor-state.js";
import { allDistrictIds, districtEmptyTrayHTML, districtGalleryHTML, districtGalleryPreviews, districtGenerationAvailability, districtInspectorControlState, districtOverrideInputProblems, districtSeedDisclosureHTML, districtsWorkspace } from "./districts.js";
import type { WorkspaceContext } from "./types.js";

const adapterMocks = vi.hoisted(() => ({
  cityLoadStatus: vi.fn(() => ({ kind: "supported" })),
  clearDistrictSelection: vi.fn(),
  deleteDistricts: vi.fn(() => Promise.resolve({})),
  districtDiagnostics: vi.fn(() => [] as Array<Record<string, unknown>>),
  districtInspector: vi.fn<() => unknown>(() => null),
  districtSnapOptions: vi.fn(() => ({ districtVertices: true, roadJunctions: true, blockBoundaries: true, foundryGrid: false })),
  generateDistricts: vi.fn(() => Promise.resolve({})),
  getCity: vi.fn<() => unknown>(() => null),
  getDistrictPlan: vi.fn(() => null),
  getDistrictSelection: vi.fn(() => [] as string[]),
  isSceneEnabled: vi.fn(() => true),
  mergeDistricts: vi.fn(() => Promise.resolve({})),
  retryGeneratedWalls: vi.fn(() => Promise.resolve(undefined)),
  setDistrictSnapOptions: vi.fn(),
  updateDistricts: vi.fn((_ids: readonly string[], _patch: unknown) => Promise.resolve({}))
}));
const districtLayerMocks = vi.hoisted(() => ({
  cancelDistrictDraft: vi.fn(),
  cancelDistrictInteraction: vi.fn(),
  finishDistrictDraft: vi.fn(() => Promise.resolve(true)),
  hasDistrictDraft: vi.fn(() => false)
}));

vi.mock("../../adapter/canvas.js", () => adapterMocks);
vi.mock("../district-layer.js", () => districtLayerMocks);

function fakeCtx(): WorkspaceContext {
  return { rerender: vi.fn(), run: vi.fn() as unknown as WorkspaceContext["run"] };
}

function setupSelection(ids = ["d-1"]): void {
  adapterMocks.getDistrictSelection.mockReturnValue(ids);
  adapterMocks.getCity.mockReturnValue({ source: { districts: ids.map((id) => ({ id })), roads: { edges: [{ classId: "street" }] } } });
  adapterMocks.districtInspector.mockReturnValue({ id: ids[0], seed: "seed-a", typeId: "corporate-core", paletteId: "corporate", locked: false, openSpaceOverride: null });
  adapterMocks.cityLoadStatus.mockReturnValue({ kind: "supported" });
  adapterMocks.isSceneEnabled.mockReturnValue(true);
  adapterMocks.districtDiagnostics.mockReturnValue([]);
}

type FakeControl = {
  listener?: (event: Event) => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
};

function fakeInspectorRoot(): { root: unknown; control: (selector: string) => FakeControl } {
  const controls = new Map<string, FakeControl>();
  const control = (selector: string): FakeControl => {
    const existing = controls.get(selector);
    if (existing !== undefined) return existing;
    const created: FakeControl = {
      addEventListener(type: string, listener: (event: Event) => void): void {
        if (type === "change" || type === "input") created.listener = listener;
      }
    };
    controls.set(selector, created);
    return created;
  };
  // WHY: absent selectors must return null like the real DOM so optional-chained
  // wiring and staged-override validation behave as they do against live markup.
  return {
    root: {
      querySelector: (selector: string) => controls.get(selector) ?? null,
      querySelectorAll: () => []
    },
    control
  };
}

describe("Districts workspace seed regeneration disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSelection();
  });

  afterEach(() => {
    districtsWorkspace().onAction("district-reset", {} as HTMLElement, fakeCtx());
  });

  it("states the fixed seed disclosure content", () => {
    const html = districtSeedDisclosureHTML();
    expect(html).toContain('data-panel="district-seed-disclosure"');
    expect(html).toContain('role="note"');
    expect(html).toContain("district-wide regeneration");
    expect(html).toContain("Roads remain fixed");
    expect(html).toContain("Protected content and reserved sites are preserved");
    expect(html).toContain("newest district event");
    expect(html).toContain("without deleting their records");
    expect(html).toContain("no ignore option");
  });

  it("discloses the district-wide regeneration only once a seed change is staged", () => {
    const workspace = districtsWorkspace();
    expect(workspace.renderTray()).not.toContain("district-seed-disclosure");
    workspace.onAction("district-reroll-seed", {} as HTMLElement, fakeCtx());
    const html = workspace.renderTray();
    expect(html).toContain('data-panel="district-seed-disclosure"');
    expect(html).toContain('aria-label="District seed regeneration disclosure"');
  });

  it("routes a staged seed apply through the adapter preflight path as a disclosed district regeneration", () => {
    const workspace = districtsWorkspace();
    const ctx = fakeCtx();
    workspace.onAction("district-reroll-seed", {} as HTMLElement, ctx);
    workspace.onAction("district-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.updateDistricts).toHaveBeenCalledWith(["d-1"], expect.objectContaining({ seed: expect.stringContaining("seed-a/reroll/") }));
    expect(ctx.run).toHaveBeenCalledTimes(1);
    expect((ctx.run as Mock).mock.calls[0]![0]).toBe("district seed regeneration");
  });

  it("keeps non-seed applies on the plain district edit path", () => {
    const workspace = districtsWorkspace();
    const ctx = fakeCtx();
    const { root, control } = fakeInspectorRoot();
    const typeControl = control("[data-field=\"district-type\"]");
    workspace.renderTray();
    workspace.onRender(root as HTMLElement, ctx);
    typeControl.listener?.({ target: { value: "corporate-core" } } as unknown as Event);
    workspace.onAction("district-apply", {} as HTMLElement, ctx);
    expect(adapterMocks.updateDistricts).toHaveBeenCalledWith(["d-1"], expect.objectContaining({ typeId: "corporate-core" }));
    expect((ctx.run as Mock).mock.calls[0]![0]).toBe("district changes");
    expect(adapterMocks.updateDistricts.mock.calls[0]![1]).not.toHaveProperty("seed");
  });

  it("keeps regeneration blockers durable in the tray with affected IDs and no ignore action", () => {
    adapterMocks.districtDiagnostics.mockReturnValue([
      { subsystem: "regeneration", message: 'Blocker building "b-7": A protected building occupies a reserved site inside the target.', revision: 4 }
    ]);
    const html = districtsWorkspace().renderTray();
    expect(html).toContain("District diagnostics");
    expect(html).toContain("Blocker building &#34;b-7&#34;");
    expect(html).not.toMatch(/data-action="district-ignore"|combined unlock/i);
  });
});

describe("Districts workspace helpers", () => {
  it("requires a vehicle network and an empty district source", () => {
    expect(districtGenerationAvailability("supported", true, null).enabled).toBe(false);
    const city: any = { source: { roads: { edges: [] as any[] }, districts: [] as any[] } };
    expect(districtGenerationAvailability("supported", true, city).reason).toContain("vehicle road");
    city.source.roads.edges.push({ classId: "street" });
    expect(districtGenerationAvailability("supported", true, city).enabled).toBe(true);
    city.source.districts.push({ id: "d1" });
    expect(districtGenerationAvailability("supported", true, city).reason).toContain("already exist");
  });

  it("rejects an empty district pool", () => {
    const city = { source: { roads: { edges: [{ classId: "street" }] }, districts: [] } };
    expect(districtGenerationAvailability("supported", true, city, []).reason).toContain("at least one");
  });

  it("ships the fixed breadth IDs", () => {
    expect(DISTRICT_TYPE_IDS).toHaveLength(16);
    expect(new Set(DISTRICT_TYPE_IDS).size).toBe(16);
  });

  it("collects all district ids for the explicit destructive action", () => {
    expect(allDistrictIds({ source: { districts: [{ id: "b" }, { id: "a" }, { id: 4 }] } })).toEqual(["b", "a"]);
    expect(allDistrictIds(null)).toEqual([]);
    expect(districtEmptyTrayHTML()).toContain('data-action="district-delete-all"');
  });

  it("keeps the deterministic gallery broad across types and grammars", () => {
    const overview = districtGalleryPreviews("overview");
    const play = districtGalleryPreviews("play");
    expect(overview).toEqual(districtGalleryPreviews("overview"));
    expect(play).toEqual(districtGalleryPreviews("play"));
    expect(new Set(overview.map((entry) => entry.districtTypeId))).toEqual(new Set(DISTRICT_TYPE_IDS));
    expect(new Set(overview.map((entry) => entry.grammarId))).toEqual(new Set(BLOCK_GRAMMAR_IDS));
    expect(overview.every((entry) => entry.cellCount > 0 && entry.polygons.length === entry.cellCount)).toBe(true);
    expect(overview.every((entry, index) => entry.scale === 0.35 && play[index]?.scale === 1)).toBe(true);
  });

  it("renders the gallery as an in-tray, escaped, non-persistent view", () => {
    const html = districtGalleryHTML("overview");
    expect(html).toContain('data-panel="district-gallery"');
    expect(html).toContain('data-action="district-gallery-back"');
    expect(html).toContain('data-action="district-gallery-mode" data-mode="overview"');
    expect(html).toContain('data-action="district-gallery-mode" data-mode="play"');
    expect(html).toContain("No Scene data is changed.");
    expect(html).toContain("<svg");
    expect(html).toContain("aria-label=\"Corporate Core");
    expect(html).not.toContain("<script");
  });

  it("blocks Apply for malformed or invalid open-space overrides", () => {
    expect(districtOverrideInputProblems(0.3, "{", "{}")).toContain("Category weights must be valid JSON.");
    expect(districtOverrideInputProblems(0.3, "{}", "{}").length).toBeGreaterThan(0);
    expect(districtInspectorControlState(1, true, true, "explicit", undefined, true).applyEnabled).toBe(false);
  });
});
