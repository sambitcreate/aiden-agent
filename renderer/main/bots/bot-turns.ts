// One reading of a Bot transcript as turns, shared by the chat's rows and the
// side panel's Activity log, so the two never disagree on when a reply was
// stopped, cut short by a restart, or carried on.
//
// A turn starts at the person's message, their answer to a question, or a
// routine, and ends at the next one or at a notice. A reply with no visible
// input before it (the self-intro) starts its own turn. Tool calls become
// steps whose status their results fill in.

import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botStepFromCall, type BotRecapStep } from "./bot-activity-steps";

type BotTurnStart = Extract<BotTranscriptEntry, { type: "user" | "question_answer" | "routine" | "assistant" }>;

export interface BotTurn {
  /** The entry that started the turn. */
  start: BotTurnStart;
  startAt?: number;
  /** The newest time seen in the turn (its replies and tool results). */
  lastAt?: number;
  /** Every tool call's step, in the order they ran, including questions to the person. */
  steps: BotRecapStep[];
  /** The person pressed Stop during this turn. */
  stopped: boolean;
  /** The app restarted mid-turn; a call with no result was cut short, not failed. */
  interrupted: boolean;
}

interface BotTurnVisitor {
  /** The turn is over: the next one started, a notice closed it, or the transcript ended (`live` then says it still runs). */
  end(turn: BotTurn, live: boolean): void;
  /** Every entry, in order, once the turn bookkeeping for it is done; `turn` is the open turn, if any. */
  entry?(entry: BotTranscriptEntry, turn: BotTurn | null): void;
}

const startsTurn = (entry: BotTranscriptEntry): entry is Extract<BotTurnStart, { type: "user" | "question_answer" | "routine" }> =>
  entry.type === "user" || entry.type === "question_answer" || entry.type === "routine";

/** Walks `entries` as turns; the turn still open at the end is live when `running`. */
export function walkBotTurns(entries: readonly BotTranscriptEntry[], running: boolean, visitor: BotTurnVisitor): void {
  // Held in an object so the closures below do not narrow it to `never`.
  const state: { turn: BotTurn | null } = { turn: null };
  const byCall = new Map<string, BotRecapStep>();

  const begin = (entry: BotTurnStart): BotTurn => {
    if (state.turn) visitor.end(state.turn, false);
    byCall.clear();
    state.turn = {
      start: entry,
      ...(entry.at === undefined ? {} : { startAt: entry.at, lastAt: entry.at }),
      steps: [],
      stopped: false,
      interrupted: false,
    };
    return state.turn;
  };

  const touch = (at: number | undefined) => {
    if (state.turn && at !== undefined) state.turn.lastAt = at;
  };

  // A person's Stop ends the run. If the run carries on after a stop marker, a
  // restart cut it short and Resume or a retry picked it up: not stopped.
  const carriedOn = (turn: BotTurn) => {
    if (!turn.stopped) return;
    turn.stopped = false;
    turn.interrupted = true;
  };

  for (const entry of entries) {
    if (startsTurn(entry)) begin(entry);
    switch (entry.type) {
      case "assistant": {
        const turn = state.turn ?? begin(entry);
        touch(entry.at);
        for (const call of entry.toolCalls) {
          const step = botStepFromCall(call);
          turn.steps.push(step);
          byCall.set(call.id, step);
        }
        if (entry.stopReason === "aborted") turn.stopped = true;
        else carriedOn(turn);
        break;
      }
      case "tool_result": {
        touch(entry.at);
        const step = byCall.get(entry.toolCallId);
        if (step) step.status = entry.status;
        // A Stop during a tool run writes only the round's results; no aborted reply follows.
        // A later "interrupted" notice still turns it back into a restart.
        if (entry.status === "stopped" && state.turn) state.turn.stopped = true;
        break;
      }
      case "notice": {
        const turn = state.turn;
        if (turn) {
          // A restart cut the turn short; the person did not stop it.
          if (entry.notice === "interrupted") {
            turn.stopped = false;
            turn.interrupted = true;
          }
          visitor.end(turn, false);
        }
        state.turn = null;
        byCall.clear();
        break;
      }
      case "failed_turn":
        if (state.turn) carriedOn(state.turn);
        break;
      default:
        break;
    }
    visitor.entry?.(entry, state.turn);
  }
  if (state.turn) visitor.end(state.turn, running);
}
