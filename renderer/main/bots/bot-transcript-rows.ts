// What a Bot chat shows, row by row, from the durable projection.
//
// A reply's turn starts at the person's message (or a routine, or their answer
// to a question) and ends at the next one. Everything the Bot writes is a
// bubble, including the narration it writes alongside tool calls (spec
// decision 9); tool steps themselves never become rows. With Summary or
// Detailed chat activity, a turn that used tools also gets one recap of its
// steps just above its answer; Detailed shows it, live, while the turn runs.
// A reply the person stopped ends with a "stopped" line that is derived here
// and never stored.

import { botRetryableFailedTurn, type BotQueuedMessage, type BotTranscriptEntry } from "../../shared/bot-live";
import type { BotChatActivityLevel } from "../../shared/bots";
import type { ConnectCardEntry } from "../../shared/bot-connections";
import type { BotRoutineProposalEntryData, BotRoutineProposalStatus } from "../../shared/bot-routine-proposals";
import { botSettleSteps, botStepFromCall, type BotRecapStep } from "./bot-activity-steps";

export interface BotTranscriptRowOptions {
  running: boolean;
  level: BotChatActivityLevel;
  /** Messages waiting for the running turn (a follow-up is faded; a steer reads as sent). */
  queued?: readonly BotQueuedMessage[];
}

