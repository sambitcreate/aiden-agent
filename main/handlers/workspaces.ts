// Workspace CRUD + folder helpers (git status, reveal in Finder).

import * as path from "path";
import { ipcMain, shell } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { listExternalEditors, openFolderInExternalEditor } from "../services/external-editors.js";
import { gitBranches, gitCheckout, gitCreateBranch, gitInfo } from "../services/git.js";
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

export function registerWorkspaceHandlers(): void {
  ipcMain.handle("workspaces:list", async () => configStore.listWorkspaces());

  ipcMain.handle("workspaces:get", async (_event, id: unknown) =>
    (await configStore.getWorkspace(asString(id, "id"))) ?? null,
  );

  ipcMain.handle("workspaces:create", async (_event, input: unknown) => {
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const folderPath = typeof i.folderPath === "string" && i.folderPath ? i.folderPath : undefined;
    const name =
      (typeof i.name === "string" && i.name.trim()) || (folderPath ? path.basename(folderPath) : "Workspace");
    const permission = PERMISSIONS.includes(i.permission as WorkspacePermission)
      ? (i.permission as WorkspacePermission)
      : "ask";
    const now = Date.now();
    const workspace: Workspace = { id: newId(), name, folderPath, permission, createdAt: now, updatedAt: now };
    return configStore.saveWorkspace(workspace);
  });

  ipcMain.handle("workspaces:update", async (_event, id: unknown, patch: unknown) => {
    const existing = await configStore.getWorkspace(asString(id, "id"));
    if (!existing) throw new Error(`Workspace ${String(id)} not found.`);
    const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
    const next: Workspace = {
      ...existing,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : existing.name,
      folderPath:
        "folderPath" in p
          ? typeof p.folderPath === "string" && p.folderPath
            ? p.folderPath
            : undefined
          : existing.folderPath,
      permission: PERMISSIONS.includes(p.permission as WorkspacePermission)
        ? (p.permission as WorkspacePermission)
        : existing.permission,
    };
    const saved = await configStore.saveWorkspace(next);
    if (saved.permission === "none" || saved.folderPath !== existing.folderPath) {
      terminalService.closeForWorkspace(existing.id);
    }
    return saved;
  });

  ipcMain.handle("workspaces:remove", async (_event, id: unknown) => {
    const workspaceId = asString(id, "id");
    terminalService.closeForWorkspace(workspaceId);
    await configStore.removeWorkspace(workspaceId);
  });

  ipcMain.handle("workspaces:gitInfo", async (_event, folderPath: unknown) => {
    if (typeof folderPath !== "string" || !folderPath) return { isRepo: false };
    return gitInfo(folderPath);
  });

  // ── Git branch picker ────────────────────────────────────────────────
  ipcMain.handle("git:branches", async (_event, folderPath: unknown) => {
    if (typeof folderPath !== "string" || !folderPath) return { isRepo: false, branches: [], uncommitted: 0 };
    return gitBranches(folderPath);
  });

  ipcMain.handle("git:checkout", async (_event, folderPath: unknown, name: unknown) => {
    await gitCheckout(asString(folderPath, "folderPath"), asString(name, "name"));
  });

  ipcMain.handle("git:createBranch", async (_event, folderPath: unknown, name: unknown) => {
    await gitCreateBranch(asString(folderPath, "folderPath"), asString(name, "name"));
  });

  // Reveal the workspace folder in Finder. shell.openPath opens a directory itself.
  ipcMain.handle("workspaces:openFolder", async (_event, folderPath: unknown) => {
    const p = asString(folderPath, "folderPath");
    const error = await shell.openPath(p);
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
