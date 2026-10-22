// Fixtures for the Bot `hand_off` and `sign_in` tests: the tools' arguments
// and the tool entries a Bot turn would offer.

import type { BotToolEntry } from "../bot-extension.js";
import { botHandoffCandidate } from "../bot-handoff-tool.js";
import type { BotHandoffs } from "../bot-handoffs.js";
import { signInCandidate, type BotSignInDeps } from "../bot-sign-in-tool.js";
import type { BotToolCandidate } from "../bot-tool-assembly.js";

export const HANDOFF_TOOL_NAME = "hand_off";
export const SIGN_IN_TOOL_NAME = "sign_in";

export const HANDOFF_ARGS = {
  action: "Enter the 2FA code for your bank.",
  why: "Only you get the code on your phone.",
  open: { url: "https://bank.example/verify" },
};

export const SIGN_IN_ARGS = {
  site: "https://GitHub.com/login?return_to=%2Fissues",
  why: "I need your GitHub account to read your issues.",
};

function entryOf(candidate: BotToolCandidate): BotToolEntry {
  return { tool: candidate.tool, replay: candidate.replay ?? "safe", ...(candidate.bind ? { bind: candidate.bind } : {}) };
}

/** The hand-off tool as a Bot turn offers it, answered through `handoffs`. */
export function handoffEntries(handoffs: BotHandoffs, botId = "bot-h"): BotToolEntry[] {
  return [entryOf(botHandoffCandidate(botId, handoffs))];
}

/** The sign-in tool as a Bot turn offers it, answered through `handoffs`. */
export function signInEntries(handoffs: BotHandoffs, botId = "bot-s", deps: BotSignInDeps = {}): BotToolEntry[] {
  return [entryOf(signInCandidate(botId, handoffs, deps))];
}
