import { ipcMain } from "../platform.js";
import { GitRepoWatcher } from "./git-repo-watcher.js";

/**
 * Repository changes (commit, checkout, stage, fetch, push) are pushed to the
 * renderer so its Git queries can poll slowly as a safety net only. One
 * instance serves the IPC handlers and the workspace and worktree removal
 * services, so a removal from any client (this Mac or a paired device) closes
 * the workspace's watcher.
 */
export const workspaceGitWatcher = new GitRepoWatcher({
  notify: (workspaceId, generation) => ipcMain.broadcast("git:changed", { workspaceId, generation }),
});
