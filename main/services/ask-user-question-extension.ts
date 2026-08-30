import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  ASK_USER_MAX_DESCRIPTION_LENGTH,
  ASK_USER_MAX_HEADER_LENGTH,
  ASK_USER_MAX_LABEL_LENGTH,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_QUESTION_TOOL_NAME,
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
  excluded: boolean;
}

export function shouldEnableAskUserQuestionExtension(
  scope: AskUserQuestionExtensionScope,
): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.botBound &&
    scope.rendererOwner &&
    !scope.excluded &&
    !scope.assistantMode
  );
}

function formatResult(
  questions: readonly AskUserQuestionV1[],
  response: AskUserQuestionResponseV1,
): string {
  if (response.cancelled) {
    return "The user closed the questionnaire without answering. Do not repeat it immediately; continue only if the task can proceed safely, otherwise ask in chat.";
  }
  const byIndex = new Map(response.answers.map((answer) => [answer.questionIndex, answer]));
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

export function createAskUserQuestionExtension(options: {
  request(
    toolCallId: string,
    questions: AskUserQuestionV1[],
    signal?: AbortSignal,
  ): Promise<AskUserQuestionResponseV1>;
}): PiAgentRuntimeExtension {
  const tool: AgentTool = declarePiRuntimeReplay(
    {
      name: ASK_USER_QUESTION_TOOL_NAME,
      label: "Ask User Question",
      description:
        "Ask the user 1-4 concise structured questions when a material choice cannot be inferred safely. Each question needs 2-4 distinct options with short labels and useful descriptions. The UI automatically offers a custom answer and Skip, so do not add Other or a skip option.",
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
      }),
      execute: async (toolCallId, parameters, signal): Promise<AgentToolResult<null>> => {
        const questions = parseAskUserQuestions((parameters as { questions?: unknown }).questions);
        if (!questions) throw new Error("The questionnaire is invalid.");
        const response = await options.request(toolCallId, questions, signal);
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
