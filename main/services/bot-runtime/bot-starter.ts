// Start Chat on a starter Bot (spec §4.2) and the one-time self-intro of a
// newly created Bot (§4.3).
//
// `startFromPreset` is idempotent per preset (`preset:<id>`): repeat and
// concurrent taps return the same Bot, and only the call that created it sends
// the self-intro. Desktop IPC and the Remote `POST /bots/from-preset` route
// share this one instance (`botStarter()` in `bot-starter-main.ts`).

import type { BotAccessUpdate } from "../../../renderer/shared/bot-capabilities.js";
import {
  botPresetIdempotencyKey,
  createBotPresetCreator,
  type BotPresetCreateResult,
} from "../../../renderer/shared/bot-presets.js";
import type { BotCreateInput, BotDefinition } from "../../../renderer/shared/bots.js";
import { sendBotIntro } from "./bot-intro.js";
import type { BotSessionService } from "./bot-session-service.js";

export interface BotStarterDeps {
  findBotByCreationKey(key: string): Promise<BotDefinition | null>;
  /**
   * Create the Bot and remember `creationKey` for it. `audienceId` is the
   * requester's audience (a paired device for Remote); absent means the Mac.
   */
  createBot(
    input: BotCreateInput,
    access: BotAccessUpdate | undefined,
    creationKey: string,
    audienceId?: string,
  ): Promise<BotDefinition>;
  session: Pick<BotSessionService, "send" | "state">;
  onIntroError?(botId: string, error: unknown): void;
}

export interface BotStartResult extends BotPresetCreateResult {
  /** True when this call asked the new Bot to introduce itself. */
  introduced: boolean;
}

export interface BotStarter {
  startFromPreset(presetId: string, access?: BotAccessUpdate, options?: { audienceId?: string }): Promise<BotStartResult>;
  /** The self-intro for a Bot created some other way (the create flow). */
  introduce(botId: string): Promise<boolean>;
}

export function createBotStarter(deps: BotStarterDeps): BotStarter {
  // The first caller of a key owns how the Bot is created; joiners get its Bot.
  const ownerByKey = new Map<string, { access: BotAccessUpdate | undefined; audienceId: string | undefined }>();
  const create = createBotPresetCreator({
    findBotByCreationKey: deps.findBotByCreationKey,
    createBot: (input, key) => {
      const owner = ownerByKey.get(key);
      return deps.createBot(input, owner?.access, key, owner?.audienceId);
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
    async startFromPreset(presetId, access, options) {
      const key = botPresetIdempotencyKey(presetId);
      const owner = !ownerByKey.has(key);
      if (owner) ownerByKey.set(key, { access, audienceId: options?.audienceId });
      try {
        const result = await create(presetId);
        const introduced = result.created ? await introduce(result.bot.id) : false;
        return { ...result, introduced };
      } finally {
        if (owner) ownerByKey.delete(key);
      }
    },
    introduce,
  };
}
