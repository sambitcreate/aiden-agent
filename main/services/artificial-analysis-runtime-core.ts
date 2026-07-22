import { randomUUID } from "node:crypto";
import {
  MAX_ARTIFICIAL_ANALYSIS_MODELS,
  parseArtificialAnalysisUserCache,
  type ArtificialAnalysisSnapshotModel,
  type ArtificialAnalysisTier,
  type ArtificialAnalysisUserCache,
} from "./artificial-analysis-catalog-core.js";

export const ARTIFICIAL_ANALYSIS_FREE_ENDPOINT =
  "https://artificialanalysis.ai/api/v2/language/models/free";
export const ARTIFICIAL_ANALYSIS_SOURCE_URL = "https://artificialanalysis.ai/data-api";

const DEFAULT_MAX_PAGES = 10_000;
const DEFAULT_MAX_MODELS = MAX_ARTIFICIAL_ANALYSIS_MODELS;
const DEFAULT_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ArtificialAnalysisConnectionState = "not_connected" | "connected" | "ready";

export interface ArtificialAnalysisStatus {
  state: ArtificialAnalysisConnectionState;
  hasKey: boolean;
  cleanupNeeded: boolean;
  ready: boolean;
  cachedModelCount: number;
  rankedModelCount: number;
  fetchedAt?: string;
  tier?: ArtificialAnalysisTier;
  intelligenceIndexVersion?: number;
}

export type ArtificialAnalysisFetchErrorCode =
  | "invalid_key"
  | "access_denied"
  | "rate_limited"
  | "service_unavailable"
  | "network_error"
  | "invalid_response";

export class ArtificialAnalysisFetchError extends Error {
  constructor(
    readonly code: ArtificialAnalysisFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtificialAnalysisFetchError";
  }
}

export class ArtificialAnalysisInputError extends Error {
  readonly code = "invalid_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "ArtificialAnalysisInputError";
  }
}

export class ArtificialAnalysisStateError extends Error {
  readonly code = "not_connected" as const;

  constructor(message: string) {
    super(message);
    this.name = "ArtificialAnalysisStateError";
  }
}

export type ArtificialAnalysisActionErrorCode =
  | ArtificialAnalysisFetchErrorCode
  | "invalid_input"
  | "not_connected"
  | "local_error";

export type ArtificialAnalysisActionResult =
  | { ok: true; status: ArtificialAnalysisStatus }
  | { ok: false; code: ArtificialAnalysisActionErrorCode; message: string };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ArtificialAnalysisFetchOptions {
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  limits?: Partial<ArtificialAnalysisFetchLimits>;
  generation?: () => string;
}

export interface ArtificialAnalysisFetchLimits {
  maxPages: number;
  maxModels: number;
  maxPageBytes: number;
  maxTotalBytes: number;
}

export interface ArtificialAnalysisStoredCredential {
  key: string;
  generation: string;
}

export interface ArtificialAnalysisCredentialStore {
  read(): Promise<ArtificialAnalysisStoredCredential | null>;
  write(credential: ArtificialAnalysisStoredCredential): Promise<void>;
  deleteKey(): Promise<void>;
}

export interface ArtificialAnalysisCacheStore {
  read(): Promise<ArtificialAnalysisUserCache | null>;
  write(cache: ArtificialAnalysisUserCache): Promise<void>;
  delete(): Promise<void>;
}

