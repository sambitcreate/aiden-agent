/** OpenAI Responses API web-search adapter (API-key or explicit bound-auth mode). */

import {
  createWebSearchJsonAdapter,
  normalizeWebSearchJsonInput,
  normalizeWebSearchApiKey,
  requireWebSearchApiKey,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import type { WebSearchAdapter, WebSearchAdapterRequest } from "./web-search-provider-registry.js";
import { webSearchError } from "./web-search-core.js";
import type { WebSearchResolvedExistingAuth } from "./web-search-auth-reuse.js";

export const OPENAI_WEB_SEARCH_ORIGIN = "https://api.openai.com";
export const OPENAI_WEB_SEARCH_ENDPOINT = `${OPENAI_WEB_SEARCH_ORIGIN}/v1/responses`;
export const OPENAI_WEB_SEARCH_MODEL = "gpt-5.6";

export interface OpenAIWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type OpenAIWebSearchCredential = OpenAIWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMaximumResults(maximumResults: number): boolean {
  return Number.isSafeInteger(maximumResults) && maximumResults >= 1 && maximumResults <= 10;
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("openai", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("openai", value.apiKey);
  }
  throw webSearchError("auth", "openai");
}

function requestContract(
  body: string,
  headers: Readonly<Record<string, string>>,
): WebSearchJsonRequestContract {
  return Object.freeze({
    url: OPENAI_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({ ...headers }),
      body,
    }),
  });
}

function modelId(value: unknown): string {
  if (typeof value !== "string") throw webSearchError("config", "openai");
  const normalized = value.trim();
  if (
    !normalized ||
    /\p{Cc}/u.test(normalized) ||
    Array.from(normalized).length > 256 ||
    new TextEncoder().encode(normalized).byteLength > 1_024
  ) {
    throw webSearchError("config", "openai");
  }
  return normalized;
}

function verifiedExistingAuth(value: WebSearchResolvedExistingAuth | undefined): {
  readonly modelId: string;
  readonly apiKey: string;
  readonly headers: Readonly<Record<string, string>>;
} {
  if (
    !value ||
    value.targetProviderId !== "openai" ||
    value.sourceProviderId !== "openai" ||
    value.modelApi !== "openai-responses" ||
    value.endpoint !== OPENAI_WEB_SEARCH_ENDPOINT ||
    !isRecord(value.headers)
  ) {
    throw webSearchError("config", "openai");
  }
  const apiKey = credentialValue(value.credential);
  const headers = value.headers;
  const keys = Object.keys(headers).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "Accept" ||
    keys[1] !== "Authorization" ||
    keys[2] !== "Content-Type" ||
    headers.Accept !== "application/json" ||
    headers.Authorization !== `Bearer ${apiKey}` ||
    headers["Content-Type"] !== "application/json"
  ) {
    throw webSearchError("config", "openai");
  }
  return {
    modelId: modelId(value.modelId),
    apiKey,
    headers,
  };
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
  credentialMode: WebSearchAdapterRequest["credentialMode"] = "api-key",
  existingAuth?: WebSearchResolvedExistingAuth,
): WebSearchJsonRequestContract {
  const { query } = normalizeWebSearchJsonInput("openai", queryValue, numResultsValue);
  const bound =
    credentialMode === "existing-provider-auth" ? verifiedExistingAuth(existingAuth) : undefined;
  if (
    credentialMode !== "existing-provider-auth" &&
    (credentialMode !== "api-key" || existingAuth !== undefined)
  ) {
    throw webSearchError("config", "openai");
  }
  const apiKey = bound?.apiKey ?? credentialValue(credential);
  const selectedModel = bound?.modelId ?? OPENAI_WEB_SEARCH_MODEL;
  const body = JSON.stringify({
    model: selectedModel,
    tools: [{ type: "web_search" }],
    input: query,
    include: ["web_search_call.action.sources"],
    store: false,
  });
  return requestContract(
    body,
    bound?.headers ?? {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  );
}

/** Build the fixed-origin OpenAI request without performing I/O. */
export function buildOpenAIWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: OpenAIWebSearchCredential,
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

function excerptAround(text: unknown, start: unknown, end: unknown): string {
  if (
    typeof text !== "string" ||
    !text ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return "";
  }
  const before = Math.max(0, start - 120);
  const after = Math.min(text.length, end + 120);
  return text
    .slice(before, after)
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

function sourceResult(
  value: unknown,
  fallbackIndex: number,
  text = "",
): WebSearchJsonRawResult | undefined {
  if (!isRecord(value)) return undefined;
  const citation = isRecord(value.url_citation) ? value.url_citation : value;
  const url = normalizedSourceUrl(citation.url ?? citation.source_website_url);
  if (!url) return undefined;
  const title = citation.title;
  const sourceText = citation.text ?? citation.description ?? citation.snippet ?? text;
  return {
    title:
      typeof title === "string" && title.trim().length > 0 ? title : `Source ${fallbackIndex + 1}`,
    url,
    text: sourceText,
  };
}

function sourceGroups(value: Record<string, unknown>): unknown[] {
  const action = isRecord(value.action) ? value.action : undefined;
  return [action?.sources, action?.results, value.sources, value.results];
}

/**
 * Parse the Responses API's `web_search_call` and cited message items. The
 * provider answer itself is intentionally not returned; only bounded source
 * evidence crosses the common Web Search contract.
 */
export function parseOpenAIWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!validMaximumResults(maximumResults) || !isRecord(payload)) return undefined;
  const output = payload.output;
  if (!Array.isArray(output)) return undefined;

  let webSearchCallSeen = false;
  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, text = "") => {
    const result = sourceResult(value, results.length, text);
    if (!result || typeof result.url !== "string") return;
    if (seen.has(result.url)) {
      const previous = results.findIndex((entry) => entry.url === result.url);
      if (
        previous >= 0 &&
        (results[previous]?.text === undefined || results[previous]?.text === "") &&
        typeof result.text === "string" &&
        result.text.length > 0
      ) {
        results[previous] = { ...results[previous], text: result.text };
      }
      return;
    }
    seen.add(result.url);
    results.push(result);
  };

  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "web_search_call") {
      if (item.status === "failed" || item.status === "incomplete") return undefined;
      webSearchCallSeen = true;
      for (const group of sourceGroups(item)) {
        if (!Array.isArray(group)) continue;
        for (const source of group) add(source);
      }
      continue;
    }
    if (item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const text = typeof part.text === "string" ? part.text : "";
      const annotations = part.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
        const citation = isRecord(annotation.url_citation) ? annotation.url_citation : annotation;
        add(citation, excerptAround(text, citation.start_index, citation.end_index));
      }
    }
  }

  if (!webSearchCallSeen) return undefined;
  return { results: results.slice(0, maximumResults) };
}

const OPENAI_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "openai",
  endpoint: OPENAI_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) =>
    buildRequestValues(
      request.query,
      request.numResults,
      request.credential,
      request.credentialMode,
      request.existingAuth,
    ),
  parse: parseOpenAIWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createOpenAIWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(OPENAI_DEFINITION, options);
}

export const openAIWebSearchAdapterFactory = createOpenAIWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireOpenAIWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "openai");
}
