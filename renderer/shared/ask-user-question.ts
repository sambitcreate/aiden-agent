export const ASK_USER_QUESTION_VERSION = 1 as const;
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question" as const;
export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 5;
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

/** Keep an already-expired prompt available so its owner can turn a late answer into a follow-up. */
export function retainExpiredAskUserQuestionForLateAnswer(
  prompt: AskUserQuestionPromptV1 | null | undefined,
  now = Date.now(),
): AskUserQuestionPromptV1 | null {
  return prompt && askUserQuestionMsUntilExpiry(prompt, now) === 0 ? prompt : null;
}

function parseInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const normalized = new Date(time).toISOString();
  return normalized === value ? normalized : undefined;
}

/**
 * The agent marks the option it recommends by ending its label with
 * "(Recommended)". The label itself stays the answer's wire identity; cards
 * show the text before the marker with a separate tag, and preselect it.
 */
const RECOMMENDED_LABEL_SUFFIX = /\s*\(recommended\)$/iu;

export function parseRecommendedOptionLabel(label: string): { text: string; recommended: boolean } {
  const text = label.replace(RECOMMENDED_LABEL_SUFFIX, "");
  return text && text !== label ? { text, recommended: true } : { text: label, recommended: false };
}

/** An option label as the person reads it: without the "(Recommended)" marker. */
export function askUserOptionDisplayLabel(label: string): string {
  return parseRecommendedOptionLabel(label).text;
}

/**
 * The starting answer for a question whose options carry the recommended
 * marker: the first marked option of a single choice, or every marked option
 * of a multi-select. Undefined when nothing is marked.
 */
export function recommendedAskUserAnswer(
  question: AskUserQuestionV1,
  questionIndex: number,
): AskUserQuestionAnswerV1 | undefined {
  const marked = question.options
    .map((option) => option.label)
    .filter((label) => parseRecommendedOptionLabel(label).recommended);
  if (marked.length === 0) return undefined;
  return question.multiSelect
    ? { questionIndex, kind: "multi", selected: marked }
    : { questionIndex, kind: "option", answer: marked[0]! };
}