export interface ArtificialAnalysisRuntimeDependencies {
  credentials: ArtificialAnalysisCredentialStore;
  cache: ArtificialAnalysisCacheStore;
  fetchCatalog(key: string): Promise<ArtificialAnalysisUserCache>;
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeModel(value: unknown, index: number): ArtificialAnalysisSnapshotModel {
  const model = record(value);
  const creator = record(model?.model_creator);
  const evaluations = record(model?.evaluations);
  const performance = record(model?.performance);
  const id = optionalString(model?.id);
  const slug = optionalString(model?.slug);
  const name = optionalString(model?.name);
  const creatorName = optionalString(creator?.name);
  if (!id || !slug || !name) {
    throw new ArtificialAnalysisFetchError(
      "invalid_response",
      `Artificial Analysis model ${index + 1} is missing identity data.`,
    );
  }
  return omitUndefined({
    id,
    slug,
    name,
    creator: creatorName ?? "Unknown",
    release_date: optionalString(model?.release_date),
    intelligence_index: finiteNumber(evaluations?.artificial_analysis_intelligence_index),
    coding_index: finiteNumber(evaluations?.artificial_analysis_coding_index),
    agentic_index: finiteNumber(evaluations?.artificial_analysis_agentic_index),
    median_output_tokens_per_second: positiveNumber(performance?.median_output_tokens_per_second),
    median_time_to_first_token_seconds: positiveNumber(
      performance?.median_time_to_first_token_seconds,
    ),
    median_end_to_end_response_time_seconds: positiveNumber(
      performance?.median_end_to_end_response_time_seconds,
    ),
  });
}

/** Map numeric values to 0...1 using average ranks for ties. */
export function artificialAnalysisPercentiles(
  models: ArtificialAnalysisSnapshotModel[],
  select: (model: ArtificialAnalysisSnapshotModel) => number | undefined,
): Map<string, number> {
  const rows = models
    .map((model) => ({ id: model.id, value: select(model) }))
    .filter((row): row is { id: string; value: number } => row.value !== undefined)
    .sort((left, right) => left.value - right.value || left.id.localeCompare(right.id));
  const result = new Map<string, number>();
  if (rows.length === 0) return result;
  if (rows.length === 1) {
    result.set(rows[0].id, 0.5);
    return result;
  }
  for (let start = 0; start < rows.length; ) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1].value === rows[start].value) end += 1;
    const percentile = (start + end) / 2 / (rows.length - 1);
    for (let index = start; index <= end; index += 1) {
      result.set(rows[index].id, percentile);
    }
    start = end + 1;
  }
  return result;
}

class ArtificialAnalysisCacheBuilder {
  private tier: ArtificialAnalysisTier | undefined;
  private indexVersion: number | undefined;
  private totalPages: number | undefined;
  private pageSize: number | undefined;
  private pagesRead = 0;
  private readonly models: ArtificialAnalysisSnapshotModel[] = [];
  private readonly ids = new Set<string>();

  constructor(
    private readonly maxPages: number,
    private readonly maxModels: number,
  ) {}

  addPage(value: unknown): number {
    const pageNumber = this.pagesRead + 1;
    const page = record(value);
    const pagination = record(page?.pagination);
    const tier = page?.tier;
    const indexVersion = finiteNumber(page?.intelligence_index_version);
    const totalPages = pagination?.total_pages;
    const pageSize = pagination?.page_size;
    if (
      !page ||
      (tier !== "free" && tier !== "pro" && tier !== "commercial") ||
      indexVersion === undefined ||
      !Number.isInteger(totalPages) ||
      (totalPages as number) < 1 ||
      (totalPages as number) > this.maxPages ||
      !Number.isInteger(pageSize) ||
      (pageSize as number) < 1 ||
      pagination?.page !== pageNumber ||
      pagination.has_more !== pageNumber < (totalPages as number) ||
      !Array.isArray(page.data)
    ) {
      throw new ArtificialAnalysisFetchError(
        "invalid_response",
        `Artificial Analysis page ${pageNumber} returned invalid metadata.`,
      );
    }
    if (this.pagesRead === 0) {
      this.tier = tier;
      this.indexVersion = indexVersion;
      this.totalPages = totalPages as number;
      this.pageSize = pageSize as number;
    } else if (
      tier !== this.tier ||
      indexVersion !== this.indexVersion ||
      totalPages !== this.totalPages ||
      pageSize !== this.pageSize
    ) {
      throw new ArtificialAnalysisFetchError(
        "invalid_response",
        `Artificial Analysis page ${pageNumber} returned inconsistent pagination.`,
      );
    }

    for (const rawModel of page.data) {
      if (this.models.length >= this.maxModels) {
        throw new ArtificialAnalysisFetchError(
          "invalid_response",
          "Artificial Analysis returned more models than Aiden can safely process.",
        );
      }
      const model = normalizeModel(rawModel, this.models.length);
      if (this.ids.has(model.id)) {
        throw new ArtificialAnalysisFetchError(
          "invalid_response",
          "Artificial Analysis returned duplicate model identifiers.",
        );
      }
      this.ids.add(model.id);
      this.models.push(model);
    }
    this.pagesRead = pageNumber;
    return this.totalPages as number;
  }

