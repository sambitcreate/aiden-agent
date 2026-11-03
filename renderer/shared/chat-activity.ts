import { isDraftChatId } from "./chat-identity";
import { isSafeSubagentIdentifier } from "./subagent-runs";

export interface ChatActivitySnapshot {
  revision: number;
  activeChatIds: string[];
  /** Chats with a tool approval waiting on the user. Omitted when empty. */
  approvalChatIds?: string[];
  /** Chats with an ask-user question waiting on the user. Omitted when empty. */
  inputChatIds?: string[];
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A filtered, unlisted UUID can belong to a Bot outside the regular chat index. */
function activityIds(value: unknown, known?: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const id of value) {
    if (isDraftChatId(id) && known?.has(id)) ids.add(id);
    else if (isSafeSubagentIdentifier(id)) ids.add(id);
    else if (!known || !isDraftChatId(id)) return null;
  }
  return [...ids];
}

export function parseChatActivitySnapshot(value: unknown, knownChatIds?: ReadonlySet<string>): ChatActivitySnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!isRevision(candidate.revision)) return null;
  const activeChatIds = activityIds(candidate.activeChatIds, knownChatIds);
  const approvalChatIds = candidate.approvalChatIds === undefined ? [] : activityIds(candidate.approvalChatIds, knownChatIds);
  const inputChatIds = candidate.inputChatIds === undefined ? [] : activityIds(candidate.inputChatIds, knownChatIds);
  if (!activeChatIds || !approvalChatIds || !inputChatIds) return null;
  return {
    revision: candidate.revision,
    activeChatIds,
    ...(approvalChatIds.length ? { approvalChatIds } : {}),
    ...(inputChatIds.length ? { inputChatIds } : {}),
  };
}
