/** Electron-main binding for workspace artifacts. */

import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, dialog, ipcMain, logger } from "../../platform.js";
import type { WorkspaceArtifactsChangedEvent } from "../../../renderer/shared/workspace-artifacts.js";
import { agentShellCommandEnvironment } from "../agent-command-environment.js";
import { runBoundedShellCommand } from "../bounded-shell-command.js";
import { writeFileAtomic } from "../durable-fs.js";
import { readWorkspaceFile } from "../workspace-files.js";
import { createWorkspaceArtifactRunner } from "./runner.js";
import { WorkspaceArtifactStore } from "./store.js";
import { readWorkspaceArtifactPageFile, type WorkspaceArtifactFiles } from "./transfer.js";

/** Device-local and never portable: artifacts can run commands in a local folder. */
export const workspaceArtifactStore = new WorkspaceArtifactStore({
  root: () => path.join(app.getPath("userData"), "workspace-artifacts"),
  // History is a convenience: a failed write is logged and the update stands.
  onHistoryError: (error) => {
    logger.error("workspace", "Could not keep an earlier version of an artifact.", error);
  },
});

/**
 * Drops a removed workspace's pages. The workspace record is already gone,
 * so a failure here only leaves clutter and is logged rather than thrown.
 */
export async function removeWorkspaceArtifacts(workspaceId: string): Promise<void> {
  await workspaceArtifactStore.removeWorkspace(workspaceId).catch((error: unknown) => {
    logger.error("workspace", "Could not remove the workspace's artifacts.", error);
  });
}

export function notifyWorkspaceArtifactsChanged(event: WorkspaceArtifactsChangedEvent): void {
  ipcMain.broadcast("workspaces:artifacts-changed", event);
}

function parentWindow(event: unknown): Electron.BrowserWindow | null {
  const parent = BrowserWindow.fromWebContents((event as IpcMainInvokeEvent).sender);
  return parent && !parent.isDestroyed() ? parent : null;
}

/** Native dialogs for Export page and Import page, attached to the calling window. */
export const workspaceArtifactFiles: WorkspaceArtifactFiles = {
  chooseExportPath: async (event, defaultName) => {
    const parent = parentWindow(event);
    const options: Electron.SaveDialogOptions = {
      title: "Export page",
      defaultPath: defaultName,
      filters: [{ name: "Aiden page", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  chooseImportFile: async (event) => {
    const parent = parentWindow(event);
    // ".aiden-page.json" ends in ".json", which is as far as file filters match.
    const options: Electron.OpenDialogOptions = {
      title: "Import page",
      properties: ["openFile"],
      filters: [{ name: "Aiden page", extensions: ["json"] }],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  writeFile: (filePath, text) => writeFileAtomic(filePath, text, { mode: 0o600 }),
  readFile: readWorkspaceArtifactPageFile,
};

export const workspaceArtifactRunner = createWorkspaceArtifactRunner({
  runShell: runBoundedShellCommand,
  readFile: async (root, file, signal) => (await readWorkspaceFile(root, file, signal)).content,
  env: agentShellCommandEnvironment,
  store: workspaceArtifactStore,
  notify: notifyWorkspaceArtifactsChanged,
});
