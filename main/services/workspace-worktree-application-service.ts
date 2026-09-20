import path from "node:path";
import type { GitCreatedWorktree, GitDeleteWorktreeResult, GitRestoredWorktree } from "./git.js";
import { GitManagedWorktreeDeleteError } from "./git.js";
import {
  commitManagedWorktreeCreation,
  ManagedWorktreeCreationError,
} from "./managed-worktree-creation-core.js";
import { removeManagedWorkspace } from "./managed-worktree-removal-core.js";
import type { Workspace, ManagedWorktree } from "./types.js";
import type { WorkspaceEnvironmentApplicationService } from "./workspace-environment-application-service.js";
import type { WorkspaceOperationDocumentOwner } from "./workspace-operation-registry.js";
import { withWorkspaceScheduleRestoration } from "./workspace-schedule-restoration.js";

export interface WorkspaceWorktreeApplicationDependencies {
  environment: Pick<WorkspaceEnvironmentApplicationService, "resolve" | "run" | "runRecord">;
  ensureWorktreeRoot(): Promise<string>;
  createWorktree(
    folderPath: string,
    root: string,
    branch: string,
    signal?: AbortSignal,
    options?: { allowSetupScript?: boolean },
  ): Promise<GitCreatedWorktree>;
  rollbackWorktree(folderPath: string, created: GitCreatedWorktree): Promise<void>;
  restoreManagedWorktree(
    folderPath: string,
    root: string,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<GitRestoredWorktree>;
  deleteManagedWorktree(
    managed: ManagedWorktree,
    signal: AbortSignal,
    options?: { force?: boolean },
  ): Promise<GitDeleteWorktreeResult>;
  managedWorktreeDeletionPending(managed: ManagedWorktree): Promise<boolean>;
  managedWorktreeRegistered(managed: ManagedWorktree): Promise<boolean>;
  managedWorktreeUsable(managed: ManagedWorktree): Promise<boolean>;
  finalizeManagedWorktreeDeletion(managed: ManagedWorktree): Promise<void>;
  workspacePathExists(worktreePath: string): Promise<boolean>;
  saveWorkspace(workspace: Workspace): Promise<Workspace>;
  removeWorkspace(workspaceId: string): Promise<void>;
  beginWorkspaceMutation(workspaceId: string): () => void;
  workspaceIsChanging(workspaceId: string): boolean;
  cancelWorkspaceOperations(workspaceId: string, exceptSignal: AbortSignal): Promise<void>;
  closeWorkspaceTerminals(workspaceId: string): void;
  cancelWorkspaceGeneration(workspaceId: string): Promise<void>;
  cancelWorkspaceSchedules(workspaceId: string): Promise<void>;
  resumeWorkspaceSchedules(workspaceId: string): Promise<void>;
  createWorkspaceId(): string;
  now(): number;
  notifyChanged(): void;
  logError(area: string, message: string, error: unknown): void;
}

function displayName(source: Workspace, branch: string, requested?: string): string {
  const trimmed = requested?.trim();
  if (trimmed) return [...trimmed].slice(0, 120).join("");
  const base = path.basename(source.folderPath ?? source.name);
  return [...`${base} · ${branch}`].slice(0, 120).join("");
}

/**
 * Shared renderer/remote orchestration for Aiden-owned Git worktrees. All
 * filesystem and Git-admin identity is reloaded from persisted Mac state.
 */
export function createWorkspaceWorktreeApplicationService(
  dependencies: WorkspaceWorktreeApplicationDependencies,
) {
  const create = async (
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    branch: string,
    requestedName?: string,
    options?: { allowSetupScript?: boolean },
  ): Promise<Workspace> =>
    dependencies.environment.run(owner, sourceWorkspaceId, async (resolved, signal) => {
      const worktree = await dependencies.createWorktree(
        resolved.folderPath,
        await dependencies.ensureWorktreeRoot(),
        branch,
        signal,
        options,
      );
      const now = dependencies.now();
      const workspace: Workspace = {
        id: dependencies.createWorkspaceId(),
        name: displayName(resolved.workspace, branch, requestedName),
        folderPath: worktree.workspacePath,
        permission: resolved.workspace.permission,
        managedWorktree: {
          repositoryPath: worktree.repositoryPath,
          worktreePath: worktree.path,
          branch,
          worktreeGitDir: worktree.worktreeGitDir,
          ownershipToken: worktree.ownershipToken,
          worktreeDevice: worktree.worktreeDevice,
          worktreeInode: worktree.worktreeInode,
          createdFromHead: worktree.createdFromHead,
          ...(worktree.provisionedFiles?.length
            ? { provisionedFiles: worktree.provisionedFiles }
            : {}),
        },
        createdAt: now,
        updatedAt: now,
      };
      try {
        const saved = await commitManagedWorktreeCreation({
          validateBeforeSave: async () => {
            const latest = await dependencies.environment.resolve(sourceWorkspaceId, true);
            if (
              !latest ||
              signal.aborted ||
              latest.folderPath !== resolved.folderPath ||
              latest.workspace.permission !== resolved.workspace.permission
            ) {
              throw new Error(
                "The source workspace changed while Aiden was creating the worktree.",
              );
            }
          },
          saveWorkspace: () => dependencies.saveWorkspace(workspace),
          validateAfterSave: () => {
            if (signal.aborted || dependencies.workspaceIsChanging(sourceWorkspaceId)) {
              throw new Error("The source workspace changed while Aiden was saving the worktree.");
            }
          },
          removeWorkspaceRecord: (savedWorkspace) =>
            dependencies.removeWorkspace(savedWorkspace.id),
          rollbackWorktree: () => dependencies.rollbackWorktree(resolved.folderPath, worktree),
        });
        dependencies.notifyChanged();
        return saved;
      } catch (error) {
        if (error instanceof ManagedWorktreeCreationError) {
          dependencies.logError("git", error.logMessage, error.errors);
        }
        throw error;
      }
    });

  const remove = async (
    owner: WorkspaceOperationDocumentOwner,
    workspaceId: string,
    validateWorkspace: (workspace: Workspace) => void = () => undefined,
    options?: { force?: boolean },
  ): Promise<GitDeleteWorktreeResult> =>
    dependencies.environment.runRecord(owner, workspaceId, async (workspace, signal) => {
      validateWorkspace(workspace);
      const managed = workspace.managedWorktree;
      if (!managed) throw new Error("This workspace is not an Aiden-managed worktree.");
      const finishMutation = dependencies.beginWorkspaceMutation(workspaceId);
      try {
        await dependencies.cancelWorkspaceOperations(workspaceId, signal);
        const result = await withWorkspaceScheduleRestoration(
          {
            restoreOnExit: workspace.permission !== "none",
            resume: () => dependencies.resumeWorkspaceSchedules(workspaceId),
            onResumeError: (error) =>
              dependencies.logError(
                "schedule",
                "Could not restore scheduled tasks after managed worktree deletion failed.",
                error,
              ),
          },
          async ({ keepPaused }) => {
            dependencies.closeWorkspaceTerminals(workspaceId);
            await dependencies.cancelWorkspaceGeneration(workspaceId);
            await dependencies.cancelWorkspaceSchedules(workspaceId);
            const deletion = await removeManagedWorkspace({
              deleteWorktree: () => dependencies.deleteManagedWorktree(managed, signal, options),
              destructiveMutationAttempted: (error) =>
                error instanceof GitManagedWorktreeDeleteError
                  ? error.destructiveMutationAttempted
                  : undefined,
              deletionPending: () => dependencies.managedWorktreeDeletionPending(managed),
              workspacePathExists: () => dependencies.workspacePathExists(managed.worktreePath),
              worktreeRegistered: () => dependencies.managedWorktreeRegistered(managed),
              worktreeUsable: () => dependencies.managedWorktreeUsable(managed),
              onDestructiveBoundary: keepPaused,
              removeWorkspaceRecord: () => dependencies.removeWorkspace(workspaceId),
              reconciledResult: () => ({ branchDeleted: false }),
            });
            if (managed.worktreeGitDir && managed.ownershipToken) {
              await dependencies.finalizeManagedWorktreeDeletion(managed);
            }
            return deletion;
          },
        );
        dependencies.notifyChanged();
        return result;
      } finally {
        finishMutation();
      }
    });

  const restore = async (
    owner: WorkspaceOperationDocumentOwner,
    sourceWorkspaceId: string,
    snapshotId: string,
    requestedName?: string,
  ): Promise<Workspace> =>
    dependencies.environment.run(owner, sourceWorkspaceId, async (resolved, signal) => {
      const worktree = await dependencies.restoreManagedWorktree(
        resolved.folderPath,
        await dependencies.ensureWorktreeRoot(),
        snapshotId,
        signal,
      );
      const now = dependencies.now();
      const workspace: Workspace = {
        id: dependencies.createWorkspaceId(),
        name: displayName(resolved.workspace, worktree.branch, requestedName),
        folderPath: worktree.workspacePath,
        permission: resolved.workspace.permission,
        managedWorktree: {
          repositoryPath: worktree.repositoryPath,
          worktreePath: worktree.path,
          branch: worktree.branch,
          worktreeGitDir: worktree.worktreeGitDir,
          ownershipToken: worktree.ownershipToken,
          worktreeDevice: worktree.worktreeDevice,
          worktreeInode: worktree.worktreeInode,
          createdFromHead: worktree.createdFromHead,
          ...(worktree.owner ? { owner: worktree.owner } : {}),
          ...(worktree.provisionedFiles?.length
            ? { provisionedFiles: worktree.provisionedFiles }
            : {}),
        },
        createdAt: now,
        updatedAt: now,
      };
      try {
        const saved = await commitManagedWorktreeCreation({
          validateBeforeSave: async () => {
            const latest = await dependencies.environment.resolve(sourceWorkspaceId, true);
            if (
              !latest ||
              signal.aborted ||
              latest.folderPath !== resolved.folderPath ||
              latest.workspace.permission !== resolved.workspace.permission
            ) {
              throw new Error(
                "The source workspace changed while Aiden was restoring the worktree.",
              );
            }
          },
          saveWorkspace: () => dependencies.saveWorkspace(workspace),
          validateAfterSave: () => {
            if (signal.aborted || dependencies.workspaceIsChanging(sourceWorkspaceId)) {
              throw new Error("The source workspace changed while Aiden was saving the worktree.");
            }
          },
          removeWorkspaceRecord: (savedWorkspace) =>
            dependencies.removeWorkspace(savedWorkspace.id),
          rollbackWorktree: () => dependencies.rollbackWorktree(resolved.folderPath, worktree),
        });
        dependencies.notifyChanged();
        return saved;
      } catch (error) {
        if (error instanceof ManagedWorktreeCreationError) {
          dependencies.logError("git", error.logMessage, error.errors);
        }
        throw error;
      }
    });

  return { create, remove, restore };
}

export type WorkspaceWorktreeApplicationService = ReturnType<
  typeof createWorkspaceWorktreeApplicationService
>;
