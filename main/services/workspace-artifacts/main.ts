/** Electron-main binding for workspace artifacts. */

import path from "node:path";
import { app, ipcMain } from "../../platform.js";
import type { WorkspaceArtifactsChangedEvent } from "../../../renderer/shared/workspace-artifacts.js";
import { WorkspaceArtifactStore } from "./store.js";

/** Device-local and never portable: artifacts can run commands in a local folder. */
export const workspaceArtifactStore = new WorkspaceArtifactStore({
  root: () => path.join(app.getPath("userData"), "workspace-artifacts"),
});

export function notifyWorkspaceArtifactsChanged(event: WorkspaceArtifactsChangedEvent): void {
  ipcMain.broadcast("workspaces:artifacts-changed", event);
}
