import type { ModelBenchmarkScores } from "./types.js";

export const OPENROUTER_BENCHMARK_ENDPOINT =
  "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&max_results=100";
export const OPENROUTER_BENCHMARK_SOURCE_URL = "https://artificialanalysis.ai";
export const OPENROUTER_BENCHMARK_LICENSE = "CC BY 4.0" as const;
export const MAX_OPENROUTER_BENCHMARK_MODELS = 100;

export interface OpenRouterBenchmarkModel {
  modelPermaslug: string;
  displayName: string;
  intelligence?: number;
  coding?: number;
  agentic?: number;
}

export interface OpenRouterBenchmarkCache {
  schemaVersion: 1;
  source: {
    name: "OpenRouter Benchmarks";
    datasetSource: "artificial-analysis";
    endpoint: typeof OPENROUTER_BENCHMARK_ENDPOINT;
    sourceUrl: typeof OPENROUTER_BENCHMARK_SOURCE_URL;
    version: "v1";
    citation: string;
    license: typeof OPENROUTER_BENCHMARK_LICENSE;
    asOf: string;
    fetchedAt: string;
  };
  models: OpenRouterBenchmarkModel[];
}

export interface ModelsDevBenchmarkIdentity {
  /** OpenRouter/Artificial Analysis author slug when the provider is direct. */
  author?: string;
  /** Exact model ID from the bundled models.dev provider record. */
  modelId: string;
  /** Exact display name from the same bundled models.dev record. */
  name: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, field: string, maximum = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`OpenRouter benchmark field "${field}" must be a non-empty string.`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 128);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new Error(`OpenRouter benchmark field "${field}" must be an ISO timestamp.`);
  }
  return parsed;
}

function isArtificialAnalysisSourceUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const sourceUrl = new URL(value);
    return sourceUrl.protocol === "https:" && sourceUrl.hostname === "artificialanalysis.ai";
  } catch {
    return false;
  }
}

function hasRequiredAttribution(value: string): boolean {
  const normalized = value.toLocaleLowerCase();
  return normalized.includes("artificial analysis") && normalized.includes("openrouter");
}

function score(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`OpenRouter benchmark field "${field}" must be between 0 and 100.`);
  }
  return value;
}

function parseModel(value: unknown, index: number): OpenRouterBenchmarkModel {
  const model = record(value);
  if (!model || model.source !== "artificial-analysis") {
    throw new Error(`OpenRouter benchmark model ${index} has an invalid source.`);
  }
  const modelPermaslug = requiredString(
    model.model_permaslug,
    `data[${index}].model_permaslug`,
    256,
  );
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:@/-]*$/iu.test(modelPermaslug)) {
    throw new Error(`OpenRouter benchmark model ${index} has an invalid permaslug.`);
  }
  const parsed = {
    modelPermaslug,
    displayName: requiredString(model.display_name, `data[${index}].display_name`, 256),
    intelligence: score(model.intelligence_index, `data[${index}].intelligence_index`),
    coding: score(model.coding_index, `data[${index}].coding_index`),
    agentic: score(model.agentic_index, `data[${index}].agentic_index`),
  };
  if (
    parsed.intelligence === undefined &&
    parsed.coding === undefined &&
    parsed.agentic === undefined
  ) {
    throw new Error(`OpenRouter benchmark model ${index} contains no benchmark scores.`);
  }
  return parsed;
}

function parseModels(value: unknown): OpenRouterBenchmarkModel[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_OPENROUTER_BENCHMARK_MODELS
  ) {
    throw new Error("OpenRouter benchmark data must contain between 1 and 100 models.");
  }
  const models = value.map(parseModel);
  if (
    new Set(models.map((model) => model.modelPermaslug.toLocaleLowerCase())).size !== models.length
  ) {
    throw new Error("OpenRouter benchmark data contains duplicate model identifiers.");
  }
  return models;
}

