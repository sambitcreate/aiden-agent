import {
  isSafeSubagentIdentifier,
  type SubagentRunSnapshotV1,
} from "../../../renderer/shared/subagent-runs.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  persistedChatReferencesSubagentRun,
  persistedChatWorkspaceId,
} from "../chat-workspace-authority.js";

interface HistoricalChat {
  id: string;
  workspaceId?: string;
  messages: Array<{
    role: string;
    subagents?: {
      generationId: string;
      runIds: readonly string[];
      version: number;
    };
  }>;
}

export interface SubagentHistoryReadDependencies {
  getChat(chatId: string): Promise<HistoricalChat | null>;
  getSnapshot(runId: string): Promise<SubagentRunSnapshotV1 | null>;
}

/** Validate both renderer-controlled lookup keys before any private-store access. */
export function parseSubagentHistoryRequestIds(
  chatId: unknown,
  runId: unknown,
): { chatId: string; runId: string } {
  if (!isSafeSubagentIdentifier(chatId) || !isSafeSubagentIdentifier(runId)) {
    throw new Error("Invalid subagent history request.");
  }
  return { chatId, runId };
}

function requireActiveOwner(owner: RendererDocumentOwner): void {
  if (owner.isDestroyed()) {
    throw new Error("The renderer document is no longer active.");
  }
}

/** Keep the exact invoking document authoritative across both asynchronous reads. */
export async function readSubagentHistoryForOwner(
  owner: RendererDocumentOwner,
  chatId: string,
  runId: string,
  dependencies: SubagentHistoryReadDependencies,
): Promise<SubagentRunSnapshotV1 | null> {
  const removeOwnerInvalidation = owner.onInvalidated(() => undefined);
  try {
    const chat = await dependencies.getChat(chatId);
    requireActiveOwner(owner);
    if (!chat || chat.id !== chatId) return null;
    const snapshot = await dependencies.getSnapshot(runId);
    requireActiveOwner(owner);
    return snapshot?.chatId === chat.id &&
      snapshot.workspaceId === persistedChatWorkspaceId(chat.workspaceId) &&
      persistedChatReferencesSubagentRun(chat.messages, snapshot.runId, snapshot.generationId)
      ? snapshot
      : null;
  } finally {
    removeOwnerInvalidation();
  }
}
