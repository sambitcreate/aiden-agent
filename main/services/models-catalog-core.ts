import type { SamplingParamsByThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { isLocalProviderDeployment } from "../../renderer/shared/provider-deployment.js";
import {
  catalogProviderSlug,
  modelIdLeaf,
  openRouterAuthor,
} from "../../renderer/shared/model-catalog-provider.js";
import type { ModelCost, ModelInfo, ProviderModelMetadata, StoredProvider } from "./types.js";
import {
  openRouterBenchmarkForModel,
  openRouterBenchmarkForModelsDevIdentity,
  type OpenRouterBenchmarkCache,
} from "./openrouter-benchmark-catalog-core.js";

interface RawModel {
  id?: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  open_weights?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  /** Unvalidated by the catalog parser; normalized by `modelsDevCost`. */
  cost?: unknown;
  canonical_model_id?: unknown;
}

interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}

export type ModelCatalog = Record<string, RawProvider>;
export type ModelCatalogProvider = Pick<
  StoredProvider,
  "id" | "baseUrl" | "modelMetadata" | "deployment"
>;
export type RuntimeCatalogProvider = Pick<
  StoredProvider,
  "id" | "kind" | "baseUrl" | "modelMetadata" | "deployment"
>;

export interface RuntimeModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: readonly string[];
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
  forceAdaptiveThinking?: boolean;
}

export interface RuntimeModelLimits {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
  forceAdaptiveThinking?: boolean;
}

export const MAX_MODELS_DEV_PROVIDERS = 1_024;
export const MAX_MODELS_DEV_MODELS = 100_000;
export const MAX_MODELS_DEV_ID_LENGTH = 512;
export const MAX_MODELS_DEV_NUMERIC_VALUE = 1_000_000_000;

export const CONSERVATIVE_RUNTIME_LIMITS: RuntimeModelLimits = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  reasoning: false,
  input: ["text"],
};

