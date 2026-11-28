/** Kagi Search API web-search adapter (API-key mode only). */

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

/** Kagi's reviewed hosted API origin. */
export const KAGI_WEB_SEARCH_ORIGIN = "https://kagi.com";
export const KAGI_WEB_SEARCH_ENDPOINT = `${KAGI_WEB_SEARCH_ORIGIN}/api/v1/search`;

export interface KagiWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type KagiWebSearchCredential = KagiWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("kagi", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("kagi", credential);
  return freezeWebSearchJsonRequest({
    url: KAGI_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit: numResults }),
  });
}

/** Build the fixed-origin Kagi request without performing I/O. */
export function buildKagiWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: KagiWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Kagi's v1 `{ data: { search: [...] } }` JSON envelope. */
export function parseKagiWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !isValidWebSearchResultCount(maximumResults) ||
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.search)
  ) {
    return undefined;
  }

  return collectUniqueWebSearchResults(payload.data.search, maximumResults, (item) => ({
    title: item.title,
    text: item.snippet,
  }));
}

const KAGI_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "kagi",
  endpoint: KAGI_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "kagi");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseKagiWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createKagiWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(KAGI_DEFINITION, options);
}

export const kagiWebSearchAdapterFactory = createKagiWebSearchAdapter;
