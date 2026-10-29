import type { AskUserQuestionAnswerV1, AskUserQuestionV1 } from "./ask-user-question.js";

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
 * tool call that asked it is gone, so the answers start a new turn, each beside
 * its question. Skipped questions are left out; undefined when none was answered.
 */
export function formatRecoveredAskUserQuestionAnswers(
  questions: readonly AskUserQuestionV1[],
  answers: readonly AskUserQuestionAnswerV1[],
): string | undefined {
  const byIndex = new Map(answers.map((answer) => [answer.questionIndex, answer]));
  const lines = questions.flatMap((question, index) => {
    const answer = byIndex.get(index);
    if (!answer) return [];
    const text = answer.kind === "multi" ? answer.selected.join(", ") : answer.answer;
    return [`${question.question}\nAnswer: ${text}`];
  });
  if (lines.length === 0) return undefined;
  return `Answering the question you asked before Aiden restarted:\n\n${lines.join("\n\n")}`;
}
