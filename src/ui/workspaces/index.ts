import { type WorkspaceId } from "../editor-state.js";
import { diagnosticsWorkspace } from "./diagnostics.js";
import { generateWorkspace } from "./generate.js";
import { roadsWorkspace } from "./roads.js";
import { terrainWorkspace } from "./terrain.js";
import type { WorkspaceModule } from "./types.js";
import { unavailableWorkspace } from "./unavailable.js";

const modules: Record<WorkspaceId, WorkspaceModule> = {
  generate: generateWorkspace(),
  terrain: terrainWorkspace(),
  roads: roadsWorkspace(),
  districts: unavailableWorkspace("districts", "Districts, blocks, and walls arrive in Phase 3."),
  objects: unavailableWorkspace("objects", "Buildings, places, props, and POIs arrive in Phases 5–8."),
  regenerate: unavailableWorkspace("regenerate", "Block and district regeneration arrives in Phase 6."),
  diagnostics: diagnosticsWorkspace()
};

export function workspaceModule(id: WorkspaceId): WorkspaceModule {
  return modules[id];
}
