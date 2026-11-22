// Keep this computer awake while Aiden works (docs/plans/proactive-aiden-plan.md, C1).
// Shared by the main process (which holds the power-save blocker) and the
// Settings → Scheduled tasks row that shows what is holding it.

/** Main → windows: the keep-awake status changed. Payload: `KeepAwakeStatus`. */
export const KEEP_AWAKE_CHANGED_CHANNEL = "schedule:keep-awake-changed";

/**
 * What can hold the computer awake. `check-back` and `wake-up` are a chat's
 * check-back or a Bot's wake-up due within the hour, on AC power only. Later
 * inputs (goals) add their own kind and label here.
 */
export const KEEP_AWAKE_REASON_KINDS = ["chat", "job", "check", "usage-limit", "check-back", "wake-up"] as const;
export type KeepAwakeReasonKind = (typeof KEEP_AWAKE_REASON_KINDS)[number];

export interface KeepAwakeStatus {
  /** This host can keep itself awake (macOS and Linux). */
  supported: boolean;
  /** Settings → Scheduled tasks → Keep this computer awake while Aiden works. */
  enabled: boolean;
  /** A power-save blocker is held right now. */
  holding: boolean;
  /** Work is running, but nobody has used the computer for 4 hours, so the hold let go. */
  pausedWhileIdle: boolean;
  /** How many distinct things of each kind are holding it now. */
  counts: Partial<Record<KeepAwakeReasonKind, number>>;
}

export const KEEP_AWAKE_UNSUPPORTED: KeepAwakeStatus = Object.freeze({
  supported: false,
  enabled: false,
  holding: false,
  pausedWhileIdle: false,
  counts: Object.freeze({}),
});

export function parseKeepAwakeStatus(value: unknown): KeepAwakeStatus {
  if (typeof value !== "object" || value === null) return KEEP_AWAKE_UNSUPPORTED;
  const record = value as Record<string, unknown>;
  const rawCounts = typeof record.counts === "object" && record.counts !== null
    ? record.counts as Record<string, unknown>
    : {};
  const counts: Partial<Record<KeepAwakeReasonKind, number>> = {};
  for (const kind of KEEP_AWAKE_REASON_KINDS) {
    const count = rawCounts[kind];
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) counts[kind] = count;
  }
  return {
    supported: record.supported === true,
    enabled: record.enabled === true,
    holding: record.holding === true,
    pausedWhileIdle: record.pausedWhileIdle === true,
    counts,
  };
}

const REASON_LABELS: Readonly<Record<KeepAwakeReasonKind, readonly [one: string, many: string]>> = {
  chat: ["chat working", "chats working"],
  job: ["background job running", "background jobs running"],
  check: ["check running", "checks running"],
  "usage-limit": ["usage limit ending soon", "usage limits ending soon"],
  "check-back": ["check-back due soon", "check-backs due soon"],
  "wake-up": ["Bot wake-up due soon", "Bot wake-ups due soon"],
};

/** The live line under the Settings row, or null where the host can't keep awake. */
export function keepAwakeStatusLine(status: KeepAwakeStatus): string | null {
  if (!status.supported) return null;
  if (!status.enabled) return "Off: this computer sleeps as usual";
  if (status.pausedWhileIdle) return "Paused: nobody has used this computer for 4 hours";
  const parts = KEEP_AWAKE_REASON_KINDS.flatMap((kind) => {
    const count = status.counts[kind] ?? 0;
    if (count <= 0) return [];
    const [one, many] = REASON_LABELS[kind];
    return [`${count} ${count === 1 ? one : many}`];
  });
  if (parts.length > 0) return `Keeping awake: ${parts.join(", ")}`;
  if (status.holding) return "Keeping awake for one more minute";
  return "Not needed right now";
}
