/** AnySearch hosted web-search adapter (anonymous or API-key mode). */

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

/** AnySearch's reviewed hosted API origin and unified search endpoint. */
export const ANYSEARCH_WEB_SEARCH_ORIGIN = "https://api.anysearch.com";
export const ANYSEARCH_WEB_SEARCH_ENDPOINT = `${ANYSEARCH_WEB_SEARCH_ORIGIN}/v1/search`;

export interface AnySearchWebSearchAnonymousCredential {
  readonly mode: "anonymous";
}

export interface AnySearchWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type AnySearchWebSearchCredential =
  | AnySearchWebSearchAnonymousCredential
  | AnySearchWebSearchApiKeyCredential
  | string;

function credentialMode(value: unknown): "anonymous" | "api-key" {
  if (isRecord(value) && value.mode === "anonymous") return "anonymous";
  if (typeof value === "string") return "api-key";
  if (isRecord(value) && value.mode === "api-key") return "api-key";
  throw webSearchError("auth", "anysearch");
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: AnySearchWebSearchCredential,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput(
    "anysearch",
    queryValue,
    numResultsValue,
  );
  const mode = credentialMode(credential);
  return freezeWebSearchJsonRequest({
    url: ANYSEARCH_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(mode === "api-key"
        ? { Authorization: `Bearer ${extractWebSearchApiKeyCredential("anysearch", credential)}` }
        : {}),
    },
    body: JSON.stringify({ query, max_results: numResults }),
  });
}

/** Build the fixed-origin AnySearch request without performing I/O. */
export function buildAnySearchWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: AnySearchWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/**
 * Parse AnySearch's `{ code: 0, data: { results, metadata } }` envelope.
 * Only source fields are retained; request IDs, quota details, and metadata
 * never cross the normalized Web Search result boundary.
 */
export function parseAnySearchWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !isValidWebSearchResultCount(maximumResults) ||
    !isRecord(payload) ||
    payload.code !== 0 ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.results) ||
    !isRecord(payload.data.metadata)
  ) {
    return undefined;
  }

  return collectUniqueWebSearchResults(payload.data.results, maximumResults, (item) => {
    if (typeof item.title !== "string" || typeof item.snippet !== "string") return undefined;
    if (item.content !== undefined && item.content !== null && typeof item.content !== "string") {
      return undefined;
    }
    return { title: item.title, text: item.snippet };
  });
}

const ANYSEARCH_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "anysearch",
  endpoint: ANYSEARCH_WEB_SEARCH_ENDPOINT,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode === "anonymous") {
      return buildRequestValues(request.query, request.numResults, { mode: "anonymous" });
    }
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "anysearch");
    }
    return buildRequestValues(request.query, request.numResults, {
      mode: "api-key",
      apiKey: request.credential,
    });
  },
  parse: parseAnySearchWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createAnySearchWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(ANYSEARCH_DEFINITION, options);
}

export const anySearchWebSearchAdapterFactory = createAnySearchWebSearchAdapter;

/** Validate an API-key request credential at a call site without I/O. */
