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
    /** Response rows dropped because they shared a permaslug with another row. */
    skippedAmbiguous: number;
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
  /** models.dev `reasoning` flag; picks a reasoning variant when no base row exists. */
  reasoning?: boolean;
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

const MODEL_COUNT_ERROR = "OpenRouter benchmark data must contain between 1 and 100 models.";

/**
 * Parse every row, then drop all rows whose permaslug appears more than once:
 * a shared permaslug cannot say which row belongs to the model, so none does.
 */
function parseModels(value: unknown): {
  models: OpenRouterBenchmarkModel[];
  skippedAmbiguous: number;
} {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_OPENROUTER_BENCHMARK_MODELS
  ) {
    throw new Error(MODEL_COUNT_ERROR);
  }
  const parsed = value.map(parseModel);
  const occurrences = new Map<string, number>();
  for (const model of parsed) {
    const key = model.modelPermaslug.toLowerCase();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  const models = parsed.filter(
    (model) => occurrences.get(model.modelPermaslug.toLowerCase()) === 1,
  );
  if (models.length === 0) throw new Error(MODEL_COUNT_ERROR);
  return { models, skippedAmbiguous: parsed.length - models.length };
}

function skippedCount(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("OpenRouter benchmark cache skipped-row count is invalid.");
  }
  return value;
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
  const { models, skippedAmbiguous } = parseModels(response.data);
  if (
    typeof meta.model_count !== "number" ||
    !Number.isSafeInteger(meta.model_count) ||
    meta.model_count < models.length + skippedAmbiguous
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
      skippedAmbiguous,
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
      // Caches written before this count existed read as none skipped.
      skippedAmbiguous: skippedCount(source.skippedAmbiguous),
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
    ).models,
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
    author: value.slice(0, slash).toLowerCase(),
    modelId: value.slice(slash + 1).toLowerCase(),
  };
}

function modelIdLeaf(value: string): string {
  const slash = value.lastIndexOf("/");
  return (slash >= 0 ? value.slice(slash + 1) : value).toLowerCase();
}

function withoutBenchmarkReleaseStamp(value: string): string {
  return value.replace(/-(?:19|20)\d{6}$/u, "");
}

type BenchmarkVariant = "reasoning" | "non-reasoning";

const VARIANT_WORDS: ReadonlyMap<string, BenchmarkVariant> = new Map([
  ["reasoning", "reasoning"],
  ["thinking", "reasoning"],
  ["nonreasoning", "non-reasoning"],
  ["nonthinking", "non-reasoning"],
  ["nothinking", "non-reasoning"],
]);
const NEGATING_WORDS = new Set(["no", "non"]);

function catalogWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** Remove reasoning-variant words ("Thinking", "non-reasoning", "no thinking"). */
function withoutVariantWords(
  words: readonly string[],
  variants: Set<BenchmarkVariant>,
): string[] {
  const rest: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const next = words[index + 1];
    const variant = VARIANT_WORDS.get(word);
    if (NEGATING_WORDS.has(word) && next !== undefined && VARIANT_WORDS.get(next) === "reasoning") {
      variants.add("non-reasoning");
      index += 1;
    } else if (variant) {
      variants.add(variant);
    } else {
      rest.push(word);
    }
  }
  return rest;
}

interface CatalogIdentity {
  base: string;
  variant: BenchmarkVariant | null;
}

function identityFrom(
  base: string,
  variants: ReadonlySet<BenchmarkVariant>,
): CatalogIdentity | null {
  // Conflicting markers cannot name one variant, so the name matches nothing.
  if (!base || variants.size > 1) return null;
  return { base, variant: variants.values().next().value ?? null };
}

/**
 * Normalize a display name to its base name plus reasoning variant. Trailing
 * parentheticals ("(max)", "(Reasoning, Max Effort)") are dropped from the base
 * but still contribute their variant, so "X (Reasoning)" and "X (Non-reasoning)"
 * stay distinct.
 */
function catalogNameIdentity(
  value: string,
  variants = new Set<BenchmarkVariant>(),
): CatalogIdentity | null {
  let name = value.trim();
  let match: RegExpMatchArray | null;
  while ((match = name.match(/\s*\(([^()]*)\)\s*$/u))) {
    withoutVariantWords(catalogWords(match[1]), variants);
    name = name.slice(0, match.index).trim();
  }
  return identityFrom(withoutVariantWords(catalogWords(name), variants).join(""), variants);
}

function catalogIdentityKey(identity: CatalogIdentity): string {
  return `${identity.variant ?? "base"}:${identity.base}`;
}

interface IndexedBenchmark {
  model: OpenRouterBenchmarkModel;
  /** Position in `cache.models`, so multi-key lookups keep source order. */
  position: number;
  /** Lowercased permaslug author, or null when the permaslug has no author/model split. */
  author: string | null;
}

