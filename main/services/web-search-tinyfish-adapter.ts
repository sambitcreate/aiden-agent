/** TinyFish Search API adapter (API-key mode only). */

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

export const TINYFISH_WEB_SEARCH_ORIGIN = "https://api.search.tinyfish.ai";
/** TinyFish Search is a GET endpoint at the origin; query is encoded in its URL. */
export const TINYFISH_WEB_SEARCH_ENDPOINT = TINYFISH_WEB_SEARCH_ORIGIN;

export interface TinyFishWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type TinyFishWebSearchCredential = TinyFishWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query } = normalizeWebSearchJsonInput("tinyfish", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("tinyfish", credential);
  const url = new URL(TINYFISH_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  return freezeWebSearchJsonRequest({
    url: url.toString(),
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-Key": apiKey,
    },
  });
}

/** Build the fixed-origin TinyFish Search request without performing I/O. */
export function buildTinyFishWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: TinyFishWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse TinyFish's `{ results: [{ title, snippet, url }] }` response. */
export function parseTinyFishWebSearchResponse(
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
    text: item.snippet,
  }));
}

const TINYFISH_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "tinyfish",
  endpoint: TINYFISH_WEB_SEARCH_ENDPOINT,
  allowQuery: true,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "tinyfish");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseTinyFishWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createTinyFishWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(TINYFISH_DEFINITION, options);
}

export const tinyFishWebSearchAdapterFactory = createTinyFishWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireTinyFishWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "tinyfish");
}
