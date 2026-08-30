import { createHash, randomUUID } from "node:crypto";
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
import { isBoundedBotText } from "../../renderer/shared/bot-capabilities.js";

type StoredBotDefinition = Omit<BotDefinition, "avatar" | "revision"> & {
  /** Kept as a legacy id so the previous release never drops this bot on rollback. */
  avatar: LegacyBotAvatar;
  /** Transitional inline copy migrated into the rollback-safe companion store on read. */
  avatarAppearance?: BotAvatarAppearance;
};

export class BotIdentityRevisionConflictError extends Error {
  constructor(readonly currentRevision: string) {
    super("This Bot changed on another surface. Refresh it and try again.");
    this.name = "BotIdentityRevisionConflictError";
  }
}

function botIdentityRevision(bot: StoredBotDefinition): string {
  return `botrev_${createHash("sha256")
    .update(JSON.stringify(bot), "utf8")
    .digest("base64url")}`;
}

interface BotState {
  version: 1;
  bots: StoredBotDefinition[];
}

interface StoredBotAppearance {
  botId: string;
  /** Legacy projection last written with this recipe; detects older-release avatar edits. */
  legacyAvatar: LegacyBotAvatar;
  /** Commit marker derived only from the primary record's avatar fields. */
  primaryRevision?: string;
  /** Written only after the primary record commits the same recipe. */
  committedRevision?: string;
  avatar: BotAvatarAppearance;
}

function botAppearanceRecipeRevision(botId: string, avatar: BotAvatarAppearance): string {
  return `botavatar_${createHash("sha256")
    .update(JSON.stringify({
      botId,
      legacyAvatar: legacyAvatarFor(avatar),
      avatar,
    }), "utf8")
    .digest("base64url")}`;
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
    left.primaryRevision === right.primaryRevision &&
    left.committedRevision === right.committedRevision &&
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
  return {
    ...stored,
    revision: botIdentityRevision(bot),
    avatar: appearance ? { ...appearance } : stored.avatar,
  };
}

function cleanText(value: string, maximum: number, required: boolean): string | undefined {
  const text = value.trim();
  if ((required && !text) || (text && !isBoundedBotText(text, maximum))) return undefined;
  return text || undefined;
}

function assertBotId(id: string): void {
  if (
    id.length === 0 ||
    id.length > BOT_LIMITS.idChars ||
    id.normalize("NFKC") !== id ||
    !/^[A-Za-z0-9._:-]+$/u.test(id)
  ) {
    throw new Error("Invalid bot id.");
  }
}

function nextIdentityTimestamp(previous: number, now: () => number): number {
  const observed = now();
  if (!Number.isSafeInteger(observed) || observed < 0) {
    throw new Error("Bot identity clock is invalid.");
  }
  if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Bot identity revision clock is exhausted.");
  }
  return Math.max(observed, previous + 1);
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
      (bot.openingGreeting === undefined ||
        (typeof bot.openingGreeting === "string" &&
          cleanText(bot.openingGreeting, BOT_LIMITS.openingGreetingChars, false) !== undefined)) &&
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
  const projected = {
    id: bot.id as string,
    name: (bot.name as string).trim(),
    ...("description" in bot && typeof bot.description === "string"
      ? { description: bot.description.trim() }
      : {}),
    instructions: (bot.instructions as string).trim(),
    ...(typeof bot.openingGreeting === "string"
      ? { openingGreeting: bot.openingGreeting.trim() }
      : {}),
    avatar,
    ...(appearance ? { avatarAppearance: { ...appearance } } : {}),
    createdAt: bot.createdAt as number,
    updatedAt: bot.updatedAt as number,
    ...(typeof bot.archivedAt === "number" ? { archivedAt: bot.archivedAt } : {}),
  };
  return projected;
}

