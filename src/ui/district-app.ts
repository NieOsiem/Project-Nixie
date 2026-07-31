import {
  applyDistrictParams,
  getCity,
  isMounted,
  reseedDistrict
} from "../adapter/canvas.js";
import type { CityParams } from "../core/gen/demo-city.js";
import {
  copyDistrictPreset,
  DISTRICT_PRESETS,
  type ZoneParams
} from "../core/gen/zones.js";
import { openPaletteApp } from "./palette-app.js";

const APP_ID = "nixie-district";
const BASE_ID = "base";
const MASSING_KEYS = ["block", "podiumTower", "terraced"] as const;
const PARAM_FIELDS = [
  ["lotSizeM", "Lot size (m)", 1, 200, 1],
  ["gapM", "Lot gap (m)", 0, 50, 0.5],
  ["minHeightM", "Min height (m)", 0, 500, 1],
  ["maxHeightM", "Max height (m)", 0, 500, 1],
  ["occupancy", "Occupancy", 0, 1, 0.01],
  ["heightCluster", "Height clustering", 0, 1, 0.01],
  ["facadeRate", "Sign density", 0, 1, 0.01],
  ["poolRate", "Ground pools", 0, 1, 0.01]
] as const;
const WEIGHT_FIELDS = [
  ["wallWeights", "Wall families", 3],
  ["roofWeights", "Roof families", 3],
  ["neonWeights", "Neon families", 2]
] as const;

type IdentityParams = ZoneParams & {
  name?: string;
  massingWeights: Record<(typeof MASSING_KEYS)[number], number>;
  wallWeights: number[];
  roofWeights: number[];
  neonWeights: number[];
};

interface WorkingDistrict extends IdentityParams {
  id: string;
}

function applicationBase(): any {
  return foundry?.applications?.api?.ApplicationV2 ?? null;
}

let cached: any = null;

const escapeHTML = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function cloneParams(params: ZoneParams & { name?: string }): IdentityParams {
  const source = params as IdentityParams;
  return {
    ...source,
    name: source.name,
    massingWeights: { ...source.massingWeights },
    wallWeights: [...source.wallWeights] as [number, number, number],
    roofWeights: [...source.roofWeights] as [number, number, number],
    neonWeights: [...source.neonWeights] as [number, number],
    palette: {
      ...source.palette,
      materials: source.palette.materials.map((material) => ({
        ...material,
        base: { ...material.base },
        emissive: { ...material.emissive }
      }))
    }
  };
}

function districtLabel(city: CityParams, id: string): string {
  if (id === BASE_ID) return "Unzoned City";
  const zone = city.zones.find((candidate) => candidate.id === id);
  return zone?.name?.trim() || `District ${id}`;
}

function districtParams(city: CityParams, id: string): WorkingDistrict | null {
  if (id === BASE_ID) return { id, ...cloneParams(city.base) };
  const zone = city.zones.find((candidate) => candidate.id === id);
  return zone === undefined ? null : { id, ...cloneParams(zone) };
}

function numericInput(
  field: string,
  label: string,
  value: number,
  min = 0,
  max = 1,
  step = 0.01
): string {
  const digits = step < 1 ? Math.max(0, `${step}`.split(".")[1]?.length ?? 0) : 0;
  return `<label class="nixie-field" style="display:grid;grid-template-columns:minmax(0,1fr) 72px;align-items:center;gap:6px"><span>${label}</span><input type="number" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${value.toFixed(digits)}"></label>`;
}

