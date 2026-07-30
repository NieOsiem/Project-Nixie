export const MODULE_ID = "project-nixie";

export const FLAG_ENABLED = "enabled";
export const FLAG_CITY = "city";
export const FLAG_GENERATED = "generated";

/** Shape of the persisted scene flag. Bump when the stored structure changes. */
export const CITY_FORMAT_VERSION = 1;

/**
 * Identifies the generation algorithm. Never change the output of an existing version —
 * bump this instead, so an in-progress campaign's city survives a module update.
 */
export const GENERATOR_VERSION = 1;
