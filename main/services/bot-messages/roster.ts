import type { BotDefinition } from "../../../renderer/shared/bots.js";
import type { BotRosterEntry } from "./courier.js";

/** Availability reads local authority only; listing never starts a session or model. */
export async function projectBotMessageRoster(
  bots: readonly BotDefinition[],
  deps: {
    paused(id: string): Promise<boolean>;
    hasModel(id: string): Promise<boolean>;
    spendingRefusal(id: string, name: string): Promise<string | undefined>;
    report(id: string, error: unknown): void;
  },
): Promise<readonly BotRosterEntry[]> {
  return Promise.all(
    bots.map(async (bot): Promise<BotRosterEntry> => {
      const row: BotRosterEntry = {
        id: bot.id,
        name: bot.name,
        purpose: bot.description ?? "",
        acceptsMessages: bot.acceptsBotMessages !== false,
        sendsMessages: bot.messagesOtherBots !== false,
      };
      try {
        if (await deps.paused(bot.id)) row.unavailable = "bot_paused";
        else if (!(await deps.hasModel(bot.id))) row.unavailable = "needs_model";
        else if (await deps.spendingRefusal(bot.id, bot.name)) row.unavailable = "spending_limit";
      } catch (error) {
        deps.report(bot.id, error);
        row.unavailable = "unavailable";
      }
      return row;
    }),
  );
}
