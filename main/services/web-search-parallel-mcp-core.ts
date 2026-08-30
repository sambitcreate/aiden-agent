/**
 * Pure request/response contract for Parallel's hosted Search MCP service.
 *
 * Transport and credentials stay in the main-process adapter registry.  This
 * module only validates the fixed JSON-RPC envelope and turns the untrusted
 * MCP result into the provider-independent search evidence shape.
 */

export const PARALLEL_MCP_ORIGIN = "https://search.parallel.ai";
export const PARALLEL_MCP_ENDPOINT = `${PARALLEL_MCP_ORIGIN}/mcp`;
/** Compatibility alias used by provider evidence notes. */
export const PARALLEL_MCP_URL = PARALLEL_MCP_ENDPOINT;
export const PARALLEL_MCP_TOOL = "web_search";
export const MAX_PARALLEL_MCP_REQUEST_BYTES = 32 * 1024;
export const MAX_PARALLEL_MCP_RESPONSE_BYTES = 256 * 1024;
export const MAX_PARALLEL_MCP_RESULT_TITLE_BYTES = 512;
export const MAX_PARALLEL_MCP_RESULT_URL_BYTES = 2_048;
export const MAX_PARALLEL_MCP_RESULT_TEXT_BYTES = 4_096;

const MAX_QUERY_CHARACTERS = 2_000;
const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_API_KEY_BYTES = 8 * 1_024;
const MAX_RESULTS = 10;
const MAX_SSE_EVENTS = 64;
const JSON_RPC_ID = 1;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_CHARACTERS_GLOBAL = /\p{Cc}/gu;

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

export type ParallelMcpErrorCategory =
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "upstream"
  | "network"
  | "timeout"
  | "cancelled"
  | "policy"
  | "invalid_response";

export interface ParallelMcpErrorContract {
  providerId: "parallel-mcp";
  category: ParallelMcpErrorCategory;
  fallbackEligible: boolean;
  message: string;
}

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

type JsonRecord = Record<string, unknown>;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function responseBytes(body: string | Uint8Array): number {
  return typeof body === "string" ? utf8ByteLength(body) : body.byteLength;
}

function sliceUtf8(value: string, maximum: number): string {
  if (utf8ByteLength(value) <= maximum) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > maximum) break;
    result += character;
    used += bytes;
  }
  return result;
}

function closedError(category: ParallelMcpErrorCategory): ParallelMcpErrorContract {
  const fallbackEligible =
    category === "rate_limit" ||
    category === "upstream" ||
    category === "network" ||
    category === "timeout" ||
    category === "invalid_response";
  const messages: Record<ParallelMcpErrorCategory, string> = {
    invalid_request: "Parallel MCP rejected the search request.",
    authentication: "Parallel MCP authentication failed.",
    rate_limit: "Parallel MCP search is temporarily rate limited.",
    upstream: "Parallel MCP search is temporarily unavailable.",
    network: "Parallel MCP search could not reach the provider.",
    timeout: "Parallel MCP search timed out.",
    cancelled: "Parallel MCP search was cancelled.",
    policy: "Parallel MCP search was blocked by the network policy.",
    invalid_response: "Parallel MCP returned an invalid response.",
  };
  return Object.freeze({
    providerId: "parallel-mcp",
    category,
    fallbackEligible,
    message: messages[category],
  });
}

function normalizedQuery(value: unknown): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new Error(closedError("invalid_request").message);
  }
  const query = value.trim();
  if (!query || codePointLength(query) > MAX_QUERY_CHARACTERS) {
    throw new Error(closedError("invalid_request").message);
  }
  return query;
}

function normalizedResultCount(value: number | undefined): number {
  const count = value ?? 5;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RESULTS) {
    throw new Error(closedError("invalid_request").message);
  }
  return count;
}

function normalizedApiKey(value: unknown): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new Error(closedError("authentication").message);
  }
  const key = value.trim();
  if (
    !key ||
    codePointLength(key) > MAX_API_KEY_CHARACTERS ||
    utf8ByteLength(key) > MAX_API_KEY_BYTES
  ) {
    throw new Error(closedError("authentication").message);
  }
  return key;
}

