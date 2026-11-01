import * as React from "react";
import { toast } from "../components/ui";
import { chatsApi } from "./ipc";
import { useChatTriage } from "./use-chat-activity";
import { RemoteHostAdapter } from "./hosts/remote-host-adapter";
import { userFacingErrorMessage } from "./ipc-error";
import type { PeerHostView } from "../shared/peer-host";
import { LOCAL_SIDEBAR_HOST_ID } from "./sidebar-organization";
import {
  formatSnoozeUntil,
  groupByHost,
  inboxTriagePatch,
  inboxTriageToastTitle,
  inboxTriageUndoConflictText,
  inboxTriageUndoWrites,
  INBOX_TRIAGE_TOAST_ID,
  INBOX_TRIAGE_UNDO_MS,
  mergeInboxTriageUndo,
  newerTriage,
  predictTriage,
  type InboxReadsPending,
  settledTriageOverlayKeys,
  type InboxTriageKind,
  type InboxTriageTarget,
  type InboxTriageUndoBatch,
  type InboxTriageUndoItem,
} from "./inbox-triage";
import type { ChatTriageEntry, ChatTriagePatch, ChatTriageResult } from "../shared/chat-triage";

/** A row the person triages, with what its host last reported for it. */
export interface InboxTriageRow extends InboxTriageTarget {
  /** A paired host's last reported entry (Phase 2b summaries); local rows read the store's snapshot. */
  reported?: ChatTriageEntry | null;
  /**
   * The newest output the row showed when the person acted. A read sent with
   * the action (`markRead`) covers output up to here; anything newer stays unread.
   */
  readThrough?: number;
}

interface TriageWrite {
  target: InboxTriageRow;
  patch: ChatTriagePatch;
  ifRevision?: number;
}

type WriteOutcome =
  | { ok: true; entry: ChatTriageEntry }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; message: string };

const FAILED_MESSAGE = "Aiden could not update that chat.";
const READ_FAILED_MESSAGE = "Aiden could not mark that chat read.";

function outcomeOf(result: ChatTriageResult): WriteOutcome {
  if (result.ok) return { ok: true, entry: result.entry };
  if (result.code === "revision_conflict") return { ok: false, conflict: true };
  return { ok: false, conflict: false, message: FAILED_MESSAGE };
}

/** A rejected write's message, without Electron's "Error invoking remote method" wrapper. */
function messageOf(error: unknown): string {
  return userFacingErrorMessage(error, FAILED_MESSAGE);
}

/**
 * One host's writes, in order, over one connection: this Mac's store over IPC,
 * or one `RemoteHostAdapter` for a paired host.
 */
async function sendHostWrites(
  hostId: string,
  writes: readonly TriageWrite[],
  view: PeerHostView | undefined,
): Promise<WriteOutcome[]> {
  if (hostId === LOCAL_SIDEBAR_HOST_ID) {
    const outcomes: WriteOutcome[] = [];
    for (const write of writes) {
      try {
        outcomes.push(outcomeOf(await chatsApi.setTriage(write.target.chatId, write.patch, write.ifRevision)));
      } catch (error) {
        outcomes.push({ ok: false, conflict: false, message: messageOf(error) });
      }
    }
    return outcomes;
  }
  if (!view) return writes.map(() => ({ ok: false, conflict: false, message: "That Mac is no longer paired with this one." }));
  const adapter = new RemoteHostAdapter(view);
  try {
    await adapter.ready();
    const outcomes: WriteOutcome[] = [];
    for (const write of writes) {
      try {
        outcomes.push(outcomeOf(await adapter.setTriage(write.target.chatId, write.patch, write.ifRevision)));
      } catch (error) {
        outcomes.push({ ok: false, conflict: false, message: messageOf(error) });
      }
    }
    return outcomes;
  } catch (error) {
    return writes.map(() => ({ ok: false, conflict: false, message: messageOf(error) }));
  } finally {
    adapter.dispose();
  }
}

/** Every write, one sequence per host and the hosts side by side. Outcomes keep the writes' order. */
async function sendWrites(
  writes: readonly TriageWrite[],
  views: ReadonlyMap<string, PeerHostView>,
): Promise<WriteOutcome[]> {
  const indexed = writes.map((write, index) => ({ ...write, index }));
  const outcomes: WriteOutcome[] = new Array(writes.length);
  await Promise.all(
    [...groupByHost(indexed)].map(async ([hostId, group]) => {
      const results = await sendHostWrites(hostId, group, views.get(hostId));
      group.forEach((write, position) => {
        outcomes[write.index] = results[position]!;
      });
    }),
  );
  return outcomes;
}

