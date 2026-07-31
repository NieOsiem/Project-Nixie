export const MODULE_ID = "project-nixie";

export const FLAG_ENABLED = "enabled";
export const FLAG_CITY = "city";
export const FLAG_GENERATED = "generated";

/** Shape of the persisted scene flag. Bump when the stored structure changes. */
export const CITY_FORMAT_VERSION = 4;

/**
 * Identifies the generation algorithm. Never change the output of an existing version —
 * bump this instead, so an in-progress campaign's city survives a module update.
 */
export const GENERATOR_VERSION = 6;

/** Client and world settings, registered in `settings.ts`. */
export const SETTING_CAMERA_HEIGHT = "cameraHeightM";
export const SETTING_CAMERA_ZOOM_MODE = "cameraZoomMode";
export const SETTING_RENDER_SCALE = "renderScale";
export const SETTING_ANTIALIAS = "antialias";
export const SETTING_ANTIALIAS_FACTOR = "antialiasFactor";
export const SETTING_BLOOM = "bloom";
export const SETTING_BLOOM_STRENGTH = "bloomStrength";

export const CAMERA_ZOOM_MODE = {
  FIXED: "fixed",
  DOLLY: "dolly"
} as const;

export type CameraZoomMode = (typeof CAMERA_ZOOM_MODE)[keyof typeof CAMERA_ZOOM_MODE];
