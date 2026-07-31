import {
  applyRecommendedFog,
  cancelPalettePreview,
  commitDistrictPalette,
  listDistricts,
  previewDistrictPalette,
  type DistrictRef
} from "../adapter/canvas.js";
import { MODULE_ID } from "../constants.js";
import {
  DISTRICT_SLOT_LABELS,
  EMISSIVE_MAX,
  PALETTE_PRESETS,
  normalizePalette,
  presetByName,
  type DistrictPalette,
  type RGB
} from "../core/palette.js";

const APP_ID = "nixie-palette";

/** Surface a failure rather than leaving an unhandled rejection in the console. */
function report(label: string, work: Promise<unknown>, then?: () => void): void {
  void work.then(then).catch((err) => {
    console.error(`${MODULE_ID} | ${label} failed`, err);
    ui.notifications?.error(`Nixie: ${label} failed — ${err.message}`);
  });
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const channelHex = (v: number): string =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");

/**
 * WHY: the picker is 8-bit and the palette is float, so the first edit of a slot quantises
 * it. `round(v*255)` then `/255` is a fixed point of itself, so later edits cannot walk the
 * value further — and `packPalette` quantises to the same 8 bits anyway, so nothing is lost.
 */
const toHex = (c: RGB): string => `#${channelHex(c.r)}${channelHex(c.g)}${channelHex(c.b)}`;

const fromHex = (hex: string): RGB => {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

const escapeHTML = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * WHY: v12.343 ships ApplicationV2 (`client-esm/applications/api/application.mjs`) but the
 * Handlebars mixin renders only from `.hbs` files on disk, and this module ships none.
 * Overriding `_renderHTML`/`_replaceHTML` directly is the documented escape hatch
 * (`application.mjs:528`) and keeps the module template-free.
 */
function applicationBase(): unknown {
  return foundry?.applications?.api?.ApplicationV2 ?? null;
}

let cached: any = null;

function paletteAppClass(): any {
  if (cached !== null) return cached;
  const Base = applicationBase() as any;
  if (!Base) throw new Error("ApplicationV2 is unavailable — Foundry's application API moved.");

  cached = class NixiePaletteApp extends Base {
    static DEFAULT_OPTIONS = {
      id: APP_ID,
      classes: ["nixie-palette"],
      window: {
        title: "Nixie: District Palette",
        icon: "fa-solid fa-palette",
        resizable: true
      },
      position: { width: 560, height: "auto" }
    };

    #districts: DistrictRef[] = [];
    #districtId = "";
    #working: DistrictPalette = normalizePalette(null);
    #presetName: string = PALETTE_PRESETS[0]?.name ?? "";

    selectDistrict(id: string): boolean {
      const district = listDistricts().find((candidate) => candidate.id === id);
      if (district === undefined) return false;
      cancelPalettePreview();
      this.#districtId = district.id;
      this.#working = normalizePalette(district.palette);
      return true;
    }

    _canRender(): void {
      if (!game.user?.isGM) throw new Error("Nixie: the palette editor is GM-only.");
    }

    /** Read the districts fresh every render — undo/redo can move a palette underneath us. */
    async _prepareContext(options: any): Promise<Record<string, never>> {
      this.#districts = listDistricts();
      const current = this.#districts.find((d) => d.id === this.#districtId);
      if (options.isFirstRender || current === undefined) {
        const district = current ?? this.#districts[0];
        this.#districtId = district?.id ?? "";
        this.#working = normalizePalette(district?.palette);
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
      const districts = this.#districts
        .map(
          (d) =>
            `<option value="${escapeHTML(d.id)}"${d.id === this.#districtId ? " selected" : ""}>` +
            `${escapeHTML(d.label)}</option>`
        )
        .join("");

      const presets = PALETTE_PRESETS.map(
        (p) =>
          `<option value="${escapeHTML(p.name)}"${p.name === this.#presetName ? " selected" : ""}>` +
          `${escapeHTML(p.name)}</option>`
      ).join("");

      // A range input snaps its value to the step grid; 0.01 covers every 2-decimal preset
      // strength, so the thumb never sits somewhere the readout disagrees with.
      const rows = DISTRICT_SLOT_LABELS.map(([slot, label]) => {
        const m = this.#working.materials[slot]!;
        return `<tr data-slot="${slot}">
          <td>${escapeHTML(label)}</td>
          <td><input type="color" data-field="base" value="${toHex(m.base)}"></td>
          <td><input type="color" data-field="emissive" value="${toHex(m.emissive)}"></td>
          <td><input type="range" data-field="strength" min="0" max="${EMISSIVE_MAX}" step="0.01"
                     value="${m.emissiveStrength}"></td>
          <td data-field="strengthValue">${m.emissiveStrength.toFixed(2)}</td>
        </tr>`;
      }).join("");

      return `<div class="form-group">
        <label>District</label>
        <div class="form-fields"><select data-nixie="district">${districts}</select></div>
      </div>
      <div class="form-group">
        <label>Preset</label>
        <div class="form-fields">
          <select data-nixie="preset">${presets}</select>
          <button type="button" data-action="applyPreset">Apply</button>
        </div>
      </div>
      <table data-nixie="slots" style="table-layout:fixed;width:100%">
        <thead><tr><th>Slot</th><th>Base</th><th>Emissive</th><th>Emission</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <footer class="form-footer" style="display:flex;gap:4px;margin-top:8px">
        <button type="button" data-action="fog"><i class="fa-solid fa-smog"></i> Recommended Fog</button>
        <button type="button" data-action="save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
      </footer>`;
    }

    /** Listeners bind to nodes `_replaceHTML` just created, so they cannot accumulate. */
    _onRender(): void {
      const root = this.element as HTMLElement;

      root.querySelector('[data-nixie="district"]')?.addEventListener("change", (event: Event) => {
        cancelPalettePreview();
        this.#districtId = (event.target as HTMLSelectElement).value;
        const district = this.#districts.find((d) => d.id === this.#districtId);
        this.#working = normalizePalette(district?.palette);
        void this.render();
      });

      root.querySelector('[data-nixie="preset"]')?.addEventListener("change", (event: Event) => {
        this.#presetName = (event.target as HTMLSelectElement).value;
      });

      root
        .querySelector('[data-nixie="slots"]')
        ?.addEventListener("input", (event: Event) => this.#onSlotInput(event));
    }

    #onSlotInput(event: Event): void {
      const input = event.target as HTMLInputElement;
      const row = input.closest("[data-slot]") as HTMLElement | null;
      if (row === null) return;
      const material = this.#working.materials[Number(row.dataset.slot)];
      if (material === undefined) return;

      switch (input.dataset.field) {
        case "base":
          material.base = fromHex(input.value);
          break;
        case "emissive":
          material.emissive = fromHex(input.value);
          break;
        case "strength": {
          material.emissiveStrength = Number(input.value);
          const readout = row.querySelector('[data-field="strengthValue"]');
          if (readout !== null) readout.textContent = material.emissiveStrength.toFixed(2);
          break;
        }
        default:
          return;
      }
      previewDistrictPalette(this.#districtId, this.#working);
    }

    _onClickAction(_event: PointerEvent, target: HTMLElement): void {
      switch (target.dataset.action) {
        case "applyPreset": {
          const preset = presetByName(this.#presetName);
          if (preset === null) return;
          this.#working = normalizePalette(preset);
          previewDistrictPalette(this.#districtId, this.#working);
          void this.render();
          return;
        }
        case "save":
          report("palette save", commitDistrictPalette(this.#districtId, this.#working), () =>
            ui.notifications?.info(`Nixie: saved palette for ${this.#districtId}.`)
          );
          return;
        case "fog":
          void this.#applyFog();
          return;
        case "cancel":
          void this.close();
          return;
        default:
          return;
      }
    }

    async #applyFog(): Promise<void> {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Nixie: Recommended Fog" },
        content:
          "<p>Overwrite this scene's fog and background colours with the palette's recommendation?</p>",
        rejectClose: false,
        modal: true
      });
      if (confirmed !== true) return;
      report("fog update", applyRecommendedFog(), () =>
        ui.notifications?.info("Nixie: scene fog colours updated.")
      );
    }

    /** Closing always drops the preview; after a save the persisted palette is the edited one. */
    async _preClose(): Promise<void> {
      cancelPalettePreview();
    }
  };

  return cached;
}

let instance: any = null;

export function openPaletteApp(districtId?: string): void {
  if (!game.user?.isGM) {
    ui.notifications?.warn("Nixie: the palette editor is GM-only.");
    return;
  }
  const districts = listDistricts();
  if (districts.length === 0) {
    ui.notifications?.warn("Nixie: enable the city on this scene first.");
    return;
  }
  // WHY one instance: the app takes a fixed DOM id, and `foundry.applications.instances` is
  // keyed on it — a second instance would deregister the first's entry when it closed.
  instance ??= new (paletteAppClass())();
  if (districtId !== undefined && instance.selectDistrict(districtId) !== true) {
    ui.notifications?.warn(`Nixie: district ${districtId} no longer exists.`);
    return;
  }
  if (instance.rendered === true) {
    void instance.render({ force: true });
    instance.bringToFront();
    return;
  }
  // ApplicationV2 aborts a first render that is not forced — application.mjs:400.
  void instance.render({ force: true });
}
