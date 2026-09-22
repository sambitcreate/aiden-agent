/** XCrawl hosted web-search adapter (API-key mode only). */

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

/** XCrawl's reviewed hosted API origin and Search API endpoint. */
export const XCRAWL_WEB_SEARCH_ORIGIN = "https://run.xcrawl.com";
export const XCRAWL_WEB_SEARCH_ENDPOINT = `${XCRAWL_WEB_SEARCH_ORIGIN}/v1/search`;

export interface XCrawlWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type XCrawlWebSearchCredential = XCrawlWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("xcrawl", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("xcrawl", value.apiKey);
  }
  throw webSearchError("auth", "xcrawl");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({ query, limit: numResults });
  return Object.freeze({
    url: XCRAWL_WEB_SEARCH_ENDPOINT,
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
  credential: XCrawlWebSearchCredential,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("xcrawl", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin XCrawl request without performing I/O. */
export function buildXCrawlWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: XCrawlWebSearchCredential,
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
 * Parse XCrawl's completed Search API envelope.  Search metadata and credit
 * accounting remain provider-local; only source evidence crosses the shared
 * result boundary.
 */
export function parseXCrawlWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 10 ||
    !isRecord(payload) ||
    payload.endpoint !== "search" ||
    payload.status !== "completed" ||
    !isRecord(payload.data) ||
    payload.data.status !== "success" ||
    !Array.isArray(payload.data.data)
  ) {
    return undefined;
  }

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.data.data) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    const title = typeof item.title === "string" && item.title.trim() ? item.title : url;
    const text = typeof item.description === "string" ? item.description : "";
    seen.add(url);
    results.push({ title, url, text });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

const XCRAWL_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "xcrawl",
  endpoint: XCRAWL_WEB_SEARCH_ENDPOINT,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "xcrawl");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseXCrawlWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createXCrawlWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(XCRAWL_DEFINITION, options);
}

export const xCrawlWebSearchAdapterFactory = createXCrawlWebSearchAdapter;
export const xcrawlWebSearchAdapterFactory = createXCrawlWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireXCrawlWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "xcrawl");
}
