import { mkdir, realpath, stat, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Workspace } from "../../../main/services/types.js";
import { createWorkspaceApplicationService } from "../../../main/services/workspace-application-service.js";
import { createWorkspaceEnvironmentApplicationService } from "../../../main/services/workspace-environment-application-service.js";
import { WorkspaceMutationGate } from "../../../main/services/workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../../../main/services/workspace-operation-registry.js";
import { createScratchWorkspaceDirectory } from "../../../main/services/scratch-workspace.js";
import { JsonStore } from "./state.ts";
import type { CliWorkspace } from "./workspaces.ts";

export function createCliWorkspaceApplication(agentDir: string, operations: {
  cancelGeneration(workspaceId: string): Promise<void>;
  cancelSchedules(workspaceId: string): Promise<void>;
  resumeSchedules(workspaceId: string): Promise<void>;
  assertManagedWorktreeAdmission?(workspace: Workspace): Promise<void>;
}) {
  const records = new JsonStore<CliWorkspace[]>(join(agentDir, "workspaces.json"), []);
  const project = (record: CliWorkspace): Workspace => ({ id: record.id, name: record.name, folderPath: record.folderPath || undefined, permission: record.access,
    createdAt: record.createdAt ?? 0, updatedAt: record.updatedAt ?? 0, memoryEnabled: record.memoryEnabled, managedWorktree: record.managedWorktree });
  const configStore = {
    async listWorkspaces() { return (await records.load()).map(project); },
    async getWorkspace(id: string) { const record = (await records.load()).find((record) => record.id === id); return record ? project(record) : undefined; },
    async saveWorkspace(workspace: Workspace) {
      return records.update((entries) => {
        const index = entries.findIndex((entry) => entry.id === workspace.id);
        const record = { ...workspace, folderPath: workspace.folderPath ?? "", access: workspace.permission };
        if (index === -1) entries.push(record); else entries[index] = record;
        return workspace;
      });
    },
    async removeWorkspace(id: string) { await records.update((entries) => { const index = entries.findIndex((entry) => entry.id === id); if (index >= 0) entries.splice(index, 1); }); },
  };
  const mutationGate = new WorkspaceMutationGate(), operationRegistry = new WorkspaceOperationRegistry();
  const application = createWorkspaceApplicationService({ configStore,
    llmClient: { cancelWorkspaceAndSettle: operations.cancelGeneration },
    scheduleService: { cancelWorkspace: operations.cancelSchedules, resumeWorkspace: operations.resumeSchedules },
    terminalService: { closeForWorkspace() {} }, // CLI daemon does not own persistent terminals.
    workspaceMutationGate: mutationGate, workspaceOperationRegistry: operationRegistry,
    createScratchWorkspaceDirectory: () => createScratchWorkspaceDirectory(join(agentDir, "scratch")),
    realpath, stat, removeEmptyDirectory: rmdir, createId: () => `w-${randomUUID()}`, now: Date.now,
    logError: (area, message) => process.stderr.write(`aiden: ${area}: ${message}\n`),
  });
  const environment = createWorkspaceEnvironmentApplicationService({ configStore, workspaceMutationGate: mutationGate, workspaceOperationRegistry: operationRegistry, realpath, stat,
    assertManagedWorktreeAdmission: operations.assertManagedWorktreeAdmission ?? (async (workspace) => { if (workspace.managedWorktree) throw new Error("Managed worktree authority is unavailable."); }),
  });
  return { application, environment, configStore, mutationGate, operationRegistry,
    async ensureWorktreeRoot() { const root = join(agentDir, "worktrees"); await mkdir(root, { recursive: true, mode: 0o700 }); return root; },
  };
}
