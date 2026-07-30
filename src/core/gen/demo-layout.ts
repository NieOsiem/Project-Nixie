import type { BuildingSpec, Vec2 } from "../geom/extrude.js";
import { MATERIAL } from "../palette.js";

interface Placement {
  /** Centre offset from the layout origin, in grid squares. */
  gx: number;
  gy: number;
  /** Footprint size in grid squares. */
  gw: number;
  gh: number;
  /** Height in metres. */
  height: number;
  roof: number;
  wall: number;
}

const M = MATERIAL;

/**
 * Hard-coded arrangement for S1. Chosen to exercise the projection rather than to
 * look like a real block: heights span 14–136 m, placements reach every quadrant so
 * the lean direction varies, and the short building at (9, -13) sits where the tall
 * tower beside it leans over — which is the case that fails without a depth buffer.
 */
const PLACEMENTS: Placement[] = [
  { gx: -26, gy: -14, gw: 14, gh: 10, height: 64, roof: M.ROOF_DARK, wall: M.WALL_VIOLET },
  { gx: -8, gy: -16, gw: 12, gh: 12, height: 118, roof: M.ROOF_ACCENT, wall: M.WALL_MAGENTA },
  { gx: 9, gy: -13, gw: 9, gh: 7, height: 14, roof: M.ROOF_WARM, wall: M.WALL_TEAL },
  { gx: 21, gy: -15, gw: 12, gh: 11, height: 78, roof: M.ROOF_DARK, wall: M.WALL_VIOLET },
  { gx: -28, gy: 4, gw: 12, gh: 13, height: 42, roof: M.ROOF_WARM, wall: M.WALL_TEAL },
  { gx: -10, gy: 6, gw: 15, gh: 9, height: 96, roof: M.ROOF_DARK, wall: M.WALL_MAGENTA },
  { gx: 9, gy: 3, gw: 8, gh: 8, height: 20, roof: M.ROOF_WARM, wall: M.WALL_TEAL },
  { gx: 21, gy: 5, gw: 13, gh: 12, height: 136, roof: M.ROOF_ACCENT, wall: M.WALL_VIOLET },
  { gx: 2, gy: 18, gw: 22, gh: 8, height: 30, roof: M.ROOF_DARK, wall: M.WALL_MAGENTA }
];

function footprint(origin: Vec2, gridSize: number, p: Placement): Vec2[] {
  const cx = origin.x + p.gx * gridSize;
  const cy = origin.y + p.gy * gridSize;
  const hw = (p.gw * gridSize) / 2;
  const hh = (p.gh * gridSize) / 2;
  return [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh }
  ];
}

export function demoLayout(origin: Vec2, gridSize: number): BuildingSpec[] {
  return PLACEMENTS.map((p) => ({
    footprint: footprint(origin, gridSize, p),
    height: p.height,
    roofMaterial: p.roof,
    wallMaterial: p.wall
  }));
}
