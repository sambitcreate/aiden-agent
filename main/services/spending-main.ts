/** Electron-main binding of the app's spending ledger. */

import { ipcMain, logger } from "../platform.js";
import { SPENDING_CHANGED_CHANNEL } from "../../renderer/shared/spending.js";
import { configStore } from "./config-store.js";
import { DataStore } from "./data-store.js";
import type { SpendingDocument } from "./spending-core.js";
import { SPENDING_FILE, SpendingService } from "./spending-service.js";
import { parseDurableSpendingDocument, SPENDING_DISPATCH_LIMITS } from "./spending-dispatch-ledger.js";

const safe = (value: unknown): boolean => {
  try { parseDurableSpendingDocument(value); return true; }
  catch { return false; }
};

const store = new DataStore<unknown>(SPENDING_FILE, { version: 1, chats: {}, bots: {}, botLimits: {}, runs: {} }, undefined, {
  maxBytes: SPENDING_DISPATCH_LIMITS.bytes,
  fileMode: 0o600,
  compact: true,
  isSafe: safe,
  rejectCorruptWrite: true,
  rejectUnsafeWrite: true,
});

async function loadSpending(): Promise<unknown> {
  const value = await store.load();
  if (await store.loadedFromCorruptFile() || await store.loadedFromUnsafeFile()) throw new Error("Saved spending data is unavailable. Restore the last valid backup.");
  return value;
}

/** Device-local; never portable. Holds chat and Bot ids and dollar amounts only. */
export const spending = new SpendingService({
  persistence: {
    load: loadSpending,
    reload: async () => { await store.reload(); return loadSpending(); },
    save: (document: SpendingDocument) => store.save(document),
  },
  settings: async () => (await configStore.getSettings()).spendingLimits,
  broadcast: (event) => ipcMain.broadcast(SPENDING_CHANGED_CHANNEL, event),
  onError: (error) =>
    logger.warn("spending", "Spending could not be read or saved.", {
      errorType: error instanceof Error ? error.name : typeof error,
    }),
});
