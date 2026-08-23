import { app } from "../platform.js";
import { DataStore } from "./data-store.js";
import {
  EMPTY_AIDEN_REMOTE_BOT_FAVORITES,
  normalizeAidenRemoteBotFavoritesSnapshot,
  type AidenRemoteBotFavoritesSnapshot,
} from "./aiden-remote-bots.js";

const BOT_FAVORITES_FILE = "aiden-remote-bot-favorites-v1.json";
const MAX_BOT_FAVORITES_BYTES = 16 * 1_024;

function safeSnapshot(value: unknown): boolean {
  try {
    normalizeAidenRemoteBotFavoritesSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

export const botFavoritesStore = new DataStore<AidenRemoteBotFavoritesSnapshot>(
  BOT_FAVORITES_FILE,
  EMPTY_AIDEN_REMOTE_BOT_FAVORITES,
  () => app.getPath("userData"),
  {
    maxBytes: MAX_BOT_FAVORITES_BYTES,
    fileMode: 0o600,
    normalize: normalizeAidenRemoteBotFavoritesSnapshot,
    isSafe: safeSnapshot,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
  },
);

let favoritesTail: Promise<void> = Promise.resolve();

/** One process-wide transaction lane shared by desktop and paired-device mutations. */
export function withBotFavoritesMutation<Result>(
  action: () => Promise<Result>,
): Promise<Result> {
  const result = favoritesTail.then(action, action);
  favoritesTail = result.then(() => undefined, () => undefined);
  return result;
}

export function removeArchivedBotFavorite(botId: string): Promise<void> {
  return withBotFavoritesMutation(async () => {
    const current = normalizeAidenRemoteBotFavoritesSnapshot(await botFavoritesStore.load());
    const botIds = current.botIds.filter((candidate) => candidate !== botId);
    if (botIds.length !== current.botIds.length) {
      await botFavoritesStore.save({ version: 1, botIds });
    }
  });
}