/** Normalize one authenticated OpenRouter Data API response for durable device-local use. */
export function buildOpenRouterBenchmarkCache(
  value: unknown,
  fetchedAt = new Date().toISOString(),
): OpenRouterBenchmarkCache {
  const response = record(value);
  const meta = record(response?.meta);
  if (!response || !meta || meta.version !== "v1" || meta.source !== "artificial-analysis") {
    throw new Error("OpenRouter benchmark response metadata is invalid.");
  }
  if (!isArtificialAnalysisSourceUrl(meta.source_url)) {
    throw new Error("OpenRouter benchmark response has an unexpected source URL.");
  }
  const citation = requiredString(meta.citation, "meta.citation", 2_048);
  if (!hasRequiredAttribution(citation)) {
    throw new Error("OpenRouter benchmark response has an invalid citation.");
  }
  const models = parseModels(response.data);
  if (
    typeof meta.model_count !== "number" ||
    !Number.isSafeInteger(meta.model_count) ||
    meta.model_count < models.length
  ) {
    throw new Error("OpenRouter benchmark response model count is invalid.");
  }
  return {
    schemaVersion: 1,
    source: {
      name: "OpenRouter Benchmarks",
      datasetSource: "artificial-analysis",
      endpoint: OPENROUTER_BENCHMARK_ENDPOINT,
      sourceUrl: OPENROUTER_BENCHMARK_SOURCE_URL,
      version: "v1",
      citation,
      license: OPENROUTER_BENCHMARK_LICENSE,
      asOf: timestamp(meta.as_of, "meta.as_of"),
      fetchedAt: timestamp(fetchedAt, "fetchedAt"),
    },
    models,
  };
}

/** Validate a previously normalized device-local OpenRouter benchmark cache. */
export function parseOpenRouterBenchmarkCache(value: unknown): OpenRouterBenchmarkCache {
  const cache = record(value);
  const source = record(cache?.source);
  if (
    !cache ||
    cache.schemaVersion !== 1 ||
    !source ||
    source.name !== "OpenRouter Benchmarks" ||
    source.datasetSource !== "artificial-analysis" ||
    source.endpoint !== OPENROUTER_BENCHMARK_ENDPOINT ||
    source.sourceUrl !== OPENROUTER_BENCHMARK_SOURCE_URL ||
    source.version !== "v1" ||
    source.license !== OPENROUTER_BENCHMARK_LICENSE
  ) {
    throw new Error("OpenRouter benchmark cache metadata is invalid.");
  }
  const citation = requiredString(source.citation, "source.citation", 2_048);
  if (!hasRequiredAttribution(citation)) {
    throw new Error("OpenRouter benchmark cache has an invalid citation.");
  }
  return {
    schemaVersion: 1,
    source: {
      name: "OpenRouter Benchmarks",
      datasetSource: "artificial-analysis",
      endpoint: OPENROUTER_BENCHMARK_ENDPOINT,
      sourceUrl: OPENROUTER_BENCHMARK_SOURCE_URL,
      version: "v1",
      citation,
      license: OPENROUTER_BENCHMARK_LICENSE,
      asOf: timestamp(source.asOf, "source.asOf"),
      fetchedAt: timestamp(source.fetchedAt, "source.fetchedAt"),
    },
    models: parseModels(
      Array.isArray(cache.models)
        ? cache.models.map((value) => {
            const model = record(value);
            return {
              source: "artificial-analysis",
              model_permaslug: model?.modelPermaslug,
              display_name: model?.displayName,
              intelligence_index: model?.intelligence,
              coding_index: model?.coding,
              agentic_index: model?.agentic,
            };
          })
        : cache.models,
    ),
  };
}

const OPENROUTER_AUTHOR: Readonly<Record<string, string>> = {
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  xai: "x-ai",
  mistral: "mistralai",
  minimax: "minimax",
  zai: "z-ai",
  "zai-coding-cn": "z-ai",
  xiaomi: "xiaomi",
  nvidia: "nvidia",
};