/** Build Parallel's fixed-origin JSON-RPC Search MCP request. */
export function buildParallelMcpRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  credential: ParallelMcpCredential,
): ParallelMcpRequestContract {
  const query = normalizedQuery(queryValue);
  // The MCP tool does not expose a stable count field; validate the local
  // projection bound and cap the returned sources after parsing instead.
  normalizedResultCount(numResultsValue);
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (credential?.mode === "api-key") {
    headers.Authorization = `Bearer ${normalizedApiKey(credential.apiKey)}`;
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
  if (responseBytes(body) > MAX_PARALLEL_MCP_REQUEST_BYTES) {
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
  if (typeof status !== "number" || !Number.isSafeInteger(status)) {
    return closedError("invalid_response");
  }
  if (status < 100 || status > 599) return closedError("invalid_response");
  if (status >= 300 && status < 400) return closedError("policy");
  if (status === 401 || status === 403) return closedError("authentication");
  if (status === 408) return closedError("timeout");
  if (status === 429) return closedError("rate_limit");
  if (status >= 400 && status < 500) return closedError("invalid_request");
  if (status >= 500) return closedError("upstream");
  return closedError("invalid_response");
}

export function parallelMcpTransportError(kind: unknown): ParallelMcpErrorContract {
  if (kind === "redirect") return closedError("policy");
  if (kind === "network" || kind === "timeout" || kind === "cancelled") {
    return closedError(kind);
  }
  return closedError("invalid_response");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeResponseBody(body: unknown): string | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  if (responseBytes(body) > MAX_PARALLEL_MCP_RESPONSE_BYTES) return undefined;
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function jsonRpcCandidatesFromSse(body: string): unknown[] | undefined {
  const candidates: unknown[] = [];
  let dataLines: string[] = [];
  let eventCount = 0;

  const flush = () => {
    if (dataLines.length === 0) return;
    eventCount += 1;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // Invalid events cannot suppress a later valid event, but never escape.
    }
  };

  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.length === 0) {
      flush();
      if (eventCount > MAX_SSE_EVENTS) return undefined;
      continue;
    }
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return eventCount > MAX_SSE_EVENTS ? undefined : candidates;
}

function jsonRpcCandidates(body: string, contentType?: string): unknown[] | undefined {
  const mediaType =
    typeof contentType === "string"
      ? contentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
  if (
    mediaType !== undefined &&
    mediaType !== "application/json" &&
    mediaType !== "text/event-stream"
  ) {
    return undefined;
  }
  if (mediaType === "text/event-stream" || /^\s*(?:data:|event:|:)/u.test(body)) {
    return jsonRpcCandidatesFromSse(body);
  }
  try {
    return [JSON.parse(body)];
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  return sliceUtf8(normalized, maximum);
}

function safeResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return undefined;
  const url = value.trim();
  if (!url || utf8ByteLength(url) > MAX_PARALLEL_MCP_RESULT_URL_BYTES) return undefined;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return url;
}

function resultFromRecord(value: unknown, index: number): ParallelMcpResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = safeResultUrl(value.url);
  if (!url) return undefined;
  const excerpts = Array.isArray(value.excerpts)
    ? value.excerpts.filter((entry): entry is string => typeof entry === "string").join(" ")
    : "";
  const textValue = value.text ?? value.snippet ?? value.content ?? excerpts;
  return {
    title: boundedText(value.title, MAX_PARALLEL_MCP_RESULT_TITLE_BYTES) || `Source ${index + 1}`,
    url,
    text: boundedText(textValue, MAX_PARALLEL_MCP_RESULT_TEXT_BYTES),
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

function parseFormattedResults(
  content: string,
  maximumResults: number,
): ParallelMcpResult[] | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/(?=^Title:\s*)/gmu);
  const results: ParallelMcpResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.*)$/mu)?.[1] ?? "";
    const rawUrl = block.match(/^URL:\s*(.*)$/mu)?.[1];
    const url = safeResultUrl(rawUrl);
    if (!url) continue;
    const contentHeader = /^(?:Text|Highlights|Excerpt):[ \t]*(.*?)(?:\n|$)/mu.exec(block);
    let resultText = contentHeader?.[1] ?? "";
    if (contentHeader?.index !== undefined) {
      const contentStart = contentHeader.index + contentHeader[0].length;
      const remainder = block.slice(contentStart);
      const separator = remainder.search(/\n---[ \t]*(?:\n|$)/u);
      const trailingText = separator >= 0 ? remainder.slice(0, separator) : remainder;
      resultText = resultText ? `${resultText}\n${trailingText}` : trailingText;
    }
    results.push({
      title:
        boundedText(title, MAX_PARALLEL_MCP_RESULT_TITLE_BYTES) || `Source ${results.length + 1}`,
      url,
      text: boundedText(resultText, MAX_PARALLEL_MCP_RESULT_TEXT_BYTES),
    });
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
  return parseFormattedResults(value, maximumResults);
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
  maximumResults = MAX_RESULTS,
): ParallelMcpParseOutcome {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > MAX_RESULTS) {
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
  const body = decodeResponseBody(response?.body);
  if (body === undefined) return { ok: false, error: closedError("invalid_response") };
  const candidates = jsonRpcCandidates(body, response.contentType);
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

/** Descriptive aliases for generic Web Search callers. */
export const buildParallelMcpWebSearchRequest = buildParallelMcpRequest;
export const parseParallelMcpWebSearchResponse = parseParallelMcpResponse;
