// `bots:answerQuestion({ botId, waitId, answer })`: answer a Bot's waiting A–E
// question from any desktop window. The first valid answer wins.
//
// - `{ answered: true }`: the answer settled the question.
// - `{ answered: false }`: nothing waits under that `waitId` for that Bot any
//   more (answered elsewhere, withdrawn by Stop/Dismiss/delete/quit, or never
//   asked). Nothing is recorded.
// - Throws for a malformed request, or an answer the waiting question does not
//   accept (an option it does not have, a question index out of range).

import type { BotQuestions } from "../services/bot-runtime/bot-questions.js";
import { parseBotQuestionAnswer } from "./bot-params.js";

export const BOT_ANSWER_QUESTION_CHANNEL = "bots:answerQuestion";

export interface BotQuestionHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  questions: Pick<BotQuestions, "answer">;
}

export function registerBotQuestionHandlers(dependencies: BotQuestionHandlerDependencies): void {
  dependencies.handle(BOT_ANSWER_QUESTION_CHANNEL, async (_event, input): Promise<{ answered: boolean }> => {
    const { botId, waitId, answer } = parseBotQuestionAnswer(input);
    const outcome = dependencies.questions.answer(botId, waitId, answer);
    if (outcome === "invalid") throw new Error("That answer doesn’t match the question.");
    return { answered: outcome === "answered" };
  });
}
