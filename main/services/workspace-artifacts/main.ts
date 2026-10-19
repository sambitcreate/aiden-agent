/** Electron-main binding for workspace artifacts. */

import path from "node:path";
import { app, ipcMain, logger } from "../../platform.js";
import type { WorkspaceArtifactsChangedEvent } from "../../../renderer/shared/workspace-artifacts.js";
import { agentShellCommandEnvironment } from "../agent-command-environment.js";
import { runBoundedShellCommand } from "../bounded-shell-command.js";
import { readWorkspaceFile } from "../workspace-files.js";
import { createWorkspaceArtifactRunner } from "./runner.js";
import { WorkspaceArtifactStore } from "./store.js";

/** Device-local and never portable: artifacts can run commands in a local folder. */
export const workspaceArtifactStore = new WorkspaceArtifactStore({
  root: () => path.join(app.getPath("userData"), "workspace-artifacts"),
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

export const workspaceArtifactRunner = createWorkspaceArtifactRunner({
  runShell: runBoundedShellCommand,
  readFile: async (root, file, signal) => (await readWorkspaceFile(root, file, signal)).content,
  env: agentShellCommandEnvironment,
  store: workspaceArtifactStore,
  notify: notifyWorkspaceArtifactsChanged,
});
