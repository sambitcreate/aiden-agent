import {
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export const CONCENTRATE_PROVIDER_ID = "concentrate";
export const CONCENTRATE_PROVIDER_NAME = "Concentrate";
export const CONCENTRATE_BASE_URL = "https://api.concentrate.ai/v1";

const CONCENTRATE_MODELS_URL = `${CONCENTRATE_BASE_URL}/models`;
const CONCENTRATE_DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_CATALOG_BYTES = 1_048_576;
const MAX_CATALOG_MODELS = 512;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 160;
const MAX_MODEL_TOKEN_LIMIT = 2_000_000;

type Fetch = typeof fetch;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MODEL_TOKEN_LIMIT
    ? value
    : fallback;
}

function supported(value: unknown): boolean {
  return record(value)?.supported === true;
}

function thinkingLevelMap(capabilities: Record<string, unknown>): ThinkingLevelMap | undefined {
  const thinking = record(capabilities.thinking);
  const effort = record(capabilities.effort);
  const reasoning = thinking?.supported === true || effort?.supported === true;
  if (!reasoning) return undefined;

  const level = (name: "low" | "medium" | "high" | "xhigh" | "max") =>
    supported(effort?.[name]) ? name : null;
  return {
    off: null,
    minimal: null,
    low: level("low"),
    medium: level("medium"),
    high: level("high"),
    xhigh: level("xhigh"),
    max: level("max"),
  };
}

/**
 * Convert Concentrate's public model projection into Pi's bounded runtime
 * contract. The catalog does not publish pricing, so Aiden leaves the rates at
 * zero and reports these as unpriced hosted runs instead of inventing a cost.
 */
export function parseConcentrateModels(value: unknown): Model<"openai-responses">[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw new Error("Concentrate returned an invalid model catalog.");

  const models: Model<"openai-responses">[] = [];
  const seen = new Set<string>();
  for (const entry of data.slice(0, MAX_CATALOG_MODELS)) {
    const model = record(entry);
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;

    const rawName = typeof model?.display_name === "string" ? model.display_name.trim() : "";
    const name = rawName && rawName.length <= MAX_MODEL_NAME_LENGTH ? rawName : id;
    const capabilities = record(model?.capabilities) ?? {};
    const levels = thinkingLevelMap(capabilities);
    seen.add(id);
    models.push({
      id,
      name,
      api: "openai-responses",
      provider: CONCENTRATE_PROVIDER_ID,
      baseUrl: CONCENTRATE_BASE_URL,
      reasoning: levels !== undefined,
      ...(levels ? { thinkingLevelMap: levels } : {}),
      input: supported(capabilities.image_input) ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: boundedPositiveInteger(model?.max_input_tokens, 128_000),
      maxTokens: boundedPositiveInteger(model?.max_tokens, 16_384),
      compat: {
        supportsDeveloperRole: true,
        sessionAffinityFormat: "openai-nosession",
        supportsLongCacheRetention: false,
        supportsToolSearch: false,
      },
    });
  }

  if (models.length === 0) throw new Error("Concentrate returned no usable chat models.");
  const preferred = models.findIndex((model) => model.id === CONCENTRATE_DEFAULT_MODEL);
  if (preferred > 0) models.unshift(...models.splice(preferred, 1));
  return models;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Concentrate returned an oversized model catalog.");
  }
  if (!response.body) throw new Error("Concentrate returned an empty model catalog.");

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Concentrate returned an oversized model catalog.");
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
    throw new Error("Concentrate returned an invalid model catalog.");
  }
}

export function concentrateProvider(fetchImpl: Fetch = fetch) {
  return createProvider({
    id: CONCENTRATE_PROVIDER_ID,
    name: CONCENTRATE_PROVIDER_NAME,
    baseUrl: CONCENTRATE_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("Concentrate API key", ["CONCENTRATE_API_KEY"]),
    },
    models: [],
    fetchModels: async ({ credential, signal }) => {
      const key = credential?.type === "api_key" ? credential.key?.trim() : undefined;
      const response = await fetchImpl(CONCENTRATE_MODELS_URL, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Concentrate model refresh failed (${response.status}).`);
      }
      return parseConcentrateModels(await boundedJson(response));
    },
    api: openAIResponsesApi(),
  });
}

/** Register Aiden-owned built-ins after Pi's pinned catalog is constructed. */
export function registerAidenBuiltinProviders(models: MutableModels): MutableModels {
  models.setProvider(concentrateProvider());
  return models;
}
