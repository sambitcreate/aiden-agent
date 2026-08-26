import {
  buildOpenRouterBenchmarkCache,
  OPENROUTER_BENCHMARK_ENDPOINT,
  type OpenRouterBenchmarkCache,
} from "./openrouter-benchmark-catalog-core.js";
import type { ModelInsightsActionErrorCode, ModelInsightsStatus } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ModelInsightsError extends Error {
  constructor(
    readonly code: ModelInsightsActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelInsightsError";
  }
}

export interface OpenRouterBenchmarkCacheStore {
  read(): Promise<OpenRouterBenchmarkCache | null>;
  write(cache: OpenRouterBenchmarkCache): Promise<void>;
  clear(): Promise<void>;
}

export interface OpenRouterBenchmarkRuntimeDependencies {
  credentials: {
    read(): Promise<string | null>;
    write(key: string): Promise<void>;
    deleteKey(): Promise<void>;
  };
  cache: OpenRouterBenchmarkCacheStore;
  fetchCatalog(key: string): Promise<OpenRouterBenchmarkCache>;
}

export function normalizeOpenRouterBenchmarkApiKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelInsightsError("invalid_key", "Paste an OpenRouter API key.");
  }
  const key = value.trim();
  if (key.length > 4_096) {
    throw new ModelInsightsError("invalid_key", "The OpenRouter API key is too long.");
  }
  if (
    Array.from(key).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new ModelInsightsError(
      "invalid_key",
      "The OpenRouter API key contains unsupported characters.",
    );
  }
  return key;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ModelInsightsError(
      "invalid_response",
      "OpenRouter returned too much benchmark data.",
    );
  }
  if (!response.body) {
    throw new ModelInsightsError(
      "invalid_response",
      "OpenRouter returned an empty benchmark response.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ModelInsightsError(
        "invalid_response",
        "OpenRouter returned too much benchmark data.",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ModelInsightsError("invalid_response", "OpenRouter returned invalid benchmark data.");
  }
}

function responseError(status: number): ModelInsightsError {
  if (status === 401 || status === 403) {
    return new ModelInsightsError("invalid_key", "OpenRouter rejected the connected API key.");
  }
  if (status === 429) {
    return new ModelInsightsError(
      "rate_limited",
      "OpenRouter is rate limiting benchmark requests. Try again later.",
    );
  }
  return new ModelInsightsError(
    "service_unavailable",
    "OpenRouter benchmark data is temporarily unavailable. Your previous cache is unchanged.",
  );
}

/** Network access is intentionally isolated here and called only by an explicit user action. */
export async function fetchOpenRouterBenchmarkCache(
  key: string,
  options: {
    fetch?: FetchLike;
    now?: () => Date;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<OpenRouterBenchmarkCache> {
  if (!key.trim()) throw new ModelInsightsError("not_connected", "Connect OpenRouter first.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(OPENROUTER_BENCHMARK_ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof ModelInsightsError) throw error;
      throw new ModelInsightsError(
        "network_error",
        controller.signal.aborted
          ? "OpenRouter benchmark fetch timed out. Your previous cache is unchanged."
          : "Aiden could not reach OpenRouter. Your previous cache is unchanged.",
      );
    }
    if (!response.ok) throw responseError(response.status);
    try {
      return buildOpenRouterBenchmarkCache(
        await readBoundedJson(response, options.maxBytes ?? DEFAULT_MAX_BYTES),
        (options.now ?? (() => new Date()))().toISOString(),
      );
    } catch (error) {
      if (error instanceof ModelInsightsError) throw error;
      throw new ModelInsightsError(
        "invalid_response",
        "OpenRouter returned invalid benchmark data.",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function statusFrom(
  key: string | null,
  cache: OpenRouterBenchmarkCache | null,
): ModelInsightsStatus {
  const ready = key !== null && cache !== null;
  return {
    hasKey: key !== null,
    ready,
    cachedModelCount: ready ? cache.models.length : 0,
    fetchedAt: ready ? cache.source.fetchedAt : undefined,
    asOf: ready ? cache.source.asOf : undefined,
    citation: ready ? cache.source.citation : undefined,
    license: ready ? cache.source.license : undefined,
  };
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class OpenRouterBenchmarkRuntime {
  private readonly actionMutex = new AsyncMutex();
  private readonly stateMutex = new AsyncMutex();

  constructor(private readonly dependencies: OpenRouterBenchmarkRuntimeDependencies) {}

  async status(): Promise<ModelInsightsStatus> {
    return this.stateMutex.run(async () =>
      statusFrom(await this.dependencies.credentials.read(), await this.dependencies.cache.read()),
    );
  }

  async catalog(): Promise<OpenRouterBenchmarkCache | null> {
    return this.stateMutex.run(async () => {
      if (!(await this.dependencies.credentials.read())) return null;
      return this.dependencies.cache.read();
    });
  }

  async connect(apiKey: unknown): Promise<ModelInsightsStatus> {
    const key = normalizeOpenRouterBenchmarkApiKey(apiKey);
    return this.actionMutex.run(async () => {
      const cache = await this.dependencies.fetchCatalog(key);
      return this.stateMutex.run(async () => {
        const previousKey = await this.dependencies.credentials.read();
        await this.dependencies.credentials.write(key);
        try {
          await this.dependencies.cache.write(cache);
        } catch (error) {
          try {
            if (previousKey) await this.dependencies.credentials.write(previousKey);
            else await this.dependencies.credentials.deleteKey();
          } catch {
            throw new Error(
              "Aiden could not save the Model Pad benchmark cache or restore the previous key.",
            );
          }
          throw error;
        }
        return statusFrom(key, cache);
      });
    });
  }

  async refresh(): Promise<ModelInsightsStatus> {
    return this.actionMutex.run(async () => {
      const key = await this.stateMutex.run(() => this.dependencies.credentials.read());
      if (!key)
        throw new ModelInsightsError(
          "not_connected",
          "Connect a Model Pad OpenRouter key before fetching benchmark data.",
        );
      const cache = await this.dependencies.fetchCatalog(key);
      return this.stateMutex.run(async () => {
        if ((await this.dependencies.credentials.read()) !== key) {
          throw new ModelInsightsError(
            "local_error",
            "The Model Pad OpenRouter key changed during the fetch. Your previous cache is unchanged.",
          );
        }
        await this.dependencies.cache.write(cache);
        return statusFrom(key, cache);
      });
    });
  }

  async clear(): Promise<ModelInsightsStatus> {
    return this.actionMutex.run(async () => {
      return this.stateMutex.run(async () => {
        await this.dependencies.cache.clear();
        return statusFrom(await this.dependencies.credentials.read(), null);
      });
    });
  }

  async disconnect(): Promise<ModelInsightsStatus> {
    return this.actionMutex.run(async () => {
      return this.stateMutex.run(async () => {
        // Keep the key available for a retry if clearing the cache fails.
        await this.dependencies.cache.clear();
        await this.dependencies.credentials.deleteKey();
        return statusFrom(null, null);
      });
    });
  }
}
