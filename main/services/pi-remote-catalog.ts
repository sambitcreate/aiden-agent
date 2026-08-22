import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
const MAX_CATALOG_MODELS = 10_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 256;
const MAX_TOKEN_LIMIT = 10_000_000;
const MAX_COST_RATE = 1_000_000;
const UNKNOWN_COST_SENTINEL = -1_000_000;
const MAX_CATALOG_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Keep synchronized with the deliberately pinned @earendil-works/pi-ai dependency. */
export const AIDEN_PI_CATALOG_VERSION = "0.80.10";
export const AIDEN_PI_CATALOG_GENERATED_AT = Date.parse("2026-07-16T22:04:50.937Z");
export const AIDEN_PI_CATALOG_USER_AGENT = `Aiden-Agent pi-ai/${AIDEN_PI_CATALOG_VERSION}`;
export const PI_REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface PiRemoteCatalogOptions {
  catalogBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  supportedApis?: readonly string[];
  localGeneratedAt?: number;
}

interface PersistedRemoteCatalog extends ModelsStoreEntry {
  etag?: string;
  lastModified?: number;
}

const remoteCatalogFreshness = new WeakMap<Provider, (entry: ModelsStoreEntry | undefined) => boolean>();

export function isPiRemoteCatalogProvider(provider: Provider): boolean {
  return remoteCatalogFreshness.has(provider);
}

export function isPiRemoteCatalogCacheFresh(
  provider: Provider,
  entry: ModelsStoreEntry | undefined,
): boolean {
  return remoteCatalogFreshness.get(provider)?.(entry) ?? false;
}

export interface CatalogPolicy {
  allowedApis?: ReadonlySet<string>;
  allowedOrigins?: ReadonlySet<string>;
  allowEmptyBaseUrl?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function catalogEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (!object) return undefined;
  if ("models" in object) return Array.isArray(object.models) ? object.models : undefined;
  return Object.values(object);
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_TOKEN_LIMIT;
}

function safeCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    (value === UNKNOWN_COST_SENTINEL || (value >= 0 && value <= MAX_COST_RATE));
}

function safeCostRecord(value: unknown): value is Model<Api>["cost"] {
  const cost = record(value);
  if (!cost || !safeCost(cost.input) || !safeCost(cost.output) || !safeCost(cost.cacheRead) || !safeCost(cost.cacheWrite)) {
    return false;
  }
  if (cost.tiers === undefined) return true;
  return Array.isArray(cost.tiers) && cost.tiers.length <= 16 && cost.tiers.every((tier) => {
    const item = record(tier);
    return item !== undefined && safePositiveInteger(item.inputTokensAbove) && safeCost(item.input) && safeCost(item.output) && safeCost(item.cacheRead) && safeCost(item.cacheWrite);
  });
}

function safeThinkingLevelMap(value: unknown): boolean {
  if (value === undefined) return true;
  const map = record(value);
  if (!map) return false;
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return Object.entries(map).every(([key, entry]) =>
    levels.has(key) && (entry === null || (typeof entry === "string" && entry.length > 0 && entry.length <= 64)),
  );
}

function safeCompat(value: unknown): boolean {
  if (value === undefined) return true;
  let nodes = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 512 || depth > 8) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry === "string") return entry.length <= 1_024 && !/[\r\n]/u.test(entry);
    if (Array.isArray(entry)) return entry.length <= 64 && entry.every((item) => visit(item, depth + 1));
    const object = record(entry);
    if (!object || Object.keys(object).length > 64) return false;
    return Object.entries(object).every(([key, item]) =>
      key.length > 0 && key.length <= 128 && key !== "__proto__" && key !== "prototype" &&
      key !== "constructor" && visit(item, depth + 1),
    );
  };
  return visit(value, 0);
}

function safeBaseUrl(value: unknown, policy: CatalogPolicy): value is string {
  if (value === "" && policy.allowEmptyBaseUrl) return true;
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      (policy.allowedOrigins === undefined || policy.allowedOrigins.has(url.origin));
  } catch {
    return false;
  }
}

function safeHeaders(value: unknown): value is Record<string, string> {
  if (value === undefined) return true;
  const headers = record(value);
  if (!headers || Object.keys(headers).length > 32) return false;
  const forbidden = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
  ]);
  return Object.entries(headers).every(([name, entry]) =>
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name) &&
    !forbidden.has(name.toLowerCase()) &&
    typeof entry === "string" && entry.length <= 1_024 && !/[\r\n]/u.test(entry),
  );
}

