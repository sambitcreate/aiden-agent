import {
  isSafeSubagentIdentifier,
  type SubagentEffectActivityV1,
  type SubagentHistoryDetailV1,
  type SubagentRunSnapshot,
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

export async function readSubagentHistoryDetailForOwner<
  Snapshot extends SubagentRunSnapshot,
>(
  owner: RendererDocumentOwner,
  chatId: string,
  runId: string,
  dependencies: SubagentHistoryReadDependencies<Snapshot> & {
    getEffectActivity(runId: string, chatId: string): Promise<SubagentEffectActivityV1[]>;
  },
): Promise<SubagentHistoryDetailV1 | null> {
  const removeOwnerInvalidation = owner.onInvalidated(() => undefined);
  try {
    const snapshot = await readSubagentHistoryForOwner(owner, chatId, runId, dependencies);
    requireActiveOwner(owner);
    if (!snapshot) return null;
    const effects = await dependencies.getEffectActivity(runId, chatId);
    requireActiveOwner(owner);
    return { version: 1, snapshot, effects };
  } finally {
    removeOwnerInvalidation();
  }
}

export interface SubagentHistoryReadDependencies<
  Snapshot extends SubagentRunSnapshot = SubagentRunSnapshot,
> {
  getChat(chatId: string): Promise<HistoricalChat | null>;
  getSnapshot(runId: string): Promise<Snapshot | null>;
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
export async function readSubagentHistoryForOwner<
  Snapshot extends SubagentRunSnapshot,
>(
  owner: RendererDocumentOwner,
  chatId: string,
  runId: string,
  dependencies: SubagentHistoryReadDependencies<Snapshot>,
): Promise<Snapshot | null> {
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
