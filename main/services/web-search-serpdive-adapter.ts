/** SERPdive Search API web-search adapter (API-key mode only). */

import { codePointLength, isRecord } from "./web-search-adapter-kit.js";
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

/** SERPdive's reviewed hosted API origin and fixed v1 search endpoint. */
export const SERPDIVE_WEB_SEARCH_ORIGIN = "https://api.serpdive.com";
export const SERPDIVE_WEB_SEARCH_ENDPOINT = `${SERPDIVE_WEB_SEARCH_ORIGIN}/v1/search`;
export const SERPDIVE_WEB_SEARCH_QUERY_MAX_CHARS = 300;
/** Krill is the documented free/fair-use model and never silently spends credits. */
export const SERPDIVE_WEB_SEARCH_MODEL = "krill";

export interface SerpDiveWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type SerpDiveWebSearchCredential = SerpDiveWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput(
    "serpdive",
    queryValue,
    numResultsValue,
  );
  if (codePointLength(query) > SERPDIVE_WEB_SEARCH_QUERY_MAX_CHARS) {
    throw webSearchError("invalid-request", "serpdive");
  }
  const apiKey = extractWebSearchApiKeyCredential("serpdive", credential);
  return freezeWebSearchJsonRequest({
    url: SERPDIVE_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      model: SERPDIVE_WEB_SEARCH_MODEL,
      max_results: numResults,
    }),
  });
}

/** Build the fixed-origin SERPdive request without performing I/O. */
export function buildSerpDiveWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: SerpDiveWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

function businessErrorKind(
  value: unknown,
): "auth" | "invalid-request" | "quota" | "transient" | "invalid-response" {
  if (typeof value !== "string") return "invalid-response";
  switch (value.trim().toLowerCase()) {
    case "invalid_json":
    case "missing_query":
      return "invalid-request";
    case "missing_api_key":
    case "invalid_api_key":
      return "auth";
    case "rate_limit_exceeded":
    case "monthly_quota_exceeded":
    case "key_limit_exceeded":
    case "too_many_concurrent_requests":
      return "quota";
    case "search_failed":
    case "server_busy":
      return "transient";
    default:
      return "invalid-response";
  }
}

/** Parse SERPdive's `{ results: [{ url, title, content }] }` response. */
export function parseSerpDiveWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!isValidWebSearchResultCount(maximumResults) || !isRecord(payload)) return undefined;
  if (payload.error !== undefined && payload.error !== null) {
    throw webSearchError(businessErrorKind(payload.error), "serpdive");
  }
  if (!Array.isArray(payload.results)) return undefined;

  return collectUniqueWebSearchResults(payload.results, maximumResults, (item) => ({
    title: item.title,
    text: item.content ?? item.snippet,
  }));
}

const SERPDIVE_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "serpdive",
  endpoint: SERPDIVE_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "serpdive");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseSerpDiveWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createSerpDiveWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(SERPDIVE_DEFINITION, options);
}

export const serpDiveWebSearchAdapterFactory = createSerpDiveWebSearchAdapter;
