import {
  BUILDING_GRAMMAR_REGISTRY,
  type BuildingGrammarDefinition,
  type BuildingGrammarId
} from "../core/gen/building-registry.js";
import {
  LANDMARK_GRAMMAR_REGISTRY,
  type LandmarkGrammarDefinition,
  type LandmarkGrammarId
} from "../core/gen/landmark-registry.js";

/** The two Phase 5 architecture families that can be previewed and placed. */
export type ArchitecturePreviewKind = "building" | "place";

export interface ArchitecturePreviewPolygon {
  readonly points: readonly (readonly [number, number])[];
  readonly role: "mass" | "courtyard" | "accent" | "open-space";
}

/**
 * A deterministic, normalized silhouette. The UI deliberately keeps this pure data so
 * catalogue generation does not require PIXI, Canvas, or a mounted Foundry scene.
 */
export interface ArchitecturePreview {
  readonly kind: ArchitecturePreviewKind;
  readonly id: string;
  readonly label: string;
  readonly viewBox: "0 0 100 100";
  readonly polygons: readonly ArchitecturePreviewPolygon[];
}

const previewCache = new Map<string, ArchitecturePreview>();
const svgCache = new Map<string, string>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function polygon(points: readonly (readonly [number, number])[], role: ArchitecturePreviewPolygon["role"] = "mass"): ArchitecturePreviewPolygon {
  return Object.freeze({ points: Object.freeze(points.map(([x, y]) => Object.freeze([x, y] as const))), role });
}

function rectangle(x: number, y: number, width: number, height: number, role: ArchitecturePreviewPolygon["role"] = "mass"): ArchitecturePreviewPolygon {
  return polygon([
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height]
  ], role);
}

function regularPolygon(cx: number, cy: number, width: number, height: number, sides: number, rotation = -Math.PI / 2, role: ArchitecturePreviewPolygon["role"] = "mass"): ArchitecturePreviewPolygon {
  const count = Math.max(3, Math.round(sides));
  const points = Array.from({ length: count }, (_, index) => {
    const angle = rotation + (index * Math.PI * 2) / count;
    return [cx + Math.cos(angle) * width * 0.5, cy + Math.sin(angle) * height * 0.5] as const;
  });
  return polygon(points, role);
}

function archetypeShape(archetype: string): ArchitecturePreviewPolygon[] {
  // Shapes are intentionally schematic: previews communicate massing and footprint, not
  // final parcel geometry. Every branch stays in a shared 100x100 viewBox.
  switch (archetype) {
    case "trapezoid":
      return [polygon([[18, 78], [28, 20], [72, 20], [84, 78]], "mass")];
    case "l-shape":
      return [polygon([[16, 18], [52, 18], [52, 48], [82, 48], [82, 82], [16, 82]], "mass")];
    case "u-shape":
      return [polygon([[14, 16], [36, 16], [36, 58], [64, 58], [64, 16], [86, 16], [86, 84], [14, 84]], "mass")];
    case "courtyard":
      return [
        polygon([[12, 14], [88, 14], [88, 86], [12, 86]], "mass"),
        rectangle(32, 32, 36, 36, "courtyard")
      ];
    case "podium":
      return [rectangle(10, 62, 80, 24, "mass"), rectangle(24, 18, 22, 48, "mass"), rectangle(54, 24, 22, 42, "mass")];
    case "compound":
      return [rectangle(12, 48, 32, 34, "mass"), rectangle(56, 20, 32, 30, "mass"), rectangle(48, 58, 24, 24, "mass")];
    case "chamfered":
      return [polygon([[24, 12], [76, 12], [88, 24], [88, 76], [76, 88], [24, 88], [12, 76], [12, 24]], "mass")];
    case "stepped":
      return [polygon([[18, 84], [18, 50], [30, 50], [30, 34], [44, 34], [44, 20], [76, 20], [76, 84]], "mass")];
    case "offset-tower":
      return [rectangle(14, 58, 72, 28, "mass"), rectangle(34, 14, 34, 52, "mass")];
    case "bridge":
      return [rectangle(12, 18, 22, 64, "mass"), rectangle(66, 18, 22, 64, "mass"), rectangle(28, 40, 44, 20, "mass")];
    case "cantilever":
      return [rectangle(26, 18, 38, 68, "mass"), polygon([[52, 34], [86, 34], [86, 64], [52, 64]], "accent")];
    case "t-shape":
      return [polygon([[16, 14], [84, 14], [84, 38], [62, 38], [62, 86], [38, 86], [38, 38], [16, 38]], "mass")];
    case "cross":
      return [polygon([[36, 12], [64, 12], [64, 36], [88, 36], [88, 64], [64, 64], [64, 88], [36, 88], [36, 64], [12, 64], [12, 36], [36, 36]], "mass")];
    case "h-shape":
      return [polygon([[14, 14], [36, 14], [36, 38], [64, 38], [64, 14], [86, 14], [86, 86], [64, 86], [64, 62], [36, 62], [36, 86], [14, 86]], "mass")];
    case "hexagonal":
      return [regularPolygon(50, 50, 76, 76, 6)];
    case "sawtooth":
      return [polygon([[12, 78], [12, 30], [24, 18], [36, 30], [48, 18], [60, 30], [72, 18], [88, 30], [88, 78]], "mass")];
    case "rectangle":
    default:
      return [rectangle(16, 16, 68, 68, "mass")];
  }
}

