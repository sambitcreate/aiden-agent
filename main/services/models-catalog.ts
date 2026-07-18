// models.dev catalog: fetches the full model database (https://models.dev/api.json)
// and maps a provider + model id to normalized capability info (vision, tool
// calling, reasoning, context length, open weights). Cached on disk with a TTL
// so we don't refetch on every lookup.

import { logger } from "@glaze/core/backend";
import { DataStore } from "./data-store.js";
import type { ModelInfo } from "./types.js";

const API_URL = "https://models.dev/api.json";
const TTL_MS = 24 * 60 * 60 * 1000; // Refresh at most once a day.

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
type Catalog = Record<string, RawProvider>;

interface CacheShape {
  fetchedAt: number;
  catalog: Catalog;
}

const cache = new DataStore<CacheShape>("models-dev.json", { fetchedAt: 0, catalog: {} });

// Our provider ids → models.dev provider slugs. Local/custom providers aren't
// mapped and fall back to a global search across all providers' models.
const PROVIDER_SLUG: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

let memory: CacheShape | null = null;
let inflight: Promise<Catalog> | null = null;

async function loadCache(): Promise<CacheShape> {
  if (!memory) memory = await cache.load();
  return memory;
}

async function fetchCatalog(): Promise<Catalog> {
  const response = await fetch(API_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`models.dev returned ${response.status} ${response.statusText}`);
  const catalog = (await response.json()) as Catalog;
  if (!catalog || typeof catalog !== "object") throw new Error("models.dev returned an unexpected payload.");
  memory = { fetchedAt: Date.now(), catalog };
  await cache.save(memory);
  return catalog;
}

/** Ensure the catalog is loaded, refetching when stale (or forced). Never throws. */
async function ensureCatalog(force = false): Promise<Catalog> {
  const current = await loadCache();
  const fresh = Date.now() - current.fetchedAt < TTL_MS;
  if (!force && fresh && Object.keys(current.catalog).length > 0) return current.catalog;
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .catch((error) => {
      logger.error("models-catalog", "Failed to fetch models.dev catalog", error);
      return current.catalog; // Fall back to whatever we already had.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function normalizeId(id: string): string {
  // "deepseek/deepseek-chat" → "deepseek-chat"; strip a leading provider prefix.
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

/** Find a raw model entry for a provider + model id. */
function findRaw(catalog: Catalog, providerId: string, modelId: string): RawModel | null {
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

function toModelInfo(modelId: string, raw: RawModel | null): ModelInfo {
  if (!raw) {
    return { id: modelId, vision: false, toolCall: false, reasoning: false, openWeights: false, matched: false };
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

export const modelsCatalog = {
  /** Capability info for one model. */
  async info(providerId: string, modelId: string): Promise<ModelInfo> {
    const catalog = await ensureCatalog();
    return toModelInfo(modelId, findRaw(catalog, providerId, modelId));
  },

  /** Capability info for many models under one provider. */
  async infoMany(providerId: string, modelIds: string[]): Promise<Record<string, ModelInfo>> {
    const catalog = await ensureCatalog();
    const out: Record<string, ModelInfo> = {};
    for (const id of modelIds) out[id] = toModelInfo(id, findRaw(catalog, providerId, id));
    return out;
  },

  /** Force a refetch of the catalog. */
  async refresh(): Promise<{ providerCount: number; fetchedAt: number }> {
    const catalog = await ensureCatalog(true);
    return { providerCount: Object.keys(catalog).length, fetchedAt: memory?.fetchedAt ?? 0 };
  },
};
