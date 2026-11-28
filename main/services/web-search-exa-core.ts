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

export const EXA_MCP_ORIGIN = "https://mcp.exa.ai";
export const EXA_MCP_ENDPOINT = `${EXA_MCP_ORIGIN}/mcp?tools=web_search_exa`;
export const EXA_MCP_TOOL = "web_search_exa";
export const MAX_EXA_MCP_REQUEST_BYTES = 32 * 1024;
export const MAX_EXA_MCP_RESPONSE_BYTES = 256 * 1024;
export const MAX_EXA_RESULT_TITLE_CHARACTERS = 300;
export const MAX_EXA_RESULT_URL_CHARACTERS = 2_048;
export const MAX_EXA_RESULT_TEXT_CHARACTERS = 1_200;

const EXA_LABEL = "Exa";
const JSON_RPC_ID = 1;

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

export type ExaMcpErrorCategory = WebSearchCoreErrorCategory;

export type ExaMcpErrorContract = WebSearchCoreErrorContract<"exa">;

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

function closedError(category: ExaMcpErrorCategory): ExaMcpErrorContract {
  return createWebSearchCoreError("exa", EXA_LABEL, category);
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
  const query = requireWebSearchCoreQuery(queryValue, "exa", EXA_LABEL);
  const numResults = requireWebSearchCoreResultCount(numResultsValue, "exa", EXA_LABEL);
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (credential?.mode === "api-key") {
    headers["x-api-key"] = requireWebSearchCoreApiKey(credential.apiKey, "exa", EXA_LABEL);
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
  if (webSearchBodyByteLength(body) > MAX_EXA_MCP_REQUEST_BYTES) {
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
  return mapWebSearchCoreHttpError("exa", EXA_LABEL, status);
}

export function exaMcpTransportError(kind: unknown): ExaMcpErrorContract {
  return mapWebSearchCoreTransportError("exa", EXA_LABEL, kind);
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

function resultFromRecord(value: unknown, index: number): ExaMcpResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = validateWebSearchResultUrl(value.url, MAX_EXA_RESULT_URL_CHARACTERS, "code-points");
  if (!url) return undefined;
  const highlights = Array.isArray(value.highlights)
    ? value.highlights.filter((entry): entry is string => typeof entry === "string").join(" ")
    : "";
  return {
    title:
      boundWebSearchText(value.title, MAX_EXA_RESULT_TITLE_CHARACTERS, "code-points") ||
      `Source ${index + 1}`,
    url,
    text: boundWebSearchText(
      value.text || highlights,
      MAX_EXA_RESULT_TEXT_CHARACTERS,
      "code-points",
    ),
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
  return parseWebSearchFormattedResults(content, {
    maximumResults,
    maxTitle: MAX_EXA_RESULT_TITLE_CHARACTERS,
    maxUrl: MAX_EXA_RESULT_URL_CHARACTERS,
    maxText: MAX_EXA_RESULT_TEXT_CHARACTERS,
    unit: "code-points",
  });
}

/**
 * Parses one already byte-bounded Exa MCP response contract. Raw provider error
 * bodies and JSON-RPC messages are never returned or incorporated into errors.
 */
export function parseExaMcpResponse(
  response: ExaMcpResponseContract,
  maximumResults = WEB_SEARCH_RESULTS_MAX_COUNT,
): ExaMcpParseOutcome {
  if (!isValidWebSearchResultCount(maximumResults)) {
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
  const body = decodeWebSearchBody(response.body, MAX_EXA_MCP_RESPONSE_BYTES);
  if (body === undefined) return { ok: false, error: closedError("invalid_response") };
  const candidates = parseWebSearchMcpCandidates(body, response.contentType);
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
