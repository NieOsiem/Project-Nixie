export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Camera state sampled from the host canvas. `x`/`y` are the stage translation in
 * screen pixels, `scale` the stage zoom; a world point maps to `world * scale + xy`.
 */
export interface CameraState {
  x: number;
  y: number;
  scale: number;
  screenWidth: number;
  screenHeight: number;
}

// WHY: negating a zero stage offset yields -0, which is harmless arithmetically but
// shows up in debug dumps and fails Object.is-based assertions.
const noNegativeZero = (v: number): number => (v === 0 ? 0 : v);

/** The region of world space currently on screen. */
export function visibleWorldRect(c: CameraState): Rect {
  const scale = c.scale > 0 ? c.scale : 1;
  return {
    x: noNegativeZero(-c.x / scale),
    y: noNegativeZero(-c.y / scale),
    width: c.screenWidth / scale,
    height: c.screenHeight / scale
  };
}

export function cameraEquals(a: CameraState | null, b: CameraState): boolean {
  return (
    a !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.scale === b.scale &&
    a.screenWidth === b.screenWidth &&
    a.screenHeight === b.screenHeight
  );
}

export function cloneCamera(c: CameraState): CameraState {
  return { x: c.x, y: c.y, scale: c.scale, screenWidth: c.screenWidth, screenHeight: c.screenHeight };
}
