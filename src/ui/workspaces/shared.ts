export function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function selected(value: string, current: string): string {
  return value === current ? " selected" : "";
}

export function checked(value: boolean): string {
  return value ? " checked" : "";
}

export function statusKind(status: any): string {
  if (typeof status === "string") return status;
  return status?.kind ?? status?.status ?? status?.type ?? "malformed";
}

/** User-facing label for a structural generation failure component. */
export function generationComponentLabel(component: "generation" | "save" | "chunks"): string {
  switch (component) {
    case "save":
      return "saving the city";
    case "chunks":
      return "rendering city chunks";
    default:
      return "generating the city";
  }
}
