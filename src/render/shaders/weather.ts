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
 * Formats a number as a GLSL float literal.
 *
 * WHY: ESSL 100 has no implicit int-to-float conversion, so `const float X = 4;` is a compile
 * error while `4.0` is fine. Interpolating a TS constant that happens to be whole is exactly how
 * that slips in — it type-checks, the string tests pass, and only the shader compiler objects.
 */
export const glslFloat = (value: number): string =>
  Number.isInteger(value) ? `${value}.0` : `${value}`;

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
 * Exactly unit-length, and a test holds it there — its length multiplies both `rainSpeedMPS` and
 * `hazeDrift`, so a stray value silently means neither dial reads in the unit it claims.
 */
export const WIND_DIR = [0.8, 0.6] as const;

/**
 * Every hash input is reduced modulo this.
 *
 * Two jobs. **Quality:** `sin()` of a large argument loses its randomness in float32, and cell
 * indices run to thousands, which correlated neighbouring columns into the visible bands the
 * first version had. **Periodicity:** it makes the field tile, so the fall accumulator can wrap
 * without reshuffling anything.
 *
 * Sized so the tile is always wider than the screen for whichever octave is active: the finest
 * octave is live around 300 px/m, where `128 × 0.18 m` is ~6900 px against a 3440 px panel. Do
 * not lower it without redoing that arithmetic.
 */
export const HASH_CYCLE = 128;

/**
 * **One** world-space lattice. There is one physical drop size, and it never changes.
 *
 * Two earlier versions got this wrong in opposite directions. A screen-space lattice of fixed
 * density and fixed drop size read as an overlay, because a world-anchored particle never holds a
 * constant screen size or count. Replacing it with band-passed octaves was worse: fading an octave
 * out once its drops went fat forced the *coarsest* lattice to be the only one at city zoom, whose
 * drops are 6.4 m wide in 46 × 230 m cells — so widening the view gave **fewer and bigger** drops,
 * backwards on both counts.
 *
 * The mistake behind both was treating "keep drops resolvable at every zoom" as the goal. It is
 * not. Widening the view must give **more and smaller** drops, monotonically, until they stop
 * being drops at all — see `MIST_SHAPE_MEAN`. A test asserts that monotonicity straight off these
 * constants, in both directions, which is the thing neither earlier version could satisfy.
 *
 * Sized for the drop to read at play zoom rather than to be physically correct: a real 2.5 cm
 * raindrop is barely a pixel at 50 px/m.
 */
export const RAIN_SPACING_M = 1.4;
export const RAIN_PERIOD_M = 7;
export const RAIN_HALF_M = 0.05;

/**
 * Drop width in screen px over which discrete streaks dissolve into mist.
 *
 * Below a pixel a drop cannot be drawn as a streak — only as aliasing — and it should not be: rain
 * seen from far enough away *is* mist. The cell stays comfortably multi-pixel across this window
 * (~14 px across at `RESOLVE_HI`), so the lattice never aliases before the drops have gone.
 */
export const RESOLVE_LO = 1.5;
export const RESOLVE_HI = 4;

/**
 * Mean of the drop field as a fraction of its geometric coverage, measured over the lattice.
 *
 * The mist that replaces sub-pixel drops carries the drop field's own mean, so brightness is
 * continuous through the crossover instead of stepping. Measured 0.117–0.126 across the usable
 * `rainStreakDuty` range, so one constant tracks the dial.
 */
export const MIST_SHAPE_MEAN = 0.12;

/** World scale of the mist's own texture, so distant rain reads as drizzle and not a flat wash. */
export const MIST_NOISE_M = 22;

/** Streak length cannot exceed this fraction of a cell, or drops merge into a continuous line. */
export const DUTY_MAX = 0.75;

/** Splash rings started per cell per second. Constrained — see `TIME_WRAP_S`. */
export const SPLASH_RATE = 1.28;

/**
 * Splash lattice pitch, metres. One site per cell.
 *
 * Sized against the **narrowest surface that must catch a splash**, not against a comfortable
 * carriageway density. At 9 m a 2.5 m pavement strip held a site in only about 40% of cells — one
 * splash per 22 m of pavement against many on a 9–24 m road — so pavements read as dry.
 *
 * The binding constraint is the jitter *span*, not the pitch: the site sits within the middle
 * `SPLASH_JITTER_SPAN` of its cell, so a strip narrower than `pitch × span` can fall entirely
 * between sites. Pitched for the `street`/`arterial` pavement below; a 1.5 m `lane` pavement is
 * still sparse, which is an accepted trade against making the roads five times busier again.
 * Turn `splashStrength` down if the carriageway is too busy — do not widen this.
 */
export const SPLASH_SPACING_M = 3.5;

