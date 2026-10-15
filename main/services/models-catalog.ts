// Capability metadata comes from the packaged models.dev snapshot. Optional
// benchmark evidence comes from the dedicated device-local OpenRouter cache.
// Reading model info never performs a network request.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, logger } from "../platform.js";
import { openRouterBenchmarkRuntime } from "./openrouter-benchmark-runtime.js";
import { modelsDevCacheRuntime } from "./models-dev-cache.js";
import { createModelsCatalogReader } from "./models-catalog-reader.js";

const BUNDLED_MODELS_DEV_PARTS = ["resources", "model-capabilities.json"] as const;

export const modelsCatalog = createModelsCatalogReader({
  loadBundled: async () =>
    JSON.parse(await readFile(join(app.getAppPath(), ...BUNDLED_MODELS_DEV_PARTS), "utf8")) as unknown,
  displayCache: modelsDevCacheRuntime,
  benchmarks: openRouterBenchmarkRuntime,
  warn: (message, details) => logger.warn("models-catalog", message, details),
});
