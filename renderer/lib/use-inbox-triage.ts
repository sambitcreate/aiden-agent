import * as React from "react";
import { toast } from "../components/ui";
import { chatsApi } from "./ipc";
import { useChatTriage } from "./use-chat-activity";
import { RemoteHostAdapter } from "./hosts/remote-host-adapter";
import type { PeerHostView } from "../shared/peer-host";
import { LOCAL_SIDEBAR_HOST_ID, parseProjectOrderKey } from "./sidebar-organization";
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
}

interface TriageWrite {
  target: InboxTriageRow;
  patch: ChatTriagePatch;
  ifRevision?: number;
}

type WriteOutcome =
  | { ok: true; entry: ChatTriageEntry }
  | { ok: false; conflict: true; entry: ChatTriageEntry | null }
  | { ok: false; conflict: false; message: string };

const FAILED_MESSAGE = "Aiden could not update that chat.";

function outcomeOf(result: ChatTriageResult): WriteOutcome {
  if (result.ok) return { ok: true, entry: result.entry };
  if (result.code === "revision_conflict") return { ok: false, conflict: true, entry: result.entry };
  return { ok: false, conflict: false, message: FAILED_MESSAGE };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FAILED_MESSAGE;
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

export interface InboxTriage {
  /** The entry a row shows: its host's, or this device's newer write. */
  entryFor: (row: InboxTriageRow) => ChatTriageEntry | undefined;
  /** Pin, unpin, mark done or snooze rows. The rows move at once; the Undo toast follows. */
  act: (kind: InboxTriageKind, rows: readonly InboxTriageRow[], until?: number) => Promise<void>;
}

/**
 * The Inbox's triage: this Mac's store, an optimistic overlay of this device's
 * own writes, and the merged 5-second Undo toast. Undo names the revision each
 * write left, so it changes nothing on a chat another device touched since.
 */
export function useInboxTriage({ views }: { views: ReadonlyMap<string, PeerHostView> }): InboxTriage {
  const local = useChatTriage();
  const [overlay, setOverlay] = React.useState<ReadonlyMap<string, ChatTriageEntry>>(() => new Map());
  const overlayRef = React.useRef(overlay);
  const localRef = React.useRef(local);
  localRef.current = local;
  const viewsRef = React.useRef(views);
  viewsRef.current = views;
  const undoRef = React.useRef<InboxTriageUndoBatch | null>(null);

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

  // A local overlay entry the store has since reported (or passed) is dropped.
  React.useEffect(() => {
    if (!local || overlayRef.current.size === 0) return;
    const stale = [...overlayRef.current].filter(([key, entry]) => {
      const parsed = parseProjectOrderKey(key);
      if (parsed?.hostId !== LOCAL_SIDEBAR_HOST_ID) return false;
      const reported = local.chats[parsed.projectId];
      return reported !== undefined && reported.revision >= entry.revision;
    });
    if (stale.length > 0) write(stale.map(([key]) => [key, null] as const));
  }, [local, write]);

  const undo = React.useCallback(async (batch: InboxTriageUndoBatch) => {
    if (undoRef.current === batch) undoRef.current = null;
    toast.dismiss(INBOX_TRIAGE_TOAST_ID);
    const writes = inboxTriageUndoWrites(batch);
    const rows: InboxTriageRow[] = batch.items.map((item) => item.target);
    const shown = rows.map((row) => currentFor(row));
    const now = Date.now();
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

  const act = React.useCallback(async (kind: InboxTriageKind, rows: readonly InboxTriageRow[], until?: number) => {
    if (rows.length === 0) return;
    const patch = inboxTriagePatch(kind, until);
    const before = rows.map((row) => currentFor(row) ?? null);
    const now = Date.now();
    write(rows.map((row, index) => [row.key, predictTriage(before[index], patch, now)] as const));
    const outcomes = await sendWrites(rows.map((row) => ({ target: row, patch })), viewsRef.current);
    const items: InboxTriageUndoItem[] = [];
    let failure: string | null = null;
    write(outcomes.map((outcome, index) => {
      const row = rows[index]!;
      if (outcome.ok) {
        items.push({ target: row, before: before[index] ?? null, patch, revision: outcome.entry.revision });
        return [row.key, outcome.entry] as const;
      }
      if (!outcome.conflict) failure ??= outcome.message;
      return [row.key, row.hostId === LOCAL_SIDEBAR_HOST_ID ? null : before[index] ?? null] as const;
    }));
    if (failure) toast.error(failure);
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
  }, [currentFor, undo, write]);

  const entryFor = React.useCallback(
    (row: InboxTriageRow) =>
      newerTriage(row.hostId === LOCAL_SIDEBAR_HOST_ID ? local?.chats[row.chatId] : row.reported ?? undefined, overlay.get(row.key)),
    [local, overlay],
  );

  return { entryFor, act };
}
