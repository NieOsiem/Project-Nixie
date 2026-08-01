import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_ZOOM_MODE,
  MODULE_ID,
  SETTING_ANTIALIAS,
  SETTING_ANTIALIAS_FACTOR,
  SETTING_CAMERA_ZOOM_MODE,
  SETTING_RAIN_STRENGTH
} from "./constants.js";
import { registerSettings, setSettingValue, settingValue } from "./settings.js";

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

  it("leaves rain unbounded, so the console can push it past any slider range", () => {
    // The bug: a `range` both renders a slider AND makes setSettingValue clamp to it, so
    // api.setRain(5) silently stored 2. Rain has no range on purpose — it is a free number.
    registerSettings();

    const definition = registered.get(`${MODULE_ID}.${SETTING_RAIN_STRENGTH}`);
    expect(definition).toMatchObject({ scope: "world", config: true, type: Number, default: 1 });
    expect(definition).not.toHaveProperty("range");
  });

  it("stores a rain value far outside any slider range untouched", async () => {
    registerSettings();
    (globalThis as any).game.settings.set = vi.fn((moduleId: string, key: string, value: unknown) => {
      values.set(`${moduleId}.${key}`, value);
      return Promise.resolve();
    });

    await setSettingValue(SETTING_RAIN_STRENGTH, 12.5);
    expect(settingValue<number>(SETTING_RAIN_STRENGTH)).toBe(12.5);
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
