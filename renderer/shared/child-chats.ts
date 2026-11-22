// Chats that run other chats (docs/plans/proactive-aiden-plan.md, Phase 5).
// Shared by the main process (the `child_chats` tool and its approvals) and
// Settings → Approvals → Advanced (the "Chats can start other chats" switch).

export const CHILD_CHATS_TOOL_NAME = "child_chats";
/** Offered in a started chat whose lead asked for a structured result. */
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export const CHILD_CHATS_ACTIONS = ["start", "send", "wait", "read", "list", "stop"] as const;
export type ChildChatsAction = (typeof CHILD_CHATS_ACTIONS)[number];

export const CHILD_CHATS_SEND_MODES = ["auto", "queue", "steer"] as const;
export type ChildChatsSendMode = (typeof CHILD_CHATS_SEND_MODES)[number];

export const CHILD_CHATS_LIMITS = Object.freeze({
  /** Chats one `wait` follows. */
  waitChats: 8,
  /** The longest one `wait` holds; a timeout never stops a chat. */
  waitMaxSeconds: 600,
  waitDefaultSeconds: 120,
  /** Messages one `read` returns, each cut to `messageChars`. */
  readMessages: 20,
  readDefaultMessages: 6,
  messageChars: 20_000,
  titleChars: 200,
  taskChars: 100_000,
  /** Chats one `start` call names; a guard on one call, not on how many run. */
  startChats: 20,
});

/** "Chats can start other chats": on unless the person turned it off. */
export function childChatsEnabled(settings: { childChats?: boolean } | null | undefined): boolean {
  return settings?.childChats !== false;
}

/**
 * Starting a chat is Consequential (judged in Auto, asked in Ask); sending,
 * waiting, reading, listing and stopping the lead's own chats are Exempt.
 */
export function childChatsRequiresApproval(toolName: string, args: unknown): boolean {
  if (toolName !== CHILD_CHATS_TOOL_NAME) return false;
  return (args as { action?: unknown } | null)?.action === "start";
}
