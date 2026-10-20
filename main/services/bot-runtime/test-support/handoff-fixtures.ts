// Fixtures for the Bot `hand_off` tests: the tool's arguments and the tool
// entries a Bot turn would offer.

import type { BotToolEntry } from "../bot-extension.js";
import { botHandoffCandidate } from "../bot-handoff-tool.js";
import type { BotHandoffs } from "../bot-handoffs.js";

export const HANDOFF_TOOL_NAME = "hand_off";

export const HANDOFF_ARGS = {
  action: "Enter the 2FA code for your bank.",
  why: "Only you get the code on your phone.",
  open: { url: "https://bank.example/verify" },
};

/** The hand-off tool as a Bot turn offers it, answered through `handoffs`. */
export function handoffEntries(handoffs: BotHandoffs, botId = "bot-h"): BotToolEntry[] {
  const candidate = botHandoffCandidate(botId, handoffs);
  return [{ tool: candidate.tool, replay: candidate.replay ?? "safe", ...(candidate.bind ? { bind: candidate.bind } : {}) }];
}