/** Starting answers for a whole questionnaire, keyed by question index. */
export function recommendedAskUserAnswers(
  questions: readonly AskUserQuestionV1[],
): Map<number, AskUserQuestionAnswerV1> {
  const answers = new Map<number, AskUserQuestionAnswerV1>();
  questions.forEach((question, index) => {
    const answer = recommendedAskUserAnswer(question, index);
    if (answer) answers.set(index, answer);
  });
  return answers;
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
 * What the person chose, as they would say it: the bare answer for one
 * question, one `Header: answer` line per question otherwise, and "Skipped"
 * for a closed card or an unanswered question. Shown as the person's reply in
 * Bot chats; the model reads `formatAskUserQuestionAnswers` instead.
 */
export function summarizeAskUserQuestionResponse(
  questions: readonly AskUserQuestionV1[],
  response: Pick<AskUserQuestionResponseV1, "cancelled" | "answers">,
): string {
  if (response.cancelled) return "Skipped";
  const byIndex = new Map(response.answers.map((answer) => [answer.questionIndex, answer]));
  const answerText = (index: number) => {
    const answer = byIndex.get(index);
    if (!answer) return "Skipped";
    if (answer.kind === "multi") return answer.selected.map(askUserOptionDisplayLabel).join(", ");
    return answer.kind === "option" ? askUserOptionDisplayLabel(answer.answer) : answer.answer;
  };
  if (questions.length === 1) return answerText(0);
  return questions.map((question, index) => `${question.header}: ${answerText(index)}`).join("\n");
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

/** Longest custom answer a transcript recap keeps; the model still receives the full text. */
export const ASK_USER_RECAP_MAX_CUSTOM_LENGTH = 1_000;

/**
 * One question and what became of it, as shown in the transcript after the
 * card closes. `answers` holds one option label, one or more labels for a
 * multi-select, one custom text, or nothing for a skipped question.
 */
export interface AskUserQuestionRecapItemV1 {
  question: string;
  header: string;
  kind: "option" | "multi" | "custom" | "skipped";
  answers: string[];
}

/**
 * Renderer-safe record of a settled questionnaire, carried on its timeline
 * step. `dismissed` means the owner closed the card; `expired` means the
 * agent stopped waiting. Both leave every item skipped.
 */
export interface AskUserQuestionRecapV1 {
  version: typeof ASK_USER_QUESTION_VERSION;
  outcome: "answered" | "dismissed" | "expired";
  items: AskUserQuestionRecapItemV1[];
}

const RECAP_OUTCOMES = new Set<AskUserQuestionRecapV1["outcome"]>([
  "answered",
  "dismissed",
  "expired",
]);

function clipRecapText(value: string, maximum: number): string {
  const characters = Array.from(value);
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

/** C0 controls other than tab and newline, plus DEL, never reach the transcript. */
function isUnsafeControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code < 32 && code !== 9 && code !== 10) || code === 127;
}

function stripUnsafeControls(value: string): string {
  return Array.from(value)
    .map((character) => (isUnsafeControl(character) ? " " : character))
    .join("");
}

/**
 * Build the transcript recap from the main-owned response, including its
 * timeout flag. Returns undefined when the result would not pass
 * `parseAskUserQuestionRecap`, so a stored timeline never carries one that
 * replay would reject.
 */
export function buildAskUserQuestionRecap(
  questions: readonly AskUserQuestionV1[],
  response: Pick<AskUserQuestionResponseV1, "cancelled" | "answers" | "timedOut">,
): AskUserQuestionRecapV1 | undefined {
  const outcome = response.timedOut ? "expired" : response.cancelled ? "dismissed" : "answered";
  const byIndex = new Map(
    outcome === "answered" ? response.answers.map((answer) => [answer.questionIndex, answer]) : [],
  );
  return parseAskUserQuestionRecap({
    version: ASK_USER_QUESTION_VERSION,
    outcome,
    items: questions.map((question, index): AskUserQuestionRecapItemV1 => {
      const base = {
        question: stripUnsafeControls(question.question),
        header: stripUnsafeControls(question.header),
      };
      const answer = byIndex.get(index);
      if (!answer) return { ...base, kind: "skipped", answers: [] };
      if (answer.kind === "multi") {
        return { ...base, kind: "multi", answers: answer.selected.map(askUserOptionDisplayLabel) };
      }
      if (answer.kind === "custom") {
        const text = stripUnsafeControls(answer.answer);
        return {
          ...base,
          kind: "custom",
          answers: [clipRecapText(text, ASK_USER_RECAP_MAX_CUSTOM_LENGTH)],
        };
      }
      return { ...base, kind: "option", answers: [askUserOptionDisplayLabel(answer.answer)] };
    }),
  });
}

function recapString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= maximum &&
    !Array.from(value).some(isUnsafeControl)
  );
}

/** Validate a stored or received recap before it reaches the transcript. */
export function parseAskUserQuestionRecap(value: unknown): AskUserQuestionRecapV1 | undefined {
  const input = record(value);
  if (
    !input ||
    input.version !== ASK_USER_QUESTION_VERSION ||
    typeof input.outcome !== "string" ||
    !RECAP_OUTCOMES.has(input.outcome as AskUserQuestionRecapV1["outcome"]) ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > ASK_USER_MAX_QUESTIONS
  ) {
    return undefined;
  }
  const outcome = input.outcome as AskUserQuestionRecapV1["outcome"];
  const items: AskUserQuestionRecapItemV1[] = [];
  for (const candidate of input.items) {
    const item = record(candidate);
    if (
      !item ||
      !recapString(item.question, ASK_USER_MAX_QUESTION_LENGTH) ||
      !recapString(item.header, ASK_USER_MAX_HEADER_LENGTH) ||
      !Array.isArray(item.answers)
    ) {
      return undefined;
    }
    const answers: unknown[] = item.answers;
    const kind = item.kind;
    const valid =
      kind === "skipped"
        ? answers.length === 0
        : outcome === "answered" &&
          (kind === "option"
            ? answers.length === 1 && recapString(answers[0], ASK_USER_MAX_LABEL_LENGTH)
            : kind === "multi"
              ? answers.length >= 1 &&
                answers.length <= ASK_USER_MAX_OPTIONS &&
                new Set(answers).size === answers.length &&
                answers.every((label) => recapString(label, ASK_USER_MAX_LABEL_LENGTH))
              : kind === "custom" &&
                answers.length === 1 &&
                recapString(answers[0], ASK_USER_RECAP_MAX_CUSTOM_LENGTH));
    if (!valid) return undefined;
    items.push({
      question: item.question,
      header: item.header,
      kind: kind as AskUserQuestionRecapItemV1["kind"],
      answers: [...(answers as string[])],
    });
  }
  return { version: ASK_USER_QUESTION_VERSION, outcome, items };
}
