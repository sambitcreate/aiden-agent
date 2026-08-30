import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("live app model reads and provider handlers remain offline for models.dev", () => {
  const providers = readFileSync(
    new URL("../handlers/providers.ts", import.meta.url),
    "utf8",
  );
  const catalog = readFileSync(new URL("./models-catalog.ts", import.meta.url), "utf8");

  assert.doesNotMatch(providers, /modelsDevCacheRuntime|fetchModelsDevCatalog/u);
  assert.doesNotMatch(catalog, /models-dev-cache|fetchModelsDevCatalog/u);
  assert.match(providers, /source:\s*"bundled"/u);
});
