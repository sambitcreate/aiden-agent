import type { PeerRunEvent, PeerRunStreamState } from "./peer-host";
import { isSafeSubagentIdentifier } from "./subagent-runs";

/**
 * This Mac's renderer mirroring a run its own process hosts (one a paired
 * phone, another window or a headless caller started). The wire vocabulary is
 * the Remote run stream's, so the same translator folds both.
 */

/** Notification channel carrying batched frames to the one subscribing document. */
export const LOCAL_RUN_FRAME_CHANNEL = "runs:local-frame" as const;

/** Where a re-subscribing observer left off; ignored once the chat has moved to another run. */
export interface LocalRunCursor {
  runId: string;
  sequence: number;
}

export type LocalRunFrame =
  | { kind: "event"; event: PeerRunEvent }
  | { kind: "state"; runId: string | null; state: PeerRunStreamState };

/** Every frame of one ~16ms batch, in journal order. */
export interface LocalRunFrameMessage {
  subscriptionId: string;
  chatId: string;
  frames: LocalRunFrame[];
}

/** `undefined` for no cursor; throws for anything malformed. */
export function parseLocalRunCursor(value: unknown): LocalRunCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid run cursor.");
  const { runId, sequence } = value as Record<string, unknown>;
  if (!isSafeSubagentIdentifier(runId) || !Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw new Error("Invalid run cursor.");
  }
  return { runId, sequence: sequence as number };
}
