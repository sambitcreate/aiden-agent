// Start Chat on a starter Bot from a paired phone (Remote `POST /bots/from-preset`).
//
// It goes through the same process-wide starter as the desktop
// (`botStarter()`), so desktop and phone taps for one preset share one
// `preset:<id>` key store and one in-flight lane, converge on one Bot, and only
// the call that created it sends the one-time self-intro. Only the Bot's
// creation itself (its capability audience) comes from the Remote caller.

import type { CreateBotFromPreset } from "../../renderer/shared/bot-presets.js";
import type { BotCreateInput, BotDefinition } from "../../renderer/shared/bots.js";

export interface BotPresetStoreDependencies {
  /** Creates the Bot for the Remote audience. */
  createBot(input: BotCreateInput): Promise<BotDefinition>;
  /**
   * Unused: creation keys live with the shared starter. Kept so existing
   * callers type-check until they stop passing it.
   */
  root?(): string;
  /** Unused, as `root`. */
  getBot?(botId: string): Promise<BotDefinition | null>;
}

/** Start Chat for a Remote caller, through the desktop's shared starter. */
export function createBotPresetCreatorFor(dependencies: BotPresetStoreDependencies): CreateBotFromPreset {
  return async (presetId) => {
    // Loaded lazily: the starter pulls in the Bot runtime.
    const { botStarter } = await import("./bot-runtime/bot-starter-main.js");
    const { bot, created } = await botStarter().startFromPreset(presetId, { createBot: dependencies.createBot });
    return { bot, created };
  };
}
