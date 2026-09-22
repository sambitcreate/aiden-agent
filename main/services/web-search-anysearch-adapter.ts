/** AnySearch hosted web-search adapter (anonymous or API-key mode). */

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialMode(value: unknown): "anonymous" | "api-key" {
  if (isRecord(value) && value.mode === "anonymous") return "anonymous";
  if (typeof value === "string") return "api-key";
  if (isRecord(value) && value.mode === "api-key") return "api-key";
  throw webSearchError("auth", "anysearch");
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("anysearch", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("anysearch", value.apiKey);
  }
  throw webSearchError("auth", "anysearch");
}

function requestContract(
  query: string,
  numResults: number,
  credential: AnySearchWebSearchCredential,
): WebSearchJsonRequestContract {
  const mode = credentialMode(credential);
  const body = JSON.stringify({ query, max_results: numResults });
  return Object.freeze({
    url: ANYSEARCH_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(mode === "api-key" ? { Authorization: `Bearer ${credentialValue(credential)}` } : {}),
      }),
      body,
    }),
  });
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
  return requestContract(query, numResults, credential);
}

/** Build the fixed-origin AnySearch request without performing I/O. */
export function buildAnySearchWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: AnySearchWebSearchCredential,
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
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 10 ||
    !isRecord(payload) ||
    payload.code !== 0 ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.results) ||
    !isRecord(payload.data.metadata)
  ) {
    return undefined;
  }

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.data.results) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    if (typeof item.title !== "string" || typeof item.snippet !== "string") continue;
    if (item.content !== undefined && item.content !== null && typeof item.content !== "string") {
      continue;
    }
    seen.add(url);
    results.push({ title: item.title, url, text: item.snippet });
    if (results.length >= maximumResults) break;
  }
  return { results };
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
export function requireAnySearchWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "anysearch");
}
