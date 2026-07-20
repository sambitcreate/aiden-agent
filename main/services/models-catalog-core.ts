import type { ModelInfo } from "./types.js";

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

/**
 * Validate the static catalog assembled by the release process. Runtime keeps
 * the payload deliberately permissive: unknown providers or model fields are
 * ignored by the lookup layer instead of breaking chat startup.
 */
export function parseModelCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled model catalog must be an object.");
  }
  return value as ModelCatalog;
}

// Our provider ids → catalog provider slugs. Local/custom providers aren't
// mapped and fall back to a global search across all providers' models.
const PROVIDER_SLUG: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

function normalizeId(id: string): string {
  // "deepseek/deepseek-chat" → "deepseek-chat"; strip a leading provider prefix.
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

/** Find a raw model entry for a provider + model id. */
function findRaw(catalog: ModelCatalog, providerId: string, modelId: string): RawModel | null {
  const wantExact = modelId.toLowerCase();
  const wantNorm = normalizeId(modelId);

  const searchProvider = (prov: RawProvider | undefined): RawModel | null => {
    if (!prov?.models) return null;
    // Exact key first, then normalized comparison.
    for (const [key, model] of Object.entries(prov.models)) {
      if (key.toLowerCase() === wantExact) return model;
    }
    for (const [key, model] of Object.entries(prov.models)) {
      if (normalizeId(key) === wantNorm) return model;
    }
    return null;
  };

  const slug = PROVIDER_SLUG[providerId];
  if (slug) {
    const hit = searchProvider(catalog[slug]);
    if (hit) return hit;
  }
  // Global fallback (custom/local providers, or a mismatched slug).
  for (const prov of Object.values(catalog)) {
    const hit = searchProvider(prov);
    if (hit) return hit;
  }
  return null;
}

export function lookupCatalogModelInfo(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): ModelInfo {
  const raw = findRaw(catalog, providerId, modelId);
  if (!raw) {
    return {
      id: modelId,
      vision: false,
      toolCall: false,
      reasoning: false,
      openWeights: false,
      matched: false,
    };
  }
  const inputs = raw.modalities?.input ?? [];
  return {
    id: modelId,
    name: raw.name,
    vision: raw.attachment === true || inputs.includes("image"),
    toolCall: raw.tool_call === true,
    reasoning: raw.reasoning === true,
    openWeights: raw.open_weights === true,
    contextLength: raw.limit?.context,
    outputLimit: raw.limit?.output,
    inputModalities: inputs.length ? inputs : undefined,
    knowledge: raw.knowledge,
    releaseDate: raw.release_date,
    matched: true,
  };
}