/**
 * Fraction of a cell a strike can land within. Must match the shader's `0.15 + … * hash21`.
 *
 * Widened from 0.6 alongside the per-strike randomisation, so successive strikes in a cell spread
 * over more of it. That tightened the pitch in turn, since `pitch × span` is what has to fit
 * inside a pavement — a test holds the two together.
 */
export const SPLASH_JITTER_SPAN = 0.7;

/** Pavement width the pitch is chosen to cover: `street` 2.5 m, per `ROAD_CLASSES`. */
export const SPLASH_TARGET_SURFACE_M = 2.5;

/**
 * Where the fall accumulator wraps, in metres.
 *
 * Derived, never written by hand: a wrap must shift the lattice by a whole number of
 * `HASH_CYCLE`s, so the field is identical either side of it. A test pins the divisibility.
 */
export const FALL_WRAP_M = RAIN_PERIOD_M * HASH_CYCLE;

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
uniform float uFallM;
uniform float uRainStrength;
uniform float uRainDrops;
uniform float uRainStreakDuty;
uniform float uRainLit;
uniform float uSplashStrength;
uniform float uSplashSizeM;
uniform float uHazeStrength;
uniform float uHazeBandM;
uniform float uHazeInscatter;
uniform float uFogTintR;
uniform float uFogTintG;
uniform float uFogTintB;

varying vec2 vUv;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SCENE_HEIGHT_NORM_M = ${glslFloat(SCENE_HEIGHT_NORM_M)};
const float SCENE_ALPHA_FLOOR = ${glslFloat(SCENE_ALPHA_FLOOR)};
const float ALPHA_BACKGROUND = ${glslFloat(SCENE_ALPHA_FLOOR * 0.5)};
const float HASH_CYCLE = ${glslFloat(HASH_CYCLE)};

const vec2 WIND = vec2(${glslFloat(WIND_DIR[0])}, ${glslFloat(WIND_DIR[1])});
/**
 * The lattice basis, and it must stay a compile-time constant.
 *
 * An earlier version derived it per fragment from the streak vector, so drops fanned radially.
 * That aliases the lattice into noise: the lattice coordinate is world-anchored and absolute, and
 * projecting it onto a basis that rotates across the screen contributes length(p) * d(basis)/dpx
 * to the phase gradient. Measured 8998 lattice units per screen pixel at zoom 4 — 2.2 cells per
 * pixel — against an intended 0.6, and the error scaled with zoom, which is why the rain changed
 * character at every zoom level. A fixed basis holds the gradient flat across a 60x zoom range.
 *
 * The radial term survives as extra streak *length*, which is what the fan-out reads as.
 */
const vec2 WIND_PERP = vec2(${glslFloat(-WIND_DIR[1])}, ${glslFloat(WIND_DIR[0])});

const float RAIN_SPACING_M = ${glslFloat(RAIN_SPACING_M)};
const float RAIN_PERIOD_M = ${glslFloat(RAIN_PERIOD_M)};
const float RAIN_HALF_M = ${glslFloat(RAIN_HALF_M)};
const float DUTY_MAX = ${glslFloat(DUTY_MAX)};
const float RESOLVE_LO = ${glslFloat(RESOLVE_LO)};
const float RESOLVE_HI = ${glslFloat(RESOLVE_HI)};
const float MIST_SHAPE_MEAN = ${glslFloat(MIST_SHAPE_MEAN)};
const float MIST_NOISE_M = ${glslFloat(MIST_NOISE_M)};

const float RAIN_AMBIENT = 0.10;
const vec3 RAIN_TINT = vec3(0.40, 0.48, 0.60);
const float RAIN_LIGHT_GAIN = 1.5;

const float SPLASH_SPACING_M = ${glslFloat(SPLASH_SPACING_M)};
const float SPLASH_RING_M = 0.09;
const float SPLASH_RATE = ${glslFloat(SPLASH_RATE)};
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
 * One octave of drops, on the fixed wind-aligned lattice, all lengths in metres.
 *
 * Three independent per-drop values, and each one is load-bearing against a pattern the eye
 * caught in the first version: r1 offsets it across its column, r2 offsets it *along* — without
 * which every drop sits exactly one period from the next and the whole column pulses in step —
 * and r3 varies length and brightness so no two drops match.
 *
 * WHY the phase arrives as one uniform distance and never as a per-fragment rate: the phase
 * gradient of a spatially varying rate grows linearly with t, so the lattice scrambles within a
 * minute. Only length may vary across the frame, never speed or direction.
 */
