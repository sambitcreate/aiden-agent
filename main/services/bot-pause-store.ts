// Which Bots the person paused, and since when (plan §7). Kept apart from
// `BotDefinition` so pausing never bumps a Bot's identity revision.
//
// One private file, `<root>/bot-pauses.json` (mode 0600). The desktop root is
// `<userData>/bot-service`; the CLI root is `<agentDir>/bot-service`.
//
// Fail closed: a file that does not parse, or that a newer Aiden wrote in a
// shape this version does not know, is kept as it is. Reads throw
// `BotPauseStoreCorruptError` and writes are refused, so callers refuse to run
// a Bot turn rather than guess that nothing is paused. A read re-checks the
// file while it is unreadable, so fixing or removing it takes effect at once.

import { BOT_LIMITS } from "../../renderer/shared/bots.js";
import { DataStore } from "./data-store.js";

export const BOT_PAUSES_FILE = "bot-pauses.json";
const MAX_BYTES = 1024 * 1024;

/** Where the pause came from: the Mac, a phone (Remote) or the CLI. */
export type BotPauseOrigin = "mac" | "phone" | "cli";

export interface BotPauseRecord {
  /** When the Bot was paused (epoch ms). Pausing again keeps the first time. */
  since: number;
  by: BotPauseOrigin;
}

export interface BotPauseStore {
  /** The Bot's pause, or undefined when it runs. Throws `BotPauseStoreCorruptError` when unreadable. */
  get(botId: string): Promise<BotPauseRecord | undefined>;
  /** Every paused Bot. Throws `BotPauseStoreCorruptError` when unreadable. */
  list(): Promise<ReadonlyMap<string, BotPauseRecord>>;
  /** Idempotent: an already paused Bot keeps its first `since` and `by`. */
  pause(botId: string, by: BotPauseOrigin): Promise<BotPauseRecord>;
  /** Clear the pause; returns the record it cleared, or undefined when the Bot was not paused. */
  unpause(botId: string): Promise<BotPauseRecord | undefined>;
  /** Called when a Bot is deleted. */
  forgetBot(botId: string): Promise<void>;
}

export interface BotPauseStoreOptions {
  /** Directory holding the file. */
  root: () => string;
  now?: () => number;
}

export class BotPauseStoreCorruptError extends Error {
  constructor() {
    super(`Aiden can't read which Bots are paused (${BOT_PAUSES_FILE}). Fix or remove that file to continue.`);
    this.name = "BotPauseStoreCorruptError";
  }
}

interface BotPauseState {
  version: 1;
  bots: Record<string, BotPauseRecord>;
}

const ORIGINS: ReadonlySet<string> = new Set<BotPauseOrigin>(["mac", "phone", "cli"]);

function emptyState(): BotPauseState {
  return { version: 1, bots: Object.create(null) as Record<string, BotPauseRecord> };
}

function isBotId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= BOT_LIMITS.idChars &&
    value.trim() === value &&
    value !== "__proto__" &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseRecord(value: unknown): BotPauseRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "since" && key !== "by")) return undefined;
  const { since, by } = value;
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) return undefined;
  if (typeof by !== "string" || !ORIGINS.has(by)) return undefined;
  return { since, by: by as BotPauseOrigin };
}

/** Strict parse; undefined when any part is not the current shape. */
function parseState(value: unknown): BotPauseState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.bots)) return undefined;
  if (Object.keys(value).some((key) => key !== "version" && key !== "bots")) return undefined;
  const state = emptyState();
  for (const [botId, raw] of Object.entries(value.bots)) {
    const record = parseRecord(raw);
    if (!isBotId(botId) || record === undefined) return undefined;
    state.bots[botId] = record;
  }
  return state;
}

export function createBotPauseStore(options: BotPauseStoreOptions): BotPauseStore {
  const now = options.now ?? Date.now;
  const store = new DataStore<BotPauseState>(BOT_PAUSES_FILE, emptyState(), options.root, {
    maxBytes: MAX_BYTES,
    fileMode: 0o600,
    compact: true,
    normalize: (value) => parseState(value) ?? emptyState(),
    isSafe: (value) => parseState(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  });

  const unreadable = async () => (await store.loadedFromCorruptFile()) || (await store.loadedFromUnsafeFile());

  /** The parsed file, or a throw when it cannot be trusted. */
  async function readable(): Promise<BotPauseState> {
    let state = await store.load();
    if (await unreadable()) {
      await store.reload();
      if (await unreadable()) throw new BotPauseStoreCorruptError();
      state = await store.load();
    }
    return state;
  }

  async function update<R>(mutation: (draft: BotPauseState) => R): Promise<R> {
    // Refuse before touching the file, and with the same error reads give.
    await readable();
    try {
      return await store.update(mutation);
    } catch (error) {
      if (await unreadable().catch(() => true)) throw new BotPauseStoreCorruptError();
      throw error;
    }
  }

  return {
    async get(botId) {
      if (!isBotId(botId)) return undefined;
      const state = await readable();
      return hasOwn(state.bots, botId) ? { ...state.bots[botId]! } : undefined;
    },
    async list() {
      const state = await readable();
      return new Map(Object.entries(state.bots).map(([botId, record]) => [botId, { ...record }]));
    },
    async pause(botId, by) {
      if (!isBotId(botId)) throw new Error("That Bot id isn't valid.");
      if (!ORIGINS.has(by)) throw new Error("That pause origin isn't valid.");
      return update((draft) => {
        if (!hasOwn(draft.bots, botId)) draft.bots[botId] = { since: now(), by };
        return { ...draft.bots[botId]! };
      });
    },
    async unpause(botId) {
      if (!isBotId(botId)) return undefined;
      const state = await readable();
      if (!hasOwn(state.bots, botId)) return undefined;
      return update((draft) => {
        if (!hasOwn(draft.bots, botId)) return undefined;
        const record = { ...draft.bots[botId]! };
        delete draft.bots[botId];
        return record;
      });
    },
    async forgetBot(botId) {
      if (!isBotId(botId)) return;
      // A delete must finish even when this file is unreadable: a deleted Bot's
      // id never comes back, so a record left behind can never pause anything.
      let state: BotPauseState;
      try {
        state = await readable();
      } catch (error) {
        if (error instanceof BotPauseStoreCorruptError) return;
        throw error;
      }
      if (!hasOwn(state.bots, botId)) return;
      await update((draft) => {
        delete draft.bots[botId];
      });
    },
  };
}
