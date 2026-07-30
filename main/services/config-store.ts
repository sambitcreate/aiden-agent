// Electron runtime binding for the otherwise platform-independent config store.

import { createConfigStore } from "./config-store-core.js";
import { configStores } from "./portable-config.js";
import { secrets } from "./secrets.js";
import { logger } from "../platform.js";

export const configStore = createConfigStore(configStores, secrets, (area, error) => {
  logger.warn("config", `Deferred ${area}; config startup remains available.`, {
    error: error instanceof Error ? error.message : String(error),
  });
});
