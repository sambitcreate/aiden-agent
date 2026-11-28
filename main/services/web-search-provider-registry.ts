/**
 * Main-process Web Search adapter registry.
 *
 * The renderer-facing provider catalog lives in
 * `web-search-provider-registry-core.ts`.  This module is intentionally main
 * only: adapter factories, fetch implementations, and credentials never
 * cross that boundary.
 */

import {
  isRedirectTransportFailure,
  webSearchErrorKindFromCoreCategory,
  type WebSearchCoreErrorCategory,
} from "./web-search-adapter-kit.js";
import {
  buildExaMcpRequest,
  exaMcpTransportError,
  parseExaMcpResponse,
  type ExaCredential,
} from "./web-search-exa-core.js";
import {
  buildParallelMcpRequest,
  parallelMcpTransportError,
  parseParallelMcpResponse,
  type ParallelMcpCredential,
} from "./web-search-parallel-mcp-core.js";
import {
  buildPerplexityRequest,
  perplexityTransportError,
  parsePerplexityResponse,
} from "./web-search-perplexity-core.js";
import {
  buildGeminiRequest,
  geminiTransportError,
  parseGeminiResponse,
} from "./web-search-gemini-core.js";
import { requireWebSearchApiKey } from "./web-search-json-adapter.js";
import { WEB_SEARCH_WAVE1_ADAPTER_FACTORIES } from "./web-search-wave1-adapters.js";
import { WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES } from "./web-search-wave2-batch-a.js";
import { WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES } from "./web-search-wave2-batch-b.js";
import { WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES } from "./web-search-wave4-batch-a.js";
import { WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES } from "./web-search-wave4-batch-b.js";
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
import type { WebSearchResolvedExistingAuth } from "./web-search-auth-reuse.js";

import { cancelWebSearchResponse, readBoundedWebSearchResponse } from "./web-search-response.js";
export { readBoundedWebSearchResponse } from "./web-search-response.js";

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
  /** Main-only, already reverified provider binding; never renderer input. */
  readonly existingAuth?: WebSearchResolvedExistingAuth;
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

