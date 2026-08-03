import {
  addCityListener,
  cityLoadStatus,
  createCoastalTerrain,
  createRectangleTerrain,
  deleteUrbanFootprint,
  getCity,
  isSceneEnabled,
  replaceLegacyWithCoastalTerrain,
  replaceLegacyWithRectangleTerrain,
  redo,
  undo
} from "../adapter/canvas.js";
import { cancelTerrainDraft, finishTerrainDraft, hasTerrainDraft } from "./nixie-layer.js";

const APP_ID = "nixie-terrain";
const EDGES = ["north", "east", "south", "west"] as const;
type Edge = (typeof EDGES)[number];

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

function terrainOf(city: any): { urbanFootprint: unknown[] | null } {
  const source = city?.source ?? city;
  const terrain = source?.terrain ?? city?.terrain;
  return { urbanFootprint: Array.isArray(terrain?.urbanFootprint) ? terrain.urbanFootprint : null };
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

function report(label: string, work: Promise<unknown>, then: () => void): void {
  void work.then(then).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`nixie | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${message}`);
  });
}

let cached: any = null;

function terrainAppClass(): any {
  if (cached !== null) return cached;
  const Base = applicationBase();
  if (!Base) throw new Error("ApplicationV2 is unavailable — Foundry's application API moved.");

  cached = class NixieTerrainApp extends Base {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["nixie-terrain"],
      window: { title: "Nixie: Terrain", icon: "fa-solid fa-water", resizable: true },
      position: { width: 520, height: "auto" }
    };

    #status: any = { kind: "malformed" };
    #seed = "nixie-2";
    #edge: Edge = "west";
    #sourceRevision: number | null = null;

    _canRender(): void {
      if (!game.user?.isGM) throw new Error("Nixie: the terrain editor is GM-only.");
    }

    async _prepareContext(options: any): Promise<Record<string, never>> {
      this.#status = cityLoadStatus();
      const stateSeed = this.#status?.state?.source?.citySeed ?? this.#status?.citySeed;
      const revision = this.#status?.state?.revision ?? null;
      if ((options.isFirstRender || revision !== this.#sourceRevision) && typeof stateSeed === "string") {
        this.#seed = stateSeed;
      }
      this.#sourceRevision = revision;
      return {};
    }

    async _renderHTML(): Promise<string> {
      return this.#html();
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
    }

    #html(): string {
      const kind = statusKind(this.#status);
      const blocked = kind === "unsupported" || kind === "malformed";
      const legacy = kind === "legacy";
      const sceneEnabled = isSceneEnabled();
      const enabled = kind === "supported" && sceneEnabled;
      const city = getCity();
      const hasFootprint = terrainOf(city).urbanFootprint !== null;
      const draft = hasTerrainDraft();
      let message = sceneEnabled
        ? "Create a City Generator 2.0 terrain explicitly. No Scene flag is written until you choose a boundary."
        : "Enable Nixie on this Scene before creating terrain.";
      if (legacy) message = "This Scene contains City Generator 1.0 data. It is read-only until you explicitly replace it.";
      else if (kind === "unsupported") message = "This Scene contains an unsupported City Generator 2.0 schema. Editing is unavailable.";
      else if (kind === "malformed") message = "The City Generator 2.0 data is malformed. Editing is unavailable until it is migrated or repaired.";
      else if (kind === "supported") message = enabled ? "Edit the current metre-space terrain or create a new boundary." : "Nixie is disabled on this Scene.";
      const disabled = blocked || !sceneEnabled ? " disabled" : "";
      const legacyAttr = legacy ? " data-legacy=\"true\"" : "";
      return `<p>${message}</p>
        <div class="form-group"><label>City seed</label><div class="form-fields"><input type="text" data-field="seed" value="${escapeHTML(this.#seed)}"${blocked ? " disabled" : ""}></div></div>
        <div class="form-group"><label>Coast edge</label><div class="form-fields"><select data-field="edge"${blocked ? " disabled" : ""}>${EDGES.map((edge) => `<option value="${edge}"${edge === this.#edge ? " selected" : ""}>${edge[0]!.toUpperCase()}${edge.slice(1)}</option>`).join("")}</select></div></div>
        <div class="form-footer" style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" data-action="rectangle"${disabled}${legacyAttr}>Rectangle</button>
          <button type="button" data-action="coastal"${disabled}${legacyAttr}>Coastal</button>
          <button type="button" data-action="delete-footprint"${city === null || !hasFootprint ? " disabled" : ""}>Delete footprint</button>
          <button type="button" data-action="finish"${draft ? "" : " disabled"}>Finish draft</button>
          <button type="button" data-action="cancel"${draft ? "" : " disabled"}>Cancel draft</button>
          <button type="button" data-action="undo"${enabled ? "" : " disabled"}>Undo</button>
          <button type="button" data-action="redo"${enabled ? "" : " disabled"}>Redo</button>
        </div>`;
    }

    _onRender(): void {
      const root = this.element as HTMLElement;
      root.querySelector('[data-field="seed"]')?.addEventListener("input", (event: Event) => {
        this.#seed = (event.target as HTMLInputElement).value;
      });
      root.querySelector('[data-field="edge"]')?.addEventListener("change", (event: Event) => {
        this.#edge = (event.target as HTMLSelectElement).value as Edge;
      });
    }

    async #create(kind: "rectangle" | "coastal"): Promise<void> {
      const legacy = statusKind(this.#status) === "legacy";
      if (legacy && !(await confirmLegacy())) return;
      const seed = this.#seed.trim();
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
            ? replaceLegacyWithCoastalTerrain(seed, this.#edge)
            : createCoastalTerrain(seed, this.#edge);
      report(`${kind} terrain`, work, () => {
        ui.notifications?.info(`Nixie: ${kind} terrain created.`);
        void this.render({ force: true });
      });
    }

    _onClickAction(_event: PointerEvent, target: HTMLElement): void {
      const action = target.closest<HTMLElement>("[data-action]") ?? target;
      switch (action.dataset.action) {
        case "rectangle":
          void this.#create("rectangle");
          return;
        case "coastal":
          void this.#create("coastal");
          return;
        case "delete-footprint":
          report("urban footprint deletion", deleteUrbanFootprint(), () => void this.render({ force: true }));
          return;
        case "finish":
          report("terrain draft", finishTerrainDraft(), () => void this.render({ force: true }));
          return;
        case "cancel":
          cancelTerrainDraft();
          void this.render({ force: true });
          return;
        case "undo":
          report("undo", undo(), () => void this.render({ force: true }));
          return;
        case "redo":
          report("redo", redo(), () => void this.render({ force: true }));
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

export function openTerrainApp(): void {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Nixie: the terrain editor is GM-only.");
    return;
  }
  instance ??= new (terrainAppClass())();
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
