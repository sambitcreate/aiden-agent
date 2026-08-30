import { Buffer } from "node:buffer";
import {
  MAX_MODELS_DEV_ID_LENGTH,
  MAX_MODELS_DEV_MODELS,
  MAX_MODELS_DEV_NUMERIC_VALUE,
  MAX_MODELS_DEV_PROVIDERS,
  parseModelCatalog,
  type ModelCatalog,
} from "./models-catalog-core.js";

export const MODELS_DEV_ENDPOINT = "https://models.dev/api.json";
export const MODELS_DEV_CACHE_SCHEMA_VERSION = 1 as const;
export const MAX_MODELS_DEV_RESPONSE_BYTES = 64 * 1024 * 1024;
export interface ModelsDevCacheDocument {
  schemaVersion: typeof MODELS_DEV_CACHE_SCHEMA_VERSION;
  appVersion: string;
  fetchedAt: string | null;
  catalog: ModelCatalog | null;
}

export interface ModelsDevCatalogStatus {
  source: "bundled" | "device-cache";
  fetchedAt: string | null;
}

export interface ModelsDevCacheStore {
  read(): Promise<ModelsDevCacheDocument>;
  write(document: ModelsDevCacheDocument): Promise<void>;
}

export interface ModelsDevRefreshResult {
  status: ModelsDevCatalogStatus;
  catalog: ModelCatalog;
}

function assertCatalogBounds(catalog: ModelCatalog): void {
  const providers = Object.entries(catalog);
  if (providers.length > MAX_MODELS_DEV_PROVIDERS) {
    throw new Error("models.dev returned too many providers.");
  }
  let modelCount = 0;
  for (const [providerId, provider] of providers) {
    if (providerId.length === 0 || providerId.length > MAX_MODELS_DEV_ID_LENGTH) {
      throw new Error("models.dev returned an invalid provider identity.");
    }
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      modelCount += 1;
      if (modelCount > MAX_MODELS_DEV_MODELS) {
        throw new Error("models.dev returned too many models.");
      }
      if (modelId.length === 0 || modelId.length > MAX_MODELS_DEV_ID_LENGTH) {
        throw new Error(`models.dev provider ${providerId} returned an invalid model identity.`);
      }
      for (const value of [model.limit?.context, model.limit?.output]) {
        if (value !== undefined && value > MAX_MODELS_DEV_NUMERIC_VALUE) {
          throw new Error(`models.dev model ${providerId}/${modelId} returned an unsafe limit.`);
        }
      }
    }
  }
  if (modelCount === 0) throw new Error("models.dev returned an empty catalog.");
}

export function validateModelsDevCatalog(value: unknown): ModelCatalog {
  const catalog = parseModelCatalog(value);
  assertCatalogBounds(catalog);
  return catalog;
}

export function parseModelsDevCacheDocument(value: unknown): ModelsDevCacheDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("models.dev cache must be an object.");
  }
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== MODELS_DEV_CACHE_SCHEMA_VERSION) {
    throw new Error("models.dev cache schema version is invalid.");
  }
  if (typeof document.appVersion !== "string") {
    throw new Error("models.dev cache app version is invalid.");
  }
  if (document.fetchedAt !== null && typeof document.fetchedAt !== "string") {
    throw new Error("models.dev cache timestamp is invalid.");
  }
  return {
    schemaVersion: MODELS_DEV_CACHE_SCHEMA_VERSION,
    appVersion: document.appVersion,
    fetchedAt: document.fetchedAt as string | null,
    catalog: document.catalog === null ? null : validateModelsDevCatalog(document.catalog),
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MODELS_DEV_RESPONSE_BYTES) {
    throw new Error("models.dev returned more data than Aiden can safely process.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODELS_DEV_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("models.dev returned more data than Aiden can safely process.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function fetchModelsDevCatalog(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 30_000,
): Promise<ModelCatalog> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("models.dev refresh timeout must be positive.");
  }
  const controller = new AbortController();
  const deadlineError = new Error("models.dev did not respond before the refresh deadline.");
  const timer = setTimeout(() => controller.abort(deadlineError), timeoutMs);
  try {
    const response = await fetchImpl(MODELS_DEV_ENDPOINT, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    const body = await readBoundedBody(response, controller.signal);
    if (!response.ok) {
      throw new Error(`models.dev request failed with HTTP ${response.status}.`);
    }
    try {
      return validateModelsDevCatalog(JSON.parse(body) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("models.dev returned malformed JSON.");
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

export class ModelsDevCacheRuntime {
  private refreshPromise: Promise<ModelsDevRefreshResult> | null = null;

  constructor(
    private readonly options: {
      appVersion: () => string;
      store: ModelsDevCacheStore;
      fetchCatalog: () => Promise<ModelCatalog>;
      now?: () => Date;
    },
  ) {}

  private async currentDocument(): Promise<ModelsDevCacheDocument | null> {
    const document = await this.options.store.read();
    return document.appVersion === this.options.appVersion() && document.catalog ? document : null;
  }

  async catalog(fallback: ModelCatalog): Promise<ModelCatalog> {
    return (await this.currentDocument())?.catalog ?? fallback;
  }

  async status(): Promise<ModelsDevCatalogStatus> {
    const document = await this.currentDocument();
    return document
      ? { source: "device-cache", fetchedAt: document.fetchedAt }
      : { source: "bundled", fetchedAt: null };
  }

  refresh(): Promise<ModelsDevRefreshResult> {
    this.refreshPromise ??= (async () => {
      const catalog = await this.options.fetchCatalog();
      const fetchedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const document: ModelsDevCacheDocument = {
        schemaVersion: MODELS_DEV_CACHE_SCHEMA_VERSION,
        appVersion: this.options.appVersion(),
        fetchedAt,
        catalog,
      };
      await this.options.store.write(document);
      return { catalog, status: { source: "device-cache" as const, fetchedAt } };
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise!;
  }
}
