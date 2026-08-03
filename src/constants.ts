export const MODULE_ID = "project-nixie";

export const FLAG_ENABLED = "enabled";
export const FLAG_CITY = "city";
export const FLAG_GENERATED = "generated";

/** City Generator 2.0 schema version. Independent from the generator algorithm version. */
export const CITY_SCHEMA_VERSION = 2;

/**
 * Identifies the generation algorithm. Never change the output of an existing version —
 * bump this instead, so an in-progress campaign's city survives a module update.
 */
export const GENERATOR_VERSION = 9;

/**
 * Weather presets. Stored strings, so renaming one strands an existing scene's setting.
 *
 * The dial values behind these are in `render/look-dials.ts`; the labels are in `settings.ts`.
 */
export const WEATHER = {
  CLEAR: "clear",
  DRIZZLE: "drizzle",
  RAIN: "rain",
  STORM: "storm"
} as const;

export type Weather = (typeof WEATHER)[keyof typeof WEATHER];

/** Client and world settings, registered in `settings.ts`. */
export const SETTING_CAMERA_HEIGHT = "cameraHeightM";
export const SETTING_CAMERA_ZOOM_MODE = "cameraZoomMode";
export const SETTING_RENDER_SCALE = "renderScale";
export const SETTING_ANTIALIAS = "antialias";
export const SETTING_ANTIALIAS_FACTOR = "antialiasFactor";
export const SETTING_BLOOM = "bloom";
export const SETTING_BLOOM_STRENGTH = "bloomStrength";
export const SETTING_RAIN_STRENGTH = "rainStrength";
export const SETTING_WEATHER = "weather";

export const CAMERA_ZOOM_MODE = {
  FIXED: "fixed",
  DOLLY: "dolly"
} as const;

export type CameraZoomMode = (typeof CAMERA_ZOOM_MODE)[keyof typeof CAMERA_ZOOM_MODE];
