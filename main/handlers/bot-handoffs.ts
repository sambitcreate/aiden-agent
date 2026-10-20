// Hand-off cards from any desktop window.
//
// `bots:answerHandoff({ botId, waitId, outcome, note? })`: Done or Skip. The
// first valid answer wins.
// - `{ answered: true }`: the answer settled the card.
// - `{ answered: false }`: nothing waits under that `waitId` for that Bot any
//   more (answered elsewhere, withdrawn by Stop/Dismiss/delete/quit, or never
//   asked). Nothing is recorded.
// - Throws for a malformed request.
//
// `bots:openHandoff({ botId, waitId })`: the card's Open button
// (`bot-handoff-open.ts`). `{ opened: "none" }` once the card no longer waits.

import type { BotHandoffOpened } from "../services/bot-runtime/bot-handoff-open.js";
import type { BotHandoffs } from "../services/bot-runtime/bot-handoffs.js";
import { parseBotHandoffAnswer, parseBotHandoffOpen } from "./bot-params.js";

export const BOT_ANSWER_HANDOFF_CHANNEL = "bots:answerHandoff";
export const BOT_OPEN_HANDOFF_CHANNEL = "bots:openHandoff";

export interface BotHandoffHandlerDependencies<Event = unknown> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  handoffs: Pick<BotHandoffs, "answer">;
  /** Open the card for the person; `event` is the asking window's request. */
  open(botId: string, waitId: string, event: Event): Promise<BotHandoffOpened>;
}

export function registerBotHandoffHandlers<Event = unknown>(dependencies: BotHandoffHandlerDependencies<Event>): void {
  dependencies.handle(BOT_ANSWER_HANDOFF_CHANNEL, async (_event, input): Promise<{ answered: boolean }> => {
    const { botId, waitId, outcome, note } = parseBotHandoffAnswer(input);
    const result = dependencies.handoffs.answer(botId, waitId, { outcome, ...(note === undefined ? {} : { note }) });
    if (result === "invalid") throw new Error("That answer doesn’t match the card.");
    return { answered: result === "answered" };
  });
  dependencies.handle(BOT_OPEN_HANDOFF_CHANNEL, async (event, input): Promise<{ opened: BotHandoffOpened }> => {
    const { botId, waitId } = parseBotHandoffOpen(input);
    return { opened: await dependencies.open(botId, waitId, event) };
  });
}
