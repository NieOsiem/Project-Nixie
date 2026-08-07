import {
  cityLoadStatus,
  clearRoadSelection,
  deleteRoadJunction,
  deleteRoads,
  getRoadSelection,
  isSceneEnabled,
  renameRoad,
  reclassifyRoad,
  roadGridSnapEnabled,
  roadInspector,
  setRoadCurvePreset,
  setRoadGridSnap,
  setRoadLocked
} from "../../adapter/canvas.js";
import { ROUTE_CLASS_IDS, type RouteClassId } from "../../core/gen/city.js";
import {
  canvasTool,
  currentCurvePreset,
  currentRoadClass,
  currentRoadName,
  currentRoadScope,
  ROAD_TOOL,
  setCanvasTool,
  setCurvePreset,
  setRoadClass,
  setRoadName,
  setRoadScope
} from "../editor-state.js";
import { cancelRoadDraft, configureRoadDraft, finishRoadDraft, hasRoadDraft } from "../road-layer.js";
import { checked, escapeHTML, selected, statusKind } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

export function roadSelectionActionsEnabled(editorEnabled: boolean, edgeCount: number): boolean {
  return editorEnabled && edgeCount > 0;
}

export function roadsWorkspace(): WorkspaceModule {
  return {
    id: "roads",

    renderShelf(): string {
      const kind = statusKind(cityLoadStatus());
      const enabled = kind === "supported" && isSceneEnabled();
      const gate = enabled ? "" : " disabled";
      const tool = canvasTool();
      const selection = getRoadSelection();
      const draft = hasRoadDraft();
      const active = (id: string): string => (tool === id ? " active" : "");
      const summary =
        selection.nodeIds.length > 0
          ? `${selection.nodeIds.length} junction${selection.nodeIds.length === 1 ? "" : "s"} selected`
          : selection.edgeIds.length > 0
            ? `${selection.edgeIds.length} road${selection.edgeIds.length === 1 ? "" : "s"} selected`
            : "";
      const drillIn =
        tool !== ROAD_TOOL.DRAW
          ? ""
          : `<div class="nixie-shelf-row">
        <label class="nixie-shelf-field">Class<select data-field="road-class"${gate}>${ROUTE_CLASS_IDS.map((id) => `<option value="${id}"${selected(id, currentRoadClass())}>${id.replaceAll("-", " ")}</option>`).join("")}</select></label>
        <label class="nixie-shelf-field">Curve<select data-field="curve-preset"${gate}><option value="tight"${selected("tight", currentCurvePreset())}>Tight</option><option value="standard"${selected("standard", currentCurvePreset())}>Standard</option><option value="broad"${selected("broad", currentCurvePreset())}>Broad</option></select></label>
        <label class="nixie-shelf-field"><input type="checkbox" data-field="grid-snap"${checked(roadGridSnapEnabled())}${gate}> Grid snap</label>
        <span class="nixie-shelf-sep"></span>
        <button type="button" data-action="road-finish"${draft ? "" : " disabled"} title="Finish the current road">Finish</button>
        <button type="button" data-action="road-cancel"${draft ? "" : " disabled"} title="Cancel the current road">Cancel road</button>
      </div>`;
      return `<div class="nixie-shelf-row">
        <button type="button" data-action="tool" data-tool="${ROAD_TOOL.SELECT}" class="${active(ROAD_TOOL.SELECT)}"${gate} title="Select roads">Select</button>
        <button type="button" data-action="tool" data-tool="${ROAD_TOOL.DRAW}" class="${active(ROAD_TOOL.DRAW)}"${gate} title="Draw a road or route">Draw</button>
        <button type="button" data-action="tool" data-tool="${ROAD_TOOL.EDIT}" class="${active(ROAD_TOOL.EDIT)}"${gate} title="Move road junctions and anchors">Edit</button>
        ${summary === "" ? "" : `<span class="nixie-shelf-sep"></span><span class="nixie-shelf-summary">${escapeHTML(summary)}</span>`}
      </div>${drillIn}`;
    },

    renderTray(): string {
      const kind = statusKind(cityLoadStatus());
      const enabled = kind === "supported" && isSceneEnabled();
      const selection = getRoadSelection();
      const inspection = roadInspector();
      const selectionActionsEnabled = roadSelectionActionsEnabled(enabled, selection.edgeIds.length);
      const roadClass = currentRoadClass();
      const curvePreset = currentCurvePreset();
      const roadName = currentRoadName();
      const roadScope = currentRoadScope();
      const scopeOptions = `<select data-field="road-scope"${enabled ? "" : " disabled"}><option value="segment"${selected("segment", roadScope)}>Selected segment(s)</option><option value="contiguous-name"${selected("contiguous-name", roadScope)}>Contiguous same-name route (single selection)</option></select>`;
      const classOptions = `<select data-field="road-class"${enabled ? "" : " disabled"}>${ROUTE_CLASS_IDS.map((id) => `<option value="${id}"${selected(id, roadClass)}>${id.replaceAll("-", " ")}</option>`).join("")}</select>`;
      const curveOptions = `<select data-field="curve-preset"${enabled ? "" : " disabled"}><option value="tight"${selected("tight", curvePreset)}>Tight</option><option value="standard"${selected("standard", curvePreset)}>Standard</option><option value="broad"${selected("broad", curvePreset)}>Broad</option></select>`;
      const inspectorHTML =
        selection.nodeIds.length > 0
          ? `<p><strong>Selected junction:</strong> ${selection.nodeIds.map(escapeHTML).join(", ")}</p>`
          : inspection === null
            ? "<p><strong>Selection:</strong> none. Use Select, then click a road.</p>"
            : `<p><strong>Selected road${inspection.edgeIds.length === 1 ? "" : "s"}:</strong> ${inspection.edgeIds.map(escapeHTML).join(", ")}</p><p>Origin: ${inspection.origin}; Class: ${inspection.classId}; Name: ${inspection.name === null ? "(unnamed)" : escapeHTML(String(inspection.name))}; Lock: ${inspection.locked}; Curve: ${inspection.curvePreset}</p>`;
      return `<section data-panel="roads" class="nixie-tray-inspector">
        <h3>Road selection</h3>
        ${inspectorHTML}
        <div class="form-footer">
          <button type="button" data-action="road-lock"${selectionActionsEnabled ? "" : " disabled"}>Lock</button>
          <button type="button" data-action="road-unlock"${selectionActionsEnabled ? "" : " disabled"}>Unlock</button>
          <button type="button" data-action="road-delete"${selectionActionsEnabled ? "" : " disabled"}>Delete</button>
          <button type="button" data-action="road-delete-junction"${enabled && selection.nodeIds.length === 1 ? "" : " disabled"}>Delete junction</button>
          <button type="button" data-action="road-clear"${selection.edgeIds.length > 0 || selection.nodeIds.length > 0 ? "" : " disabled"}>Clear selection</button>
        </div>
        <div class="nixie-form-grid">
          <div class="form-group"><label>Route class</label><div class="form-fields">${classOptions}</div></div>
          <div class="form-group"><label>Curve preset (selected routes)</label><div class="form-fields">${curveOptions}</div></div>
          <div class="form-group"><label>Street name</label><div class="form-fields"><input type="text" data-field="road-name" value="${escapeHTML(roadName)}"${enabled ? "" : " disabled"}></div></div>
          <div class="form-group"><label>Name/class scope</label><div class="form-fields">${scopeOptions}</div></div>
        </div>
        <div class="form-footer">
          <button type="button" data-action="road-classify"${selectionActionsEnabled ? "" : " disabled"}>Apply class</button>
          <button type="button" data-action="road-curve"${selectionActionsEnabled ? "" : " disabled"}>Apply curve</button>
          <button type="button" data-action="road-rename"${selectionActionsEnabled ? "" : " disabled"}>Apply name</button>
        </div>
        <p class="nixie-note">Draw: click anchors, click an endpoint or segment to connect, double-click to finish, right-click to backtrack. Select: click a segment; Shift-click adds. Edit: drag anchors or weld by dropping on another anchor. For multi-selection, class and name apply to the selected segments only; curve applies to every route represented by them.</p>
      </section>`;
    },

    onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void {
      switch (action) {
        case "tool": {
          const next = target.dataset.tool ?? null;
          setCanvasTool(next);
          if (next === ROAD_TOOL.DRAW) {
            configureRoadDraft({ classId: currentRoadClass() as RouteClassId, curvePreset: currentCurvePreset(), name: currentRoadName().trim() || null });
          }
          return;
        }
        case "road-finish":
          ctx.run("road draft", finishRoadDraft());
          return;
        case "road-cancel":
          cancelRoadDraft();
          ctx.rerender();
          return;
        case "road-lock":
          ctx.run("road lock", setRoadLocked(true));
          return;
        case "road-unlock":
          ctx.run("road unlock", setRoadLocked(false));
          return;
        case "road-delete":
          ctx.run("road deletion", deleteRoads());
          return;
        case "road-clear":
          clearRoadSelection();
          ctx.rerender();
          return;
        case "road-delete-junction":
          ctx.run("junction deletion", deleteRoadJunction(getRoadSelection().nodeIds[0]!));
          return;
        case "road-classify":
          ctx.run("road class", reclassifyRoad(currentRoadClass() as RouteClassId, currentRoadScope() === "contiguous-name"));
          return;
        case "road-curve":
          ctx.run("road curve", setRoadCurvePreset(currentCurvePreset(), getRoadSelection().edgeIds));
          return;
        case "road-rename":
          ctx.run("road rename", renameRoad(currentRoadName().trim() || null, currentRoadScope() === "contiguous-name"));
          return;
        default:
          return;
      }
    },

    onRender(root: HTMLElement, _ctx: WorkspaceContext): void {
      for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('[data-field="road-class"]'))) {
        select.addEventListener("change", () => {
          const next = select.value;
          setRoadClass(next);
          configureRoadDraft({ classId: next as RouteClassId });
        });
      }
      for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('[data-field="curve-preset"]'))) {
        select.addEventListener("change", () => {
          const next = select.value as "tight" | "standard" | "broad";
          setCurvePreset(next);
          configureRoadDraft({ curvePreset: next });
        });
      }
      root.querySelector('[data-field="road-name"]')?.addEventListener("input", (event: Event) => {
        const next = (event.target as HTMLInputElement).value;
        setRoadName(next);
        configureRoadDraft({ name: next.trim() || null });
      });
      root.querySelector('[data-field="road-scope"]')?.addEventListener("change", (event: Event) => {
        setRoadScope((event.target as HTMLSelectElement).value as "segment" | "contiguous-name");
      });
      root.querySelector('[data-field="grid-snap"]')?.addEventListener("change", (event: Event) => {
        setRoadGridSnap((event.target as HTMLInputElement).checked);
      });
    }
  };
}
