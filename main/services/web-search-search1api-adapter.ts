/** Search1API Search endpoint adapter (API-key mode only). */

import {
  createWebSearchJsonAdapter,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  requireWebSearchApiKey,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import type { WebSearchAdapter, WebSearchAdapterRequest } from "./web-search-provider-registry.js";
import { webSearchError } from "./web-search-core.js";

export const SEARCH1API_WEB_SEARCH_ORIGIN = "https://api.search1api.com";
export const SEARCH1API_WEB_SEARCH_ENDPOINT = `${SEARCH1API_WEB_SEARCH_ORIGIN}/search`;

export interface Search1APIWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type Search1APIWebSearchCredential = Search1APIWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("search1api", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("search1api", value.apiKey);
  }
  throw webSearchError("auth", "search1api");
}

function requestContract(body: string, apiKey: string): WebSearchJsonRequestContract {
  return Object.freeze({
    url: SEARCH1API_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      }),
      body,
    }),
  });
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput(
    "search1api",
    queryValue,
    numResultsValue,
  );
  const body = JSON.stringify({
    query,
    max_results: numResults,
    // Deep Search is a separate paid content operation. This adapter only
    // handles the model-facing bounded search request.
    crawl_results: 0,
  });
  return requestContract(body, credentialValue(credential));
}

/** Build the fixed-origin Search1API request without performing I/O. */
export function buildSearch1APIWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: Search1APIWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
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

/** Parse Search1API's `{ searchParameters, results: [{ title, link, snippet }] }`. */
export function parseSearch1APIWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 10 ||
    !isRecord(payload) ||
    !Array.isArray(payload.results)
  ) {
    return undefined;
  }

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.results) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title,
      url,
      text: item.snippet ?? item.content,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

const SEARCH1API_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "search1api",
  endpoint: SEARCH1API_WEB_SEARCH_ENDPOINT,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "search1api");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseSearch1APIWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createSearch1APIWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(SEARCH1API_DEFINITION, options);
}

export const search1APIWebSearchAdapterFactory = createSearch1APIWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireSearch1APIWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "search1api");
}
