import { type WorkspaceId } from "../editor-state.js";
import { diagnosticsWorkspace } from "./diagnostics.js";
import { districtsWorkspace } from "./districts.js";
import { generateWorkspace } from "./generate.js";
import { objectsWorkspace } from "./objects.js";
import { regenerateWorkspace } from "./regenerate.js";
import { roadsWorkspace } from "./roads.js";
import { terrainWorkspace } from "./terrain.js";
import type { WorkspaceModule } from "./types.js";

const modules: Record<WorkspaceId, WorkspaceModule> = {
  generate: generateWorkspace(),
  terrain: terrainWorkspace(),
  roads: roadsWorkspace(),
  districts: districtsWorkspace(),
  objects: objectsWorkspace(),
  regenerate: regenerateWorkspace(),
  diagnostics: diagnosticsWorkspace()
};

export function workspaceModule(id: WorkspaceId): WorkspaceModule {
  return modules[id];
}