interface CoreRequestContract {
  readonly url: string;
  readonly init: {
    readonly method: "POST";
    readonly redirect: "error";
    readonly credentials?: "omit";
    readonly cache?: "no-store";
    readonly referrerPolicy?: "no-referrer";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

interface CoreParseSuccess {
  readonly ok: true;
  readonly value: { readonly results: readonly { title: string; url: string; text: string }[] };
}

interface CoreParseFailure {
  readonly ok: false;
  readonly error: { readonly category: WebSearchCoreErrorCategory };
}

type CoreParseOutcome = CoreParseSuccess | CoreParseFailure;

function asWebSearchError(
  category: WebSearchCoreErrorCategory,
  providerId: WebSearchProviderId,
): WebSearchError {
  return webSearchError(webSearchErrorKindFromCoreCategory(category), providerId);
}

function mapCoreTransportFailure(
  providerId: WebSearchProviderId,
  error: unknown,
  request: WebSearchAdapterRequest,
  transportError: (kind: unknown) => { category: WebSearchCoreErrorCategory },
): WebSearchError {
  if (request.signal.aborted) {
    return asWebSearchError(
      transportError(request.timedOut?.() === true ? "timeout" : "cancelled").category,
      providerId,
    );
  }
  if (isRedirectTransportFailure(error)) {
    return asWebSearchError(transportError("redirect").category, providerId);
  }
  return asWebSearchError("network", providerId);
}

async function runCoreAdapterSearch(
  providerId: WebSearchProviderId,
  request: WebSearchAdapterRequest,
  fetchImpl: WebSearchFetch,
  buildRequest: () => CoreRequestContract,
  parseResponse: (
    response: {
      status: number;
      body: Uint8Array;
      contentType?: string;
    },
    maximumResults: number,
  ) => CoreParseOutcome,
  transportError: (kind: unknown) => { category: WebSearchCoreErrorCategory },
): Promise<WebSearchResultSet> {
  if (request.signal.aborted) {
    throw webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", providerId);
  }
  let built: CoreRequestContract;
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
    throw mapCoreTransportFailure(providerId, error, request, transportError);
  }
  if (!response || typeof response.status !== "number") {
    throw webSearchError("invalid-response", providerId);
  }
  if (!response.headers || typeof response.headers.get !== "function") {
    throw webSearchError("invalid-response", providerId);
  }

  if (response.status < 200 || response.status >= 300) {
    cancelWebSearchResponse(response.body);
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
    throw mapCoreTransportFailure(providerId, error, request, transportError);
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

function anonymousOrApiKeyCredential(
  request: WebSearchAdapterRequest,
  providerId: "exa" | "parallel-mcp",
): ExaCredential & ParallelMcpCredential {
  if (request.credentialMode === "anonymous") return { mode: "anonymous" };
  return { mode: "api-key", apiKey: requireWebSearchApiKey(request, providerId) };
}

function createCoreWebSearchAdapter(
  providerId: "exa" | "parallel-mcp" | "perplexity" | "gemini",
  options: WebSearchAdapterFactoryOptions,
  buildRequest: (request: WebSearchAdapterRequest) => CoreRequestContract,
  parseResponse: (
    response: { status: number; body: Uint8Array; contentType?: string },
    maximumResults: number,
  ) => CoreParseOutcome,
  transportError: (kind: unknown) => { category: WebSearchCoreErrorCategory },
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const definition = getWebSearchProviderDefinition(providerId);
  if (!definition || definition.releaseState !== "shipped" || typeof fetchImpl !== "function") {
    throw webSearchError("unavailable", providerId);
  }
  return Object.freeze({
    providerId,
    adapterVersion: definition.adapterVersion,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      return runCoreAdapterSearch(
        providerId,
        request,
        fetchImpl,
        () => buildRequest(request),
        parseResponse,
        transportError,
      );
    },
  });
}

export function createExaWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  return createCoreWebSearchAdapter(
    "exa",
    options,
    (request) =>
      buildExaMcpRequest(
        request.query,
        request.numResults,
        anonymousOrApiKeyCredential(request, "exa"),
      ),
    parseExaMcpResponse,
    exaMcpTransportError,
  );
}

export function createParallelMcpWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  return createCoreWebSearchAdapter(
    "parallel-mcp",
    options,
    (request) =>
      buildParallelMcpRequest(
        request.query,
        request.numResults,
        anonymousOrApiKeyCredential(request, "parallel-mcp"),
      ),
    parseParallelMcpResponse,
    parallelMcpTransportError,
  );
}

export const parallelMcpWebSearchAdapterFactory = createParallelMcpWebSearchAdapter;

export function createPerplexityWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  return createCoreWebSearchAdapter(
    "perplexity",
    options,
    (request) =>
      buildPerplexityRequest(
        request.query,
        request.numResults,
        requireWebSearchApiKey(request, "perplexity"),
      ),
    parsePerplexityResponse,
    perplexityTransportError,
  );
}

export const perplexityWebSearchAdapterFactory = createPerplexityWebSearchAdapter;

export function createGeminiWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  return createCoreWebSearchAdapter(
    "gemini",
    options,
    (request) =>
      buildGeminiRequest(
        request.query,
        request.numResults,
        requireWebSearchApiKey(request, "gemini"),
      ),
    parseGeminiResponse,
    geminiTransportError,
  );
}

export const geminiWebSearchAdapterFactory = createGeminiWebSearchAdapter;

/** Main-only factories for every adapter whose reviewed contract is shipped. */
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
  ...WEB_SEARCH_WAVE2_BATCH_A_ADAPTER_FACTORIES,
  ...WEB_SEARCH_WAVE2_BATCH_B_ADAPTER_FACTORIES,
  ...WEB_SEARCH_WAVE4_BATCH_A_ADAPTER_FACTORIES,
  ...WEB_SEARCH_WAVE4_BATCH_B_ADAPTER_FACTORIES,
});

export function webSearchAdapterFactory(providerId: unknown): WebSearchAdapterFactory | undefined {
  return typeof providerId === "string" &&
    Object.prototype.hasOwnProperty.call(WEB_SEARCH_ADAPTER_FACTORIES, providerId)
    ? WEB_SEARCH_ADAPTER_FACTORIES[providerId as WebSearchProviderId]
    : undefined;
}

export function webSearchAdapterAvailable(providerId: unknown): boolean {
  return webSearchAdapterFactory(providerId) !== undefined;
}
