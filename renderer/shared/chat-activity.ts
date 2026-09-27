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

/** undefined: absent or empty; null: present but invalid. */
function optionalIds(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isSafeSubagentIdentifier)) return null;
  return value.length > 0 ? [...new Set(value)] : undefined;
}

export function parseChatActivitySnapshot(value: unknown): ChatActivitySnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isRevision(candidate.revision) ||
    !Array.isArray(candidate.activeChatIds) ||
    !candidate.activeChatIds.every(isSafeSubagentIdentifier)
  ) {
    return null;
  }
  const approvalChatIds = optionalIds(candidate.approvalChatIds);
  const inputChatIds = optionalIds(candidate.inputChatIds);
  if (approvalChatIds === null || inputChatIds === null) return null;
  return {
    revision: candidate.revision,
    activeChatIds: [...new Set(candidate.activeChatIds)],
    ...(approvalChatIds ? { approvalChatIds } : {}),
    ...(inputChatIds ? { inputChatIds } : {}),
  };
}
