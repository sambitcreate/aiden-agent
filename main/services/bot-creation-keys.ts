// Which Bot each idempotent creation key (`preset:<id>`) made, so Start Chat
// on a starter Bot opens the same Bot every time. A key whose Bot is gone
// (deleted) is forgotten, and the next Start Chat creates a fresh one.

import { DataStore } from "./data-store.js";

export const BOT_CREATION_KEYS_FILE = "bot-creation-keys.json";
const KEY_PATTERN = /^preset:[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_BOT_ID_CHARS = 160;

interface BotCreationKeyState {
  version: 1;
  /** creation key → Bot id. */
  keys: Record<string, string>;
}

function emptyState(): BotCreationKeyState {
  return { version: 1, keys: {} };
}

function parseState(value: unknown): BotCreationKeyState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.keys !== "object" || record.keys === null || Array.isArray(record.keys)) {
    return undefined;
  }
  const keys: Record<string, string> = Object.create(null);
  for (const [key, botId] of Object.entries(record.keys as Record<string, unknown>)) {
    if (!KEY_PATTERN.test(key) || typeof botId !== "string" || !botId || botId.length > MAX_BOT_ID_CHARS) {
      return undefined;
    }
    keys[key] = botId;
  }
  return { version: 1, keys };
}

export interface BotCreationKeyStore {
  get(key: string): Promise<string | null>;
  set(key: string, botId: string): Promise<void>;
  forget(key: string): Promise<void>;
}

export function createBotCreationKeyStore(options: { root: () => string; filename?: string }): BotCreationKeyStore {
  const store = new DataStore<BotCreationKeyState>(options.filename ?? BOT_CREATION_KEYS_FILE, emptyState(), options.root, {
    maxBytes: 256 * 1024,
    fileMode: 0o600,
    compact: true,
    normalize: (value) => parseState(value) ?? emptyState(),
    isSafe: (value) => parseState(value) !== undefined,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  });
  return {
    async get(key) {
      if (!KEY_PATTERN.test(key)) return null;
      const state = await store.load();
      return Object.prototype.hasOwnProperty.call(state.keys, key) ? state.keys[key]! : null;
    },
    async set(key, botId) {
      if (!KEY_PATTERN.test(key)) throw new Error("That creation key isn't valid.");
      await store.update((draft) => {
        draft.keys[key] = botId;
      });
    },
    async forget(key) {
      if (!KEY_PATTERN.test(key)) return;
      await store.update((draft) => {
        delete draft.keys[key];
      });
    },
  };
}
