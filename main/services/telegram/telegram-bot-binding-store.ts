import { randomUUID } from "node:crypto";
import { DataStore } from "../data-store.js";

/**
 * The durable identity that connects one Telegram target to one Aiden bot.
 *
 * The backing chat id is deliberately generated and persisted.  It must not
 * be derived from a Telegram owner, because one owner can pair multiple
 * profiles and because a bot may move between Telegram targets over time.
 */
export interface TelegramBotBinding {
  botId: string;
  profile: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  workspaceId: string;
  backingChatId: string;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface TelegramBotBindingInput {
  botId: string;
  profile: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  workspaceId: string;
}

export const TELEGRAM_BOT_BINDING_LIMITS = {
  profileChars: 32,
  botIdChars: 160,
  workspaceIdChars: 160,
  backingChatIdChars: 64,
  maxBindings: 256,
} as const;

const PROFILE_PATTERN = /^[a-z0-9]{1,32}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const BACKING_CHAT_ID_PATTERN =
  /^telegram-bot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface TelegramBotBindingState {
  version: 1;
  bindings: TelegramBotBinding[];
}

export type TelegramBotBindingListOptions =
  | boolean
  | { includeDisabled?: boolean };

function includeDisabled(options: TelegramBotBindingListOptions): boolean {
  return typeof options === "boolean"
    ? options
    : options.includeDisabled === true;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
}

function validPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validBotId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TELEGRAM_BOT_BINDING_LIMITS.botIdChars &&
    value.normalize("NFKC") === value &&
    ID_PATTERN.test(value)
  );
}

function validWorkspaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TELEGRAM_BOT_BINDING_LIMITS.workspaceIdChars &&
    value.normalize("NFKC") === value &&
    ID_PATTERN.test(value)
  );
}

function validProfile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TELEGRAM_BOT_BINDING_LIMITS.profileChars &&
    PROFILE_PATTERN.test(value)
  );
}

function validBackingChatId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TELEGRAM_BOT_BINDING_LIMITS.backingChatIdChars &&
    BACKING_CHAT_ID_PATTERN.test(value)
  );
}

function validThreadId(value: unknown): value is number {
  return validPositiveId(value);
}

/** A stable key for the exact Telegram route; omitted thread means a DM. */
export function telegramBotBindingTargetKey(
  profile: string,
  chatId: number,
  threadId?: number,
): string {
  return JSON.stringify([profile, chatId, threadId ?? "dm"]);
}

function projectBinding(value: unknown): TelegramBotBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !validBotId(raw.botId) ||
    !validProfile(raw.profile) ||
    !validChatId(raw.chatId) ||
    (raw.threadId !== undefined && !validThreadId(raw.threadId)) ||
    !validPositiveId(raw.ownerUserId) ||
    !validWorkspaceId(raw.workspaceId) ||
    !validBackingChatId(raw.backingChatId) ||
    !validTimestamp(raw.createdAt) ||
    !validTimestamp(raw.updatedAt) ||
    typeof raw.enabled !== "boolean"
  ) {
    return null;
  }

  return {
    botId: raw.botId,
    profile: raw.profile,
    chatId: raw.chatId,
    ...(raw.threadId === undefined ? {} : { threadId: raw.threadId }),
    ownerUserId: raw.ownerUserId,
    workspaceId: raw.workspaceId,
    backingChatId: raw.backingChatId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    enabled: raw.enabled,
  };
}