function buildingPreview(definition: BuildingGrammarDefinition): ArchitecturePreview {
  const base = archetypeShape(definition.archetype);
  const maxMasses = Math.max(1, Math.round(definition.massing.maxMasses));
  const accent = maxMasses > 1
    ? [rectangle(43, 10, 14, 12, "accent")]
    : [];
  const polygons = [...base, ...accent];
  return Object.freeze({
    kind: "building",
    id: definition.id,
    label: definition.label,
    viewBox: "0 0 100 100",
    polygons: Object.freeze(polygons)
  });
}

function placePreview(definition: LandmarkGrammarDefinition): ArchitecturePreview {
  const templates = definition.massTemplates;
  const count = Math.max(1, templates.length);
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / columns);
  const cellWidth = 74 / columns;
  const cellHeight = 74 / rows;
  const polygons: ArchitecturePreviewPolygon[] = [];
  templates.forEach((template, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const width = clamp(template.widthFactor * cellWidth, 10, cellWidth - 3);
    const height = clamp(template.depthFactor * cellHeight, 10, cellHeight - 3);
    const cx = 13 + cellWidth * (column + 0.5);
    const cy = 13 + cellHeight * (row + 0.5);
    polygons.push(template.polygonSides !== undefined
      ? regularPolygon(cx, cy, width, height, template.polygonSides, -Math.PI / 2, "mass")
      : rectangle(cx - width * 0.5, cy - height * 0.5, width, height, "mass"));
  });
  if (definition.requiredOpenSpace !== null) polygons.push(rectangle(34, 77, 32, 10, "open-space"));
  return Object.freeze({
    kind: "place",
    id: definition.id,
    label: definition.label,
    viewBox: "0 0 100 100",
    polygons: Object.freeze(polygons)
  });
}

function resolveDefinition(kind: "building", id: string | BuildingGrammarDefinition): BuildingGrammarDefinition;
function resolveDefinition(kind: "place", id: string | LandmarkGrammarDefinition): LandmarkGrammarDefinition;
function resolveDefinition(kind: ArchitecturePreviewKind, value: string | BuildingGrammarDefinition | LandmarkGrammarDefinition): BuildingGrammarDefinition | LandmarkGrammarDefinition {
  if (typeof value !== "string") return value;
  const definition = kind === "building"
    ? BUILDING_GRAMMAR_REGISTRY.get(value as BuildingGrammarId)
    : LANDMARK_GRAMMAR_REGISTRY.get(value as LandmarkGrammarId);
  if (definition === undefined) throw new Error(`Unknown ${kind} preview grammar "${value}".`);
  return definition;
}

