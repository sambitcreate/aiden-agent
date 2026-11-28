/**
 * Pure request/response contract for Parallel's hosted Search MCP service.
 *
 * Transport and credentials stay in the main-process adapter registry.  This
 * module only validates the fixed JSON-RPC envelope and turns the untrusted
 * MCP result into the provider-independent search evidence shape.
 */

import {
  WEB_SEARCH_RESULTS_MAX_COUNT,
  boundWebSearchText,
  createWebSearchCoreError,
  decodeWebSearchBody,
  isRecord,
  isValidWebSearchResultCount,
  mapWebSearchCoreHttpError,
  mapWebSearchCoreTransportError,
  parseWebSearchFormattedResults,
  parseWebSearchMcpCandidates,
  requireWebSearchCoreApiKey,
  requireWebSearchCoreQuery,
  requireWebSearchCoreResultCount,
  validateWebSearchResultUrl,
  webSearchBodyByteLength,
  type WebSearchCoreErrorCategory,
  type WebSearchCoreErrorContract,
} from "./web-search-adapter-kit.js";

export const PARALLEL_MCP_ORIGIN = "https://search.parallel.ai";
export const PARALLEL_MCP_ENDPOINT = `${PARALLEL_MCP_ORIGIN}/mcp`;
export const PARALLEL_MCP_TOOL = "web_search";
export const MAX_PARALLEL_MCP_REQUEST_BYTES = 32 * 1024;
export const MAX_PARALLEL_MCP_RESPONSE_BYTES = 256 * 1024;
export const MAX_PARALLEL_MCP_RESULT_TITLE_BYTES = 512;
export const MAX_PARALLEL_MCP_RESULT_URL_BYTES = 2_048;
export const MAX_PARALLEL_MCP_RESULT_TEXT_BYTES = 4_096;

const PARALLEL_MCP_LABEL = "Parallel MCP";
const JSON_RPC_ID = 1;

export type ParallelMcpCredential = { mode: "anonymous" } | { mode: "api-key"; apiKey: string };

export interface ParallelMcpRequestContract {
  url: typeof PARALLEL_MCP_ENDPOINT;
  init: {
    method: "POST";
    redirect: "error";
    credentials: "omit";
    cache: "no-store";
    referrerPolicy: "no-referrer";
    headers: Readonly<Record<string, string>>;
    body: string;
  };
}

export type ParallelMcpErrorCategory = WebSearchCoreErrorCategory;

export type ParallelMcpErrorContract = WebSearchCoreErrorContract<"parallel-mcp">;

export interface ParallelMcpResult {
  title: string;
  url: string;
  text: string;
}

export interface ParallelMcpEvidence {
  providerId: "parallel-mcp";
  trust: "untrusted-web-evidence";
  results: ParallelMcpResult[];
}

export type ParallelMcpParseOutcome =
  | { ok: true; value: ParallelMcpEvidence }
  | { ok: false; error: ParallelMcpErrorContract };

export interface ParallelMcpResponseContract {
  status: number;
  body: string | Uint8Array;
  contentType?: string;
}

function closedError(category: ParallelMcpErrorCategory): ParallelMcpErrorContract {
  return createWebSearchCoreError("parallel-mcp", PARALLEL_MCP_LABEL, category);
}

/** Build Parallel's fixed-origin JSON-RPC Search MCP request. */
export function buildParallelMcpRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  credential: ParallelMcpCredential,
): ParallelMcpRequestContract {
  const query = requireWebSearchCoreQuery(queryValue, "parallel-mcp", PARALLEL_MCP_LABEL);
  // The MCP tool does not expose a stable count field; validate the local
  // projection bound and cap the returned sources after parsing instead.
  requireWebSearchCoreResultCount(numResultsValue, "parallel-mcp", PARALLEL_MCP_LABEL);
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (credential?.mode === "api-key") {
    headers.Authorization = `Bearer ${requireWebSearchCoreApiKey(
      credential.apiKey,
      "parallel-mcp",
      PARALLEL_MCP_LABEL,
    )}`;
  } else if (credential?.mode !== "anonymous") {
    throw new Error(closedError("authentication").message);
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: JSON_RPC_ID,
    method: "tools/call",
    params: {
      name: PARALLEL_MCP_TOOL,
      arguments: {
        objective: query,
        search_queries: [query],
      },
    },
  });
  if (webSearchBodyByteLength(body) > MAX_PARALLEL_MCP_REQUEST_BYTES) {
    throw new Error(closedError("invalid_request").message);
  }
  return Object.freeze({
    url: PARALLEL_MCP_ENDPOINT,
    init: Object.freeze({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: Object.freeze(headers),
      body,
    }),
  });
}

export function parallelMcpHttpError(status: unknown): ParallelMcpErrorContract {
  return mapWebSearchCoreHttpError("parallel-mcp", PARALLEL_MCP_LABEL, status);
}

