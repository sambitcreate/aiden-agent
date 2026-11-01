import type { ChatRowState } from "./chat-row-state.js";
import { chatSurface, type ChatSurfaceInput } from "./chat-visibility.js";
import { DEFAULT_CHAT_WORKSPACE_ID } from "./chat-workspace.js";
import type { ChatTriageEntry } from "./chat-triage.js";

/**
 * Inbox placement for one row (docs/plans/inbox-sidebar-plan.md, "Status
 * model"), shared by the sidebar (`renderer/lib/sidebar-inbox.ts`) and the
 * main process's Dock badge (`main/services/inbox-dock-badge.ts`), so both
 * place a chat by one implementation. Pure: callers pass `now`.
 */

export const INBOX_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const INBOX_SECTIONS = ["needs_you", "pinned", "updates", "earlier", "working"] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];
export type InboxShelf = InboxSection | "hidden";

/** Needs you tiers, most urgent first. */
export const INBOX_TIERS = {
  approval: 0,
  input: 1,
  failed: 2,
  /** A detached or interrupted local prompt. */
  unavailable: 3,
} as const;

export interface InboxSignals {
  rowState: ChatRowState;
  unread: boolean;
  /** The newest run failed (`lastAssistantFailed` / `lastRunFailed`). */
  failed: boolean;
  /** Local only, from `chats:pendingAttention`. */
  attention?: "detached" | "interrupted";
  /** The chat shown in the main pane. It never counts as unread. */
  isOpen: boolean;
  /** Always true for local chats. */
  hostOnline: boolean;
  updatedAt: number;
  lastAssistantAt?: number;
  attentionSince?: number;
  runStartedAt?: number;
  /** Phase 2. */
  pinnedAt?: number;
  /** Phase 2. */
  doneAt?: number;
  /** Phase 2. */
  snoozedUntil?: number;
}

export interface InboxPlacement {
  shelf: InboxShelf;
  /** The Needs you tier (see `INBOX_TIERS`); 0 on every other shelf. */
  tier: number;
  /** The time the row orders by within its shelf. */
  sortAt: number;
}

/**
 * The triage that hides a row right now: Mark done until newer output lands,
 * and Snooze until it ends. Both can hold at once.
 */
export function inboxTriageHold(
  signals: Pick<InboxSignals, "doneAt" | "snoozedUntil" | "lastAssistantAt">,
  now: number,
): { done: boolean; snoozed: boolean } {
  return {
    done: signals.doneAt !== undefined && (signals.lastAssistantAt ?? Number.NEGATIVE_INFINITY) <= signals.doneAt,
    snoozed: signals.snoozedUntil !== undefined && signals.snoozedUntil > now,
  };
}

/**
 * Where one chat belongs. The placement rules apply in the plan's order.
 * `includeTriaged` (search) skips rule 5, so a Done or snoozed chat is listed
 * where it would be without its triage.
 */
export function inboxState(
  signals: Readonly<InboxSignals>,
  now: number,
  recentWindowMs: number = INBOX_RECENT_WINDOW_MS,
  includeTriaged = false,
): InboxPlacement {
  const unread = signals.unread && !signals.isOpen;
  const needsYou = (tier: number): InboxPlacement => ({
    shelf: "needs_you",
    tier,
    sortAt: signals.attentionSince ?? signals.updatedAt,
  });
  // 1. A live prompt overrides Done and Snooze.
  if (signals.rowState === "needs_approval") return needsYou(INBOX_TIERS.approval);
  if (signals.rowState === "needs_input") return needsYou(INBOX_TIERS.input);
  // 2. Unseen output from a failed run (an idle chat; `inboxRowStatus` reads it as Failed).
  if (signals.rowState === "idle" && signals.failed && unread) return needsYou(INBOX_TIERS.failed);
  // 3. A local prompt that can no longer be answered where it was raised.
  if (signals.attention) return needsYou(INBOX_TIERS.unavailable);
  // 4. Running.
  if (signals.rowState === "working") {
    return { shelf: "working", tier: 0, sortAt: signals.runStartedAt ?? signals.updatedAt };
  }
  // 5. Done with no newer output, or snoozed.
  const hidden: InboxPlacement = { shelf: "hidden", tier: 0, sortAt: signals.updatedAt };
  if (!includeTriaged) {
    const hold = inboxTriageHold(signals, now);
    if (hold.done || hold.snoozed) return hidden;
  }
  // 6–8.
  if (signals.pinnedAt !== undefined) return { shelf: "pinned", tier: 0, sortAt: signals.pinnedAt };
  if (unread) return { shelf: "updates", tier: 0, sortAt: signals.lastAssistantAt ?? signals.updatedAt };
  // The open chat stays listed however old it is.
  if (signals.isOpen || now - signals.updatedAt <= recentWindowMs) {
    return { shelf: "earlier", tier: 0, sortAt: signals.updatedAt };
  }
  return hidden;
}

/** A triage entry as the placement signals read it. */
export function triageSignals(
  entry: ChatTriageEntry | null | undefined,
): Pick<InboxSignals, "pinnedAt" | "doneAt" | "snoozedUntil"> {
  if (!entry) return {};
  return {
    ...(entry.pinnedAt !== undefined ? { pinnedAt: entry.pinnedAt } : {}),
    ...(entry.doneAt !== undefined ? { doneAt: entry.doneAt } : {}),
    ...(entry.snoozedUntil !== undefined ? { snoozedUntil: entry.snoozedUntil } : {}),
  };
}

/**
 * Whether the Inbox lists a local chat. Bot chats show through their Bot and
 * feature-owned chats never show; chats of removed workspaces are left out.
 * The Assistant chat and workspace-less scheduled chats (saved with no
 * workspace, read back as the default id) are listed.
 */
export function isLocalInboxChat(
  chat: ChatSurfaceInput,
  hasWorkspace: (workspaceId: string) => boolean,
): boolean {
  const surface = chatSurface(chat);
  if (surface === "assistant") return true;
  if (surface !== "regular") return false;
  if (chat.workspaceId === undefined || chat.workspaceId === DEFAULT_CHAT_WORKSPACE_ID) return true;
  return hasWorkspace(chat.workspaceId);
}
