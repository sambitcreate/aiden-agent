import type { Workspace } from "./types.js";

/**
 * Managed-worktree metadata is part of a durable filesystem transaction.
 * Removing only its workspace record would discard recovery authority, so the
 * generic removal path must never accept it.
 */
export function assertWorkspaceRecordRemovalAllowed(workspace: Workspace | null | undefined): void {
  if (workspace?.managedWorktree) {
    throw new Error(
      "Managed worktrees must be deleted with Delete worktree so Aiden can finish or recover the filesystem transaction.",
    );
  }
}
