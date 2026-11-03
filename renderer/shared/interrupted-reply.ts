import {
  formatAskUserQuestionAnswers,
  type AskUserQuestionAnswerV1,
  type AskUserQuestionV1,
} from "./ask-user-question.js";

/** The visible turn Resume sends after a reply was cut short by a quit or crash. */
export const INTERRUPTED_REPLY_FOLLOW_UP = "Continue where you left off.";

/** A saved question or approval is offered for this long after the quit or crash. */
export const INTERRUPTED_WAIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Longest approval summary kept for the Resume card. */
export const INTERRUPTED_WAIT_MAX_SUMMARY_LENGTH = 300;

/**
 * What an interrupted reply was waiting on when Aiden quit or crashed. A
 * question is offered again and its answer starts a new turn; an approval is
 * only named, because approving an old command after a restart is unsafe.
 */
export type InterruptedWaitV1 =
  | { kind: "question"; waitId: string; askedAt: number; questions: AskUserQuestionV1[] }
  | { kind: "approval"; waitId: string; askedAt: number; summary: string };

/**
 * The message that carries answers to a question asked before a restart. The
 * tool call that asked it is gone, so the answers start a new turn, in the same
 * form the tool result uses (each question with its answer, or "Skipped").
 */
export function formatRecoveredAskUserQuestionAnswers(
  questions: readonly AskUserQuestionV1[],
  answers: readonly AskUserQuestionAnswerV1[],
): string {
  return `Answering the question you asked before Aiden restarted:\n\n${formatAskUserQuestionAnswers(questions, answers)}`;
}

/**
 * Whether a settled card stops being something a restart offers again. Only a
 * card the host withdrew while Aiden was quitting is kept: an answer, a denial,
 * an expiry, Stop or a closed window all leave the reply nothing to wait on.
 */
export function interruptedWaitSettled(input: {
  /** The person answered, allowed, denied or closed the card. */
  byPerson: boolean;
  timedOut?: boolean;
  quitting: boolean;
}): boolean {
  return input.byPerson || input.timedOut === true || !input.quitting;
}
