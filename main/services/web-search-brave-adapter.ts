/** Brave Search web-search adapter (API-key mode only). */

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

export const BRAVE_WEB_SEARCH_ORIGIN = "https://api.search.brave.com";
export const BRAVE_WEB_SEARCH_ENDPOINT = `${BRAVE_WEB_SEARCH_ORIGIN}/res/v1/web/search`;
export const BRAVE_WEB_SEARCH_QUERY_MAX_CHARS = 400;
export const BRAVE_WEB_SEARCH_QUERY_MAX_WORDS = 50;

export interface BraveWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type BraveWebSearchCredential = BraveWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("brave", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("brave", value.apiKey);
  }
  throw webSearchError("auth", "brave");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  if (
    Array.from(query).length > BRAVE_WEB_SEARCH_QUERY_MAX_CHARS ||
    query.split(/\s+/u).length > BRAVE_WEB_SEARCH_QUERY_MAX_WORDS
  ) {
    throw webSearchError("invalid-request", "brave");
  }
  const url = new URL(BRAVE_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  return Object.freeze({
    url: url.toString(),
    init: Object.freeze({
      method: "GET" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      }),
    }),
  });
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("brave", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin Brave request without performing I/O. */
export function buildBraveWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: BraveWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

function normalizedSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
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

/** Parse Brave's `{ web: { results: [...] } }` JSON envelope. */
export function parseBraveWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  // Brave documents `web` as nullable for a successful search with no web
  // matches. Preserve that valid empty result set while rejecting an absent
  // or incorrectly typed envelope.
  if (payload.web === null) return { results: [] };
  if (!isRecord(payload.web) || !Array.isArray(payload.web.results)) return undefined;

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.web.results) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title,
      url,
      text: item.description ?? item.snippet,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

const BRAVE_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "brave",
  endpoint: BRAVE_WEB_SEARCH_ENDPOINT,
  allowQuery: true,
  buildRequest: (request: WebSearchAdapterRequest) =>
    buildRequestValues(request.query, request.numResults, request.credential),
  parse: parseBraveWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createBraveWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(BRAVE_DEFINITION, options);
}

export const braveWebSearchAdapterFactory = createBraveWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireBraveWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "brave");
}