function normalizeState(value: unknown): BotState {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { bots?: unknown }).bots)
  ) {
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

function isSafeBotState(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { bots?: unknown }).bots),
  );
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
        !isBotAvatarAppearance(candidate.avatar) ||
        (candidate.primaryRevision !== undefined &&
          (typeof candidate.primaryRevision !== "string" ||
            !/^botavatar_[A-Za-z0-9_-]{43}$/u.test(candidate.primaryRevision))) ||
        (candidate.committedRevision !== undefined &&
          (typeof candidate.committedRevision !== "string" ||
            !/^botavatar_[A-Za-z0-9_-]{43}$/u.test(candidate.committedRevision)))
      ) {
        continue;
      }
      seen.add(candidate.botId);
      appearances.push({
        botId: candidate.botId,
        legacyAvatar,
        ...(typeof candidate.primaryRevision === "string" &&
        /^botavatar_[A-Za-z0-9_-]{43}$/u.test(candidate.primaryRevision)
          ? { primaryRevision: candidate.primaryRevision }
          : {}),
        ...(typeof candidate.committedRevision === "string" &&
        /^botavatar_[A-Za-z0-9_-]{43}$/u.test(candidate.committedRevision)
          ? { committedRevision: candidate.committedRevision }
          : {}),
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
  const openingGreeting = cleanText(
    input.openingGreeting ?? "",
    BOT_LIMITS.openingGreetingChars,
    false,
  );
  if (!name) throw new Error("Give this bot a name.");
  if (input.description !== undefined && input.description.trim() && !description)
    throw new Error("Bot description is too long.");
  if (!instructions) throw new Error("Give this bot instructions.");
  if (input.openingGreeting !== undefined && input.openingGreeting.trim() && !openingGreeting)
    throw new Error("Bot opening greeting is too long.");
  if (!isBotAvatar(input.avatar)) throw new Error("Choose a valid bot avatar.");
  return {
    name,
    description,
    instructions,
    ...(openingGreeting ? { openingGreeting } : {}),
    avatar: input.avatar,
  };
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
    isSafe: isSafeBotState,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
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

  const loadBotState = async (): Promise<BotState> => {
    const state = await store.load();
    if (await store.loadedFromCorruptFile()) {
      throw new Error("Bot identity storage is unreadable and was preserved.");
    }
    if (await store.loadedFromUnsafeFile()) {
      throw new Error("Bot identity storage has an unsupported version and was preserved.");
    }
    return state;
  };

  const appearanceFor = (state: BotAppearanceState, bot: StoredBotDefinition) => {
    const entry = state.appearances.find((candidate) => candidate.botId === bot.id);
    const revision = entry ? botAppearanceRecipeRevision(bot.id, entry.avatar) : undefined;
    return entry?.legacyAvatar === bot.avatar &&
      entry.primaryRevision === revision &&
      entry.committedRevision === revision
      ? entry.avatar
      : undefined;
  };

  const ensureAppearanceMigration = async () => {
    if (!migrationPromise) {
      migrationPromise = (async () => {
        let [botState, appearanceState] = await Promise.all([
          loadBotState(),
          appearanceStore.load(),
        ]);
        const existingByBot = new Map(
          appearanceState.appearances.map((entry) => [entry.botId, entry] as const),
        );
        const primaryBackfills = new Map(
          botState.bots.flatMap((bot): Array<[string, BotAvatarAppearance]> => {
            const existing = existingByBot.get(bot.id);
            return !bot.avatarAppearance &&
              existing?.legacyAvatar === bot.avatar &&
              ((existing.primaryRevision === undefined &&
                existing.committedRevision === undefined) ||
                (existing.primaryRevision === existing.committedRevision &&
                  existing.primaryRevision ===
                    botAppearanceRecipeRevision(bot.id, existing.avatar)))
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
          botState = await loadBotState();
        }
        const reconciled = botState.bots.flatMap((bot): StoredBotAppearance[] => {
          const inline =
            bot.avatarAppearance && legacyAvatarFor(bot.avatarAppearance) === bot.avatar
              ? bot.avatarAppearance
              : undefined;
          if (inline) {
            const revision = botAppearanceRecipeRevision(bot.id, inline);
            return [
              {
                botId: bot.id,
                legacyAvatar: bot.avatar,
                primaryRevision: revision,
                committedRevision: revision,
                avatar: { ...inline },
              },
            ];
          }
          const existing = existingByBot.get(bot.id);
          return existing?.legacyAvatar === bot.avatar &&
            ((existing.primaryRevision === undefined &&
              existing.committedRevision === undefined) ||
              (existing.primaryRevision === existing.committedRevision &&
                existing.primaryRevision ===
                  botAppearanceRecipeRevision(bot.id, existing.avatar)))
            ? (() => {
                const revision = botAppearanceRecipeRevision(bot.id, existing.avatar);
                return [{ ...existing, primaryRevision: revision, committedRevision: revision }];
              })()
            : [];
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

  const setAppearance = async (
    botId: string,
    avatar?: BotAvatarAppearance,
    committedRevision?: string,
  ) =>
    appearanceStore.update((draft) => {
      const index = draft.appearances.findIndex((entry) => entry.botId === botId);
      if (!avatar) {
        if (index >= 0) draft.appearances.splice(index, 1);
        return;
      }
      const next = {
        botId,
        legacyAvatar: legacyAvatarFor(avatar),
        primaryRevision: botAppearanceRecipeRevision(botId, avatar),
        ...(committedRevision ? { committedRevision } : {}),
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

  const createWithId = (id: string, input: BotCreateInput): Promise<BotDefinition> =>
    queueMutation(async () => {
      assertBotId(id);
      await ensureAppearanceMigration();
      const normalized = normalizeInput(input);
      const existing = (await loadBotState()).bots;
      if (existing.some((entry) => entry.id === id)) {
        throw new Error("A bot with this identity already exists.");
      }
      if (existing.length >= 256) {
        throw new Error("Aiden supports up to 256 bots.");
      }
      const timestamp = nextIdentityTimestamp(-1, now);
      const bot: StoredBotDefinition = {
        id,
        name: normalized.name,
        ...(normalized.description ? { description: normalized.description } : {}),
        instructions: normalized.instructions,
        ...(normalized.openingGreeting
          ? { openingGreeting: normalized.openingGreeting }
          : {}),
        ...storedAvatar(normalized.avatar),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const appearance = isBotAvatarAppearance(normalized.avatar)
        ? normalized.avatar
        : undefined;
      if (appearance) {
        await setAppearance(bot.id, appearance);
      }
      try {
        await store.update((draft) => {
          if (draft.bots.some((entry) => entry.id === id)) {
            throw new Error("A bot with this identity already exists.");
          }
          if (draft.bots.length >= 256) throw new Error("Aiden supports up to 256 bots.");
          draft.bots.push(bot);
        });
        if (appearance) {
          await setAppearance(bot.id, appearance, botAppearanceRecipeRevision(bot.id, appearance));
        }
      } catch (error) {
        if (appearance) await setAppearance(bot.id).catch(() => undefined);
        throw error;
      }
      return structuredClone(botForRenderer(bot, appearance));
    });

  const list = (includeArchived = false) =>
    queueMutation(async () => {
      await ensureAppearanceMigration();
      const [botState, appearanceState] = await Promise.all([
        loadBotState(),
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
    create(input: BotCreateInput): Promise<BotDefinition> {
      return createWithId(randomUUID(), input);
    },
    createWithId,
    async update(input: BotUpdateInput): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const normalized = normalizeInput(input);
        if (!(await loadBotState()).bots.some((entry) => entry.id === input.id)) {
          throw new Error("This bot is no longer available.");
        }
        const appearanceState = await appearanceStore.load();
        const existingBot = (await loadBotState()).bots.find((entry) => entry.id === input.id)!;
        if (botIdentityRevision(existingBot) !== input.expectedRevision) {
          throw new BotIdentityRevisionConflictError(botIdentityRevision(existingBot));
        }
        const previousAppearance = appearanceFor(appearanceState, existingBot);
        const nextAppearance = isBotAvatarAppearance(normalized.avatar)
          ? normalized.avatar
          : undefined;
        const targetBot: StoredBotDefinition = {
          ...existingBot,
          name: normalized.name,
          instructions: normalized.instructions,
          ...(normalized.openingGreeting
            ? { openingGreeting: normalized.openingGreeting }
            : { openingGreeting: undefined }),
          ...(normalized.description
            ? { description: normalized.description }
            : { description: undefined }),
          avatar: legacyAvatarFor(normalized.avatar),
          ...(nextAppearance
            ? { avatarAppearance: { ...nextAppearance } }
            : { avatarAppearance: undefined }),
          updatedAt: nextIdentityTimestamp(existingBot.updatedAt, now),
        };
        await setAppearance(
          input.id,
          nextAppearance,
          previousAppearance
            ? botAppearanceRecipeRevision(input.id, previousAppearance)
            : undefined,
        );
        try {
          await options.beforeBotWrite?.();
          const saved = await store.update((draft) => {
            const bot = draft.bots.find((entry) => entry.id === input.id);
            if (!bot) throw new Error("This bot is no longer available.");
            if (botIdentityRevision(bot) !== input.expectedRevision) {
              throw new BotIdentityRevisionConflictError(botIdentityRevision(bot));
            }
            bot.name = normalized.name;
            bot.instructions = normalized.instructions;
            if (normalized.openingGreeting) bot.openingGreeting = normalized.openingGreeting;
            else delete bot.openingGreeting;
            if (normalized.description) bot.description = normalized.description;
            else delete bot.description;
            bot.avatar = legacyAvatarFor(normalized.avatar);
            if (nextAppearance) bot.avatarAppearance = { ...nextAppearance };
            else delete bot.avatarAppearance;
            bot.updatedAt = targetBot.updatedAt;
            return structuredClone(botForRenderer(bot, nextAppearance));
          });
          if (nextAppearance) {
            await setAppearance(
              input.id,
              nextAppearance,
              botAppearanceRecipeRevision(input.id, nextAppearance),
            );
          }
          return saved;
        } catch (error) {
          await setAppearance(
            input.id,
            previousAppearance,
            previousAppearance
              ? botAppearanceRecipeRevision(input.id, previousAppearance)
              : undefined,
          ).catch(() => undefined);
          throw error;
        }
      });
    },
    async archive(id: string, expectedRevision: string): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const existingBot = (await loadBotState()).bots.find((entry) => entry.id === id);
        if (!existingBot) throw new Error("This bot is no longer available.");
        const appearance = appearanceFor(await appearanceStore.load(), existingBot);
        return store.update((draft) => {
          const bot = draft.bots.find((entry) => entry.id === id);
          if (!bot) throw new Error("This bot is no longer available.");
          if (botIdentityRevision(bot) !== expectedRevision) {
            throw new BotIdentityRevisionConflictError(botIdentityRevision(bot));
          }
          const timestamp = nextIdentityTimestamp(bot.updatedAt, now);
          bot.archivedAt = bot.archivedAt ?? timestamp;
          bot.updatedAt = timestamp;
          return structuredClone(botForRenderer(bot, appearance));
        });
      });
    },
    async restore(id: string, expectedRevision: string): Promise<BotDefinition> {
      return queueMutation(async () => {
        await ensureAppearanceMigration();
        const existingBot = (await loadBotState()).bots.find((entry) => entry.id === id);
        if (!existingBot) throw new Error("This bot is no longer available.");
        const appearance = appearanceFor(await appearanceStore.load(), existingBot);
        return store.update((draft) => {
          const bot = draft.bots.find((entry) => entry.id === id);
          if (!bot) throw new Error("This bot is no longer available.");
          if (botIdentityRevision(bot) !== expectedRevision) {
            throw new BotIdentityRevisionConflictError(botIdentityRevision(bot));
          }
          delete bot.archivedAt;
          bot.updatedAt = nextIdentityTimestamp(bot.updatedAt, now);
          return structuredClone(botForRenderer(bot, appearance));
        });
      });
    },
  };
}

export type BotStore = ReturnType<typeof createBotStore>;
