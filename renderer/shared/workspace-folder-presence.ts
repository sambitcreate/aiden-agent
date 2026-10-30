// Whether a workspace's folder is still on disk, as main reports it to the
// renderer. `none`: the workspace has no folder. `unknown`: the check could not
// answer (for example a permission error), which is not treated as missing.
export interface WorkspaceFolderPresenceResult {
  presence: "present" | "missing" | "unknown" | "none";
  /** The folder with the home folder shown as `~`; absent for `none`. */
  folder?: string;
}

/** One sentence naming a moved or deleted workspace folder, shared by main and the renderer. */
export function workspaceFolderMissingMessage(name: string, folder?: string): string {
  const where = folder ? `: ${folder}` : "";
  return `The folder for “${name}” is missing${where}. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, or start the chat in another workspace.`;
}

/** The short send refusal; the notice above the composer carries the details. */
export const WORKSPACE_FOLDER_MISSING_SEND_REFUSAL =
  "This chat's workspace folder is missing. Put it back, then send again.";

/**
 * Paired devices get the same refusal without a path: Remote errors never
 * carry one.
 */
export const WORKSPACE_FOLDER_MISSING_REMOTE_REFUSAL =
  "This chat's workspace folder is missing on your Mac. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, then send again.";

/**
 * Which workspaces the check covers. An Aiden-managed worktree has its own
 * restore flow, and a No Access workspace never touches its folder.
 */
export function workspaceFolderCheckApplies(workspace: {
  folderPath?: string;
  permission?: string;
  managedWorktree?: unknown;
}): boolean {
  return Boolean(workspace.folderPath) && !workspace.managedWorktree && workspace.permission !== "none";
}