function districtAppClass(): any {
  if (cached !== null) return cached;
  const Base = applicationBase();
  if (!Base) throw new Error("ApplicationV2 is unavailable — Foundry's application API moved.");

  cached = class NixieDistrictApp extends Base {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["nixie-district"],
      window: {
        title: "Nixie: Districts",
        icon: "fa-solid fa-city",
        resizable: true
      },
      position: { width: 900, height: "auto" }
    };

    #districts: Array<{ id: string; label: string }> = [];
    #districtId = BASE_ID;
    #working: WorkingDistrict | null = null;
    #source: CityParams | null = null;
    #presetId = DISTRICT_PRESETS[0]?.id ?? "";
    #dirty = false;
    #saving = false;

    _canRender(): void {
      if (!game.user?.isGM) throw new Error("Nixie: the district editor is GM-only.");
    }

    async _prepareContext(options: any): Promise<Record<string, never>> {
      const city = getCity();
      if (this.#dirty && this.#source !== null && city !== this.#source) {
        this.#stale();
        return {};
      }
      if (!isMounted() || city === null) {
        this.#districts = [];
        this.#working = null;
        this.#source = city;
        return {};
      }

      this.#districts = [
        { id: BASE_ID, label: districtLabel(city, BASE_ID) },
        ...city.zones.map((zone) => ({ id: zone.id, label: districtLabel(city, zone.id) }))
      ];
      const selected = this.#districts.some((district) => district.id === this.#districtId)
        ? this.#districtId
        : BASE_ID;
      if (options.isFirstRender || this.#source === null || this.#source !== city) {
        this.#districtId = selected;
        this.#working = districtParams(city, selected);
        this.#source = city;
        this.#dirty = false;
      }
      return {};
    }

    async _renderHTML(): Promise<string> {
      return this.#html();
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
    }

    #html(): string {
      const working = this.#working;
      if (working === null) return "<p>Nixie is not enabled on this scene.</p>";
      const districts = this.#districts
        .map(
          (district) =>
            `<option value="${escapeHTML(district.id)}"${district.id === this.#districtId ? " selected" : ""}>${escapeHTML(district.label)}</option>`
        )
        .join("");
      const presets = DISTRICT_PRESETS.map(
        (preset) =>
          `<option value="${escapeHTML(preset.id)}"${preset.id === this.#presetId ? " selected" : ""}>${escapeHTML(preset.label)}</option>`
      ).join("");
      const massing = MASSING_KEYS.map((key) =>
        numericInput(`massingWeights.${key}`, key === "podiumTower" ? "Podium + tower" : key[0]!.toUpperCase() + key.slice(1), working.massingWeights[key])
      ).join("");
      const scalar = PARAM_FIELDS.map(([field, label, min, max, step]) =>
        numericInput(field, label, working[field], min, max, step)
      ).join("");
      const weights = WEIGHT_FIELDS.map(([field, label, count]) => {
        const values = working[field];
        return `<fieldset style="min-width:0;margin:0 0 8px"><legend>${label}</legend><div class="nixie-grid">${Array.from({ length: count }, (_, index) => numericInput(`${field}.${index}`, `Family ${index + 1}`, values[index] ?? 0)).join("")}</div></fieldset>`;
      });
      const base = this.#districtId === BASE_ID;
      return `<div class="form-group"><label>District</label><div class="form-fields"><select data-nixie="district">${districts}</select></div></div>
        <div class="form-group"><label>Name</label><div class="form-fields"><input type="text" data-field="name" value="${escapeHTML(working.name ?? "")}"${base ? " disabled" : ""}></div></div>
        <div class="form-group"><label>Template</label><div class="form-fields"><select data-nixie="preset">${presets}</select><button type="button" data-action="preset">Apply</button></div></div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:start">
          <fieldset style="min-width:0;margin:0"><legend>Identity</legend><div class="nixie-grid" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 8px">${scalar}</div></fieldset>
          <div style="min-width:0">
            <fieldset style="min-width:0;margin:0 0 8px"><legend>Massing</legend><div class="nixie-grid">${massing}</div></fieldset>
            ${weights[0] ?? ""}
          </div>
          <div style="min-width:0">
            ${weights[1] ?? ""}
            ${weights[2] ?? ""}
          </div>
        </div>
        <footer class="form-footer" style="display:flex;gap:4px;margin-top:8px">
          <button type="button" data-action="reseed"><i class="fa-solid fa-dice"></i> Reseed</button>
          <button type="button" data-action="palette"><i class="fa-solid fa-palette"></i> Palette</button>
          <button type="button" data-action="apply"><i class="fa-solid fa-floppy-disk"></i> Apply</button>
          <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
        </footer>`;
    }

    _onRender(): void {
      const root = this.element as HTMLElement;
      root.querySelector('[data-nixie="district"]')?.addEventListener("change", (event: Event) => {
        void this.#changeDistrict((event.target as HTMLSelectElement).value);
      });
      root.querySelector('[data-nixie="preset"]')?.addEventListener("change", (event: Event) => {
        this.#presetId = (event.target as HTMLSelectElement).value;
      });
      root.addEventListener("input", (event: Event) => this.#onInput(event));
    }

    #onInput(event: Event): void {
      if (!this.#isFresh()) return;
      const input = event.target as HTMLInputElement;
      const field = input.dataset.field;
      const working = this.#working;
      if (field === undefined || working === null) return;
      const [root, key] = field.split(".");
      if (root === "name") working.name = input.value;
      else if (root === "massingWeights" && MASSING_KEYS.includes(key as (typeof MASSING_KEYS)[number])) {
        working.massingWeights[key as (typeof MASSING_KEYS)[number]] = Number(input.value);
      } else if (root === "wallWeights" || root === "roofWeights" || root === "neonWeights") {
        const index = Number(key);
        if (Number.isInteger(index)) working[root][index] = Number(input.value);
      } else if (root !== undefined && root in working) {
        (working as unknown as Record<string, unknown>)[root] = Number(input.value);
      } else return;
      this.#dirty = true;
    }

    #isFresh(): boolean {
      const current = getCity();
      if (current === this.#source) return true;
      this.#stale();
      return false;
    }

    #stale(): void {
      if (this.#source === null) return;
      void this.close();
      ui.notifications?.warn("Nixie: the city changed while the district editor was open; no edits were applied.");
    }

    async #changeDistrict(id: string): Promise<void> {
      if (!this.#isFresh()) return;
      if (this.#dirty) {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Nixie: Discard edits?" },
          content: "Discard unsaved district edits?",
          rejectClose: false,
          modal: true
        });
        if (confirmed !== true) {
          void this.render({ force: true });
          return;
        }
      }
      const city = getCity();
      const next = city === null ? null : districtParams(city, id);
      if (next === null || city === null) return;
      this.#districtId = id;
      this.#working = next;
      this.#source = city;
      this.#dirty = false;
      void this.render({ force: true });
    }

    async #applyPreset(): Promise<void> {
      if (!this.#isFresh() || this.#working === null) return;
      const preset = copyDistrictPreset(this.#presetId);
      if (preset === null) return;
      const seed = this.#working.seed;
      const name = this.#working.name;
      this.#working = { id: this.#districtId, ...cloneParams({ ...preset, seed, name }) };
      this.#dirty = true;
      void this.render({ force: true });
    }

    async #apply(): Promise<void> {
      if (this.#saving || !this.#isFresh() || this.#working === null || !this.#dirty) return;
      this.#saving = true;
      try {
        const { id, name, ...params } = this.#working;
        await applyDistrictParams(id, id === BASE_ID ? params : { ...params, name });
        this.#source = getCity();
        this.#dirty = false;
        if (this.#source !== null) {
          ui.notifications?.info(`Nixie: applied district ${districtLabel(this.#source, id)}.`);
        }
        void this.render({ force: true });
      } catch (err) {
        console.error("nixie | district apply failed", err);
        ui.notifications?.error(`Nixie: district apply failed — ${(err as Error).message}`);
      } finally {
        this.#saving = false;
      }
    }

    async #reseed(): Promise<void> {
      if (!this.#isFresh()) return;
      if (this.#dirty) {
        ui.notifications?.warn("Nixie: apply or cancel district edits before reseeding.");
        return;
      }
      try {
        await reseedDistrict(this.#districtId);
        const city = getCity();
        const next = city === null ? null : districtParams(city, this.#districtId);
        if (city !== null && next !== null) {
          this.#source = city;
          this.#working = next;
          this.#dirty = false;
          void this.render({ force: true });
        }
        ui.notifications?.info("Nixie: district reseeded.");
      } catch (err) {
        console.error("nixie | district reseed failed", err);
        ui.notifications?.error(`Nixie: district reseed failed — ${(err as Error).message}`);
      }
    }

    _onClickAction(_event: PointerEvent, target: HTMLElement): void {
      const action = target.closest<HTMLElement>("[data-action]") ?? target;
      switch (action.dataset.action) {
        case "preset":
          void this.#applyPreset();
          return;
        case "apply":
          void this.#apply();
          return;
        case "reseed":
          void this.#reseed();
          return;
        case "palette":
          if (!this.#isFresh()) return;
          if (this.#dirty) {
            ui.notifications?.warn("Nixie: apply or cancel district edits before opening the palette.");
            return;
          }
          openPaletteApp(this.#districtId);
          return;
        case "cancel":
          void this.close();
          return;
        default:
          return;
      }
    }

    async _preClose(): Promise<void> {
      this.#dirty = false;
    }
  };
  return cached;
}

let instance: any = null;

export function openDistrictApp(): void {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Nixie: the district editor is GM-only.");
    return;
  }
  if (!isMounted()) {
    ui.notifications?.warn("Nixie: enable the city on this scene first.");
    return;
  }
  instance ??= new (districtAppClass())();
  if (instance.rendered === true) {
    instance.bringToFront();
    return;
  }
  void instance.render({ force: true });
}