export interface InboxTriageActOptions {
  /**
   * Also mark each row read (unseen output from a failed run, which would
   * otherwise keep the row in Needs you). The rows read as read at once
   * (`readsPending`); the read itself is sent only once the host has taken the
   * triage write, so it never lands without the triage. A row whose write fails
   * or conflicts, or whose read rejects, reads unread again, and a rejected
   * read shows an error toast. Undo doesn't reverse the read.
   */
  markRead?: (row: InboxTriageRow) => Promise<void>;
}

export interface InboxTriage {
  /** The entry a row shows: its host's, or this device's newer write. */
  entryFor: (row: InboxTriageRow) => ChatTriageEntry | undefined;
  /** Pin, unpin, mark done or snooze rows. The rows move at once; the Undo toast follows. */
  act: (
    kind: InboxTriageKind,
    rows: readonly InboxTriageRow[],
    until?: number,
    options?: InboxTriageActOptions,
  ) => Promise<void>;
  /**
   * Rows this device marked read with an action, by row key, until the row's
   * own read state catches up (`withInboxReadsPending` applies them;
   * `settledInboxReads` names the ones to `settleReads`).
   */
  readsPending: InboxReadsPending;
  /** Drops rows from `readsPending`. */
  settleReads: (keys: readonly string[]) => void;
}

/**
 * The Inbox's triage: this Mac's store, an optimistic overlay of this device's
 * own writes, and the merged 5-second Undo toast. Undo names the revision each
 * write left, so it changes nothing on a chat another device touched since.
 */
