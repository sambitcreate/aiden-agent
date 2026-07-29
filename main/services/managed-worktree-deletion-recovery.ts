import type { Workspace } from "./types.js";

export interface ManagedWorktreeDeletionRecoveryDependencies {
  listWorkspaces(): Promise<Workspace[]>;
  deletionPending(workspace: Workspace): Promise<boolean>;
  blockWorkspace(workspaceId: string): Promise<void>;
  deleteWorktree(workspace: Workspace): Promise<void>;
  removeWorkspaceRecord(workspaceId: string): Promise<void>;
  finalizeDeletion(workspace: Workspace): Promise<void>;
  finalizeOrphanedDeletions(referencedOwnershipTokens: ReadonlySet<string>): Promise<void>;
  onError(workspaceId: string, error: unknown): void;
}

/**
 * Finish crash-left managed-worktree deletions before scheduled work starts.
 * Every journaled workspace is blocked first and remains blocked on any
 * recovery error. Orphan finalization receives a fresh post-recovery snapshot
 * of persisted ownership tokens, so a failed metadata removal cannot lose the
 * journal required to block and retry that workspace on the next startup.
 */
export async function reconcilePendingManagedWorktreeDeletions(
  dependencies: ManagedWorktreeDeletionRecoveryDependencies,
): Promise<void> {
  for (const workspace of await dependencies.listWorkspaces()) {
    if (!workspace.managedWorktree) continue;
    let pending: boolean;
    try {
      pending = await dependencies.deletionPending(workspace);
    } catch (error) {
      await dependencies.blockWorkspace(workspace.id).catch(() => undefined);
      dependencies.onError(workspace.id, error);
      continue;
    }
    if (!pending) continue;

    try {
      await dependencies.blockWorkspace(workspace.id);
      await dependencies.deleteWorktree(workspace);
      await dependencies.removeWorkspaceRecord(workspace.id);
      await dependencies.finalizeDeletion(workspace);
    } catch (error) {
      dependencies.onError(workspace.id, error);
    }
  }

  const referencedOwnershipTokens = new Set<string>();
  for (const workspace of await dependencies.listWorkspaces()) {
    const ownershipToken = workspace.managedWorktree?.ownershipToken;
    if (ownershipToken) referencedOwnershipTokens.add(ownershipToken);
  }
  await dependencies.finalizeOrphanedDeletions(referencedOwnershipTokens);
}
