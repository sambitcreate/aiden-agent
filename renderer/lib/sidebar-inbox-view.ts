import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import { DEFAULT_CHAT_WORKSPACE_ID } from "../shared/chat-workspace";
import type { ChatPendingAttention } from "../shared/chat-pending-attention";
import type { ChatRowState } from "../shared/chat-row-state";
import type { ChatTriageEntry } from "../shared/chat-triage";
import { triageSignals } from "./inbox-triage";
import { isNoWorkspace, NO_WORKSPACE_GROUP_LABEL } from "./no-workspace";
import {
  INBOX_SECTIONS,
  INBOX_TIERS,
  inboxState,
  type HeldInboxOrder,
  type InboxDisplayOrder,
  type InboxRow,
  type InboxSection,
} from "./sidebar-inbox";
import { LOCAL_SIDEBAR_HOST_ID, projectOrderKey, type SidebarMachineFilter } from "./sidebar-organization";
import {
  LOCAL_MACHINE_LABEL,
  type RemoteSidebarRows,
  type RemoteSidebarChat,
  type SidebarHost,
} from "./sidebar-remote-groups";
import type { ChatMeta, Workspace } from "./types";
import { isBotAvatarAppearance, type BotAvatar, type BotDefinition } from "../shared/bots";
import type { PeerHostFeedSnapshot } from "../shared/peer-host";

/**
 * The Inbox view's pure parts (docs/plans/inbox-sidebar-plan.md, Phase 1b):
 * which chats it lists and under what project label, each row's status text,
 * tooltip and hover action, the Needs you leave debounce, and the ⌘1–9 order.
 * Placement itself lives in `sidebar-inbox.ts`.
 */

/** Shown when a paired host has no name. Never a bare "Mac". */
export const INBOX_UNNAMED_HOST_LABEL = "Paired Mac";
export const INBOX_ASSISTANT_PROJECT_LABEL = "Assistant";
export const INBOX_SCHEDULED_PROJECT_LABEL = "Scheduled";
/** Line 1 of a Bot's row, in place of a project. */
export const INBOX_BOT_PROJECT_LABEL = "Bot";
export const INBOX_BOT_NEEDS_YOU_DESCRIPTION = "Waiting for you";
export const INBOX_UNAVAILABLE_DESCRIPTION = "Approval unavailable — return to retry";
/** Leaving Needs you waits this long, so a run that answers one prompt and raises the next doesn't bounce. */
export const NEEDS_YOU_LEAVE_DEBOUNCE_MS = 400;

export type InboxEntrySource =
  | { kind: "local"; chat: ChatMeta }
  | { kind: "remote"; chat: RemoteSidebarChat }
  | {
      kind: "bot";
      bot: BotDefinition;
      /** The newest reply the row rendered; Mark read records it as seen. */
      lastReplyAt: number | null;
      working: boolean;
    }
  | {
      kind: "remoteBot";
      botId: string;
      name: string;
      /** The Bot's drawn avatar, when the host sent a valid one. */
      avatar?: BotAvatar;
      working: boolean;
    };

export interface InboxEntry extends InboxRow {
  title: string;
  /** Line 1: the workspace name, or "Assistant" / "Scheduled". */
  project: string;
  hostId: string;
  hostLabel: string;
  /** What a local chat waits on, from `chats:pendingAttention`. */
  pending?: ChatPendingAttention;
  source: InboxEntrySource;
}

export interface LocalInboxInput {
  chats: readonly ChatMeta[];
  workspaces: readonly Workspace[];
  activeChatId?: string | null;
  rowState: (chatId: string) => ChatRowState;
  unread: (chat: ChatMeta) => boolean;
  pending: ReadonlyMap<string, ChatPendingAttention>;
  /** The chat's Pin, Done and Snooze, from this Mac's triage store and this device's own writes. */
  triage?: (chatId: string) => ChatTriageEntry | undefined;
}

/**
 * The project label for a local chat, or null when the Inbox leaves it out:
 * Bot chats (they show through their Bot) and chats of removed workspaces.
 * The Assistant chat and workspace-less scheduled chats are listed.
 */
