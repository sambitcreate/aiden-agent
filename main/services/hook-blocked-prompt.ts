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

/** True when a hook blocked this user message, so it must never reach a model. */
export function isHookBlockedPrompt(message: { role?: unknown; hookBlocked?: unknown }): boolean {
  return message.role === "user" && parseHookBlockedPrompt(message.hookBlocked) !== undefined;
}

/** The messages a model may see: every message except hook-blocked prompts. */
export function withoutHookBlockedPrompts<T extends { role?: unknown; hookBlocked?: unknown }>(
  messages: readonly T[],
): T[] {
  return messages.filter((message) => !isHookBlockedPrompt(message));
}
