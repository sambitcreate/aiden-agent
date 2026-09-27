export const ASK_USER_QUESTION_VERSION = 1 as const;
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question" as const;
export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;
export const ASK_USER_MAX_HEADER_LENGTH = 16;
export const ASK_USER_MAX_LABEL_LENGTH = 60;
export const ASK_USER_MAX_QUESTION_LENGTH = 1_000;
export const ASK_USER_MAX_DESCRIPTION_LENGTH = 2_000;
export const ASK_USER_MAX_CUSTOM_ANSWER_LENGTH = 4_000;
/** Shortest wait the agent may request before continuing without an answer. */
export const ASK_USER_MIN_TIMEOUT_SECONDS = 30;
/** Longest wait the agent may request; attended desktop chats default to no deadline. */
export const ASK_USER_MAX_TIMEOUT_SECONDS = 60 * 60;
/**
 * Unattended owners (a paired phone that may have gone away) always carry a
 * deadline, and never a longer one. It matches the Remote v1 question
 * lifetime so the wire `expiresAt` and the agent-facing deadline coincide.
 */
export const ASK_USER_UNATTENDED_TIMEOUT_SECONDS = 5 * 60;
const RESERVED_OPTION_LABELS = new Set(["Other", "Type something.", "Next"]);

export interface AskUserQuestionOptionV1 {
  label: string;
  description: string;
}

export interface AskUserQuestionV1 {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOptionV1[];
}

export interface AskUserQuestionPromptV1 {
  version: typeof ASK_USER_QUESTION_VERSION;
  promptId: string;
  streamId: string;
  toolCallId: string;
  questions: AskUserQuestionV1[];
  /**
   * RFC 3339 instant after which the agent stops waiting and continues with
   * its best judgement. Absent when the prompt waits for its owner.
   */
  expiresAt?: string;
}

export type AskUserQuestionAnswerV1 =
  | { questionIndex: number; kind: "option"; answer: string }
  | { questionIndex: number; kind: "custom"; answer: string }
  | { questionIndex: number; kind: "multi"; selected: string[] };

export interface AskUserQuestionResponseV1 {
  version: typeof ASK_USER_QUESTION_VERSION;
  promptId: string;
  cancelled: boolean;
  answers: AskUserQuestionAnswerV1[];
  /**
   * Main-owned only: the deadline passed without an answer. The response
   * parser never copies it, so a renderer or Remote client cannot forge one.
   * Timed-out responses are also `cancelled` so consumers that only know the
   * cancel path (the advisor picker) fall back to their default.
   */
  timedOut?: true;
}

/** Outcome of an owner's answer attempt, reported back to the answering surface. */
export type AskUserQuestionAnswerStatus = "answered" | "expired";

/**
 * Clamp an agent-requested wait into the supported window. A missing or
 * non-numeric request returns undefined so the owner default applies.
 */
export function normalizeAskUserTimeoutSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(
    ASK_USER_MAX_TIMEOUT_SECONDS,
    Math.max(ASK_USER_MIN_TIMEOUT_SECONDS, Math.round(value)),
  );
}

/**
 * Milliseconds until the agent stops waiting (0 once expired), or undefined
 * for a prompt that waits for its owner indefinitely.
 */
export function askUserQuestionMsUntilExpiry(
  prompt: Pick<AskUserQuestionPromptV1, "expiresAt">,
  now: number,
): number | undefined {
  if (!prompt.expiresAt) return undefined;
  const deadline = Date.parse(prompt.expiresAt);
  if (!Number.isFinite(deadline)) return undefined;
  return Math.max(0, deadline - now);
}

function parseInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const normalized = new Date(time).toISOString();
  return normalized === value ? normalized : undefined;
}

/**
 * Plain-text rendering of an owner's answers, shared by the agent tool result
 * and the late-reply follow-up message.
 */
export function formatAskUserQuestionAnswers(
  questions: readonly AskUserQuestionV1[],
  answers: readonly AskUserQuestionAnswerV1[],
): string {
  const byIndex = new Map(answers.map((answer) => [answer.questionIndex, answer]));
  return questions
    .map((question, index) => {
      const answer = byIndex.get(index);
      if (!answer) return `${index + 1}. ${question.question}\nAnswer: Skipped`;
      if (answer.kind === "multi") {
        return `${index + 1}. ${question.question}\nAnswer: ${answer.selected.join(", ")}`;
      }
      return `${index + 1}. ${question.question}\nAnswer: ${answer.answer}`;
    })
    .join("\n\n");
}

/**
 * Follow-up chat message for answers that arrived after the agent stopped
 * waiting. Returns undefined when nothing was answered, so there is nothing
 * worth sending.
 */