export function localInboxProject(chat: ChatMeta, workspaces: readonly Workspace[]): string | null {
  if (chat.botId) return null;
  const workspace = chat.workspaceId === undefined
    ? undefined
    : workspaces.find((candidate) => candidate.id === chat.workspaceId);
  if (workspace) return isNoWorkspace(workspace) ? NO_WORKSPACE_GROUP_LABEL : workspace.name;
  if (chat.workspaceId === ASSISTANT_WORKSPACE_ID) return INBOX_ASSISTANT_PROJECT_LABEL;
  // A scheduled task without a workspace saves its chat with no workspace,
  // which the chat list reads back as the default id.
  if (chat.workspaceId === undefined || chat.workspaceId === DEFAULT_CHAT_WORKSPACE_ID) {
    return INBOX_SCHEDULED_PROJECT_LABEL;
  }
  return null;
}

export function localInboxEntries(input: LocalInboxInput): InboxEntry[] {
  return input.chats.flatMap((chat): InboxEntry[] => {
    const project = localInboxProject(chat, input.workspaces);
    if (project === null) return [];
    const pending = input.pending.get(chat.id);
    const attention = pending?.kind === "detached" || pending?.kind === "interrupted" ? pending.kind : undefined;
    return [
      {
        key: projectOrderKey(LOCAL_SIDEBAR_HOST_ID, chat.id),
        title: chat.title,
        project,
        hostId: LOCAL_SIDEBAR_HOST_ID,
        hostLabel: LOCAL_MACHINE_LABEL,
        ...(pending ? { pending } : {}),
        source: { kind: "local", chat },
        signals: {
          rowState: input.rowState(chat.id),
          unread: input.unread(chat),
          failed: chat.lastAssistantFailed === true,
          ...(attention ? { attention } : {}),
          isOpen: chat.id === input.activeChatId,
          hostOnline: true,
          updatedAt: chat.updatedAt,
          ...(chat.lastAssistantAt !== undefined ? { lastAssistantAt: chat.lastAssistantAt } : {}),
          ...(pending?.since !== undefined ? { attentionSince: pending.since } : {}),
          ...(pending?.runStartedAt !== undefined ? { runStartedAt: pending.runStartedAt } : {}),
          ...triageSignals(input.triage?.(chat.id)),
        },
      },
    ];
  });
}

/** One local Bot, as the Bots sidebar reads it (`useBotRows`). */
export interface InboxBotInput {
  bot: BotDefinition;
  state?: { kind: string };
  /** When the Bot's chat last changed, or the Bot itself when it has no messages. */
  activityAt: number;
  needsYou: boolean;
  lastReplyAt: number | null;
}

export interface BotInboxInput {
  bots: readonly InboxBotInput[];
  /** The Bot whose chat is open, if any. */
  openBotId: string | null;
  /** Unread from the Bot sidebar preferences (`isBotUnread`), not chat read markers. */
  unread: (botId: string, lastReplyAt: number | null) => boolean;
}

/** A Bot's row key. Bot ids never collide with chat ids under it. */
export function botInboxKey(botId: string): string {
  return projectOrderKey(LOCAL_SIDEBAR_HOST_ID, `bot:${botId}`);
}

/** Every local Bot's row, split by whether the Inbox lists it. */
export interface BotInboxRows {
  /** Bots that need the person, have an unread reply, or are open. */
  listed: InboxEntry[];
  /**
   * Every other Bot. They still exist, so a row the list holds in place after
   * it stopped qualifying (a freeze, the Needs you linger) reads its live
   * state here, and isn't taken for deleted.
   */
  unlisted: InboxEntry[];
}

/**
 * This Mac's Bots, listed only while they need the person (`needsYou`, which
 * covers pending prompts, issues and failed runs) or have an unread reply
 * (plan D8). The open Bot also stays listed until the person leaves it, as an
 * open chat does. Bot chats never show as chats; a Bot that is only running
 * isn't listed, so Bots never join the Working shelf.
 */
