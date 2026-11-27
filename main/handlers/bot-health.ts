// A Bot's health from the desktop profile.
//
// - `bots:health:report({ botId })`: the newest check report, or null when
//   the Bot was not checked since Aiden started.
// - `bots:health:check({ botId })`: run the checks now (the person pressed
//   Check now). It may refresh a sign-in and connect the Bot's services, the
//   same as the pre-fire check; it never starts a Bot computer.

import { BOT_HEALTH_CHANNELS, type BotHealthReport } from "../../renderer/shared/bot-health.js";
import { parseBotId } from "./bot-params.js";
import { requireAllowedKeys } from "../shared/guards.js";

function parseBotHealthInput(input: unknown): { botId: string } {
  const fields = requireAllowedKeys(input, ["botId"], "Invalid bot health fields.");
  return { botId: parseBotId(fields.botId) };
}

export interface BotHealthHandlerDependencies<Event = unknown> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  report(botId: string): BotHealthReport | undefined;
  check(botId: string): Promise<BotHealthReport>;
}

export function registerBotHealthHandlers<Event = unknown>(dependencies: BotHealthHandlerDependencies<Event>): void {
  dependencies.handle(BOT_HEALTH_CHANNELS.report, async (_event, input): Promise<BotHealthReport | null> => {
    const { botId } = parseBotHealthInput(input);
    return dependencies.report(botId) ?? null;
  });
  dependencies.handle(BOT_HEALTH_CHANNELS.check, async (_event, input): Promise<BotHealthReport> => {
    const { botId } = parseBotHealthInput(input);
    return dependencies.check(botId);
  });
}
