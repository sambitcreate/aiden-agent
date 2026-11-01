import { ASSISTANT_WORKSPACE_ID } from "../shared/assistant";
import { DEFAULT_CHAT_WORKSPACE_ID } from "../shared/chat-workspace";
import type { ChatPendingAttention } from "../shared/chat-pending-attention";
import type { ChatRowState } from "../shared/chat-row-state";
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
export const INBOX_UNAVAILABLE_DESCRIPTION = "Approval unavailable — return to retry";
/** Leaving Needs you waits this long, so a run that answers one prompt and raises the next doesn't bounce. */
export const NEEDS_YOU_LEAVE_DEBOUNCE_MS = 400;

export type InboxEntrySource =
  | { kind: "local"; chat: ChatMeta }
  | { kind: "remote"; chat: RemoteSidebarChat };

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
        },
      },
    ];
  });
}

/**
 * Paired hosts' rows. A blocked host's rows are left out: the one Reconnect
 * notice above the list stands in for them. Rows of a host that isn't online
 * stay, marked offline (`hostOnline: false`), and drop out of the counts.
 */
export function remoteInboxEntries(
  rows: readonly RemoteSidebarRows[],
  hosts: readonly SidebarHost[],
  isOpen: (hostId: string, chatId: string) => boolean = () => false,
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

export type InboxNeedsYouKind = "approval" | "question" | "failed" | "interrupted" | "unavailable";

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
};

/** Why a Needs you row is there, from the same rules that placed it. */
export function inboxNeedsYouKind(entry: InboxEntry, now: number): InboxNeedsYouKind | null {
  const placement = inboxState(entry.signals, now);
  if (placement.shelf !== "needs_you") return null;
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
 * failure for local chats; status, host and wait for remote chats, whose
 * summaries can't carry prompt text until Phase 2.
 */
export function inboxRowDescription(entry: InboxEntry, status: InboxRowStatus): string | undefined {
  const offline = entry.signals.hostOnline ? "" : `. ${entry.hostLabel} is offline`;
  if (!status.needsYou) {
    return entry.signals.hostOnline ? undefined : `${entry.hostLabel} is offline`;
  }
  if (entry.source.kind === "remote") {
    return `${status.label} on ${entry.hostLabel}, waiting ${status.wait}${offline}`;
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
  if (section === "needs_you") return status.needsYou === "failed" ? "acknowledge" : null;
  if (section !== "updates" && section !== "earlier") return null;
  return entry.signals.unread && !entry.signals.isOpen ? "mark_read" : null;
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

/** The sections the Inbox shows, top to bottom. Pinned arrives in Phase 2. */
export const INBOX_VISIBLE_SECTIONS = ["needs_you", "updates", "earlier", "working"] as const satisfies readonly InboxSection[];

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
