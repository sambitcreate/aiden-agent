// Bot messaging, per Bot (plan §4.7): one switch, "Can message other Bots".
// The stored setting keeps its two directions (receiving and sending), and
// phones still read both, so the switch shows on only when both are on, and
// turning it on or off sets both. Nothing turns either on by itself.

import type { BotDefinition } from "../../shared/bots";

/** On only when the Bot both receives and sends. */
export function botMessagingSwitchOn(bot: Pick<BotDefinition, "acceptsBotMessages" | "messagesOtherBots">): boolean {
  return bot.acceptsBotMessages !== false && bot.messagesOtherBots !== false;
}

/** What the switch saves: both directions at once. */
export function botMessagingPatch(on: boolean): { acceptsBotMessages: boolean; messagesOtherBots: boolean } {
  return { acceptsBotMessages: on, messagesOtherBots: on };
}
