import {
  setAntialias,
  setBloom,
  setCameraHeightM,
  setCameraZoomMode,
  setRain,
  setRenderScale
} from "./adapter/canvas.js";
import {
  CAMERA_ZOOM_MODE,
  MODULE_ID,
  SETTING_ANTIALIAS,
  SETTING_ANTIALIAS_FACTOR,
  SETTING_BLOOM,
  SETTING_BLOOM_STRENGTH,
  SETTING_CAMERA_HEIGHT,
  SETTING_CAMERA_ZOOM_MODE,
  SETTING_RAIN_STRENGTH,
  SETTING_RENDER_SCALE
} from "./constants.js";
import type { CameraZoomMode } from "./constants.js";

export type NixieSettingKey =
  | typeof SETTING_CAMERA_HEIGHT
  | typeof SETTING_CAMERA_ZOOM_MODE
  | typeof SETTING_RENDER_SCALE
  | typeof SETTING_ANTIALIAS
  | typeof SETTING_ANTIALIAS_FACTOR
  | typeof SETTING_BLOOM
  | typeof SETTING_BLOOM_STRENGTH
  | typeof SETTING_RAIN_STRENGTH;

interface SettingRange {
  min: number;
  max: number;
  step: number;
}

const RANGES: Partial<Record<NixieSettingKey, SettingRange>> = {
  [SETTING_CAMERA_HEIGHT]: { min: 150, max: 2000, step: 25 },
  [SETTING_RENDER_SCALE]: { min: 0.25, max: 1, step: 0.05 },
  [SETTING_ANTIALIAS_FACTOR]: { min: 1.25, max: 2, step: 0.25 },
  [SETTING_BLOOM_STRENGTH]: { min: 0, max: 2, step: 0.05 }
  // WHY no rainStrength range: a range makes it a slider AND makes `setSettingValue` clamp to it,
  // so the console could not push it past 2. Deliberately a free number input.
};

const DEFAULTS: Record<NixieSettingKey, number | boolean | CameraZoomMode> = {
  [SETTING_CAMERA_HEIGHT]: 500,
  [SETTING_CAMERA_ZOOM_MODE]: CAMERA_ZOOM_MODE.DOLLY,
  [SETTING_RENDER_SCALE]: 1,
  [SETTING_ANTIALIAS]: true,
  [SETTING_ANTIALIAS_FACTOR]: 1.5,
  [SETTING_BLOOM]: true,
  [SETTING_BLOOM_STRENGTH]: 1.35,
  [SETTING_RAIN_STRENGTH]: 1
};

/**
 * WHY: `game.settings.get` throws outright for a key it has not seen
 * (`client/core/settings.js:241`), so anything reading a dial before `init` — or on a client
 * where registration failed — has to fall back rather than blow up.
 */
export function settingValue<T>(key: NixieSettingKey): T {
  const registered = game?.settings?.settings?.has(`${MODULE_ID}.${key}`) === true;
  const value = registered ? game.settings.get(MODULE_ID, key) : undefined;
  return (value ?? DEFAULTS[key]) as T;
}

/**
 * WHY: `game.settings.set` only range-validates settings declared as a DataField
 * (`client/core/settings.js:213`), so a plain `type: Number` accepts anything the console
 * hands it. Clamp here or the sheet's slider and `module.api` disagree.
 */
export async function setSettingValue(
  key: NixieSettingKey,
  value: number | boolean | CameraZoomMode
): Promise<void> {
  const range = RANGES[key];
  const clamped =
    typeof value === "number" && range !== undefined
      ? Math.min(range.max, Math.max(range.min, value))
      : value;
  await game.settings.set(MODULE_ID, key, clamped);
}

/** Stored values are the truth on load; the adapter keeps them until a renderer mounts. */
export function applySettings(): void {
  setCameraHeightM(settingValue<number>(SETTING_CAMERA_HEIGHT));
  setCameraZoomMode(settingValue<CameraZoomMode>(SETTING_CAMERA_ZOOM_MODE));
  setRenderScale(settingValue<number>(SETTING_RENDER_SCALE));
  setAntialias(
    settingValue<boolean>(SETTING_ANTIALIAS),
    settingValue<number>(SETTING_ANTIALIAS_FACTOR)
  );
  setBloom(settingValue<boolean>(SETTING_BLOOM), settingValue<number>(SETTING_BLOOM_STRENGTH));
  setRain(settingValue<number>(SETTING_RAIN_STRENGTH));
}