  finish(fetchedAt: string, generation: string): ArtificialAnalysisUserCache {
    if (
      this.pagesRead === 0 ||
      this.pagesRead !== this.totalPages ||
      !this.tier ||
      this.indexVersion === undefined
    ) {
      throw new ArtificialAnalysisFetchError(
        "invalid_response",
        "Artificial Analysis returned incomplete model data.",
      );
    }
    if (!Number.isFinite(Date.parse(fetchedAt))) {
      throw new Error("Artificial Analysis fetchedAt must be an ISO timestamp.");
    }
    if (!/^[a-z0-9][a-z0-9-]{7,127}$/iu.test(generation)) {
      throw new Error("Artificial Analysis cache generation is invalid.");
    }
    if (this.models.length === 0) {
      throw new ArtificialAnalysisFetchError(
        "invalid_response",
        "Artificial Analysis returned no models.",
      );
    }

    const capability = artificialAnalysisPercentiles(
      this.models,
      (model) => model.intelligence_index,
    );
    const responseTime = artificialAnalysisPercentiles(
      this.models,
      (model) => model.median_end_to_end_response_time_seconds,
    );
    const ranked = this.models
      .map((model) => {
        const capabilityPercentile = capability.get(model.id);
        const responseTimePercentile = responseTime.get(model.id);
        return omitUndefined({
          ...model,
          ranking:
            capabilityPercentile === undefined || responseTimePercentile === undefined
              ? undefined
              : {
                  capability_percentile: capabilityPercentile,
                  response_time_percentile: responseTimePercentile,
                  pace_metric: "median_end_to_end_response_time_seconds" as const,
                },
        });
      })
      .sort(
        (left, right) =>
          left.creator.localeCompare(right.creator) ||
          left.name.localeCompare(right.name) ||
          left.slug.localeCompare(right.slug) ||
          left.id.localeCompare(right.id),
      );

    return parseArtificialAnalysisUserCache({
      schema_version: 1,
      source: {
        name: "Artificial Analysis",
        url: ARTIFICIAL_ANALYSIS_SOURCE_URL,
        endpoint: ARTIFICIAL_ANALYSIS_FREE_ENDPOINT,
        generation,
        fetched_at: fetchedAt,
        tier: this.tier,
        intelligence_index_version: this.indexVersion,
      },
      models: ranked,
    });
  }
}

export function buildArtificialAnalysisUserCache(
  pages: unknown[],
  fetchedAt: string,
  generation: string = randomUUID(),
): ArtificialAnalysisUserCache {
  const builder = new ArtificialAnalysisCacheBuilder(DEFAULT_MAX_PAGES, DEFAULT_MAX_MODELS);
  for (const page of pages) builder.addPage(page);
  return builder.finish(fetchedAt, generation);
}

export function normalizeArtificialAnalysisApiKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ArtificialAnalysisInputError("Paste an Artificial Analysis API key.");
  }
  const key = value.trim();
  if (key.length > 4_096) {
    throw new ArtificialAnalysisInputError("The Artificial Analysis API key is too long.");
  }
  if (
    Array.from(key).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new ArtificialAnalysisInputError(
      "The Artificial Analysis API key contains unsupported characters.",
    );
  }
  return key;
}

function responseError(status: number): ArtificialAnalysisFetchError {
  if (status === 401) {
    return new ArtificialAnalysisFetchError(
      "invalid_key",
      "Artificial Analysis did not accept that API key. Check the key and try again.",
    );
  }
  if (status === 403) {
    return new ArtificialAnalysisFetchError(
      "access_denied",
      "This Artificial Analysis key cannot access the model data endpoint.",
    );
  }
  if (status === 429) {
    return new ArtificialAnalysisFetchError(
      "rate_limited",
      "Artificial Analysis has reached this key's daily request limit. Try again after the quota resets.",
    );
  }
  if (status >= 500) {
    return new ArtificialAnalysisFetchError(
      "service_unavailable",
      "Artificial Analysis is temporarily unavailable. Try fetching again later.",
    );
  }
  return new ArtificialAnalysisFetchError(
    "invalid_response",
    "Artificial Analysis rejected the model data request.",
  );
}

