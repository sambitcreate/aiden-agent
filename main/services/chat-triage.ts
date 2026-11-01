// Inbox triage: Pin, Done and Snooze (docs/plans/inbox-sidebar-plan.md, Phase 2a).
//
// One small main-owned JSON document (userData/chat-triage.json) shared by the
// desktop sidebar and every paired Aiden Remote device, so a chat marked done
// on a phone leaves the Mac's Inbox too. Like the read markers, triage lives
// outside the chat payload and index: it never bumps a chat's summary revision.
//
// Each field is last-writer-wins. Every write to a chat bumps that chat's
// triage `revision`, which a writer can pass back as `ifRevision` so Undo only
// lands when nothing else changed the chat in between.

import {
  MAX_CHAT_TRIAGE_ENTRIES,
  MAX_SNOOZE_AHEAD_MS,
  triageRevision,
  type ChatTriageEntry,
  type ChatTriagePatch,
  type ChatTriageResult,
  type ChatTriageSnapshot,
  type ChatTriageWrite,
} from "../../renderer/shared/chat-triage.js";
import { DataStore } from "./data-store.js";
import type { HostRunSummary } from "./host-run-registry.js";

interface ChatTriageFile {
  version: 1;
  chats: Record<string, ChatTriageEntry>;
}

const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
/**
 * The wake timer never waits longer than this, so a snooze that passed while
 * the clock jumped (a manual change, a time-zone sync) clears within a minute
 * even if no resume or unlock reported it.
 */
export const SNOOZE_WAKE_CHECK_MS = 60_000;

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeEntry(value: unknown): ChatTriageEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isTimestamp(record.revision) || record.revision < 1 || !isTimestamp(record.updatedAt)) return null;
  const entry: ChatTriageEntry = { revision: record.revision, updatedAt: record.updatedAt };
  if (isTimestamp(record.pinnedAt)) entry.pinnedAt = record.pinnedAt;
  if (isTimestamp(record.doneAt)) entry.doneAt = record.doneAt;
  if (isTimestamp(record.snoozedUntil) && record.snoozedUntil > 0) entry.snoozedUntil = record.snoozedUntil;
  return entry;
}

