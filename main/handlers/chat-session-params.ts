const MAX_CHAT_ID_CHARS = 160;
const MAX_CHAT_ID_BYTES = 640;
const COPY_KEYS = new Set(["chatId", "throughMessageId"]);
const CHAT_ONLY_KEYS = new Set(["chatId"]);

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > allowed.size || !allowed.has(key)) {
      throw new Error(`Invalid ${label}.`);
    }
  }
  return record;
}

function boundedId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CHAT_ID_CHARS ||
    Buffer.byteLength(value, "utf8") > MAX_CHAT_ID_BYTES
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export interface ParsedChatCopyRequest {
  chatId: string;
  throughMessageId?: string;
}

export function parseChatCopyRequest(value: unknown): ParsedChatCopyRequest {
  const record = exactRecord(value, COPY_KEYS, "chat copy request");
  return {
    chatId: boundedId(record.chatId, "chat id"),
    throughMessageId:
      record.throughMessageId === undefined
        ? undefined
        : boundedId(record.throughMessageId, "turn id"),
  };
}

export function parseChatOnlyRequest(value: unknown): { chatId: string } {
  const record = exactRecord(value, CHAT_ONLY_KEYS, "chat request");
  return { chatId: boundedId(record.chatId, "chat id") };
}

// Keep workspace-bound identifiers on the same explicit budget as the rest
// of the renderer chat envelope. Exported for contract tests.
export const CHAT_SESSION_ID_LIMITS = Object.freeze({
  chatCharacters: MAX_CHAT_ID_CHARS,
  chatBytes: MAX_CHAT_ID_BYTES,
});
