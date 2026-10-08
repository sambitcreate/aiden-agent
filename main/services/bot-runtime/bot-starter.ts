// Start Chat on a starter Bot (spec §4.2) and the one-time self-intro of a
// newly created Bot (§4.3).
//
// `startFromPreset` is idempotent per preset (`preset:<id>`): repeat and
// concurrent taps return the same Bot, and only the call that created it sends
// the self-intro. Desktop IPC and the Remote `POST /bots/from-preset` route
// share this one instance (`botStarter()` in `bot-starter-main.ts`, reached by
// Remote through `createBotPresetCreatorFor` in `bot-preset-store.ts`), so a
// tap on the Mac and a tap on a phone converge on one Bot and one key store.

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
  findBotByCreationKey(key: string): Promise<BotDefinition | null>;
  /** Create the Bot (the desktop default) and remember `creationKey` for it. */
  createBot(input: BotCreateInput, access: BotAccessUpdate | undefined, creationKey: string): Promise<BotDefinition>;
  /** Remember `creationKey` for a Bot that a caller-supplied `createBot` made. */
  rememberCreation(creationKey: string, botId: string): Promise<void>;
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
  /** Creates the Bot for another audience (a paired phone); the key is still remembered here. */
  createBot?(input: BotCreateInput): Promise<BotDefinition>;
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
      if (!options.createBot) return deps.createBot(input, options.access, key);
      const bot = await options.createBot(input);
      await deps.rememberCreation(key, bot.id);
      return bot;
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
