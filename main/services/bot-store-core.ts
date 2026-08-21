import { randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import {
  BOT_LIMITS,
  isBotAvatar,
  isBotAvatarAppearance,
  isLegacyBotAvatar,
  type BotAvatar,
  type BotAvatarAppearance,
  type BotCreateInput,
  type BotDefinition,
  type BotUpdateInput,
  type LegacyBotAvatar,
} from "../../renderer/shared/bots.js";

type StoredBotDefinition = Omit<BotDefinition, "avatar"> & {
  /** Kept as a legacy id so the previous release never drops this bot on rollback. */
  avatar: LegacyBotAvatar;
  /** Transitional inline copy migrated into the rollback-safe companion store on read. */
  avatarAppearance?: BotAvatarAppearance;
};

interface BotState {
  version: 1;
  bots: StoredBotDefinition[];
}

interface StoredBotAppearance {
  botId: string;
  /** Legacy projection last written with this recipe; detects older-release avatar edits. */
  legacyAvatar: LegacyBotAvatar;
  avatar: BotAvatarAppearance;
}

interface BotAppearanceState {
  version: 1;
  appearances: StoredBotAppearance[];
}

function sameAppearance(left: BotAvatarAppearance, right: BotAvatarAppearance): boolean {
  return (
    left.version === right.version &&
    left.shape === right.shape &&
    left.color === right.color &&
    left.eyes === right.eyes &&
    left.detail === right.detail
  );
}

function sameStoredAppearance(left: StoredBotAppearance, right: StoredBotAppearance): boolean {
  return (
    left.botId === right.botId &&
    left.legacyAvatar === right.legacyAvatar &&
    sameAppearance(left.avatar, right.avatar)
  );
}

function legacyAvatarFor(avatar: BotAvatar): LegacyBotAvatar {
  if (isLegacyBotAvatar(avatar)) return avatar;
  return {
    wisp: "spark",
    orb: "orbit",
    drop: "leaf",
    hex: "prism",
    cloud: "wave",
    peak: "ember",
    squircle: "spark",
    capsule: "spark",
  }[avatar.shape] as LegacyBotAvatar;
}

function storedAvatar(avatar: BotAvatar): Pick<StoredBotDefinition, "avatar" | "avatarAppearance"> {
  return isBotAvatarAppearance(avatar)
    ? { avatar: legacyAvatarFor(avatar), avatarAppearance: { ...avatar } }
    : { avatar };
}

function botForRenderer(
  bot: StoredBotDefinition,
  durableAppearance?: BotAvatarAppearance,
): BotDefinition {
  const { avatarAppearance, ...stored } = bot;
  const compatibleInlineAppearance =
    avatarAppearance && legacyAvatarFor(avatarAppearance) === stored.avatar
      ? avatarAppearance
      : undefined;
  // The primary record is the commit point. A companion write can survive a crash
  // before that commit, so a compatible inline recipe must remain authoritative.
  const appearance = compatibleInlineAppearance ?? durableAppearance;
  return { ...stored, avatar: appearance ? { ...appearance } : stored.avatar };
}

function cleanText(value: string, maximum: number, required: boolean): string | undefined {
  const text = value.trim();
  if ((required && !text) || text.length > maximum) return undefined;
  return text || undefined;
}

function projectBot(value: unknown): StoredBotDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bot = value as Record<string, unknown>;
  if (
    !(
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
      (isLegacyBotAvatar(bot.avatar) || isBotAvatarAppearance(bot.avatar)) &&
      typeof bot.createdAt === "number" &&
      Number.isSafeInteger(bot.createdAt) &&
      typeof bot.updatedAt === "number" &&
      Number.isSafeInteger(bot.updatedAt) &&
      (bot.archivedAt === undefined ||
        (typeof bot.archivedAt === "number" && Number.isSafeInteger(bot.archivedAt)))
    )
  )
    return null;
  const appearance = isBotAvatarAppearance(bot.avatarAppearance)
    ? bot.avatarAppearance
    : isBotAvatarAppearance(bot.avatar)
      ? bot.avatar
      : undefined;
  const avatar = isLegacyBotAvatar(bot.avatar)
    ? bot.avatar
    : legacyAvatarFor(bot.avatar as BotAvatarAppearance);
  return {
    id: bot.id as string,
    name: (bot.name as string).trim(),
    ...("description" in bot && typeof bot.description === "string"
      ? { description: bot.description.trim() }
      : {}),
    instructions: (bot.instructions as string).trim(),
    avatar,
    ...(appearance ? { avatarAppearance: { ...appearance } } : {}),
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
  const bots: StoredBotDefinition[] = [];
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

function normalizeAppearanceState(value: unknown): BotAppearanceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, appearances: [] };
  }
  const raw = value as { appearances?: unknown };
  const seen = new Set<string>();
  const appearances: StoredBotAppearance[] = [];
  if (Array.isArray(raw.appearances)) {
    for (const entry of raw.appearances) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as Record<string, unknown>;
      const legacyAvatar = isLegacyBotAvatar(candidate.legacyAvatar)
        ? candidate.legacyAvatar
        : isBotAvatarAppearance(candidate.avatar)
          ? legacyAvatarFor(candidate.avatar)
          : undefined;
      if (
        typeof candidate.botId !== "string" ||
        candidate.botId.length === 0 ||
        candidate.botId.length > BOT_LIMITS.idChars ||
        candidate.botId.normalize("NFKC") !== candidate.botId ||
        !/^[A-Za-z0-9._:-]+$/u.test(candidate.botId) ||
        seen.has(candidate.botId) ||
        !legacyAvatar ||
        !isBotAvatarAppearance(candidate.avatar)
      ) {
        continue;
      }
      seen.add(candidate.botId);
      appearances.push({
        botId: candidate.botId,
        legacyAvatar,
        avatar: { ...candidate.avatar },
      });
    }
  }
  return { version: 1, appearances: appearances.slice(0, 256) };
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

