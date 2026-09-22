import { app, logger } from "../platform.js";
import { DataStore } from "./data-store.js";
import {
  fetchModelsDevCatalog,
  MODELS_DEV_CACHE_SCHEMA_VERSION,
  ModelsDevCacheRuntime,
  parseModelsDevCacheDocument,
  type ModelsDevCacheDocument,
} from "./models-dev-cache-core.js";

const EMPTY_CACHE: ModelsDevCacheDocument = {
  schemaVersion: MODELS_DEV_CACHE_SCHEMA_VERSION,
  appVersion: "",
  fetchedAt: null,
  catalog: null,
};

const store = new DataStore<ModelsDevCacheDocument>(
  "models-dev-display-cache.json",
  EMPTY_CACHE,
  undefined,
  {
    maxBytes: 65 * 1024 * 1024,
    fileMode: 0o600,
    normalize: parseModelsDevCacheDocument,
  },
);

export const modelsDevCacheRuntime = new ModelsDevCacheRuntime({
  appVersion: () => app.getVersion(),
  store: {
    read: () => store.load(),
    write: async (document) => {
      await store.save(parseModelsDevCacheDocument(document));
    },
  },
  fetchCatalog: () => fetchModelsDevCatalog(),
});

export async function modelsDevCacheStatus() {
  try {
    return await modelsDevCacheRuntime.status();
  } catch (error) {
    logger.warn("models-catalog", "Ignoring an invalid device-local models.dev cache.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { source: "bundled" as const, fetchedAt: null };
  }
}
