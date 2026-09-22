/** SERPdive Search API web-search adapter (API-key mode only). */

import {
  createWebSearchJsonAdapter,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  requireWebSearchApiKey,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("serpdive", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("serpdive", value.apiKey);
  }
  throw webSearchError("auth", "serpdive");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({
    query,
    model: SERPDIVE_WEB_SEARCH_MODEL,
    max_results: numResults,
  });
  return Object.freeze({
    url: SERPDIVE_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      }),
      body,
    }),
  });
}

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
  if (Array.from(query).length > SERPDIVE_WEB_SEARCH_QUERY_MAX_CHARS) {
    throw webSearchError("invalid-request", "serpdive");
  }
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin SERPdive request without performing I/O. */
export function buildSerpDiveWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: SerpDiveWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

function normalizedSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
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
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  if (payload.error !== undefined && payload.error !== null) {
    throw webSearchError(businessErrorKind(payload.error), "serpdive");
  }
  if (!Array.isArray(payload.results)) return undefined;

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.results) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title,
      url,
      text: item.content ?? item.snippet,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
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

// Keep the provider's display-name casing available to main-only integrations
// that use the API's SERPdive spelling.
export const createSERPdiveWebSearchAdapter = createSerpDiveWebSearchAdapter;
export const createSerpdiveWebSearchAdapter = createSerpDiveWebSearchAdapter;
export const serpdiveWebSearchAdapterFactory = createSerpDiveWebSearchAdapter;
export const buildSERPdiveWebSearchRequest = buildSerpDiveWebSearchRequest;
export const buildSerpdiveWebSearchRequest = buildSerpDiveWebSearchRequest;
export const parseSERPdiveWebSearchResponse = parseSerpDiveWebSearchResponse;
export const parseSerpdiveWebSearchResponse = parseSerpDiveWebSearchResponse;

/** Validate the provider request credential at a call site without I/O. */
export function requireSerpDiveWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "serpdive");
}

export const requireSERPdiveWebSearchApiKey = requireSerpDiveWebSearchApiKey;
export const requireSerpdiveWebSearchApiKey = requireSerpDiveWebSearchApiKey;