float dropLayer(vec2 wm, float spacingM, float periodM, float halfM, float duty) {
  float a = dot(wm, WIND_PERP);
  float cx = floor(a / spacingM);
  float hx = mod(cx, HASH_CYCLE);
  float gy = (dot(wm, WIND) - uFallM) / periodM + hash11(hx * 1.7);
  float cy = floor(gy);
  vec2 id = vec2(hx, mod(cy, HASH_CYCLE));
  float r1 = hash21(id);
  float r2 = hash21(id + 11.3);
  float r3 = hash21(id + 29.7);

  float span = duty * (0.6 + 0.8 * r3);
  float t = (gy - cy - r2 * (1.0 - span)) / span;
  float inside = step(0.0, t) * (1.0 - step(1.0, t));
  // Jitter confined to the middle of the cell: a drop straddling a cell edge would be cut in half,
  // and reading the neighbour to stitch it back costs twice the lattice for nothing.
  float centre = spacingM * (0.2 + 0.6 * r1);
  float across = abs(a - cx * spacingM - centre) / (halfM * (0.7 + 0.6 * r1));
  // Brightest at the leading tip, fading back down the tail.
  return (1.0 - smoothstep(0.0, 1.0, across)) * t * t * inside * (0.4 + 0.6 * r3);
}

/**
 * One expanding ring per cell per strike, fading as it grows. Metres in, so it scales with zoom.
 *
 * The site is keyed to the **strike index** as well as the cell. Keyed to the cell alone it was
 * fixed forever, so the same spot was struck over and over and the illusion died.
 */
float splashRing(vec2 worldM) {
  vec2 g = worldM / SPLASH_SPACING_M;
  vec2 cell = floor(g);
  vec2 f = (g - cell) * SPLASH_SPACING_M;
  vec2 id = mod(cell, HASH_CYCLE);
  float t = uTime * SPLASH_RATE + hash21(id + 4.3);
  float strike = mod(floor(t), HASH_CYCLE);
  float life = fract(t);
  vec2 site = SPLASH_SPACING_M * vec2(
    0.15 + ${glslFloat(SPLASH_JITTER_SPAN)} * hash21(id + vec2(strike * 13.7, strike * 5.1)),
    0.15 + ${glslFloat(SPLASH_JITTER_SPAN)} * hash21(id + vec2(strike * 7.9, strike * 21.3) + 19.7));
  float sizeM = uSplashSizeM * (0.55 + 0.9 * hash21(id + strike * 3.3));
  float ring = 1.0 - smoothstep(0.0, SPLASH_RING_M, abs(length(f - site) - life * sizeM));
  // Small rings retire rather than alias. The band is wide because the site count grows as
  // 1/zoom^2 — a whole-district view holds thousands, and a 3 px ring at that density reads as
  // static, not as rain.
  return ring * (1.0 - life) * smoothstep(3.0, 8.0, sizeM * uPxPerMetre);
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

  // Drifted world position, shared by the mist and the haze. Drifts on an accumulated offset rather
  // than on uTime: uTime wraps, and value noise is not periodic, so deriving the drift from it would
  // repattern both in one frame.
  vec2 hp = worldM + uHazeOffsetM;

  // The projection's own radial term, in metres: a drop stretches away from the pivot exactly as
  // a building leans, so streaks lengthen toward the frame edge. A scalar, so nothing can rotate.
  vec2 fromPivotM = (vUv - uPivotUv) * uWorldSizeM;
  float radialM = length(fromPivotM) * uRadialSmear;

  vec3 light = texture2D(uCity, uv).rgb;
  // Light-aware: water is only visible where something lights it, so drops glow under neon and
  // all but vanish in a dark alley.
  float lit = RAIN_AMBIENT + dot(light, LUMA) * uRainLit;

  // Drops shrink and multiply as the view widens, monotonically, until they are sub-pixel — at
  // which point they become mist rather than aliasing. Both branches are uniform across the draw,
  // since resolve depends only on uniforms, so only the side in use is ever evaluated.
  float dropPx = 2.0 * RAIN_HALF_M * uPxPerMetre;
  float resolve = smoothstep(RESOLVE_LO, RESOLVE_HI, dropPx);
  float duty = clamp(uRainStreakDuty + radialM / RAIN_PERIOD_M, 0.02, DUTY_MAX);

  float dropField = 0.0;
  if (resolve > 0.0) {
    dropField = dropLayer(worldM, RAIN_SPACING_M, RAIN_PERIOD_M, RAIN_HALF_M, duty);
  }
  float mist = 0.0;
  if (resolve < 1.0) {
    // Carries the drop field's own mean, so the crossover does not step in brightness, and its own
    // noise so distant rain reads as drizzle rather than a flat wash.
    float mean = MIST_SHAPE_MEAN * duty * (2.0 * RAIN_HALF_M / RAIN_SPACING_M);
    mist = mean * (0.55 + 0.9 * valueNoise(hp / MIST_NOISE_M));
  }
  float drops = mix(mist, dropField, resolve);

  float ground = 1.0 - smoothstep(0.0, SPLASH_MAX_HEIGHT_M, heightM);
  float water =
    (clamp(drops, 0.0, 1.0) * uRainDrops + splashRing(worldM) * ground * uSplashStrength)
    * lit * uRainStrength;

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