function normalizeModel(providerId: string, value: unknown, policy: CatalogPolicy): Model<Api> | undefined {
  const model = record(value);
  if (!model) return undefined;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  const name = typeof model.name === "string" ? model.name.trim() : "";
  const api = typeof model.api === "string" ? model.api : "";
  const input = model.input;
  const compat = model.compat;
  if (!id || id.length > MAX_MODEL_ID_LENGTH || !name || name.length > MAX_MODEL_NAME_LENGTH || !api ||
    (policy.allowedApis !== undefined && !policy.allowedApis.has(api)) ||
    !safeBaseUrl(model.baseUrl, policy) || typeof model.reasoning !== "boolean" ||
    !Array.isArray(input) || input.length === 0 || input.length > 2 || new Set(input).size !== input.length ||
    !input.every((entry) => entry === "text" || entry === "image") || !safeCostRecord(model.cost) ||
    !safePositiveInteger(model.contextWindow) || !safePositiveInteger(model.maxTokens) ||
    !safeThinkingLevelMap(model.thinkingLevelMap) || !safeCompat(compat) ||
    !safeHeaders(model.headers)) {
    return undefined;
  }
  return {
    id,
    name,
    api,
    provider: providerId,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: structuredClone(model.thinkingLevelMap) }),
    input: [...input],
    cost: structuredClone(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers === undefined ? {} : { headers: structuredClone(model.headers) }),
    ...(compat === undefined ? {} : { compat: structuredClone(compat) }),
  } as Model<Api>;
}

export function parsePiRemoteCatalog(providerId: string, value: unknown, policy: CatalogPolicy = {}): Model<Api>[] {
  const entries = catalogEntries(value);
  if (!entries || entries.length > MAX_CATALOG_MODELS) {
    throw new Error(`Invalid model catalog for provider "${providerId}".`);
  }
  const models: Model<Api>[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const model = normalizeModel(providerId, entry, policy);
    if (!model || ids.has(model.id)) {
      throw new Error(`Invalid model catalog entry for provider "${providerId}".`);
    }
    ids.add(model.id);
    models.push(model);
  }
  return models;
}

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
  const merged = [...baseline];
  for (const model of dynamic) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;
    else merged.push(model);
  }
  return merged;
}

function versionParts(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

export function catalogVersionSupported(minimum: string | null): boolean {
  if (!minimum) return true;
  const required = versionParts(minimum);
  const installed = versionParts(AIDEN_PI_CATALOG_VERSION);
  if (!required || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (installed[index]! > required[index]!) return true;
    if (installed[index]! < required[index]!) return false;
  }
  return true;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Model catalog response is too large.");
  }
  if (!response.body) throw new Error("Model catalog response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Model catalog response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
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
    throw new Error("Model catalog response is invalid JSON.");
  }
}