export function createModelCatalogLoader(
  load: () => Promise<unknown>,
  onError: (error: unknown) => void = () => {},
): () => Promise<ModelCatalog> {
  let snapshot: Promise<ModelCatalog> | null = null;
  return () => {
    snapshot ??= load()
      .then(parseModelCatalog)
      .catch((error: unknown) => {
        try {
          onError(error);
        } catch {
          // Diagnostics cannot turn a safe catalog fallback into a chat failure.
        }
        return {};
      });
    return snapshot;
  };
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Bundled model catalog ${field} must be a string when present.`);
  }
}

function assertOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`Bundled model catalog ${field} must be a boolean when present.`);
  }
}

function assertOptionalStringArray(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`Bundled model catalog ${field} must be a string array when present.`);
  }
}

function assertOptionalLimit(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_MODELS_DEV_NUMERIC_VALUE)
  ) {
    throw new Error(`Bundled model catalog ${field} must be a non-negative number when present.`);
  }
}

function validateRawModel(value: unknown, providerId: string, modelId: string): void {
  const model = rawRecord(value);
  if (!model) {
    throw new Error(
      `Bundled model catalog provider ${providerId} has an invalid model ${modelId}.`,
    );
  }
  if (typeof model.name !== "string" || model.name.length === 0) {
    throw new Error(`Bundled model catalog model ${providerId}/${modelId} must have a name.`);
  }
  for (const field of [
    "id",
    "description",
    "family",
    "knowledge",
    "release_date",
    "last_updated",
  ]) {
    assertOptionalString(model[field], `${providerId}/${modelId}.${field}`);
  }
  for (const field of ["attachment", "reasoning", "tool_call", "open_weights"]) {
    assertOptionalBoolean(model[field], `${providerId}/${modelId}.${field}`);
  }

  const modalities = model.modalities === undefined ? null : rawRecord(model.modalities);
  if (model.modalities !== undefined && !modalities) {
    throw new Error(`Bundled model catalog ${providerId}/${modelId}.modalities must be an object.`);
  }
  assertOptionalStringArray(modalities?.input, `${providerId}/${modelId}.modalities.input`);
  assertOptionalStringArray(modalities?.output, `${providerId}/${modelId}.modalities.output`);

  const limit = model.limit === undefined ? null : rawRecord(model.limit);
  if (model.limit !== undefined && !limit) {
    throw new Error(`Bundled model catalog ${providerId}/${modelId}.limit must be an object.`);
  }
  assertOptionalLimit(limit?.context, `${providerId}/${modelId}.limit.context`);
  assertOptionalLimit(limit?.output, `${providerId}/${modelId}.limit.output`);
}

/** Validate the static models.dev catalog assembled by release tooling. */
export function parseModelCatalog(value: unknown): ModelCatalog {
  const catalog = rawRecord(value);
  if (!catalog) {
    throw new Error("Bundled model catalog must be an object.");
  }
  let modelCount = 0;
  const providers = Object.entries(catalog);
  if (providers.length > MAX_MODELS_DEV_PROVIDERS) {
    throw new Error("Bundled model catalog contains too many providers.");
  }
  for (const [providerId, providerValue] of providers) {
    if (providerId.length === 0 || providerId.length > MAX_MODELS_DEV_ID_LENGTH) {
      throw new Error("Bundled model catalog contains an invalid provider identity.");
    }
    const provider = rawRecord(providerValue);
    const models = rawRecord(provider?.models);
    if (!provider || !models) {
      throw new Error(`Bundled model catalog provider ${providerId} must contain models.`);
    }
    for (const [modelId, model] of Object.entries(models)) {
      if (modelId.length === 0 || modelId.length > MAX_MODELS_DEV_ID_LENGTH) {
        throw new Error(
          `Bundled model catalog provider ${providerId} contains an invalid model id.`,
        );
      }
      validateRawModel(model, providerId, modelId);
      modelCount += 1;
      if (modelCount > MAX_MODELS_DEV_MODELS) {
        throw new Error("Bundled model catalog contains too many models.");
      }
    }
  }
  if (modelCount === 0) {
    throw new Error("Bundled model catalog must contain at least one model.");
  }
  return value as ModelCatalog;
}

const TRUSTED_GATEWAYS_WITHOUT_MODELS_DEV_PROVIDER = new Set(["concentrate"]);

export { catalogProviderSlug };

interface ModelIdIndex {
  /** Lowercased full id -> first row with that id in iteration order. */
  exact: Map<string, RawModel>;
  /** Lowercased id leaf (after the last slash) -> first row with that leaf. */
  leaf: Map<string, RawModel>;
}

function emptyIndex(): ModelIdIndex {
  return { exact: new Map(), leaf: new Map() };
}

/** First occurrence wins, matching the linear scans these maps replace. */
function addToIndex(index: ModelIdIndex, key: string, model: RawModel): void {
  const exact = key.toLowerCase();
  if (!index.exact.has(exact)) index.exact.set(exact, model);
  const leaf = modelIdLeaf(key);
  if (!index.leaf.has(leaf)) index.leaf.set(leaf, model);
}

// Catalog snapshots are parsed once and never mutated, so each object is indexed once.
const providerIndexes = new WeakMap<RawProvider, ModelIdIndex>();
const catalogIndexes = new WeakMap<ModelCatalog, ModelIdIndex>();

function providerIndex(provider: RawProvider): ModelIdIndex {
  let index = providerIndexes.get(provider);
  if (!index) {
    index = emptyIndex();
    for (const [key, model] of Object.entries(provider.models ?? {})) addToIndex(index, key, model);
    providerIndexes.set(provider, index);
  }
  return index;
}

function catalogIndex(catalog: ModelCatalog): ModelIdIndex {
  let index = catalogIndexes.get(catalog);
  if (!index) {
    index = emptyIndex();
    for (const provider of Object.values(catalog)) {
      for (const [key, model] of Object.entries(provider.models ?? {})) {
        addToIndex(index, key, model);
      }
    }
    catalogIndexes.set(catalog, index);
  }
  return index;
}

/** An exact (case-insensitive) id match wins over a leaf match. */
function lookupIndex(index: ModelIdIndex, modelId: string): RawModel | null {
  return index.exact.get(modelId.toLowerCase()) ?? index.leaf.get(modelIdLeaf(modelId)) ?? null;
}

function findRawInProvider(provider: RawProvider | undefined, modelId: string): RawModel | null {
  return provider ? lookupIndex(providerIndex(provider), modelId) : null;
}

function findRawForProvider(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): RawModel | null {
  const provider = catalog[providerId] ?? catalog[catalogProviderSlug(providerId) ?? ""];
  if (!provider) return null;
  return findRawInProvider(provider, modelId);
}

/** Exact matches across the catalog must win before any lossy normalized match. */
function findRaw(catalog: ModelCatalog, providerId: string, modelId: string): RawModel | null {
  const preferred = findRawInProvider(catalog[catalogProviderSlug(providerId) ?? ""], modelId);
  return preferred ?? lookupIndex(catalogIndex(catalog), modelId);
}

const MAX_MODELS_DEV_CANONICAL_ID_LENGTH = 256;

const MODELS_DEV_COST_FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"],
] as const;

/** Keep only finite, non-negative USD-per-1M-token prices; omit the object when none remain. */
function modelsDevCost(value: unknown): ModelCost | undefined {
  const raw = rawRecord(value);
  if (!raw) return undefined;
  const cost: ModelCost = {};
  for (const [source, target] of MODELS_DEV_COST_FIELDS) {
    const price = raw[source];
    if (typeof price === "number" && Number.isFinite(price) && price >= 0) cost[target] = price;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function modelsDevCanonicalId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MODELS_DEV_CANONICAL_ID_LENGTH
    ? value
    : undefined;
}

function modelsDevInfo(catalog: ModelCatalog, providerId: string, modelId: string): ModelInfo {
  const raw = findRaw(catalog, providerId, modelId);
  if (!raw) {
    return { id: modelId, metadataSource: "fallback", matched: false };
  }
  const inputs = raw.modalities?.input ?? [];
  const outputs = raw.modalities?.output ?? [];
  const family = raw.family?.trim().toLocaleLowerCase();
  const description = raw.description?.trim() ?? "";
  const mediaOutputType: ModelInfo["modelType"] =
    outputs.length > 0 && !outputs.includes("text")
      ? outputs.includes("image")
        ? "image"
        : outputs.includes("video")
          ? "video"
          : outputs.includes("audio")
            ? "audio"
            : undefined
      : undefined;
  const modelType: ModelInfo["modelType"] =
    family === "text-embedding" || /^embedding model\b/iu.test(description)
      ? "embedding"
      : /^reranking model\b/iu.test(description)
        ? "reranker"
        : mediaOutputType;
  // Display-only pricing and identity; runtime limits never read these fields.
  const cost = modelsDevCost(raw.cost);
  const canonicalModelId = modelsDevCanonicalId(raw.canonical_model_id);
  return {
    id: modelId,
    name: raw.name,
    vision:
      typeof raw.attachment === "boolean"
        ? raw.attachment || inputs.includes("image")
        : inputs.length > 0
          ? inputs.includes("image")
          : undefined,
    toolCall: typeof raw.tool_call === "boolean" ? raw.tool_call : undefined,
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
    openWeights: typeof raw.open_weights === "boolean" ? raw.open_weights : undefined,
    ...(modelType ? { modelType } : {}),
    contextLength: raw.limit?.context,
    outputLimit: raw.limit?.output,
    inputModalities: inputs.length ? inputs : undefined,
    knowledge: raw.knowledge,
    releaseDate: raw.release_date,
    ...(cost ? { cost } : {}),
    ...(canonicalModelId ? { canonicalModelId } : {}),
    metadataSource: "models-dev",
    matched: true,
  };
}

function modelsDevBenchmark(
  catalog: ModelCatalog,
  cache: OpenRouterBenchmarkCache,
  provider: ModelCatalogProvider,
  modelId: string,
): ModelInfo["benchmark"] {
  const directAuthor = openRouterAuthor(provider.id);
  const providerCatalog = catalog[provider.id] ?? catalog[catalogProviderSlug(provider.id) ?? ""];
  if (
    directAuthor === undefined &&
    providerCatalog === undefined &&
    !TRUSTED_GATEWAYS_WITHOUT_MODELS_DEV_PROVIDER.has(provider.id)
  ) {
    return undefined;
  }

  const raw =
    findRawInProvider(providerCatalog, modelId) ??
    (TRUSTED_GATEWAYS_WITHOUT_MODELS_DEV_PROVIDER.has(provider.id)
      ? findRaw(catalog, provider.id, modelId)
      : null);
  if (!raw?.name) return undefined;

  return openRouterBenchmarkForModelsDevIdentity(cache, {
    ...(directAuthor === undefined ? {} : { author: directAuthor }),
    modelId,
    name: raw.name,
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
  });
}

/** models.dev-only capability lookup; production uses it for bundled request admission (`modelsCatalog.bundledInfo`). */
export function lookupCatalogModelInfo(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): ModelInfo {
  return modelsDevInfo(catalog, providerId, modelId);
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function supportsImage(input: readonly string[] | undefined): boolean | undefined {
  return input === undefined ? undefined : input.includes("image");
}

/**
 * Resolve request-time limits without public-catalog or device-cache access.
 *
 * Each field uses exact Pi metadata first, then the provider-scoped bundled
 * models.dev snapshot, then the conservative legacy fallback.
 */
export function resolveRuntimeLimits(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
  exact?: RuntimeModelMetadata,
): RuntimeModelLimits {
  const bundled = findRawForProvider(catalog, providerId, modelId);
  const bundledInputs = bundled?.modalities?.input;
  const bundledVision =
    bundled === null
      ? undefined
      : bundled.attachment === true || supportsImage(bundledInputs) === true
        ? true
        : bundled.attachment === false || bundledInputs !== undefined
          ? false
          : undefined;
  const exactVision = supportsImage(exact?.input);
  const vision = exactVision ?? bundledVision ?? false;

  const limits: RuntimeModelLimits = {
    contextWindow:
      positiveInteger(exact?.contextWindow) ??
      positiveInteger(bundled?.limit?.context) ??
      CONSERVATIVE_RUNTIME_LIMITS.contextWindow,
    maxTokens:
      positiveInteger(exact?.maxTokens) ??
      positiveInteger(bundled?.limit?.output) ??
      CONSERVATIVE_RUNTIME_LIMITS.maxTokens,
    reasoning:
      exact?.reasoning ??
      (typeof bundled?.reasoning === "boolean"
        ? bundled.reasoning
        : CONSERVATIVE_RUNTIME_LIMITS.reasoning),
    input: vision ? ["text", "image"] : ["text"],
  };
  if (exact?.samplingParamsByThinkingLevel !== undefined) limits.samplingParamsByThinkingLevel = exact.samplingParamsByThinkingLevel;
  if (exact?.thinkingLevelMap !== undefined) {
    limits.thinkingLevelMap = exact.thinkingLevelMap;
  }
  if (exact?.forceAdaptiveThinking !== undefined) {
    limits.forceAdaptiveThinking = exact.forceAdaptiveThinking;
  }
  return limits;
}

function discoveredRuntimeMetadata(
  provider: RuntimeCatalogProvider,
  modelId: string,
): RuntimeModelMetadata | undefined {
  const metadata = provider.modelMetadata?.[modelId];
  if (!metadata) return undefined;
  return {
    contextWindow: metadata.overrides?.contextLength ?? metadata.contextLength,
    maxTokens: metadata.overrides?.outputLimit,
    samplingParamsByThinkingLevel: metadata.overrides?.samplingParamsByThinkingLevel,
    reasoning: metadata.overrides?.reasoning ?? metadata.reasoning,
    input:
      (metadata.overrides?.vision ?? metadata.vision) === undefined ? undefined : (metadata.overrides?.vision ?? metadata.vision) ? ["text", "image"] : ["text"],
  };
}

function mergeRuntimeMetadata(
  primary: RuntimeModelMetadata | undefined,
  fallback: RuntimeModelMetadata | undefined,
): RuntimeModelMetadata | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    contextWindow: primary.contextWindow ?? fallback.contextWindow,
    maxTokens: primary.maxTokens ?? fallback.maxTokens,
    reasoning: primary.reasoning ?? fallback.reasoning,
    input: primary.input ?? fallback.input,
    samplingParamsByThinkingLevel: primary.samplingParamsByThinkingLevel ?? fallback.samplingParamsByThinkingLevel,
    thinkingLevelMap: primary.thinkingLevelMap ?? fallback.thinkingLevelMap,
    forceAdaptiveThinking: primary.forceAdaptiveThinking ?? fallback.forceAdaptiveThinking,
  };
}

/**
 * Follow Pi's provider composition semantics for request-time metadata.
 *
 * Built-in provider metadata survives a proxy/base-URL override, while
 * connection-discovered fields act like per-model overrides. Unrelated custom
 * provider IDs cannot borrow another provider's catalog entry.
 */
export function resolveProviderRuntimeLimits(
  catalog: ModelCatalog,
  provider: RuntimeCatalogProvider,
  modelId: string,
  piExact?: RuntimeModelMetadata,
): RuntimeModelLimits {
  const runtimeSlug = catalogProviderSlug(provider.id);
  const discovered = discoveredRuntimeMetadata(provider, modelId);
  const limits = resolveRuntimeLimits(
    catalog,
    runtimeSlug ? provider.id : "",
    modelId,
    runtimeSlug ? mergeRuntimeMetadata(discovered, piExact) : discovered,
  );
  if (provider.modelMetadata?.[modelId]?.overrides?.maxImages === 0) limits.input = ["text"];
  if (provider.modelMetadata?.[modelId]?.overrides) limits.maxTokens = Math.min(limits.maxTokens, limits.contextWindow);
  return limits;
}

function isLocalProvider(provider: ModelCatalogProvider): boolean {
  return isLocalProviderDeployment(provider);
}

function localInfo(
  modelId: string,
  metadata: ProviderModelMetadata,
  fallback: ModelInfo,
): ModelInfo {
  const inputModalities =
    metadata.vision === true
      ? ["text", "image"]
      : metadata.vision === false
        ? ["text"]
        : fallback.inputModalities;
  return {
    ...fallback,
    id: modelId,
    name: metadata.name ?? fallback.name,
    vision: metadata.vision ?? fallback.vision,
    toolCall: metadata.toolCall ?? fallback.toolCall,
    reasoning: metadata.reasoning ?? fallback.reasoning,
    // A provider's generic `llm` label cannot make a catalog-identified
    // embedding/reranker chat-capable. Either trusted non-chat source wins.
    modelType:
      metadata.type && metadata.type !== "llm"
        ? metadata.type
        : fallback.modelType && fallback.modelType !== "llm"
          ? fallback.modelType
          : (metadata.type ?? fallback.modelType),
    parameterCount: metadata.parameterCount,
    format: metadata.format,
    contextLength: metadata.contextLength ?? fallback.contextLength,
    inputModalities,
    metadataSource: "local",
    matched: true,
  };
}

/** Local metadata wins for local providers; hosted models use models.dev plus benchmark evidence. */
export function resolveModelInfo(
  catalog: ModelCatalog,
  provider: ModelCatalogProvider,
  modelId: string,
  openRouterBenchmarks?: OpenRouterBenchmarkCache | null,
): ModelInfo {
  const info = modelsDevInfo(catalog, provider.id, modelId);
  if (isLocalProvider(provider)) {
    const metadata = provider.modelMetadata?.[modelId];
    return metadata ? localInfo(modelId, metadata, info) : info;
  }
  const benchmark = openRouterBenchmarks
    ? (openRouterBenchmarkForModel(openRouterBenchmarks, provider.id, modelId) ??
      modelsDevBenchmark(catalog, openRouterBenchmarks, provider, modelId))
    : undefined;
  return benchmark ? { ...info, benchmark } : info;
}
