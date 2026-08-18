import { randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import {
  BOT_LIMITS,
  isBotAvatar,
  type BotCreateInput,
  type BotDefinition,
  type BotUpdateInput,
} from "../../renderer/shared/bots.js";

interface BotState {
  version: 1;
  bots: BotDefinition[];
}

function cleanText(value: string, maximum: number, required: boolean): string | undefined {
  const text = value.trim();
  if ((required && !text) || text.length > maximum) return undefined;
  return text || undefined;
}

function projectBot(value: unknown): BotDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bot = value as Record<string, unknown>;
  if (!(
    typeof bot.id === "string" &&
    bot.id.length > 0 &&
    bot.id.length <= BOT_LIMITS.idChars &&
    bot.id.normalize("NFKC") === bot.id &&
    /^[A-Za-z0-9._:-]+$/u.test(bot.id) &&
    typeof bot.name === "string" &&
    cleanText(bot.name, BOT_LIMITS.nameChars, true) !== undefined &&
    (bot.description === undefined ||
      (typeof bot.description === "string" &&
        cleanText(bot.description, BOT_LIMITS.descriptionChars, false) !== undefined)) &&
    typeof bot.instructions === "string" &&
    cleanText(bot.instructions, BOT_LIMITS.instructionsChars, true) !== undefined &&
    isBotAvatar(bot.avatar) &&
    typeof bot.createdAt === "number" &&
    Number.isSafeInteger(bot.createdAt) &&
    typeof bot.updatedAt === "number" &&
    Number.isSafeInteger(bot.updatedAt) &&
    (bot.archivedAt === undefined ||
      (typeof bot.archivedAt === "number" && Number.isSafeInteger(bot.archivedAt)))
  )) return null;
  return {
    id: bot.id as string,
    name: (bot.name as string).trim(),
    ...("description" in bot && typeof bot.description === "string"
      ? { description: bot.description.trim() }
      : {}),
    instructions: (bot.instructions as string).trim(),
    avatar: bot.avatar as BotDefinition["avatar"],
    createdAt: bot.createdAt as number,
    updatedAt: bot.updatedAt as number,
    ...(typeof bot.archivedAt === "number" ? { archivedAt: bot.archivedAt } : {}),
  };
}

function normalizeState(value: unknown): BotState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, bots: [] };
  }
  const raw = value as { bots?: unknown };
  const seen = new Set<string>();
  const bots: BotDefinition[] = [];
  if (Array.isArray(raw.bots)) {
    for (const entry of raw.bots) {
      const projected = projectBot(entry);
      if (!projected || seen.has(projected.id)) continue;
      seen.add(projected.id);
      bots.push(projected);
    }
  }
  return { version: 1, bots: bots.slice(0, 256) };
}

function normalizeInput(input: BotCreateInput): BotCreateInput {
  const name = cleanText(input.name, BOT_LIMITS.nameChars, true);
  const description = cleanText(input.description ?? "", BOT_LIMITS.descriptionChars, false);
  const instructions = cleanText(input.instructions, BOT_LIMITS.instructionsChars, true);
  if (!name) throw new Error("Give this bot a name.");
  if (input.description !== undefined && input.description.trim() && !description)
    throw new Error("Bot description is too long.");
  if (!instructions) throw new Error("Give this bot instructions.");
  if (!isBotAvatar(input.avatar)) throw new Error("Choose a valid bot avatar.");
  return { name, description, instructions, avatar: input.avatar };
}

export function createBotStore(options: { root(): string; now?: () => number }) {
  const store = new DataStore<BotState>("bots.json", { version: 1, bots: [] }, options.root, {
    maxBytes: 2 * 1024 * 1024,
    fileMode: 0o600,
    preserveCorruptFile: true,
    normalize: normalizeState,
  });
  const now = options.now ?? Date.now;
  const list = async (includeArchived = false) =>
    structuredClone((await store.load()).bots)
      .filter((bot) => includeArchived || bot.archivedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    list,
    async get(id: string): Promise<BotDefinition | null> {
      return (await list(true)).find((bot) => bot.id === id) ?? null;
    },
    async create(input: BotCreateInput): Promise<BotDefinition> {
      const normalized = normalizeInput(input);
      const timestamp = now();
      const bot: BotDefinition = {
        id: randomUUID(),
        ...normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await store.update((draft) => {
        if (draft.bots.length >= 256) throw new Error("Aiden supports up to 256 bots.");
        draft.bots.push(bot);
      });
      return structuredClone(bot);
    },
    async update(input: BotUpdateInput): Promise<BotDefinition> {
      const normalized = normalizeInput(input);
      return store.update((draft) => {
        const bot = draft.bots.find((entry) => entry.id === input.id);
        if (!bot) throw new Error("This bot is no longer available.");
        Object.assign(bot, normalized, { updatedAt: now() });
        return structuredClone(bot);
      });
    },
    async archive(id: string): Promise<BotDefinition> {
      return store.update((draft) => {
        const bot = draft.bots.find((entry) => entry.id === id);
        if (!bot) throw new Error("This bot is no longer available.");
        bot.archivedAt = bot.archivedAt ?? now();
        bot.updatedAt = now();
        return structuredClone(bot);
      });
    },
    async restore(id: string): Promise<BotDefinition> {
      return store.update((draft) => {
        const bot = draft.bots.find((entry) => entry.id === id);
        if (!bot) throw new Error("This bot is no longer available.");
        delete bot.archivedAt;
        bot.updatedAt = now();
        return structuredClone(bot);
      });
    },
  };
}

export type BotStore = ReturnType<typeof createBotStore>;
