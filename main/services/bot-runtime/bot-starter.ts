// Create bot on a Template (plan §4.3), the silent first Bot onboarding makes
// (§4.1), and the one-time self-intro of a newly created Bot.
//
// `startFromPreset` is idempotent per template (`preset:<id>`) and
// `startFirst` per install (`first-bot`): repeat and
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
  BOT_FIRST_BOT_KEY,
  BOT_PRESETS,
  botFirstCreateInput,
  botPresetIdempotencyKey,
  createBotPresetCreator,
  createKeyedBotCreator,
  getBotPreset,
  type BotPresetCreateResult,
  type BotPresetRoutine,
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
  /**
   * Create the Bot with exactly `botId` (the desktop default). `presetId` is
   * the template it came from; none for the first Bot.
   */
  createBot(input: BotCreateInput, access: BotAccessUpdate | undefined, botId: string, presetId: string | undefined): Promise<BotDefinition>;
  /**
   * Adds a template's routine to the Bot it just made, paused until the person
   * turns it on. Optional: a host without routines adds none.
   */
  addPausedRoutine?(botId: string, routine: BotPresetRoutine): Promise<void>;
  session: Pick<BotSessionRuntime, "send" | "state" | "conversation">;
  onIntroError?(botId: string, error: unknown): void;
  /** The Bot exists; only its paused template routine could not be added. */
  onRoutineError?(botId: string, error: unknown): void;
}

export interface BotStartResult extends BotPresetCreateResult {
  /** True when this call asked the new Bot to introduce itself. */
  introduced: boolean;
}

export interface BotStartOptions {
  /** The access the person confirmed (desktop). */
  access?: BotAccessUpdate;
  /** The template version the person was shown; another version refuses. */
  version?: number;
  /**
   * False leaves the one-time self-intro to the caller (`introduce`), so the
   * answer comes back as soon as the Bot exists and its chat can open while the
   * intro is sent. The intro is deduped per Bot either way.
   */
  introduce?: boolean;
  /** Creates the Bot with exactly `botId` for another audience (a paired phone); the key is still kept here. */
  createBot?(input: BotCreateInput, botId: string, presetId: string): Promise<BotDefinition>;
}

export interface BotStarter {
  startFromPreset(presetId: string, options?: BotStartOptions): Promise<BotStartResult>;
  /** The silent first Bot (§4.1): "Chief", made once; a repeat returns it. */
  startFirst(options?: Pick<BotStartOptions, "introduce">): Promise<BotStartResult>;
  /** Template id → the live Bot it made, for "Open" instead of "Create bot". */
  presetBots(): Promise<Record<string, string>>;
  /** The self-intro for a Bot created some other way (the create flow). */
  introduce(botId: string): Promise<boolean>;
}

export function createBotStarter(deps: BotStarterDeps): BotStarter {
  /** The options of the call that owns each in-flight creation. */
  const optionsByKey = new Map<string, BotStartOptions>();
  const store = {
    findBotByCreationKey: deps.findBotByCreationKey,
    async createBot(input: BotCreateInput, key: string) {
      const options = optionsByKey.get(key) ?? {};
      const botId = deps.mintBotId();
      await deps.reserveCreation(key, botId);
      const presetId = key.startsWith("preset:") ? key.slice("preset:".length) : undefined;
      const bot = options.createBot && presetId !== undefined
        ? await options.createBot(input, botId, presetId)
        : await deps.createBot(input, options.access, botId, presetId);
      // A template's routine arrives paused; nothing runs until the person turns it on.
      const routine = presetId === undefined ? undefined : getBotPreset(presetId)?.suggestedRoutine;
      if (routine && deps.addPausedRoutine) {
        await deps.addPausedRoutine(bot.id, routine).catch((error: unknown) => deps.onRoutineError?.(bot.id, error));
      }
      return bot;
    },
  };
  const create = createBotPresetCreator(store);
  const createKeyed = createKeyedBotCreator(store);

  const introduce = async (botId: string): Promise<boolean> => {
    try {
      return await sendBotIntro(deps.session, botId);
    } catch (error) {
      // The Bot exists either way; the person can still just start talking.
      deps.onIntroError?.(botId, error);
      return false;
    }
  };

  const started = async (
    key: string,
    options: BotStartOptions,
    make: () => Promise<BotPresetCreateResult>,
  ): Promise<BotStartResult> => {
    const owner = !optionsByKey.has(key);
    if (owner) optionsByKey.set(key, options);
    try {
      const result = await make();
      const introduced = result.created && options.introduce !== false ? await introduce(result.bot.id) : false;
      return { ...result, introduced };
    } finally {
      if (owner) optionsByKey.delete(key);
    }
  };

  return {
    startFromPreset(presetId, options = {}) {
      return started(botPresetIdempotencyKey(presetId), options, () => create(presetId, options.version));
    },
    startFirst(options = {}) {
      return started(BOT_FIRST_BOT_KEY, options, () => createKeyed(BOT_FIRST_BOT_KEY, () => botFirstCreateInput()));
    },
    async presetBots() {
      const found: Record<string, string> = {};
      for (const preset of BOT_PRESETS) {
        const bot = await deps.findBotByCreationKey(botPresetIdempotencyKey(preset.id));
        if (bot) found[preset.id] = bot.id;
      }
      return found;
    },
    introduce,
  };
}
