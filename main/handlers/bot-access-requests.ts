import type { BotAccessChoice } from "../../renderer/shared/bot-access-requests.js";
import { parseBotAccessAnswer } from "./bot-params.js";

export const BOT_ANSWER_ACCESS_REQUEST_CHANNEL = "bots:answerAccessRequest";

/** Renderer answers carry only the Bot, current attempt and offered choice. */
export function registerBotAccessRequestHandlers<Event = unknown>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  answer(botId: string, waitId: string, choice: BotAccessChoice): Promise<{ answered: boolean; savedForFuture?: true }>;
}): void {
  deps.handle(BOT_ANSWER_ACCESS_REQUEST_CHANNEL, async (_event, input) => {
    const { botId, waitId, choice } = parseBotAccessAnswer(input);
    return deps.answer(botId, waitId, choice);
  });
}
