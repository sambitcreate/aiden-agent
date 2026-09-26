import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createWorkspaceWorktreeApplicationService } from "../../../main/services/workspace-worktree-application-service.js";
import { checkCreateCapacity, checkSnapshotCapacity, checkWorktreeAllocation } from "../../../main/services/managed-worktree-capacity.js";
import { provisionWorktreeIncludedFiles } from "../../../main/services/managed-worktree-provisioner.js";
import type { createCliWorkspaceApplication } from "./workspace-application.ts";
import type { createCliScheduler } from "./schedules.ts";
import type { GitService } from "../../../main/services/git.js";
export function createCliRemoteWorktrees(workspace: ReturnType<typeof createCliWorkspaceApplication>, scheduler: ReturnType<typeof createCliScheduler>, git: GitService, cancelGeneration: (id: string) => Promise<void>) {
return createWorkspaceWorktreeApplicationService({
  environment: workspace.environment,
  ensureWorktreeRoot: workspace.ensureWorktreeRoot,
  ensureSnapshotRoot: workspace.ensureSnapshotRoot,
  createWorktree: (...args) => git.createWorktree(...args),
  rollbackWorktree: (...args) => git.rollbackWorktree(...args),
  deleteManagedWorktree: (managed, signal, lifecycle) => git.deleteManagedWorktree(
    managed.repositoryPath,
    managed.worktreePath,
    managed.branch,
    managed.createdFromHead,
    signal,
    managed.worktreeGitDir,
    managed.ownershipToken,
    managed.worktreeDevice,
    managed.worktreeInode,
    true,
    lifecycle,
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
  checkoutBytes: (folderPath, commit) => git.managedWorktreeCheckoutBytes(folderPath, commit),
  checkWorktreeAllocation,
  checkCreateCapacity: async (root, estimatedBytes) => {
    await checkCreateCapacity(root, estimatedBytes);
  },
  checkSnapshotCapacity: async (root, estimatedBytes) => {
    await checkSnapshotCapacity(root, estimatedBytes);
  },
  provisionIncludedFiles: (options) =>
    provisionWorktreeIncludedFiles({ listFiles: (folderPath, args) => git.listFiles(folderPath, args) }, options),
  repositoryPaths: (folderPath) => git.repositoryPaths(folderPath),
  dirtyState: (repositoryPath, worktreePath) => git.managedWorktreeDirtyState(repositoryPath, worktreePath),
  expandIgnoredPaths: (repositoryPath, worktreePath, ignoredPaths) =>
    git.expandManagedWorktreeIgnored(repositoryPath, worktreePath, ignoredPaths),
  snapshotContentBytes: (repositoryPath, worktreePath) => git.managedWorktreeDirtyBytes(repositoryPath, worktreePath),
  captureWorktreeSnapshot: (repositoryPath, worktreePath, snapshotId, signal) =>
    git.captureManagedWorktreeSnapshot(repositoryPath, worktreePath, snapshotId, signal),
  snapshotRefCommit: (repositoryPath, snapshotId) => git.managedWorktreeSnapshotCommit(repositoryPath, snapshotId),
  deleteSnapshotRef: (repositoryPath, snapshotId, expectedCommit) =>
    git.deleteManagedWorktreeSnapshotRef(repositoryPath, snapshotId, expectedCommit),
  restoreManagedCheckout: (...args) => git.restoreManagedWorktreeCheckout(...args),
  resumeManagedCheckout: (...args) => git.resumeManagedWorktreeCheckout(...args),
  applyWorktreeSnapshot: (worktreePath, snapshotCommit, signal) =>
    git.applyManagedWorktreeSnapshot(worktreePath, worktreePath, snapshotCommit, signal),
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
