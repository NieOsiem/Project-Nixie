/**
 * Animated weather overlay: rain, ground splashes and a drifting haze band, in one pass.
 *
 * Deliberately **not** part of the post chain. The settled city frame is cached and stationary
 * frames draw nothing, so any time-varying term in the composite would defeat that cache and
 * charge the whole city cost at 60 fps forever. This is a separate quad over the presented
 * texture: Foundry constructs `PIXI.Application` with the default `autoStart` and never stops
 * the ticker (`client/pixi/board.js:583`), so the stage redraws every frame regardless and this
 * pass costs its own fill and nothing else.
 *
 * Both samplers are textures that already exist — the composite output for local light and the
 * scene target's alpha for height and coverage — so the overlay adds no pass upstream of itself.
 */
import { SCENE_ALPHA_FLOOR, SCENE_HEIGHT_NORM_M } from "./scene-alpha.js";

/**
 * Fall represented by one streak, in metres. Not the whole visible fall: the streak is a motion
 * blur, and this feeds the projection term below, where it decides how hard rain fans outward.
 */
export const RAIN_FALL_M = 1.6;

/**
 * Wind direction, screen axes (+y is down). Constant rather than a dial: it has to be a unit
 * vector and `LookDials` is validated as plain finite numbers, so an angle dial would need its
 * own path for a knob nobody is going to turn twice.
 *
 * Exactly unit-length, and a test holds it there — its length multiplies both `rainStreakPx` and
 * `hazeDrift`, so a stray value silently means neither dial reads in the unit it claims.
 */
export const WIND_DIR = [0.8, 0.6] as const;

/** Drop lattice steps per second. Constant across the frame — see the WHY on `rainLayer`. */
export const FALL_RATE = 5.5;

/** Splash rings started per cell per second. */
export const SPLASH_RATE = 1.15;

/**
 * Length, in lattice cells, of the per-drop jitter sequence down one column.
 *
 * Exists purely so the clock wrap is seamless: `uTime` has to wrap somewhere, and a wrap shifts
 * the along-lattice cell index by `TIME_WRAP_S * FALL_RATE`. Keying the jitter to the cell index
 * modulo this, with the shift an exact multiple of it, leaves the pattern identical across the
 * wrap. `weather-overlay.ts` holds the wrap and a test pins the divisibility both ways.
 */
export const JITTER_CYCLE = 8;