export function botInboxRows(input: BotInboxInput): BotInboxRows {
  const rows: BotInboxRows = { listed: [], unlisted: [] };
  for (const row of input.bots) {
    const isOpen = row.bot.id === input.openBotId;
    const unread = !isOpen && input.unread(row.bot.id, row.lastReplyAt);
    const entry: InboxEntry = {
      key: botInboxKey(row.bot.id),
      title: row.bot.name,
      project: INBOX_BOT_PROJECT_LABEL,
      hostId: LOCAL_SIDEBAR_HOST_ID,
      hostLabel: LOCAL_MACHINE_LABEL,
      source: {
        kind: "bot",
        bot: row.bot,
        lastReplyAt: row.lastReplyAt,
        working: row.state?.kind === "running",
      },
      signals: {
        // Placement needs only that the Bot waits; its status reads "Needs you" whatever the wait is.
        rowState: row.needsYou ? "needs_input" : "idle",
        unread,
        failed: false,
        isOpen,
        hostOnline: true,
        updatedAt: row.activityAt,
        ...(row.lastReplyAt !== null ? { lastAssistantAt: row.lastReplyAt } : {}),
        // The Bot's chat last changed when the wait began, near enough.
        ...(row.needsYou ? { attentionSince: row.activityAt } : {}),
      },
    };
    (row.needsYou || unread || isOpen ? rows.listed : rows.unlisted).push(entry);
  }
  return rows;
}

/** The Bots the Inbox lists (`botInboxRows(input).listed`). */
export function botInboxEntries(input: BotInboxInput): InboxEntry[] {
  return botInboxRows(input).listed;
}

export interface RemoteBotInboxInput {
  hosts: readonly SidebarHost[];
  feeds: ReadonlyMap<string, PeerHostFeedSnapshot | null | undefined>;
  /** The paired host's Bot whose chat is open, as `hostId/botId` (`hostBotChatRouteKey`), if any. */
  openKey: string | null;
}

/** A paired host's Bot's row key. Bot ids never collide with chat ids under it. */
export function remoteBotInboxKey(hostId: string, botId: string): string {
  return projectOrderKey(hostId, `bot:${botId}`);
}

function feedTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Paired hosts' Bots (Remote revision 48), listed while their host says they
 * need the person (`needsYou`), their last run failed (`failed`), or their
 * chat is open here. A host has no read state for a Bot's replies, so a
 * remote Bot's replies never read as unread; a failed one reads as an unseen
 * failure, Failed in Needs you, until its next run. Older hosts send neither field, so their Bots stay out.
 * A blocked host's Bots are left out, like its chats.
 */
export function remoteBotInboxRows(input: RemoteBotInboxInput): BotInboxRows {
  const rows: BotInboxRows = { listed: [], unlisted: [] };
  for (const host of input.hosts) {
    if (host.availability === "blocked") continue;
    const feed = input.feeds.get(host.id);
    if (!feed || feed.hostId !== host.id) continue;
    const hostOnline = !feed.stale && host.availability === "online";
    for (const row of feed.bots) {
      const needsYou = row.needsYou === true;
      const failed = !needsYou && row.failed === true;
      const isOpen = input.openKey === `${host.id}/${row.id}`;
      const lastReplyAt = feedTime(row.lastReplyAt);
      // The feed has no time a Bot's wait began; its newest reply, else its last edit, stands in.
      const updatedAt = lastReplyAt ?? feedTime(row.updatedAt) ?? 0;
      const name = typeof row.name === "string" && row.name.trim() ? row.name : "Untitled Bot";
      const semantic = (row.avatar as { semantic?: unknown } | undefined)?.semantic;
      const entry: InboxEntry = {
        key: remoteBotInboxKey(host.id, row.id),
        title: name,
        project: INBOX_BOT_PROJECT_LABEL,
        hostId: host.id,
        hostLabel: host.label.trim() || INBOX_UNNAMED_HOST_LABEL,
        source: {
          kind: "remoteBot",
          botId: row.id,
          name,
          ...(isBotAvatarAppearance(semantic) ? { avatar: semantic } : {}),
          working: hostOnline && row.sessionState === "running",
        },
        signals: {
          rowState: needsYou ? "needs_input" : "idle",
          // The host keeps no read state for Bots: a failure stays unseen until the next run.
          unread: failed,
          failed,
          isOpen,
          hostOnline,
          updatedAt,
          ...(lastReplyAt !== undefined ? { lastAssistantAt: lastReplyAt } : {}),
        },
      };
      (needsYou || failed || isOpen ? rows.listed : rows.unlisted).push(entry);
    }
  }
  return rows;
}

