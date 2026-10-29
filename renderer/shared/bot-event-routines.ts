// The renderer's view of a Bot event routine (no token hash, no bookkeeping).

import type { BotRoutineTrigger } from "./bot-routine-trigger.js";

/** What the last check of a watch found; `error` is a failed check, never a change. */
export type BotWatchResult = "baseline" | "no_change" | "changed" | "error";

/** A watch's status for its row: no hash and no saved output. */
export interface BotWatchStatusView {
  lastCheckAt?: number;
  nextCheckAt?: number;
  /** When the output last changed (or the baseline was taken). */
  sameSince?: number;
  lastResult?: BotWatchResult;
  /** Failed checks in a row; a success resets it. */
  failures: number;
  /** Why the last check failed, in words for the person. */
  lastError?: string;
}

export interface BotEventRoutineView {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  trigger: BotRoutineTrigger;
  enabled: boolean;
  lastRunAt?: number;
  /** Watch routines only. */
  watch?: BotWatchStatusView;
}
