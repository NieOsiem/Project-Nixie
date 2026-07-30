export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Transform2D {
  x: number;
  y: number;
  scale: number;
}

/**
 * Camera state sampled from the host canvas.
 *
 * The host pins a world point (the pivot) to a screen point (the stage translation):
 *   screen = (world - pivot) * scale + stage
 * Dropping the pivot term still looks correct on screen, because the offscreen pass
 * and the presented quad shift by equal and opposite amounts — but the content slides
 * off the render target as scale grows. Keep both terms.
 */
export interface CameraState {
  /** Stage translation in screen pixels. */
  stageX: number;
  stageY: number;
  /** Stage pivot in world coordinates. */
  pivotX: number;
  pivotY: number;
  scale: number;
  screenWidth: number;
  screenHeight: number;
}

// WHY: negating a zero offset yields -0, which is harmless arithmetically but shows up
// in debug dumps and fails Object.is-based assertions.
const noNegativeZero = (v: number): number => (v === 0 ? 0 : v);

const safeScale = (c: CameraState): number => (c.scale > 0 ? c.scale : 1);

/** The region of world space currently on screen. */
export function visibleWorldRect(c: CameraState): Rect {
  const scale = safeScale(c);
  return {
    x: noNegativeZero(c.pivotX - c.stageX / scale),
    y: noNegativeZero(c.pivotY - c.stageY / scale),
    width: c.screenWidth / scale,
    height: c.screenHeight / scale
  };
}

/**
 * Transform mapping world coordinates onto pixels of an offscreen target sized
 * `screen * renderScale`. Composing it with `visibleWorldRect` round-trips: the
 * top-left of the visible rect lands on target pixel (0, 0), the bottom-right on
 * (width, height).
 */
export function offscreenTransform(c: CameraState, renderScale: number): Transform2D {
  const scale = safeScale(c);
  return {
    x: noNegativeZero((c.stageX - c.pivotX * scale) * renderScale),
    y: noNegativeZero((c.stageY - c.pivotY * scale) * renderScale),
    scale: scale * renderScale
  };
}

export function cameraEquals(a: CameraState | null, b: CameraState): boolean {
  return (
    a !== null &&
    a.stageX === b.stageX &&
    a.stageY === b.stageY &&
    a.pivotX === b.pivotX &&
    a.pivotY === b.pivotY &&
    a.scale === b.scale &&
    a.screenWidth === b.screenWidth &&
    a.screenHeight === b.screenHeight
  );
}

export function cloneCamera(c: CameraState): CameraState {
  return {
    stageX: c.stageX,
    stageY: c.stageY,
    pivotX: c.pivotX,
    pivotY: c.pivotY,
    scale: c.scale,
    screenWidth: c.screenWidth,
    screenHeight: c.screenHeight
  };
}
