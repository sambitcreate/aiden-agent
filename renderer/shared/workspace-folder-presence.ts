// Whether a workspace's folder is still on disk, as main reports it to the
// renderer. `none`: the workspace has no folder. `unknown`: the check could not
// answer (for example a permission error), which is not treated as missing.
export interface WorkspaceFolderPresenceResult {
  presence: "present" | "missing" | "unknown" | "none";
  /** The folder with the home folder shown as `~`; absent for `none`. */
  folder?: string;
  /** For a missing Aiden-managed worktree: its branch and what can be done about it. */
  worktree?: MissingWorktreeOptions;
}

export interface MissingWorktreeOptions {
  branch: string;
  /**
   * The branch still exists, no other worktree has it, and Aiden was not in
   * the middle of removing it, so the checkout can be put back.
   */
  restorable: boolean;
  /** The workspace for the repository's main checkout, for a new chat there. */
  mainWorkspaceId?: string;
  mainWorkspaceName?: string;
}

/** One sentence naming a moved or deleted workspace folder, shared by main and the renderer. */
export function workspaceFolderMissingMessage(name: string, folder?: string): string {
  const where = folder ? `: ${folder}` : "";
  return `The folder for “${name}” is missing${where}. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, or start the chat in another workspace.`;
}

/** The notice for a chat whose Aiden-managed worktree folder was deleted. */
export function managedWorktreeMissingMessage(
  name: string,
  folder: string | undefined,
  options?: Pick<MissingWorktreeOptions, "branch" | "restorable" | "mainWorkspaceId">,
): string {
  const where = folder ? `: ${folder}` : "";
  const elsewhere = options?.mainWorkspaceId ? "start a new chat in the main checkout" : "start the chat in another workspace";
  if (!options) {
    return `The worktree folder for “${name}” is missing${where}. Restore it, or ${elsewhere}.`;
  }
  if (!options.restorable) {
    return `The worktree folder for “${name}” is missing${where}, and its branch ${options.branch} can't be checked out again (it was deleted, or another worktree has it). ${capitalize(elsewhere)}.`;
  }
  return `The worktree folder for “${name}” is missing${where}. If it's in the Trash, put it back to keep uncommitted changes, then check again. Or restore it from its branch ${options.branch}, or ${elsewhere}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The short send refusal; the notice above the composer carries the details. */
export const WORKSPACE_FOLDER_MISSING_SEND_REFUSAL =
  "This chat's workspace folder is missing. Put it back, then send again.";

export const MANAGED_WORKTREE_MISSING_SEND_REFUSAL =
  "This chat's worktree folder is missing. Restore it, or start a new chat in the main checkout.";

/**
 * Paired devices get the same refusal without a path: Remote errors never
 * carry one.
 */
export const WORKSPACE_FOLDER_MISSING_REMOTE_REFUSAL =
  "This chat's workspace folder is missing on your Mac. It may have been moved, renamed or deleted, or its drive isn't connected. Put it back, then send again.";

export const MANAGED_WORKTREE_MISSING_REMOTE_REFUSAL =
  "This chat's worktree folder was deleted on your Mac. Restore it from the chat on your Mac, then send again.";

/**
 * Which workspaces the check covers. A No Access workspace never touches its
 * folder, and a No workspace chat's hidden folder is made again when the chat
 * next runs. An Aiden-managed worktree is checked at its checkout's root.
 */
export function workspaceFolderCheckApplies(workspace: {
  folderPath?: string;
  permission?: string;
  noWorkspace?: true;
}): boolean {
  return Boolean(workspace.folderPath) && !workspace.noWorkspace && workspace.permission !== "none";
}
