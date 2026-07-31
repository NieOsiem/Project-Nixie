import { cameraEquals, cloneCamera, type CameraState } from "../core/camera.js";

export const FRAME_QUALITY = {
  MOTION: "motion",
  SETTLED: "settled"
} as const;

export type FrameQuality = (typeof FRAME_QUALITY)[keyof typeof FRAME_QUALITY];

export interface FrameQualityProfile {
  shaderDetail: number;
  geometryDetail: "screen" | "all";
  shadows: boolean;
  supersample: boolean;
}

const PROFILES: Record<FrameQuality, FrameQualityProfile> = {
  [FRAME_QUALITY.MOTION]: {
    shaderDetail: 1,
    geometryDetail: "screen",
    shadows: true,
    supersample: false
  },
  [FRAME_QUALITY.SETTLED]: {
    shaderDetail: 1,
    geometryDetail: "all",
    shadows: true,
    supersample: true
  }
};

export function frameQualityProfile(quality: FrameQuality): FrameQualityProfile {
  return PROFILES[quality];
}

/** Debounces exact host-camera samples into one high-quality frame per gesture. */
export class FrameQualityController {
  readonly settleDelayMs: number;

  #lastCamera: CameraState | null = null;
  #settleAt = Infinity;
  #quality: FrameQuality = FRAME_QUALITY.MOTION;

  constructor(settleDelayMs = 120) {
    this.settleDelayMs = Math.max(0, settleDelayMs);
  }

  sample(camera: CameraState, nowMs: number): FrameQuality {
    if (!cameraEquals(this.#lastCamera, camera)) {
      this.#lastCamera = cloneCamera(camera);
      this.#settleAt = nowMs + this.settleDelayMs;
      this.#quality = FRAME_QUALITY.MOTION;
      return this.#quality;
    }

    if (this.#quality === FRAME_QUALITY.MOTION && nowMs >= this.#settleAt) {
      this.#quality = FRAME_QUALITY.SETTLED;
    }
    return this.#quality;
  }

  reset(): void {
    this.#lastCamera = null;
    this.#settleAt = Infinity;
    this.#quality = FRAME_QUALITY.MOTION;
  }
}
