import type { ChatActivitySnapshot } from "../../renderer/shared/chat-activity.js";
import type { ChatPendingAttention } from "../../renderer/shared/chat-pending-attention.js";
import { chatRowState, isChatUnread, type ChatReadMarkersSnapshot } from "../../renderer/shared/chat-row-state.js";
import type { ChatTriageEntry } from "../../renderer/shared/chat-triage.js";
import type { ChatSurfaceInput } from "../../renderer/shared/chat-visibility.js";
import { inboxState, isLocalInboxChat, triageSignals, type InboxSignals } from "../../renderer/shared/inbox-state.js";
import { latestPeerRuns, peerFeedBotAttention, peerFeedChatState } from "../../renderer/shared/peer-feed-inbox.js";
import type { PeerHostFeedSnapshot, PeerHostStatus } from "../../renderer/shared/peer-host.js";

/**
 * The Dock badge for the Inbox (docs/plans/inbox-sidebar-plan.md, Phase 2c):
 * how many rows sit in Needs you, counted in the main process so the badge
 * stays right with no window open. Placement is the sidebar's own
 * (`renderer/shared/inbox-state.ts`); this file only gathers the rows.
 */

/** A local chat's list metadata, as `chatStore.listSummaryMetadata()` returns it. */
export interface InboxBadgeLocalChat extends ChatSurfaceInput {
  id: string;
  updatedAt: number;
  lastAssistantAt?: number;
  lastAssistantSequence?: number;
  lastAssistantFailed?: boolean;
}

export interface InboxBadgeLocal {
  chats: readonly InboxBadgeLocalChat[];
  /** Workspaces this Mac still has; chats of removed workspaces don't count. */
  workspaceIds: ReadonlySet<string>;
  activity: Pick<ChatActivitySnapshot, "activeChatIds" | "approvalChatIds" | "inputChatIds">;
  /** Null when the markers can't be read: nothing then reads as unread. */
  markers: ChatReadMarkersSnapshot | null;
  triage: Readonly<Record<string, ChatTriageEntry>>;
  /** What each chat waits on (`chats:pendingAttention`); only detached and interrupted waits add to the activity. */
  pending: ReadonlyMap<string, ChatPendingAttention>;
  /** This Mac's Bots that need the person (`needsYou`). */
  botsNeedingYou: readonly string[];
}

export interface InboxBadgePeer {
  status: PeerHostStatus;
  feed: PeerHostFeedSnapshot | null;
}

export interface InboxBadgeInput {
  now: number;
  local: InboxBadgeLocal;
  peers: readonly InboxBadgePeer[];
}

const LOCAL_HOST_KEY = "local";

function needsYou(signals: InboxSignals, now: number): boolean {
  return inboxState(signals, now).shelf === "needs_you";
}

/** Whether a paired host's rows are live: connected and its feed caught up. */
function peerOnline(peer: InboxBadgePeer): peer is InboxBadgePeer & { feed: PeerHostFeedSnapshot } {
  return (
    peer.status.state.kind === "connected" &&
    !peer.status.stale &&
    peer.feed !== null &&
    peer.feed.hostId === peer.status.hostId &&
    !peer.feed.stale
  );
}

/**
 * How many distinct rows are in Needs you: approvals and questions, detached
 * and interrupted waits, unseen failures, and Bots that need the person, on
 * this Mac and on every online paired host. Done and snoozed chats don't
 * count, nor do rows of hosts that are offline, connecting or blocked. Rows
 * are keyed by host and chat, so one chat reported twice counts once. No
 * chat is open here, as no window may be: a chat the person is reading is
 * already read, so it never counts as an unseen failure.
 */
export function inboxBadgeCount(input: InboxBadgeInput): number {
  const { now, local } = input;
  const counted = new Set<string>();
  const active = new Set(local.activity.activeChatIds);
  const approval = new Set(local.activity.approvalChatIds ?? []);
  const question = new Set(local.activity.inputChatIds ?? []);

  for (const chat of local.chats) {
    if (!isLocalInboxChat(chat, (id) => local.workspaceIds.has(id))) continue;
    const pending = local.pending.get(chat.id);
    const attention = pending?.kind === "detached" || pending?.kind === "interrupted" ? pending.kind : undefined;
    const signals: InboxSignals = {
      rowState: chatRowState({
        active: active.has(chat.id),
        needsApproval: approval.has(chat.id),
        needsInput: question.has(chat.id),
      }),
      unread: isChatUnread(chat.lastAssistantAt, local.markers, chat.id, chat.lastAssistantSequence),
      failed: chat.lastAssistantFailed === true,
      ...(attention ? { attention } : {}),
      isOpen: false,
      hostOnline: true,
      updatedAt: chat.updatedAt,
      ...(chat.lastAssistantAt !== undefined ? { lastAssistantAt: chat.lastAssistantAt } : {}),
      ...triageSignals(local.triage[chat.id]),
    };
    if (needsYou(signals, now)) counted.add(`${LOCAL_HOST_KEY}\u0000chat\u0000${chat.id}`);
  }
  for (const botId of local.botsNeedingYou) counted.add(`${LOCAL_HOST_KEY}\u0000bot\u0000${botId}`);

  for (const peer of input.peers) {
    if (!peerOnline(peer)) continue;
    const { feed } = peer;
    const runs = latestPeerRuns(feed.runs);
    for (const row of feed.summaries) {
      // The sidebar leaves out a summary with no workspace, so the badge does too.
      if (typeof row.workspaceId !== "string" || !row.workspaceId.trim()) continue;
      const state = peerFeedChatState(row, runs.get(row.id), false);
      const signals: InboxSignals = {
        rowState: state.rowState,
        unread: state.hostUnread,
        failed: state.lastRunFailed,
        isOpen: false,
        hostOnline: true,
        updatedAt: 0,
        ...(state.lastAssistantAt !== undefined ? { lastAssistantAt: state.lastAssistantAt } : {}),
        ...triageSignals(state.triage),
      };
      if (needsYou(signals, now)) counted.add(`${feed.hostId}\u0000chat\u0000${row.id}`);
    }
    for (const row of feed.bots) {
      const bot = peerFeedBotAttention(row);
      // A host keeps no read state for Bots, so a failed Bot reads as an unseen failure.
      if (bot.needsYou || bot.failed) counted.add(`${feed.hostId}\u0000bot\u0000${row.id}`);
    }
  }
  return counted.size;
}