function normalizeState(value: unknown): TelegramBotBindingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, bindings: [] };
  }
  const raw = value as { bindings?: unknown };
  if (!Array.isArray(raw.bindings)) return { version: 1, bindings: [] };

  // A hand-edited file may contain duplicate bot or route entries.  Keep the
  // newest valid record and discard the rest so routing never becomes
  // ambiguous after a restart.  Disabled records do not occupy a route.
  const projected = raw.bindings
    .map(projectBinding)
    .filter((binding): binding is TelegramBotBinding => binding !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const bots = new Set<string>();
  const targets = new Set<string>();
  const bindings: TelegramBotBinding[] = [];
  for (const binding of projected) {
    if (bots.has(binding.botId)) continue;
    const target = telegramBotBindingTargetKey(
      binding.profile,
      binding.chatId,
      binding.threadId,
    );
    if (binding.enabled && targets.has(target)) continue;
    bots.add(binding.botId);
    if (binding.enabled) targets.add(target);
    bindings.push(binding);
    if (bindings.length >= TELEGRAM_BOT_BINDING_LIMITS.maxBindings) break;
  }
  return { version: 1, bindings };
}

function normalizeBotId(value: unknown): string {
  if (typeof value !== "string") throw new Error("A bot id is required.");
  const botId = value.trim();
  if (!validBotId(botId)) throw new Error("The bot id is invalid or too long.");
  return botId;
}

function normalizeProfile(value: unknown): string {
  if (typeof value !== "string") throw new Error("A Telegram profile is required.");
  const profile = value.trim().toLowerCase();
  if (!validProfile(profile) || profile === "main" || profile === "active") {
    throw new Error("The Telegram profile is invalid or reserved.");
  }
  return profile;
}

function normalizeChatId(value: unknown): number {
  if (!validChatId(value)) throw new Error("A valid Telegram chat id is required.");
  return value;
}

function normalizeThreadId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!validThreadId(value)) throw new Error("A Telegram thread id must be a positive integer.");
  return value;
}

function normalizeOwnerUserId(value: unknown): number {
  if (!validPositiveId(value)) throw new Error("A valid Telegram owner id is required.");
  return value;
}

function normalizeWorkspaceId(value: unknown): string {
  if (typeof value !== "string") throw new Error("A workspace id is required.");
  const workspaceId = value.trim();
  if (!validWorkspaceId(workspaceId)) throw new Error("The workspace id is invalid or too long.");
  return workspaceId;
}

