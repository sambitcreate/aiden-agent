// Discover provider models and retain provider-reported metadata for local runtimes.

import type { ProviderModelMetadata, StoredProvider } from "./types.js";
import {
  GOOGLE_PROVIDER_ID,
  googleProviderModelMetadata,
  googleProviderModels,
} from "./google-provider.js";
import { isLmStudioProviderId, isOllamaProviderId } from "./custom-provider-id.js";

interface GenericModelEntry {
  id?: string;
  key?: string;
  name?: string;
  display_name?: string;
  type?: string;
  max_context_length?: number;
  context_length?: number;
  params_string?: string;
  format?: string;
  quantization?: { name?: string | null } | string | null;
  capabilities?: unknown;
}

interface ModelsResponse {
  data?: GenericModelEntry[];
  models?: GenericModelEntry[];
}

interface GoogleModelEntry {
  name?: string;
  supportedGenerationMethods?: string[];
}

interface GoogleModelsResponse {
  models?: GoogleModelEntry[];
  nextPageToken?: string;
}

interface OllamaTag {
  name?: string;
  model?: string;
  details?: {
    format?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaShowResponse {
  capabilities?: string[];
  details?: OllamaTag["details"];
  model_info?: Record<string, unknown>;
}

export interface DiscoveredModels {
  models: string[];
  modelMetadata: Record<string, ProviderModelMetadata>;
}

export interface ConnectionTestResult extends DiscoveredModels {
  ok: true;
  modelCount: number;
}

/** Keep a settings request responsive when a local or private server is offline. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_GOOGLE_MODEL_PAGES = 10;

class ModelDiscoveryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Validate connection URLs before they are persisted or used for discovery.
 * Credentials belong in the encrypted key store, never in a URL.
 */
export function normalizeProviderBaseUrl(value: string): string {
  const input = value.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid HTTP(S) base URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider URLs must use HTTP or HTTPS.");
  }
  if (!url.hostname) {
    throw new Error("Provider URL must include a host.");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the API key field, not the URL.");
  }
  if (url.search || url.hash) {
    throw new Error("Provider URL cannot include a query string or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function headersFor(provider: StoredProvider, apiKey: string | null): Record<string, string> {
  if (provider.kind === "anthropic") {
    return {
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
    };
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function providerEndpoint(provider: StoredProvider, pathname: string): string {
  const url = new URL(provider.baseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  init: { method?: "GET" | "POST"; body?: string; redirect?: RequestRedirect } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers: init.body ? { ...headers, "content-type": "application/json" } : headers,
      redirect: init.redirect,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelDiscoveryHttpError(
        `Failed to list models: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        response.status,
      );
    }
    return response.json() as Promise<unknown>;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Connection timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverGoogle(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<DiscoveredModels> {
  const key = apiKey?.trim();
  if (!key) throw new Error("Enter a Gemini API key before discovering models.");
  const available = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MAX_GOOGLE_MODEL_PAGES) {
      throw new Error("Google's model endpoint returned too many pages.");
    }
    const url = new URL(providerEndpoint(provider, "/v1beta/models"));
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const value = object(
      await fetchJson(url.toString(), { "x-goog-api-key": key }, { redirect: "error" }),
    ) as GoogleModelsResponse | null;
    if (!Array.isArray(value?.models)) {
      throw new Error("Google's model endpoint returned an unexpected response.");
    }
    for (const model of value.models) {
      if (
        Array.isArray(model.supportedGenerationMethods) &&
        !model.supportedGenerationMethods.includes("generateContent")
      ) {
        continue;
      }
      const modelId = model.name?.replace(/^models\//u, "");
      if (modelId) available.add(modelId);
    }
    pageToken = value.nextPageToken?.trim() || undefined;
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error("Google's model endpoint repeated a pagination token.");
      }
      seenPageTokens.add(pageToken);
    }
  } while (pageToken);
  const models = googleProviderModels()
    .map((model) => model.id)
    .filter((modelId) => available.has(modelId));
  const metadata = googleProviderModelMetadata();
  return {
    models,
    modelMetadata: Object.fromEntries(models.map((modelId) => [modelId, metadata[modelId]])),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function capabilityFlags(value: unknown): {
  vision?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  embedding?: boolean;
} {
  if (Array.isArray(value)) {
    const capabilities = new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.toLowerCase()),
    );
    return {
      vision: capabilities.has("vision"),
      toolCall: capabilities.has("tools") || capabilities.has("tool_use"),
      reasoning: capabilities.has("reasoning") || capabilities.has("thinking"),
      embedding: capabilities.has("embedding") || capabilities.has("embeddings"),
    };
  }
  const capabilities = object(value);
  if (!capabilities) return {};
  return {
    vision: typeof capabilities.vision === "boolean" ? capabilities.vision : undefined,
    toolCall:
      typeof capabilities.trained_for_tool_use === "boolean"
        ? capabilities.trained_for_tool_use
        : typeof capabilities.tool_use === "boolean"
          ? capabilities.tool_use
          : undefined,
    reasoning:
      capabilities.reasoning !== undefined
        ? Boolean(capabilities.reasoning)
        : typeof capabilities.thinking === "boolean"
          ? capabilities.thinking
          : undefined,
  };
}

function genericMetadata(entry: GenericModelEntry): ProviderModelMetadata {
  const flags = capabilityFlags(entry.capabilities);
  const type = entry.type?.toLowerCase();
  const quantization =
    typeof entry.quantization === "string"
      ? entry.quantization
      : (entry.quantization?.name ?? undefined);
  return {
    source: "provider",
    name: entry.display_name ?? entry.name,
    type:
      type?.includes("embed") || flags.embedding
        ? "embedding"
        : type === "llm" || type === "vlm"
          ? "llm"
          : undefined,
    vision: flags.vision,
    toolCall: flags.toolCall,
    reasoning: flags.reasoning,
    contextLength: finitePositive(entry.max_context_length ?? entry.context_length),
    parameterCount: entry.params_string,
    format: quantization ?? entry.format,
  };
}

function normalizeDiscovery(entries: GenericModelEntry[]): DiscoveredModels {
  const metadataEntries: Array<[string, ProviderModelMetadata]> = [];
  for (const entry of entries) {
    const id = entry.id ?? entry.key ?? entry.name;
    if (!id) continue;
    metadataEntries.push([id, genericMetadata(entry)]);
  }
  const metadata = Object.fromEntries(metadataEntries);
  const models = Object.keys(metadata)
    .filter((id) => metadata[id]?.type !== "embedding")
    .sort();
  return { models: Array.from(new Set(models)), modelMetadata: metadata };
}

function parseGenericResponse(value: unknown): DiscoveredModels | null {
  const response = object(value) as ModelsResponse | null;
  const entries = response?.data ?? response?.models;
  return Array.isArray(entries) ? normalizeDiscovery(entries) : null;
}

function parseLmStudioResponse(value: unknown): DiscoveredModels | null {
  const response = object(value);
  if (!response || !Array.isArray(response.models)) return null;
  const entries = response.models
    .map((value) => object(value))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const metadataEntries: Array<[string, ProviderModelMetadata]> = [];
  for (const entry of entries) {
    const key = typeof entry.key === "string" ? entry.key : undefined;
    if (!key) continue;
    const capabilities = capabilityFlags(entry.capabilities);
    const type =
      entry.type === "embedding" ? "embedding" : entry.type === "llm" ? "llm" : undefined;
    const quantization = object(entry.quantization);
    metadataEntries.push([
      key,
      {
        source: "lmstudio",
        name: typeof entry.display_name === "string" ? entry.display_name : undefined,
        type,
        vision: capabilities.vision,
        toolCall: capabilities.toolCall,
        reasoning: capabilities.reasoning,
        contextLength: finitePositive(entry.max_context_length),
        parameterCount: typeof entry.params_string === "string" ? entry.params_string : undefined,
        format:
          typeof quantization?.name === "string"
            ? quantization.name
            : typeof entry.format === "string"
              ? entry.format
              : undefined,
      },
    ]);
  }
  const modelMetadata = Object.fromEntries(metadataEntries);
  const models = Object.keys(modelMetadata)
    .filter((id) => modelMetadata[id]?.type !== "embedding")
    .sort();
  return { models, modelMetadata };
}

function ollamaContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  const lengths = Object.entries(modelInfo)
    .filter(
      ([key, value]) => key.endsWith(".context_length") && finitePositive(value) !== undefined,
    )
    .map(([, value]) => value as number);
  return lengths.length > 0 ? Math.max(...lengths) : undefined;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        output[index] = await transform(values[index]);
      }
    }),
  );
  return output;
}

async function discoverOllama(
  provider: StoredProvider,
  headers: Record<string, string>,
): Promise<DiscoveredModels | null> {
  const tagsValue = await fetchJson(providerEndpoint(provider, "/api/tags"), headers);
  const tagsResponse = object(tagsValue);
  if (!tagsResponse || !Array.isArray(tagsResponse.models)) return null;
  const tags = tagsResponse.models
    .map((value) => object(value) as OllamaTag | null)
    .filter((value): value is OllamaTag => Boolean(value?.model ?? value?.name));

  const rows = await mapWithConcurrency(tags, 4, async (tag) => {
    const id = tag.model ?? tag.name!;
    let detail: OllamaShowResponse = {};
    try {
      detail = (await fetchJson(providerEndpoint(provider, "/api/show"), headers, {
        method: "POST",
        body: JSON.stringify({ model: id, verbose: false }),
      })) as OllamaShowResponse;
    } catch {
      // One damaged model entry must not hide the rest of an otherwise healthy local catalog.
    }
    const capabilities = capabilityFlags(detail.capabilities);
    const type = capabilities.embedding ? "embedding" : "llm";
    const details = detail.details ?? tag.details;
    return {
      id,
      metadata: {
        source: "ollama",
        name: tag.name ?? tag.model,
        type,
        vision: capabilities.vision,
        toolCall: capabilities.toolCall,
        reasoning: capabilities.reasoning,
        contextLength: ollamaContextLength(detail.model_info),
        parameterCount: details?.parameter_size,
        format: details?.quantization_level ?? details?.format,
      } satisfies ProviderModelMetadata,
    };
  });

  const modelMetadata = Object.fromEntries(rows.map((row) => [row.id, row.metadata]));
  const models = rows
    .filter((row) => row.metadata.type !== "embedding")
    .map((row) => row.id)
    .sort();
  return { models, modelMetadata };
}

function canFallBackFromNative(error: unknown): boolean {
  return error instanceof ModelDiscoveryHttpError && [404, 405].includes(error.status);
}

export async function discoverModels(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<DiscoveredModels> {
  if (provider.id === GOOGLE_PROVIDER_ID) return discoverGoogle(provider, apiKey);
  const headers = headersFor(provider, apiKey);
  if (isLmStudioProviderId(provider.id)) {
    try {
      const native = parseLmStudioResponse(
        await fetchJson(providerEndpoint(provider, "/api/v1/models"), headers),
      );
      if (native) return native;
    } catch (error) {
      if (!canFallBackFromNative(error)) throw error;
    }
  }
  if (isOllamaProviderId(provider.id)) {
    try {
      const native = await discoverOllama(provider, headers);
      if (native) return native;
    } catch (error) {
      if (!canFallBackFromNative(error)) throw error;
    }
  }

  const url = `${provider.baseUrl.replace(/\/$/u, "")}/models`;
  const generic = parseGenericResponse(await fetchJson(url, headers));
  if (!generic) throw new Error("Model endpoint returned an unexpected response.");
  return generic;
}

/** Fetch only chat-capable model ids for legacy callers. */
export async function listModels(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<string[]> {
  return (await discoverModels(provider, apiKey)).models;
}

/** Lightweight connectivity/auth check. Throws with a specific message on failure. */
export async function testConnection(
  provider: StoredProvider,
  apiKey: string | null,
): Promise<ConnectionTestResult> {
  const discovered = await discoverModels(provider, apiKey);
  return {
    ok: true,
    modelCount: discovered.models.length,
    ...discovered,
  };
}