export const WEATHER_FRAG = `
precision highp float;

uniform sampler2D uCity;
uniform sampler2D uHeight;
uniform vec2 uUvScale;
uniform vec2 uPivotUv;
uniform vec2 uWorldOriginM;
uniform vec2 uWorldSizeM;
uniform vec2 uHazeOffsetM;
uniform float uPxPerMetre;
uniform float uRadialSmear;
uniform float uTime;
uniform float uRainStrength;
uniform float uRainDrops;
uniform float uRainStreakPx;
uniform float uRainLit;
uniform float uSplashStrength;
uniform float uHazeStrength;
uniform float uHazeBandM;
uniform float uHazeInscatter;
uniform float uFogTintR;
uniform float uFogTintG;
uniform float uFogTintB;

varying vec2 vUv;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SCENE_HEIGHT_NORM_M = ${SCENE_HEIGHT_NORM_M}.0;
const float SCENE_ALPHA_FLOOR = ${SCENE_ALPHA_FLOOR};
const float ALPHA_BACKGROUND = ${SCENE_ALPHA_FLOOR * 0.5};

const vec2 WIND = vec2(${WIND_DIR[0]}, ${WIND_DIR[1]});

/**
 * The drop and splash lattices are metered in **screen pixels** off a world-anchored origin.
 *
 * World-metre cells would be the obvious choice and are wrong twice over: a drop is inherently
 * a thin line, so at any zoom where its width falls under a pixel it aliases into shimmer, and
 * the on-screen count would grow with the visible area until a 7 km view is a solid sheet.
 * Anchoring the origin in the world but sizing the cells in pixels keeps density and streak
 * length fixed on screen while the pattern still pans with the city. Zooming re-lays the
 * lattice, which is one discrete step per wheel notch and reads as nothing.
 */
const float NEAR_SPACING_PX = 44.0;
const float NEAR_PERIOD_PX = 210.0;
const float NEAR_HALF_PX = 0.9;
const float FAR_SPACING_PX = 21.0;
const float FAR_PERIOD_PX = 132.0;
const float FAR_HALF_PX = 0.55;
const float FAR_WEIGHT = 0.45;
const float FALL_RATE = ${FALL_RATE};
const float JITTER_CYCLE = ${JITTER_CYCLE}.0;
const float RAIN_AMBIENT = 0.10;
const vec3 RAIN_TINT = vec3(0.40, 0.48, 0.60);
const float RAIN_LIGHT_GAIN = 1.5;

const float SPLASH_SPACING_PX = 118.0;
const float SPLASH_RADIUS_PX = 27.0;
const float SPLASH_RING_PX = 3.0;
const float SPLASH_RATE = ${SPLASH_RATE};
const float SPLASH_MAX_HEIGHT_M = 2.5;

const float HAZE_COARSE_M = 92.0;
const float HAZE_FINE_M = 34.0;
const float HAZE_BAND_FEATHER_M = 22.0;

float hash11(float x) {
  return fract(sin(x * 78.233) * 43758.5453);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/**
 * One layer of drops, in the streak's own frame so the lattice bends with the projection.
 *
 * WHY the fall rate is a constant and never a per-fragment value: the phase gradient of a
 * spatially varying rate grows linearly with t, so within a minute the lattice is scrambled at
 * every scale. Only the streak's direction and length may vary across the frame, never its speed.
 */
float rainLayer(
  vec2 p,
  vec2 tAxis,
  vec2 nAxis,
  float lenPx,
  float spacingPx,
  float periodPx,
  float halfPx
) {
  float a = dot(p, nAxis);
  float cx = floor(a / spacingPx);
  float gy = dot(p, tAxis) / periodPx - uTime * FALL_RATE + hash11(cx * 1.7);
  float cy = floor(gy);

  // Jitter confined to the middle half of the cell: a drop straddling a cell edge would be cut
  // in half, and reading the neighbouring cell to stitch it back costs twice the lattice for a
  // pattern nobody can resolve at 1.8 px wide. Keyed to the cell index modulo JITTER_CYCLE so
  // the clock wrap cannot reshuffle every drop on screen in one frame.
  float jitter = spacingPx * (0.25 + 0.5 * hash21(vec2(cx, mod(cy, JITTER_CYCLE))));
  float across = 1.0 - smoothstep(0.0, halfPx, abs(a - cx * spacingPx - jitter));

  // Clamped so a long streak cannot overrun its own cell and get chopped at the boundary.
  float reach = min(lenPx, periodPx * 0.8);
  float s = (gy - cy) * periodPx / max(reach, 1.0);
  // Brightest at the leading tip, fading back down the tail, nothing past the tip.
  return across * s * s * (1.0 - step(1.0, s));
}

/** One expanding ring per cell per period, fading as it grows. */
float splashRing(vec2 p) {
  vec2 g = p / SPLASH_SPACING_PX;
  vec2 cell = floor(g);
  vec2 f = (g - cell) * SPLASH_SPACING_PX;
  vec2 site = SPLASH_SPACING_PX * vec2(
    0.2 + 0.6 * hash21(cell),
    0.2 + 0.6 * hash21(cell + 19.7));
  float life = fract(uTime * SPLASH_RATE + hash21(cell + 4.3));
  float ring = 1.0 - smoothstep(
    0.0,
    SPLASH_RING_PX,
    abs(length(f - site) - life * SPLASH_RADIUS_PX));
  return ring * (1.0 - life);
}

void main() {
  vec2 uv = vUv * uUvScale;
  vec4 encoded = texture2D(uHeight, uv);

  // Alpha 0 is cleared background, so this is everything outside the city. Discarding is free
  // here — unlike the city mesh there is no depth buffer and no early-Z to lose.
  if (encoded.a < ALPHA_BACKGROUND) discard;

  float heightM = max(encoded.a - SCENE_ALPHA_FLOOR, 0.0)
    / (1.0 - SCENE_ALPHA_FLOOR) * SCENE_HEIGHT_NORM_M;

  vec2 worldM = uWorldOriginM + vUv * uWorldSizeM;
  vec2 p = worldM * uPxPerMetre;

  // Wind smears every drop the same way; the radial term is the projection's own, so a drop
  // leans away from the pivot exactly as a building does and rain fans out toward the edges.
  // Adding the two as vectors also removes the singularity a normalize at the pivot would have.
  vec2 fromPivotPx = (vUv - uPivotUv) * uWorldSizeM * uPxPerMetre;
  vec2 smearPx = WIND * uRainStreakPx + fromPivotPx * uRadialSmear;
  float lenPx = length(smearPx);
  vec2 tAxis = smearPx / max(lenPx, 0.001);
  vec2 nAxis = vec2(-tAxis.y, tAxis.x);

  vec3 light = texture2D(uCity, uv).rgb;
  // Light-aware: water is only visible where something lights it, so drops glow under neon and
  // all but vanish in a dark alley.
  float lit = RAIN_AMBIENT + dot(light, LUMA) * uRainLit;

  float drops =
    rainLayer(p, tAxis, nAxis, lenPx, NEAR_SPACING_PX, NEAR_PERIOD_PX, NEAR_HALF_PX)
    + FAR_WEIGHT * rainLayer(
      p + vec2(37.0, 91.0),
      tAxis,
      nAxis,
      lenPx * 0.7,
      FAR_SPACING_PX,
      FAR_PERIOD_PX,
      FAR_HALF_PX);

  float ground = 1.0 - smoothstep(0.0, SPLASH_MAX_HEIGHT_M, heightM);
  float water = (clamp(drops, 0.0, 1.0) * uRainDrops + splashRing(p) * ground * uSplashStrength)
    * lit * uRainStrength;

  // Haze drifts on an accumulated offset rather than on uTime: uTime wraps, and value noise is
  // not periodic, so deriving the drift from it would repattern the whole veil in one frame.
  vec2 hp = worldM + uHazeOffsetM;
  float veil = valueNoise(hp / HAZE_COARSE_M) * 0.66 + valueNoise(hp / HAZE_FINE_M) * 0.34;
  // Everything under the band is veiled and the tops of the tall towers are not, which is what
  // reads as low cloud drifting through them. The composite's fog is radial and fills the street
  // canyons; this is the complement, and the two are tuned against each other.
  float below = 1.0
    - smoothstep(uHazeBandM - HAZE_BAND_FEATHER_M, uHazeBandM + HAZE_BAND_FEATHER_M, heightM);
  float haze = uHazeStrength * below * smoothstep(0.34, 0.86, veil) * uRainStrength;

  vec3 waterC = RAIN_TINT + light * RAIN_LIGHT_GAIN;
  vec3 hazeC = vec3(uFogTintR, uFogTintG, uFogTintB) + light * uHazeInscatter;

  // Premultiplied, matching the NORMAL blend this quad draws with. Dividing by max(a, 1) keeps
  // colour and alpha consistent when dense rain and haze land on the same pixel, where a bare
  // clamp on alpha alone would leave the premultiplied colour over-bright.
  float a = water + haze;
  float norm = max(a, 1.0);
  gl_FragColor = vec4((water * waterC + haze * hazeC) / norm, a / norm);
}
`;
