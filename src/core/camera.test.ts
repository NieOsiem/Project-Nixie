import { describe, expect, it } from "vitest";
import { cameraEquals, cloneCamera, visibleWorldRect, type CameraState } from "./camera.js";

const cam = (over: Partial<CameraState> = {}): CameraState => ({
  x: 0,
  y: 0,
  scale: 1,
  screenWidth: 3440,
  screenHeight: 1440,
  ...over
});

describe("visibleWorldRect", () => {
  it("is the screen itself at identity", () => {
    expect(visibleWorldRect(cam())).toEqual({ x: 0, y: 0, width: 3440, height: 1440 });
  });

  it("inverts the stage translation", () => {
    const r = visibleWorldRect(cam({ x: -500, y: -250 }));
    expect(r.x).toBe(500);
    expect(r.y).toBe(250);
  });

  it("grows the visible area as zoom decreases", () => {
    const r = visibleWorldRect(cam({ scale: 0.25 }));
    expect(r.width).toBe(3440 * 4);
    expect(r.height).toBe(1440 * 4);
  });

  it("combines translation and zoom", () => {
    const r = visibleWorldRect(cam({ x: -1000, y: -400, scale: 2 }));
    expect(r).toEqual({ x: 500, y: 200, width: 1720, height: 720 });
  });

  it("falls back to scale 1 rather than dividing by zero", () => {
    expect(visibleWorldRect(cam({ scale: 0 }))).toEqual({ x: 0, y: 0, width: 3440, height: 1440 });
  });
});

describe("cameraEquals", () => {
  it("is false against a null previous state", () => {
    expect(cameraEquals(null, cam())).toBe(false);
  });

  it("is true for identical state", () => {
    expect(cameraEquals(cam(), cam())).toBe(true);
  });

  it.each([["x", { x: 1 }], ["y", { y: 1 }], ["scale", { scale: 1.5 }], ["screenWidth", { screenWidth: 1 }], ["screenHeight", { screenHeight: 1 }]] as const)(
    "detects a change in %s",
    (_label, over) => {
      expect(cameraEquals(cam(), cam(over))).toBe(false);
    }
  );
});

describe("cloneCamera", () => {
  it("copies by value", () => {
    const a = cam();
    const b = cloneCamera(a);
    a.x = 999;
    expect(b.x).toBe(0);
    expect(cameraEquals(b, cam())).toBe(true);
  });
});
