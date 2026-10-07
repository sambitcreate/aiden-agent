import { app } from "../platform.js";
import { DataStore } from "./data-store.js";

/**
 * Retired Bot favorites storage. Favorites left Aiden in contract revision 25;
 * the file is only pruned so a deleted Bot's id does not linger on disk.
 */
interface BotFavoritesSnapshot {
  version: 1;
  botIds: string[];
}

const BOT_FAVORITES_FILE = "aiden-remote-bot-favorites-v1.json";
const MAX_BOT_FAVORITES_BYTES = 16 * 1_024;
const BOT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const EMPTY: BotFavoritesSnapshot = { version: 1, botIds: [] };

function normalize(value: unknown): BotFavoritesSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { botIds?: unknown }).botIds)
  ) {
    return { ...EMPTY, botIds: [] };
  }
  const botIds = (value as { botIds: unknown[] }).botIds
    .filter((id): id is string => typeof id === "string" && BOT_ID.test(id));
  return { version: 1, botIds: [...new Set(botIds)] };
}

const botFavoritesStore = new DataStore<BotFavoritesSnapshot>(
  BOT_FAVORITES_FILE,
  EMPTY,
  () => app.getPath("userData"),
  {
    maxBytes: MAX_BOT_FAVORITES_BYTES,
    fileMode: 0o600,
    normalize,
  },
);

let favoritesTail: Promise<void> = Promise.resolve();

export function removeArchivedBotFavorite(botId: string): Promise<void> {
  const result = favoritesTail.then(async () => {
    const current = normalize(await botFavoritesStore.load());
    const botIds = current.botIds.filter((candidate) => candidate !== botId);
    if (botIds.length !== current.botIds.length) {
      await botFavoritesStore.save({ version: 1, botIds });
    }
  });
  favoritesTail = result.catch(() => undefined);
  return result;
}