/**
 * Paired hosts' rows. A blocked host's rows are left out: its "Needs
 * re-pairing" notice above the list (`RemoteHostStatusList`) stands in for
 * them. Rows of a host that isn't online stay, marked offline
 * (`hostOnline: false`), and drop out of the counts.
 */
export function remoteInboxEntries(
  rows: readonly RemoteSidebarRows[],
  hosts: readonly SidebarHost[],
  isOpen: (hostId: string, chatId: string) => boolean = () => false,
  triage?: (chat: RemoteSidebarChat) => ChatTriageEntry | undefined,
): InboxEntry[] {
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  return rows.flatMap(({ projects, chats }) => {
    const projectNames = new Map(projects.map((project) => [project.key, project.name]));
    return chats.flatMap((chat): InboxEntry[] => {
      const host = hostsById.get(chat.hostId);
      if (!host || host.availability === "blocked") return [];
      return [
        {
          key: chat.key,
          title: chat.title,
          project: projectNames.get(chat.projectKey) ?? "Untitled project",
          hostId: chat.hostId,
          hostLabel: chat.hostLabel.trim() || INBOX_UNNAMED_HOST_LABEL,
          source: { kind: "remote", chat },
          signals: {
            rowState: chat.rowState,
            // `remoteSidebarRows` already clears unread on the open chat.
            unread: chat.unread,
            failed: chat.lastRunFailed,
            isOpen: isOpen(chat.hostId, chat.chatId),
            hostOnline: !chat.stale,
            updatedAt: chat.lastActivityAt ?? chat.createdAt ?? 0,
            // Revision 48 hosts report these; older hosts leave the row on updatedAt.
            ...(chat.attentionSince !== undefined ? { attentionSince: chat.attentionSince } : {}),
            ...(chat.runStartedAt !== undefined ? { runStartedAt: chat.runStartedAt } : {}),
            ...(chat.lastAssistantAt !== undefined ? { lastAssistantAt: chat.lastAssistantAt } : {}),
            ...triageSignals(triage ? triage(chat) : chat.triage),
          },
        },
      ];
    });
  });
}

