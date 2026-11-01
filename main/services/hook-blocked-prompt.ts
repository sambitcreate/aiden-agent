/**
 * A prompt a UserPromptSubmit hook blocked stays in the visible transcript so
 * the person can see what they typed, but it never reached the model and must
 * never reach it later. Every projection that turns stored chat messages into
 * model input (the Pi journal sync, visible-history projection, fork summaries,
 * side questions, title prompts, CLI forks) drops these messages.
 */

/** The display-only record that a hook stopped this user message. */
export interface HookBlockedPromptV1 {
  reason: string;
}

const MAX_HOOK_BLOCKED_REASON_CHARS = 500;

/** Parse a stored mark; anything malformed is treated as not blocked. */
export function parseHookBlockedPrompt(value: unknown): HookBlockedPromptV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reason = (value as { reason?: unknown }).reason;
  if (typeof reason !== "string") return undefined;
  return { reason: boundedHookBlockedReason(reason) };
}

export function boundedHookBlockedReason(reason: string): string {
  const trimmed = reason.trim() || "A hook blocked this prompt.";
  return trimmed.length > MAX_HOOK_BLOCKED_REASON_CHARS
    ? `${trimmed.slice(0, MAX_HOOK_BLOCKED_REASON_CHARS - 1)}…`
    : trimmed;
}

type MaybeBlockedMessage = { id?: unknown; role?: unknown; hookBlocked?: unknown };

/**
 * Prompts a hook blocked in this process, by message id. The stored mark is
 * what survives a restart; this set keeps the prompt out of every projection
 * even when writing that mark failed, so a failed write never lets it through.
 */
const blockedInThisProcess = new Set<string>();

/** True when a hook blocked this user message, so it must never reach a model. */
export function isHookBlockedPrompt(message: MaybeBlockedMessage): boolean {
  if (message.role !== "user") return false;
  if (typeof message.id === "string" && blockedInThisProcess.has(message.id)) return true;
  return parseHookBlockedPrompt(message.hookBlocked) !== undefined;
}

/** The messages a model may see: every message except hook-blocked prompts. */
export function withoutHookBlockedPrompts<T extends MaybeBlockedMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isHookBlockedPrompt(message));
}

/** The chat store call that writes or clears the mark. */
export interface PromptHookBlockStore {
  setPromptHookBlock(chatId: string, messageId: string, reason: string | undefined): Promise<boolean>;
}

/**
 * Mark a prompt a UserPromptSubmit hook refused. It is excluded at once, in
 * this process, before the write; a write that throws or finds no such
 * message is retried once and then reported, and the prompt stays excluded
 * for as long as this process runs.
 */
/**
 * Keep a prompt out of every projection in this process, before it is even
 * saved. Run input a hook refused is held this way, then saved and marked.
 */
export function holdHookBlockedPrompt(messageId: string): void {
  blockedInThisProcess.add(messageId);
}

export async function markPromptHookBlocked(
  store: PromptHookBlockStore,
  chatId: string,
  messageId: string,
  reason: string,
  onError: (error: unknown) => void,
): Promise<void> {
  holdHookBlockedPrompt(messageId);
  const write = async () => {
    if (!(await store.setPromptHookBlock(chatId, messageId, reason))) {
      throw new Error("The prompt was not found in its chat.");
    }
  };
  try {
    await write();
  } catch {
    try {
      await write();
    } catch (error) {
      onError(error);
    }
  }
}

/**
 * A blocked prompt is being sent now (the hook let it through this time), so
 * clear its mark everywhere: in this process, on the message object the turn
 * is about to journal, and in the store. A failed store write is reported and
 * leaves only the stored mark, which no longer affects this turn.
 */
export async function clearPromptHookBlock(
  store: PromptHookBlockStore,
  chatId: string,
  message: { id: string; hookBlocked?: unknown },
  onError: (error: unknown) => void,
): Promise<void> {
  blockedInThisProcess.delete(message.id);
  delete message.hookBlocked;
  try {
    await store.setPromptHookBlock(chatId, message.id, undefined);
  } catch (error) {
    onError(error);
  }
}

/**
 * `{ hookBlocked }` for a blocked user message, `{}` otherwise. Spread it into
 * a parsed or copied message so an unmarked one has no `hookBlocked` key.
 */
export function hookBlockedField(message: { role?: unknown; hookBlocked?: unknown }): { hookBlocked?: HookBlockedPromptV1 } {
  if (message.role !== "user") return {};
  const hookBlocked = parseHookBlockedPrompt(message.hookBlocked);
  return hookBlocked ? { hookBlocked } : {};
}