export function parallelMcpTransportError(kind: unknown): ParallelMcpErrorContract {
  return mapWebSearchCoreTransportError("parallel-mcp", PARALLEL_MCP_LABEL, kind);
}

function resultFromRecord(value: unknown, index: number): ParallelMcpResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = validateWebSearchResultUrl(value.url, MAX_PARALLEL_MCP_RESULT_URL_BYTES);
  if (!url) return undefined;
  const excerpts = Array.isArray(value.excerpts)
    ? value.excerpts.filter((entry): entry is string => typeof entry === "string").join(" ")
    : "";
  const textValue = value.text ?? value.snippet ?? value.content ?? excerpts;
  return {
    title:
      boundWebSearchText(value.title, MAX_PARALLEL_MCP_RESULT_TITLE_BYTES) || `Source ${index + 1}`,
    url,
    text: boundWebSearchText(textValue, MAX_PARALLEL_MCP_RESULT_TEXT_BYTES),
  };
}

function parseObjectResults(
  value: unknown,
  maximumResults: number,
): ParallelMcpResult[] | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.data) ? value.data : value;
  const rawResults = nested.results;
  if (!Array.isArray(rawResults)) return undefined;
  const results: ParallelMcpResult[] = [];
  for (const [index, item] of rawResults.entries()) {
    const result = resultFromRecord(item, index);
    if (result) results.push(result);
    if (results.length >= maximumResults) break;
  }
  return results.length > 0 ? results : undefined;
}

function parsePayload(value: unknown, maximumResults: number): ParallelMcpResult[] | undefined {
  const objectResults = parseObjectResults(value, maximumResults);
  if (objectResults) return objectResults;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    const parsedResults = parseObjectResults(parsed, maximumResults);
    if (parsedResults) return parsedResults;
  } catch {
    // Parallel MCP may return a human-readable result block in text content.
  }
  return parseWebSearchFormattedResults(value, {
    maximumResults,
    maxTitle: MAX_PARALLEL_MCP_RESULT_TITLE_BYTES,
    maxUrl: MAX_PARALLEL_MCP_RESULT_URL_BYTES,
    maxText: MAX_PARALLEL_MCP_RESULT_TEXT_BYTES,
    allowExcerptHeader: true,
  });
}

function rpcPayload(
  candidate: unknown,
):
  | { kind: "error"; category: ParallelMcpErrorCategory }
  | { kind: "payload"; payload: unknown }
  | undefined {
  if (!isRecord(candidate) || candidate.jsonrpc !== "2.0" || candidate.id !== JSON_RPC_ID) {
    return undefined;
  }
  if (isRecord(candidate.error)) return { kind: "error", category: "upstream" };
  if (!isRecord(candidate.result)) return undefined;
  if (candidate.result.isError === true) return { kind: "error", category: "upstream" };
  if (
    Object.prototype.hasOwnProperty.call(candidate.result, "structuredContent") &&
    candidate.result.structuredContent !== undefined &&
    candidate.result.structuredContent !== null
  ) {
    return { kind: "payload", payload: candidate.result.structuredContent };
  }
  const content = candidate.result.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find(
    (entry) =>
      isRecord(entry) &&
      entry.type === "text" &&
      typeof entry.text === "string" &&
      entry.text.trim(),
  );
  return text && isRecord(text) ? { kind: "payload", payload: text.text } : undefined;
}

/** Parse one bounded Parallel Search MCP response without exposing raw data. */
export function parseParallelMcpResponse(
  response: ParallelMcpResponseContract,
  maximumResults = WEB_SEARCH_RESULTS_MAX_COUNT,
): ParallelMcpParseOutcome {
  if (!isValidWebSearchResultCount(maximumResults)) {
    return { ok: false, error: closedError("invalid_request") };
  }
  if (
    typeof response?.status !== "number" ||
    !Number.isSafeInteger(response.status) ||
    response.status < 200 ||
    response.status >= 300
  ) {
    return {
      ok: false,
      error: parallelMcpHttpError(response?.status),
    };
  }
  const body = decodeWebSearchBody(response?.body, MAX_PARALLEL_MCP_RESPONSE_BYTES);
  if (body === undefined) return { ok: false, error: closedError("invalid_response") };
  const candidates = parseWebSearchMcpCandidates(body, response.contentType);
  if (!candidates) return { ok: false, error: closedError("invalid_response") };
  for (const candidate of candidates) {
    const payload = rpcPayload(candidate);
    if (!payload) continue;
    if (payload.kind === "error") return { ok: false, error: closedError(payload.category) };
    const results = parsePayload(payload.payload, maximumResults);
    if (results) {
      return {
        ok: true,
        value: {
          providerId: "parallel-mcp",
          trust: "untrusted-web-evidence",
          results,
        },
      };
    }
  }
  return { ok: false, error: closedError("invalid_response") };
}
