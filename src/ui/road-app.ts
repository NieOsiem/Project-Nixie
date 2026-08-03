import {
  addCityListener,
  canRedo,
  canUndo,
  cityLoadStatus,
  clearRoadSelection,
  deleteRoadJunction,
  deleteRoads,
  generateRoads,
  getCity,
  getRoadSelection,
  isSceneEnabled,
  renameRoad,
  reclassifyRoad,
  roadGridSnapEnabled,
  roadInspector,
  setRoadCurvePreset,
  setRoadGridSnap,
  setRoadLocked,
  redo,
  undo
} from "../adapter/canvas.js";
import type { RouteClassId } from "../core/gen/city.js";
import {
  activateRoadTool,
  cancelRoadDraft,
  configureRoadDraft,
  finishRoadDraft,
  hasRoadDraft,
  ROAD_TOOL
} from "./road-layer.js";

function applicationBase(): any {
  return foundry?.applications?.api?.ApplicationV2 ?? null;
}

function statusKind(status: any): string {
  if (typeof status === "string") return status;
  return status?.kind ?? status?.status ?? status?.type ?? "malformed";
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface RoadGenerationAvailability {
  enabled: boolean;
  reason: string;
  roadCount: number;
}

export function allRoadEdgeIds(city: any): string[] {
  return Array.isArray(city?.source?.roads?.edges)
    ? city.source.roads.edges.map((edge: any) => edge.id).filter((id: unknown): id is string => typeof id === "string")
    : [];
}

export function roadGenerationAvailability(kind: string, sceneEnabled: boolean, city: any): RoadGenerationAvailability {
  if (kind !== "supported" || !sceneEnabled) return { enabled: false, reason: "Enable Nixie on this Scene first.", roadCount: 0 };
  if (city === null || city === undefined) return { enabled: false, reason: "Create a rectangle or coastal terrain first.", roadCount: 0 };
  const roadCount = allRoadEdgeIds(city).length;
  if (roadCount > 0) return { enabled: false, reason: `This Scene already has ${roadCount} road segment${roadCount === 1 ? "" : "s"}. Delete them before generating an initial network.`, roadCount };
  return { enabled: true, reason: "Terrain is ready. Generate the initial network once, then edit it in Roads.", roadCount: 0 };
}

export function roadSelectionActionsEnabled(editorEnabled: boolean, edgeCount: number): boolean {
  return editorEnabled && edgeCount > 0;
}

export function roadGenerationActionsHTML(generation: RoadGenerationAvailability, editorEnabled: boolean): string {
  return `<div class="form-footer"><button type="button" data-action="generate-roads"${generation.enabled ? "" : " disabled"}>Generate initial roads</button><button type="button" data-action="delete-all-roads"${editorEnabled && generation.roadCount > 0 ? "" : " disabled"}>Delete all roads</button></div>`;
}

function selected(value: string, current: string): string {
  return value === current ? " selected" : "";
}

function checked(value: boolean): string {
  return value ? " checked" : "";
}

let cached: any = null;

function roadAppClass(): any {
  if (cached !== null) return cached;
  const Base = applicationBase();
  if (!Base) throw new Error("ApplicationV2 is unavailable — Foundry's application API moved.");

  cached = class NixieRoadApp extends Base {
    static DEFAULT_OPTIONS = {
      id: "nixie-roads",
      classes: ["nixie-roads"],
      window: { title: "Nixie: Roads", icon: "fa-solid fa-road", resizable: true },
      position: { width: 520, height: "auto" }
    };

    #status: any = { kind: "malformed" };
    #roadClass: RouteClassId = "street";
    #curvePreset: "tight" | "standard" | "broad" = "standard";
    #roadLayout: "european" | "grid" | "mixed" = "european";
    #hubMode: "single-centre" | "multiple-hubs" = "single-centre";
    #roadName = "";
    #roadScope: "segment" | "contiguous-name" = "segment";
    #notice: { kind: "info" | "success" | "error"; text: string } | null = null;

    _canRender(): void {
      if (!game.user?.isGM) throw new Error("Nixie: the Roads editor is GM-only.");
    }

    async _prepareContext(_options: any): Promise<Record<string, never>> {
      this.#status = cityLoadStatus();
      return {};
    }

    async _renderHTML(): Promise<string> {
      return this.#html();
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
    }

    #run(label: string, work: Promise<unknown>, then?: () => void): void {
      void work.then(() => {
        this.#notice = { kind: "success", text: `${label} completed.` };
        then?.();
        void this.render({ force: true });
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`nixie | ${label} failed`, err);
        this.#notice = { kind: "error", text: `${label} failed — ${message}` };
        ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
        void this.render({ force: true });
      });
    }

    async _onClose(options: any): Promise<void> {
      cancelRoadDraft();
      clearRoadSelection();
      const parent = Base.prototype._onClose;
      if (typeof parent === "function") await parent.call(this, options);
    }

    #html(): string {
      const kind = statusKind(this.#status);
      const sceneEnabled = isSceneEnabled();
      const enabled = kind === "supported" && sceneEnabled;
      const city = getCity();
      const generation = roadGenerationAvailability(kind, sceneEnabled, city);
      const selection = getRoadSelection();
      const inspection = roadInspector();
      const selectionActionsEnabled = roadSelectionActionsEnabled(enabled, selection.edgeIds.length);
      let message = sceneEnabled ? "Generate or edit the road network for this Scene." : "Enable Nixie on this Scene before editing roads.";
      if (kind === "unsupported") message = "This Scene contains an unsupported City Generator 2.0 schema. Road editing is unavailable.";
      else if (kind === "malformed") message = "The City Generator 2.0 data is malformed. Road editing is unavailable until it is repaired.";
      const classes = ["highway", "arterial", "street", "narrow", "lane", "alley", "pedestrian-path", "park-path", "plaza-route", "public-passage", "waterfront-promenade", "cycleway"];
      const classOptions = classes.map((id) => `<option value="${id}"${id === this.#roadClass ? " selected" : ""}>${id.replaceAll("-", " ")}</option>`).join("");
      const inspectorHTML = selection.nodeIds.length > 0
        ? `<p><strong>Selected junction:</strong> ${selection.nodeIds.map(escapeHTML).join(", ")}</p>`
        : inspection === null
          ? "<p><strong>Selection:</strong> none. Use Select, then click a road.</p>"
          : `<p><strong>Selected road${inspection.edgeIds.length === 1 ? "" : "s"}:</strong> ${inspection.edgeIds.map(escapeHTML).join(", ")}</p><p>Origin: ${inspection.origin}; Class: ${inspection.classId}; Name: ${inspection.name === null ? "(unnamed)" : escapeHTML(String(inspection.name))}; Lock: ${inspection.locked}; Curve: ${inspection.curvePreset}</p>`;
      const activeTool = (tool: string): string => game?.activeTool === tool ? " active" : "";
      const generationHTML = `<section data-panel="generation"><h2>Generate initial roads</h2><p>Generate once after creating terrain. Single centre makes one central hub; multiple hubs creates several connected centres.</p><div class="form-group"><label>Road layout</label><div class="form-fields"><select data-field="road-layout"${enabled ? "" : " disabled"}><option value="european"${selected("european", this.#roadLayout)}>European</option><option value="grid"${selected("grid", this.#roadLayout)}>Grid</option><option value="mixed"${selected("mixed", this.#roadLayout)}>Mixed</option></select></div></div><div class="form-group"><label>Hub mode</label><div class="form-fields"><select data-field="hub-mode"${enabled ? "" : " disabled"}><option value="single-centre"${selected("single-centre", this.#hubMode)}>Single centre</option><option value="multiple-hubs"${selected("multiple-hubs", this.#hubMode)}>Multiple hubs</option></select></div></div><div data-status="road-generation" data-status-kind="${generation.enabled ? "success" : "info"}"><p>${escapeHTML(generation.reason)}</p>${roadGenerationActionsHTML(generation, enabled)}</div></section>`;
      const roadsHTML = `<section data-panel="roads"><h2>Road tools</h2><p>Draw: click anchors, click an endpoint or segment to connect, double-click to finish, right-click to backtrack. Select: click a segment; Shift-click adds. Edit / Junction: drag anchors or weld by dropping on another anchor.</p><div class="form-footer"><button type="button" data-action="road-tool" data-tool="${ROAD_TOOL.SELECT}" class="tool${activeTool(ROAD_TOOL.SELECT)}"${enabled ? "" : " disabled"}>Select</button><button type="button" data-action="road-tool" data-tool="${ROAD_TOOL.DRAW}" class="tool${activeTool(ROAD_TOOL.DRAW)}"${enabled ? "" : " disabled"}>Draw</button><button type="button" data-action="road-tool" data-tool="${ROAD_TOOL.EDIT}" class="tool${activeTool(ROAD_TOOL.EDIT)}"${enabled ? "" : " disabled"}>Edit / Junction</button></div>${inspectorHTML}<p>For multi-selection, class and name apply to the selected segments only. Curve applies to every route represented by the selected segments.</p><div class="form-group"><label>Route class</label><div class="form-fields"><select data-field="road-class"${enabled ? "" : " disabled"}>${classOptions}</select></div></div><div class="form-group"><label>Curve preset (selected routes)</label><div class="form-fields"><select data-field="curve-preset"${enabled ? "" : " disabled"}><option value="tight"${selected("tight", this.#curvePreset)}>Tight</option><option value="standard"${selected("standard", this.#curvePreset)}>Standard</option><option value="broad"${selected("broad", this.#curvePreset)}>Broad</option></select></div></div><div class="form-group"><label>Street name</label><div class="form-fields"><input type="text" data-field="road-name" value="${escapeHTML(this.#roadName)}"${enabled ? "" : " disabled"}></div></div><div class="form-group"><label>Name/class scope</label><div class="form-fields"><select data-field="road-scope"${enabled ? "" : " disabled"}><option value="segment"${selected("segment", this.#roadScope)}>Selected segment(s)</option><option value="contiguous-name"${selected("contiguous-name", this.#roadScope)}>Contiguous same-name route (single selection)</option></select></div></div><label><input type="checkbox" data-field="grid-snap"${checked(roadGridSnapEnabled())}${enabled ? "" : " disabled"}> Snap road anchors to Foundry grid</label><div class="form-footer"><button type="button" data-action="road-finish"${hasRoadDraft() ? "" : " disabled"}>Finish road</button><button type="button" data-action="road-cancel"${hasRoadDraft() ? "" : " disabled"}>Cancel road</button><button type="button" data-action="road-clear"${selection.edgeIds.length > 0 || selection.nodeIds.length > 0 ? "" : " disabled"}>Clear selection</button></div><div class="form-footer"><button type="button" data-action="road-lock"${selectionActionsEnabled ? "" : " disabled"}>Lock selection</button><button type="button" data-action="road-unlock"${selectionActionsEnabled ? "" : " disabled"}>Unlock selection</button><button type="button" data-action="road-delete"${selectionActionsEnabled ? "" : " disabled"}>Delete roads</button><button type="button" data-action="road-delete-junction"${enabled && selection.nodeIds.length === 1 ? "" : " disabled"}>Delete junction</button></div><div class="form-footer"><button type="button" data-action="road-classify"${selectionActionsEnabled ? "" : " disabled"}>Apply class</button><button type="button" data-action="road-curve"${selectionActionsEnabled ? "" : " disabled"}>Apply curve</button><button type="button" data-action="road-rename"${selectionActionsEnabled ? "" : " disabled"}>Apply name</button></div><div class="form-footer"><button type="button" data-action="undo"${enabled && canUndo() ? "" : " disabled"}>Undo</button><button type="button" data-action="redo"${enabled && canRedo() ? "" : " disabled"}>Redo</button></div></section>`;
      const noticeHTML = this.#notice === null ? "" : `<div data-status="operation" data-status-kind="${this.#notice.kind}"><strong>${this.#notice.kind === "error" ? "Error" : this.#notice.kind === "success" ? "Done" : "Status"}:</strong> ${escapeHTML(this.#notice.text)}</div>`;
      return `<p data-status="scene" data-status-kind="${kind}">${escapeHTML(message)}</p>${noticeHTML}${generationHTML}${roadsHTML}`;
    }

    _onRender(): void {
      const root = this.element as HTMLElement;
      root.querySelector('[data-field="road-class"]')?.addEventListener("change", (event: Event) => {
        this.#roadClass = (event.target as HTMLSelectElement).value as RouteClassId;
        configureRoadDraft({ classId: this.#roadClass });
      });
      root.querySelector('[data-field="curve-preset"]')?.addEventListener("change", (event: Event) => {
        this.#curvePreset = (event.target as HTMLSelectElement).value as "tight" | "standard" | "broad";
        configureRoadDraft({ curvePreset: this.#curvePreset });
      });
      root.querySelector('[data-field="road-name"]')?.addEventListener("input", (event: Event) => {
        this.#roadName = (event.target as HTMLInputElement).value;
        configureRoadDraft({ name: this.#roadName.trim() || null });
      });
      root.querySelector('[data-field="road-scope"]')?.addEventListener("change", (event: Event) => {
        this.#roadScope = (event.target as HTMLSelectElement).value as "segment" | "contiguous-name";
      });
      root.querySelector('[data-field="road-layout"]')?.addEventListener("change", (event: Event) => {
        this.#roadLayout = (event.target as HTMLSelectElement).value as "european" | "grid" | "mixed";
      });
      root.querySelector('[data-field="hub-mode"]')?.addEventListener("change", (event: Event) => {
        this.#hubMode = (event.target as HTMLSelectElement).value as "single-centre" | "multiple-hubs";
      });
      root.querySelector('[data-field="grid-snap"]')?.addEventListener("change", (event: Event) => {
        setRoadGridSnap((event.target as HTMLInputElement).checked);
      });
    }

    _onClickAction(_event: PointerEvent, target: HTMLElement): void {
      const action = target.closest<HTMLElement>("[data-action]") ?? target;
      switch (action.dataset.action) {
        case "generate-roads":
          this.#run("road generation", generateRoads(this.#roadLayout, this.#hubMode));
          return;
        case "delete-all-roads":
          this.#run("delete all roads", deleteRoads(allRoadEdgeIds(getCity())));
          return;
        case "road-tool":
          activateRoadTool(action.dataset.tool as typeof ROAD_TOOL[keyof typeof ROAD_TOOL]);
          if (action.dataset.tool === ROAD_TOOL.DRAW) configureRoadDraft({ classId: this.#roadClass, curvePreset: this.#curvePreset, name: this.#roadName.trim() || null });
          return;
        case "road-finish":
          this.#run("road draft", finishRoadDraft());
          return;
        case "road-cancel":
          cancelRoadDraft();
          void this.render({ force: true });
          return;
        case "road-lock":
          this.#run("road lock", setRoadLocked(true));
          return;
        case "road-unlock":
          this.#run("road unlock", setRoadLocked(false));
          return;
        case "road-delete":
          this.#run("road deletion", deleteRoads());
          return;
        case "road-clear":
          clearRoadSelection();
          this.#notice = { kind: "info", text: "Road selection cleared." };
          void this.render({ force: true });
          return;
        case "road-delete-junction":
          this.#run("junction deletion", deleteRoadJunction(getRoadSelection().nodeIds[0]!));
          return;
        case "road-classify":
          this.#run("road class", reclassifyRoad(this.#roadClass, this.#roadScope === "contiguous-name"));
          return;
        case "road-curve":
          this.#run("road curve", setRoadCurvePreset(this.#curvePreset, getRoadSelection().edgeIds));
          return;
        case "road-rename":
          this.#run("road rename", renameRoad(this.#roadName.trim() || null, this.#roadScope === "contiguous-name"));
          return;
        case "undo":
          this.#run("undo", undo());
          return;
        case "redo":
          this.#run("redo", redo());
          return;
        default:
          return;
      }
    }
  };
  return cached;
}

let instance: any = null;
let listening = false;

export function openRoadApp(): void {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Nixie: the Roads editor is GM-only.");
    return;
  }
  instance ??= new (roadAppClass())();
  if (!listening) {
    listening = true;
    addCityListener(() => {
      if (instance?.rendered === true) void instance.render({ force: true });
    });
  }
  if (instance.rendered === true) {
    void instance.render({ force: true });
    instance.bringToFront();
    return;
  }
  void instance.render({ force: true });
}