function normalizeFile(value: unknown): ChatTriageFile {
  const empty: ChatTriageFile = { version: 1, chats: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return empty;
  const raw = record.chats;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const chats: Record<string, ChatTriageEntry> = {};
  for (const [chatId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!SAFE_CHAT_ID.test(chatId)) continue;
    const normalized = normalizeEntry(entry);
    if (normalized) chats[chatId] = normalized;
  }
  return { version: 1, chats: pruned(chats) };
}

function isEmpty(entry: ChatTriageEntry): boolean {
  return entry.pinnedAt === undefined && entry.doneAt === undefined && entry.snoozedUntil === undefined;
}

/**
 * Keep the map bounded. Entries with nothing set go first (they only hold a
 * revision), then the least recently changed.
 */
function pruned(chats: Record<string, ChatTriageEntry>, keep?: string): Record<string, ChatTriageEntry> {
  const entries = Object.entries(chats);
  if (entries.length <= MAX_CHAT_TRIAGE_ENTRIES) return chats;
  entries.sort(([idA, a], [idB, b]) => {
    if (idA === keep) return -1;
    if (idB === keep) return 1;
    const emptyA = isEmpty(a) ? 1 : 0;
    const emptyB = isEmpty(b) ? 1 : 0;
    return emptyA - emptyB || b.updatedAt - a.updatedAt;
  });
  return Object.fromEntries(entries.slice(0, MAX_CHAT_TRIAGE_ENTRIES));
}

function copyEntry(entry: ChatTriageEntry): ChatTriageEntry {
  return { ...entry };
}

export interface ChatTriageStoreOptions {
  now?: () => number;
  onChange?: (snapshot: ChatTriageSnapshot) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ChatTriageStore {
  private readonly store: DataStore<ChatTriageFile>;
  private revision = 0;
  private timer: unknown = null;
  private started = false;

  constructor(
    root: () => string,
    private readonly options: ChatTriageStoreOptions = {},
  ) {
    this.store = new DataStore<ChatTriageFile>(
      "chat-triage.json",
      { version: 1, chats: {} },
      root,
      { normalize: normalizeFile, fileMode: 0o600, maxBytes: 2 * 1_024 * 1_024 },
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async snapshot(): Promise<ChatTriageSnapshot> {
    const file = await this.store.load();
    const chats: Record<string, ChatTriageEntry> = {};
    for (const [chatId, entry] of Object.entries(file.chats)) chats[chatId] = copyEntry(entry);
    return { revision: this.revision, chats };
  }

  async get(chatId: string): Promise<ChatTriageEntry | null> {
    const entry = (await this.store.load()).chats[chatId];
    return entry ? copyEntry(entry) : null;
  }

  /**
   * Apply one patch. Each field it names is set and the others are kept. With
   * `ifRevision`, the write lands only when the chat's triage revision still
   * matches (0 for a chat with no triage yet).
   */
  async set(chatId: string, patch: ChatTriagePatch, write: ChatTriageWrite = {}): Promise<ChatTriageResult> {
    if (!SAFE_CHAT_ID.test(chatId)) return { ok: false, code: "invalid" };
    const keys = Object.keys(patch);
    if (keys.length === 0) return { ok: false, code: "invalid" };
    const now = this.now();
    if (patch.snoozeUntil !== undefined && patch.snoozeUntil !== null) {
      if (!isTimestamp(patch.snoozeUntil) || patch.snoozeUntil <= 0 || patch.snoozeUntil > now + MAX_SNOOZE_AHEAD_MS) {
        return { ok: false, code: "invalid" };
      }
    }
    if (write.ifRevision !== undefined && !isTimestamp(write.ifRevision)) return { ok: false, code: "invalid" };
    let result: ChatTriageResult = { ok: false, code: "invalid" };
    await this.store.update((draft) => {
      const current = draft.chats[chatId];
      if (write.ifRevision !== undefined && write.ifRevision !== triageRevision(current)) {
        result = { ok: false, code: "revision_conflict", entry: current ? copyEntry(current) : null };
        return false;
      }
      const next: ChatTriageEntry = {
        ...(current ?? {}),
        revision: triageRevision(current) + 1,
        updatedAt: now,
      };
      if (patch.pinned === true) next.pinnedAt = current?.pinnedAt ?? now;
      else if (patch.pinned === false) delete next.pinnedAt;
      if (patch.done === true) next.doneAt = now;
      else if (patch.done === false) delete next.doneAt;
      if (typeof patch.snoozeUntil === "number" && patch.snoozeUntil > now) next.snoozedUntil = patch.snoozeUntil;
      else if (patch.snoozeUntil !== undefined) delete next.snoozedUntil;
      draft.chats = pruned({ ...draft.chats, [chatId]: next }, chatId);
      result = { ok: true, entry: copyEntry(next) };
      return true;
    });
    if (result.ok) {
      await this.publish();
      this.arm();
    }
    return result;
  }

  /**
   * Bring a snoozed chat back now, because it needs the person (an approval,
   * a question or a failure) or the person just wrote in it. Only the snooze
   * is cleared; Pin and Done stay. A chat that is not snoozed is left alone.
   */
  async wake(chatId: string): Promise<boolean> {
    if ((await this.store.load()).chats[chatId]?.snoozedUntil === undefined) return false;
    const now = this.now();
    const changed = await this.store.update((draft) => {
      const entry = draft.chats[chatId];
      if (!entry || entry.snoozedUntil === undefined) return false;
      const { snoozedUntil: _, ...rest } = entry;
      draft.chats[chatId] = { ...rest, revision: entry.revision + 1, updatedAt: now };
      return true;
    });
    if (changed) {
      await this.publish();
      this.arm();
    }
    return changed;
  }

  async remove(chatId: string): Promise<void> {
    if ((await this.store.load()).chats[chatId] === undefined) return;
    await this.store.update((draft) => {
      delete draft.chats[chatId];
    });
    await this.publish();
    this.arm();
  }

  /** Start the wake timer for the next snooze. Safe to call more than once. */
  async start(): Promise<void> {
    this.started = true;
    await this.expire();
  }

  /**
   * Clear every snooze that has passed and re-arm the timer now, for example
   * after the Mac wakes from sleep or unlocks, when a timer may have slept
   * through its time. Does nothing before `start()`.
   */
  async checkSnoozes(): Promise<void> {
    if (!this.started) return;
    await this.expire();
  }

  dispose(): void {
    this.started = false;
    this.clear();
  }

  /**
   * Clear every snooze that has passed, then arm the timer for the next one.
   * The timer is re-armed even when the clear fails, so one failed write never
   * stops later snoozes from waking.
   */
  private async expire(): Promise<void> {
    try {
      const now = this.now();
      const due = Object.entries((await this.store.load()).chats).some(
        ([, entry]) => entry.snoozedUntil !== undefined && entry.snoozedUntil <= now,
      );
      if (!due) return;
      const changed = await this.store.update((draft) => {
        let any = false;
        for (const [chatId, entry] of Object.entries(draft.chats)) {
          if (entry.snoozedUntil === undefined || entry.snoozedUntil > now) continue;
          const { snoozedUntil: _, ...rest } = entry;
          draft.chats[chatId] = { ...rest, revision: entry.revision + 1, updatedAt: now };
          any = true;
        }
        return any;
      });
      if (changed) await this.publish();
    } finally {
      this.arm();
    }
  }

  private clear(): void {
    if (this.timer === null) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.clear();
    if (!this.started) return;
    void this.store.load().then((file) => {
      let next: number | undefined;
      for (const entry of Object.values(file.chats)) {
        if (entry.snoozedUntil !== undefined && (next === undefined || entry.snoozedUntil < next)) {
          next = entry.snoozedUntil;
        }
      }
      if (next !== undefined) this.schedule(Math.max(next - this.now(), 0));
    }, () => {
      // An unreadable store retries on the next check rather than never.
      this.schedule(SNOOZE_WAKE_CHECK_MS);
    });
  }

  private schedule(delay: number): void {
    if (!this.started) return;
    this.clear();
    const set = this.options.setTimer ?? ((callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
    this.timer = set(() => {
      this.timer = null;
      void this.expire().catch(() => undefined);
    }, Math.min(delay, SNOOZE_WAKE_CHECK_MS));
  }

  private async publish(): Promise<void> {
    this.revision += 1;
    if (!this.options.onChange) return;
    this.options.onChange(await this.snapshot());
  }
}

/** Run states that need the person, so they bring a snoozed chat back early. */
const WAKING_RUN_STATES: ReadonlySet<string> = new Set(["needs_approval", "needs_input", "failed"]);

type AttentionRun = Pick<HostRunSummary, "runId" | "chatId" | "state" | "pendingApprovalIds" | "pendingQuestionIds">;

/**
 * Wake a snoozed chat as soon as one of its runs starts asking for an
 * approval or an answer, asks a new one, or fails. Any other notification
 * about a run that is already waiting (one of two approvals answered, a delta)
 * leaves a snooze the person set after the wait began. Returns the
 * unsubscribe function.
 */
export function wakeTriageOnAttention(
  runs: { onChange(listener: (summary: AttentionRun, removed: boolean) => void): () => void },
  triage: Pick<ChatTriageStore, "wake">,
): () => void {
  /** Each run's last state and the prompt ids it was already waiting on. */
  const seen = new Map<string, { state: string; prompts: ReadonlySet<string> }>();
  const stop = runs.onChange((summary, removed) => {
    if (removed) {
      seen.delete(summary.runId);
      return;
    }
    const before = seen.get(summary.runId);
    const prompts = new Set([...summary.pendingApprovalIds, ...summary.pendingQuestionIds]);
    seen.set(summary.runId, { state: summary.state, prompts });
    if (!WAKING_RUN_STATES.has(summary.state)) return;
    const entered = before?.state !== summary.state;
    const asked = [...prompts].some((id) => !before?.prompts.has(id));
    if (!entered && !asked) return;
    void triage.wake(summary.chatId).catch(() => undefined);
  });
  return () => {
    stop();
    seen.clear();
  };
}
