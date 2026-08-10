// Workspace CRUD + folder helpers (git status, reveal in Finder).

import * as fs from "fs/promises";
import * as path from "path";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { BrowserWindow, dialog, ipcMain, logger, shell } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { ensureUserDataDir } from "../services/data-store.js";
import { listExternalEditors, openFolderInExternalEditor } from "../services/external-editors.js";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCompare,
  gitComparisonDiff,
  gitCreateBranch,
  gitCreateWorktree,
  gitDeleteManagedWorktree,
  gitDiff,
  gitFinalizeManagedWorktreeDeletion,
  gitInfo,
  gitManagedWorktreeDeletionPending,
  gitManagedWorktreeRegistered,
  gitManagedWorktreeUsable,
  gitPush,
  gitPushCapability,
  gitReview,
  gitRollbackWorktree,
  gitWorktrees,
  GitManagedWorktreeDeleteError,
  type GitCommitInput,
  type GitComparisonDiffInput,
  type GitDiffInput,
  type GitPushInput,
} from "../services/git.js";
import { llmClient } from "../services/llm-client.js";
import { scheduleService } from "../services/schedule-service.js";
import { createScratchWorkspaceDirectory } from "../services/scratch-workspace.js";
import { terminalService } from "../services/terminal.js";
import type { Workspace, WorkspacePermission } from "../services/types.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
} from "../services/workspace-files.js";
import { workspaceMutationGate } from "../services/workspace-mutation-gate.js";
import { removeManagedWorkspace } from "../services/managed-worktree-removal-core.js";
import { assertManagedWorktreeAdmission } from "../services/managed-worktree-admission.js";
import { withWorkspaceScheduleRestoration } from "../services/workspace-schedule-restoration.js";
import {
  commitManagedWorktreeCreation,
  ManagedWorktreeCreationError,
} from "../services/managed-worktree-creation-core.js";
import {
  admitRendererOwnedWorkspaceOperation,
  workspaceOperationRegistry,
} from "../services/workspace-operation-registry.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { assertWorkspaceRecordRemovalAllowed } from "../services/workspace-record-removal.js";
import { parseWorktreeCreateParams } from "./worktree-create-params.js";

