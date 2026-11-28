import path from "node:path";
import { aidenConfigDir } from "./aiden-config-dir.js";
import { sharedWorkspaceScopeId } from "./memory-shared.js";
import { MemoryStore } from "./memory-store.js";

/** Cap main-thread lock waits so concurrent CLI writes cannot stall desktop IPC. */
export const MAIN_MEMORY_BUSY_TIMEOUT_MS = 100;

export function createMainMemoryStore(deps: {
  root?: () => string | Promise<string>;
  userDataPath?: () => Promise<string>;
  listWorkspaces?: () => Promise<readonly { id: string; folderPath?: string; noWorkspace?: boolean }[]>;
} = {}): MemoryStore {
  return new MemoryStore({
    root: deps.root ?? (() => path.join(aidenConfigDir(), "memory")),
    busyTimeoutMs: MAIN_MEMORY_BUSY_TIMEOUT_MS,
    imports: async () => [{
      file: path.join(
        await (deps.userDataPath
          ? deps.userDataPath()
          : (await import("../platform.js")).app.getPath("userData")),
        "memory",
        "memory-v1.sqlite",
      ),
    }],
    scopeAliases: async () => {
      const workspaces = deps.listWorkspaces
        ? await deps.listWorkspaces()
        : await (await import("./config-store.js")).configStore.listWorkspaces();
      return workspaces.flatMap((workspace) =>
        // No workspace chats keep the default workspace's id scope (see memoryScopeForChat).
        workspace.folderPath && !workspace.noWorkspace
          ? [{
              from: { kind: "workspace" as const, id: workspace.id },
              to: { kind: "workspace" as const, id: sharedWorkspaceScopeId(workspace.folderPath) },
            }]
          : [],
      );
    },
  });
}

/**
 * The desktop store shares `~/.aiden/memory` with the CLI. On first open it
 * absorbs the legacy per-app database under Electron's userData directory and
 * duplicates rows scoped by workspace UUID into the shared folder-hash scope;
 * the original rows remain so a downgraded app still sees them.
 */
export const memoryStore = createMainMemoryStore();
