import { describe, expect, it } from "vitest";
import type { CameraState } from "../core/camera.js";
import {
  FRAME_QUALITY,
  FrameQualityController,
  frameQualityProfile
} from "./frame-quality.js";

const camera = (over: Partial<CameraState> = {}): CameraState => ({
  stageX: 500,
  stageY: 400,
  pivotX: 0,
  pivotY: 0,
  scale: 1,
  screenWidth: 1000,
  screenHeight: 800,
  ...over
});

describe("FrameQualityController", () => {
  it("settles once after the camera remains unchanged for the delay", () => {
    const quality = new FrameQualityController(120);

    expect(quality.sample(camera(), 0)).toBe(FRAME_QUALITY.MOTION);
    expect(quality.sample(camera(), 119)).toBe(FRAME_QUALITY.MOTION);
    expect(quality.sample(camera(), 120)).toBe(FRAME_QUALITY.SETTLED);
    expect(quality.sample(camera(), 500)).toBe(FRAME_QUALITY.SETTLED);
  });

  it("returns to motion and restarts the delay on any camera change", () => {
    const quality = new FrameQualityController(120);
    quality.sample(camera(), 0);
    expect(quality.sample(camera(), 120)).toBe(FRAME_QUALITY.SETTLED);

    expect(quality.sample(camera({ pivotX: 1 }), 121)).toBe(FRAME_QUALITY.MOTION);
    expect(quality.sample(camera({ pivotX: 1 }), 240)).toBe(FRAME_QUALITY.MOTION);
    expect(quality.sample(camera({ pivotX: 1 }), 241)).toBe(FRAME_QUALITY.SETTLED);
  });

  it("reset makes the next sample a new motion gesture", () => {
    const quality = new FrameQualityController(0);
    quality.sample(camera(), 0);
    expect(quality.sample(camera(), 0)).toBe(FRAME_QUALITY.SETTLED);

    quality.reset();
    expect(quality.sample(camera(), 10)).toBe(FRAME_QUALITY.MOTION);
  });
});

describe("frameQualityProfile", () => {
  it("keeps the full baseline look in motion and reserves geometry plus supersampling", () => {
    expect(frameQualityProfile(FRAME_QUALITY.MOTION)).toEqual({
      shaderDetail: 1,
      geometryDetail: "screen",
      shadows: true,
      supersample: false
    });
    expect(frameQualityProfile(FRAME_QUALITY.SETTLED)).toEqual({
      shaderDetail: 1,
      geometryDetail: "all",
      shadows: true,
      supersample: true
    });
  });
});