/** The machine filter and search. Search matches the title, project and host. */
export function filterInboxEntries(
  entries: readonly InboxEntry[],
  options: { search: string; machineFilter: SidebarMachineFilter },
): InboxEntry[] {
  const terms = options.search.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return entries.filter((entry) => {
    if (options.machineFilter === "local" && entry.hostId !== LOCAL_SIDEBAR_HOST_ID) return false;
    if (options.machineFilter.startsWith("host:") && entry.hostId !== options.machineFilter.slice("host:".length)) {
      return false;
    }
    if (terms.length === 0) return true;
    const text = `${entry.title} ${entry.project} ${entry.hostLabel}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** A wait or run length: "<1m", "4m", "3h", "2d". Never negative. */
export function formatInboxDuration(now: number, since: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type InboxStatusTone = "warning" | "danger" | "working" | "quiet";

/** Why a row is in Needs you. A Bot is only ever `needs_you`: its row doesn't say which wait it is. */
export type InboxNeedsYouKind = "approval" | "question" | "failed" | "interrupted" | "unavailable" | "needs_you";

export interface InboxRowStatus {
  /** "Approval", "Working 4m", or a bare age such as "2h". */
  label: string;
  tone: InboxStatusTone;
  /** How long a Needs you row has waited. */
  wait?: string;
  needsYou?: InboxNeedsYouKind;
}

const NEEDS_YOU_LABELS: Readonly<Record<InboxNeedsYouKind, string>> = {
  approval: "Approval",
  question: "Question",
  failed: "Failed",
  interrupted: "Interrupted",
  unavailable: "Unavailable",
  needs_you: "Needs you",
};

/** Why a Needs you row is there, from the same rules that placed it. */
export function inboxNeedsYouKind(entry: InboxEntry, now: number): InboxNeedsYouKind | null {
  const placement = inboxState(entry.signals, now);
  if (placement.shelf !== "needs_you") return null;
  if (entry.source.kind === "bot") return "needs_you";
  if (entry.source.kind === "remoteBot") return placement.tier === INBOX_TIERS.failed ? "failed" : "needs_you";
  switch (placement.tier) {
    case INBOX_TIERS.approval:
      return "approval";
    case INBOX_TIERS.input:
      return "question";
    case INBOX_TIERS.failed:
      return "failed";
    default:
      return entry.signals.attention === "interrupted" ? "interrupted" : "unavailable";
  }
}

/**
 * Line 1's trailing status. `now` is the row's own clock: a host that isn't
 * online passes the moment it went offline, so its waits stop counting.
 */
export function inboxRowStatus(entry: InboxEntry, section: InboxSection, now: number): InboxRowStatus {
  const { signals } = entry;
  if (section === "needs_you") {
    const kind = inboxNeedsYouKind(entry, now) ?? "unavailable";
    return {
      label: NEEDS_YOU_LABELS[kind],
      tone: kind === "failed" ? "danger" : "warning",
      wait: formatInboxDuration(now, signals.attentionSince ?? signals.lastAssistantAt ?? signals.updatedAt),
      needsYou: kind,
    };
  }
  if (section === "working") {
    return {
      label: signals.runStartedAt === undefined ? "Working" : `Working ${formatInboxDuration(now, signals.runStartedAt)}`,
      tone: "working",
    };
  }
  return {
    label: formatInboxDuration(now, section === "updates" ? signals.lastAssistantAt ?? signals.updatedAt : signals.updatedAt),
    tone: "quiet",
  };
}

/**
 * The row's tooltip and `aria-description`: the pending command, question or
 * failure for local chats; for remote chats, what a waiting run asks (Remote
 * revision 48, for `runs:observe` devices) or else status, host and wait.
 */
export function inboxRowDescription(entry: InboxEntry, status: InboxRowStatus): string | undefined {
  const offline = entry.signals.hostOnline ? "" : `. ${entry.hostLabel} is offline`;
  if (!status.needsYou) {
    return entry.signals.hostOnline ? undefined : `${entry.hostLabel} is offline`;
  }
  if (entry.source.kind === "remote") {
    // Revision 48 hosts send what a waiting run asks, to devices that may observe runs.
    const asked = entry.source.chat.attentionSummary?.trim();
    const prefix = status.needsYou === "approval" ? "Approve" : status.needsYou === "question" ? "Question" : null;
    if (asked && prefix) return `${prefix}: ${asked}. On ${entry.hostLabel}, waiting ${status.wait}${offline}`;
    return `${status.label} on ${entry.hostLabel}, waiting ${status.wait}${offline}`;
  }
  if (entry.source.kind === "bot") return INBOX_BOT_NEEDS_YOU_DESCRIPTION;
  if (entry.source.kind === "remoteBot") {
    const what = status.needsYou === "failed" ? "The last run failed" : INBOX_BOT_NEEDS_YOU_DESCRIPTION;
    return `${what} on ${entry.hostLabel}${offline}`;
  }
  const summary = entry.pending?.summary.trim() ?? "";
  const more = entry.pending && entry.pending.count > 1 ? ` (+${entry.pending.count - 1} more)` : "";
  switch (status.needsYou) {
    case "approval":
      return summary ? `Approve: ${summary}${more}` : "Waiting for your approval";
    case "question":
      return summary ? `Question: ${summary}${more}` : "Waiting for your answer";
    case "failed":
      return "The last run failed";
    case "interrupted":
      return summary ? `Interrupted — open to resume: ${summary}` : "Interrupted — open to resume";
    case "unavailable":
      return summary ? `${INBOX_UNAVAILABLE_DESCRIPTION}: ${summary}` : INBOX_UNAVAILABLE_DESCRIPTION;
  }
}

export type InboxRowActionKind = "mark_read" | "acknowledge";

/**
 * The row's one hover icon. Mark read on unread Updates and Earlier rows;
 * Acknowledge on a Failed row in Needs you. Approval, Question, Interrupted
 * and Unavailable rows get none: the person answers those in the chat.
 * Remote rows need the host's read grant and a live connection.
 */
export function inboxRowAction(
  entry: InboxEntry,
  section: InboxSection,
  status: InboxRowStatus,
  remoteCanMarkRead: boolean,
): InboxRowActionKind | null {
  if (entry.source.kind === "remote" && (!remoteCanMarkRead || !entry.signals.hostOnline)) return null;
  // A paired host's Bot has no read state to acknowledge: its next run clears it.
  if (entry.source.kind === "remoteBot") return null;
  if (section === "needs_you") return status.needsYou === "failed" ? "acknowledge" : null;
  if (section !== "updates" && section !== "earlier") return null;
  return entry.signals.unread && !entry.signals.isOpen ? "mark_read" : null;
}

/** `chats:pendingAttention` refuses more ids than this. */
export const MAX_PENDING_ATTENTION_IDS = 2_000;

export interface PendingAttentionRequest {
  ids: readonly string[];
  /** Short and stable for the same ids: their count and a hash, never the ids themselves. */
  key: string;
}

/**
 * The local chats the Inbox asks `chats:pendingAttention` about. Bot chats are
 * left out (the Inbox doesn't list them). Chats that are running or waiting
 * right now come first, so the cap never drops a live wait; the newest of the
 * rest fill what's left.
 */
export function pendingAttentionRequest(
  chats: readonly ChatMeta[],
  live: Iterable<ReadonlySet<string>>,
  max = MAX_PENDING_ATTENTION_IDS,
): PendingAttentionRequest {
  const listed = chats.filter((chat) => !chat.botId);
  const known = new Set(listed.map((chat) => chat.id));
  const ids: string[] = [];
  const taken = new Set<string>();
  const take = (id: string) => {
    if (ids.length >= max || taken.has(id) || !known.has(id)) return;
    taken.add(id);
    ids.push(id);
  };
  for (const set of live) for (const id of [...set].sort()) take(id);
  const newest = [...listed].sort(
    (left, right) => (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt) || left.id.localeCompare(right.id),
  );
  for (const chat of newest) take(chat.id);
  return { ids, key: `${ids.length}:${fnv1a32(ids.join("\n"))}` };
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Mark read names the newest message the row rendered, so a reply that lands
 * mid-click stays unread: the newest user or assistant message no newer than
 * the row's `lastAssistantAt`.
 */
export function markReadThroughMessageId(
  messages: readonly { id: string; role: string; createdAt: number }[],
  renderedLastAssistantAt: number | undefined,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (renderedLastAssistantAt === undefined || message.createdAt <= renderedLastAssistantAt) return message.id;
  }
  return null;
}

export interface NeedsYouLeaveInput {
  /** Needs you keys as last shown, in order. */
  previous: readonly string[];
  /** The live order. */
  next: InboxDisplayOrder;
  /** When each lingering row left; carried between calls. */
  leftAt: ReadonlyMap<string, number>;
  /** Every row key that still exists. */
  present: ReadonlySet<string>;
  /** Rows the person acted on: they move at once. */
  touched: ReadonlySet<string>;
  now: number;
  delayMs?: number;
}

export interface NeedsYouLeaveResult {
  order: InboxDisplayOrder;
  leftAt: Map<string, number>;
  /** When the next lingering row is due to leave, or null. */
  nextCheckAt: number | null;
}

/**
 * Entering Needs you is immediate; leaving it waits `delayMs`. A row that just
 * left stays at its old Needs you slot until then, unless it was deleted or
 * the person acted on it.
 */
export function debounceNeedsYouLeave(input: NeedsYouLeaveInput): NeedsYouLeaveResult {
  const delayMs = input.delayMs ?? NEEDS_YOU_LEAVE_DEBOUNCE_MS;
  const live = new Set(input.next.needs_you);
  const leftAt = new Map<string, number>();
  const lingering: { key: string; index: number }[] = [];
  let nextCheckAt: number | null = null;
  input.previous.forEach((key, index) => {
    if (live.has(key) || !input.present.has(key) || input.touched.has(key)) return;
    const since = input.leftAt.get(key) ?? input.now;
    const due = since + delayMs;
    if (input.now >= due) return;
    leftAt.set(key, since);
    lingering.push({ key, index });
    nextCheckAt = nextCheckAt === null ? due : Math.min(nextCheckAt, due);
  });
  if (lingering.length === 0) return { order: input.next, leftAt, nextCheckAt };
  const held = new Set(lingering.map((row) => row.key));
  const needsYou = [...input.next.needs_you];
  for (const { key, index } of lingering) needsYou.splice(Math.min(index, needsYou.length), 0, key);
  const order = Object.fromEntries(
    INBOX_SECTIONS.map((section) => [
      section,
      section === "needs_you" ? needsYou : input.next[section].filter((key) => !held.has(key)),
    ]),
  ) as Record<InboxSection, string[]>;
  return { order, leftAt, nextCheckAt };
}

/** The sections the Inbox shows, top to bottom. */
export const INBOX_VISIBLE_SECTIONS = ["needs_you", "pinned", "updates", "earlier", "working"] as const satisfies readonly InboxSection[];

/**
 * ⌘1–9 and previous/next follow the rows on screen, in the frozen order:
 * every visible section, the Working shelf only while expanded. Rows held
 * dimmed after leaving are skipped.
 */
export function inboxShortcutOrder(held: HeldInboxOrder, options: { workingExpanded: boolean }): string[] {
  return INBOX_VISIBLE_SECTIONS.flatMap((section) =>
    section === "working" && !options.workingExpanded
      ? []
      : held[section].filter((row) => !row.leaving).map((row) => row.key),
  );
}

/** How many Inbox rows get a ⌘1–9 shortcut. */
export const INBOX_SHORTCUT_LIMIT = 9;

/**
 * The Inbox's key lookup: a listed entry first, then a held one that no
 * longer qualifies (a Bot answered or read elsewhere while it lingers).
 */
export function resolveInboxEntry<Entry>(
  listed: ReadonlyMap<string, Entry>,
  unlisted: ReadonlyMap<string, Entry>,
): (key: string) => Entry | undefined {
  return (key) => listed.get(key) ?? unlisted.get(key);
}

/**
 * What ⌘1–9 and previous/next open, given the keys the Inbox reports in
 * on-screen order (the same order that numbers the rows' hints): ⌘N opens the
 * Nth row, a held row that no longer qualifies included, so the binding always
 * matches the hint. `resolve` finds a key's live entry, listed or held.
 */
export function inboxShortcutTargets<Entry>(
  keys: readonly string[],
  resolve: (key: string) => Entry | undefined,
  activeKey: string | null,
): { jump: (Entry | undefined)[]; previous: Entry | undefined; next: Entry | undefined } {
  const jump = keys.slice(0, INBOX_SHORTCUT_LIMIT).map(resolve);
  const navigable = keys.filter((key) => resolve(key) !== undefined);
  const current = activeKey ? navigable.indexOf(activeKey) : -1;
  const previousKey = current > 0 ? navigable[current - 1] : undefined;
  const nextKey = current >= 0 ? navigable[current + 1] : navigable[0];
  return {
    jump,
    previous: previousKey === undefined ? undefined : resolve(previousKey),
    next: nextKey === undefined ? undefined : resolve(nextKey),
  };
}
