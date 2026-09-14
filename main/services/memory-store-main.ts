import path from "node:path";
import { aidenConfigDir } from "./aiden-config-dir.js";
import { configStore } from "./config-store.js";
import { sharedWorkspaceScopeId } from "./memory-shared.js";
import { MemoryStore } from "./memory-store.js";

/**
 * The desktop store shares `~/.aiden/memory` with the CLI. On first open it
 * absorbs the legacy per-app database under Electron's userData directory and
 * duplicates rows scoped by workspace UUID into the shared folder-hash scope;
 * the original rows remain so a downgraded app still sees them.
 */
export const memoryStore = new MemoryStore({
  root: () => path.join(aidenConfigDir(), "memory"),
  imports: async () => [{
    file: path.join((await import("../platform.js")).app.getPath("userData"), "memory", "memory-v1.sqlite"),
  }],
  scopeAliases: async () => (await configStore.listWorkspaces()).flatMap((workspace) =>
    workspace.folderPath
      ? [{
          from: { kind: "workspace" as const, id: workspace.id },
          to: { kind: "workspace" as const, id: sharedWorkspaceScopeId(workspace.folderPath) },
        }]
      : [],
  ),
});