interface ReadPageResult {
  value: unknown;
  bytes: number;
}

async function readJsonResponse(response: Response, maxBytes: number): Promise<ReadPageResult> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ArtificialAnalysisFetchError(
      "invalid_response",
      "Artificial Analysis returned a response that was too large.",
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ArtificialAnalysisFetchError(
            "invalid_response",
            "Artificial Analysis returned a response that was too large.",
          );
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  ).toString("utf8");
  try {
    return { value: JSON.parse(text) as unknown, bytes };
  } catch {
    throw new ArtificialAnalysisFetchError(
      "invalid_response",
      "Artificial Analysis returned data Aiden could not read.",
    );
  }
}

async function requestPage(
  page: number,
  key: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  maxPageBytes: number,
): Promise<ReadPageResult> {
  try {
    const response = await fetchImpl(`${ARTIFICIAL_ANALYSIS_FREE_ENDPOINT}?page=${page}`, {
      method: "GET",
      headers: { accept: "application/json", "x-api-key": key },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw responseError(response.status);
    return await readJsonResponse(response, maxPageBytes);
  } catch (error) {
    if (error instanceof ArtificialAnalysisFetchError) throw error;
    throw new ArtificialAnalysisFetchError(
      "network_error",
      signal.aborted
        ? "Artificial Analysis did not respond in time. Try fetching again."
        : "Aiden could not reach Artificial Analysis. Check your connection and try again.",
    );
  }
}

function resolveLimits(
  overrides: Partial<ArtificialAnalysisFetchLimits> | undefined,
): ArtificialAnalysisFetchLimits {
  const limits: ArtificialAnalysisFetchLimits = {
    maxPages: overrides?.maxPages ?? DEFAULT_MAX_PAGES,
    maxModels: overrides?.maxModels ?? DEFAULT_MAX_MODELS,
    maxPageBytes: overrides?.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES,
    maxTotalBytes: overrides?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.maxTotalBytes < limits.maxPageBytes
  ) {
    throw new Error("Artificial Analysis response limits must be positive and internally valid.");
  }
  return limits;
}

export async function fetchArtificialAnalysisUserCache(
  apiKey: string,
  options: ArtificialAnalysisFetchOptions = {},
): Promise<ArtificialAnalysisUserCache> {
  const key = normalizeArtificialAnalysisApiKey(apiKey);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Artificial Analysis request timeout must be positive.");
  }
  const limits = resolveLimits(options.limits);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const builder = new ArtificialAnalysisCacheBuilder(limits.maxPages, limits.maxModels);
    const first = await requestPage(1, key, fetchImpl, controller.signal, limits.maxPageBytes);
    let totalBytes = first.bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ArtificialAnalysisFetchError(
        "invalid_response",
        "Artificial Analysis returned more data than Aiden can safely process.",
      );
    }
    const totalPages = builder.addPage(first.value);
    for (let page = 2; page <= totalPages; page += 1) {
      const next = await requestPage(page, key, fetchImpl, controller.signal, limits.maxPageBytes);
      totalBytes += next.bytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new ArtificialAnalysisFetchError(
          "invalid_response",
          "Artificial Analysis returned more data than Aiden can safely process.",
        );
      }
      builder.addPage(next.value);
    }
    return builder.finish(
      (options.now ?? (() => new Date()))().toISOString(),
      (options.generation ?? randomUUID)(),
    );
  } finally {
    clearTimeout(timer);
  }
}

function cacheMatchesCredential(
  credential: ArtificialAnalysisStoredCredential | null,
  cache: ArtificialAnalysisUserCache | null,
): cache is ArtificialAnalysisUserCache {
  return credential !== null && cache?.source.generation === credential.generation;
}

