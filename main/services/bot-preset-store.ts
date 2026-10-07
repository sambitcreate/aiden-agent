// Persistence for "Start Chat" on a starter Bot: which Bot each preset made,
// keyed `preset:<id>`, so repeated and concurrent taps (desktop or phone)
// converge on one Bot. A deleted Bot frees its preset for a fresh start.

import {
  createBotPresetCreator,
  type BotPresetStore,
  type CreateBotFromPreset,
} from "../../renderer/shared/bot-presets.js";
import type { BotCreateInput, BotDefinition } from "../../renderer/shared/bots.js";
import { DataStore } from "./data-store.js";

interface BotPresetCreations {
  version: 1;
  /** `preset:<id>` → Bot id. */
  creations: Record<string, string>;
}

const FILE = "bot-preset-creations-v1.json";
const KEY = /^preset:[a-z0-9][a-z0-9._-]{0,79}$/u;
const BOT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;

function normalize(value: unknown): BotPresetCreations {
  const creations: Record<string, string> = {};
  const raw = (value as { creations?: unknown } | null)?.creations;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, botId] of Object.entries(raw)) {
      if (KEY.test(key) && typeof botId === "string" && BOT_ID.test(botId)) creations[key] = botId;
    }
  }
  return { version: 1, creations };
}

export interface BotPresetStoreDependencies {
  root(): string;
  /** A live Bot, or null when it is missing or deleted. */
  getBot(botId: string): Promise<BotDefinition | null>;
  createBot(input: BotCreateInput): Promise<BotDefinition>;
}

export function createBotPresetStore(dependencies: BotPresetStoreDependencies): BotPresetStore {
  const store = new DataStore<BotPresetCreations>(FILE, { version: 1, creations: {} }, dependencies.root, {
    maxBytes: 64 * 1_024,
    fileMode: 0o600,
    normalize,
  });
  return {
    async findBotByCreationKey(key) {
      const botId = normalize(await store.load()).creations[key];
      if (!botId) return null;
      const bot = await dependencies.getBot(botId);
      return bot && bot.archivedAt === undefined ? bot : null;
    },
    async createBot(input, key) {
      const bot = await dependencies.createBot(input);
      await store.update((draft) => {
        const next = normalize(draft);
        next.creations[key] = bot.id;
        draft.version = 1;
        draft.creations = next.creations;
      });
      return bot;
    },
  };
}

/** One process-wide creator, so desktop and Remote taps share one in-flight lane. */
export function createBotPresetCreatorFor(dependencies: BotPresetStoreDependencies): CreateBotFromPreset {
  return createBotPresetCreator(createBotPresetStore(dependencies));
}
