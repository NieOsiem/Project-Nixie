import {
  cityLoadStatus,
  createCoastalTerrain,
  createRectangleTerrain,
  deleteRoads,
  generateRoads,
  getCity,
  isSceneEnabled,
  replaceLegacyWithCoastalTerrain,
  replaceLegacyWithRectangleTerrain,
  setSceneEnabled
} from "../../adapter/canvas.js";
import {
  currentCoastEdge,
  currentHubMode,
  currentRoadLayout,
  currentSeed,
  setCoastEdge,
  setHubMode,
  setRoadLayout,
  setSeed
} from "../editor-state.js";
import type { HubMode, RoadLayout } from "../editor-state.js";
import { escapeHTML, selected, statusKind } from "./shared.js";
import type { WorkspaceContext, WorkspaceModule } from "./types.js";

const EDGES = ["north", "east", "south", "west"] as const;
type Edge = (typeof EDGES)[number];

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

export function roadGenerationActionsHTML(generation: RoadGenerationAvailability, editorEnabled: boolean): string {
  return `<div class="form-footer"><button type="button" data-action="generate-roads"${generation.enabled ? "" : " disabled"}>Generate initial roads</button><button type="button" data-action="delete-all-roads"${editorEnabled && generation.roadCount > 0 ? "" : " disabled"}>Delete all roads</button></div>`;
}

async function confirmLegacy(): Promise<boolean> {
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Nixie: Replace legacy city?" },
    content: "This replaces City Generator 1.0 data with a new City Generator 2.0 terrain. Continue?",
    rejectClose: false,
    modal: true
  });
  return confirmed === true;
}

