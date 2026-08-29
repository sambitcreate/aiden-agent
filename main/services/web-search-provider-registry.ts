/**
 * Main-process Web Search adapter registry.
 *
 * The renderer-facing provider catalog lives in
 * `web-search-provider-registry-core.ts`.  This module is intentionally main
 * only: adapter factories, fetch implementations, and credentials never
 * cross that boundary.
 */

import {
  buildExaMcpRequest,
  exaMcpHttpError,
  exaMcpTransportError,
  parseExaMcpResponse,
  type ExaCredential,
  type ExaMcpErrorCategory,
} from "./web-search-exa-core.js";
import {
  buildParallelMcpRequest,
  parallelMcpTransportError,
  parseParallelMcpResponse,
  type ParallelMcpCredential,
  type ParallelMcpErrorCategory,
} from "./web-search-parallel-mcp-core.js";
import {
  buildPerplexityRequest,
  perplexityTransportError,
  parsePerplexityResponse,
  type PerplexityErrorCategory,
} from "./web-search-perplexity-core.js";
import {
  buildGeminiRequest,
  geminiTransportError,
  parseGeminiResponse,
  type GeminiErrorCategory,
} from "./web-search-gemini-core.js";
import { WEB_SEARCH_WAVE1_ADAPTER_FACTORIES } from "./web-search-wave1-adapters.js";
import {
  getWebSearchProviderDefinition,
  type WebSearchCredentialMode,
  type WebSearchProviderId,
} from "./web-search-provider-registry-core.js";
import {
  normalizeWebSearchResultSet,
  webSearchError,
  WebSearchError,
  type WebSearchResultSet,
} from "./web-search-core.js";

export type WebSearchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WebSearchAdapterRequest {
  readonly query: string;
  readonly numResults: number;
  readonly credentialMode: WebSearchCredentialMode;
  /** Main-owned API key. It is never included in a result or error. */
  readonly credential?: string;
  readonly signal: AbortSignal;
  /** Distinguishes the service deadline from caller cancellation. */
  readonly timedOut?: () => boolean;
}

export interface WebSearchAdapter {
  readonly providerId: WebSearchProviderId;
  readonly adapterVersion: number;
  search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet>;
}

export type WebSearchAdapterFactory = (options?: { fetch?: WebSearchFetch }) => WebSearchAdapter;

export interface WebSearchAdapterFactoryOptions {
  readonly fetch?: WebSearchFetch;
}

function asWebSearchError(
  category:
    | ExaMcpErrorCategory
    | ParallelMcpErrorCategory
    | PerplexityErrorCategory
    | GeminiErrorCategory,
  providerId: WebSearchProviderId = "exa",
): WebSearchError {
  switch (category) {
    case "invalid_request":
      return webSearchError("invalid-request", providerId);
    case "authentication":
      return webSearchError("auth", providerId);
    case "rate_limit":
      return webSearchError("quota", providerId);
    case "upstream":
      return webSearchError("transient", providerId);
    case "network":
      return webSearchError("network", providerId);
    case "timeout":
      return webSearchError("timeout", providerId);
    case "cancelled":
      return webSearchError("cancelled", providerId);
    case "policy":
      return webSearchError("config", providerId);
    case "invalid_response":
      return webSearchError("invalid-response", providerId);
  }
}

function isRedirectFailure(error: unknown): boolean {
  // Fetch implementations normally surface redirect:error as a TypeError.
  // Inspect only the local error category; the upstream text is never copied
  // into a public error.
  return (
    error instanceof Error && /\bredirect\b|redirect mode|maximum redirect/iu.test(error.message)
  );
}

function responseContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

async function raceReader<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<T>>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("The request was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Read an HTTP body before parsing it; declared and streamed bytes are bounded. */
export async function readBoundedWebSearchResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
  providerId: WebSearchProviderId = "exa",
): Promise<Uint8Array> {
  const declared = responseContentLength(response);
  if (declared !== undefined && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw webSearchError("invalid-response", providerId);
  }
  if (!response.body) throw webSearchError("invalid-response", providerId);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await raceReader(reader, signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        throw webSearchError("invalid-response", providerId);
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw webSearchError("invalid-response", providerId);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mapExaTransportFailure(error: unknown, request: WebSearchAdapterRequest): WebSearchError {
  if (request.signal.aborted) {
    return asWebSearchError(
      exaMcpTransportError(request.timedOut?.() === true ? "timeout" : "cancelled").category,
    );
  }
  if (isRedirectFailure(error)) return asWebSearchError(exaMcpTransportError("redirect").category);
  return asWebSearchError("network");
}

function adapterRequestCredential(request: WebSearchAdapterRequest): ExaCredential {
  if (request.credentialMode === "anonymous") return { mode: "anonymous" };
  if (request.credentialMode === "api-key" && request.credential !== undefined) {
    return { mode: "api-key", apiKey: request.credential };
  }
  throw asWebSearchError("authentication");
}

export function createExaWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const definition = getWebSearchProviderDefinition("exa");
  if (!definition || definition.releaseState !== "shipped") {
    throw webSearchError("unavailable", "exa");
  }

  return Object.freeze({
    providerId: "exa" as const,
    adapterVersion: definition.adapterVersion,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      let built: ReturnType<typeof buildExaMcpRequest>;
      try {
        built = buildExaMcpRequest(
          request.query,
          request.numResults,
          adapterRequestCredential(request),
        );
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw asWebSearchError("invalid_request");
      }

      let response: Response;
      try {
        response = await fetchImpl(built.url, {
          ...built.init,
          signal: request.signal,
        });
      } catch (error) {
        throw mapExaTransportFailure(error, request);
      }

      let body: Uint8Array;
      try {
        body = await readBoundedWebSearchResponse(response, request.signal, 256 * 1_024);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw mapExaTransportFailure(error, request);
      }

      const parsed = parseExaMcpResponse(
        {
          status: response.status,
          body,
          contentType: response.headers.get("content-type") ?? undefined,
        },
        request.numResults,
      );
      if (!parsed.ok) throw asWebSearchError(parsed.error.category);
      try {
        return normalizeWebSearchResultSet("exa", { results: parsed.value.results });
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-response", "exa");
      }
    },
  });
}

