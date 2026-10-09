import { createHash, randomUUID } from "node:crypto";
import { DataStore } from "./data-store.js";
import {
  BOT_LIMITS,
  DEFAULT_BOT_AVATAR,
  isBotAvatar,
  isBotAvatarAppearance,
  type BotAvatarAppearance,
  type BotCreateInput,
  type BotDefinition,
  type BotUpdateInput,
} from "../../renderer/shared/bots.js";
import { isBoundedBotText } from "../../renderer/shared/bot-capabilities.js";

/*
 * Pre-1.0, no migrations: the record stores the current avatar recipe
 * directly. A record whose avatar is not a current recipe (an older id such
 * as "spark", or a recipe with retired axes) reads as `DEFAULT_BOT_AVATAR`;
 * the next edit writes the current shape. Nothing else is carried forward.
 */

type StoredBotDefinition = Omit<BotDefinition, "revision" | "archivedAt"> & {
  /**
   * Archive marker from releases that archived instead of deleting. A record
   * carrying it is a deleted Bot: it never leaves the store and startup erases
   * it through Bot delete (`legacyArchivedIds`).
   */
  archivedAt?: number;
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

function botForRenderer(bot: StoredBotDefinition): BotDefinition {
  const { archivedAt: _archivedAt, ...stored } = bot;
  return { ...stored, revision: botIdentityRevision(bot), avatar: { ...bot.avatar } };
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
      typeof bot.createdAt === "number" &&
      Number.isSafeInteger(bot.createdAt) &&
      typeof bot.updatedAt === "number" &&
      Number.isSafeInteger(bot.updatedAt) &&
      (bot.archivedAt === undefined ||
        (typeof bot.archivedAt === "number" && Number.isSafeInteger(bot.archivedAt)))
    )
  )
    return null;
  const avatar: BotAvatarAppearance = isBotAvatarAppearance(bot.avatar)
    ? { version: 1, shape: bot.avatar.shape, color: bot.avatar.color }
    : { ...DEFAULT_BOT_AVATAR };
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
  const now = options.now ?? Date.now;
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

  const queueMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const createWithId = (id: string, input: BotCreateInput): Promise<BotDefinition> =>
    queueMutation(async () => {
      assertBotId(id);
      const normalized = normalizeInput(input);
      const timestamp = nextIdentityTimestamp(-1, now);
      const bot: StoredBotDefinition = {
        id,
        name: normalized.name,
        ...(normalized.description ? { description: normalized.description } : {}),
        instructions: normalized.instructions,
        ...(normalized.openingGreeting
          ? { openingGreeting: normalized.openingGreeting }
          : {}),
        avatar: { version: 1, shape: normalized.avatar.shape, color: normalized.avatar.color },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await store.update((draft) => {
        if (draft.bots.some((entry) => entry.id === id)) {
          throw new Error("A bot with this identity already exists.");
        }
        if (draft.bots.length >= 256) throw new Error("Aiden supports up to 256 bots.");
        draft.bots.push(bot);
      });
      return structuredClone(botForRenderer(bot));
    });

  /** Live Bots, newest first. Legacy archived records are deleted Bots and never listed. */
  const list = () =>
    queueMutation(async () =>
      structuredClone((await loadBotState()).bots)
        .filter((bot) => bot.archivedAt === undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(botForRenderer),
    );

  return {
    list,
    async get(id: string): Promise<BotDefinition | null> {
      return (await list()).find((bot) => bot.id === id) ?? null;
    },
    create(input: BotCreateInput): Promise<BotDefinition> {
      return createWithId(randomUUID(), input);
    },
    createWithId,
    async update(input: BotUpdateInput): Promise<BotDefinition> {
      return queueMutation(async () => {
        const normalized = normalizeInput(input);
        await loadBotState();
        return store.update((draft) => {
          const bot = draft.bots.find((entry) => entry.id === input.id);
          if (!bot || bot.archivedAt !== undefined) throw new Error("This bot is no longer available.");
          if (botIdentityRevision(bot) !== input.expectedRevision) {
            throw new BotIdentityRevisionConflictError(botIdentityRevision(bot));
          }
          bot.name = normalized.name;
          bot.instructions = normalized.instructions;
          if (normalized.openingGreeting) bot.openingGreeting = normalized.openingGreeting;
          else delete bot.openingGreeting;
          if (normalized.description) bot.description = normalized.description;
          else delete bot.description;
          bot.avatar = { version: 1, shape: normalized.avatar.shape, color: normalized.avatar.color };
          bot.updatedAt = nextIdentityTimestamp(bot.updatedAt, now);
          return structuredClone(botForRenderer(bot));
        });
      });
    },
    /**
     * Ids of every stored record, including legacy archived ones. Startup
     * bootstrap checks need the full inventory; nothing else should.
     */
    async storedIds(): Promise<string[]> {
      return queueMutation(async () => (await loadBotState()).bots.map(({ id }) => id));
    },
    /** Records a previous release archived. Startup erases them as deleted Bots. */
    async legacyArchivedIds(): Promise<string[]> {
      return queueMutation(async () =>
        (await loadBotState()).bots.filter((bot) => bot.archivedAt !== undefined).map(({ id }) => id),
      );
    },
    /** Hard-delete a Bot record. Idempotent: returns false when the record was already gone. */
    async delete(id: string): Promise<boolean> {
      return queueMutation(async () => {
        assertBotId(id);
        if (!(await loadBotState()).bots.some((entry) => entry.id === id)) return false;
        return store.update((draft) => {
          const before = draft.bots.length;
          draft.bots = draft.bots.filter((entry) => entry.id !== id);
          return draft.bots.length !== before;
        });
      });
    },
  };
}

export type BotStore = ReturnType<typeof createBotStore>;
