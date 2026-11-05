import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import { createMessageBotTool, type MessageBotToolDeps } from "./tool.js";
/** Resolve the declaration roster at refresh; bind execution to the real durable call. */
export async function messageBotCandidate(botId: string, deps: MessageBotToolDeps): Promise<BotToolCandidate> {
  const snapshot = { ...deps, descriptionRoster: deps.descriptionRoster ?? await deps.roster() };
  return {
    tool: createMessageBotTool(botId, snapshot),
    replay: "safe",
    bind: (call) => createMessageBotTool(botId, snapshot, call),
  };
}