const PERMISSIONS: WorkspacePermission[] = ["full", "ask", "none"];

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function asText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected text for "${name}".`);
  return value;
}

function asGitCommitInput(value: unknown): GitCommitInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const mode = input.mode;
  if (mode !== "staged" && mode !== "all") {
    throw new Error('Expected "mode" to be "staged" or "all".');
  }
  return {
    expectedSnapshot: asString(input.expectedSnapshot, "expectedSnapshot"),
    message: asText(input.message, "message"),
    mode,
  };
}

function asGitDiffInput(value: unknown): GitDiffInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    expectedSnapshot: asString(input.expectedSnapshot, "expectedSnapshot"),
    path: asString(input.path, "path"),
  };
}

function asGitPushInput(value: unknown): GitPushInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (typeof input.setUpstream !== "boolean") throw new Error('Expected boolean "setUpstream".');
  return {
    destinationBranch: asString(input.destinationBranch, "destinationBranch"),
    expectedBranch: asString(input.expectedBranch, "expectedBranch"),
    expectedHead: asString(input.expectedHead, "expectedHead"),
    expectedRemoteIdentity: asString(input.expectedRemoteIdentity, "expectedRemoteIdentity"),
    remote: asString(input.remote, "remote"),
    setUpstream: input.setUpstream,
  };
}

function asGitComparisonDiffInput(value: unknown): GitComparisonDiffInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    expectedHead: asString(input.expectedHead, "expectedHead"),
    expectedTarget: asString(input.expectedTarget, "expectedTarget"),
    mergeBase: asString(input.mergeBase, "mergeBase"),
    path: asString(input.path, "path"),
    targetRef: asString(input.targetRef, "targetRef"),
  };
}

function newId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface WorkspaceDirectory {
  folderPath: string;
  workspace: Workspace;
}

async function withWorkspaceOperation<T>(
  event: IpcMainInvokeEvent,
  workspaceIdValue: unknown,
  operation: (resolved: WorkspaceDirectory, signal: AbortSignal) => Promise<T>,
  allowNoAccess = false,
): Promise<T> {
  const workspaceId = asString(workspaceIdValue, "workspaceId");
  if (workspaceMutationGate.isChanging(workspaceId))
    throw new Error("The workspace is changing. Try again in a moment.");
  const owner = rendererDocumentOwner(
    event,
    () => new Error("Workspace access requires the active renderer document."),
  );
  const admission = admitRendererOwnedWorkspaceOperation(
    workspaceOperationRegistry,
    owner,
    workspaceId,
  );
  try {
    const resolved = await workspaceDirectory(workspaceId, true, allowNoAccess);
    if (
      !resolved ||
      owner.isDestroyed() ||
      admission.signal.aborted ||
      workspaceMutationGate.isChanging(workspaceId)
    ) {
      throw new Error("The workspace changed before the operation could start.");
    }
    return await operation(resolved, admission.signal);
  } finally {
    admission.release();
  }
}

async function withWorkspaceRecordOperation<T>(
  event: IpcMainInvokeEvent,
  workspaceIdValue: unknown,
  operation: (workspace: Workspace, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const workspaceId = asString(workspaceIdValue, "workspaceId");
  if (workspaceMutationGate.isChanging(workspaceId)) {
    throw new Error("The workspace is changing. Try again in a moment.");
  }
  const owner = rendererDocumentOwner(
    event,
    () => new Error("Workspace access requires the active renderer document."),
  );
  const admission = admitRendererOwnedWorkspaceOperation(
    workspaceOperationRegistry,
    owner,
    workspaceId,
  );
  try {
    const workspace = await configStore.getWorkspace(workspaceId);
    if (
      !workspace ||
      owner.isDestroyed() ||
      admission.signal.aborted ||
      workspaceMutationGate.isChanging(workspaceId)
    ) {
      throw new Error("The workspace changed before the operation could start.");
    }
    return await operation(workspace, admission.signal);
  } finally {
    admission.release();
  }
}

async function withOptionalWorkspaceOperation<T>(
  event: IpcMainInvokeEvent,
  workspaceIdValue: unknown,
  operation: (resolved: WorkspaceDirectory | undefined, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const workspaceId = asString(workspaceIdValue, "workspaceId");
  return withWorkspaceRecordOperation(event, workspaceId, async (_workspace, signal) => {
    const resolved = await workspaceDirectory(workspaceId, false);
    if (signal.aborted || workspaceMutationGate.isChanging(workspaceId)) {
      throw new Error("The workspace changed before the operation could start.");
    }
    return operation(resolved, signal);
  });
}

async function saveWorkspaceForFolder(
  folderPath: string,
  permission: WorkspacePermission,
): Promise<Workspace> {
  const canonicalPath = await fs.realpath(folderPath);
  if (!(await fs.stat(canonicalPath)).isDirectory())
    throw new Error("Choose a folder for this workspace.");
  const now = Date.now();
  return configStore.saveWorkspace({
    id: newId(),
    name: path.basename(canonicalPath) || "Workspace",
    folderPath: canonicalPath,
    permission,
    createdAt: now,
    updatedAt: now,
  });
}

/** Resolve Git paths from persisted workspace state, never from renderer input. */
async function workspaceDirectory(
  workspaceId: unknown,
  required: boolean,
  allowNoAccess = false,
): Promise<WorkspaceDirectory | undefined> {
  const id = asString(workspaceId, "workspaceId");
  const workspace = await configStore.getWorkspace(id);
  if (!workspace) throw new Error(`Workspace ${id} was not found.`);
  if (workspace.permission === "none" && !allowNoAccess) {
    if (!required) return undefined;
    throw new Error(`${workspace.name} does not allow local file access.`);
  }
  if (!workspace.folderPath) {
    if (!required) return undefined;
    throw new Error(`${workspace.name} does not have a folder.`);
  }
  await assertManagedWorktreeAdmission(workspace);
  try {
    const folderPath = await fs.realpath(workspace.folderPath);
    const stats = await fs.stat(folderPath);
    if (!stats.isDirectory()) throw new Error("not a directory");
    return { folderPath, workspace };
  } catch {
    if (!required) return undefined;
    throw new Error(`${workspace.name}'s folder is no longer available.`);
  }
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle("workspaces:list", async () => configStore.listWorkspaces());

  ipcMain.handle(
    "workspaces:get",
    async (_event, id: unknown) => (await configStore.getWorkspace(asString(id, "id"))) ?? null,
  );

  ipcMain.handle("workspaces:create", async (_event, input: unknown) => {
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if ("folderPath" in i)
      throw new Error("Choose workspace folders through Aiden's folder picker.");
    const name = (typeof i.name === "string" && i.name.trim()) || "Workspace";
    const permission = PERMISSIONS.includes(i.permission as WorkspacePermission)
      ? (i.permission as WorkspacePermission)
      : "ask";
    const now = Date.now();
    const workspace: Workspace = {
      id: newId(),
      name,
      permission,
      createdAt: now,
      updatedAt: now,
    };
    return configStore.saveWorkspace(workspace);
  });

  ipcMain.handle("workspaces:createFromFolder", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return saveWorkspaceForFolder(result.filePaths[0], "ask");
  });

  ipcMain.handle("workspaces:createScratch", async () => {
    const scratch = await createScratchWorkspaceDirectory();
    const now = Date.now();
    const workspace: Workspace = {
      id: newId(),
      name: scratch.name,
      folderPath: scratch.folderPath,
      permission: "ask",
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await configStore.saveWorkspace(workspace);
    } catch (error) {
      // The directory is still empty here; avoid leaving an orphan if persistence fails.
      await fs.rmdir(scratch.folderPath).catch(() => undefined);
      throw error;
    }
  });

  ipcMain.handle("workspaces:update", async (_event, id: unknown, patch: unknown) => {
    const workspaceId = asString(id, "id");
    const finishMutation = workspaceMutationGate.begin(workspaceId);
    try {
      await workspaceOperationRegistry.cancelAndSettle(workspaceId);
      const existing = await configStore.getWorkspace(workspaceId);
      if (!existing) throw new Error(`Workspace ${String(id)} not found.`);
      const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<
        string,
        unknown
      >;
      if ("folderPath" in p)
        throw new Error("Workspace folders cannot be changed from renderer input.");
      const next: Workspace = {
        ...existing,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : existing.name,
        permission: PERMISSIONS.includes(p.permission as WorkspacePermission)
          ? (p.permission as WorkspacePermission)
          : existing.permission,
      };
      if (next.permission !== existing.permission) {
        return await withWorkspaceScheduleRestoration(
          {
            restoreOnExit: existing.permission !== "none",
            resume: () => scheduleService.resumeWorkspace(existing.id),
            onResumeError: (error) => {
              logger.error(
                "schedule",
                "Could not restore scheduled tasks after workspace update failed.",
                error,
              );
            },
          },
          async ({ ensureResumedOnExit, keepPaused }) => {
            terminalService.closeForWorkspace(existing.id);
            await llmClient.cancelWorkspaceAndSettle(existing.id);
            await scheduleService.cancelWorkspace(existing.id);
            const saved = await configStore.saveWorkspace(next);
            if (saved.permission !== "none") {
              ensureResumedOnExit();
              await scheduleService.resumeWorkspace(saved.id);
            }
            keepPaused();
            return saved;
          },
        );
      }
      return await configStore.saveWorkspace(next);
    } finally {
      finishMutation();
    }
  });

  ipcMain.handle("workspaces:remove", async (_event, id: unknown) => {
    const workspaceId = asString(id, "id");
    const finishMutation = workspaceMutationGate.begin(workspaceId);
    terminalService.closeForWorkspace(workspaceId);
    try {
      await workspaceOperationRegistry.cancelAndSettle(workspaceId);
      const existing = await configStore.getWorkspace(workspaceId);
      assertWorkspaceRecordRemovalAllowed(existing);
      await withWorkspaceScheduleRestoration(
        {
          restoreOnExit: existing?.permission !== "none",
          resume: () => scheduleService.resumeWorkspace(workspaceId),
          onResumeError: (error) => {
            logger.error(
              "schedule",
              "Could not restore scheduled tasks after workspace removal failed.",
              error,
            );
          },
        },
        async ({ keepPaused }) => {
          await llmClient.cancelWorkspaceAndSettle(workspaceId);
          await scheduleService.cancelWorkspace(workspaceId);
          await configStore.removeWorkspace(workspaceId);
          keepPaused();
        },
      );
    } finally {
      finishMutation();
    }
  });

  ipcMain.handle("workspaces:gitInfo", async (event, workspaceId: unknown) =>
    withOptionalWorkspaceOperation(event, workspaceId, async (resolved, signal) =>
      resolved ? gitInfo(resolved.folderPath, signal) : { isRepo: false },
    ),
  );

  // ── Environment panel: Files + Review ────────────────────────────────
  ipcMain.handle("workspaces:files", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      listWorkspaceFiles(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("workspaces:readFile", async (event, workspaceId: unknown, filePath: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      readWorkspaceFile(resolved.folderPath, asString(filePath, "path"), signal),
    ),
  );

  ipcMain.handle(
    "workspaces:writeFile",
    async (
      event,
      workspaceId: unknown,
      filePath: unknown,
      content: unknown,
      expectedVersion: unknown,
    ) =>
      withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
        writeWorkspaceFile(
          resolved.folderPath,
          asString(filePath, "path"),
          asText(content, "content"),
          asString(expectedVersion, "expectedVersion"),
          signal,
        ).then(
          (document) => ({ ok: true as const, document }),
          (error: unknown) => ({
            ok: false as const,
            code: error instanceof WorkspaceFileError ? error.code : ("io_error" as const),
            message: error instanceof Error ? error.message : "Aiden could not save this file.",
          }),
        ),
      ),
  );

  ipcMain.handle("git:review", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitReview(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("git:diff", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitDiff(resolved.folderPath, asGitDiffInput(input), signal),
    ),
  );

  ipcMain.handle("git:commit", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCommit(resolved.folderPath, asGitCommitInput(input), signal),
    ),
  );

  ipcMain.handle("git:pushCapability", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitPushCapability(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("git:push", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitPush(resolved.folderPath, asGitPushInput(input), signal),
    ),
  );

  ipcMain.handle("git:compare", async (event, workspaceId: unknown, targetRef: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCompare(resolved.folderPath, asString(targetRef, "targetRef"), signal),
    ),
  );

  ipcMain.handle("git:comparisonDiff", async (event, workspaceId: unknown, input: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitComparisonDiff(resolved.folderPath, asGitComparisonDiffInput(input), signal),
    ),
  );

  // ── Git branch picker ────────────────────────────────────────────────
  ipcMain.handle("git:branches", async (event, workspaceId: unknown) =>
    withOptionalWorkspaceOperation(event, workspaceId, async (resolved, signal) =>
      resolved
        ? gitBranches(resolved.folderPath, signal)
        : { isRepo: false, branches: [], remoteBranches: [], uncommitted: 0 },
    ),
  );

  ipcMain.handle("git:checkout", async (event, workspaceId: unknown, name: unknown) => {
    await withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCheckout(resolved.folderPath, asString(name, "name"), signal),
    );
  });

  ipcMain.handle("git:createBranch", async (event, workspaceId: unknown, name: unknown) => {
    await withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitCreateBranch(resolved.folderPath, asString(name, "name"), signal),
    );
  });

  ipcMain.handle("git:worktrees", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, (resolved, signal) =>
      gitWorktrees(resolved.folderPath, signal),
    ),
  );

  ipcMain.handle("git:createWorktree", async (event, workspaceId: unknown, name: unknown) => {
    const { workspaceId: sourceWorkspaceId, branch } = parseWorktreeCreateParams(
      workspaceId,
      name,
    );
    return withWorkspaceOperation(event, sourceWorkspaceId, async (resolved, signal) => {
      const worktreeRoot = await ensureUserDataDir("worktrees");
      const worktree = await gitCreateWorktree(resolved.folderPath, worktreeRoot, branch, signal);
      const now = Date.now();
      const workspace: Workspace = {
        id: newId(),
        name: `${path.basename(resolved.workspace.folderPath ?? resolved.workspace.name)} · ${branch}`,
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
        },
        createdAt: now,
        updatedAt: now,
      };
      try {
        return await commitManagedWorktreeCreation({
          validateBeforeSave: async () => {
            const latest = await workspaceDirectory(sourceWorkspaceId, true);
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
          saveWorkspace: () => configStore.saveWorkspace(workspace),
          validateAfterSave: () => {
            if (signal.aborted || workspaceMutationGate.isChanging(sourceWorkspaceId)) {
              throw new Error("The source workspace changed while Aiden was saving the worktree.");
            }
          },
          removeWorkspaceRecord: (saved) => configStore.removeWorkspace(saved.id),
          rollbackWorktree: () => gitRollbackWorktree(resolved.folderPath, worktree),
        });
      } catch (error) {
        if (error instanceof ManagedWorktreeCreationError) {
          logger.error("git", error.logMessage, error.errors);
        }
        throw error;
      }
    });
  });

  ipcMain.handle("git:deleteManagedWorktree", async (event, workspaceId: unknown) => {
    const id = asString(workspaceId, "workspaceId");
    return withWorkspaceRecordOperation(event, id, async (workspace, signal) => {
      const managed = workspace.managedWorktree;
      if (!managed) throw new Error("This workspace is not an Aiden-managed worktree.");
      const finishMutation = workspaceMutationGate.begin(id);
      try {
        await workspaceOperationRegistry.cancelAndSettle(id, {
          exceptSignal: signal,
        });
        return await withWorkspaceScheduleRestoration(
          {
            restoreOnExit: workspace.permission !== "none",
            resume: () => scheduleService.resumeWorkspace(id),
            onResumeError: (error) => {
              logger.error(
                "schedule",
                "Could not restore scheduled tasks after managed worktree deletion failed.",
                error,
              );
            },
          },
          async ({ keepPaused }) => {
            terminalService.closeForWorkspace(id);
            await llmClient.cancelWorkspaceAndSettle(id);
            await scheduleService.cancelWorkspace(id);
            const result = await removeManagedWorkspace({
              deleteWorktree: () =>
                gitDeleteManagedWorktree(
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
              destructiveMutationAttempted: (error) =>
                error instanceof GitManagedWorktreeDeleteError
                  ? error.destructiveMutationAttempted
                  : undefined,
              deletionPending: () =>
                gitManagedWorktreeDeletionPending(
                  managed.worktreePath,
                  managed.worktreeGitDir!,
                  managed.ownershipToken!,
                ),
              workspacePathExists: async () => {
                try {
                  await fs.stat(managed.worktreePath);
                  return true;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                  throw error;
                }
              },
              worktreeRegistered: () =>
                gitManagedWorktreeRegistered(
                  managed.repositoryPath,
                  managed.worktreePath,
                  managed.branch,
                  managed.worktreeGitDir,
                  managed.ownershipToken,
                ),
              worktreeUsable: () =>
                gitManagedWorktreeUsable(
                  managed.repositoryPath,
                  managed.worktreePath,
                  managed.branch,
                  managed.worktreeGitDir,
                  managed.ownershipToken,
                  managed.worktreeDevice,
                  managed.worktreeInode,
                ),
              onDestructiveBoundary: keepPaused,
              removeWorkspaceRecord: () => configStore.removeWorkspace(id),
              reconciledResult: () => ({ branchDeleted: false }),
            });
            if (managed.worktreeGitDir && managed.ownershipToken) {
              await gitFinalizeManagedWorktreeDeletion(
                managed.worktreePath,
                managed.worktreeGitDir,
                managed.ownershipToken,
              );
            }
            return result;
          },
        );
      } finally {
        finishMutation();
      }
    });
  });

  // Reveal the workspace folder in Finder. shell.openPath opens a directory itself.
  ipcMain.handle("workspaces:openFolder", async (event, workspaceId: unknown) =>
    withWorkspaceOperation(event, workspaceId, async (resolved) => {
      const error = await shell.openPath(resolved.folderPath);
      if (error) throw new Error(`Could not open folder: ${error}`);
    }),
  );

  ipcMain.handle("workspaces:externalEditors", async (_event, forceRefresh: unknown) =>
    listExternalEditors(forceRefresh === true),
  );

  ipcMain.handle(
    "workspaces:openInEditor",
    async (event, workspaceId: unknown, editorId: unknown) =>
      withWorkspaceOperation(event, workspaceId, async (resolved) => {
        await openFolderInExternalEditor(resolved.folderPath, asString(editorId, "editorId"));
      }),
  );
}
