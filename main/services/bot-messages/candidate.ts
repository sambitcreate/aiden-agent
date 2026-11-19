import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import { createMessageBotTool, type MessageBotToolDeps } from "./tool.js";
/** One fixed declaration; execution binds to the real durable call. */
export async function messageBotCandidate(botId: string, deps: MessageBotToolDeps): Promise<BotToolCandidate> {
  return {
    tool: createMessageBotTool(botId, deps),
    replay: "safe",
    bind: (call) => createMessageBotTool(botId, deps, call),
  };
}
