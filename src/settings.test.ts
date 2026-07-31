import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_ZOOM_MODE,
  MODULE_ID,
  SETTING_ANTIALIAS,
  SETTING_ANTIALIAS_FACTOR,
  SETTING_CAMERA_ZOOM_MODE
} from "./constants.js";
import { registerSettings } from "./settings.js";

describe("camera zoom setting", () => {
  const registered = new Map<string, Record<string, any>>();
  const values = new Map<string, unknown>();

  beforeEach(() => {
    registered.clear();
    values.clear();
    (globalThis as any).game = {
      settings: {
        settings: registered,
        register: vi.fn((moduleId: string, key: string, definition: Record<string, any>) => {
          const id = `${moduleId}.${key}`;
          registered.set(id, definition);
          values.set(id, definition.default);
        }),
        get: (moduleId: string, key: string) => values.get(`${moduleId}.${key}`)
      }
    };
  });

  afterEach(() => {
    delete (globalThis as any).game;
  });

  it("offers Dolly and Fixed modes and defaults to Dolly", () => {
    registerSettings();

    const definition = registered.get(`${MODULE_ID}.${SETTING_CAMERA_ZOOM_MODE}`);
    expect(definition).toMatchObject({
      scope: "world",
      config: true,
      type: String,
      default: CAMERA_ZOOM_MODE.DOLLY,
      choices: {
        [CAMERA_ZOOM_MODE.DOLLY]: "Dolly",
        [CAMERA_ZOOM_MODE.FIXED]: "Fixed Altitude"
      }
    });
  });

  it("registers client supersampling on at 1.5x by default", () => {
    registerSettings();

    expect(registered.get(`${MODULE_ID}.${SETTING_ANTIALIAS}`)).toMatchObject({
      scope: "client",
      config: true,
      type: Boolean,
      default: true
    });
    expect(registered.get(`${MODULE_ID}.${SETTING_ANTIALIAS_FACTOR}`)).toMatchObject({
      scope: "client",
      config: true,
      type: Number,
      range: { min: 1.25, max: 2, step: 0.25 },
      default: 1.5
    });
  });
});
