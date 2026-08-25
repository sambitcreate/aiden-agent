import { createHash, randomUUID } from "node:crypto";
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
  /** External Telegram target context; never used as the Bot execution cwd. */
  workspaceId: string;
  /** Main-owned Bot managed-home workspace used by the backing chat and turns. */
  backingWorkspaceId: string;
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
  backingWorkspaceId: string;
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
  version: 3;
  generation: number;
  bindings: TelegramBotBinding[];
}

interface TelegramBotBindingLegacyState {
  version: 1 | 2;
  bindings: unknown[];
}

export interface TelegramBotBindingRollbackAuthority {
  load(): Promise<string | null>;
  store(value: string, expected: string | null): Promise<void>;
}

export interface TelegramBotBindingAuthorityTransitionHooks {
  beforePending?(): Promise<void>;
  afterPending?(): Promise<void>;
  afterFile?(): Promise<void>;
  afterCommit?(): Promise<void>;
}

export const TELEGRAM_BOT_BINDING_STORE_UNAVAILABLE_MESSAGE =
  "Telegram routing data is unavailable. Open Aiden on the Mac to repair it.";

export class TelegramBotBindingStoreUnavailableError extends Error {
  constructor() {
    super(TELEGRAM_BOT_BINDING_STORE_UNAVAILABLE_MESSAGE);
    this.name = "TelegramBotBindingStoreUnavailableError";
  }
}

export type TelegramBotBindingListOptions =
  boolean | { includeDisabled?: boolean };

function includeDisabled(options: TelegramBotBindingListOptions): boolean {
  return typeof options === "boolean"
    ? options
    : options.includeDisabled === true;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validChatId(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value !== 0
  );
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

function projectBinding(
  value: unknown,
  migrateV1 = false,
): TelegramBotBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const backingWorkspaceId = migrateV1
    ? raw.workspaceId
    : raw.backingWorkspaceId;
  if (
    !validBotId(raw.botId) ||
    !validProfile(raw.profile) ||
    !validChatId(raw.chatId) ||
    (raw.threadId !== undefined && !validThreadId(raw.threadId)) ||
    !validPositiveId(raw.ownerUserId) ||
    !validWorkspaceId(raw.workspaceId) ||
    !validWorkspaceId(backingWorkspaceId) ||
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
    backingWorkspaceId,
    backingChatId: raw.backingChatId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    enabled: raw.enabled,
  };
}

function hasExactBindingKeys(value: unknown, version: 1 | 2): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([
    "botId",
    "profile",
    "chatId",
    "threadId",
    "ownerUserId",
    "workspaceId",
    ...(version === 2 ? ["backingWorkspaceId"] : []),
    "backingChatId",
    "createdAt",
    "updatedAt",
    "enabled",
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeState(value: unknown): TelegramBotBindingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 3, generation: 0, bindings: [] };
  }
  const raw = value as {
    version?: unknown;
    generation?: unknown;
    bindings?: unknown;
  };
  if (
    (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) ||
    !Array.isArray(raw.bindings)
  ) {
    return { version: 3, generation: 0, bindings: [] };
  }
  const migrateV1 = raw.version === 1;
  const generation =
    raw.version === 3 &&
    Number.isSafeInteger(raw.generation) &&
    (raw.generation as number) >= 0
      ? (raw.generation as number)
      : 0;

  // A hand-edited file may contain duplicate bot or route entries.  Keep the
  // newest valid record and discard the rest so routing never becomes
  // ambiguous after a restart.  Disabled records do not occupy a route.
  const projected = raw.bindings
    .map((binding) => projectBinding(binding, migrateV1))
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
  return { version: 3, generation, bindings };
}

function supportedState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as {
    version?: unknown;
    bindings?: unknown;
    [key: string]: unknown;
  };
  if (
    (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) ||
    !Array.isArray(raw.bindings) ||
    raw.bindings.length > TELEGRAM_BOT_BINDING_LIMITS.maxBindings ||
    !Object.keys(raw).every(
      (key) =>
        key === "version" ||
        key === "bindings" ||
        (raw.version === 3 && key === "generation"),
    ) ||
    (raw.version === 3 &&
      (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0))
  )
    return false;

  const bots = new Set<string>();
  const targets = new Set<string>();
  for (const candidate of raw.bindings) {
    if (!hasExactBindingKeys(candidate, raw.version === 3 ? 2 : raw.version))
      return false;
    const binding = projectBinding(candidate, raw.version === 1);
    if (!binding || bots.has(binding.botId)) return false;
    bots.add(binding.botId);
    if (!binding.enabled) continue;
    const target = telegramBotBindingTargetKey(
      binding.profile,
      binding.chatId,
      binding.threadId,
    );
    if (targets.has(target)) return false;
    targets.add(target);
  }
  return true;
}

function normalizeBotId(value: unknown): string {
  if (typeof value !== "string") throw new Error("A bot id is required.");
  const botId = value.trim();
  if (!validBotId(botId)) throw new Error("The bot id is invalid or too long.");
  return botId;
}

