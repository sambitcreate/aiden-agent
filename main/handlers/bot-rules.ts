// Profile → Rules over desktop IPC (plan §6.3).
//
// - `bots:rules:get(botId)` → `BotRulesView`: locked, built-in and custom
//   rules, with the revision every edit must name.
// - `bots:rules:update({ botId, revision, change })` → `BotRulesUpdateResult`.
//   A refused edit (stale revision, locked rule, invalid text, over the limit,
//   already removed) is a result with the current view, not a throw, so the
//   page can show its message; malformed input throws.

import { BOT_RULE_CHANNELS, type BotRulesUpdateResult, type BotRulesView } from "../../renderer/shared/bot-rules.js";
import type { BotRuleStore } from "../services/bot-rules/store.js";
import { parseBotId, parseBotRulesUpdate } from "./bot-params.js";

export interface BotRuleHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  rules: Pick<BotRuleStore, "get" | "update">;
  /** Whether the Bot exists; rules of an unknown Bot are refused. */
  botExists(botId: string): Promise<boolean>;
}

export function registerBotRuleHandlers(dependencies: BotRuleHandlerDependencies): void {
  async function knownBot(raw: unknown): Promise<string> {
    const botId = parseBotId(raw);
    if (!(await dependencies.botExists(botId))) throw new Error("This Bot no longer exists.");
    return botId;
  }

  dependencies.handle(BOT_RULE_CHANNELS.get, async (_event, rawBotId): Promise<BotRulesView> => {
    return dependencies.rules.get(await knownBot(rawBotId));
  });

  dependencies.handle(BOT_RULE_CHANNELS.update, async (_event, input): Promise<BotRulesUpdateResult> => {
    const parsed = parseBotRulesUpdate(input);
    await knownBot(parsed.botId);
    return dependencies.rules.update(parsed.botId, parsed.revision, parsed.change);
  });
}