/** The app icon surface the badge writes to. */
export interface BadgeApp {
  dock?: { setBadge(text: string): void };
  setBadgeCount?(count?: number): boolean;
}

export interface BadgeSurface {
  /** Show `count`, or clear the badge at zero. */
  show(count: number): void;
}

/**
 * macOS writes the Dock tile's text; Linux sets the launcher count, which only
 * Unity-style launchers show (`setBadgeCount` reports false elsewhere, and
 * that is fine). Other platforms have no badge.
 */
export function badgeSurface(platform: NodeJS.Platform, app: BadgeApp): BadgeSurface | null {
  if (platform === "darwin") {
    const dock = app.dock;
    if (!dock) return null;
    return { show: (count) => dock.setBadge(count > 0 ? String(count) : "") };
  }
  if (platform === "linux" && typeof app.setBadgeCount === "function") {
    return { show: (count) => void app.setBadgeCount!(count) };
  }
  return null;
}

export interface InboxBadgeDriverOptions {
  surface: BadgeSurface;
  /**
   * The current count. Rejections keep the last badge and are reported, once
   * per distinct failure until a count succeeds again.
   */
  count: () => Promise<number>;
  /** Changes arriving within this window coalesce into one recount. */
  debounceMs?: number;
  onError?: (error: unknown) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface InboxBadgeDriver {
  /** On: count now and on every change. Off: clear the badge and stop counting. */
  setEnabled(enabled: boolean): void;
  /** Something the count reads changed. */
  invalidate(): void;
  /** Stop, and clear the badge. */
  dispose(): void;
  readonly enabled: boolean;
}

export const INBOX_BADGE_DEBOUNCE_MS = 250;

export const INBOX_BADGE_REQUEST_CHANNEL = "app:setInboxDockBadge";

export interface InboxBadgeRequestIpc<Event> {
  handle(channel: typeof INBOX_BADGE_REQUEST_CHANNEL, listener: (event: Event, enabled: unknown) => void): void;
}

/**
 * `app:setInboxDockBadge(enabled)`: a window reports whether the badge should
 * show (the Inbox is the sidebar view and its switch is on). The latest report
 * wins. Only the main window reports, as for `app:setDockIcon`; any other
 * sender is ignored and leaves the request as it was.
 */
export function registerInboxBadgeRequest<Event>(
  ipc: InboxBadgeRequestIpc<Event>,
  options: { isMainWindow: (event: Event) => boolean; apply: (enabled: boolean) => void },
): void {
  ipc.handle(INBOX_BADGE_REQUEST_CHANNEL, (event, enabled) => {
    if (!options.isMainWindow(event)) return;
    if (typeof enabled !== "boolean") throw new Error("Expected a boolean.");
    options.apply(enabled);
  });
}

export interface DistinctFailureReporter {
  /** Report this failure unless the last one reported had the same message. */
  failed(error: unknown): void;
  /** It worked again: the next failure is reported whatever it says. */
  succeeded(): void;
}

/**
 * A failure that repeats on every recount (an index too large to read, say)
 * is logged once, not on every change, until the read works again.
 */
export function distinctFailureReporter(report: (error: unknown) => void): DistinctFailureReporter {
  let last: string | undefined;
  return {
    failed(error) {
      const key = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (key === last) return;
      last = key;
      report(error);
    },
    succeeded() {
      last = undefined;
    },
  };
}

export function createInboxBadgeDriver(options: InboxBadgeDriverOptions): InboxBadgeDriver {
  const debounceMs = options.debounceMs ?? INBOX_BADGE_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let enabled = false;
  let disposed = false;
  let timer: unknown;
  let counting = false;
  let again = false;
  /** What the badge shows; starts unknown so the first write always lands. */
  let shown: number | undefined;
  const failures = distinctFailureReporter((error) => options.onError?.(error));

  const show = (count: number): void => {
    if (shown === count) return;
    shown = count;
    options.surface.show(count);
  };

  const run = async (): Promise<void> => {
    timer = undefined;
    if (!enabled || disposed) return;
    if (counting) {
      again = true;
      return;
    }
    counting = true;
    try {
      const count = await options.count();
      failures.succeeded();
      // Switched off while counting: the clear already happened and wins.
      if (enabled && !disposed) show(Math.max(0, Math.floor(count)));
    } catch (error) {
      failures.failed(error);
    } finally {
      counting = false;
    }
    if (again) {
      again = false;
      schedule();
    }
  };

  const schedule = (): void => {
    if (!enabled || disposed || timer !== undefined) return;
    timer = setTimer(() => void run(), debounceMs);
  };

  const cancel = (): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    again = false;
  };

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      if (disposed || next === enabled) return;
      enabled = next;
      if (enabled) {
        schedule();
      } else {
        cancel();
        show(0);
      }
    },
    invalidate: schedule,
    dispose() {
      if (disposed) return;
      cancel();
      if (enabled) show(0);
      enabled = false;
      disposed = true;
    },
  };
}
