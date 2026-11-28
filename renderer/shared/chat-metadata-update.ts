// Pure reducer for `chats:metadata-updated` notifications so both the main
// window and Quick Chat keep `ephemeral` accurate across auto-titling, manual
// renames, Save (promoteEphemeral), and Attach to workspace.

import type { GenerationThinkingLevel } from "./generation-thinking.js";

export interface ChatMetadataUpdatedPatch {
  chatId: string;
  workspaceId?: string;
  title: string;
  updatedAt: number;
  /**
   * Explicit persistence transition when known:
   * - `true`: chat is still Temporary (ephemeral)
   * - `false`: chat was explicitly promoted/attached to durable storage
   * - `undefined`: metadata update (e.g. title/rename) does not change persistence
   */
  ephemeral?: boolean;
  /**
   * The chat's own thinking level after main reconciled a clamped level: a
   * level sets it, `null` clears it, absent leaves it.
   */
  thinkingLevel?: GenerationThinkingLevel | null;
}

function applyThinkingLevel(
  target: { thinkingLevel?: GenerationThinkingLevel },
  update: Pick<ChatMetadataUpdatedPatch, "thinkingLevel">,
): void {
  if (update.thinkingLevel === null) delete target.thinkingLevel;
  else if (update.thinkingLevel !== undefined) target.thinkingLevel = update.thinkingLevel;
}

export function applyChatMetadataUpdate<
  T extends {
    title: string;
    workspaceId?: string;
    updatedAt: number;
    ephemeral?: true;
    thinkingLevel?: GenerationThinkingLevel;
  },
>(current: T, update: ChatMetadataUpdatedPatch): T {
  const next: T = {
    ...current,
    title: update.title,
    ...(update.workspaceId !== undefined ? { workspaceId: update.workspaceId } : {}),
    updatedAt: update.updatedAt,
  };
  applyThinkingLevel(next, update);
  if (update.ephemeral === false) {
    delete next.ephemeral;
  } else if (update.ephemeral === true) {
    next.ephemeral = true;
  }
  return next;
}

/**
 * The same notification applied to a cached chat list: the matching row takes
 * the new title, workspace, time and thinking level, and the list stays newest
 * first. Other rows are returned as they were.
 */
export function applyChatMetaListUpdate<
  T extends {
    id: string;
    title: string;
    workspaceId?: string;
    updatedAt: number;
    thinkingLevel?: GenerationThinkingLevel;
  },
>(rows: readonly T[], update: ChatMetadataUpdatedPatch): T[] {
  return rows
    .map((row) => {
      if (row.id !== update.chatId) return row;
      const next: T = {
        ...row,
        title: update.title,
        workspaceId: update.workspaceId,
        updatedAt: update.updatedAt,
      };
      applyThinkingLevel(next, update);
      return next;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
