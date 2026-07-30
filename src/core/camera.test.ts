import { describe, expect, it } from "vitest";
import {
  cameraEquals,
  cloneCamera,
  offscreenTransform,
  visibleWorldRect,
  type CameraState
} from "./camera.js";

const SCREEN_W = 3440;
const SCREEN_H = 1440;

/** Mirrors how the host pins a world point to the viewport centre. */
const cam = (over: Partial<CameraState> = {}): CameraState => ({
  stageX: SCREEN_W / 2,
  stageY: SCREEN_H / 2,
  pivotX: 0,
  pivotY: 0,
  scale: 1,
  screenWidth: SCREEN_W,
  screenHeight: SCREEN_H,
  ...over
});

const applyTransform = (t: { x: number; y: number; scale: number }, wx: number, wy: number) => ({
  x: wx * t.scale + t.x,
  y: wy * t.scale + t.y
});

describe("visibleWorldRect", () => {
  it("centres the visible region on the pivot", () => {
    const r = visibleWorldRect(cam({ pivotX: 5860, pivotY: 7340 }));
    expect(r.x + r.width / 2).toBe(5860);
    expect(r.y + r.height / 2).toBe(7340);
  });

  it("keeps the pivot centred as zoom changes", () => {
    for (const scale of [0.1, 0.5, 1, 3, 12]) {
      const r = visibleWorldRect(cam({ pivotX: 5860, pivotY: 7340, scale }));
      expect(r.x + r.width / 2).toBeCloseTo(5860, 6);
      expect(r.width).toBeCloseTo(SCREEN_W / scale, 6);
    }
  });

  it("is the screen itself at origin and identity zoom", () => {
    const r = visibleWorldRect(cam({ stageX: 0, stageY: 0 }));
    expect(r).toEqual({ x: 0, y: 0, width: SCREEN_W, height: SCREEN_H });
  });

  it("falls back to scale 1 rather than dividing by zero", () => {
    const r = visibleWorldRect(cam({ stageX: 0, stageY: 0, scale: 0 }));
    expect(r).toEqual({ x: 0, y: 0, width: SCREEN_W, height: SCREEN_H });
  });
});

describe("offscreenTransform", () => {
  // The regression that shipped in S0: dropping the pivot term shifted content off the
  // render target by pivot*scale, so it vanished as you zoomed in.
  it.each([
    ["origin", cam(), 1],
    ["offset pivot", cam({ pivotX: 5860, pivotY: 7340 }), 1],
    ["zoomed in on an offset pivot", cam({ pivotX: 5860, pivotY: 7340, scale: 4 }), 1],
    ["zoomed out on an offset pivot", cam({ pivotX: 5860, pivotY: 7340, scale: 0.25 }), 1],
    ["half render scale", cam({ pivotX: 5860, pivotY: 7340 }), 0.5],
    ["half render scale, zoomed in", cam({ pivotX: 1200, pivotY: 900, scale: 3 }), 0.5],
    ["quarter render scale", cam({ pivotX: -420, pivotY: 380, scale: 1.75 }), 0.25]
  ])("maps the visible rect onto the whole target: %s", (_label, c, renderScale) => {
    const rect = visibleWorldRect(c);
    const t = offscreenTransform(c, renderScale);

    const topLeft = applyTransform(t, rect.x, rect.y);
    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);

    const bottomRight = applyTransform(t, rect.x + rect.width, rect.y + rect.height);
    expect(bottomRight.x).toBeCloseTo(c.screenWidth * renderScale, 6);
    expect(bottomRight.y).toBeCloseTo(c.screenHeight * renderScale, 6);
  });

  it("scales the transform by the render scale", () => {
    const c = cam({ pivotX: 300, pivotY: 200, scale: 2 });
    expect(offscreenTransform(c, 0.5).scale).toBe(1);
    expect(offscreenTransform(c, 1).scale).toBe(2);
  });
});

describe("cameraEquals", () => {
  it("is false against a null previous state", () => {
    expect(cameraEquals(null, cam())).toBe(false);
  });

  it("is true for identical state", () => {
    expect(cameraEquals(cam(), cam())).toBe(true);
  });

  it.each([
    ["stageX", { stageX: 1 }],
    ["stageY", { stageY: 1 }],
    ["pivotX", { pivotX: 1 }],
    ["pivotY", { pivotY: 1 }],
    ["scale", { scale: 1.5 }],
    ["screenWidth", { screenWidth: 1 }],
    ["screenHeight", { screenHeight: 1 }]
  ] as const)("detects a change in %s", (_label, over) => {
    expect(cameraEquals(cam(), cam(over))).toBe(false);
  });
});

describe("cloneCamera", () => {
  it("copies by value", () => {
    const a = cam();
    const b = cloneCamera(a);
    a.stageX = 999;
    a.pivotX = 999;
    expect(cameraEquals(b, cam())).toBe(true);
  });
});
