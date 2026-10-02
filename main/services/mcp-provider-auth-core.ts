import { createHash } from "node:crypto";
import type { McpServer } from "./types.js";
import { mcpCredentialConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import { validateMcpServerMetadata } from "../../renderer/shared/mcp-oauth-config.js";

export function mcpProviderGrantKey(serverId: string): string {
  return `mcp-provider-grant-${createHash("sha256").update(serverId).digest("hex")}`;
}

/** References may be portable; this consent marker is encrypted and device-local. */
export function mcpProviderGrantBinding(server: McpServer): string {
  validateMcpServerMetadata(server);
  if (!server.authProvider) throw new Error("Select a provider for this MCP server first.");
  return JSON.stringify({ version: 1, connection: createHash("sha256").update(JSON.stringify(mcpCredentialConnectionSnapshot(server))).digest("hex") });
}

export function canUseProviderAuthenticatedMcp(input: {
  rendererOwner: boolean; workspace: boolean; assistant: boolean; bot: boolean; permission: string;
  usageSource?: string; interactionSurface?: string;
}): boolean {
  return input.rendererOwner && input.workspace && input.permission !== "none" && !input.assistant && !input.bot &&
    (input.usageSource === undefined || input.usageSource === "chat") &&
    (input.interactionSurface === undefined || input.interactionSurface === "desktop");
}

export function admitMcpProviderAuthServers(servers: readonly McpServer[], allowed: boolean, strict: boolean): McpServer[] {
  const unavailable = servers.some((server) => server.authProvider !== undefined);
  if (unavailable && !allowed && strict) throw new Error("Provider-authenticated MCP servers require an attended desktop workspace.");
  return servers.filter((server) => allowed || server.authProvider === undefined);
}

/** Resolve only the bearer credential: model headers, base URL and environment never leave the provider. */
export function createMcpProviderAuthenticatedFetch(options: {
  server: McpServer;
  readGrant(): Promise<string | null>;
  resolveToken(providerId: string): Promise<string | undefined>;
  assertCurrent(): void;
  fetch?: typeof fetch;
}): typeof fetch {
  const server = structuredClone(options.server);
  const binding = mcpProviderGrantBinding(server);
  const endpoint = new URL(server.url!).href;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    options.assertCurrent();
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.href !== endpoint) throw new Error("Provider credentials may only reach the exact approved MCP URL.");
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    if (await options.readGrant() !== binding) throw new Error("Approve this provider credential in Settings → Plugins on this device before connecting.");
    options.assertCurrent();
    let token: string | undefined;
    try { token = await options.resolveToken(server.authProvider!); }
    catch { throw new Error("The selected provider credential could not be refreshed. Sign in again in Provider Settings."); }
    signal?.throwIfAborted();
    options.assertCurrent();
    if (await options.readGrant() !== binding) throw new Error("MCP provider credential approval was revoked.");
    signal?.throwIfAborted();
    options.assertCurrent();
    if (typeof token !== "string" || !token || token.length > 32_768 || [...token].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
      throw new Error("The selected provider does not have a usable bearer credential. Sign in or choose another provider.");
    }
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    try {
      const response = await fetchImpl(input, { ...init, headers, redirect: "error" });
      if (response.ok) return response;
      await response.body?.cancel();
      // Remote error bodies can echo Authorization; never expose them in SDK errors.
      return new Response("The MCP server rejected the authenticated request.", { status: response.status, headers: { "content-type": "text/plain" } });
    }
    catch { throw new Error("The provider-authenticated MCP request failed. Check the server connection and try again."); }
  };
}

export interface McpProviderExecutionScope {
  signal: AbortSignal;
  isCurrent(): boolean;
  onInvalidated?(listener: () => void): () => void;
}

/** No provider-authenticated connection survives its one discovery/tool operation. */
export async function withMcpProviderOperation<T, R>(options: {
  scope: McpProviderExecutionScope;
  create(): T;
  connect(client: T, signal: AbortSignal, isCurrent: () => boolean): Promise<void>;
  use(client: T, signal: AbortSignal): Promise<R>;
  close(client: T): Promise<void>;
}): Promise<R> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.scope.signal, lifetime.signal, AbortSignal.timeout(60_000)]);
  const current = () => !signal.aborted && options.scope.isCurrent();
  const assertCurrent = () => { signal.throwIfAborted(); if (!current()) throw new Error("This attended MCP operation is no longer active."); };
  assertCurrent();
  const client = options.create();
  const abort = () => { void options.close(client).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const unsubscribe = options.scope.onInvalidated?.(() => lifetime.abort(new Error("The attended MCP owner closed.")));
  try {
    assertCurrent();
    await options.connect(client, signal, current);
    assertCurrent();
    const result = await options.use(client, signal);
    assertCurrent();
    return result;
  } finally {
    // Revoke before asynchronous close: late token refresh/reconnect cannot dispatch.
    unsubscribe?.();
    signal.removeEventListener("abort", abort);
    lifetime.abort(new Error("The attended MCP operation completed."));
    await options.close(client).catch(() => undefined);
  }
}
