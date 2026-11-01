/**
 * Inbox triage (docs/plans/inbox-sidebar-plan.md, Phase 2a): Pin, Done and
 * Snooze, kept by the host that owns the chat so every surface paired to it
 * sees the same state. The store lives in main (`main/services/chat-triage.ts`);
 * this module holds the shapes and the pure rules both sides share.
 */

/** The most chats one host keeps triage for. Empty entries go first, then the oldest. */
export const MAX_CHAT_TRIAGE_ENTRIES = 5_000;
/** A snooze can reach at most this far ahead. */
export const MAX_SNOOZE_AHEAD_MS = 366 * 24 * 60 * 60 * 1_000;

export interface ChatTriageEntry {
  /** Starts at 1 and rises with every write to this chat. `ifRevision` checks it. */
  revision: number;
  updatedAt: number;
  pinnedAt?: number;
  doneAt?: number;
  snoozedUntil?: number;
}

export interface ChatTriageSnapshot {
  /** Rises with every change, so a renderer can drop an older answer. */
  revision: number;
  chats: Record<string, ChatTriageEntry>;
}

/**
 * One write. Each field present is set (last writer wins) and the others are
 * left alone. `snoozeUntil: null` wakes the chat.
 */
export interface ChatTriagePatch {
  pinned?: boolean;
  done?: boolean;
  snoozeUntil?: number | null;
}

export interface ChatTriageWrite {
  /** The chat's triage revision the writer last saw; 0 for a chat with none. */
  ifRevision?: number;
}

export type ChatTriageResult =
  | { ok: true; entry: ChatTriageEntry }
  | {
      ok: false;
      code: "revision_conflict";
      /** The entry the store holds; a paired host's refusal names only its revision, so it is `null` there. */
      entry: ChatTriageEntry | null;
      /** The revision the host holds, when its refusal says. */
      currentRevision?: number;
    }
  | { ok: false; code: "invalid" };

/** A chat with no triage reads as revision 0. */
export function triageRevision(entry: ChatTriageEntry | null | undefined): number {
  return entry?.revision ?? 0;
}

/** Whether a patch names at least one field and every value it names is well formed. */
export function isChatTriagePatch(value: unknown): value is ChatTriagePatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => key !== "pinned" && key !== "done" && key !== "snoozeUntil")) {
    return false;
  }
  if ("pinned" in record && typeof record.pinned !== "boolean") return false;
  if ("done" in record && typeof record.done !== "boolean") return false;
  if (
    "snoozeUntil" in record &&
    record.snoozeUntil !== null &&
    !(typeof record.snoozeUntil === "number" && Number.isSafeInteger(record.snoozeUntil) && record.snoozeUntil > 0)
  ) {
    return false;
  }
  return true;
}

/**
 * The patch that puts an entry's fields back as they were before `patch`, for
 * Undo. Only the fields `patch` named are restored.
 */
export function inverseTriagePatch(before: ChatTriageEntry | null | undefined, patch: ChatTriagePatch): ChatTriagePatch {
  const inverse: ChatTriagePatch = {};
  if (patch.pinned !== undefined) inverse.pinned = before?.pinnedAt !== undefined;
  if (patch.done !== undefined) inverse.done = before?.doneAt !== undefined;
  if (patch.snoozeUntil !== undefined) inverse.snoozeUntil = before?.snoozedUntil ?? null;
  return inverse;
}

export type SnoozePreset = "hour" | "evening" | "tomorrow" | "next_week";

export interface SnoozeOption {
  preset: SnoozePreset;
  label: string;
  /** Epoch ms, in the acting device's time zone. */
  until: number;
}

export const SNOOZE_PRESET_LABELS: Readonly<Record<SnoozePreset, string>> = {
  hour: "1 hour",
  evening: "This evening",
  tomorrow: "Tomorrow",
  next_week: "Next week",
};

function atLocal(base: Date, dayOffset: number, hour: number): number {
  const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
  return at.getTime();
}

const SNOOZE_HOUR_MS = 60 * 60 * 1_000;

/**
 * The snooze presets as absolute times on this device's clock, earliest
 * first: 1 hour from now; this evening at 18:00, left out unless it is more
 * than an hour away (so it never lands at or before "1 hour"); tomorrow at
 * 09:00; and next week's Monday at 09:00, at least two days away so it never
 * repeats Tomorrow (on a Sunday it is the Monday after tomorrow).
 */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const hour = now.getTime() + SNOOZE_HOUR_MS;
  const options: SnoozeOption[] = [{ preset: "hour", label: SNOOZE_PRESET_LABELS.hour, until: hour }];
  const evening = atLocal(now, 0, 18);
  if (evening > hour) options.push({ preset: "evening", label: SNOOZE_PRESET_LABELS.evening, until: evening });
  options.push({ preset: "tomorrow", label: SNOOZE_PRESET_LABELS.tomorrow, until: atLocal(now, 1, 9) });
  // Monday is day 1. The next Monday strictly after tomorrow.
  const nextMonday = ((8 - now.getDay()) % 7) || 7;
  const daysToMonday = nextMonday < 2 ? nextMonday + 7 : nextMonday;
  options.push({ preset: "next_week", label: SNOOZE_PRESET_LABELS.next_week, until: atLocal(now, daysToMonday, 9) });
  return options;
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Read a triage snapshot from IPC, dropping anything malformed. */
export function parseChatTriageSnapshot(value: unknown): ChatTriageSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isWhole(record.revision)) return null;
  const raw = record.chats;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const chats: Record<string, ChatTriageEntry> = {};
  for (const [chatId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    if (!isWhole(fields.revision) || !isWhole(fields.updatedAt)) continue;
    const parsed: ChatTriageEntry = { revision: fields.revision, updatedAt: fields.updatedAt };
    if (isWhole(fields.pinnedAt)) parsed.pinnedAt = fields.pinnedAt;
    if (isWhole(fields.doneAt)) parsed.doneAt = fields.doneAt;
    if (isWhole(fields.snoozedUntil)) parsed.snoozedUntil = fields.snoozedUntil;
    chats[chatId] = parsed;
  }
  return { revision: record.revision, chats };
}
