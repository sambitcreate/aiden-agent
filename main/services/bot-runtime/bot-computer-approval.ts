// What a `computer` call does, for the Bot rules (plan §8.7).
//
// Inside the Bot's own computer the baseline is allowed: nothing asks per
// click. Rules still read the call through the `computer` classifier
// surface. VNC-lane clicks are only coordinates, so the classifier reads the
// Bot's required intent ("Click Place order"); there is no window title,
// app or element in this lane. Typed text never reaches the classifier.
//
// A key chord that only types a character is typing; any other chord
// (Return, Command-S, Delete) presses something, so its intent can make any
// class a click's can: pressing Return to send a message is sending.

import { BOT_COMPUTER_MUTATING_ACTIONS, botComputerIntentOf, isBotComputerAction } from "../bot-computers/computer-schema.js";
import { botComputerChordIsPrintable } from "../bot-computers/computer-keystrokes.js";
import type { BotToolCallCheck } from "./bot-extension.js";
import type { BotLiveApproval } from "./bot-tool-assembly.js";

export function botComputerAction(call: Pick<BotToolCallCheck, "args">): BotLiveApproval {
  const args = (call.args ?? {}) as { action?: unknown; keys?: unknown };
  const action = args.action;
  // Looking, waiting and invalid calls change nothing a rule covers; the tool refuses invalid ones.
  if (!isBotComputerAction(action) || !BOT_COMPUTER_MUTATING_ACTIONS.has(action)) return { approval: null };
  const intent = botComputerIntentOf(args);
  // A mutating call without an intent never runs: the tool refuses it before acting.
  if (intent === undefined) return { approval: null };
  const classified =
    action === "key" && typeof args.keys === "string" && !botComputerChordIsPrintable(args.keys) ? "press" : action;
  return {
    approval: null,
    action: { surface: "computer", action: classified, intent },
    summary: intent,
  };
}
