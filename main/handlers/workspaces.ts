// Workspace CRUD + folder helpers (git status, reveal in Finder).

import * as fs from "fs/promises";
import * as path from "path";
import type { OpenDialogOptions, WebContents } from "electron";
import { BrowserWindow, dialog, ipcMain, logger, shell } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { ensureUserDataDir } from "../services/data-store.js";
import { listExternalEditors, openFolderInExternalEditor } from "../services/external-editors.js";
import {
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  gitCreateWorktree,
  gitDeleteManagedWorktree,
  gitInfo,
  gitRollbackWorktree,
  gitWorktrees,
} from "../services/git.js";
import { llmClient } from "../services/llm-client.js";
import { createScratchWorkspaceDirectory } from "../services/scratch-workspace.js";
import { terminalService } from "../services/terminal.js";
import type { Workspace, WorkspacePermission } from "../services/types.js";

const PERMISSIONS: WorkspacePermission[] = ["full", "ask", "none"];

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

function newId(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface WorkspaceDirectory {
  folderPath: string;
  workspace: Workspace;
}

const gitOperations = new Map<string, Set<AbortController>>();
const workspacesUpdating = new Set<string>();

function cancelWorkspaceGitOperations(workspaceId: string): void {
  for (const controller of gitOperations.get(workspaceId) ?? []) controller.abort();
}

async function withWorkspaceGitOperation<T>(
  sender: WebContents,
  workspaceIdValue: unknown,
  operation: (resolved: WorkspaceDirectory, signal: AbortSignal) => Promise<T>,
  allowNoAccess = false,
): Promise<T> {
  const workspaceId = asString(workspaceIdValue, "workspaceId");
  if (workspacesUpdating.has(workspaceId)) throw new Error("The workspace is changing. Try again in a moment.");
  const controller = new AbortController();
  const controllers = gitOperations.get(workspaceId) ?? new Set<AbortController>();
  controllers.add(controller);
  gitOperations.set(workspaceId, controllers);
  const onDestroyed = () => controller.abort();
  sender.once("destroyed", onDestroyed);
  try {
    const resolved = await workspaceDirectory(workspaceId, true, allowNoAccess);
    if (!resolved || controller.signal.aborted || workspacesUpdating.has(workspaceId)) {
      throw new Error("The workspace changed before the Git operation could start.");
    }
    return await operation(resolved, controller.signal);
  } finally {
    sender.removeListener("destroyed", onDestroyed);
    controllers.delete(controller);
    if (controllers.size === 0) gitOperations.delete(workspaceId);
  }
}

async function saveWorkspaceForFolder(folderPath: string, permission: WorkspacePermission): Promise<Workspace> {
  const canonicalPath = await fs.realpath(folderPath);
  if (!(await fs.stat(canonicalPath)).isDirectory()) throw new Error("Choose a folder for this workspace.");
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

  ipcMain.handle("workspaces:get", async (_event, id: unknown) =>
    (await configStore.getWorkspace(asString(id, "id"))) ?? null,
  );

  ipcMain.handle("workspaces:create", async (_event, input: unknown) => {
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if ("folderPath" in i) throw new Error("Choose workspace folders through Aiden's folder picker.");
    const name = (typeof i.name === "string" && i.name.trim()) || "Workspace";
    const permission = PERMISSIONS.includes(i.permission as WorkspacePermission)
      ? (i.permission as WorkspacePermission)
      : "ask";
    const now = Date.now();
    const workspace: Workspace = { id: newId(), name, permission, createdAt: now, updatedAt: now };
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
    workspacesUpdating.add(workspaceId);
    cancelWorkspaceGitOperations(workspaceId);
    try {
      const existing = await configStore.getWorkspace(workspaceId);
      if (!existing) throw new Error(`Workspace ${String(id)} not found.`);
      const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
      if ("folderPath" in p) throw new Error("Workspace folders cannot be changed from renderer input.");
      const next: Workspace = {
        ...existing,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : existing.name,
        permission: PERMISSIONS.includes(p.permission as WorkspacePermission)
          ? (p.permission as WorkspacePermission)
          : existing.permission,
      };
      if (next.permission !== existing.permission) llmClient.cancelWorkspace(existing.id);
      const saved = await configStore.saveWorkspace(next);
      if (saved.permission === "none") terminalService.closeForWorkspace(existing.id);
      return saved;
    } finally {
      workspacesUpdating.delete(workspaceId);
    }
  });

  ipcMain.handle("workspaces:remove", async (_event, id: unknown) => {
    const workspaceId = asString(id, "id");
    workspacesUpdating.add(workspaceId);
    cancelWorkspaceGitOperations(workspaceId);
    try {
      llmClient.cancelWorkspace(workspaceId);
      terminalService.closeForWorkspace(workspaceId);
      await configStore.removeWorkspace(workspaceId);
    } finally {
      workspacesUpdating.delete(workspaceId);
    }
  });

  ipcMain.handle("workspaces:gitInfo", async (_event, workspaceId: unknown) => {
    const resolved = await workspaceDirectory(workspaceId, false);
    return resolved ? gitInfo(resolved.folderPath) : { isRepo: false };
  });

  // ── Git branch picker ────────────────────────────────────────────────
  ipcMain.handle("git:branches", async (_event, workspaceId: unknown) => {
    const resolved = await workspaceDirectory(workspaceId, false);
    return resolved
      ? gitBranches(resolved.folderPath)
      : { isRepo: false, branches: [], remoteBranches: [], uncommitted: 0 };
  });

  ipcMain.handle("git:checkout", async (event, workspaceId: unknown, name: unknown) => {
    await withWorkspaceGitOperation(event.sender, workspaceId, (resolved, signal) =>
      gitCheckout(resolved.folderPath, asString(name, "name"), signal),
    );
  });

  ipcMain.handle("git:createBranch", async (event, workspaceId: unknown, name: unknown) => {
    await withWorkspaceGitOperation(event.sender, workspaceId, (resolved, signal) =>
      gitCreateBranch(resolved.folderPath, asString(name, "name"), signal),
    );
  });

  ipcMain.handle("git:worktrees", async (_event, workspaceId: unknown) => {
    const resolved = (await workspaceDirectory(workspaceId, true))!;
    return gitWorktrees(resolved.folderPath);
  });

  ipcMain.handle("git:createWorktree", async (event, workspaceId: unknown, name: unknown) => {
    const sourceWorkspaceId = asString(workspaceId, "workspaceId");
    return withWorkspaceGitOperation(event.sender, sourceWorkspaceId, async (resolved, signal) => {
      const branch = asString(name, "name").trim();
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
          createdFromHead: worktree.createdFromHead,
        },
        createdAt: now,
        updatedAt: now,
      };
      try {
        const latest = await workspaceDirectory(sourceWorkspaceId, true);
        if (
          !latest ||
          signal.aborted ||
          latest.folderPath !== resolved.folderPath ||
          latest.workspace.permission !== resolved.workspace.permission
        ) {
          throw new Error("The source workspace changed while Aiden was creating the worktree.");
        }
        const saved = await configStore.saveWorkspace(workspace);
        if (signal.aborted || workspacesUpdating.has(sourceWorkspaceId)) {
          await configStore.removeWorkspace(saved.id);
          throw new Error("The source workspace changed while Aiden was saving the worktree.");
        }
        return saved;
      } catch (error) {
        try {
          await gitRollbackWorktree(resolved.folderPath, worktree);
        } catch (rollbackError) {
          logger.error("git", "Could not roll back a managed worktree after workspace persistence failed", rollbackError);
          throw new Error(
            "Aiden could not save or fully roll back the worktree. Inspect `git worktree list` before retrying.",
          );
        }
        throw error;
      }
    });
  });

  ipcMain.handle("git:deleteManagedWorktree", async (event, workspaceId: unknown) => {
    const id = asString(workspaceId, "workspaceId");
    return withWorkspaceGitOperation(event.sender, id, async (resolved, signal) => {
      const managed = resolved.workspace.managedWorktree;
      if (!managed) throw new Error("This workspace is not an Aiden-managed worktree.");
      const result = await gitDeleteManagedWorktree(
        managed.repositoryPath,
        managed.worktreePath,
        managed.branch,
        managed.createdFromHead,
        signal,
      );
      llmClient.cancelWorkspace(id);
      terminalService.closeForWorkspace(id);
      await configStore.removeWorkspace(id);
      return result;
    }, true);
  });

  // Reveal the workspace folder in Finder. shell.openPath opens a directory itself.
  ipcMain.handle("workspaces:openFolder", async (_event, workspaceId: unknown) => {
    const resolved = (await workspaceDirectory(workspaceId, true))!;
    const error = await shell.openPath(resolved.folderPath);
    if (error) throw new Error(`Could not open folder: ${error}`);
  });

  ipcMain.handle("workspaces:externalEditors", async (_event, forceRefresh: unknown) =>
    listExternalEditors(forceRefresh === true),
  );

  ipcMain.handle(
    "workspaces:openInEditor",
    async (_event, workspaceId: unknown, editorId: unknown) => {
      const id = asString(workspaceId, "workspaceId");
      const workspace = await configStore.getWorkspace(id);
      if (!workspace) throw new Error(`Workspace ${id} was not found.`);
      if (!workspace.folderPath) throw new Error(`${workspace.name} does not have a folder.`);
      await openFolderInExternalEditor(workspace.folderPath, asString(editorId, "editorId"));
    },
  );
}
