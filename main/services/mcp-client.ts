// Thin Aiden conventions over Pi's MCP client (`@earendil-works/pi-mcp`).
// Every desktop MCP client connection goes through these helpers so request
// bounds, cancellation and connection deadlines behave the same everywhere.
import {
  McpAbortError,
  McpClient,
  McpTimeoutError,
  type McpRequestOptions,
  type McpTransport,
} from "@earendil-works/pi-mcp";

/**
 * Per-request bounds. Without `onProgress`, `timeoutMs` is a hard total; with
 * it, each progress notification restarts the timeout.
 */
export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: McpRequestOptions["onProgress"];
}

/** A client that can make raw MCP requests (tests may pass a narrower fake). */
export type McpRequester = Pick<McpClient, "request">;

export { AIDEN_MCP_CLIENT_NAME } from "../../renderer/shared/connector-catalog.js";

export function createMcpClient(name: string, version = "1.0.0"): McpClient {
  return new McpClient({ name, version, capabilities: {} });
}

/**
 * Pi rejects an aborted request with a generic `McpAbortError`. Aiden's
 * callers classify cancellation by the abort reason the caller supplied, so
 * surface that reason instead.
 */
export function withMcpAbortReason<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending;
  return pending.catch((error: unknown) => {
    if (error instanceof McpAbortError && signal.aborted && signal.reason !== undefined) throw signal.reason;
    throw error;
  });
}

/** One raw request, with Aiden's bounds and abort-reason convention. */
export function mcpRequest<T>(
  client: McpRequester,
  method: string,
  params: Record<string, unknown> | undefined,
  options: McpCallOptions = {},
): Promise<T> {
  return withMcpAbortReason(
    client.request<T>(method, params, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    }),
    options.signal,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new McpAbortError();
}

/**
 * Connect (transport start plus `initialize`) within `timeoutMs` and until
 * `signal` aborts. Pi's `connect` takes no options, so on timeout or abort
 * the client is closed, which rejects the pending `initialize` and closes the
 * transport. A failed connect leaves the client closed, as with the SDK.
 */
export async function connectMcpClient(
  client: McpClient,
  transport: McpTransport,
  options: McpCallOptions = {},
): Promise<void> {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) {
    await transport.close().catch(() => undefined);
    throw abortReason(signal);
  }
  const connecting = client.connect(transport);
  if (!signal && timeoutMs === undefined) {
    await connecting;
    return;
  }
  connecting.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      connecting,
      new Promise<never>((_resolve, reject) => {
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => reject(new McpTimeoutError(timeoutMs)), timeoutMs);
        }
        if (signal) {
          onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