function cacheKey(kind: ArchitecturePreviewKind, value: string | { id: string }): string {
  return `${kind}:${typeof value === "string" ? value : value.id}`;
}

/** Return a session-cached normalized silhouette for one registry entry. */
export function architecturePreview(kind: "building", value: string | BuildingGrammarDefinition): ArchitecturePreview;
export function architecturePreview(kind: "place", value: string | LandmarkGrammarDefinition): ArchitecturePreview;
export function architecturePreview(kind: ArchitecturePreviewKind, value: string | BuildingGrammarDefinition | LandmarkGrammarDefinition): ArchitecturePreview {
  const key = cacheKey(kind, value);
  const cached = previewCache.get(key);
  if (cached !== undefined) return cached;
  if (kind === "building") {
    const preview = buildingPreview(resolveDefinition("building", value as string | BuildingGrammarDefinition));
    previewCache.set(key, preview);
    return preview;
  }
  const preview = placePreview(resolveDefinition("place", value as string | LandmarkGrammarDefinition));
  previewCache.set(key, preview);
  return preview;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function pointsAttribute(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");
}

/** Render one cached silhouette as accessible SVG markup. */
export function architecturePreviewSVG(kind: "building", value: string | BuildingGrammarDefinition, options?: { label?: string }): string;
export function architecturePreviewSVG(kind: "place", value: string | LandmarkGrammarDefinition, options?: { label?: string }): string;
export function architecturePreviewSVG(kind: ArchitecturePreviewKind, value: string | BuildingGrammarDefinition | LandmarkGrammarDefinition, options: { label?: string } = {}): string {
  const key = `${cacheKey(kind, value)}:${options.label ?? ""}`;
  const cached = svgCache.get(key);
  if (cached !== undefined) return cached;
  const preview = kind === "building"
    ? architecturePreview("building", value as string | BuildingGrammarDefinition)
    : architecturePreview("place", value as string | LandmarkGrammarDefinition);
  const label = options.label ?? preview.label;
  const polygons = preview.polygons
    .map((shape) => `<polygon points="${pointsAttribute(shape.points)}" class="nixie-architecture-preview-${shape.role}" data-preview-role="${shape.role}"></polygon>`)
    .join("");
  const svg = `<svg class="nixie-architecture-preview" viewBox="${preview.viewBox}" role="img" aria-label="${escapeAttribute(label)}" focusable="false">${polygons}</svg>`;
  svgCache.set(key, svg);
  return svg;
}

/** Canvas equivalent used by ghost/thumbnail surfaces that already own a 2D context. */
export function drawArchitecturePreview(
  context: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void; fill(): void; stroke?(): void },
  kind: ArchitecturePreviewKind,
  value: string | BuildingGrammarDefinition | LandmarkGrammarDefinition,
  width: number,
  height: number
): void {
  const preview = kind === "building"
    ? architecturePreview("building", value as string | BuildingGrammarDefinition)
    : architecturePreview("place", value as string | LandmarkGrammarDefinition);
  for (const shape of preview.polygons) {
    if (shape.role === "courtyard" || shape.role === "open-space") continue;
    context.beginPath();
    shape.points.forEach(([x, y], index) => {
      const px = (x / 100) * width;
      const py = (y / 100) * height;
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.closePath();
    context.fill();
    context.stroke?.();
  }
}

export function clearArchitecturePreviewCache(): void {
  previewCache.clear();
  svgCache.clear();
}

export function architecturePreviewCacheSize(): number {
  return previewCache.size;
}

/** Useful for catalogue tests and diagnostics: all currently retained preview keys. */
export function architecturePreviewCacheKeys(): string[] {
  return [...previewCache.keys()];
}

// Explicit aliases keep the UI vocabulary readable while preserving one cache.
export const renderArchitecturePreview = architecturePreviewSVG;
export const renderBuildingPreview = (value: string | BuildingGrammarDefinition, options: { label?: string } = {}): string => architecturePreviewSVG("building", value, options);
export const renderPlacePreview = (value: string | LandmarkGrammarDefinition, options: { label?: string } = {}): string => architecturePreviewSVG("place", value, options);

