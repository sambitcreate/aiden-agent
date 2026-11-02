import {
  inverseTriagePatch,
  triageRevision,
  type ChatTriageEntry,
  type ChatTriagePatch,
} from "../shared/chat-triage";
import { inboxTriageHold, type InboxSignals } from "./sidebar-inbox";
import { LOCAL_SIDEBAR_HOST_ID, parseProjectOrderKey } from "./sidebar-organization";

/**
 * The Inbox's triage actions (docs/plans/inbox-sidebar-plan.md, Phase 2a):
 * the pure rules the sidebar's row menus, its optimistic overlay and its Undo
 * toast share. The hook that sends them is `use-inbox-triage.ts`.
 */

/** `undone` and `unsnooze` are Mark not done and Unsnooze, on the Done and snoozed rows search lists. */
export type InboxTriageKind = "pin" | "unpin" | "done" | "undone" | "snooze" | "unsnooze";

/** One row a triage action names. */
export interface InboxTriageTarget {
  /** The row key, `projectOrderKey(hostId, chatId)`. */
  key: string;
  hostId: string;
  chatId: string;
}

/** How long the Undo toast stays, and how close together actions merge into one. */
export const INBOX_TRIAGE_UNDO_MS = 5_000;
/** The one Undo toast: a new action replaces it rather than stacking a second. */
export const INBOX_TRIAGE_TOAST_ID = "inbox-triage";

export function inboxTriagePatch(kind: InboxTriageKind, until?: number): ChatTriagePatch {
  switch (kind) {
    case "pin":
      return { pinned: true };
    case "unpin":
      return { pinned: false };
    case "done":
      return { done: true };
    case "undone":
      return { done: false };
    case "snooze":
      return { snoozeUntil: until ?? null };
    case "unsnooze":
      return { snoozeUntil: null };
  }
}

/** Which triage items a row's menu offers. */
export interface InboxTriageOffer {
  /**
   * Mark done (or Mark not done) and Snooze (or Unsnooze). Left out while the
   * row waits on the person or runs: neither would move it. Such a row with a
   * snooze still to run offers Unsnooze alone (`snoozed`), so it doesn't drop
   * back out of the list once the wait or the run ends.
   */
  doneAndSnooze: boolean;
  /**
   * Mark done and Snooze also mark the row read: unseen output from a failed
   * run keeps a row in Needs you until it is read.
   */
  alsoMarkRead: boolean;
  /** Mark done holds now, so the item reads Mark not done. */
  done: boolean;
  /** A snooze holds now, so the item reads Unsnooze (offered even when `doneAndSnooze` is not). */
  snoozed: boolean;
}

/** What a row's menu offers, by the rules that place it (`inboxState`). */
export function inboxTriageOffer(
  signals: Pick<InboxSignals, "rowState" | "attention" | "failed" | "unread" | "isOpen" | "doneAt" | "snoozedUntil" | "lastAssistantAt">,
  now: number,
): InboxTriageOffer {
  const holdsRow =
    signals.rowState === "needs_approval" ||
    signals.rowState === "needs_input" ||
    signals.rowState === "working" ||
    signals.attention !== undefined;
  const hold = inboxTriageHold(signals, now);
  return {
    doneAndSnooze: !holdsRow,
    alsoMarkRead: !holdsRow && signals.failed && signals.unread && !signals.isOpen,
    done: hold.done,
    snoozed: hold.snoozed,
  };
}

/**
 * The entry a write will leave, by the store's rules (`ChatTriageStore.set`),
 * so a row moves the moment the person acts rather than when the host answers.
 */
export function predictTriage(
  before: ChatTriageEntry | null | undefined,
  patch: ChatTriagePatch,
  now: number,
): ChatTriageEntry {
  const next: ChatTriageEntry = { ...(before ?? {}), revision: triageRevision(before) + 1, updatedAt: now };
  if (patch.pinned === true) next.pinnedAt = before?.pinnedAt ?? now;
  else if (patch.pinned === false) delete next.pinnedAt;
  if (patch.done === true) next.doneAt = now;
  else if (patch.done === false) delete next.doneAt;
  if (typeof patch.snoozeUntil === "number" && patch.snoozeUntil > now) next.snoozedUntil = patch.snoozeUntil;
  else if (patch.snoozeUntil !== undefined) delete next.snoozedUntil;
  return next;
}

/**
 * The entry a row shows: the newer of what its host reported and what this
 * device just wrote. A write's entry wins until the host reports that
 * revision or a later one.
 */
export function newerTriage(
  reported: ChatTriageEntry | null | undefined,
  written: ChatTriageEntry | null | undefined,
): ChatTriageEntry | undefined {
  if (!written) return reported ?? undefined;
  if (!reported) return written;
  return written.revision > reported.revision ? written : reported;
}

