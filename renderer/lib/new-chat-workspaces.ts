import type { ChatMeta, Workspace } from "./types";

export interface NewChatWorkspaceChoice {
  workspace: Workspace;
  /** The workspace of the chat being viewed (or the last active one). */
  current: boolean;
  /** Latest chat activity, or when the workspace was added if it has no chats. */
  lastActivityAt: number;
}

/**
 * Workspaces the New chat in… palette offers, most recent activity first.
 * Managed worktrees are left out: they belong to their repository's branch
 * menu, not to the list of places a chat can start.
 */
export function newChatWorkspaceChoices(
  workspaces: readonly Workspace[],
  chats: readonly Pick<ChatMeta, "workspaceId" | "updatedAt">[],
  currentWorkspaceId: string | undefined,
): NewChatWorkspaceChoice[] {
  const latestChatAt = new Map<string, number>();
  for (const chat of chats) {
    if (!chat.workspaceId) continue;
    latestChatAt.set(
      chat.workspaceId,
      Math.max(latestChatAt.get(chat.workspaceId) ?? Number.NEGATIVE_INFINITY, chat.updatedAt),
    );
  }
  return workspaces
    .filter((workspace) => !workspace.managedWorktree)
    .map((workspace) => ({
      workspace,
      current: workspace.id === currentWorkspaceId,
      lastActivityAt: latestChatAt.get(workspace.id) ?? workspace.createdAt,
    }))
    .sort(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt ||
        left.workspace.name.localeCompare(right.workspace.name),
    );
}