export function registerSettings(): void {
  game.settings.register(MODULE_ID, SETTING_CAMERA_HEIGHT, {
    name: "Camera Height (m)",
    hint: "Height of the fake-3D camera above the city. Lower leans buildings harder; 2000 is near flat.",
    scope: "world",
    config: true,
    type: Number,
    range: RANGES[SETTING_CAMERA_HEIGHT],
    default: DEFAULTS[SETTING_CAMERA_HEIGHT],
    onChange: (value: number) => setCameraHeightM(value)
  });

  game.settings.register(MODULE_ID, SETTING_CAMERA_ZOOM_MODE, {
    name: "Camera Zoom Mode",
    hint: "Dolly changes lean with zoom. Fixed preserves the same perspective at every zoom level.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [CAMERA_ZOOM_MODE.DOLLY]: "Dolly",
      [CAMERA_ZOOM_MODE.FIXED]: "Fixed Altitude"
    },
    default: DEFAULTS[SETTING_CAMERA_ZOOM_MODE],
    onChange: (value: CameraZoomMode) => setCameraZoomMode(value)
  });

  game.settings.register(MODULE_ID, SETTING_RENDER_SCALE, {
    name: "Render Scale",
    hint: "Resolution of the city's offscreen target relative to the canvas. Drop it to buy frame rate.",
    scope: "client",
    config: true,
    type: Number,
    range: RANGES[SETTING_RENDER_SCALE],
    default: DEFAULTS[SETTING_RENDER_SCALE],
    onChange: (value: number) => setRenderScale(value)
  });

  game.settings.register(MODULE_ID, SETTING_ANTIALIAS, {
    name: "Antialiasing",
    hint: "Supersample one high-quality frame after panning stops. Disable this first on a weak client.",
    scope: "client",
    config: true,
    type: Boolean,
    default: DEFAULTS[SETTING_ANTIALIAS],
    onChange: (value: boolean) =>
      setAntialias(value, settingValue<number>(SETTING_ANTIALIAS_FACTOR))
  });

  game.settings.register(MODULE_ID, SETTING_ANTIALIAS_FACTOR, {
    name: "Antialiasing Factor",
    hint: "Settled-frame resolution multiplier. Its one-frame cost rises with the square of this value.",
    scope: "client",
    config: true,
    type: Number,
    range: RANGES[SETTING_ANTIALIAS_FACTOR],
    default: DEFAULTS[SETTING_ANTIALIAS_FACTOR],
    onChange: (value: number) =>
      setAntialias(settingValue<boolean>(SETTING_ANTIALIAS), value)
  });

  game.settings.register(MODULE_ID, SETTING_BLOOM, {
    name: "Bloom",
    hint: "Glow pass over emissive surfaces. Costs about 0.25 ms a frame.",
    scope: "client",
    config: true,
    type: Boolean,
    default: DEFAULTS[SETTING_BLOOM],
    onChange: (value: boolean) => setBloom(value, settingValue<number>(SETTING_BLOOM_STRENGTH))
  });

  game.settings.register(MODULE_ID, SETTING_BLOOM_STRENGTH, {
    name: "Bloom Strength",
    hint: "How hard the glow pass blooms. 0 is off in all but name.",
    scope: "world",
    config: true,
    type: Number,
    range: RANGES[SETTING_BLOOM_STRENGTH],
    default: DEFAULTS[SETTING_BLOOM_STRENGTH],
    onChange: (value: number) => setBloom(settingValue<boolean>(SETTING_BLOOM), value)
  });

  game.settings.register(MODULE_ID, SETTING_RAIN_STRENGTH, {
    name: "Rain",
    hint:
      "Rain, splashes and drifting haze. 0 is a dry night and costs nothing. Unbounded on purpose"
      + " — a plain number, not a slider, so it can be pushed as far as you like.",
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULTS[SETTING_RAIN_STRENGTH],
    onChange: (value: number) => setRain(value)
  });

  applySettings();
}