/**
 * The overlay keys whose host has since reported the same revision or a newer
 * one: this Mac's store for local rows, the host's chat summaries (Remote
 * revision 50) for a paired host's. A host that reports nothing for a row,
 * such as one older than revision 50, keeps its overlay entry.
 */
export function settledTriageOverlayKeys(
  overlay: ReadonlyMap<string, ChatTriageEntry>,
  local: Readonly<Record<string, ChatTriageEntry>> | undefined,
  reported: ReadonlyMap<string, ChatTriageEntry> | undefined,
): string[] {
  return [...overlay].flatMap(([key, entry]) => {
    const parsed = parseProjectOrderKey(key);
    if (!parsed) return [];
    const known = parsed.hostId === LOCAL_SIDEBAR_HOST_ID ? local?.[parsed.projectId] : reported?.get(key);
    return known !== undefined && known.revision >= entry.revision ? [key] : [];
  });
}

/**
 * Rows this device marked read along with Mark done or Snooze, by row key: the
 * newest output each row showed then (`InboxTriageRow.readThrough`).
 */
export type InboxReadsPending = ReadonlyMap<string, number | undefined>;

type ReadSignals = Pick<InboxSignals, "unread" | "isOpen" | "lastAssistantAt">;

function readCovers(through: number | undefined, signals: ReadSignals): boolean {
  return (signals.lastAssistantAt ?? Number.NEGATIVE_INFINITY) <= (through ?? Number.NEGATIVE_INFINITY);
}

/**
 * The rows as the person left them: a read sent with an action counts at once,
 * so unseen failed output doesn't hold a Done or snoozed row in Needs you while
 * the host and the read markers catch up. Output newer than the action still
 * reads unread.
 */
export function withInboxReadsPending<Row extends { key: string; signals: ReadSignals }>(
  rows: readonly Row[],
  pending: InboxReadsPending,
): Row[] {
  if (pending.size === 0) return [...rows];
  return rows.map((row) =>
    row.signals.unread && pending.has(row.key) && readCovers(pending.get(row.key), row.signals)
      ? { ...row, signals: { ...row.signals, unread: false } }
      : row,
  );
}

/**
 * The pending reads the rows no longer need: the row reads as read by itself,
 * newer output arrived, or the row is gone.
 */
export function settledInboxReads(
  pending: InboxReadsPending,
  rows: readonly { key: string; signals: ReadSignals }[],
): string[] {
  if (pending.size === 0) return [];
  const byKey = new Map(rows.map((row) => [row.key, row.signals] as const));
  return [...pending].flatMap(([key, through]) => {
    const signals = byKey.get(key);
    if (!signals || !signals.unread || signals.isOpen || !readCovers(through, signals)) return [key];
    return [];
  });
}

export { triageSignals } from "../shared/inbox-state";

/** One chat in an Undo batch. */
export interface InboxTriageUndoItem {
  target: InboxTriageTarget;
  /** The entry before the first action in the batch touched this chat. */
  before: ChatTriageEntry | null;
  /** Every field the batch's actions on this chat named. */
  patch: ChatTriagePatch;
  /** The chat's triage revision after this device's last write; Undo sends it as `ifRevision`. */
  revision: number;
}

/** What one Undo toast reverts. */
export interface InboxTriageUndoBatch {
  kind: InboxTriageKind;
  items: InboxTriageUndoItem[];
  /** When the last action joined the batch. */
  at: number;
  /** Snooze only: when the chats wake. */
  until?: number;
}

/**
 * Join a new action to the open Undo batch when it is the same kind and lands
 * within the Undo window; otherwise it starts a new batch. A chat acted on
 * twice keeps its first `before`, so Undo puts it back as it was before both.
 * A merged snooze keeps `until` only while every chat in it wakes then.
 */
export function mergeInboxTriageUndo(
  current: InboxTriageUndoBatch | null,
  next: InboxTriageUndoBatch,
): InboxTriageUndoBatch {
  if (!current || current.kind !== next.kind || next.at - current.at >= INBOX_TRIAGE_UNDO_MS) return next;
  const items = current.items.map((item) => ({ ...item }));
  for (const item of next.items) {
    const existing = items.find((candidate) => candidate.target.key === item.target.key);
    if (existing) {
      existing.patch = { ...existing.patch, ...item.patch };
      existing.revision = item.revision;
    } else {
      items.push(item);
    }
  }
  // Chats snoozed to different times share one toast that names no time.
  const wakes = new Set(items.map((item) => item.patch.snoozeUntil));
  const until = next.until !== undefined && wakes.size === 1 && wakes.has(next.until) ? next.until : undefined;
  return { kind: next.kind, items, at: next.at, ...(until !== undefined ? { until } : {}) };
}

