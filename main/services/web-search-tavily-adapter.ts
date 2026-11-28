/** Tavily Search API adapter (API-key mode only). */

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

export const TAVILY_WEB_SEARCH_ORIGIN = "https://api.tavily.com";
export const TAVILY_WEB_SEARCH_ENDPOINT = `${TAVILY_WEB_SEARCH_ORIGIN}/search`;

export interface TavilyWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type TavilyWebSearchCredential = TavilyWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("tavily", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("tavily", credential);
  return freezeWebSearchJsonRequest({
    url: TAVILY_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: numResults,
    }),
  });
}

/** Build the fixed-origin Tavily request without performing I/O. */
export function buildTavilyWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: TavilyWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Tavily's `{ results: [...] }` JSON envelope. */
export function parseTavilyWebSearchResponse(
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

  return collectUniqueWebSearchResults(payload.results, maximumResults, (item) => ({
    title: item.title,
    text: item.content ?? item.raw_content,
  }));
}

const TAVILY_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "tavily",
  endpoint: TAVILY_WEB_SEARCH_ENDPOINT,
  quotaStatuses: Object.freeze([432, 433]),
  buildRequest: (request: WebSearchAdapterRequest) =>
    buildRequestValues(request.query, request.numResults, request.credential),
  parse: parseTavilyWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createTavilyWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(TAVILY_DEFINITION, options);
}

export const tavilyWebSearchAdapterFactory = createTavilyWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireTavilyWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "tavily");
}