function normalizeInput(input: TelegramBotBindingInput): TelegramBotBindingInput {
  if (!input || typeof input !== "object") {
    throw new Error("A Telegram bot binding is required.");
  }
  return {
    botId: normalizeBotId(input.botId),
    profile: normalizeProfile(input.profile),
    chatId: normalizeChatId(input.chatId),
    ...(normalizeThreadId(input.threadId) === undefined
      ? {}
      : { threadId: normalizeThreadId(input.threadId) }),
    ownerUserId: normalizeOwnerUserId(input.ownerUserId),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createTelegramBotBindingStore(options: {
  root(): string;
  now?: () => number;
  /** Test seam; production values are generated UUID-v4-backed ids. */
  createBackingChatId?: () => string;
}) {
  const store = new DataStore<TelegramBotBindingState>(
    "telegram-bot-bindings.json",
    { version: 1, bindings: [] },
    options.root,
    {
      maxBytes: 512 * 1024,
      fileMode: 0o600,
      preserveCorruptFile: true,
      normalize: normalizeState,
    },
  );
  const now = options.now ?? Date.now;

  async function list(
    filter: TelegramBotBindingListOptions = false,
  ): Promise<TelegramBotBinding[]> {
    const showDisabled = includeDisabled(filter);
    return clone(
      (await store.load()).bindings
        .filter((binding) => showDisabled || binding.enabled)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }

  function makeBackingChatId(existing: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = options.createBackingChatId?.() ?? `telegram-bot-${randomUUID()}`;
      if (validBackingChatId(candidate) && !existing.has(candidate)) return candidate;
    }
    throw new Error("Unable to allocate a unique Telegram backing chat id.");
  }

  return {
    list,

    async get(
      botId: string,
      filter: TelegramBotBindingListOptions = false,
    ): Promise<TelegramBotBinding | null> {
      const id = normalizeBotId(botId);
      const showDisabled = includeDisabled(filter);
      const binding = (await store.load()).bindings.find(
        (candidate) => candidate.botId === id && (showDisabled || candidate.enabled),
      );
      return binding ? clone(binding) : null;
    },

    async resolve(
      profile: string,
      chatId: number,
      threadId?: number,
    ): Promise<TelegramBotBinding | null> {
      const normalizedProfile = normalizeProfile(profile);
      const normalizedChatId = normalizeChatId(chatId);
      const normalizedThreadId = normalizeThreadId(threadId);
      const key = telegramBotBindingTargetKey(
        normalizedProfile,
        normalizedChatId,
        normalizedThreadId,
      );
      const binding = (await store.load()).bindings.find(
        (candidate) =>
          candidate.enabled &&
          telegramBotBindingTargetKey(
            candidate.profile,
            candidate.chatId,
            candidate.threadId,
          ) === key,
      );
      return binding ? clone(binding) : null;
    },

    /** Explicit alias for call sites that want to emphasize exact matching. */
    async resolveExact(
      profile: string,
      chatId: number,
      threadId?: number,
    ): Promise<TelegramBotBinding | null> {
      return this.resolve(profile, chatId, threadId);
    },

    async bind(input: TelegramBotBindingInput): Promise<TelegramBotBinding> {
      const normalized = normalizeInput(input);
      return store.update((draft) => {
        const activeBot = draft.bindings.find(
          (binding) => binding.botId === normalized.botId && binding.enabled,
        );
        if (activeBot) {
          throw new Error("This bot already has an active Telegram binding.");
        }

        const targetKey = telegramBotBindingTargetKey(
          normalized.profile,
          normalized.chatId,
          normalized.threadId,
        );
        const activeTarget = draft.bindings.find(
          (binding) =>
            binding.enabled &&
            telegramBotBindingTargetKey(
              binding.profile,
              binding.chatId,
              binding.threadId,
            ) === targetKey,
        );
        if (activeTarget) {
          throw new Error("This Telegram chat is already bound to another bot.");
        }

        const timestamp = now();
        const previous = draft.bindings.find(
          (binding) => binding.botId === normalized.botId,
        );
        if (previous) {
          // Rebinding an archived binding keeps its durable backing chat so
          // the Pi session identity remains stable across target changes.
          Object.assign(previous, normalized, { enabled: true, updatedAt: timestamp });
          return clone(previous);
        }

        if (draft.bindings.length >= TELEGRAM_BOT_BINDING_LIMITS.maxBindings) {
          throw new Error("Aiden supports up to 256 Telegram bot bindings.");
        }
        const backingChatId = makeBackingChatId(
          new Set(draft.bindings.map((binding) => binding.backingChatId)),
        );
        const binding: TelegramBotBinding = {
          ...normalized,
          backingChatId,
          createdAt: timestamp,
          updatedAt: timestamp,
          enabled: true,
        };
        draft.bindings.push(binding);
        return clone(binding);
      });
    },

    async unbind(botId: string): Promise<TelegramBotBinding> {
      const id = normalizeBotId(botId);
      return store.update((draft) => {
        const binding = draft.bindings.find(
          (candidate) => candidate.botId === id && candidate.enabled,
        );
        if (!binding) throw new Error("This bot has no active Telegram binding.");
        binding.enabled = false;
        binding.updatedAt = now();
        return clone(binding);
      });
    },

    /** Disable every route owned by a Telegram profile in one durable write. */
    async unbindProfile(profile: string): Promise<number> {
      const normalizedProfile = normalizeProfile(profile);
      return store.update((draft) => {
        const timestamp = now();
        let count = 0;
        for (const binding of draft.bindings) {
          if (binding.profile !== normalizedProfile || !binding.enabled) continue;
          binding.enabled = false;
          binding.updatedAt = timestamp;
          count += 1;
        }
        return count;
      });
    },
  };
}

export type TelegramBotBindingStore = ReturnType<
  typeof createTelegramBotBindingStore
>;
