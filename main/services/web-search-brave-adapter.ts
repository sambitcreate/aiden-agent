/** Brave Search web-search adapter (API-key mode only). */

import { codePointLength, isRecord } from "./web-search-adapter-kit.js";
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

export const BRAVE_WEB_SEARCH_ORIGIN = "https://api.search.brave.com";
export const BRAVE_WEB_SEARCH_ENDPOINT = `${BRAVE_WEB_SEARCH_ORIGIN}/res/v1/web/search`;
export const BRAVE_WEB_SEARCH_QUERY_MAX_CHARS = 400;
export const BRAVE_WEB_SEARCH_QUERY_MAX_WORDS = 50;

export interface BraveWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type BraveWebSearchCredential = BraveWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("brave", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("brave", credential);
  if (
    codePointLength(query) > BRAVE_WEB_SEARCH_QUERY_MAX_CHARS ||
    query.split(/\s+/u).length > BRAVE_WEB_SEARCH_QUERY_MAX_WORDS
  ) {
    throw webSearchError("invalid-request", "brave");
  }
  const url = new URL(BRAVE_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  return freezeWebSearchJsonRequest({
    url: url.toString(),
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
}

/** Build the fixed-origin Brave request without performing I/O. */
export function buildBraveWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: BraveWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Brave's `{ web: { results: [...] } }` JSON envelope. */
export function parseBraveWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!isValidWebSearchResultCount(maximumResults) || !isRecord(payload)) return undefined;
  // Brave documents `web` as nullable for a successful search with no web
  // matches. Preserve that valid empty result set while rejecting an absent
  // or incorrectly typed envelope.
  if (payload.web === null) return { results: [] };
  if (!isRecord(payload.web) || !Array.isArray(payload.web.results)) return undefined;

  return collectUniqueWebSearchResults(payload.web.results, maximumResults, (item) => ({
    title: item.title,
    text: item.description ?? item.snippet,
  }));
}

const BRAVE_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "brave",
  endpoint: BRAVE_WEB_SEARCH_ENDPOINT,
  allowQuery: true,
  buildRequest: (request: WebSearchAdapterRequest) =>
    buildRequestValues(request.query, request.numResults, request.credential),
  parse: parseBraveWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createBraveWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(BRAVE_DEFINITION, options);
}

export const braveWebSearchAdapterFactory = createBraveWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireBraveWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "brave");
}
