import {
  artificialAnalysisRanking,
  findArtificialAnalysisModel,
  type ArtificialAnalysisCatalog,
} from "./artificial-analysis-catalog-core.js";
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
export type ModelCatalogProvider = Pick<StoredProvider, "id" | "baseUrl" | "modelMetadata">;

/** Validate the static models.dev catalog assembled by release tooling. */
export function parseModelCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled model catalog must be an object.");
  }
  return value as ModelCatalog;
}

const PROVIDER_SLUG: Record<string, string> = {
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  gemini: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

const ARTIFICIAL_ANALYSIS_CREATOR: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  deepseek: "DeepSeek",
  moonshot: "Moonshot AI",
};

function normalizeId(id: string): string {
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLocaleLowerCase();
}

function entries(provider: RawProvider | undefined): Array<[string, RawModel]> {
  return provider?.models ? Object.entries(provider.models) : [];
}

/** Exact matches across the catalog must win before any lossy normalized match. */
function findRaw(catalog: ModelCatalog, providerId: string, modelId: string): RawModel | null {
  const exact = modelId.toLocaleLowerCase();
  const normalized = normalizeId(modelId);
  const preferred = catalog[PROVIDER_SLUG[providerId] ?? ""];

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

function isLocalProvider(provider: ModelCatalogProvider): boolean {
  if (provider.id === "lmstudio" || provider.id === "ollama") return true;
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLocaleLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127\./u.test(hostname);
  } catch {
    return false;
  }
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
