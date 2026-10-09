// Per-Bot memory of connect cards the person answered with Not now. Once a
// plugin is dismissed for a Bot, `suggest_connection` refuses it for that Bot.
// Guarded JSON: an unreadable or newer-shaped file is kept, never overwritten.

import { BOT_LIMITS } from "../../renderer/shared/bots.js";
import { DataStore } from "./data-store.js";

export const BOT_CONNECTION_DISMISSALS_FILE = "bot-connection-dismissals.json";
const MAX_BYTES = 1024 * 1024;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

interface BotConnectionDismissalState {
  version: 1;
  /** botId → pluginId → dismissedAt (epoch ms). */
  bots: Record<string, Record<string, number>>;
}

function emptyState(): BotConnectionDismissalState {
  return { version: 1, bots: {} };
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

function isPluginId(value: string): boolean {
  return PLUGIN_ID_PATTERN.test(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict parse; undefined when any part is not the current shape. */
function parseState(value: unknown): BotConnectionDismissalState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.bots)) return undefined;
  if (Object.keys(value).some((key) => key !== "version" && key !== "bots")) return undefined;
  const bots: Record<string, Record<string, number>> = Object.create(null);
  for (const [botId, plugins] of Object.entries(value.bots)) {
    if (!isBotId(botId) || !isRecord(plugins)) return undefined;
    const entry: Record<string, number> = Object.create(null);
    for (const [pluginId, at] of Object.entries(plugins)) {
      if (!isPluginId(pluginId) || typeof at !== "number" || !Number.isFinite(at) || at < 0) {
        return undefined;
      }
      entry[pluginId] = at;
    }
    bots[botId] = entry;
  }
  return { version: 1, bots };
}

export interface BotConnectionDismissalStore {
  isDismissed(botId: string, pluginId: string): Promise<boolean>;
  /** Idempotent; keeps the first dismissal time. */
  dismiss(botId: string, pluginId: string): Promise<void>;
  list(botId: string): Promise<string[]>;
  /** Called when a Bot is deleted. */
  forgetBot(botId: string): Promise<void>;
}

export interface BotConnectionDismissalStoreOptions {
  /** Directory holding the file, usually the profile directory. */
  root: () => string;
  filename?: string;
  now?: () => number;
}

export function createBotConnectionDismissalStore(
  options: BotConnectionDismissalStoreOptions,
): BotConnectionDismissalStore {
  const now = options.now ?? Date.now;
  const store = new DataStore<BotConnectionDismissalState>(
    options.filename ?? BOT_CONNECTION_DISMISSALS_FILE,
    emptyState(),
    options.root,
    {
      maxBytes: MAX_BYTES,
      fileMode: 0o600,
      compact: true,
      normalize: (value) => parseState(value) ?? emptyState(),
      isSafe: (value) => parseState(value) !== undefined,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
    },
  );

  const pluginsFor = async (botId: string): Promise<Record<string, number> | undefined> => {
    if (!isBotId(botId)) return undefined;
    const state = await store.load();
    return hasOwn(state.bots, botId) ? state.bots[botId] : undefined;
  };

  return {
    async isDismissed(botId, pluginId) {
      if (!isPluginId(pluginId)) return false;
      const plugins = await pluginsFor(botId);
      return Boolean(plugins && hasOwn(plugins, pluginId));
    },
    async dismiss(botId, pluginId) {
      if (!isBotId(botId)) throw new Error("That Bot id isn't valid.");
      if (!isPluginId(pluginId)) throw new Error("That connection id isn't valid.");
      await store.update((draft) => {
        const plugins = hasOwn(draft.bots, botId) ? draft.bots[botId]! : {};
        if (!hasOwn(plugins, pluginId)) plugins[pluginId] = now();
        draft.bots[botId] = plugins;
      });
    },
    async list(botId) {
      const plugins = await pluginsFor(botId);
      return plugins ? Object.keys(plugins).sort() : [];
    },
    async forgetBot(botId) {
      if (!isBotId(botId)) return;
      if (!(await pluginsFor(botId))) return;
      await store.update((draft) => {
        delete draft.bots[botId];
      });
    },
  };
}
