import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import { createMessageBotTool, type MessageBotToolDeps } from "./tool.js";
/** One fixed declaration; execution binds to the real durable call. */
export async function messageBotCandidate(botId: string, deps: MessageBotToolDeps): Promise<BotToolCandidate> {
  return {
    tool: createMessageBotTool(botId, deps),
    replay: "safe",
    bind: (call) => createMessageBotTool(botId, deps, call),
  };
}
export interface MessageBotOfferDeps extends MessageBotToolDeps {
  /** The person's Bot messaging switch. */
  messagingEnabled(): Promise<boolean>;
  /** This Bot's own definition. */
  bot(botId: string): Promise<Pick<BotDefinition, "messagesOtherBots"> | null | undefined>;
}
/**
 * Whether a Bot declares `message_bot`: the messaging switch and the Bot's own
 * send setting only, never the other Bots, so a Bot being added, removed or
 * told to stop accepting messages leaves every other Bot's tool list
 * unchanged. Which peers accept messages is read by `list` and when sending;
 * the Bot-message chain limit and peer turns are refused per call.
 */
export async function messageBotOffer(botId: string, deps: MessageBotOfferDeps): Promise<BotToolCandidate | undefined> {
  if (!(await deps.messagingEnabled())) return undefined;
  const bot = await deps.bot(botId);
  if (!bot || bot.messagesOtherBots === false) return undefined;
  return messageBotCandidate(botId, deps);
}
