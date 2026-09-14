import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createWorkspaceWorktreeApplicationService } from "../../../main/services/workspace-worktree-application-service.js";
import type { createCliWorkspaceApplication } from "./workspace-application.ts";
import type { createCliScheduler } from "./schedules.ts";
import type { GitService } from "../../../main/services/git.js";
export function createCliRemoteWorktrees(workspace: ReturnType<typeof createCliWorkspaceApplication>, scheduler: ReturnType<typeof createCliScheduler>, git: GitService, cancelGeneration: (id: string) => Promise<void>) {
return createWorkspaceWorktreeApplicationService({
  environment: workspace.environment,
  ensureWorktreeRoot: workspace.ensureWorktreeRoot,
  createWorktree: (...args) => git.createWorktree(...args),
  rollbackWorktree: (...args) => git.rollbackWorktree(...args),
  deleteManagedWorktree: (managed, signal) => git.deleteManagedWorktree(
    managed.repositoryPath,
    managed.worktreePath,
    managed.branch,
    managed.createdFromHead,
    signal,
    managed.worktreeGitDir,
    managed.ownershipToken,
    managed.worktreeDevice,
    managed.worktreeInode,
  ),
  managedWorktreeDeletionPending: (managed) => git.managedWorktreeDeletionPending(
    managed.worktreePath,
    managed.worktreeGitDir!,
    managed.ownershipToken!,
  ),
  managedWorktreeRegistered: (managed) => git.managedWorktreeRegistered(
    managed.repositoryPath,
    managed.worktreePath,
    managed.branch,
    managed.worktreeGitDir,
    managed.ownershipToken,
  ),
  managedWorktreeUsable: (managed) => git.managedWorktreeUsable(
    managed.repositoryPath,
    managed.worktreePath,
    managed.branch,
    managed.worktreeGitDir,
    managed.ownershipToken,
    managed.worktreeDevice,
    managed.worktreeInode,
  ),
  finalizeManagedWorktreeDeletion: (managed) => git.finalizeManagedWorktreeDeletion(
    managed.worktreePath,
    managed.worktreeGitDir!,
    managed.ownershipToken!,
  ),
  workspacePathExists: async (worktreePath) => {
    try {
      await fs.stat(worktreePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  },
  saveWorkspace: (record) => workspace.configStore.saveWorkspace(record),
  removeWorkspace: (workspaceId) => workspace.configStore.removeWorkspace(workspaceId),
  beginWorkspaceMutation: (workspaceId) => workspace.mutationGate.begin(workspaceId),
  workspaceIsChanging: (workspaceId) => workspace.mutationGate.isChanging(workspaceId),
  cancelWorkspaceOperations: (workspaceId, exceptSignal) =>
    workspace.operationRegistry.cancelAndSettle(workspaceId, { exceptSignal }),
  closeWorkspaceTerminals: () => {},
  cancelWorkspaceGeneration: (workspaceId) => cancelGeneration(workspaceId),
  cancelWorkspaceSchedules: (workspaceId) => scheduler.service.cancelWorkspace(workspaceId),
  resumeWorkspaceSchedules: (workspaceId) => scheduler.service.resumeWorkspace(workspaceId),
  createWorkspaceId: () => `w-${randomUUID()}`,
  now: Date.now,
  notifyChanged: () => {},
  logError: (area, message) => process.stderr.write(`aiden: ${area}: ${message}\n`),
});

}
