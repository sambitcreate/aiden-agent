/**
 * Bounded transport for the JSON-based Web Search providers.
 *
 * Provider modules own their fixed URL, request shape, and response parser.
 * This module owns the common network safety envelope: no redirects or
 * ambient credentials, no-store/no-referrer fetches, abort propagation,
 * declared and streamed response limits, and closed provider errors.
 */

import {
  WEB_SEARCH_API_KEY_MAX_CHARACTERS,
  WEB_SEARCH_API_KEY_MAX_UTF8_BYTES,
  WEB_SEARCH_QUERY_MAX_CHARACTERS,
  WEB_SEARCH_QUERY_MAX_UTF8_BYTES,
  classifyWebSearchHttpStatus,
  isRecord,
  isRedirectTransportFailure,
  isValidWebSearchResultCount,
  normalizeWebSearchSourceUrl,
  parseWebSearchApiKey,
  parseWebSearchMediaType,
  parseWebSearchQuery,
  parseWebSearchResultCount,
  utf8ByteLength,
  webSearchErrorKindFromCoreCategory,
} from "./web-search-adapter-kit.js";
import {
  normalizeWebSearchResultSet,
  webSearchError,
  WebSearchError,
  type WebSearchResultSet,
} from "./web-search-core.js";
import type {
  WebSearchAdapter,
  WebSearchAdapterRequest,
  WebSearchFetch,
} from "./web-search-provider-registry.js";
import type { WebSearchProviderId } from "./web-search-provider-registry-core.js";

import {
  cancelWebSearchResponse,
  readBoundedWebSearchResponse as readBoundedWebSearchJsonResponse,
} from "./web-search-response.js";
export { readBoundedWebSearchResponse as readBoundedWebSearchJsonResponse } from "./web-search-response.js";
export { isValidWebSearchResultCount } from "./web-search-adapter-kit.js";

export const WEB_SEARCH_JSON_RESPONSE_MAX_BYTES = 256 * 1_024;
export const WEB_SEARCH_JSON_REQUEST_MAX_BYTES = 8 * 1_024;
export const WEB_SEARCH_API_KEY_MAX_CHARS = WEB_SEARCH_API_KEY_MAX_CHARACTERS;
export const WEB_SEARCH_API_KEY_MAX_BYTES = WEB_SEARCH_API_KEY_MAX_UTF8_BYTES;

export interface WebSearchJsonRequestContract {
  readonly url: string;
  readonly init: {
    readonly method: "GET" | "POST";
    readonly redirect: "error";
    readonly credentials: "omit";
    readonly cache: "no-store";
    readonly referrerPolicy: "no-referrer";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  };
}

export interface WebSearchJsonRequestEnvelopeInit {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface WebSearchJsonRawResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly text?: unknown;
  readonly snippet?: unknown;
}

export interface WebSearchJsonParsedResponse {
  readonly results: readonly WebSearchJsonRawResult[];
}

export interface WebSearchJsonAdapterDefinition {
  readonly providerId: WebSearchProviderId;
  readonly endpoint: string;
  readonly allowQuery?: boolean;
  /** Allow path-encoded queries beneath the fixed HTTPS endpoint origin/base path. */
  readonly allowOriginScopedPath?: boolean;
  /** Provider-specific quota responses in addition to the common 429. */
  readonly quotaStatuses?: readonly number[];
  readonly buildRequest: (request: WebSearchAdapterRequest) => WebSearchJsonRequestContract;
  readonly parse: (
    payload: unknown,
    maximumResults: number,
  ) => WebSearchJsonParsedResponse | undefined;
}

export interface WebSearchJsonAdapterOptions {
  readonly fetch?: WebSearchFetch;
}

/**
 * Validate the common model-facing query/count pair at each adapter boundary.
 * The service validates this first, but direct adapter callers must also fail
 * closed without allowing malformed values into a provider request.
 */
export function normalizeWebSearchJsonInput(
  providerId: WebSearchProviderId,
  queryValue: unknown,
  numResultsValue: unknown,
): { query: string; numResults: number } {
  const query = parseWebSearchQuery(queryValue, {
    maxRawCharacters: WEB_SEARCH_QUERY_MAX_CHARACTERS,
    maxRawBytes: WEB_SEARCH_QUERY_MAX_UTF8_BYTES,
  });
  if (query === undefined) {
    throw webSearchError("invalid-request", providerId);
  }
  const numResults = parseWebSearchResultCount(numResultsValue);
  if (numResults === undefined) {
    throw webSearchError("invalid-request", providerId);
  }
  return { query, numResults };
}

/** Normalize and validate a provider API key without retaining it in errors. */
export function normalizeWebSearchApiKey(providerId: WebSearchProviderId, value: unknown): string {
  const key = parseWebSearchApiKey(value);
  if (key === undefined) {
    throw webSearchError("auth", providerId);
  }
  return key;
}

