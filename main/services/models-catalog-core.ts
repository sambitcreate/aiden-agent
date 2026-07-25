import {
  artificialAnalysisRanking,
  findArtificialAnalysisModel,
  type ArtificialAnalysisCatalog,
} from "./artificial-analysis-catalog-core.js";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { isLocalProviderDeployment } from "../../renderer/shared/provider-deployment.js";
import type { ModelInfo, ProviderModelMetadata, StoredProvider } from "./types.js";

interface RawModel {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  open_weights?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
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
  thinkingLevelMap?: ThinkingLevelMap;
  forceAdaptiveThinking?: boolean;
}

export interface RuntimeModelLimits {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  thinkingLevelMap?: ThinkingLevelMap;
  forceAdaptiveThinking?: boolean;
}

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
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
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
  for (const field of ["id", "knowledge", "release_date", "last_updated"]) {
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
  for (const [providerId, providerValue] of Object.entries(catalog)) {
    const provider = rawRecord(providerValue);
    const models = rawRecord(provider?.models);
    if (!provider || !models) {
      throw new Error(`Bundled model catalog provider ${providerId} must contain models.`);
    }
    for (const [modelId, model] of Object.entries(models)) {
      if (modelId.length === 0) {
        throw new Error(`Bundled model catalog provider ${providerId} contains an empty model id.`);
      }
      validateRawModel(model, providerId, modelId);
      modelCount += 1;
    }
  }
  if (modelCount === 0) {
    throw new Error("Bundled model catalog must contain at least one model.");
  }
  return value as ModelCatalog;
}

const PROVIDER_SLUG: Record<string, string> = {
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  gemini: "google",
  google: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
};

const ARTIFICIAL_ANALYSIS_CREATOR: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  google: "Google",
  deepseek: "DeepSeek",
  moonshot: "Moonshot AI",
};

/** Map Aiden's stored provider IDs to the shared Pi/models.dev provider IDs. */
export function catalogProviderSlug(providerId: string): string | undefined {
  return PROVIDER_SLUG[providerId];
}

function normalizeId(id: string): string {
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLocaleLowerCase();
}

function entries(provider: RawProvider | undefined): Array<[string, RawModel]> {
  return provider?.models ? Object.entries(provider.models) : [];
}

function findRawForProvider(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): RawModel | null {
  const provider = catalog[catalogProviderSlug(providerId) ?? ""];
  if (!provider) return null;

  const exact = modelId.toLocaleLowerCase();
  const normalized = normalizeId(modelId);
  const exactMatch = entries(provider).find(([key]) => key.toLocaleLowerCase() === exact);
  if (exactMatch) return exactMatch[1];
  return entries(provider).find(([key]) => normalizeId(key) === normalized)?.[1] ?? null;
}

/** Exact matches across the catalog must win before any lossy normalized match. */
function findRaw(catalog: ModelCatalog, providerId: string, modelId: string): RawModel | null {
  const exact = modelId.toLocaleLowerCase();
  const normalized = normalizeId(modelId);
  const preferred = catalog[catalogProviderSlug(providerId) ?? ""];

  const preferredExact = entries(preferred).find(([key]) => key.toLocaleLowerCase() === exact);
  if (preferredExact) return preferredExact[1];
  const preferredNormalized = entries(preferred).find(([key]) => normalizeId(key) === normalized);
  if (preferredNormalized) return preferredNormalized[1];

  for (const provider of Object.values(catalog)) {
    const hit = entries(provider).find(([key]) => key.toLocaleLowerCase() === exact);
    if (hit) return hit[1];
  }
  for (const provider of Object.values(catalog)) {
    const hit = entries(provider).find(([key]) => normalizeId(key) === normalized);
    if (hit) return hit[1];
  }
  return null;
}

function modelsDevInfo(catalog: ModelCatalog, providerId: string, modelId: string): ModelInfo {
  const raw = findRaw(catalog, providerId, modelId);
  if (!raw) {
    return { id: modelId, metadataSource: "fallback", matched: false };
  }
  const inputs = raw.modalities?.input ?? [];
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
    contextLength: raw.limit?.context,
    outputLimit: raw.limit?.output,
    inputModalities: inputs.length ? inputs : undefined,
    knowledge: raw.knowledge,
    releaseDate: raw.release_date,
    metadataSource: "models-dev",
    matched: true,
  };
}

/** Backward-compatible models.dev-only lookup used by focused tests. */
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
    contextWindow: metadata.contextLength,
    reasoning: metadata.reasoning,
    input:
      metadata.vision === undefined ? undefined : metadata.vision ? ["text", "image"] : ["text"],
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
    thinkingLevelMap: primary.thinkingLevelMap ?? fallback.thinkingLevelMap,
    forceAdaptiveThinking:
      primary.forceAdaptiveThinking ?? fallback.forceAdaptiveThinking,
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
  return resolveRuntimeLimits(
    catalog,
    runtimeSlug ? provider.id : "",
    modelId,
    runtimeSlug ? mergeRuntimeMetadata(discovered, piExact) : discovered,
  );
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
    modelType: metadata.type,
    parameterCount: metadata.parameterCount,
    format: metadata.format,
    contextLength: metadata.contextLength ?? fallback.contextLength,
    inputModalities,
    ranking: undefined,
    metadataSource: "local",
    matched: true,
  };
}

function hostedInfo(
  snapshot: ArtificialAnalysisCatalog,
  provider: ModelCatalogProvider,
  modelId: string,
  fallback: ModelInfo,
): ModelInfo {
  const match = findArtificialAnalysisModel(
    snapshot,
    modelId,
    ARTIFICIAL_ANALYSIS_CREATOR[provider.id],
    fallback.name,
  );
  if (!match) return fallback;
  const inputs = match.input_modalities;
  return {
    ...fallback,
    id: modelId,
    name: match.name ?? fallback.name,
    vision: inputs ? inputs.includes("image") : fallback.vision,
    reasoning: match.reasoning ?? fallback.reasoning,
    openWeights: match.open_weights ?? fallback.openWeights,
    parameterCount:
      match.parameter_count_billions === undefined
        ? fallback.parameterCount
        : `${match.parameter_count_billions}B`,
    contextLength: match.context_window_tokens ?? fallback.contextLength,
    inputModalities: inputs?.length ? inputs : fallback.inputModalities,
    releaseDate: match.release_date ?? fallback.releaseDate,
    ranking: artificialAnalysisRanking(snapshot, match),
    metadataSource: "artificial-analysis",
    matched: true,
  };
}

/** Apply local > Artificial Analysis > models.dev precedence for one model. */
export function resolveModelInfo(
  catalog: ModelCatalog,
  artificialAnalysis: ArtificialAnalysisCatalog,
  provider: ModelCatalogProvider,
  modelId: string,
): ModelInfo {
  const fallback = modelsDevInfo(catalog, provider.id, modelId);
  if (isLocalProvider(provider)) {
    const metadata = provider.modelMetadata?.[modelId];
    return metadata ? localInfo(modelId, metadata, fallback) : fallback;
  }
  return hostedInfo(artificialAnalysis, provider, modelId, fallback);
}
