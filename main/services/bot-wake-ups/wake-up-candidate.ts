// The durable Bot binding of `wake_up`: the chat chip is an entry in the
// Bot's own transcript. `unsafe`: a replayed call never sets a second wake-up.

import type { JsonValue } from "@earendil-works/chord";
import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import { createWakeUpTool } from "./wake-up-tool.js";
import type { BotWakeUps } from "./wake-ups.js";

export function wakeUpCandidate(botId: string, wakeUps: Pick<BotWakeUps, "set" | "pending" | "cancel">): BotToolCandidate {
  return {
    tool: createWakeUpTool(botId, wakeUps, async () => {
      throw new Error("Setting a wake-up needs a Bot conversation.");
    }),
    replay: "unsafe",
    bind: (call) => createWakeUpTool(botId, wakeUps, (kind, data) => call.appendEntry(kind, data as unknown as JsonValue)),
  };
}