export function generateWorkspace(): WorkspaceModule {
  let sourceRevision: number | null = null;

  const syncSeedFromCity = (): void => {
    const status = cityLoadStatus();
    if (status.kind !== "supported") {
      sourceRevision = null;
      return;
    }
    const revision = status.state.revision;
    const stateSeed = status.state.source.citySeed;
    if (revision !== sourceRevision) setSeed(stateSeed);
    sourceRevision = revision;
  };

  return {
    id: "generate",

    renderShelf(): string {
      return "";
    },

    renderTray(): string {
      syncSeedFromCity();
      const status = cityLoadStatus();
      const kind = statusKind(status);
      const blocked = kind === "unsupported" || kind === "malformed";
      const legacy = kind === "legacy";
      const sceneEnabled = isSceneEnabled();
      const enabled = kind === "supported" && sceneEnabled;
      const city = getCity();
      const generation = roadGenerationAvailability(kind, sceneEnabled, city);
      let message = sceneEnabled
        ? "Create a City Generator 2.0 terrain explicitly. No Scene flag is written until you choose a boundary."
        : "Enable Nixie on this Scene before creating terrain.";
      if (legacy) message = "This Scene contains City Generator 1.0 data. It is read-only until you explicitly replace it.";
      else if (kind === "unsupported") message = "This Scene contains an unsupported City Generator 2.0 schema. Editing is unavailable.";
      else if (kind === "malformed") message = "The City Generator 2.0 data is malformed. Editing is unavailable until it is migrated or repaired.";
      else if (kind === "supported") message = enabled ? "Create or replace the city, then generate its initial road network." : "Nixie is disabled on this Scene.";
      const disabled = blocked || !sceneEnabled ? " disabled" : "";
      const legacyAttr = legacy ? ' data-legacy="true"' : "";
      const seed = currentSeed();
      const coastEdge = currentCoastEdge();
      const roadLayout = currentRoadLayout();
      const hubMode = currentHubMode();
      return `<section data-panel="generate" class="nixie-tray-generate">
        <div data-status="scene" data-status-kind="${kind}"><p>${escapeHTML(message)}</p></div>
        <div class="form-group"><label><input type="checkbox" data-field="enable"${sceneEnabled ? " checked" : ""}${blocked ? " disabled" : ""}> Enable Nixie on this Scene</label></div>
        <h3>Create city</h3>
        <p class="nixie-note">Settings here configure the next terrain or network. Until full-city generation arrives in a later phase, each create action writes immediately.</p>
        <div class="nixie-form-grid">
          <div class="form-group"><label>City seed</label><div class="form-fields"><input type="text" data-field="seed" value="${escapeHTML(seed)}"${disabled}></div></div>
          <div class="form-group"><label>Coast edge</label><div class="form-fields"><select data-field="coast-edge"${disabled}>${EDGES.map((edge) => `<option value="${edge}"${selected(edge, coastEdge)}>${edge[0]!.toUpperCase()}${edge.slice(1)}</option>`).join("")}</select></div></div>
        </div>
        <div class="form-footer">
          <button type="button" data-action="create-rectangle"${disabled}${legacyAttr}>Rectangle terrain</button>
          <button type="button" data-action="create-coastal"${disabled}${legacyAttr}>Coastal terrain</button>
        </div>
        <h3>Road network</h3>
        <div class="nixie-form-grid">
          <div class="form-group"><label>Road layout</label><div class="form-fields"><select data-field="road-layout"${enabled ? "" : " disabled"}><option value="european"${selected("european", roadLayout)}>European</option><option value="grid"${selected("grid", roadLayout)}>Grid</option><option value="mixed"${selected("mixed", roadLayout)}>Mixed</option></select></div></div>
          <div class="form-group"><label>Hub mode</label><div class="form-fields"><select data-field="hub-mode"${enabled ? "" : " disabled"}><option value="single-centre"${selected("single-centre", hubMode)}>Single centre</option><option value="multiple-hubs"${selected("multiple-hubs", hubMode)}>Multiple hubs</option></select></div></div>
        </div>
        <div data-status="road-generation" data-status-kind="${generation.enabled ? "success" : "info"}"><p>${escapeHTML(generation.reason)}</p>${roadGenerationActionsHTML(generation, enabled)}</div>
        <p class="nixie-note">Full-city generation with staged settings and confirmation arrives in a later phase; until then these actions replace the current city and network directly.</p>
      </section>`;
    },

    onAction(action: string, _target: HTMLElement, ctx: WorkspaceContext): void {
      switch (action) {
        case "create-rectangle":
          void createCity(ctx, "rectangle");
          return;
        case "create-coastal":
          void createCity(ctx, "coastal");
          return;
        case "generate-roads":
          ctx.run("road generation", generateRoads(currentRoadLayout(), currentHubMode()));
          return;
        case "delete-all-roads":
          ctx.run("delete all roads", deleteRoads(allRoadEdgeIds(getCity())));
          return;
        default:
          return;
      }
    },

    onRender(root: HTMLElement, _ctx: WorkspaceContext): void {
      root.querySelector('[data-field="enable"]')?.addEventListener("change", (event: Event) => {
        void setSceneEnabled((event.target as HTMLInputElement).checked);
      });
      root.querySelector('[data-field="seed"]')?.addEventListener("input", (event: Event) => {
        setSeed((event.target as HTMLInputElement).value);
      });
      root.querySelector('[data-field="coast-edge"]')?.addEventListener("change", (event: Event) => {
        setCoastEdge((event.target as HTMLSelectElement).value as Edge);
      });
      root.querySelector('[data-field="road-layout"]')?.addEventListener("change", (event: Event) => {
        setRoadLayout((event.target as HTMLSelectElement).value as RoadLayout);
      });
      root.querySelector('[data-field="hub-mode"]')?.addEventListener("change", (event: Event) => {
        setHubMode((event.target as HTMLSelectElement).value as HubMode);
      });
    }
  };

  async function createCity(ctx: WorkspaceContext, kind: "rectangle" | "coastal"): Promise<void> {
    const legacy = statusKind(cityLoadStatus()) === "legacy";
    if (legacy && !(await confirmLegacy())) return;
    const seed = currentSeed().trim();
    if (seed.length === 0) {
      ui.notifications?.warn("Nixie: enter a non-empty city seed.");
      return;
    }
    const replace = legacy;
    const work =
      kind === "rectangle"
        ? replace
          ? replaceLegacyWithRectangleTerrain(seed)
          : createRectangleTerrain(seed)
        : replace
          ? replaceLegacyWithCoastalTerrain(seed, currentCoastEdge())
          : createCoastalTerrain(seed, currentCoastEdge());
    ctx.run(`${kind} terrain`, work, () => {
      ui.notifications?.info(`Nixie: ${kind} terrain created.`);
    });
  }
}
