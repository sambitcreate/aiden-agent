/** Search1API Search endpoint adapter (API-key mode only). */

import { isRecord } from "./web-search-adapter-kit.js";
import {
  collectUniqueWebSearchResults,
  createWebSearchJsonAdapter,
  extractWebSearchApiKeyCredential,
  freezeWebSearchJsonRequest,
  isValidWebSearchResultCount,
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
  const apiKey = extractWebSearchApiKeyCredential("search1api", credential);
  return freezeWebSearchJsonRequest({
    url: SEARCH1API_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: numResults,
      // Deep Search is a separate paid content operation. This adapter only
      // handles the model-facing bounded search request.
      crawl_results: 0,
    }),
  });
}

/** Build the fixed-origin Search1API request without performing I/O. */
export function buildSearch1APIWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: Search1APIWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Search1API's `{ searchParameters, results: [{ title, link, snippet }] }`. */
export function parseSearch1APIWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !isValidWebSearchResultCount(maximumResults) ||
    !isRecord(payload) ||
    !Array.isArray(payload.results)
  ) {
    return undefined;
  }

  return collectUniqueWebSearchResults(
    payload.results,
    maximumResults,
    (item) => ({
      title: item.title,
      text: item.snippet ?? item.content,
    }),
    (item) => item.link,
  );
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
