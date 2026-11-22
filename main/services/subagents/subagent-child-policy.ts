/**
 * Named helper time limits. A chat helper runs until it finishes, fails or the
 * person presses Stop; the 24-hour chat limit is only a safety net. A Bot reply
 * has a real 60-minute limit, counted from that reply's first helper launch.
 */
export type SubagentTimeLimit = "chat" | "bot";
export const CHAT_SUBAGENT_TIME_LIMIT_MS = 24 * 60 * 60_000;
export const BOT_SUBAGENT_TIME_LIMIT_MS = 60 * 60_000;
export const SUBAGENT_TIME_LIMIT_MS: Readonly<Record<SubagentTimeLimit, number>> = Object.freeze({
  chat: CHAT_SUBAGENT_TIME_LIMIT_MS,
  bot: BOT_SUBAGENT_TIME_LIMIT_MS,
});
export const BOT_SUBAGENT_TIME_LIMIT_WARNING = "Stopped at the 60-minute limit for Bot replies.";
export const CHAT_SUBAGENT_TIME_LIMIT_WARNING = "Stopped at the 24-hour safety limit for helpers.";
export const SUBAGENT_TIME_LIMIT_WARNING: Readonly<Record<SubagentTimeLimit, string>> = Object.freeze({
  chat: CHAT_SUBAGENT_TIME_LIMIT_WARNING,
  bot: BOT_SUBAGENT_TIME_LIMIT_WARNING,
});

export const DEFAULT_SUBAGENT_CHILD_DEADLINE_MS = CHAT_SUBAGENT_TIME_LIMIT_MS;
export const DEFAULT_SUBAGENT_CANCELLATION_GRACE_MS = 5_000;
export const MAX_SUBAGENT_CHILD_TURNS = 24;
export const MAX_SUBAGENT_CHILD_TOOL_CALLS = 64;
export const MAX_SUBAGENT_CHILD_EVENTS = 512;
export const MAX_SUBAGENT_CHILD_OUTPUT_CHARS = 120_000;
export const MAX_SUBAGENT_CHILD_PROTOCOL_CHARS = 512_000;