export function formatLateAskUserQuestionFollowUp(
  questions: readonly AskUserQuestionV1[],
  answers: readonly AskUserQuestionAnswerV1[],
): string | undefined {
  if (answers.length === 0) return undefined;
  return `Answering your earlier question, which expired before I replied:\n\n${formatAskUserQuestionAnswers(questions, answers)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maximum) return undefined;
  return normalized;
}

function safeIdentifier(value: unknown, prefix?: string): value is string {
  return (
    typeof value === "string" &&
    (!prefix || value.startsWith(prefix)) &&
    value.length <= 128 &&
    /^[a-z0-9._:-]+$/iu.test(value)
  );
}

export function parseAskUserQuestions(value: unknown): AskUserQuestionV1[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > ASK_USER_MAX_QUESTIONS) {
    return undefined;
  }
  const questions: AskUserQuestionV1[] = [];
  const seenQuestions = new Set<string>();
  for (const candidate of value) {
    const input = record(candidate);
    const question = boundedString(input?.question, ASK_USER_MAX_QUESTION_LENGTH);
    const header = boundedString(input?.header, ASK_USER_MAX_HEADER_LENGTH);
    if (!input || !question || !header || seenQuestions.has(question)) return undefined;
    if (
      !Array.isArray(input.options) ||
      input.options.length < ASK_USER_MIN_OPTIONS ||
      input.options.length > ASK_USER_MAX_OPTIONS
    ) {
      return undefined;
    }
    const labels = new Set<string>();
    const options: AskUserQuestionOptionV1[] = [];
    for (const candidateOption of input.options) {
      const option = record(candidateOption);
      const label = boundedString(option?.label, ASK_USER_MAX_LABEL_LENGTH);
      const description = boundedString(option?.description, ASK_USER_MAX_DESCRIPTION_LENGTH);
      if (
        !option ||
        !label ||
        !description ||
        labels.has(label) ||
        RESERVED_OPTION_LABELS.has(label)
      ) {
        return undefined;
      }
      labels.add(label);
      options.push({ label, description });
    }
    seenQuestions.add(question);
    questions.push({
      question,
      header,
      multiSelect: input.multiSelect === true,
      options,
    });
  }
  return questions;
}

export function parseAskUserQuestionPrompt(value: unknown): AskUserQuestionPromptV1 | undefined {
  const input = record(value);
  if (
    !input ||
    input.version !== ASK_USER_QUESTION_VERSION ||
    !safeIdentifier(input.promptId, "q-") ||
    !safeIdentifier(input.streamId, "s-") ||
    !safeIdentifier(input.toolCallId)
  ) {
    return undefined;
  }
  const questions = parseAskUserQuestions(input.questions);
  if (!questions) return undefined;
  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined) {
    expiresAt = parseInstant(input.expiresAt);
    if (!expiresAt) return undefined;
  }
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId: input.promptId,
    streamId: input.streamId,
    toolCallId: input.toolCallId,
    questions,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function parseAskUserQuestionResponse(
  value: unknown,
  prompt: AskUserQuestionPromptV1,
): AskUserQuestionResponseV1 | undefined {
  const input = record(value);
  if (
    !input ||
    input.version !== ASK_USER_QUESTION_VERSION ||
    input.promptId !== prompt.promptId ||
    typeof input.cancelled !== "boolean" ||
    !Array.isArray(input.answers) ||
    input.answers.length > prompt.questions.length
  ) {
    return undefined;
  }
  const answers: AskUserQuestionAnswerV1[] = [];
  const seen = new Set<number>();
  for (const candidate of input.answers) {
    const answer = record(candidate);
    if (!answer || !Number.isSafeInteger(answer.questionIndex)) return undefined;
    const questionIndex = answer.questionIndex as number;
    const question = prompt.questions[questionIndex];
    if (!question || seen.has(questionIndex)) return undefined;
    seen.add(questionIndex);
    if (answer.kind === "option" && !question.multiSelect) {
      const selected = boundedString(answer.answer, ASK_USER_MAX_LABEL_LENGTH);
      if (!selected || !question.options.some((option) => option.label === selected)) {
        return undefined;
      }
      answers.push({ questionIndex, kind: "option", answer: selected });
      continue;
    }
    if (answer.kind === "custom") {
      const custom = boundedString(answer.answer, ASK_USER_MAX_CUSTOM_ANSWER_LENGTH);
      if (!custom) return undefined;
      answers.push({ questionIndex, kind: "custom", answer: custom });
      continue;
    }
    if (answer.kind === "multi" && question.multiSelect && Array.isArray(answer.selected)) {
      const selected = answer.selected.filter(
        (label): label is string =>
          typeof label === "string" && question.options.some((option) => option.label === label),
      );
      if (selected.length < 1 || selected.length !== answer.selected.length) return undefined;
      if (new Set(selected).size !== selected.length) return undefined;
      answers.push({ questionIndex, kind: "multi", selected });
      continue;
    }
    return undefined;
  }
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId: prompt.promptId,
    cancelled: input.cancelled,
    answers,
  };
}
