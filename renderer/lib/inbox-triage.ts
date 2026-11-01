import {
  inverseTriagePatch,
  triageRevision,
  type ChatTriageEntry,
  type ChatTriagePatch,
} from "../shared/chat-triage";
import type { InboxSignals } from "./sidebar-inbox";

/**
 * The Inbox's triage actions (docs/plans/inbox-sidebar-plan.md, Phase 2a):
 * the pure rules the sidebar's row menus, its optimistic overlay and its Undo
 * toast share. The hook that sends them is `use-inbox-triage.ts`.
 */

export type InboxTriageKind = "pin" | "unpin" | "done" | "snooze";

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
    case "snooze":
      return { snoozeUntil: until ?? null };
  }
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

/** The placement signals one entry contributes to a row. */
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
  return { kind: next.kind, items, at: next.at, ...(next.until !== undefined ? { until: next.until } : {}) };
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

/**
 * When a snooze ends, as the toast and menu say it: a time today, "tomorrow"
 * and a time, or a weekday and a time.
 */
export function formatSnoozeUntil(until: number, now: number, locale?: string): string {
  const at = new Date(until);
  const today = new Date(now);
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((dayStart(at) - dayStart(today)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow, ${time}`;
  if (days < 7) return `${at.toLocaleDateString(locale, { weekday: "long" })}, ${time}`;
  return `${at.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
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
      case "snooze":
        return batch.until === undefined ? "Snoozed" : `Snoozed until ${formatUntil(batch.until)}`;
    }
  }
  const verb = { pin: "pinned", unpin: "unpinned", done: "marked done", snooze: "snoozed" }[batch.kind];
  return `${count} chats ${verb}`;
}

/** What the toast says when Undo found chats another device changed in between. */
export function inboxTriageUndoConflictText(conflicts: number, total: number): string {
  if (total === 1) return "That chat changed since, so Undo left it as it is.";
  if (conflicts >= total) return "Those chats changed since, so Undo left them as they are.";
  return `${conflicts} ${conflicts === 1 ? "chat" : "chats"} changed since, so Undo left ${conflicts === 1 ? "it" : "them"} as ${conflicts === 1 ? "it is" : "they are"}.`;
}
