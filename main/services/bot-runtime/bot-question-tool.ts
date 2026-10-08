// The durable `ask_user_question` tool for Bot turns: the legacy schema,
// parser and model-facing answer text, waiting on the person through
// `bot-questions.ts`.
//
// - Waiting: the question's `waitId` is a memo of the tool task, so a Resume
//   after a quit or crash re-asks the same question under the same id.
// - Replay: `safe`. Its only effect is showing a card; the answer lands in the
//   one tool result the harness commits, so re-asking after an interruption is
//   idempotent and an answer is applied exactly once.
// - Stopped (Stop, Dismiss, delete): the wait rejects, so no answer is
//   recorded; the harness writes its own `aborted` result.
// - Not offered on routine or Telegram turns (`bot-tool-policy.ts`): nobody is
//   watching a card there.
// - Interactive: the call waits for a person, so it holds no authority
//   admission while it waits (`interactive` on the candidate).

import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseAskUserQuestions,
  summarizeAskUserQuestionResponse,
} from "../../../renderer/shared/ask-user-question.js";
import type { BotQuestionAnswerDetails } from "../../../renderer/shared/bot-live.js";
import { askUserQuestionsSchema, formatAskUserQuestionResponse } from "../ask-user-question-extension.js";
import type { BotQuestions } from "./bot-questions.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import type { BotToolCall } from "./tool-adapter.js";

export const BOT_QUESTION_MEMO = "aiden.question";

const DESCRIPTION =
  "Ask the person 1-4 concise structured questions when a material choice cannot be inferred safely. " +
  "Each question needs 2-5 distinct options with short labels and useful descriptions. The app shows them as " +
  "quick replies and adds a custom answer and Skip automatically, so do not add Other or a skip option. " +
  "The answer comes back as this tool's result; wait for it and do not guess.";

export function botQuestionCandidate(botId: string, questions: BotQuestions): BotToolCandidate {
  const schema: AgentTool = {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description: DESCRIPTION,
    // One card at a time: a second question in the same round waits for the first.
    executionMode: "sequential",
    parameters: Type.Object({ questions: askUserQuestionsSchema() }),
    async execute(): Promise<AgentToolResult<null>> {
      throw new Error("A question needs the Bot's conversation.");
    },
  };
  return {
    tool: schema,
    replay: "safe",
    interactive: true,
    bind: (call: BotToolCall): AgentTool => ({
      ...schema,
      async execute(_toolCallId, params): Promise<AgentToolResult<BotQuestionAnswerDetails>> {
        const parsed = parseAskUserQuestions((params as { questions?: unknown }).questions);
        if (!parsed) throw new Error("The questions are invalid: each needs 2-5 distinct options and a unique question.");
        const memo = await call.memo<{ waitId: string }>(BOT_QUESTION_MEMO, { waitId: randomUUID() });
        const response = await questions.request({
          botId,
          waitId: memo.waitId,
          toolCallId: call.callId,
          questions: parsed,
          signal: call.signal,
        });
        return {
          content: [{ type: "text", text: formatAskUserQuestionResponse(parsed, response) }],
          details: { answerText: summarizeAskUserQuestionResponse(parsed, response) },
        };
      },
    }),
  };
}
