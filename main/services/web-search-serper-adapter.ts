/** Serper Google Search API web-search adapter (API-key mode only). */

import { isRecord } from "./web-search-adapter-kit.js";
import {
  collectUniqueWebSearchResults,
  createWebSearchJsonAdapter,
  extractWebSearchApiKeyCredential,
  freezeWebSearchJsonRequest,
  isValidWebSearchResultCount,
  normalizeWebSearchJsonInput,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import type { WebSearchAdapter, WebSearchAdapterRequest } from "./web-search-provider-registry.js";
import { webSearchError } from "./web-search-core.js";

/** Serper's reviewed hosted API origin. */
export const SERPER_WEB_SEARCH_ORIGIN = "https://google.serper.dev";
export const SERPER_WEB_SEARCH_ENDPOINT = `${SERPER_WEB_SEARCH_ORIGIN}/search`;

export interface SerperWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type SerperWebSearchCredential = SerperWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("serper", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("serper", credential);
  return freezeWebSearchJsonRequest({
    url: SERPER_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: numResults }),
  });
}

/** Build the fixed-origin Serper request without performing I/O. */
export function buildSerperWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: SerperWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Serper's `{ organic: [...] }` JSON envelope into source evidence. */
export function parseSerperWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !isValidWebSearchResultCount(maximumResults) ||
    !isRecord(payload) ||
    !Array.isArray(payload.organic)
  ) {
    return undefined;
  }

  return collectUniqueWebSearchResults(
    payload.organic,
    maximumResults,
    (item) => ({
      title: item.title,
      text: item.snippet,
    }),
    (item) => item.link,
  );
}

const SERPER_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "serper",
  endpoint: SERPER_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "serper");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseSerperWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createSerperWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(SERPER_DEFINITION, options);
}

export const serperWebSearchAdapterFactory = createSerperWebSearchAdapter;
