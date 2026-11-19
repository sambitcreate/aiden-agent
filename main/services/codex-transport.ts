import type { ProviderEnv, Transport } from "@earendil-works/pi-ai";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * The transport for a Codex request sent from this process (the desktop and
 * `aiden serve`). A persistent WebSocket, keyed by the chat's session ID,
 * keeps the conversation on one backend connection and so on its prompt
 * cache; Pi falls back to HTTP (SSE) for the session when the socket fails
 * before streaming. Only the plain "websocket" mode is used: it sends the
 * whole request, as SSE does, while Pi's "auto" and "websocket-cached" modes
 * replace the request's input with a `previous_response_id` delta,
 * server-side continuation that has not been measured against the replay
 * gate.
 *
 * The request goes over HTTP when the caller asks for SSE, when the runtime
 * has no WebSocket, or when a proxy is configured for the Codex host: the
 * runtime's WebSocket does not go through the proxy that HTTP requests use.
 * Isolated dispatch stays on SSE as well: its worker process cannot keep a
 * socket between requests.
 */
export function inProcessCodexTransport(
  requested: Transport | undefined,
  options: { webSocketAvailable?: boolean; baseUrl?: string; env?: ProviderEnv } = {},
): Transport {
  // `in` checks the runtime without reading (and constructing) the global.
  const webSocketAvailable = options.webSocketAvailable ?? "WebSocket" in globalThis;
  if (requested === "sse" || !webSocketAvailable) return "sse";
  return codexProxyConfigured(options.baseUrl ?? CODEX_BASE_URL, options.env) ? "sse" : "websocket";
}

/** Whether HTTP requests to the Codex host would go through a proxy (NO_PROXY honored). */
function codexProxyConfigured(baseUrl: string, env: ProviderEnv | undefined): boolean {
  try {
    return resolveHttpProxyUrlForTarget(baseUrl, env) !== undefined;
  } catch {
    // A proxy is set, in a form Pi's HTTP proxy support rejects.
    return true;
  }
}
