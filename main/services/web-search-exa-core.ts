export const EXA_MCP_ORIGIN = "https://mcp.exa.ai";
export const EXA_MCP_ENDPOINT = `${EXA_MCP_ORIGIN}/mcp?tools=web_search_exa`;
export const EXA_MCP_TOOL = "web_search_exa";
export const MAX_EXA_MCP_REQUEST_BYTES = 32 * 1024;
export const MAX_EXA_MCP_RESPONSE_BYTES = 256 * 1024;
export const MAX_EXA_RESULT_TITLE_CHARACTERS = 300;
export const MAX_EXA_RESULT_URL_CHARACTERS = 2_048;
export const MAX_EXA_RESULT_TEXT_CHARACTERS = 1_200;

const MAX_QUERY_CHARACTERS = 2_000;
const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_API_KEY_BYTES = 8_192;
const MAX_RESULTS = 10;
const MAX_SSE_EVENTS = 64;
const JSON_RPC_ID = 1;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_CHARACTERS_GLOBAL = /\p{Cc}/gu;

export type ExaCredential = { mode: "anonymous" } | { mode: "api-key"; apiKey: string };

export interface ExaMcpRequestContract {
  url: typeof EXA_MCP_ENDPOINT;
  init: {
    method: "POST";
    redirect: "error";
    headers: Readonly<Record<string, string>>;
    body: string;
  };
}

export type ExaMcpErrorCategory =
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "upstream"
  | "network"
  | "timeout"
  | "cancelled"
  | "policy"
  | "invalid_response";

export interface ExaMcpErrorContract {
  providerId: "exa";
  category: ExaMcpErrorCategory;
  fallbackEligible: boolean;
  message: string;
}

export interface ExaMcpResult {
  title: string;
  url: string;
  text: string;
}

export interface ExaMcpEvidence {
  providerId: "exa";
  trust: "untrusted-web-evidence";
  results: ExaMcpResult[];
}

export type ExaMcpParseOutcome =
  | { ok: true; value: ExaMcpEvidence }
  | { ok: false; error: ExaMcpErrorContract };

export interface ExaMcpResponseContract {
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

function sliceCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function closedError(category: ExaMcpErrorCategory): ExaMcpErrorContract {
  const fallbackEligible =
    category === "rate_limit" ||
    category === "upstream" ||
    category === "network" ||
    category === "timeout" ||
    category === "invalid_response";
  const messages: Record<ExaMcpErrorCategory, string> = {
    invalid_request: "Exa rejected the search request.",
    authentication: "Exa authentication failed.",
    rate_limit: "Exa search is temporarily rate limited.",
    upstream: "Exa search is temporarily unavailable.",
    network: "Exa search could not reach the provider.",
    timeout: "Exa search timed out.",
    cancelled: "Exa search was cancelled.",
    policy: "Exa search was blocked by the network policy.",
    invalid_response: "Exa returned an invalid response.",
  };
  return Object.freeze({
    providerId: "exa",
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
  if (query.length === 0 || codePointLength(query) > MAX_QUERY_CHARACTERS) {
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
    key.length === 0 ||
    codePointLength(key) > MAX_API_KEY_CHARACTERS ||
    utf8ByteLength(key) > MAX_API_KEY_BYTES
  ) {
    throw new Error(closedError("authentication").message);
  }
  return key;
}

/**
 * Builds the reviewed hosted-Exa MCP request without performing I/O. The URL,
 * tool name, auth header, and redirect mode are adapter-owned constants.
 */
export function buildExaMcpRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  credential: ExaCredential,
): ExaMcpRequestContract {
  const query = normalizedQuery(queryValue);
  const numResults = normalizedResultCount(numResultsValue);
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (credential?.mode === "api-key") {
    headers["x-api-key"] = normalizedApiKey(credential.apiKey);
  } else if (credential?.mode !== "anonymous") {
    throw new Error(closedError("authentication").message);
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: JSON_RPC_ID,
    method: "tools/call",
    params: {
      name: EXA_MCP_TOOL,
      arguments: { query, numResults },
    },
  });
  if (responseBytes(body) > MAX_EXA_MCP_REQUEST_BYTES) {
    throw new Error(closedError("invalid_request").message);
  }
  return Object.freeze({
    url: EXA_MCP_ENDPOINT,
    init: Object.freeze({
      method: "POST",
      redirect: "error",
      headers: Object.freeze(headers),
      body,
    }),
  });
}

export function exaMcpHttpError(status: unknown): ExaMcpErrorContract {
  if (typeof status !== "number" || !Number.isSafeInteger(status)) {
    return closedError("invalid_response");
  }
  if (status < 100 || status > 599) {
    return closedError("invalid_response");
  }
  if (status >= 300 && status < 400) return closedError("policy");
  if (status === 401 || status === 403) return closedError("authentication");
  if (status === 408) return closedError("timeout");
  if (status === 429) return closedError("rate_limit");
  if (status >= 400 && status < 500) return closedError("invalid_request");
  if (status >= 500) return closedError("upstream");
  return closedError("invalid_response");
}

export function exaMcpTransportError(kind: unknown): ExaMcpErrorContract {
  if (kind === "redirect") return closedError("policy");
  if (kind === "network" || kind === "timeout" || kind === "cancelled") {
    return closedError(kind);
  }
  return closedError("invalid_response");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseBytes(body: string | Uint8Array): number {
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

function decodeResponseBody(body: unknown): string | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  if (responseBytes(body) > MAX_EXA_MCP_RESPONSE_BYTES) return undefined;
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
      // A malformed event does not hide a later, valid JSON-RPC event.
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

function validatedRpcContent(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  if (candidate.jsonrpc !== "2.0" || candidate.id !== JSON_RPC_ID) return undefined;
  if (isRecord(candidate.error)) return undefined;
  if (!isRecord(candidate.result) || candidate.result.isError === true) return undefined;
  const content = candidate.result.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
    ) {
      return item.text;
    }
  }
  return undefined;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  return sliceCodePoints(normalized, maximum);
}

function safeResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return undefined;
  const url = value.trim();
  if (url.length === 0 || codePointLength(url) > MAX_EXA_RESULT_URL_CHARACTERS) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function resultFromRecord(value: unknown, index: number): ExaMcpResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = safeResultUrl(value.url);
  if (!url) return undefined;
  const highlights = Array.isArray(value.highlights)
    ? value.highlights.filter((entry): entry is string => typeof entry === "string").join(" ")
    : "";
  return {
    title: boundedText(value.title, MAX_EXA_RESULT_TITLE_CHARACTERS) || `Source ${index + 1}`,
    url,
    text: boundedText(value.text || highlights, MAX_EXA_RESULT_TEXT_CHARACTERS),
  };
}