/** Extract and validate a direct string or `{ mode: "api-key", apiKey }` credential. */
export function extractWebSearchApiKeyCredential(
  providerId: WebSearchProviderId,
  value: unknown,
): string {
  if (typeof value === "string") return normalizeWebSearchApiKey(providerId, value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey(providerId, value.apiKey);
  }
  throw webSearchError("auth", providerId);
}

/** Require the API-key route; anonymous and provider-auth routes are not valid here. */
export function requireWebSearchApiKey(
  request: WebSearchAdapterRequest,
  providerId: WebSearchProviderId,
): string {
  if (request.credentialMode !== "api-key") throw webSearchError("auth", providerId);
  return normalizeWebSearchApiKey(providerId, request.credential);
}

/** Freeze a provider request into the standard no-redirect, no-ambient-state envelope. */
export function freezeWebSearchJsonRequest(
  request: WebSearchJsonRequestEnvelopeInit,
): WebSearchJsonRequestContract {
  return Object.freeze({
    url: request.url,
    init: Object.freeze({
      method: request.method,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({ ...request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
    }),
  });
}

export interface WebSearchJsonResultCollector {
  readonly size: number;
  add(result: WebSearchJsonRawResult | undefined): void;
  results(maximumResults?: number): WebSearchJsonParsedResponse;
}

/**
 * Deduplicate normalized source URLs in insertion order, optionally backfilling
 * empty text when a later citation repeats an already-seen URL.
 */
export function createWebSearchResultCollector(options?: {
  readonly backfillEmptyText?: boolean;
}): WebSearchJsonResultCollector {
  const collected: WebSearchJsonRawResult[] = [];
  const indexByUrl = new Map<string, number>();
  return {
    get size(): number {
      return collected.length;
    },
    add(result: WebSearchJsonRawResult | undefined): void {
      if (!result || typeof result.url !== "string") return;
      const existingIndex = indexByUrl.get(result.url);
      if (existingIndex !== undefined) {
        if (
          options?.backfillEmptyText === true &&
          (collected[existingIndex]?.text === undefined || collected[existingIndex]?.text === "") &&
          typeof result.text === "string" &&
          result.text.length > 0
        ) {
          collected[existingIndex] = { ...collected[existingIndex], text: result.text };
        }
        return;
      }
      indexByUrl.set(result.url, collected.length);
      collected.push(result);
    },
    results(maximumResults?: number): WebSearchJsonParsedResponse {
      return {
        results: maximumResults === undefined ? collected : collected.slice(0, maximumResults),
      };
    },
  };
}

/**
 * Normalize, deduplicate, and cap an array of untrusted provider items using
 * `normalizeWebSearchSourceUrl`.
 */
export function collectUniqueWebSearchResults(
  items: readonly unknown[],
  maximumResults: number,
  mapItem: (
    item: Record<string, unknown>,
    url: string,
  ) => Omit<WebSearchJsonRawResult, "url"> | undefined,
  selectUrl: (item: Record<string, unknown>) => unknown = (item) => item.url,
): WebSearchJsonParsedResponse {
  if (!isValidWebSearchResultCount(maximumResults)) return { results: [] };
  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const url = normalizeWebSearchSourceUrl(selectUrl(item));
    if (!url || seen.has(url)) continue;
    const mapped = mapItem(item, url);
    if (!mapped) continue;
    seen.add(url);
    results.push({ ...mapped, url });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

function decodeJsonBody(
  body: Uint8Array,
  providerId: WebSearchProviderId,
  contentType: string | undefined,
): unknown {
  const mediaType = parseWebSearchMediaType(contentType);
  if (mediaType !== undefined && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw webSearchError("invalid-response", providerId);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw webSearchError("invalid-response", providerId);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw webSearchError("invalid-response", providerId);
  }
}

function statusError(
  providerId: WebSearchProviderId,
  status: unknown,
  quotaStatuses: readonly number[] = [],
): WebSearchError {
  return webSearchError(
    webSearchErrorKindFromCoreCategory(classifyWebSearchHttpStatus(status, quotaStatuses)),
    providerId,
  );
}

/** Map fetch failures without retaining an upstream message, URL, or body. */
export function mapWebSearchJsonTransportError(
  providerId: WebSearchProviderId,
  error: unknown,
  request: Pick<WebSearchAdapterRequest, "signal" | "timedOut">,
): WebSearchError {
  if (request.signal.aborted) {
    return webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", providerId);
  }
  if (isRedirectTransportFailure(error)) return webSearchError("config", providerId);
  return webSearchError("network", providerId);
}

function rawResultsPayload(
  parsed: WebSearchJsonParsedResponse,
  providerId: WebSearchProviderId,
): WebSearchResultSet {
  try {
    return normalizeWebSearchResultSet(providerId, { results: parsed.results });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw webSearchError("invalid-response", providerId);
  }
}

function requestWithSignal(
  contract: WebSearchJsonRequestContract,
  signal: AbortSignal,
): RequestInit {
  return {
    method: contract.init.method,
    headers: contract.init.headers,
    ...(contract.init.body === undefined ? {} : { body: contract.init.body }),
    redirect: contract.init.redirect,
    credentials: contract.init.credentials,
    cache: contract.init.cache,
    referrerPolicy: contract.init.referrerPolicy,
    signal,
  };
}

function fixedEndpointMatches(
  endpoint: string,
  requestUrl: string,
  options: {
    readonly allowQuery?: boolean;
    readonly allowOriginScopedPath?: boolean;
  } = {},
): boolean {
  try {
    const expected = new URL(endpoint);
    const actual = new URL(requestUrl);
    const basePath = expected.pathname.endsWith("/") ? expected.pathname : `${expected.pathname}/`;
    const pathMatches =
      options.allowOriginScopedPath === true
        ? actual.pathname === expected.pathname || actual.pathname.startsWith(basePath)
        : actual.pathname === expected.pathname;
    return (
      expected.protocol === "https:" &&
      !expected.username &&
      !expected.password &&
      !expected.search &&
      !expected.hash &&
      actual.protocol === expected.protocol &&
      actual.origin === expected.origin &&
      pathMatches &&
      !actual.username &&
      !actual.password &&
      !actual.hash &&
      (options.allowQuery === true || actual.search === expected.search)
    );
  } catch {
    return false;
  }
}

/** Build a factory-compatible adapter with the shared JSON transport policy. */
export function createWebSearchJsonAdapter(
  definition: WebSearchJsonAdapterDefinition,
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw webSearchError("unavailable", definition.providerId);

  return Object.freeze({
    providerId: definition.providerId,
    adapterVersion: 1,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      if (request.signal.aborted) {
        throw webSearchError(
          request.timedOut?.() === true ? "timeout" : "cancelled",
          definition.providerId,
        );
      }
      let contract: WebSearchJsonRequestContract;
      try {
        contract = definition.buildRequest(request);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-request", definition.providerId);
      }
      if (
        !fixedEndpointMatches(definition.endpoint, contract.url, {
          allowQuery: definition.allowQuery,
          allowOriginScopedPath: definition.allowOriginScopedPath,
        })
      ) {
        throw webSearchError("config", definition.providerId);
      }
      const body = contract.init.body;
      if (body !== undefined && utf8ByteLength(body) > WEB_SEARCH_JSON_REQUEST_MAX_BYTES) {
        throw webSearchError("invalid-request", definition.providerId);
      }

      let response: Response;
      try {
        response = await fetchImpl(contract.url, requestWithSignal(contract, request.signal));
      } catch (error) {
        throw mapWebSearchJsonTransportError(definition.providerId, error, request);
      }

      if (
        !response ||
        typeof response.status !== "number" ||
        !Number.isSafeInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        !response.headers ||
        typeof response.headers.get !== "function"
      ) {
        throw webSearchError("invalid-response", definition.providerId);
      }
      if (response.status < 200 || response.status >= 300) {
        cancelWebSearchResponse(response.body);
        throw statusError(definition.providerId, response.status, definition.quotaStatuses);
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedWebSearchJsonResponse(
          response,
          request.signal,
          WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
          definition.providerId,
        );
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw mapWebSearchJsonTransportError(definition.providerId, error, request);
      }
      if (request.signal.aborted) {
        throw webSearchError(
          request.timedOut?.() === true ? "timeout" : "cancelled",
          definition.providerId,
        );
      }

      let contentType: string | undefined;
      try {
        contentType = response.headers.get("content-type") ?? undefined;
      } catch {
        throw webSearchError("invalid-response", definition.providerId);
      }
      const payload = decodeJsonBody(bytes, definition.providerId, contentType);
      let parsed: WebSearchJsonParsedResponse | undefined;
      try {
        parsed = definition.parse(payload, request.numResults);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-response", definition.providerId);
      }
      if (!parsed || !Array.isArray(parsed.results)) {
        throw webSearchError("invalid-response", definition.providerId);
      }
      if (request.signal.aborted) {
        throw webSearchError(
          request.timedOut?.() === true ? "timeout" : "cancelled",
          definition.providerId,
        );
      }
      return rawResultsPayload(parsed, definition.providerId);
    },
  });
}

/** Exported for provider parser tests without exposing response/body details. */
export function mapWebSearchJsonHttpError(
  providerId: WebSearchProviderId,
  status: unknown,
  quotaStatuses: readonly number[] = [],
): WebSearchError {
  return statusError(providerId, status, quotaStatuses);
}