function statusFrom(
  credential: ArtificialAnalysisStoredCredential | null,
  cache: ArtificialAnalysisUserCache | null,
): ArtificialAnalysisStatus {
  const hasKey = credential !== null;
  const ready = cacheMatchesCredential(credential, cache);
  const cleanupNeeded = !hasKey && cache !== null;
  return {
    state: ready ? "ready" : hasKey ? "connected" : "not_connected",
    hasKey,
    cleanupNeeded,
    ready,
    cachedModelCount: ready ? cache.models.length : 0,
    rankedModelCount: ready ? cache.models.filter((model) => model.ranking).length : 0,
    fetchedAt: ready ? cache.source.fetched_at : undefined,
    tier: ready ? cache.source.tier : undefined,
    intelligenceIndexVersion: ready ? cache.source.intelligence_index_version : undefined,
  };
}

/** Serializes mutations while allowing fail-closed offline reads during a manual network fetch. */
export class ArtificialAnalysisRuntime {
  private readonly actionMutex = new AsyncMutex();
  private readonly stateMutex = new AsyncMutex();

  constructor(private readonly dependencies: ArtificialAnalysisRuntimeDependencies) {}

  async status(): Promise<ArtificialAnalysisStatus> {
    return this.stateMutex.run(async () => {
      const credential = await this.dependencies.credentials.read();
      const cache = await this.dependencies.cache.read();
      return statusFrom(credential, cache);
    });
  }

  async catalog(): Promise<ArtificialAnalysisUserCache | null> {
    return this.stateMutex.run(async () => {
      const credential = await this.dependencies.credentials.read();
      if (!credential) return null;
      const cache = await this.dependencies.cache.read();
      return cacheMatchesCredential(credential, cache) ? cache : null;
    });
  }

  async connect(apiKey: unknown): Promise<ArtificialAnalysisStatus> {
    const key = normalizeArtificialAnalysisApiKey(apiKey);
    return this.actionMutex.run(async () => {
      const cache = await this.dependencies.fetchCatalog(key);
      return this.stateMutex.run(async () => {
        const previousCredential = await this.dependencies.credentials.read();
        await this.dependencies.credentials.write({ key, generation: cache.source.generation });
        try {
          await this.dependencies.cache.write(cache);
        } catch (error) {
          try {
            if (previousCredential) await this.dependencies.credentials.write(previousCredential);
            else await this.dependencies.credentials.deleteKey();
          } catch {
            throw new Error(
              "Aiden could not save the Artificial Analysis cache or restore the previous key.",
            );
          }
          throw error;
        }
        return statusFrom({ key, generation: cache.source.generation }, cache);
      });
    });
  }

  async refresh(): Promise<ArtificialAnalysisStatus> {
    return this.actionMutex.run(async () => {
      const previousCredential = await this.stateMutex.run(() =>
        this.dependencies.credentials.read(),
      );
      if (!previousCredential) {
        throw new ArtificialAnalysisStateError(
          "Connect Artificial Analysis before fetching model data.",
        );
      }
      const cache = await this.dependencies.fetchCatalog(previousCredential.key);
      return this.stateMutex.run(async () => {
        const currentCredential = await this.dependencies.credentials.read();
        if (
          currentCredential?.key !== previousCredential.key ||
          currentCredential.generation !== previousCredential.generation
        ) {
          throw new ArtificialAnalysisStateError(
            "Artificial Analysis connection changed while model data was being fetched. Try again.",
          );
        }
        const nextCredential = {
          key: previousCredential.key,
          generation: cache.source.generation,
        };
        await this.dependencies.credentials.write(nextCredential);
        try {
          await this.dependencies.cache.write(cache);
        } catch (error) {
          try {
            await this.dependencies.credentials.write(previousCredential);
          } catch {
            throw new Error(
              "Aiden could not save the Artificial Analysis cache or restore its previous generation.",
            );
          }
          throw error;
        }
        return statusFrom(nextCredential, cache);
      });
    });
  }

  async disconnect(): Promise<ArtificialAnalysisStatus> {
    return this.actionMutex.run(async () => {
      return this.stateMutex.run(async () => {
        const results = await Promise.allSettled([
          this.dependencies.credentials.deleteKey(),
          this.dependencies.cache.delete(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return statusFrom(null, null);
      });
    });
  }
}
