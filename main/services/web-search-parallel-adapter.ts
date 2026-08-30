/** Parallel Search REST API adapter (API-key mode only). */

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

export const PARALLEL_WEB_SEARCH_ORIGIN = "https://api.parallel.ai";
export const PARALLEL_WEB_SEARCH_ENDPOINT = `${PARALLEL_WEB_SEARCH_ORIGIN}/v1/search`;

export interface ParallelWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type ParallelWebSearchCredential = ParallelWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("parallel", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("parallel", value.apiKey);
  }
  throw webSearchError("auth", "parallel");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({
    objective: query,
    search_queries: [query],
    advanced_settings: {
      max_results: numResults,
    },
  });
  return Object.freeze({
    url: PARALLEL_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
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
    "parallel",
    queryValue,
    numResultsValue,
  );
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin Parallel REST request without performing I/O. */
export function buildParallelWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: ParallelWebSearchCredential,
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
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 10 ||
    !isRecord(payload) ||
    !Array.isArray(payload.results)
  ) {
    return undefined;
  }

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
      text: excerptsText(item.excerpts),
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
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
