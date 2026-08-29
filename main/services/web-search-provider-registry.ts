/**
 * Main-process Web Search adapter registry.
 *
 * The renderer-facing provider catalog lives in
 * `web-search-provider-registry-core.ts`.  This module is intentionally main
 * only: adapter factories, fetch implementations, and credentials never
 * cross that boundary.
 */

import {
  buildExaMcpRequest,
  exaMcpHttpError,
  exaMcpTransportError,
  parseExaMcpResponse,
  type ExaCredential,
  type ExaMcpErrorCategory,
} from "./web-search-exa-core.js";
import {
  getWebSearchProviderDefinition,
  type WebSearchCredentialMode,
  type WebSearchProviderId,
} from "./web-search-provider-registry-core.js";
import {
  normalizeWebSearchResultSet,
  webSearchError,
  WebSearchError,
  type WebSearchResultSet,
} from "./web-search-core.js";

export type WebSearchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WebSearchAdapterRequest {
  readonly query: string;
  readonly numResults: number;
  readonly credentialMode: WebSearchCredentialMode;
  /** Main-owned API key. It is never included in a result or error. */
  readonly credential?: string;
  readonly signal: AbortSignal;
  /** Distinguishes the service deadline from caller cancellation. */
  readonly timedOut?: () => boolean;
}

export interface WebSearchAdapter {
  readonly providerId: WebSearchProviderId;
  readonly adapterVersion: number;
  search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet>;
}

export type WebSearchAdapterFactory = (options?: { fetch?: WebSearchFetch }) => WebSearchAdapter;

export interface WebSearchAdapterFactoryOptions {
  readonly fetch?: WebSearchFetch;
}

function asWebSearchError(category: ExaMcpErrorCategory): WebSearchError {
  switch (category) {
    case "invalid_request":
      return webSearchError("invalid-request", "exa");
    case "authentication":
      return webSearchError("auth", "exa");
    case "rate_limit":
      return webSearchError("quota", "exa");
    case "upstream":
      return webSearchError("transient", "exa");
    case "network":
      return webSearchError("network", "exa");
    case "timeout":
      return webSearchError("timeout", "exa");
    case "cancelled":
      return webSearchError("cancelled", "exa");
    case "policy":
      return webSearchError("config", "exa");
    case "invalid_response":
      return webSearchError("invalid-response", "exa");
  }
}

function isRedirectFailure(error: unknown): boolean {
  // Fetch implementations normally surface redirect:error as a TypeError.
  // Inspect only the local error category; the upstream text is never copied
  // into a public error.
  return (
    error instanceof Error && /\bredirect\b|redirect mode|maximum redirect/iu.test(error.message)
  );
}

function responseContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

async function raceReader<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<T>>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("The request was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Read an HTTP body before parsing it; declared and streamed bytes are bounded. */
export async function readBoundedWebSearchResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = responseContentLength(response);
  if (declared !== undefined && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw webSearchError("invalid-response", "exa");
  }
  if (!response.body) throw webSearchError("invalid-response", "exa");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await raceReader(reader, signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw webSearchError("invalid-response", "exa");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mapExaTransportFailure(error: unknown, request: WebSearchAdapterRequest): WebSearchError {
  if (request.signal.aborted) {
    return asWebSearchError(
      exaMcpTransportError(request.timedOut?.() === true ? "timeout" : "cancelled").category,
    );
  }
  if (isRedirectFailure(error)) return asWebSearchError(exaMcpTransportError("redirect").category);
  return asWebSearchError("network");
}

function adapterRequestCredential(request: WebSearchAdapterRequest): ExaCredential {
  if (request.credentialMode === "anonymous") return { mode: "anonymous" };
  if (request.credentialMode === "api-key" && request.credential !== undefined) {
    return { mode: "api-key", apiKey: request.credential };
  }
  throw asWebSearchError("authentication");
}

export function createExaWebSearchAdapter(
  options: WebSearchAdapterFactoryOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const definition = getWebSearchProviderDefinition("exa");
  if (!definition || definition.releaseState !== "shipped") {
    throw webSearchError("unavailable", "exa");
  }

  return Object.freeze({
    providerId: "exa" as const,
    adapterVersion: definition.adapterVersion,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      let built: ReturnType<typeof buildExaMcpRequest>;
      try {
        built = buildExaMcpRequest(
          request.query,
          request.numResults,
          adapterRequestCredential(request),
        );
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw asWebSearchError("invalid_request");
      }

      let response: Response;
      try {
        response = await fetchImpl(built.url, {
          ...built.init,
          signal: request.signal,
        });
      } catch (error) {
        throw mapExaTransportFailure(error, request);
      }

      let body: Uint8Array;
      try {
        body = await readBoundedWebSearchResponse(response, request.signal, 256 * 1_024);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw mapExaTransportFailure(error, request);
      }

      const parsed = parseExaMcpResponse(
        {
          status: response.status,
          body,
          contentType: response.headers.get("content-type") ?? undefined,
        },
        request.numResults,
      );
      if (!parsed.ok) throw asWebSearchError(parsed.error.category);
      try {
        return normalizeWebSearchResultSet("exa", { results: parsed.value.results });
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-response", "exa");
      }
    },
  });
}

/** Only Exa is shippable in this phase. Other catalog entries have no factory. */
export const WEB_SEARCH_ADAPTER_FACTORIES: Readonly<
  Partial<Record<WebSearchProviderId, WebSearchAdapterFactory>>
> = Object.freeze({ exa: createExaWebSearchAdapter });

export function webSearchAdapterFactory(providerId: unknown): WebSearchAdapterFactory | undefined {
  return typeof providerId === "string" &&
    Object.prototype.hasOwnProperty.call(WEB_SEARCH_ADAPTER_FACTORIES, providerId)
    ? WEB_SEARCH_ADAPTER_FACTORIES[providerId as WebSearchProviderId]
    : undefined;
}

export const getWebSearchAdapterFactory = webSearchAdapterFactory;

export function webSearchAdapterAvailable(providerId: unknown): boolean {
  return webSearchAdapterFactory(providerId) !== undefined;
}

export const isWebSearchAdapterAvailable = webSearchAdapterAvailable;

/** Closed HTTP status mapping kept available for transport-focused tests. */
export const mapExaHttpError = (status: unknown): WebSearchError =>
  asWebSearchError(exaMcpHttpError(status).category);
