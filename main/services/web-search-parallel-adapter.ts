/** Parallel Search REST API adapter (API-key mode only). */

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

export const PARALLEL_WEB_SEARCH_ORIGIN = "https://api.parallel.ai";
export const PARALLEL_WEB_SEARCH_ENDPOINT = `${PARALLEL_WEB_SEARCH_ORIGIN}/v1/search`;

export interface ParallelWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type ParallelWebSearchCredential = ParallelWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput(
    "parallel",
    queryValue,
    numResultsValue,
  );
  const apiKey = extractWebSearchApiKeyCredential("parallel", credential);
  return freezeWebSearchJsonRequest({
    url: PARALLEL_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      objective: query,
      search_queries: [query],
      advanced_settings: {
        max_results: numResults,
      },
    }),
  });
}

/** Build the fixed-origin Parallel REST request without performing I/O. */
export function buildParallelWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: ParallelWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

function excerptsText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n\n");
}

/** Parse Parallel's `{ results: [{ url, title, excerpts }] }` response. */
export function parseParallelWebSearchResponse(
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
    text: excerptsText(item.excerpts),
  }));
}

const PARALLEL_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "parallel",
  endpoint: PARALLEL_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "parallel");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseParallelWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createParallelWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(PARALLEL_DEFINITION, options);
}

export const parallelWebSearchAdapterFactory = createParallelWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireParallelWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "parallel");
}
