/** Jina Search Foundation API adapter (API-key mode only). */

import { isRecord } from "./web-search-adapter-kit.js";
import {
  collectUniqueWebSearchResults,
  createWebSearchJsonAdapter,
  extractWebSearchApiKeyCredential,
  freezeWebSearchJsonRequest,
  isValidWebSearchResultCount,
  mapWebSearchJsonHttpError,
  normalizeWebSearchJsonInput,
  requireWebSearchApiKey,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import { webSearchError } from "./web-search-core.js";
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

/** Build the fixed-origin Jina Search request without performing I/O. */
export function buildJinaWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: JinaWebSearchCredential,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("jina", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("jina", credential);
  const url = new URL(encodeURIComponent(query), JINA_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("count", String(numResults));
  return freezeWebSearchJsonRequest({
    url: url.toString(),
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Respond-With": "no-content",
      "X-Retain-Images": "none",
    },
  });
}

function mapJinaItems(
  items: readonly unknown[],
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } {
  return collectUniqueWebSearchResults(items, maximumResults, (item) => ({
    title: item.title,
    text: item.description ?? item.content,
  }));
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
  if (!isValidWebSearchResultCount(maximumResults)) return undefined;
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

const JINA_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "jina",
  endpoint: JINA_WEB_SEARCH_ENDPOINT,
  allowQuery: true,
  allowOriginScopedPath: true,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "jina");
    }
    return buildJinaWebSearchRequest(request.query, request.numResults, request.credential);
  },
  parse: parseJinaWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createJinaWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(JINA_DEFINITION, options);
}

export const jinaWebSearchAdapterFactory = createJinaWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireJinaWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "jina");
}

export type { WebSearchFetch };
