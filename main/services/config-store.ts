// Electron runtime binding for the otherwise platform-independent config store.

import { createConfigStore } from "./config-store-core.js";
import { configStores } from "./portable-config.js";
import { secrets } from "./secrets.js";

export const configStore = createConfigStore(configStores, secrets);