export type BotTranscriptRow =
  | { kind: "user"; id: string; text: string }
  | { kind: "routine"; id: string; label: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  /** One turn's steps; `live` while the turn runs (Detailed only). */
  | { kind: "recap"; id: string; steps: BotRecapStep[]; durationMs: number; live: boolean }
  /** "You stopped this reply." */
  | { kind: "stopped"; id: string }
  /** A follow-up waiting for the running turn; shown faded with Remove. */
  | { kind: "queued"; id: string; submissionId: string; text: string }
  | { kind: "file"; id: string; path: string; operation: "written" | "edited" }
  | { kind: "image"; id: string; name: string; mimeType: string; size: number; data: string }
  | { kind: "notice"; id: string; notice: "interrupted" | "session_reset" }
  | { kind: "connect"; id: string; card: ConnectCardEntry }
  /** `retryText` is set only on the newest failed turn, when Retry applies. */
  | { kind: "failed"; id: string; retryText: string | null; errorMessage?: string }
  /** A quiet "Memory updated" caption. */
  | { kind: "memory_update"; id: string }
  | {
      kind: "routine_proposal";
      id: string;
      proposal: BotRoutineProposalEntryData;
      status: BotRoutineProposalStatus;
      routineId?: string;
    };

interface Turn {
  id: string;
  startAt?: number;
  lastAt?: number;
  /** Index of the turn's answer bubble in `rows`, once it has one. */
  answerRow: number | null;
  steps: BotRecapStep[];
  byCall: Map<string, BotRecapStep>;
  /** The person pressed Stop during this reply. */
  stopped: boolean;
  /** The app restarted mid-turn; a call with no result was cut short, not failed. */
  interrupted: boolean;
}

export function botTranscriptRows(
  entries: readonly BotTranscriptEntry[],
  partial: string | null,
  { running, level, queued }: BotTranscriptRowOptions,
): BotTranscriptRow[] {
  const rows: BotTranscriptRow[] = [];
  const retryable = running ? null : botRetryableFailedTurn(entries);
  // The current turn, once a message has started one.
  const state: { turn: Turn | null } = { turn: null };

  const endTurn = (live: boolean) => {
    const turn = state.turn;
    state.turn = null;
    if (!turn) return;
    const steps = turn.steps.filter((step) => step.kind !== "waiting");
    if (steps.length > 0 && (level === "detailed" || (level === "summary" && !live))) {
      const recap: BotTranscriptRow = {
        kind: "recap",
        id: `${turn.id}:recap`,
        steps: live ? steps : botSettleSteps(steps, turn.stopped || turn.interrupted),
        durationMs: Math.max(0, (turn.lastAt ?? 0) - (turn.startAt ?? turn.lastAt ?? 0)),
        live,
      };
      if (live || turn.answerRow === null) rows.push(recap);
      else rows.splice(turn.answerRow, 0, recap);
    }
    if (turn.stopped && !live) rows.push({ kind: "stopped", id: `${turn.id}:stopped` });
  };

  const beginTurn = (id: string, at: number | undefined) => {
    endTurn(false);
    state.turn = {
      id,
      ...(at === undefined ? {} : { startAt: at, lastAt: at }),
      answerRow: null,
      steps: [],
      byCall: new Map(),
      stopped: false,
      interrupted: false,
    };
  };

  // A person's Stop ends the run. If the run carries on after a stop marker, a
  // restart cut it short and Resume or a retry picked it up: no stopped line.
  const carriedOn = (turn: Turn) => {
    if (!turn.stopped) return;
    turn.stopped = false;
    turn.interrupted = true;
  };

  const touch = (at: number | undefined) => {
    if (state.turn && at !== undefined) state.turn.lastAt = at;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        // Every message starts a turn: a steer is placed after the round's tool results, so it never splits a step from its result.
        beginTurn(entry.id, entry.at);
        rows.push({ kind: "user", id: entry.id, text: entry.text });
        break;
      case "question_answer":
        beginTurn(entry.id, entry.at);
        rows.push({ kind: "user", id: entry.id, text: entry.text });
        break;
      case "routine":
        beginTurn(entry.id, entry.at);
        rows.push({ kind: "routine", id: entry.id, label: entry.label, text: entry.text });
        break;
      case "assistant": {
        // A reply with no visible input (the self-intro) still gets a turn.
        if (!state.turn) beginTurn(entry.id, entry.at);
        const turn = state.turn!;
        touch(entry.at);
        for (const call of entry.toolCalls) {
          const recapStep = botStepFromCall(call);
          turn.steps.push(recapStep);
          turn.byCall.set(call.id, recapStep);
        }
        if (entry.stopReason === "aborted") turn.stopped = true;
        else carriedOn(turn);
        if (entry.text.trim()) {
          if (entry.toolCalls.length === 0) turn.answerRow = rows.length;
          rows.push({ kind: "assistant", id: entry.id, text: entry.text });
        }
        break;
      }
      case "file":
        rows.push({ kind: "file", id: entry.id, path: entry.path, operation: entry.operation });
        break;
      case "shared_image":
        rows.push({ kind: "image", id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size, data: entry.data });
        break;
      case "notice":
        // A restart cut the turn short; the person did not stop it.
        if (entry.notice === "interrupted" && state.turn) {
          state.turn.stopped = false;
          state.turn.interrupted = true;
        }
        endTurn(false);
        rows.push({ kind: "notice", id: entry.id, notice: entry.notice });
        break;
      case "connect_card":
        rows.push({ kind: "connect", id: entry.id, card: entry.card });
        break;
      case "failed_turn":
        if (state.turn) carriedOn(state.turn);
        rows.push({
          kind: "failed",
          id: entry.id,
          retryText: retryable?.id === entry.id ? entry.retryText : null,
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        });
        break;
      case "memory_update":
        // Back-to-back saves read as one update.
        if (rows[rows.length - 1]?.kind !== "memory_update") rows.push({ kind: "memory_update", id: entry.id });
        break;
      case "routine_proposal":
        rows.push({
          kind: "routine_proposal",
          id: entry.id,
          proposal: entry.proposal,
          status: entry.status,
          ...(entry.routineId ? { routineId: entry.routineId } : {}),
        });
        break;
      case "tool_result": {
        touch(entry.at);
        const recapStep = state.turn?.byCall.get(entry.toolCallId);
        if (recapStep) recapStep.status = entry.status;
        // A Stop during a tool run writes only the round's results; no aborted reply follows.
        // A later "interrupted" notice still turns it back into a restart.
        if (entry.status === "stopped" && state.turn) state.turn.stopped = true;
        break;
      }
    }
  }

  endTurn(running);
  if (partial !== null && partial.trim()) {
    rows.push({ kind: "assistant", id: "partial", text: partial, ...(running ? { streaming: true } : {}) });
  }
  for (const message of queued ?? []) {
    const text = message.text.trim()
      ? message.text
      : message.imageCount === 1
        ? "Photo"
        : message.imageCount > 1
          ? `${message.imageCount} photos`
          : "";
    if (!text) continue;
    // A steer joins the running turn: it reads as sent right away.
    if (message.mode === "steer") rows.push({ kind: "user", id: `queued:${message.submissionId}`, text });
    else rows.push({ kind: "queued", id: `queued:${message.submissionId}`, submissionId: message.submissionId, text });
  }
  return rows;
}
