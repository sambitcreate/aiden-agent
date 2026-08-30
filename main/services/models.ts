// Discover provider models and retain provider-reported metadata for local runtimes.

import type { ProviderModelMetadata, ProviderModelType, StoredProvider } from "./types.js";
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
  /** Ephemeral runtime hint; never persisted as model metadata. */
  recommendedModel?: string;
}

export interface ConnectionTestResult extends DiscoveredModels {
  ok: true;
  modelCount: number;
}

/** Keep a settings request responsive when a local or private server is offline. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_GOOGLE_MODEL_PAGES = 10;
export const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 1_048_576;
export const MAX_DISCOVERED_MODELS = 2_000;
export const MAX_DISCOVERED_MODEL_ID_LENGTH = 256;

class ModelDiscoveryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function httpFailureMessage(status: number): string {
  if (status === 401) return "The provider rejected those credentials.";
  if (status === 403) return "The provider denied access to its model catalog.";
  if (status === 429) return "The provider is rate limiting connection checks. Try again later.";
  if (status === 404 || status === 405) return "The model catalog endpoint is not supported.";
  if (status >= 500) return "The provider is temporarily unavailable.";
  return `The provider could not list models (HTTP ${status}).`;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
    throw new Error("The provider's model catalog is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The provider's model catalog is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const literalMetadataTarget =
    /^169\.254\./u.test(hostname) ||
    /^\[::ffff:(?:169\.254\.|a9fe:)/u.test(hostname) ||
    hostname === "100.100.100.200" ||
    hostname === "0.0.0.0" ||
    hostname === "[::]" ||
    /^\[fe[89ab][0-9a-f]:/u.test(hostname);
  if (
    literalMetadataTarget ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata"
  ) {
    throw new Error("Provider URL cannot target a host-local metadata service.");
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

/** First-run Tailnet setup is intentionally narrower than arbitrary custom endpoints. */
export function assertOnboardingTailnetBaseUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Tailscale model URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the API key field, not the URL.");
  }
  if (url.search || url.hash) {
    throw new Error("Provider URL cannot include a query string or fragment.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  const cgnat =
    ipv4 !== null &&
    Number(ipv4[1]) === 100 &&
    Number(ipv4[2]) >= 64 &&
    Number(ipv4[2]) <= 127;
  const tailscaleIpv6 = /^\[fd7a:115c:a1e0:/u.test(hostname);
  if (!hostname.endsWith(".ts.net") && !cgnat && !tailscaleIpv6) {
    throw new Error("Use a Tailscale .ts.net name or Tailnet IP address for this connection.");
  }
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
  init: {
    method?: "GET" | "POST";
    body?: string;
    redirect?: RequestRedirect;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const controller = init.signal ? null : new AbortController();
  const signal = init.signal ?? controller!.signal;
  const timeoutMs = init.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      body: init.body,
      headers: init.body ? { ...headers, "content-type": "application/json" } : headers,
      redirect: init.redirect ?? "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelDiscoveryHttpError(httpFailureMessage(response.status), response.status);
    }
    const text = await boundedResponseText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("The provider returned an invalid model catalog.");
    }
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error(`Connection timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (init.signal?.aborted) throw new Error("Connection check cancelled.");
    if (error instanceof ModelDiscoveryHttpError) throw error;
    if (
      error instanceof Error &&
      (error.message === "The provider's model catalog is too large." ||
        error.message === "The provider returned an invalid model catalog.")
    ) {
      throw error;
    }
    // Header/fetch errors can echo credential material. Renderer-facing
    // callers receive only app-owned transport copy.
    throw new Error("Couldn't reach the provider model endpoint.");
  } finally {
    if (timeout) clearTimeout(timeout);
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
  reranking?: boolean;
  imageOutput?: boolean;
  audioOutput?: boolean;
  videoOutput?: boolean;
  completion?: boolean;
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
      reranking: capabilities.has("rerank") || capabilities.has("reranking"),
      imageOutput:
        capabilities.has("image_generation") || capabilities.has("text_to_image"),
      audioOutput:
        capabilities.has("audio_generation") ||
        capabilities.has("speech") ||
        capabilities.has("tts"),
      videoOutput:
        capabilities.has("video_generation") || capabilities.has("text_to_video"),
      completion: capabilities.has("completion"),
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
    embedding:
      typeof capabilities.embedding === "boolean" ? capabilities.embedding : undefined,
    reranking:
      typeof capabilities.reranking === "boolean" ? capabilities.reranking : undefined,
    imageOutput:
      typeof capabilities.image_generation === "boolean"
        ? capabilities.image_generation
        : undefined,
    audioOutput:
      typeof capabilities.audio_generation === "boolean"
        ? capabilities.audio_generation
        : undefined,
    videoOutput:
      typeof capabilities.video_generation === "boolean"
        ? capabilities.video_generation
        : undefined,
  };
}

function providerModelType(
  rawType: string | undefined,
  flags: ReturnType<typeof capabilityFlags>,
): ProviderModelType | undefined {
  const type = rawType?.trim().toLocaleLowerCase().replace(/[\s_]+/gu, "-");
  if (flags.embedding || type?.includes("embed")) return "embedding";
  if (flags.reranking || type?.includes("rerank")) return "reranker";
  // Explicit output capabilities are stronger than a server's generic `llm`
  // label; otherwise media-only endpoints leak into chat model lists.
  if (flags.videoOutput) return "video";
  if (flags.audioOutput) return "audio";
  if (flags.imageOutput) return "image";
  if (
    type === "llm" ||
    type === "vlm" ||
    type === "chat" ||
    type === "chat-completion" ||
    type === "text-generation" ||
    type === "text-to-text" ||
    type === "image-text-to-text"
  ) {
    return "llm";
  }
  if (type?.includes("video")) return "video";
  if (
    type?.includes("audio") ||
    type?.includes("speech") ||
    type === "tts" ||
    type?.includes("transcription")
  ) {
    return "audio";
  }
  if (type?.includes("image") || type?.includes("diffusion")) return "image";
  if (flags.completion) return "llm";
  return undefined;
}

function isProviderNonChatType(type: ProviderModelType | undefined): boolean {
  return type !== undefined && type !== "llm";
}

function genericMetadata(entry: GenericModelEntry): ProviderModelMetadata {
  const flags = capabilityFlags(entry.capabilities);
  const quantization =
    typeof entry.quantization === "string"
      ? entry.quantization
      : (entry.quantization?.name ?? undefined);
  return {
    source: "provider",
    name: entry.display_name ?? entry.name,
    type: providerModelType(entry.type, flags),
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
  for (const entry of entries.slice(0, MAX_DISCOVERED_MODELS)) {
    const candidate = entry.id ?? entry.key ?? entry.name;
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id || id.length > MAX_DISCOVERED_MODEL_ID_LENGTH) continue;
    metadataEntries.push([id, genericMetadata(entry)]);
  }
  const metadata = Object.fromEntries(metadataEntries);
  const models = Object.keys(metadata)
    .filter((id) => !isProviderNonChatType(metadata[id]?.type))
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
  let recommendedModel: string | undefined;
  for (const entry of entries.slice(0, MAX_DISCOVERED_MODELS)) {
    const key = typeof entry.key === "string" ? entry.key : undefined;
    if (!key || key.length > MAX_DISCOVERED_MODEL_ID_LENGTH) continue;
    const capabilities = capabilityFlags(entry.capabilities);
    const type = providerModelType(
      typeof entry.type === "string" ? entry.type : undefined,
      capabilities,
    );
    const quantization = object(entry.quantization);
    const loadedInstances = entry.loaded_instances;
    if (
      !recommendedModel &&
      !isProviderNonChatType(type) &&
      ((Array.isArray(loadedInstances) && loadedInstances.length > 0) || entry.state === "loaded")
    ) {
      recommendedModel = key;
    }
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
    .filter((id) => !isProviderNonChatType(modelMetadata[id]?.type))
    .sort();
  return {
    models,
    modelMetadata,
    ...(recommendedModel && models.includes(recommendedModel) ? { recommendedModel } : {}),
  };
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

export async function discoverOllamaModels(
  provider: StoredProvider,
  headers: Record<string, string>,
  timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
): Promise<DiscoveredModels | null> {
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MODEL_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);
  try {
    const tagsValue = await fetchJson(providerEndpoint(provider, "/api/tags"), headers, {
      signal: controller.signal,
      timeoutMs: boundedTimeoutMs,
    });
    const tagsResponse = object(tagsValue);
    if (!tagsResponse || !Array.isArray(tagsResponse.models)) return null;
    const tags = tagsResponse.models
      .slice(0, MAX_DISCOVERED_MODELS)
      .map((value) => object(value) as OllamaTag | null)
      .filter((value): value is OllamaTag => {
        const id = value?.model ?? value?.name;
        return Boolean(id && id.length <= MAX_DISCOVERED_MODEL_ID_LENGTH);
      });

    const rows = await mapWithConcurrency(tags, 4, async (tag) => {
      const id = tag.model ?? tag.name!;
      let detail: OllamaShowResponse = {};
      if (!controller.signal.aborted) {
        try {
          const value = await fetchJson(providerEndpoint(provider, "/api/show"), headers, {
            method: "POST",
            body: JSON.stringify({ model: id, verbose: false }),
            signal: controller.signal,
            timeoutMs: boundedTimeoutMs,
          });
          detail = (object(value) ?? {}) as OllamaShowResponse;
        } catch {
          // A damaged or deadline-aborted detail entry must not hide the safe
          // tag metadata from the rest of an otherwise healthy local catalog.
        }
      }
      const capabilities = capabilityFlags(detail.capabilities);
      const type = providerModelType(undefined, capabilities);
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
      .filter((row) => row.metadata.type === "llm")
      .map((row) => row.id)
      .sort();
    return { models, modelMetadata };
  } finally {
    clearTimeout(timeout);
  }
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
      const native = await discoverOllamaModels(provider, headers);
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
