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
  if (update.thinkingLevel === null) delete next.thinkingLevel;
  else if (update.thinkingLevel !== undefined) next.thinkingLevel = update.thinkingLevel;
  if (update.ephemeral === false) {
    delete next.ephemeral;
  } else if (update.ephemeral === true) {
    next.ephemeral = true;
  }
  return next;
}
