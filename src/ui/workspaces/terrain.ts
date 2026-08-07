import { cityLoadStatus, deleteUrbanFootprint, getCity, isSceneEnabled } from "../../adapter/canvas.js";
import { canvasTool, setCanvasTool, TOOL } from "../editor-state.js";
import { cancelTerrainDraft, finishTerrainDraft, hasTerrainDraft } from "../nixie-layer.js";
import { statusKind } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

function terrainOf(city: any): { urbanFootprint: unknown[] | null } {
  const source = city?.source ?? city;
  const terrain = source?.terrain ?? city?.terrain;
  return { urbanFootprint: Array.isArray(terrain?.urbanFootprint) ? terrain.urbanFootprint : null };
}

export function terrainWorkspace(): WorkspaceModule {
  return {
    id: "terrain",

    renderShelf(): string {
      const kind = statusKind(cityLoadStatus());
      const enabled = kind === "supported" && isSceneEnabled();
      const city = getCity();
      const hasFootprint = terrainOf(city).urbanFootprint !== null;
      const draft = hasTerrainDraft();
      const tool = canvasTool();
      const gate = enabled ? "" : " disabled";
      const active = (id: string): string => (tool === id ? " active" : "");
      return `<div class="nixie-shelf-row">
        <button type="button" data-action="tool" data-tool="${TOOL.LAND_DRAW}" class="${active(TOOL.LAND_DRAW)}"${gate} title="Draw or replace the land boundary">Land</button>
        <button type="button" data-action="tool" data-tool="${TOOL.FOOTPRINT_DRAW}" class="${active(TOOL.FOOTPRINT_DRAW)}"${gate} title="Draw or replace the urban footprint">Footprint</button>
        <span class="nixie-shelf-sep"></span>
        <button type="button" data-action="tool" data-tool="${TOOL.LAND_EDIT}" class="${active(TOOL.LAND_EDIT)}"${gate} title="Drag land vertices">Edit land</button>
        <button type="button" data-action="tool" data-tool="${TOOL.FOOTPRINT_EDIT}" class="${active(TOOL.FOOTPRINT_EDIT)}"${gate} title="Drag urban-footprint vertices">Edit footprint</button>
        <span class="nixie-shelf-sep"></span>
        <button type="button" data-action="finish-draft"${draft ? "" : " disabled"} title="Finish the current boundary draft">Finish</button>
        <button type="button" data-action="cancel-draft"${draft ? "" : " disabled"} title="Cancel the current boundary draft">Cancel</button>
        <button type="button" data-action="delete-footprint"${enabled && hasFootprint ? "" : " disabled"} title="Delete the urban footprint">Delete footprint</button>
      </div>`;
    },

    renderTray(): string {
      return "";
    },

    onAction(action: string, target: HTMLElement, ctx: WorkspaceContext): void {
      switch (action) {
        case "tool":
          setCanvasTool(target.dataset.tool ?? null);
          return;
        case "finish-draft":
          ctx.run("terrain draft", finishTerrainDraft());
          return;
        case "cancel-draft":
          cancelTerrainDraft();
          ctx.rerender();
          return;
        case "delete-footprint":
          ctx.run("urban footprint deletion", deleteUrbanFootprint());
          return;
        default:
          return;
      }
    },

    onRender(_root: HTMLElement, _ctx: WorkspaceContext): void {}
  };
}