/** Adds a durable, credential-free pi.dev overlay to a static built-in provider. */
export function withPiRemoteCatalog(provider: Provider, options: PiRemoteCatalogOptions = {}): Provider {
  const baseline = provider.getModels();
  const allowedApis = new Set([
    ...baseline.map((model) => model.api),
    ...(options.supportedApis ?? []),
  ]);
  const allowedOrigins = new Set(
    [provider.baseUrl, ...baseline.map((model) => model.baseUrl)]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => {
        try { return [new URL(value).origin]; } catch { return []; }
      }),
  );
  const policy = {
    allowedApis,
    allowedOrigins,
    allowEmptyBaseUrl: provider.baseUrl === "" || baseline.some((model) => model.baseUrl === ""),
  };
  const catalogBaseUrl = options.catalogBaseUrl ?? DEFAULT_CATALOG_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const localGeneratedAt = options.localGeneratedAt ?? AIDEN_PI_CATALOG_GENERATED_AT;
  let dynamicModels: readonly Model<Api>[] = [];
  let activeNetworkRefresh: Promise<void> | null = null;

  const restoredCatalog = (
    entry: ModelsStoreEntry | undefined,
  ): { models: readonly Model<Api>[]; lastModified: number } | undefined => {
    if (!entry) return undefined;
    const persisted = entry as PersistedRemoteCatalog;
    const acceptedAt = persisted.checkedAt;
    if (persisted.lastModified === undefined || persisted.lastModified <= localGeneratedAt ||
      !Number.isSafeInteger(acceptedAt) ||
      persisted.lastModified > acceptedAt! + MAX_CATALOG_CLOCK_SKEW_MS) return undefined;
    try {
      return {
        models: parsePiRemoteCatalog(provider.id, entry.models, policy),
        lastModified: persisted.lastModified,
      };
    } catch {
      return undefined;
    }
  };
  const cacheIsFresh = (entry: ModelsStoreEntry | undefined): boolean => {
    if (!entry || !Number.isSafeInteger(entry.checkedAt)) return false;
    const checkedNow = now();
    if (entry.checkedAt! > checkedNow + MAX_CATALOG_CLOCK_SKEW_MS ||
      checkedNow - entry.checkedAt! >= PI_REMOTE_CATALOG_REFRESH_INTERVAL_MS) return false;
    const persisted = entry as PersistedRemoteCatalog;
    if (restoredCatalog(entry)) return true;
    // A 404/501 is a valid negative cache entry. It is deliberately distinct
    // from a malformed catalog and from a poisoned future generation.
    return entry.models.length === 0 && persisted.lastModified === undefined && persisted.etag === undefined;
  };

  const wrapped: Provider = {
    ...provider,
    getModels: () => mergeModels(baseline, dynamicModels),
    refreshModels: async (context) => {
      const stored = (await context.store.read()) as PersistedRemoteCatalog | undefined;
      const restored = restoredCatalog(stored);
      dynamicModels = restored?.models ?? [];
      if (!context.allowNetwork || context.signal?.aborted) return;
      if (!context.force && cacheIsFresh(stored)) return;
      if (activeNetworkRefresh) return activeNetworkRefresh;

      const task = (async () => {
        const validator = restored ? stored?.etag : undefined;
        const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
        const response = await fetchImpl(url, {
          headers: {
            accept: "application/json",
            "user-agent": AIDEN_PI_CATALOG_USER_AGENT,
            ...(validator ? { "if-none-match": validator } : {}),
          },
          redirect: "error",
          signal: context.signal,
        });
        if (context.signal?.aborted) return;
        const checkedAt = now();
        if (response.status === 304 && stored && restored) {
          await context.store.write({
            ...stored,
            // A local clock rollback must not invalidate the generation's
            // original acceptance boundary on the next process launch.
            checkedAt: Math.max(stored.checkedAt ?? 0, checkedAt),
          });
          return;
        }
        if (response.status === 404 || response.status === 501) {
          await response.body?.cancel().catch(() => undefined);
          const retained: PersistedRemoteCatalog = {
            ...(restored && stored ? stored : { models: [] }),
            checkedAt: restored && stored
              ? Math.max(stored.checkedAt ?? 0, checkedAt)
              : checkedAt,
            etag: undefined,
          };
          await context.store.write(retained);
          return;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
        }
        const minimum = response.headers.get("x-pi-model-catalog-minimum-version");
        if (!catalogVersionSupported(minimum)) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`${provider.id} model catalog requires Pi ${minimum ?? "a newer version"}.`);
        }
        const refreshed = parsePiRemoteCatalog(provider.id, await readBoundedJson(response), policy);
        if (context.signal?.aborted) return;
        const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
        if (Number.isNaN(lastModified) || lastModified <= localGeneratedAt) {
          throw new Error(`${provider.id} model catalog is missing a newer generation timestamp.`);
        }
        const remoteModified = lastModified;
        if (remoteModified > checkedAt + MAX_CATALOG_CLOCK_SKEW_MS) {
          throw new Error(`${provider.id} model catalog has an invalid future generation timestamp.`);
        }
        if (restored && remoteModified < restored.lastModified) {
          throw new Error(`${provider.id} model catalog is older than the cached generation.`);
        }
        const entry: PersistedRemoteCatalog = {
          models: refreshed,
          checkedAt,
          lastModified: remoteModified,
          etag: response.headers.get("etag") ?? undefined,
        };
        await context.store.write(entry);
        if (!context.signal?.aborted) dynamicModels = refreshed;
      })();
      activeNetworkRefresh = task;
      try { await task; } finally { if (activeNetworkRefresh === task) activeNetworkRefresh = null; }
    },
  };
  remoteCatalogFreshness.set(wrapped, cacheIsFresh);
  return wrapped;
}