interface BenchmarkIndex {
  byPermaslug: Map<string, IndexedBenchmark[]>;
  byName: Map<string, IndexedBenchmark[]>;
  byStampedLeaf: Map<string, IndexedBenchmark[]>;
}

function pushIndexed(map: Map<string, IndexedBenchmark[]>, key: string, entry: IndexedBenchmark) {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

// Parsed caches are replaced, never mutated, so each object is indexed once.
const benchmarkIndexes = new WeakMap<OpenRouterBenchmarkCache, BenchmarkIndex>();

function benchmarkIndex(cache: OpenRouterBenchmarkCache): BenchmarkIndex {
  let index = benchmarkIndexes.get(cache);
  if (index) return index;
  index = { byPermaslug: new Map(), byName: new Map(), byStampedLeaf: new Map() };
  cache.models.forEach((model, position) => {
    const parsed = splitPermaslug(model.modelPermaslug);
    const entry: IndexedBenchmark = { model, position, author: parsed?.author ?? null };
    pushIndexed(index.byPermaslug, model.modelPermaslug.toLowerCase(), entry);
    if (parsed === null) return;
    const name = catalogNameIdentity(model.displayName);
    if (name) pushIndexed(index.byName, catalogIdentityKey(name), entry);
    pushIndexed(index.byStampedLeaf, withoutBenchmarkReleaseStamp(parsed.modelId), entry);
  });
  benchmarkIndexes.set(cache, index);
  return index;
}

function eligibleBenchmarks(
  candidates: ReadonlyArray<readonly IndexedBenchmark[] | undefined>,
  author: string | undefined,
): Set<IndexedBenchmark> {
  const matches = new Set<IndexedBenchmark>();
  for (const list of candidates) {
    for (const entry of list ?? []) {
      if (entry.author !== null && (author === undefined || entry.author === author)) {
        matches.add(entry);
      }
    }
  }
  return matches;
}

function onlyBenchmark(matches: Set<IndexedBenchmark>): OpenRouterBenchmarkModel | undefined {
  return matches.size === 1 ? matches.values().next().value?.model : undefined;
}

/** Exactly one eligible record across the candidate lists, or nothing. */
function uniqueBenchmark(
  candidates: ReadonlyArray<readonly IndexedBenchmark[] | undefined>,
  author: string | undefined,
): OpenRouterBenchmarkModel | undefined {
  return onlyBenchmark(eligibleBenchmarks(candidates, author));
}

/**
 * Match by normalized display name. A model whose name or ID carries a variant
 * marker matches only that variant; an unmarked model takes the base row, or,
 * when the source lists only variants, the one its models.dev reasoning flag
 * names. Every step needs exactly one eligible row.
 */
function benchmarkByCatalogName(
  index: BenchmarkIndex,
  identity: ModelsDevBenchmarkIdentity,
  author: string | undefined,
): OpenRouterBenchmarkModel | undefined {
  const variants = new Set<BenchmarkVariant>();
  withoutVariantWords(catalogWords(modelIdLeaf(identity.modelId)), variants);
  const name = catalogNameIdentity(identity.name, variants);
  if (!name) return undefined;
  if (name.variant) return uniqueBenchmark([index.byName.get(catalogIdentityKey(name))], author);

  const baseRows = eligibleBenchmarks([index.byName.get(catalogIdentityKey(name))], author);
  if (baseRows.size > 0 || identity.reasoning === undefined) return onlyBenchmark(baseRows);
  const variant: BenchmarkVariant = identity.reasoning ? "reasoning" : "non-reasoning";
  return uniqueBenchmark([index.byName.get(catalogIdentityKey({ ...name, variant }))], author);
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
  const author = identity.author?.toLowerCase();
  const leaf = modelIdLeaf(identity.modelId);
  const index = benchmarkIndex(cache);

  const exact = uniqueBenchmark(
    [
      index.byPermaslug.get(identity.modelId.toLowerCase()),
      author === undefined ? undefined : index.byPermaslug.get(`${author}/${leaf}`),
    ],
    author,
  );
  if (exact) return benchmarkScores(cache, exact);

  const byName = benchmarkByCatalogName(index, identity, author);
  if (byName) return benchmarkScores(cache, byName);

  const byStampedId = uniqueBenchmark([index.byStampedLeaf.get(leaf)], author);
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
    ...(author && !modelId.toLowerCase().startsWith(`${author}/`)
      ? [`${author}/${modelId}`]
      : []),
  ];
  const index = benchmarkIndex(cache);
  // The earliest record in source order wins, as the former linear scan did.
  let first: IndexedBenchmark | undefined;
  for (const candidate of candidates) {
    const hit = index.byPermaslug.get(candidate.toLowerCase())?.[0];
    if (hit && (first === undefined || hit.position < first.position)) first = hit;
  }
  return first ? benchmarkScores(cache, first.model) : undefined;
}