/** Undo's writes: the inverse of each chat's patch, guarded by the revision its last write left. */
export function inboxTriageUndoWrites(
  batch: InboxTriageUndoBatch,
): { target: InboxTriageTarget; patch: ChatTriagePatch; ifRevision: number; before: ChatTriageEntry | null }[] {
  return batch.items.map((item) => ({
    target: item.target,
    patch: inverseTriagePatch(item.before, item.patch),
    ifRevision: item.revision,
    before: item.before,
  }));
}

/** Writes grouped by host, in first-seen order, so each host gets one connection. */
export function groupByHost<T extends { target: InboxTriageTarget }>(writes: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const write of writes) {
    const group = groups.get(write.target.hostId);
    if (group) group.push(write);
    else groups.set(write.target.hostId, [write]);
  }
  return groups;
}

function snoozeTime(at: Date, locale?: string): string {
  return at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** Whole calendar days from `now` to `until` on this device's clock. */
function calendarDaysAhead(until: Date, now: number): number {
  const today = new Date(now);
  const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((dayStart(until) - dayStart(today)) / 86_400_000);
}

/**
 * When a snooze ends, as the toast and a snoozed row say it: a time today,
 * "tomorrow" and a time, or a weekday and a time.
 */
export function formatSnoozeUntil(until: number, now: number, locale?: string): string {
  const at = new Date(until);
  const time = snoozeTime(at, locale);
  const days = calendarDaysAhead(at, now);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow, ${time}`;
  if (days < 7) return `${at.toLocaleDateString(locale, { weekday: "long" })}, ${time}`;
  return `${at.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

/**
 * A time without ":00" on the hour ("9 AM", "5:42 PM"), on a 12-hour clock only: a
 * 24-hour clock's bare hour ("18") doesn't read as a time.
 */
function compactSnoozeTime(at: Date, locale?: string): string {
  if (at.getMinutes() !== 0) return snoozeTime(at, locale);
  const hourOnly = new Intl.DateTimeFormat(locale, { hour: "numeric" });
  // `hour12` is true for the h11 and h12 hour cycles.
  return hourOnly.resolvedOptions().hour12 === true ? hourOnly.format(at) : snoozeTime(at, locale);
}

/**
 * A snoozed row's short status, which search lists after "Until" beside the
 * workspace label, so the label keeps its room: the time for today ("5:42
 * PM"), the short weekday and time within the week ("Mon 9 AM"), else the date
 * ("Nov 16"). The row's accessible name says it in full (`formatSnoozeMenuTime`).
 */
export function formatSnoozeStatus(until: number, now: number, locale?: string): string {
  const at = new Date(until);
  const days = calendarDaysAhead(at, now);
  if (days >= 7) return at.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const time = compactSnoozeTime(at, locale);
  if (days <= 0) return time;
  return `${at.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

/**
 * A Snooze preset's trailing time in the menu, beside a label that already
 * names the day ("Tomorrow", "Next week"): the time alone for today, the short
 * weekday and the time within the week ("Mon 9:00 AM"), else the date and the
 * time ("Nov 9, 9:00 AM"), so Next week on a Sunday doesn't read like Tomorrow.
 */
export function formatSnoozeMenuTime(until: number, now: number, locale?: string): string {
  const at = new Date(until);
  const time = snoozeTime(at, locale);
  const days = calendarDaysAhead(at, now);
  if (days <= 0) return time;
  if (days < 7) return `${at.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`;
}

/** The Undo toast's title: "Marked done", or "3 chats marked done" once actions merge. */
export function inboxTriageToastTitle(
  batch: Pick<InboxTriageUndoBatch, "kind" | "items" | "until">,
  formatUntil: (until: number) => string,
): string {
  const count = batch.items.length;
  if (count === 1) {
    switch (batch.kind) {
      case "pin":
        return "Pinned";
      case "unpin":
        return "Unpinned";
      case "done":
        return "Marked done";
      case "undone":
        return "Marked not done";
      case "snooze":
        return batch.until === undefined ? "Snoozed" : `Snoozed until ${formatUntil(batch.until)}`;
      case "unsnooze":
        return "Unsnoozed";
    }
  }
  const verb = {
    pin: "pinned",
    unpin: "unpinned",
    done: "marked done",
    undone: "marked not done",
    snooze: "snoozed",
    unsnooze: "unsnoozed",
  }[batch.kind];
  return `${count} chats ${verb}`;
}

/** What the toast says when Undo found chats another device changed in between. */
export function inboxTriageUndoConflictText(conflicts: number, total: number): string {
  if (total === 1) return "That chat changed since, so Undo left it as it is.";
  if (conflicts >= total) return "Those chats changed since, so Undo left them as they are.";
  return `${conflicts} ${conflicts === 1 ? "chat" : "chats"} changed since, so Undo left ${conflicts === 1 ? "it" : "them"} as ${conflicts === 1 ? "it is" : "they are"}.`;
}
