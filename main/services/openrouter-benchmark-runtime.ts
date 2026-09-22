import { DataStore } from "./data-store.js";
import {
  parseOpenRouterBenchmarkCache,
  type OpenRouterBenchmarkCache,
} from "./openrouter-benchmark-catalog-core.js";
import {
  fetchOpenRouterBenchmarkCache,
  OpenRouterBenchmarkRuntime,
} from "./openrouter-benchmark-runtime-core.js";
import { piCredentialStore } from "./pi-credential-store.js";

interface CacheDocument {
  version: 1;
  cache: OpenRouterBenchmarkCache | null;
}

function normalizeDocument(value: unknown): CacheDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model insights cache must be an object.");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== 1) throw new Error("Model insights cache version is invalid.");
  return {
    version: 1,
    cache: document.cache === null ? null : parseOpenRouterBenchmarkCache(document.cache),
  };
}

const store = new DataStore<CacheDocument>(
  "openrouter-benchmark-cache.json",
  { version: 1, cache: null },
  undefined,
  { maxBytes: 2 * 1024 * 1024, fileMode: 0o600, normalize: normalizeDocument },
);

// This deliberately does not match the `openrouter` inference-provider ID.
// A credential stored here can only authorize Model Pad benchmark fetches.
const MODEL_PAD_CREDENTIAL_ID = "aiden-internal:model-pad-openrouter-benchmarks-v1";

const cache = {
  async read() {
    return (await store.load()).cache;
  },
  async write(next: OpenRouterBenchmarkCache) {
    await store.save({ version: 1, cache: parseOpenRouterBenchmarkCache(next) });
  },
  async clear() {
    await store.save({ version: 1, cache: null });
  },
};

const credentials = {
  async read(): Promise<string | null> {
    const credential = await piCredentialStore.read(MODEL_PAD_CREDENTIAL_ID);
    if (!credential) return null;
    if (credential.type !== "api_key" || typeof credential.key !== "string" || !credential.key) {
      throw new Error("Stored Model Pad OpenRouter credentials are invalid.");
    }
    return credential.key;
  },
  async write(key: string): Promise<void> {
    await piCredentialStore.modify(MODEL_PAD_CREDENTIAL_ID, async () => ({
      type: "api_key",
      key,
    }));
  },
  async deleteKey(): Promise<void> {
    await piCredentialStore.delete(MODEL_PAD_CREDENTIAL_ID);
  },
};

/** Manual-only benchmark runtime. Status/catalog reads are strictly device-local. */
export const openRouterBenchmarkRuntime = new OpenRouterBenchmarkRuntime({
  credentials,
  cache,
  fetchCatalog: (key) => fetchOpenRouterBenchmarkCache(key),
});
