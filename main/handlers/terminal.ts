// IPC handlers for the user-operated terminal drawer.

import * as fs from "fs/promises";
import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import { terminalService } from "../services/terminal.js";

function asSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected a terminal session id.");
  return value;
}

async function workspaceFolder(workspaceId: unknown): Promise<{ id: string; folderPath: string }> {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("Expected a workspace id.");
  }
  const workspace = await configStore.getWorkspace(workspaceId);
  if (!workspace?.folderPath) throw new Error("Open a folder workspace before starting a terminal.");
  if (workspace.permission === "none") throw new Error("Enable workspace access before starting a terminal.");
  const stat = await fs.stat(workspace.folderPath);
  if (!stat.isDirectory()) throw new Error("The workspace folder is no longer available.");
  return { id: workspace.id, folderPath: workspace.folderPath };
}

async function ensureSessionAccess(event: Electron.IpcMainInvokeEvent, sessionId: string): Promise<void> {
  const workspaceId = terminalService.workspaceId(sessionId, event.sender);
  const workspace = await configStore.getWorkspace(workspaceId);
  if (workspace && workspace.permission !== "none") return;
  terminalService.close(sessionId, event.sender);
  throw new Error("Workspace access is disabled; the terminal was closed.");
}

export function registerTerminalHandlers(): void {
  ipcMain.handle("terminal:create", async (event, workspaceId: unknown) => {
    const workspace = await workspaceFolder(workspaceId);
    return await terminalService.create(workspace.id, workspace.folderPath, event.sender);
  });
  ipcMain.handle("terminal:snapshot", (event, sessionId: unknown) =>
    terminalService.snapshot(asSessionId(sessionId), event.sender),
  );
  ipcMain.handle("terminal:write", async (event, sessionId: unknown, data: unknown) => {
    const id = asSessionId(sessionId);
    await ensureSessionAccess(event, id);
    terminalService.write(id, data, event.sender);
  });
  ipcMain.handle("terminal:resize", (event, sessionId: unknown, cols: unknown, rows: unknown) =>
    terminalService.resize(asSessionId(sessionId), cols, rows, event.sender),
  );
  ipcMain.handle("terminal:close", (event, sessionId: unknown) =>
    terminalService.close(asSessionId(sessionId), event.sender),
  );
}