type Wave1ErrorCategory =
  | ExaMcpErrorCategory
  | ParallelMcpErrorCategory
  | PerplexityErrorCategory
  | GeminiErrorCategory;

interface Wave1RequestContract {
  readonly url: string;
  readonly init: {
    readonly method: "POST";
    readonly redirect: "error";
    readonly credentials: "omit";
    readonly cache: "no-store";
    readonly referrerPolicy: "no-referrer";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

interface Wave1ParseSuccess {
  readonly ok: true;
  readonly value: { readonly results: readonly { title: string; url: string; text: string }[] };
}

interface Wave1ParseFailure {
  readonly ok: false;
  readonly error: { readonly category: Wave1ErrorCategory };
}

type Wave1ParseOutcome = Wave1ParseSuccess | Wave1ParseFailure;

function mapWave1TransportFailure(
  providerId: WebSearchProviderId,
  error: unknown,
  request: WebSearchAdapterRequest,
  transportError: (kind: unknown) => { category: Wave1ErrorCategory },
): WebSearchError {
  if (request.signal.aborted) {
    return asWebSearchError(
      transportError(request.timedOut?.() === true ? "timeout" : "cancelled").category,
      providerId,
    );
  }
  if (isRedirectFailure(error)) {
    return asWebSearchError(transportError("redirect").category, providerId);
  }
  return asWebSearchError("network", providerId);
}

async function runWave1AdapterSearch(
  providerId: WebSearchProviderId,
  request: WebSearchAdapterRequest,
  fetchImpl: WebSearchFetch,
  buildRequest: () => Wave1RequestContract,
  parseResponse: (
    response: {
      status: number;
      body: Uint8Array;
      contentType?: string;
    },
    maximumResults: number,
  ) => Wave1ParseOutcome,
  transportError: (kind: unknown) => { category: Wave1ErrorCategory },
): Promise<WebSearchResultSet> {
  if (request.signal.aborted) {
    throw webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", providerId);
  }
  let built: Wave1RequestContract;
  try {
    built = buildRequest();
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw webSearchError("invalid-request", providerId);
  }

  let response: Response;
  try {
    response = await fetchImpl(built.url, {
      ...built.init,
      signal: request.signal,
    });
  } catch (error) {
    throw mapWave1TransportFailure(providerId, error, request, transportError);
  }
  if (!response || typeof response.status !== "number") {
    throw webSearchError("invalid-response", providerId);
  }
  if (!response.headers || typeof response.headers.get !== "function") {
    throw webSearchError("invalid-response", providerId);
  }

  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    const parsed = parseResponse(
      { status: response.status, body: new Uint8Array(0) },
      request.numResults,
    );
    if (!parsed.ok) throw asWebSearchError(parsed.error.category, providerId);
    throw webSearchError("invalid-response", providerId);
  }

  let body: Uint8Array;
  try {
    body = await readBoundedWebSearchResponse(response, request.signal, 256 * 1_024, providerId);
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw mapWave1TransportFailure(providerId, error, request, transportError);
  }
  if (request.signal.aborted) {
    throw webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", providerId);
  }
  let contentType: string | undefined;
  try {
    contentType = response.headers.get("content-type") ?? undefined;
  } catch {
    throw webSearchError("invalid-response", providerId);
  }
  const parsed = parseResponse({ status: response.status, body, contentType }, request.numResults);
  if (!parsed.ok) throw asWebSearchError(parsed.error.category, providerId);
  try {
    return normalizeWebSearchResultSet(providerId, { results: parsed.value.results });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw webSearchError("invalid-response", providerId);
  }
}

function apiKeyCredential(
  request: WebSearchAdapterRequest,
  providerId: WebSearchProviderId,
): string {
  if (request.credentialMode !== "api-key" || request.credential === undefined) {
    throw webSearchError("auth", providerId);
  }
  const credential = request.credential;
  const normalized = credential.trim();
  if (
    !normalized ||
    /\p{Cc}/u.test(credential) ||
    Array.from(normalized).length > 4_096 ||
    new TextEncoder().encode(normalized).byteLength > 8 * 1_024
  ) {
    throw webSearchError("auth", providerId);
  }
  return normalized;
}

export function createParallelMcpWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const definition = getWebSearchProviderDefinition("parallel-mcp");
  if (!definition || definition.releaseState !== "shipped") {
    throw webSearchError("unavailable", "parallel-mcp");
  }
  if (typeof fetchImpl !== "function") throw webSearchError("unavailable", "parallel-mcp");

