// What a Bot chat shows, row by row, from the durable projection.
//
// A reply's turn starts at the person's message (or a routine, or their answer
// to a question or a hand-off card) and ends at the next one. Everything the Bot writes is a
// bubble, including the narration it writes alongside tool calls (spec
// decision 9); tool steps themselves never become rows. With Summary or
// Detailed chat activity, a turn that used tools also gets one recap of its
// steps just above its answer; Detailed shows it, live, while the turn runs.
// A reply the person stopped ends with a "stopped" line that is derived here
// and never stored.

import { botRetryableFailedTurn, type BotQueuedMessage, type BotTranscriptEntry } from "../../shared/bot-live";
import { botHandoffResultLine, type BotHandoffOutcome } from "../../shared/bot-handoffs";
import type { BotChatActivityLevel } from "../../shared/bots";
import type { ConnectCardEntry } from "../../shared/bot-connections";
import type { BotRoutineProposalEntryData, BotRoutineProposalStatus } from "../../shared/bot-routine-proposals";
import { botSettleSteps, type BotRecapStep } from "./bot-activity-steps";
import { walkBotTurns, type BotTurn } from "./bot-turns";

export interface BotTranscriptRowOptions {
  running: boolean;
  level: BotChatActivityLevel;
  /** Messages waiting for the running turn (a follow-up is faded; a steer reads as sent). */
  queued?: readonly BotQueuedMessage[];
}

export type BotTranscriptRow =
  | { kind: "user"; id: string; text: string }
  /** The person's answer to a hand-off card, on their side: "You did this: …" with their note below. */
  | { kind: "handoff_result"; id: string; outcome: BotHandoffOutcome; signedIn: boolean; text: string; note?: string }
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
    }
  /** Routines that fired while the person had paused the Bot, each with Run now. */
  | {
      kind: "routines_skipped";
      id: string;
      since: number;
      routines: { routineId: string; name: string; count: number }[];
    };

export function botTranscriptRows(
  entries: readonly BotTranscriptEntry[],
  partial: string | null,
  { running, level, queued }: BotTranscriptRowOptions,
): BotTranscriptRow[] {
  const rows: BotTranscriptRow[] = [];
  const retryable = running ? null : botRetryableFailedTurn(entries);
  /** Index of each turn's answer bubble in `rows`, once it has one. */
  const answerRows = new Map<BotTurn, number>();

  walkBotTurns(entries, running, {
    end(turn, live) {
      const steps = turn.steps.filter((step) => step.kind !== "waiting");
      if (steps.length > 0 && (level === "detailed" || (level === "summary" && !live))) {
        const recap: BotTranscriptRow = {
          kind: "recap",
          id: `${turn.start.id}:recap`,
          steps: live ? steps : botSettleSteps(steps, turn.stopped || turn.interrupted),
          durationMs: Math.max(0, (turn.lastAt ?? 0) - (turn.startAt ?? turn.lastAt ?? 0)),
          live,
        };
        const answerRow = answerRows.get(turn);
        if (live || answerRow === undefined) rows.push(recap);
        else rows.splice(answerRow, 0, recap);
      }
      if (turn.stopped && !live) rows.push({ kind: "stopped", id: `${turn.start.id}:stopped` });
    },
    entry(entry, turn) {
      switch (entry.type) {
        case "user":
        case "question_answer":
          // Every message starts a turn: a steer is placed after the round's tool results, so it never splits a step from its result.
          rows.push({ kind: "user", id: entry.id, text: entry.text });
          break;
        case "handoff_result":
          rows.push({
            kind: "handoff_result",
            id: entry.id,
            outcome: entry.outcome,
            signedIn: entry.kind === "sign_in" && entry.outcome === "done",
            text: botHandoffResultLine(entry),
            ...(entry.note ? { note: entry.note } : {}),
          });
          break;
        case "routine":
          rows.push({ kind: "routine", id: entry.id, label: entry.label, text: entry.text });
          break;
        case "assistant":
          if (entry.text.trim()) {
            if (entry.toolCalls.length === 0 && turn) answerRows.set(turn, rows.length);
            rows.push({ kind: "assistant", id: entry.id, text: entry.text });
          }
          break;
        case "file":
          rows.push({ kind: "file", id: entry.id, path: entry.path, operation: entry.operation });
          break;
        case "shared_image":
          rows.push({ kind: "image", id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size, data: entry.data });
          break;
        case "notice":
          rows.push({ kind: "notice", id: entry.id, notice: entry.notice });
          break;
        case "connect_card":
          rows.push({ kind: "connect", id: entry.id, card: entry.card });
          break;
        case "failed_turn":
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
        case "routines_skipped":
          rows.push({ kind: "routines_skipped", id: entry.id, since: entry.since, routines: entry.routines });
          break;
        case "tool_result":
          break;
      }
    },
  });
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
