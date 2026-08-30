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
  return {
    version: ASK_USER_QUESTION_VERSION,
    promptId: input.promptId,
    streamId: input.streamId,
    toolCallId: input.toolCallId,
    questions,
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