  return Object.freeze({
    providerId: "parallel-mcp" as const,
    adapterVersion: definition.adapterVersion,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      const credential: ParallelMcpCredential =
        request.credentialMode === "anonymous"
          ? { mode: "anonymous" }
          : { mode: "api-key", apiKey: apiKeyCredential(request, "parallel-mcp") };
      return runWave1AdapterSearch(
        "parallel-mcp",
        request,
        fetchImpl,
        () => buildParallelMcpRequest(request.query, request.numResults, credential),
        (response, maximumResults) => parseParallelMcpResponse(response, maximumResults),
        parallelMcpTransportError,
      );
    },
  });
}

export const parallelMcpWebSearchAdapterFactory = createParallelMcpWebSearchAdapter;

export function createPerplexityWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const definition = getWebSearchProviderDefinition("perplexity");
  if (!definition || definition.releaseState !== "shipped") {
    throw webSearchError("unavailable", "perplexity");
  }
  if (typeof fetchImpl !== "function") throw webSearchError("unavailable", "perplexity");

  return Object.freeze({
    providerId: "perplexity" as const,
    adapterVersion: definition.adapterVersion,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      const apiKey = apiKeyCredential(request, "perplexity");
      return runWave1AdapterSearch(
        "perplexity",
        request,
        fetchImpl,
        () => buildPerplexityRequest(request.query, request.numResults, apiKey),
        (response, maximumResults) => parsePerplexityResponse(response, maximumResults),
        perplexityTransportError,
      );
    },
  });
}

export const perplexityWebSearchAdapterFactory = createPerplexityWebSearchAdapter;

export function createGeminiWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const definition = getWebSearchProviderDefinition("gemini");
  if (!definition || definition.releaseState !== "shipped") {
    throw webSearchError("unavailable", "gemini");
  }
  if (typeof fetchImpl !== "function") throw webSearchError("unavailable", "gemini");

  return Object.freeze({
    providerId: "gemini" as const,
    adapterVersion: definition.adapterVersion,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      const apiKey = apiKeyCredential(request, "gemini");
      return runWave1AdapterSearch(
        "gemini",
        request,
        fetchImpl,
        () => buildGeminiRequest(request.query, request.numResults, apiKey),
        (response, maximumResults) => parseGeminiResponse(response, maximumResults),
        geminiTransportError,
      );
    },
  });
}

export const geminiWebSearchAdapterFactory = createGeminiWebSearchAdapter;

/** Main-only factories for all adapters whose Wave 1 contracts are shipped. */
export const WEB_SEARCH_ADAPTER_FACTORIES: Readonly<
  Partial<Record<WebSearchProviderId, WebSearchAdapterFactory>>
> = Object.freeze({
  openai: WEB_SEARCH_WAVE1_ADAPTER_FACTORIES.openai,
  brave: WEB_SEARCH_WAVE1_ADAPTER_FACTORIES.brave,
  "parallel-mcp": parallelMcpWebSearchAdapterFactory,
  tavily: WEB_SEARCH_WAVE1_ADAPTER_FACTORIES.tavily,
  perplexity: perplexityWebSearchAdapterFactory,
  gemini: geminiWebSearchAdapterFactory,
  exa: createExaWebSearchAdapter,
});

export function webSearchAdapterFactory(providerId: unknown): WebSearchAdapterFactory | undefined {
  return typeof providerId === "string" &&
    Object.prototype.hasOwnProperty.call(WEB_SEARCH_ADAPTER_FACTORIES, providerId)
    ? WEB_SEARCH_ADAPTER_FACTORIES[providerId as WebSearchProviderId]
    : undefined;
}

export const getWebSearchAdapterFactory = webSearchAdapterFactory;

export function webSearchAdapterAvailable(providerId: unknown): boolean {
  return webSearchAdapterFactory(providerId) !== undefined;
}

export const isWebSearchAdapterAvailable = webSearchAdapterAvailable;

/** Closed HTTP status mapping kept available for transport-focused tests. */
export const mapExaHttpError = (status: unknown): WebSearchError =>
  asWebSearchError(exaMcpHttpError(status).category);
