import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  ASK_USER_MAX_DESCRIPTION_LENGTH,
  ASK_USER_MAX_HEADER_LENGTH,
  ASK_USER_MAX_LABEL_LENGTH,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_MAX_TIMEOUT_SECONDS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_MIN_TIMEOUT_SECONDS,
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_UNATTENDED_TIMEOUT_SECONDS,
  formatAskUserQuestionAnswers,
  normalizeAskUserTimeoutSeconds,
  parseAskUserQuestions,
  type AskUserQuestionResponseV1,
  type AskUserQuestionV1,
} from "../../renderer/shared/ask-user-question.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";

export const ASK_USER_QUESTION_EXTENSION_ID = "aiden.gui.ask-user-question";

export interface AskUserQuestionExtensionScope {
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  botBound: boolean;
  rendererOwner: boolean;
  /** Paired-device owners also reach a questionnaire surface through Remote v1. */
  remoteOwner?: boolean;
  excluded: boolean;
}

/**
 * Resolve how long a questionnaire waits before the agent continues without
 * an answer. Attended desktop owners wait until answered unless the agent
 * asked for a deadline. Unattended owners always get one, capped at the
 * Remote question lifetime so the phone card and the agent expire together.
 */
export function resolveAskUserQuestionTimeoutMs(
  requestedSeconds: number | undefined,
  owner: { unattended: boolean },
): number | undefined {
  const requested = normalizeAskUserTimeoutSeconds(requestedSeconds);
  if (!owner.unattended) return requested === undefined ? undefined : requested * 1_000;
  return (
    Math.min(requested ?? ASK_USER_UNATTENDED_TIMEOUT_SECONDS, ASK_USER_UNATTENDED_TIMEOUT_SECONDS) *
    1_000
  );
}

/**
 * Questionnaires run where someone can answer them: attended desktop or
 * paired-device chats, including Bot chats (their A–E quick replies).
 * Telegram and Assistant turns have no questionnaire surface.
 */
export function shouldEnableAskUserQuestionExtension(
  scope: AskUserQuestionExtensionScope,
): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    (scope.rendererOwner || scope.remoteOwner === true) &&
    !scope.excluded &&
    !scope.assistantMode
  );
}

function formatResult(
  questions: readonly AskUserQuestionV1[],
  response: AskUserQuestionResponseV1,
): string {
  if (response.timedOut) {
    return "No answer was received before the question expired. Proceed with your best judgement, using any default you stated in the question. Say which assumption you made so the user can correct it. Do not ask the same question again; the user may still send their answer as a follow-up message.";
  }
  if (response.cancelled) {
    return "The user closed the questionnaire without answering. Do not repeat it immediately; continue only if the task can proceed safely, otherwise ask in chat.";
  }
  return formatAskUserQuestionAnswers(questions, response.answers);
}

export function createAskUserQuestionExtension(options: {
  request(
    toolCallId: string,
    questions: AskUserQuestionV1[],
    signal?: AbortSignal,
    timeoutSeconds?: number,
  ): Promise<AskUserQuestionResponseV1>;
}): PiAgentRuntimeExtension {
  const tool: AgentTool = declarePiRuntimeReplay(
    {
      name: ASK_USER_QUESTION_TOOL_NAME,
      label: "Ask User Question",
      description:
        "Ask the user 1-4 concise structured questions when a material choice cannot be inferred safely. Each question needs 2-5 distinct options with short labels and useful descriptions. The UI automatically offers a custom answer and Skip, so do not add Other or a skip option. Set timeoutSeconds when the task can reasonably continue without an answer (for example, state a default in the question): after that long you receive a no-answer result and should proceed with your best judgement. Some unattended surfaces always apply a short deadline.",
      // A second questionnaire cannot replace the first composer surface while
      // it is awaiting its owner. Serialize calls so every prompt is answered
      // or cancelled before another questionnaire can be published.
      executionMode: "sequential" as const,
      parameters: Type.Object({
        questions: Type.Array(
          Type.Object({
            question: Type.String({ minLength: 1, maxLength: 1_000 }),
            header: Type.String({ minLength: 1, maxLength: ASK_USER_MAX_HEADER_LENGTH }),
            options: Type.Array(
              Type.Object({
                label: Type.String({ minLength: 1, maxLength: ASK_USER_MAX_LABEL_LENGTH }),
                description: Type.String({
                  minLength: 1,
                  maxLength: ASK_USER_MAX_DESCRIPTION_LENGTH,
                }),
              }),
              { minItems: ASK_USER_MIN_OPTIONS, maxItems: ASK_USER_MAX_OPTIONS },
            ),
            multiSelect: Type.Optional(Type.Boolean({ default: false })),
          }),
          { minItems: 1, maxItems: ASK_USER_MAX_QUESTIONS },
        ),
        timeoutSeconds: Type.Optional(
          Type.Integer({
            minimum: ASK_USER_MIN_TIMEOUT_SECONDS,
            maximum: ASK_USER_MAX_TIMEOUT_SECONDS,
            description:
              "Optional. Seconds to wait for an answer before continuing without one.",
          }),
        ),
      }),
      execute: async (toolCallId, parameters, signal): Promise<AgentToolResult<null>> => {
        const questions = parseAskUserQuestions((parameters as { questions?: unknown }).questions);
        if (!questions) throw new Error("The questionnaire is invalid.");
        const timeoutSeconds = normalizeAskUserTimeoutSeconds(
          (parameters as { timeoutSeconds?: unknown }).timeoutSeconds,
        );
        const response = await options.request(toolCallId, questions, signal, timeoutSeconds);
        return {
          content: [{ type: "text", text: formatResult(questions, response) }],
          details: null,
        };
      },
    },
    "never",
  );
  return { id: ASK_USER_QUESTION_EXTENSION_ID, tools: [tool] };
}
