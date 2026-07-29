// IPC handlers for the user-operated terminal drawer.

import * as fs from "fs/promises";
import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { terminalService } from "../services/terminal.js";
import {
  commitWithWorkspaceMutationAdmission,
  workspaceMutationGate,
} from "../services/workspace-mutation-gate.js";
import { assertManagedWorktreeAdmission } from "../services/managed-worktree-admission.js";
import {
  rendererDocumentOwner,
  type RendererDocumentOwner,
} from "../services/renderer-document-owner.js";

function asSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Expected a terminal session id.");
  return value;
}

async function workspaceFolder(workspaceId: unknown): Promise<{ id: string; folderPath: string }> {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("Expected a workspace id.");
  }
  const workspace = await configStore.getWorkspace(workspaceId);
  if (!workspace?.folderPath)
    throw new Error("Open a folder workspace before starting a terminal.");
  if (workspace.permission === "none")
    throw new Error("Enable workspace access before starting a terminal.");
  await assertManagedWorktreeAdmission(workspace);
  const stat = await fs.stat(workspace.folderPath);
  if (!stat.isDirectory()) throw new Error("The workspace folder is no longer available.");
  return { id: workspace.id, folderPath: workspace.folderPath };
}

function terminalOwner(event: Electron.IpcMainInvokeEvent): RendererDocumentOwner {
  return rendererDocumentOwner(
    event,
    () => new Error("Terminal access requires the active application document."),
  );
}

async function ensureSessionAccess(
  owner: RendererDocumentOwner,
  sessionId: string,
  workspaceId: string,
  mutationSignal: AbortSignal,
): Promise<void> {
  const workspace = await configStore.getWorkspace(workspaceId);
  if (mutationSignal.aborted) {
    throw new Error("The workspace is changing; terminal input is paused.");
  }
  try {
    if (workspace && workspace.permission !== "none") {
      await assertManagedWorktreeAdmission(workspace);
      if (mutationSignal.aborted) {
        throw new Error("The workspace is changing; terminal input is paused.");
      }
      return;
    }
  } catch {
    if (mutationSignal.aborted) {
      throw new Error("The workspace is changing; terminal input is paused.");
    }
    terminalService.close(sessionId, owner);
    throw new Error("The managed worktree changed; the terminal was closed.");
  }
  terminalService.close(sessionId, owner);
  throw new Error("Workspace access is disabled; the terminal was closed.");
}

function withSessionAccess<T>(
  owner: RendererDocumentOwner,
  sessionId: string,
  operation: () => T,
): Promise<T> {
  const workspaceId = terminalService.workspaceId(sessionId, owner);
  return commitWithWorkspaceMutationAdmission(
    workspaceMutationGate,
    workspaceId,
    async (mutationSignal) => {
      await ensureSessionAccess(owner, sessionId, workspaceId, mutationSignal);
      return operation;
    },
  );
}

export function registerTerminalHandlers(): void {
  ipcMain.handle("terminal:create", async (event, workspaceId: unknown) => {
    const owner = terminalOwner(event);
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new Error("Expected a workspace id.");
    }
    const admission = workspaceMutationGate.admit(workspaceId);
    const lifecycle = new AbortController();
    const onWorkspaceMutation = () =>
      lifecycle.abort(
        admission.signal.reason instanceof Error
          ? admission.signal.reason
          : new Error("The workspace changed."),
      );
    const onDestroyed = () =>
      lifecycle.abort(new Error("The renderer document is no longer active."));
    if (admission.signal.aborted) onWorkspaceMutation();
    else admission.signal.addEventListener("abort", onWorkspaceMutation, { once: true });
    const removeOwnerInvalidation = owner.onInvalidated(onDestroyed);
    try {
      const workspace = await workspaceFolder(workspaceId);
      return await terminalService.create(
        workspace.id,
        workspace.folderPath,
        owner,
        lifecycle.signal,
        async () => {
          if (owner.isDestroyed()) {
            throw new Error("The renderer document is no longer active.");
          }
          const latest = await workspaceFolder(workspace.id);
          if (latest.folderPath !== workspace.folderPath) {
            throw new Error("The workspace changed before the terminal could start.");
          }
        },
      );
    } finally {
      admission.signal.removeEventListener("abort", onWorkspaceMutation);
      removeOwnerInvalidation();
      admission.release();
    }
  });
  ipcMain.handle("terminal:snapshot", async (event, sessionId: unknown) => {
    const owner = terminalOwner(event);
    const id = asSessionId(sessionId);
    return withSessionAccess(owner, id, () => terminalService.snapshot(id, owner));
  });
  ipcMain.handle("terminal:write", async (event, sessionId: unknown, data: unknown) => {
    const owner = terminalOwner(event);
    const id = asSessionId(sessionId);
    await withSessionAccess(owner, id, () => terminalService.write(id, data, owner));
  });
  ipcMain.handle(
    "terminal:resize",
    async (event, sessionId: unknown, cols: unknown, rows: unknown) => {
      const owner = terminalOwner(event);
      const id = asSessionId(sessionId);
      return withSessionAccess(owner, id, () => terminalService.resize(id, cols, rows, owner));
    },
  );
  ipcMain.handle("terminal:close", (event, sessionId: unknown) =>
    terminalService.close(asSessionId(sessionId), terminalOwner(event)),
  );
}