function parseJsonResults(content: string, maximumResults: number): ExaMcpResult[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) return undefined;
  const results: ExaMcpResult[] = [];
  for (const [index, value] of parsed.results.entries()) {
    const result = resultFromRecord(value, index);
    if (result) results.push(result);
    if (results.length >= maximumResults) break;
  }
  return results.length > 0 ? results : undefined;
}

function parseFormattedResults(
  content: string,
  maximumResults: number,
): ExaMcpResult[] | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/(?=^Title:\s*)/gmu);
  const results: ExaMcpResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.*)$/mu)?.[1] ?? "";
    const rawUrl = block.match(/^URL:\s*(.*)$/mu)?.[1];
    const url = safeResultUrl(rawUrl);
    if (!url) continue;
    const contentHeader = /^(?:Text|Highlights):[ \t]*(.*?)(?:\n|$)/mu.exec(block);
    let resultText = "";
    if (contentHeader?.index !== undefined) {
      const contentStart = contentHeader.index + contentHeader[0].length;
      const remainder = block.slice(contentStart);
      const separator = remainder.search(/\n---[ \t]*(?:\n|$)/u);
      const trailingText = separator >= 0 ? remainder.slice(0, separator) : remainder;
      const inlineText = contentHeader[1] ?? "";
      resultText = inlineText.length > 0 ? `${inlineText}\n${trailingText}` : trailingText;
    }
    results.push({
      title: boundedText(title, MAX_EXA_RESULT_TITLE_CHARACTERS) || `Source ${results.length + 1}`,
      url,
      text: boundedText(resultText, MAX_EXA_RESULT_TEXT_CHARACTERS),
    });
    if (results.length >= maximumResults) break;
  }
  return results.length > 0 ? results : undefined;
}

/**
 * Parses one already byte-bounded Exa MCP response contract. Raw provider error
 * bodies and JSON-RPC messages are never returned or incorporated into errors.
 */
export function parseExaMcpResponse(
  response: ExaMcpResponseContract,
  maximumResults = MAX_RESULTS,
): ExaMcpParseOutcome {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > MAX_RESULTS) {
    return { ok: false, error: closedError("invalid_request") };
  }
  const status = isRecord(response) ? response.status : undefined;
  if (
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status < 200 ||
    status >= 300
  ) {
    return { ok: false, error: exaMcpHttpError(status) };
  }
  const body = decodeResponseBody(response.body);
  if (body === undefined) return { ok: false, error: closedError("invalid_response") };
  const candidates = jsonRpcCandidates(body, response.contentType);
  if (!candidates) return { ok: false, error: closedError("invalid_response") };
  for (const candidate of candidates) {
    const content = validatedRpcContent(candidate);
    if (!content) continue;
    const results =
      parseJsonResults(content, maximumResults) ?? parseFormattedResults(content, maximumResults);
    if (results) {
      return {
        ok: true,
        value: {
          providerId: "exa",
          trust: "untrusted-web-evidence",
          results,
        },
      };
    }
  }
  return { ok: false, error: closedError("invalid_response") };
}