export function useInboxTriage({
  views,
  reported,
  onRestore,
}: {
  views: ReadonlyMap<string, PeerHostView>;
  /**
   * What each paired host last reported, by row key (Remote revision 48 summaries).
   * An overlay entry its host has since reported, or passed, is dropped.
   */
  reported?: ReadonlyMap<string, ChatTriageEntry>;
  /**
   * Undo is about to move these rows back: the Inbox places them live, as the
   * row's own `touch` does for an action, so a frozen list doesn't hold them out.
   */
  onRestore?: (keys: readonly string[]) => void;
}): InboxTriage {
  const local = useChatTriage();
  const [overlay, setOverlay] = React.useState<ReadonlyMap<string, ChatTriageEntry>>(() => new Map());
  const overlayRef = React.useRef(overlay);
  const localRef = React.useRef(local);
  localRef.current = local;
  const viewsRef = React.useRef(views);
  viewsRef.current = views;
  const onRestoreRef = React.useRef(onRestore);
  onRestoreRef.current = onRestore;
  const undoRef = React.useRef<InboxTriageUndoBatch | null>(null);
  const [readsPending, setReadsPending] = React.useState<InboxReadsPending>(() => new Map());

  const markReadsPending = React.useCallback((rows: readonly InboxTriageRow[]) => {
    setReadsPending((current) => {
      const next = new Map(current);
      for (const row of rows) next.set(row.key, row.readThrough);
      return next;
    });
  }, []);

  const settleReads = React.useCallback((keys: readonly string[]) => {
    setReadsPending((current) => {
      if (!keys.some((key) => current.has(key))) return current;
      const next = new Map(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  const write = React.useCallback((changes: readonly (readonly [string, ChatTriageEntry | null])[]) => {
    const next = new Map(overlayRef.current);
    for (const [key, entry] of changes) {
      if (entry) next.set(key, entry);
      else next.delete(key);
    }
    overlayRef.current = next;
    setOverlay(next);
  }, []);

  const reportedFor = React.useCallback((row: InboxTriageRow) =>
    row.hostId === LOCAL_SIDEBAR_HOST_ID ? localRef.current?.chats[row.chatId] : row.reported ?? undefined, []);

  const currentFor = React.useCallback(
    (row: InboxTriageRow) => newerTriage(reportedFor(row), overlayRef.current.get(row.key)),
    [reportedFor],
  );

  // An overlay entry its host has since reported (or passed) is dropped.
  React.useEffect(() => {
    if (overlayRef.current.size === 0) return;
    const settled = settledTriageOverlayKeys(overlayRef.current, local?.chats, reported);
    if (settled.length > 0) write(settled.map((key) => [key, null] as const));
  }, [local, reported, write]);

  const undo = React.useCallback(async (batch: InboxTriageUndoBatch) => {
    if (undoRef.current === batch) undoRef.current = null;
    toast.dismiss(INBOX_TRIAGE_TOAST_ID);
    const writes = inboxTriageUndoWrites(batch);
    const rows: InboxTriageRow[] = batch.items.map((item) => item.target);
    const shown = rows.map((row) => currentFor(row));
    const now = Date.now();
    onRestoreRef.current?.(rows.map((row) => row.key));
    write(rows.map((row, index) => [row.key, predictTriage(shown[index], writes[index]!.patch, now)] as const));
    const outcomes = await sendWrites(
      writes.map((undoWrite, index) => ({ target: rows[index]!, patch: undoWrite.patch, ifRevision: undoWrite.ifRevision })),
      viewsRef.current,
    );
    let conflicts = 0;
    let failure: string | null = null;
    write(outcomes.map((outcome, index) => {
      const row = rows[index]!;
      if (outcome.ok) return [row.key, outcome.entry] as const;
      if (outcome.conflict) conflicts += 1;
      else failure ??= outcome.message;
      // Put back what the row showed. On this Mac the store's snapshot already holds the other write.
      return [row.key, row.hostId === LOCAL_SIDEBAR_HOST_ID ? null : shown[index] ?? null] as const;
    }));
    if (conflicts > 0) {
      toast(inboxTriageUndoConflictText(conflicts, rows.length), { id: INBOX_TRIAGE_TOAST_ID, duration: INBOX_TRIAGE_UNDO_MS });
    } else if (failure) {
      toast.error(failure, { id: INBOX_TRIAGE_TOAST_ID });
    }
  }, [currentFor, write]);

  const act = React.useCallback(async (
    kind: InboxTriageKind,
    rows: readonly InboxTriageRow[],
    until?: number,
    options?: InboxTriageActOptions,
  ) => {
    if (rows.length === 0) return;
    const patch = inboxTriagePatch(kind, until);
    const before = rows.map((row) => currentFor(row) ?? null);
    const now = Date.now();
    const markRead = options?.markRead;
    if (markRead) markReadsPending(rows);
    write(rows.map((row, index) => [row.key, predictTriage(before[index], patch, now)] as const));
    const outcomes = await sendWrites(rows.map((row) => ({ target: row, patch })), viewsRef.current);
    const items: InboxTriageUndoItem[] = [];
    const written: InboxTriageRow[] = [];
    let failure: string | null = null;
    write(outcomes.map((outcome, index) => {
      const row = rows[index]!;
      if (outcome.ok) {
        written.push(row);
        items.push({ target: row, before: before[index] ?? null, patch, revision: outcome.entry.revision });
        return [row.key, outcome.entry] as const;
      }
      if (!outcome.conflict) failure ??= outcome.message;
      return [row.key, row.hostId === LOCAL_SIDEBAR_HOST_ID ? null : before[index] ?? null] as const;
    }));
    if (failure) toast.error(failure);
    if (markRead) {
      const refused = rows.filter((row) => !written.includes(row));
      if (refused.length > 0) settleReads(refused.map((row) => row.key));
      for (const row of written) {
        void markRead(row).catch((error: unknown) => {
          settleReads([row.key]);
          toast.error(userFacingErrorMessage(error, READ_FAILED_MESSAGE));
        });
      }
    }
    if (items.length === 0) return;
    const batch = mergeInboxTriageUndo(undoRef.current, {
      kind,
      items,
      at: Date.now(),
      ...(until !== undefined ? { until } : {}),
    });
    undoRef.current = batch;
    toast(inboxTriageToastTitle(batch, (at) => formatSnoozeUntil(at, Date.now())), {
      id: INBOX_TRIAGE_TOAST_ID,
      duration: INBOX_TRIAGE_UNDO_MS,
      action: { label: "Undo", onClick: () => void undo(batch) },
    });
  }, [currentFor, markReadsPending, settleReads, undo, write]);

  const entryFor = React.useCallback(
    (row: InboxTriageRow) =>
      newerTriage(row.hostId === LOCAL_SIDEBAR_HOST_ID ? local?.chats[row.chatId] : row.reported ?? undefined, overlay.get(row.key)),
    [local, overlay],
  );

  // One identity while nothing changes, so the Inbox's entries are not rebuilt every render.
  return React.useMemo(
    () => ({ entryFor, act, readsPending, settleReads }),
    [entryFor, act, readsPending, settleReads],
  );
}