function benchmarkScores(
  cache: OpenRouterBenchmarkCache,
  model: OpenRouterBenchmarkModel,
): ModelBenchmarkScores {
  return {
    source: "openrouter",
    datasetSource: "artificial-analysis",
    sourceLabel: "Artificial Analysis via OpenRouter",
    sourceUrl: cache.source.sourceUrl,
    citation: cache.source.citation,
    asOf: cache.source.asOf,
    license: cache.source.license,
    ...(model.intelligence === undefined ? {} : { intelligence: model.intelligence }),
    ...(model.coding === undefined ? {} : { coding: model.coding }),
    ...(model.agentic === undefined ? {} : { agentic: model.agentic }),
  };
}

function splitPermaslug(value: string): { author: string; modelId: string } | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return {
    author: value.slice(0, slash).toLocaleLowerCase(),
    modelId: value.slice(slash + 1).toLocaleLowerCase(),
  };
}

function modelIdLeaf(value: string): string {
  const slash = value.lastIndexOf("/");
  return (slash >= 0 ? value.slice(slash + 1) : value).toLocaleLowerCase();
}

function withoutBenchmarkReleaseStamp(value: string): string {
  return value.replace(/-(?:19|20)\d{6}$/u, "");
}

function normalizedCatalogName(value: string): string {
  let name = value.trim();
  while (/\s*\([^()]*\)\s*$/u.test(name)) {
    name = name.replace(/\s*\([^()]*\)\s*$/u, "").trim();
  }
  return name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function uniqueBenchmark(
  models: readonly OpenRouterBenchmarkModel[],
  predicate: (model: OpenRouterBenchmarkModel) => boolean,
): OpenRouterBenchmarkModel | undefined {
  const matches = models.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Resolve an OpenRouter benchmark through one exact models.dev identity.
 *
 * The source may append an eight-digit publication stamp or order vendor words
 * differently from the provider API ID. models.dev's provider-scoped ID/name
 * is authoritative; every normalized fallback must produce exactly one source
 * record or it fails closed.
 */
export function openRouterBenchmarkForModelsDevIdentity(
  cache: OpenRouterBenchmarkCache,
  identity: ModelsDevBenchmarkIdentity,
): ModelBenchmarkScores | undefined {
  const author = identity.author?.toLocaleLowerCase();
  const exactId = identity.modelId.toLocaleLowerCase();
  const leaf = modelIdLeaf(identity.modelId);
  const eligible = cache.models.filter((model) => {
    const parsed = splitPermaslug(model.modelPermaslug);
    return parsed !== null && (author === undefined || parsed.author === author);
  });

  const exact = uniqueBenchmark(eligible, (model) => {
    const permaslug = model.modelPermaslug.toLocaleLowerCase();
    return permaslug === exactId || (author !== undefined && permaslug === `${author}/${leaf}`);
  });
  if (exact) return benchmarkScores(cache, exact);

  const catalogName = normalizedCatalogName(identity.name);
  const byName = catalogName
    ? uniqueBenchmark(eligible, (model) => normalizedCatalogName(model.displayName) === catalogName)
    : undefined;
  if (byName) return benchmarkScores(cache, byName);

  const byStampedId = uniqueBenchmark(eligible, (model) => {
    const parsed = splitPermaslug(model.modelPermaslug);
    return parsed !== null && withoutBenchmarkReleaseStamp(parsed.modelId) === leaf;
  });
  return byStampedId ? benchmarkScores(cache, byStampedId) : undefined;
}

/** Match only exact OpenRouter permaslugs; ambiguous display-name and leaf matching are forbidden. */
export function openRouterBenchmarkForModel(
  cache: OpenRouterBenchmarkCache,
  providerId: string,
  modelId: string,
): ModelBenchmarkScores | undefined {
  const author = OPENROUTER_AUTHOR[providerId];
  const candidates = [
    ...(providerId === "openrouter" || modelId.includes("/") ? [modelId] : []),
    ...(author && !modelId.toLocaleLowerCase().startsWith(`${author}/`)
      ? [`${author}/${modelId}`]
      : []),
  ];
  if (candidates.length === 0) return undefined;
  const model = cache.models.find((entry) =>
    candidates.some(
      (candidate) => entry.modelPermaslug.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
    ),
  );
  if (!model) return undefined;
  return benchmarkScores(cache, model);
}
