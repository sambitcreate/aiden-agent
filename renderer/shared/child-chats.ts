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

/** One started chat as the desktop's chip shows it (`chats:childChats`). */
export interface StartedChatView {
  chatId: string;
  title: string;
  state: "idle" | "running" | "waiting_for_input" | "waiting_for_approval" | "done" | "failed";
  tookOver?: true;
  outcome?: "completed" | "stopped";
  reason?: "interrupted" | "error";
  branch?: string;
}

const STARTED_CHAT_STATES: ReadonlySet<string> = new Set([
  "idle",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "done",
  "failed",
]);

/** The list main sent, with damaged rows dropped. */
export function parseStartedChatViews(value: unknown): StartedChatView[] {
  if (!Array.isArray(value)) return [];
  const views: StartedChatView[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.chatId !== "string" || !row.chatId || typeof row.title !== "string" || !STARTED_CHAT_STATES.has(row.state as string)) continue;
    views.push({
      chatId: row.chatId,
      title: row.title,
      state: row.state as StartedChatView["state"],
      ...(row.tookOver === true ? { tookOver: true as const } : {}),
      ...(row.outcome === "completed" || row.outcome === "stopped" ? { outcome: row.outcome } : {}),
      ...(row.reason === "interrupted" || row.reason === "error" ? { reason: row.reason } : {}),
      ...(typeof row.branch === "string" && row.branch ? { branch: row.branch } : {}),
    });
  }
  return views;
}

/** Still going: running, or waiting for the person's approval or answer. */
export function startedChatWorking(view: StartedChatView): boolean {
  return view.state === "running" || view.state === "waiting_for_input" || view.state === "waiting_for_approval";
}

/** The chip's label: how many are working, or how many there are once none is. */
export function startedChatsChipLabel(views: readonly StartedChatView[]): string {
  const working = views.filter(startedChatWorking).length;
  if (working > 0) return `${working} ${working === 1 ? "chat" : "chats"} working`;
  return `${views.length} started ${views.length === 1 ? "chat" : "chats"}`;
}

/** One row's status line. */
export function startedChatStatus(view: StartedChatView): string {
  const where = view.branch ? ` · ${view.branch}` : "";
  if (view.tookOver) return `Yours now${where}`;
  switch (view.state) {
    case "running":
      return `Working${where}`;
    case "waiting_for_approval":
      return `Needs your approval${where}`;
    case "waiting_for_input":
      return `Needs your answer${where}`;
    case "done":
      return `${view.outcome === "stopped" ? "Stopped" : "Done"}${where}`;
    case "failed":
      return `${view.reason === "interrupted" ? "Interrupted" : "Stopped with an error"}${where}`;
    default:
      return `Idle${where}`;
  }
}
