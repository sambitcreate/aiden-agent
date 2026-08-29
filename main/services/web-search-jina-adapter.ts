/** Jina Search Foundation API adapter (API-key mode only). */

import {
  WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
  mapWebSearchJsonHttpError,
  mapWebSearchJsonTransportError,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  readBoundedWebSearchJsonResponse,
  requireWebSearchApiKey,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
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

export const JINA_WEB_SEARCH_ORIGIN = "https://s.jina.ai";
export const JINA_WEB_SEARCH_ENDPOINT = `${JINA_WEB_SEARCH_ORIGIN}/`;

export interface JinaWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type JinaWebSearchCredential = JinaWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("jina", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("jina", value.apiKey);
  }
  throw webSearchError("auth", "jina");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const url = new URL(encodeURIComponent(query), JINA_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("count", String(numResults));
  return Object.freeze({
    url: url.toString(),
    init: Object.freeze({
      method: "GET" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Respond-With": "no-content",
        "X-Retain-Images": "none",
      }),
    }),
  });
}

/** Build the fixed-origin Jina Search request without performing I/O. */
export function buildJinaWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: JinaWebSearchCredential,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("jina", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

function normalizedSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function mapJinaItems(
  items: unknown[],
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } {
  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title,
      url,
      text: item.description ?? item.content,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

/**
 * Map Jina's JSON response into source-only evidence. Jina also accepts a
 * legacy direct-array response; retaining it keeps the adapter compatible with
 * the reviewed Pi contract without accepting arbitrary response fields.
 */
export function parseJinaWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
    return undefined;
  }
  if (Array.isArray(payload)) return mapJinaItems(payload, maximumResults);
  if (!isRecord(payload)) return undefined;

  if (payload.code !== undefined) {
    if (!Number.isSafeInteger(payload.code)) return undefined;
    if (payload.code !== 200) {
      throw mapWebSearchJsonHttpError("jina", payload.code, [402]);
    }
  }
  if (!Array.isArray(payload.data)) return undefined;
  return mapJinaItems(payload.data, maximumResults);
}

function fixedJinaEndpointMatches(requestUrl: string): boolean {
  try {
    const expected = new URL(JINA_WEB_SEARCH_ORIGIN);
    const actual = new URL(requestUrl);
    return (
      expected.protocol === "https:" &&
      actual.protocol === expected.protocol &&
      actual.origin === expected.origin &&
      actual.pathname.startsWith("/") &&
      !actual.username &&
      !actual.password &&
      !actual.hash
    );
  } catch {
    return false;
  }
}

function decodeJsonBody(body: Uint8Array, contentType: string | undefined): unknown {
  const mediaType =
    typeof contentType === "string"
      ? contentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
  if (mediaType !== undefined && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw webSearchError("invalid-response", "jina");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw webSearchError("invalid-response", "jina");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw webSearchError("invalid-response", "jina");
  }
}

function ensureJinaResponseShape(response: Response): void {
  if (
    !response ||
    typeof response.status !== "number" ||
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    !response.headers ||
    typeof response.headers.get !== "function"
  ) {
    throw webSearchError("invalid-response", "jina");
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is discarded and cancellation failures are intentionally closed.
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

/** Factory consumed by the main-only provider registry integration. */
export function createJinaWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw webSearchError("unavailable", "jina");

  return Object.freeze({
    providerId: "jina" as const,
    adapterVersion: 1,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      if (request.signal.aborted) {
        throw webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", "jina");
      }

      let contract: WebSearchJsonRequestContract;
      try {
        if (request.credentialMode !== "api-key" || request.credential === undefined) {
          throw webSearchError("auth", "jina");
        }
        contract = buildJinaWebSearchRequest(request.query, request.numResults, request.credential);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-request", "jina");
      }
      if (!fixedJinaEndpointMatches(contract.url)) {
        throw webSearchError("config", "jina");
      }

      let response: Response;
      try {
        response = await fetchImpl(contract.url, requestWithSignal(contract, request.signal));
      } catch (error) {
        throw mapWebSearchJsonTransportError("jina", error, request);
      }
      ensureJinaResponseShape(response);
      if (response.status < 200 || response.status >= 300) {
        await cancelBody(response);
        throw mapWebSearchJsonHttpError("jina", response.status, [402]);
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedWebSearchJsonResponse(
          response,
          request.signal,
          WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
          "jina",
        );
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw mapWebSearchJsonTransportError("jina", error, request);
      }
      if (request.signal.aborted) {
        throw webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", "jina");
      }

      let contentType: string | undefined;
      try {
        contentType = response.headers.get("content-type") ?? undefined;
      } catch {
        throw webSearchError("invalid-response", "jina");
      }
      const payload = decodeJsonBody(bytes, contentType);
      const parsed = parseJinaWebSearchResponse(payload, request.numResults);
      if (!parsed || !Array.isArray(parsed.results)) {
        throw webSearchError("invalid-response", "jina");
      }
      try {
        return normalizeWebSearchResultSet("jina", { results: parsed.results });
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-response", "jina");
      }
    },
  });
}

export const jinaWebSearchAdapterFactory = createJinaWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireJinaWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "jina");
}

export type { WebSearchFetch };
