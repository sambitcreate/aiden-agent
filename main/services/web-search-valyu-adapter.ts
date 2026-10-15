/** Valyu hosted web-search adapter (API-key mode only). */

import { isRecord, normalizeWebSearchSourceUrl } from "./web-search-adapter-kit.js";
import {
  createWebSearchJsonAdapter,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import type { WebSearchAdapter, WebSearchAdapterRequest } from "./web-search-provider-registry.js";
import { webSearchError } from "./web-search-core.js";

/** Valyu's reviewed hosted API origin and Search API endpoint. */
export const VALYU_WEB_SEARCH_ORIGIN = "https://api.valyu.ai";
export const VALYU_WEB_SEARCH_ENDPOINT = `${VALYU_WEB_SEARCH_ORIGIN}/v1/search`;

export interface ValyuWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type ValyuWebSearchCredential = ValyuWebSearchApiKeyCredential | string;

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("valyu", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("valyu", value.apiKey);
  }
  throw webSearchError("auth", "valyu");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({
    query,
    max_num_results: numResults,
    // Keep this adapter on public web sources; the Valyu default also searches
    // proprietary sources and can incur a different cost profile.
    search_type: "web",
  });
  return Object.freeze({
    url: VALYU_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      }),
      body,
    }),
  });
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: ValyuWebSearchCredential,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("valyu", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin Valyu request without performing I/O. */
export function buildValyuWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: ValyuWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Valyu's successful Search API envelope into source evidence. */
export function parseValyuWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 10 ||
    !isRecord(payload) ||
    payload.success !== true ||
    !Array.isArray(payload.results)
  ) {
    return undefined;
  }

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.results) {
    if (!isRecord(item)) continue;
    const url = normalizeWebSearchSourceUrl(item.url);
    if (!url || seen.has(url) || typeof item.title !== "string") continue;
    const text =
      typeof item.content === "string"
        ? item.content
        : typeof item.description === "string"
          ? item.description
          : "";
    seen.add(url);
    results.push({ title: item.title, url, text });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

const VALYU_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "valyu",
  endpoint: VALYU_WEB_SEARCH_ENDPOINT,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "valyu");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseValyuWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createValyuWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(VALYU_DEFINITION, options);
}

export const valyuWebSearchAdapterFactory = createValyuWebSearchAdapter;
