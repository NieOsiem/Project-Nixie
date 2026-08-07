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
