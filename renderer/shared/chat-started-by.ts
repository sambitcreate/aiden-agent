// Which chat started this one (docs/plans/proactive-aiden-plan.md, Phase 5).
//
// A chat started by another chat through `child_chats` records its lead here.
// Main writes it once, when the chat is created; it is display and policy
// provenance, parsed strictly like `forkedFrom`: anything but the exact shape
// is dropped, never repaired.

export interface ChatStartedByV1 {
  version: 1;
  kind: "chat";
  /** The lead chat that started this one. */
  chatId: string;
  /** Epoch milliseconds. */
  at: number;
}

const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

export function parseChatStartedByV1(value: unknown): ChatStartedByV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || !["version", "kind", "chatId", "at"].every((key) => keys.includes(key))) return undefined;
  if (record.version !== 1 || record.kind !== "chat") return undefined;
  if (typeof record.chatId !== "string" || !SAFE_CHAT_ID.test(record.chatId)) return undefined;
  if (typeof record.at !== "number" || !Number.isSafeInteger(record.at) || record.at < 0) return undefined;
  return { version: 1, kind: "chat", chatId: record.chatId, at: record.at };
}
