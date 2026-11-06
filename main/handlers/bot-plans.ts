import { BOT_PLAN_CHANNELS, parseBotPlanResponse } from "../../renderer/shared/bot-plans.js";
import type { BotPlans } from "../services/bot-plans/plans.js";

/** A renderer may answer the captured plan, never supply its authority. */
export function registerBotPlanHandlers<Event = unknown>(deps: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  plans: Pick<BotPlans, "respond">;
}): void {
  deps.handle(BOT_PLAN_CHANNELS.respond, async (_event, input) => {
    const { botId, planId, decision } = parseBotPlanResponse(input);
    return { result: await deps.plans.respond(botId, planId, decision) };
  });
}
