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
import { ROUTE_CLASS_IDS, ROUTE_CLASSES, type RouteClassDefinition, type RouteClassId } from "../../core/gen/city.js";
import {
  canvasTool,
  currentCurvePreset,
  currentRoadClass,
  ROAD_TOOL,
  setCanvasTool,
  setCurvePreset,
  setRoadClass,
  type CurvePreset
} from "../editor-state.js";
import { cancelRoadDraft, configureRoadDraft, finishRoadDraft, hasRoadDraft } from "../road-layer.js";
import { checked, escapeHTML, selected, statusKind } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

type RoadScope = "segment" | "contiguous-name";
type ClassGroup = "vehicle" | "non-vehicle";

/** Editor state, the pending inspector edits, and the canvas draft. */
let classGroup: ClassGroup = "vehicle";
let stagedClass: string | undefined;
let stagedCurve: CurvePreset | undefined;
let stagedName: string | undefined;
let stagedScope: RoadScope = "segment";
let lastSelectionKey = "";

export function roadSelectionActionsEnabled(editorEnabled: boolean, edgeCount: number): boolean {
  return editorEnabled && edgeCount > 0;
}

export function routeClassLabel(id: string): string {
  return id.replaceAll("-", " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function classChipsForGroup(group: ClassGroup): RouteClassDefinition[] {
  return ROUTE_CLASSES.filter((routeClass) => (group === "vehicle") === routeClass.vehicle);
}

export function roadStagedDirty(classValue: string | undefined, curveValue: string | undefined, nameValue: string | undefined): boolean {
  return classValue !== undefined || curveValue !== undefined || nameValue !== undefined;
}

function selectionKey(selection: { edgeIds: string[]; nodeIds: string[] }): string {
  return `${selection.edgeIds.join("|")}::${selection.nodeIds.join("|")}`;
}

function resetStaged(selection: { edgeIds: string[]; nodeIds: string[] }): void {
  stagedClass = undefined;
  stagedCurve = undefined;
  stagedName = undefined;
  stagedScope = "segment";
  lastSelectionKey = selectionKey(selection);
}

function silhouetteWidth(widthM: number): number {
  return Math.round(4 + widthM * 1.3);
}

function renderInspector(enabled: boolean, selection: { edgeIds: string[]; nodeIds: string[] }): string {
  const inspection = roadInspector();
  if (selectionKey(selection) !== lastSelectionKey) resetStaged(selection);
  const count = selection.edgeIds.length;
  const classValue = stagedClass ?? (inspection?.classId === "multiple" ? "" : inspection?.classId ?? "");
  const curveValue = stagedCurve ?? (inspection?.curvePreset === "multiple" ? "" : inspection?.curvePreset ?? "");
  const nameMixed = stagedName === undefined && inspection?.name === "multiple";
  const nameValue = stagedName ?? (inspection?.name === "multiple" || inspection?.name == null ? "" : String(inspection.name));
  const dirty = roadStagedDirty(stagedClass, stagedCurve, stagedName);
  const classOptions = ROUTE_CLASS_IDS.map((id) => `<option value="${id}"${selected(id, classValue)}>${routeClassLabel(id)}</option>`).join("");
  const curveOptions = `<option value="tight"${selected("tight", curveValue)}>Tight</option><option value="standard"${selected("standard", curveValue)}>Standard</option><option value="broad"${selected("broad", curveValue)}>Broad</option>`;
  const mixedClass = inspection?.classId === "multiple" && stagedClass === undefined ? '<option value="multiple" disabled selected>Multiple</option>' : "";
  const mixedCurve = inspection?.curvePreset === "multiple" && stagedCurve === undefined ? '<option value="multiple" disabled selected>Multiple</option>' : "";
  const headName = inspection === null || inspection.name === "multiple"
    ? "Multiple roads"
    : inspection.name === null
      ? "(unnamed road)"
      : String(inspection.name);
  const subClass = inspection === null || inspection.classId === "multiple" ? "Roads" : routeClassLabel(inspection.classId);
  const lockLabel = inspection?.locked === true ? "Unlock" : "Lock";
  const scopeOptions = `<select data-field="road-scope"${enabled ? "" : " disabled"}>
    <option value="segment"${selected("segment", stagedScope)}>Selected segment(s)</option>
    <option value="contiguous-name"${selected("contiguous-name", stagedScope)}${selection.edgeIds.length === 1 ? "" : " disabled"}>Entire named route</option>
  </select>`;
  return `<section data-panel="roads" class="nixie-tray-inspector">
    <div class="nixie-inspector-head">
      <h3>${escapeHTML(headName)}</h3>
      <button type="button" data-action="road-lock-toggle"${enabled ? "" : " disabled"} title="Lock or unlock the selected roads">${lockLabel}</button>
    </div>
    <p class="nixie-inspector-sub">${subClass} • ${count} segment${count === 1 ? "" : "s"} selected</p>
    <div class="nixie-form-grid">
      <div class="form-group"><label>Class</label><div class="form-fields"><select data-field="staged-class"${enabled ? "" : " disabled"}>${mixedClass}${classOptions}</select></div></div>
      <div class="form-group"><label>Curve</label><div class="form-fields"><select data-field="staged-curve"${enabled ? "" : " disabled"}>${mixedCurve}${curveOptions}</select></div></div>
      <div class="form-group"><label>Name</label><div class="form-fields"><input type="text" data-field="staged-name" value="${escapeHTML(nameValue)}" placeholder="${nameMixed ? "Multiple — selected roads differ" : ""}"${enabled ? "" : " disabled"}></div></div>
      <div class="form-group"><label>Apply to</label><div class="form-fields">${scopeOptions}</div></div>
    </div>
    <div class="form-footer">
      <button type="button" data-action="road-reset"${dirty && enabled ? "" : " disabled"}>Reset</button>
      <button type="button" data-action="road-apply"${dirty && enabled ? "" : " disabled"}>Apply changes</button>
    </div>
    <div class="form-footer">
      <button type="button" data-action="road-edit-geometry"${enabled ? "" : " disabled"} title="Move junctions and reshape this road">Edit geometry</button>
      <button type="button" data-action="road-delete"${roadSelectionActionsEnabled(enabled, count) ? "" : " disabled"}>Delete</button>
      <span class="nixie-shelf-sep"></span>
      <button type="button" data-action="road-clear"${count > 0 ? "" : " disabled"}>Clear selection</button>
    </div>
  </section>`;
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
      const tabs = `<div class="nixie-shelf-row">
        <button type="button" data-action="tool" data-tool="${ROAD_TOOL.SELECT}" class="${active(ROAD_TOOL.SELECT)}"${gate} title="Select roads">Select</button>
        <button type="button" data-action="tool" data-tool="${ROAD_TOOL.DRAW}" class="${active(ROAD_TOOL.DRAW)}"${gate} title="Draw a road or route">Draw</button>
        <button type="button" data-action="tool" data-tool="${ROAD_TOOL.EDIT}" class="${active(ROAD_TOOL.EDIT)}"${gate} title="Move road junctions and anchors, weld them together">Shape</button>
        ${summary === "" ? "" : `<span class="nixie-shelf-sep"></span><span class="nixie-shelf-summary">${escapeHTML(summary)}</span>`}
      </div>`;
      if (tool !== ROAD_TOOL.DRAW) return tabs;
      const chips = classChipsForGroup(classGroup)
        .map((routeClass) => {
          const isActive = routeClass.id === currentRoadClass();
          return `<button type="button" data-action="road-class-chip" data-class="${routeClass.id}" class="nixie-class-chip${isActive ? " active" : ""}"${gate} title="${routeClassLabel(routeClass.id)} — ${routeClass.vehicle ? "vehicle road" : "non-vehicle route"}">
            <span class="nixie-class-silhouette" style="width:${silhouetteWidth(routeClass.widthM)}px"></span>${routeClassLabel(routeClass.id)}
          </button>`;
        })
        .join("");
      return `${tabs}
        <div class="nixie-shelf-row">
          <span class="nixie-class-group-switch" role="group" aria-label="Road class group">
            <button type="button" data-action="class-group" data-group="vehicle" class="${classGroup === "vehicle" ? " active" : ""}" title="Vehicle road classes">Vehicles</button>
            <button type="button" data-action="class-group" data-group="non-vehicle" class="${classGroup === "non-vehicle" ? " active" : ""}" title="Non-vehicle routes">Routes</button>
          </span>
          ${chips}
        </div>
        <div class="nixie-shelf-row">
          <label class="nixie-shelf-field">Curve<select data-field="curve-preset"${gate}><option value="tight"${selected("tight", currentCurvePreset())}>Tight</option><option value="standard"${selected("standard", currentCurvePreset())}>Standard</option><option value="broad"${selected("broad", currentCurvePreset())}>Broad</option></select></label>
          <label class="nixie-shelf-field"><input type="checkbox" data-field="grid-snap"${checked(roadGridSnapEnabled())}${gate}> Grid snap</label>
          <span class="nixie-shelf-sep"></span>
          <button type="button" data-action="road-finish"${draft ? "" : " disabled"} title="Finish the current road">Finish</button>
          <button type="button" data-action="road-cancel"${draft ? "" : " disabled"} title="Cancel the current road">Cancel road</button>
        </div>
        <div class="nixie-shelf-hint">Click: add anchor • Double-click: finish • Right-click: remove last anchor</div>`;
    },

    renderTray(): string {
      const kind = statusKind(cityLoadStatus());
      const enabled = kind === "supported" && isSceneEnabled();
      const tool = canvasTool();
      const selection = getRoadSelection();
      const gate = enabled ? "" : " disabled";
      if (tool === ROAD_TOOL.DRAW) return "";
      if (tool === ROAD_TOOL.EDIT) {
        const inspection = roadInspector();
        const nodeIds = selection.nodeIds;
        const name = inspection === null || inspection.name === "multiple" ? null : inspection.name;
        const classLabel = inspection === null || inspection.classId === "multiple" ? "" : `${routeClassLabel(inspection.classId)} • `;
        return `<section data-panel="roads" class="nixie-tray-inspector">
          <h3>${escapeHTML(name === null ? "Edit road geometry" : `Editing ${name}`)}</h3>
          ${nodeIds.length > 0
            ? `<p class="nixie-inspector-sub">Junction selected: ${nodeIds.map(escapeHTML).join(", ")}</p>`
            : inspection === null
              ? `<p class="nixie-inspector-sub">Select a road first, then reshape it here.</p>`
              : `<p class="nixie-inspector-sub">${classLabel}${inspection.edgeIds.length} segment${inspection.edgeIds.length === 1 ? "" : "s"} selected</p>`}
          <p class="nixie-note">Drag anchors to reshape • Drop an anchor onto another anchor to weld</p>
          <label class="nixie-shelf-field"><input type="checkbox" data-field="grid-snap"${checked(roadGridSnapEnabled())}${gate}> Grid snap</label>
          <div class="form-footer">
            <button type="button" data-action="road-delete-junction"${enabled && nodeIds.length === 1 ? "" : " disabled"} title="Delete the selected junction">Delete junction</button>
            <button type="button" data-action="road-done-geometry" title="Return to road selection">Done</button>
          </div>
        </section>`;
      }
      if (selection.nodeIds.length > 0) {
        return `<section data-panel="roads" class="nixie-tray-inspector">
          <h3>Junction selection</h3>
          <p class="nixie-note">${selection.nodeIds.map(escapeHTML).join(", ")} — junctions are modified in Shape mode.</p>
          <div class="form-footer">
            <button type="button" data-action="road-delete-junction"${enabled && selection.nodeIds.length === 1 ? "" : " disabled"}>Delete junction</button>
            <button type="button" data-action="road-clear">Clear selection</button>
          </div>
        </section>`;
      }
      if (selection.edgeIds.length === 0) {
        return `<section data-panel="roads" class="nixie-tray-inspector">
          <h3>Road selection</h3>
          <p class="nixie-note">Click a road to inspect it. Shift-click to select multiple segments.</p>
        </section>`;
      }
      return renderInspector(enabled, selection);
    },

    onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void {
      switch (action) {
        case "tool": {
          const next = target.dataset.tool ?? null;
          setCanvasTool(next);
          if (next === ROAD_TOOL.DRAW) {
            configureRoadDraft({ classId: currentRoadClass() as RouteClassId, curvePreset: currentCurvePreset(), name: stagedName?.trim() || null });
          }
          return;
        }
        case "road-class-chip": {
          const next = target.dataset.class ?? "";
          if (!(ROUTE_CLASS_IDS as readonly string[]).includes(next)) return;
          setRoadClass(next);
          configureRoadDraft({ classId: next as RouteClassId });
          return;
        }
        case "class-group": {
          const group = target.dataset.group === "non-vehicle" ? "non-vehicle" : "vehicle";
          if (classGroup === group) return;
          classGroup = group;
          ctx.rerender();
          return;
        }
        case "road-finish":
          ctx.run("road draft", finishRoadDraft());
          return;
        case "road-cancel":
          cancelRoadDraft();
          ctx.rerender();
          return;
        case "road-lock-toggle":
          ctx.run("road lock change", setRoadLocked(roadInspector()?.locked !== true));
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
        case "road-edit-geometry":
          setCanvasTool(ROAD_TOOL.EDIT);
          return;
        case "road-done-geometry":
          setCanvasTool(ROAD_TOOL.SELECT);
          return;
        case "road-reset":
          resetStaged(getRoadSelection());
          ctx.rerender();
          return;
        case "road-apply": {
          const scope = stagedScope === "contiguous-name";
          const edgeIds = getRoadSelection().edgeIds;
          const ops: Array<Promise<unknown>> = [];
          if (stagedClass !== undefined) ops.push(reclassifyRoad(stagedClass as RouteClassId, scope));
          if (stagedName !== undefined) ops.push(renameRoad(stagedName.trim() || null, scope));
          if (stagedCurve !== undefined) ops.push(setRoadCurvePreset(stagedCurve, edgeIds, scope));
          if (ops.length === 0) return;
          ctx.run(
            "road changes",
            (async () => {
              for (const op of ops) await op;
            })(),
            () => {
              resetStaged(getRoadSelection());
              ctx.rerender();
            }
          );
          return;
        }
        default:
          return;
      }
    },

    onRender(root: HTMLElement, _ctx: WorkspaceContext): void {
      for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('[data-field="curve-preset"]'))) {
        select.addEventListener("change", () => {
          const next = select.value as CurvePreset;
          setCurvePreset(next);
          configureRoadDraft({ curvePreset: next });
        });
      }
      const syncApplyButtons = (): void => {
        const dirty = roadStagedDirty(stagedClass, stagedCurve, stagedName);
        const apply = root.querySelector<HTMLButtonElement>('[data-action="road-apply"]');
        const reset = root.querySelector<HTMLButtonElement>('[data-action="road-reset"]');
        if (apply !== null) apply.disabled = !dirty;
        if (reset !== null) reset.disabled = !dirty;
      };
      root.querySelector('[data-field="staged-class"]')?.addEventListener("change", (event: Event) => {
        const next = (event.target as HTMLSelectElement).value;
        if (next === "multiple") return;
        stagedClass = next;
        syncApplyButtons();
      });
      root.querySelector('[data-field="staged-curve"]')?.addEventListener("change", (event: Event) => {
        const next = (event.target as HTMLSelectElement).value as CurvePreset;
        if (next !== "tight" && next !== "standard" && next !== "broad") return;
        stagedCurve = next;
        syncApplyButtons();
      });
      root.querySelector('[data-field="staged-name"]')?.addEventListener("input", (event: Event) => {
        stagedName = (event.target as HTMLInputElement).value;
        syncApplyButtons();
      });
      root.querySelector('[data-field="road-scope"]')?.addEventListener("change", (event: Event) => {
        const next = (event.target as HTMLSelectElement).value as RoadScope;
        if (next === "segment" || next === "contiguous-name") stagedScope = next;
      });
      root.querySelector('[data-field="grid-snap"]')?.addEventListener("change", (event: Event) => {
        setRoadGridSnap((event.target as HTMLInputElement).checked);
      });
    }
  };
}
