import * as fs from "node:fs/promises";
import { ipcMain, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { ensureUserDataDir } from "./data-store.js";
import {
  gitCreateWorktree,
  gitDeleteManagedWorktree,
  gitFinalizeManagedWorktreeDeletion,
  gitManagedWorktreeDeletionPending,
  gitManagedWorktreeRegistered,
  gitManagedWorktreeUsable,
  gitRollbackWorktree,
} from "./git.js";
import { llmClient } from "./llm-client.js";
import { scheduleService } from "./schedule-service.js";
import { terminalService } from "./terminal.js";
import { defaultWorkspaceId } from "./workspace-application-service.js";
import { workspaceEnvironmentApplicationService } from "./workspace-environment-application-service-main.js";
import { workspaceMutationGate } from "./workspace-mutation-gate.js";
import { workspaceOperationRegistry } from "./workspace-operation-registry.js";
import { createWorkspaceWorktreeApplicationService } from "./workspace-worktree-application-service.js";

export const workspaceWorktreeApplicationService = createWorkspaceWorktreeApplicationService({
  environment: workspaceEnvironmentApplicationService,
  ensureWorktreeRoot: () => ensureUserDataDir("worktrees"),
  createWorktree: gitCreateWorktree,
  rollbackWorktree: gitRollbackWorktree,
  deleteManagedWorktree: (managed, signal) => gitDeleteManagedWorktree(
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
  managedWorktreeDeletionPending: (managed) => gitManagedWorktreeDeletionPending(
    managed.worktreePath,
    managed.worktreeGitDir!,
    managed.ownershipToken!,
  ),
  managedWorktreeRegistered: (managed) => gitManagedWorktreeRegistered(
    managed.repositoryPath,
    managed.worktreePath,
    managed.branch,
    managed.worktreeGitDir,
    managed.ownershipToken,
  ),
  managedWorktreeUsable: (managed) => gitManagedWorktreeUsable(
    managed.repositoryPath,
    managed.worktreePath,
    managed.branch,
    managed.worktreeGitDir,
    managed.ownershipToken,
    managed.worktreeDevice,
    managed.worktreeInode,
  ),
  finalizeManagedWorktreeDeletion: (managed) => gitFinalizeManagedWorktreeDeletion(
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
  saveWorkspace: (workspace) => configStore.saveWorkspace(workspace),
  removeWorkspace: (workspaceId) => configStore.removeWorkspace(workspaceId),
  beginWorkspaceMutation: (workspaceId) => workspaceMutationGate.begin(workspaceId),
  workspaceIsChanging: (workspaceId) => workspaceMutationGate.isChanging(workspaceId),
  cancelWorkspaceOperations: (workspaceId, exceptSignal) =>
    workspaceOperationRegistry.cancelAndSettle(workspaceId, { exceptSignal }),
  closeWorkspaceTerminals: (workspaceId) => terminalService.closeForWorkspace(workspaceId),
  cancelWorkspaceGeneration: (workspaceId) => llmClient.cancelWorkspaceAndSettle(workspaceId),
  cancelWorkspaceSchedules: (workspaceId) => scheduleService.cancelWorkspace(workspaceId),
  resumeWorkspaceSchedules: (workspaceId) => scheduleService.resumeWorkspace(workspaceId),
  createWorkspaceId: defaultWorkspaceId,
  now: Date.now,
  notifyChanged: () => ipcMain.broadcast("workspaces:changed", {}),
  logError: (area, message, error) => logger.error(area, message, error),
});