export function createBotStore(options: {
  root(): string;
  now?: () => number;
  /** Test seam for proving companion/primary publication remains one visible operation. */
  beforeBotWrite?: () => Promise<void>;
}) {
  const store = new DataStore<BotState>("bots.json", { version: 1, bots: [] }, options.root, {
    maxBytes: 2 * 1024 * 1024,
    fileMode: 0o600,
    preserveCorruptFile: true,
    normalize: normalizeState,
  });
  const appearanceStore = new DataStore<BotAppearanceState>(
    "bot-avatar-appearances.json",
    { version: 1, appearances: [] },
    options.root,
    {
      maxBytes: 512 * 1024,
      fileMode: 0o600,
      preserveCorruptFile: true,
      normalize: normalizeAppearanceState,
    },
  );
  const now = options.now ?? Date.now;
  let migrationPromise: Promise<void> | null = null;
  let mutationTail: Promise<void> = Promise.resolve();

  const appearanceFor = (state: BotAppearanceState, bot: StoredBotDefinition) => {
    const entry = state.appearances.find((candidate) => candidate.botId === bot.id);
    return entry?.legacyAvatar === bot.avatar ? entry.avatar : undefined;
  };

  const ensureAppearanceMigration = async () => {
    if (!migrationPromise) {
      migrationPromise = (async () => {
        const [botState, appearanceState] = await Promise.all([
          store.load(),
          appearanceStore.load(),
        ]);
        const existingByBot = new Map(
          appearanceState.appearances.map((entry) => [entry.botId, entry] as const),
        );
        const primaryBackfills = new Map(
          botState.bots.flatMap((bot): Array<[string, BotAvatarAppearance]> => {
            const existing = existingByBot.get(bot.id);
            return !bot.avatarAppearance && existing?.legacyAvatar === bot.avatar
              ? [[bot.id, existing.avatar]]
              : [];
          }),
        );
        if (primaryBackfills.size > 0) {
          // Establish a primary-file commit marker before any later companion-first
          // update, including immediately after a previous release stripped it.
          await store.update((draft) => {
            for (const bot of draft.bots) {
              const appearance = primaryBackfills.get(bot.id);
              if (!bot.avatarAppearance && appearance) {
                bot.avatarAppearance = { ...appearance };
              }
            }
          });
        }
        const reconciled = botState.bots.flatMap((bot): StoredBotAppearance[] => {
          const inline =
            bot.avatarAppearance && legacyAvatarFor(bot.avatarAppearance) === bot.avatar
              ? bot.avatarAppearance
              : undefined;
          if (inline) {
            return [
              {
                botId: bot.id,
                legacyAvatar: bot.avatar,
                avatar: { ...inline },
              },
            ];
          }
          const existing = existingByBot.get(bot.id);
          return existing?.legacyAvatar === bot.avatar ? [existing] : [];
        });
        const unchanged =
          reconciled.length === appearanceState.appearances.length &&
          reconciled.every((entry, index) =>
            sameStoredAppearance(entry, appearanceState.appearances[index]!),
          );
        if (unchanged) return;
        await appearanceStore.update((draft) => {
          draft.appearances = reconciled.map((entry) => ({
            ...entry,
            avatar: { ...entry.avatar },
          }));
        });
      })();
    }
    try {
      await migrationPromise;
    } catch (error) {
      migrationPromise = null;
      throw error;
    }
  };

  const queueMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const setAppearance = async (botId: string, avatar?: BotAvatarAppearance) =>
    appearanceStore.update((draft) => {
      const index = draft.appearances.findIndex((entry) => entry.botId === botId);
      if (!avatar) {
        if (index >= 0) draft.appearances.splice(index, 1);
        return;
      }
      const next = {
        botId,
        legacyAvatar: legacyAvatarFor(avatar),
        avatar: { ...avatar },
      };
      if (index >= 0) draft.appearances[index] = next;
      else {
        if (draft.appearances.length >= 256) {
          throw new Error("Aiden supports up to 256 bot appearances.");
        }
        draft.appearances.push(next);
      }
    });

  const list = (includeArchived = false) =>
    queueMutation(async () => {
      await ensureAppearanceMigration();
      const [botState, appearanceState] = await Promise.all([
        store.load(),
        appearanceStore.load(),
      ]);
      return structuredClone(botState.bots)
        .filter((bot) => includeArchived || bot.archivedAt === undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((bot) => botForRenderer(bot, appearanceFor(appearanceState, bot)));
    });

  return {
    list,
    async get(id: string): Promise<BotDefinition | null> {
      return (await list(true)).find((bot) => bot.id === id) ?? null;
    },
    async create(input: BotCreateInput): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const normalized = normalizeInput(input);
        if ((await store.load()).bots.length >= 256) {
          throw new Error("Aiden supports up to 256 bots.");
        }
        const timestamp = now();
        const bot: StoredBotDefinition = {
          id: randomUUID(),
          name: normalized.name,
          ...(normalized.description ? { description: normalized.description } : {}),
          instructions: normalized.instructions,
          ...storedAvatar(normalized.avatar),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const appearance = isBotAvatarAppearance(normalized.avatar)
          ? normalized.avatar
          : undefined;
        if (appearance) await setAppearance(bot.id, appearance);
        try {
          await store.update((draft) => {
            if (draft.bots.length >= 256) throw new Error("Aiden supports up to 256 bots.");
            draft.bots.push(bot);
          });
        } catch (error) {
          if (appearance) await setAppearance(bot.id).catch(() => undefined);
          throw error;
        }
        return structuredClone(botForRenderer(bot, appearance));
      });
    },
    async update(input: BotUpdateInput): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const normalized = normalizeInput(input);
        if (!(await store.load()).bots.some((entry) => entry.id === input.id)) {
          throw new Error("This bot is no longer available.");
        }
        const appearanceState = await appearanceStore.load();
        const existingBot = (await store.load()).bots.find((entry) => entry.id === input.id)!;
        const previousAppearance = appearanceFor(appearanceState, existingBot);
        const nextAppearance = isBotAvatarAppearance(normalized.avatar)
          ? normalized.avatar
          : undefined;
        await setAppearance(input.id, nextAppearance);
        try {
          await options.beforeBotWrite?.();
          return await store.update((draft) => {
            const bot = draft.bots.find((entry) => entry.id === input.id);
            if (!bot) throw new Error("This bot is no longer available.");
            bot.name = normalized.name;
            bot.instructions = normalized.instructions;
            if (normalized.description) bot.description = normalized.description;
            else delete bot.description;
            bot.avatar = legacyAvatarFor(normalized.avatar);
            if (nextAppearance) bot.avatarAppearance = { ...nextAppearance };
            else delete bot.avatarAppearance;
            bot.updatedAt = now();
            return structuredClone(botForRenderer(bot, nextAppearance));
          });
        } catch (error) {
          await setAppearance(input.id, previousAppearance).catch(() => undefined);
          throw error;
        }
      });
    },
    async archive(id: string): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const existingBot = (await store.load()).bots.find((entry) => entry.id === id);
        if (!existingBot) throw new Error("This bot is no longer available.");
        const appearance = appearanceFor(await appearanceStore.load(), existingBot);
        return store.update((draft) => {
          const bot = draft.bots.find((entry) => entry.id === id);
          if (!bot) throw new Error("This bot is no longer available.");
          bot.archivedAt = bot.archivedAt ?? now();
          bot.updatedAt = now();
          return structuredClone(botForRenderer(bot, appearance));
        });
      });
    },
    async restore(id: string): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const existingBot = (await store.load()).bots.find((entry) => entry.id === id);
        if (!existingBot) throw new Error("This bot is no longer available.");
        const appearance = appearanceFor(await appearanceStore.load(), existingBot);
        return store.update((draft) => {
          const bot = draft.bots.find((entry) => entry.id === id);
          if (!bot) throw new Error("This bot is no longer available.");
          delete bot.archivedAt;
          bot.updatedAt = now();
          return structuredClone(botForRenderer(bot, appearance));
        });
      });
    },
  };
}

export type BotStore = ReturnType<typeof createBotStore>;