function normalizeProfile(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("A Telegram profile is required.");
  const profile = value.trim().toLowerCase();
  if (!validProfile(profile) || profile === "main" || profile === "active") {
    throw new Error("The Telegram profile is invalid or reserved.");
  }
  return profile;
}

function normalizeChatId(value: unknown): number {
  if (!validChatId(value))
    throw new Error("A valid Telegram chat id is required.");
  return value;
}

function normalizeThreadId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!validThreadId(value))
    throw new Error("A Telegram thread id must be a positive integer.");
  return value;
}

function normalizeOwnerUserId(value: unknown): number {
  if (!validPositiveId(value))
    throw new Error("A valid Telegram owner id is required.");
  return value;
}

function normalizeWorkspaceId(value: unknown): string {
  if (typeof value !== "string") throw new Error("A workspace id is required.");
  const workspaceId = value.trim();
  if (!validWorkspaceId(workspaceId))
    throw new Error("The workspace id is invalid or too long.");
  return workspaceId;
}

function normalizeInput(
  input: TelegramBotBindingInput,
): TelegramBotBindingInput {
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
    backingWorkspaceId: normalizeWorkspaceId(input.backingWorkspaceId),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createTelegramBotBindingStore(options: {
  root(): string;
  now?: () => number;
  authority?: {
    head: TelegramBotBindingRollbackAuthority;
    bootstrap: TelegramBotBindingRollbackAuthority;
  };
  authorityTransitionHooks?: TelegramBotBindingAuthorityTransitionHooks;
  /** Test seam; production values are generated UUID-v4-backed ids. */
  createBackingChatId?: () => string;
}) {
  const store = new DataStore<TelegramBotBindingState>(
    "telegram-bot-bindings.json",
    { version: 3, generation: 0, bindings: [] },
    options.root,
    {
      maxBytes: 512 * 1024,
      fileMode: 0o600,
      preserveCorruptFile: true,
      normalize: normalizeState,
      isSafe: supportedState,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
    },
  );
  const now = options.now ?? Date.now;
  let migrationPromise: Promise<void> | undefined;
  let mutationTail: Promise<void> = Promise.resolve();

  function authorityHead(state: TelegramBotBindingState): string {
    const canonical = normalizeState(state);
    return `${canonical.generation}:${createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("hex")}`;
  }

  const committedAuthority = (head: string): string => `committed|${head}`;
  const pendingAuthority = (previous: string, next: string): string =>
    `pending|${previous}|${next}`;
  const pendingBootstrap = (head: string): string => `pending|${head}`;
  const consumedBootstrap = "consumed";

  function parseAuthority(
    value: string,
  ):
    | { phase: "committed"; head: string }
    | { phase: "pending"; previous: string; next: string } {
    const committed = /^committed\|([0-9]+:[a-f0-9]{64})$/u.exec(value);
    if (committed) return { phase: "committed", head: committed[1]! };
    const pending =
      /^pending\|([0-9]+:[a-f0-9]{64})\|([0-9]+:[a-f0-9]{64})$/u.exec(value);
    if (pending)
      return {
        phase: "pending",
        previous: pending[1]!,
        next: pending[2]!,
      };
    throw new TelegramBotBindingStoreUnavailableError();
  }

  async function bootstrapAuthority(fileHead: string): Promise<void> {
    if (!options.authority) return;
    const [anchor, marker] = await Promise.all([
      options.authority.head.load(),
      options.authority.bootstrap.load(),
    ]);
    if (marker === consumedBootstrap) {
      if (anchor === null) throw new TelegramBotBindingStoreUnavailableError();
      return;
    }
    const pending = marker === null ? pendingBootstrap(fileHead) : marker;
    if (marker !== null && marker !== pendingBootstrap(fileHead)) {
      throw new TelegramBotBindingStoreUnavailableError();
    }
    if (marker === null) {
      await options.authority.bootstrap.store(pending, null);
    }
    if (anchor === null) {
      await options.authority.head.store(committedAuthority(fileHead), null);
    } else {
      const parsed = parseAuthority(anchor);
      if (parsed.phase !== "committed" || parsed.head !== fileHead) {
        throw new TelegramBotBindingStoreUnavailableError();
      }
    }
    await options.authority.bootstrap.store(consumedBootstrap, pending);
  }

  async function reconcileAuthority(fileHead: string): Promise<void> {
    if (!options.authority) return;
    const marker = await options.authority.bootstrap.load();
    if (marker !== consumedBootstrap) {
      throw new TelegramBotBindingStoreUnavailableError();
    }
    const value = await options.authority.head.load();
    if (value === null) throw new TelegramBotBindingStoreUnavailableError();
    const state = parseAuthority(value);
    if (state.phase === "committed") {
      if (state.head !== fileHead)
        throw new TelegramBotBindingStoreUnavailableError();
      return;
    }
    if (fileHead === state.previous) {
      await options.authority.head.store(
        committedAuthority(state.previous),
        value,
      );
      return;
    }
    if (fileHead === state.next) {
      await options.authority.head.store(committedAuthority(state.next), value);
      return;
    }
    throw new TelegramBotBindingStoreUnavailableError();
  }

  async function assertDataHealthy(): Promise<void> {
    await store.load();
    if (
      (await store.loadedFromCorruptFile()) ||
      (await store.loadedFromUnsafeFile())
    ) {
      throw new TelegramBotBindingStoreUnavailableError();
    }
  }

  async function ensureV3(): Promise<void> {
    migrationPromise ??= (async () => {
      await assertDataHealthy();
      const state = await store.load();
      const disk = await store.loadedDiskContents();
      let legacy = false;
      if (disk) {
        let raw: TelegramBotBindingLegacyState | TelegramBotBindingState;
        try {
          raw = JSON.parse(disk.toString("utf8")) as
            TelegramBotBindingLegacyState | TelegramBotBindingState;
        } catch {
          throw new TelegramBotBindingStoreUnavailableError();
        }
        legacy = raw.version === 1 || raw.version === 2;
      }
      await bootstrapAuthority(authorityHead(state));
      await reconcileAuthority(authorityHead(state));
      if (legacy) await store.save(state);
    })().catch((error) => {
      migrationPromise = undefined;
      throw error;
    });
    return migrationPromise;
  }

  async function assertHealthy(): Promise<void> {
    await ensureV3();
    const current = await store.load();
    await reconcileAuthority(authorityHead(current));
  }

  function mutate<Result>(
    operation: (draft: TelegramBotBindingState) => Result,
  ): Promise<Result> {
    const result = mutationTail.then(async () => {
      await assertHealthy();
      const current = structuredClone(await store.load());
      const currentHead = authorityHead(current);
      const next = structuredClone(current);
      const value = operation(next);
      next.generation = current.generation + 1;
      if (!Number.isSafeInteger(next.generation)) {
        throw new TelegramBotBindingStoreUnavailableError();
      }
      const canonicalNext = normalizeState(next);
      const nextHead = authorityHead(canonicalNext);
      await options.authorityTransitionHooks?.beforePending?.();
      if (options.authority) {
        await options.authority.head.store(
          pendingAuthority(currentHead, nextHead),
          committedAuthority(currentHead),
        );
      }
      await options.authorityTransitionHooks?.afterPending?.();
      await store.save(canonicalNext);
      await options.authorityTransitionHooks?.afterFile?.();
      if (options.authority) {
        await options.authority.head.store(
          committedAuthority(nextHead),
          pendingAuthority(currentHead, nextHead),
        );
      }
      await options.authorityTransitionHooks?.afterCommit?.();
      return value;
    });
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function list(
    filter: TelegramBotBindingListOptions = false,
  ): Promise<TelegramBotBinding[]> {
    await assertHealthy();
    const showDisabled = includeDisabled(filter);
    return clone(
      (await store.load()).bindings
        .filter((binding) => showDisabled || binding.enabled)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }

  function makeBackingChatId(existing: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate =
        options.createBackingChatId?.() ?? `telegram-bot-${randomUUID()}`;
      if (validBackingChatId(candidate) && !existing.has(candidate))
        return candidate;
    }
    throw new Error("Unable to allocate a unique Telegram backing chat id.");
  }

  return {
    assertHealthy,
    list,

    async get(
      botId: string,
      filter: TelegramBotBindingListOptions = false,
    ): Promise<TelegramBotBinding | null> {
      await assertHealthy();
      const id = normalizeBotId(botId);
      const showDisabled = includeDisabled(filter);
      const binding = (await store.load()).bindings.find(
        (candidate) =>
          candidate.botId === id && (showDisabled || candidate.enabled),
      );
      return binding ? clone(binding) : null;
    },

    async resolve(
      profile: string,
      chatId: number,
      threadId?: number,
    ): Promise<TelegramBotBinding | null> {
      await assertHealthy();
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
      await assertHealthy();
      const normalized = normalizeInput(input);
      return mutate((draft) => {
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
          throw new Error(
            "This Telegram chat is already bound to another bot.",
          );
        }

        const timestamp = now();
        const previous = draft.bindings.find(
          (binding) => binding.botId === normalized.botId,
        );
        if (previous) {
          // Rebinding an archived binding keeps its durable backing chat so
          // the Pi session identity remains stable across target changes.
          Object.assign(previous, normalized, {
            enabled: true,
            updatedAt: timestamp,
          });
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
      await assertHealthy();
      const id = normalizeBotId(botId);
      return mutate((draft) => {
        const binding = draft.bindings.find(
          (candidate) => candidate.botId === id && candidate.enabled,
        );
        if (!binding)
          throw new Error("This bot has no active Telegram binding.");
        binding.enabled = false;
        binding.updatedAt = now();
        return clone(binding);
      });
    },

    /** Disable every route owned by a Telegram profile in one durable write. */
    async unbindProfile(profile: string): Promise<number> {
      await assertHealthy();
      const normalizedProfile = normalizeProfile(profile);
      return mutate((draft) => {
        const timestamp = now();
        let count = 0;
        for (const binding of draft.bindings) {
          if (binding.profile !== normalizedProfile || !binding.enabled)
            continue;
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
