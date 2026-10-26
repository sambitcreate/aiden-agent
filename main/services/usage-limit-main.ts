/** Electron-main binding of the app's usage-limit gate. */

import { ipcMain, logger } from "../platform.js";
import { USAGE_LIMITS_CHANGED_CHANNEL } from "../../renderer/shared/usage-limits.js";
import { configStore } from "./config-store.js";
import { DataStore } from "./data-store.js";
import type { UsageLimitEntriesDocument } from "./usage-limit-core.js";
import { USAGE_LIMITS_FILE, UsageLimitService } from "./usage-limit-service.js";

const store = new DataStore<unknown>(USAGE_LIMITS_FILE, { version: 1, entries: [] }, undefined, {
  maxBytes: 512 * 1024,
  fileMode: 0o600,
  compact: true,
  // Short-lived waits; a rescue copy of a bad file would only litter.
  preserveCorruptFile: false,
});

/** Device-local; never portable. Holds provider ids, model ids and times only. */
export const usageLimits = new UsageLimitService({
  persistence: {
    load: () => store.load(),
    save: (document: UsageLimitEntriesDocument) => store.save(document),
  },
  waitHours: async () => (await configStore.getSettings()).usageLimitWaitHours,
  broadcast: (event) => ipcMain.broadcast(USAGE_LIMITS_CHANGED_CHANNEL, event),
  onError: (error) =>
    logger.warn("usage-limits", "Usage limit state could not be read or saved.", {
      errorType: error instanceof Error ? error.name : typeof error,
    }),
  onWait: ({ owner, model, entry }) =>
    logger.info(
      "usage-limits",
      `A ${owner.kind} reply waits for a ${model.provider} usage limit until ${new Date(entry?.nextTryAt ?? 0).toISOString()}.`,
    ),
  onGiveUp: ({ owner, model, decision }) =>
    logger.info("usage-limits", `A ${owner.kind} reply stopped waiting for a ${model.provider} usage limit (${decision?.reason}).`),
});
