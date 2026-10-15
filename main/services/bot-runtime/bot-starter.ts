// Start Chat on a starter Bot (spec §4.2) and the one-time self-intro of a
// newly created Bot (§4.3).
//
// `startFromPreset` is idempotent per preset (`preset:<id>`): repeat and
// concurrent taps return the same Bot, and only the call that created it sends
// the self-intro. Desktop IPC and the Remote `POST /bots/from-preset` route
// share this one instance (`botStarter()` in `bot-starter-main.ts`; Remote
// passes a `createBot` for the phone's audience), so a tap on the Mac and a tap
// on a phone converge on one Bot, one key store and one in-flight lane.
//
// Crash safety: the new Bot's id is minted and saved under its key before the
// Bot is created, so a crash at any point leaves either nothing, a key whose
// Bot never got made (forgotten on the next tap), or a key that already finds
// the Bot. A second Bot is never made for one key.

import type { BotAccessUpdate } from "../../../renderer/shared/bot-capabilities.js";
import {
  botPresetIdempotencyKey,
  createBotPresetCreator,
  type BotPresetCreateResult,
} from "../../../renderer/shared/bot-presets.js";
import type { BotCreateInput, BotDefinition } from "../../../renderer/shared/bots.js";
import { sendBotIntro } from "./bot-intro.js";
import type { BotSessionRuntime } from "./bot-session-service.js";

export interface BotStarterDeps {
  /** The live Bot saved under `key`, or null (a key whose Bot is gone is forgotten). */
  findBotByCreationKey(key: string): Promise<BotDefinition | null>;
  /** A fresh Bot id. */
  mintBotId(): string;
  /** Durably save `creationKey` → `botId`. Called before the Bot is created. */
  reserveCreation(creationKey: string, botId: string): Promise<void>;
  /** Create the Bot with exactly `botId` (the desktop default). */
  createBot(input: BotCreateInput, access: BotAccessUpdate | undefined, botId: string): Promise<BotDefinition>;
  session: Pick<BotSessionRuntime, "send" | "state" | "conversation">;
  onIntroError?(botId: string, error: unknown): void;
}

export interface BotStartResult extends BotPresetCreateResult {
  /** True when this call asked the new Bot to introduce itself. */
  introduced: boolean;
}

export interface BotStartOptions {
  /** The access the person confirmed (desktop). */
  access?: BotAccessUpdate;
  /** Creates the Bot with exactly `botId` for another audience (a paired phone); the key is still kept here. */
  createBot?(input: BotCreateInput, botId: string): Promise<BotDefinition>;
}

export interface BotStarter {
  startFromPreset(presetId: string, options?: BotStartOptions): Promise<BotStartResult>;
  /** The self-intro for a Bot created some other way (the create flow). */
  introduce(botId: string): Promise<boolean>;
}

export function createBotStarter(deps: BotStarterDeps): BotStarter {
  /** The options of the call that owns each in-flight creation. */
  const optionsByKey = new Map<string, BotStartOptions>();
  const create = createBotPresetCreator({
    findBotByCreationKey: deps.findBotByCreationKey,
    async createBot(input, key) {
      const options = optionsByKey.get(key) ?? {};
      const botId = deps.mintBotId();
      await deps.reserveCreation(key, botId);
      return options.createBot ? options.createBot(input, botId) : deps.createBot(input, options.access, botId);
    },
  });

  const introduce = async (botId: string): Promise<boolean> => {
    try {
      return await sendBotIntro(deps.session, botId);
    } catch (error) {
      // The Bot exists either way; the person can still just start talking.
      deps.onIntroError?.(botId, error);
      return false;
    }
  };

  return {
    async startFromPreset(presetId, options = {}) {
      const key = botPresetIdempotencyKey(presetId);
      const owner = !optionsByKey.has(key);
      if (owner) optionsByKey.set(key, options);
      try {
        const result = await create(presetId);
        const introduced = result.created ? await introduce(result.bot.id) : false;
        return { ...result, introduced };
      } finally {
        if (owner) optionsByKey.delete(key);
      }
    },
    introduce,
  };
}
