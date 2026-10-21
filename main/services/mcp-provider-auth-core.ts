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

/**
 * Device-local opt-ins, stored encrypted: provider id → fingerprint of the
 * exact API key that was opted in. A replaced key, a switch to a sign-in, or
 * a logout no longer matches, so a different credential is never shared.
 */
export const MCP_PROVIDER_KEY_SHARING_KEY = "mcp-provider-key-sharing";
const MAX_SHARING_IDS = 256;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

export type McpProviderKeySharing = Map<string, string>;

export function mcpProviderKeyFingerprint(key: string): string {
  return createHash("sha256").update(`aiden-mcp-provider-key\0${key}`).digest("hex");
}

export function parseMcpProviderKeySharing(value: string | null): McpProviderKeySharing {
  const result: McpProviderKeySharing = new Map();
  if (!value) return result;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    for (const [id, fingerprint] of Object.entries(parsed)) {
      if (result.size >= MAX_SHARING_IDS) break;
      if (id.length > 0 && id.length <= 200 && typeof fingerprint === "string" && FINGERPRINT.test(fingerprint)) result.set(id, fingerprint);
    }
  } catch {
    // Unreadable records share nothing.
  }
  return result;
}

export function serializeMcpProviderKeySharing(sharing: McpProviderKeySharing): string {
  return JSON.stringify(Object.fromEntries([...sharing].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_SHARING_IDS)));
}

/** The ChatGPT subscription provider: its sign-in is never an API key. */
const SUBSCRIPTION_PROVIDER_IDS: ReadonlySet<string> = new Set(["openai-codex"]);

export interface McpProviderStoredCredential {
  type: "api_key" | "oauth";
  /** The saved API key (api_key credentials only). */
  key?: string;
}

export interface McpProviderCredentialSource {
  isBuiltin(providerId: string): boolean;
  /** One read of the credential Aiden stores for this provider: its type and, for an API key, the key. */
  storedCredential(providerId: string): Promise<McpProviderStoredCredential | undefined>;
  /** Fingerprint of the key that was opted in with "Let custom connectors use this key". */
  sharedFingerprint(providerId: string): Promise<string | undefined>;
}

/** A provider credential that custom connectors may not use, with the reason. */
export class McpProviderKeyRefusedError extends Error {}

/**
 * The API key a custom connector may use, from a single read of the stored
 * credential so its type and value cannot change in between. Only a saved API
 * key qualifies: sign-in and subscription credentials (ChatGPT, Claude, GitHub
 * Copilot and any other OAuth credential) never do, and the exact key must
 * have been opted in from Settings → Providers. `checkSharing: false` checks
 * only the credential (used when opting in). Throws `McpProviderKeyRefusedError`.
 */
export async function resolveMcpProviderSharedKey(
  providerId: string,
  source: McpProviderCredentialSource,
  options: { checkSharing?: boolean } = {},
): Promise<{ key: string; fingerprint: string }> {
  if (!source.isBuiltin(providerId) || SUBSCRIPTION_PROVIDER_IDS.has(providerId)) {
    throw new McpProviderKeyRefusedError("Only a built-in provider’s API key can be shared with a custom connector.");
  }
  const credential = await source.storedCredential(providerId);
  if (credential?.type === "oauth") {
    throw new McpProviderKeyRefusedError("Sign-in and subscription credentials are never shared with connectors. Use a provider with a saved API key.");
  }
  const key = credential?.type === "api_key" ? credential.key?.trim() : undefined;
  if (!key) throw new McpProviderKeyRefusedError("This provider has no saved API key to share.");
  const fingerprint = mcpProviderKeyFingerprint(key);
  if (options.checkSharing !== false && (await source.sharedFingerprint(providerId)) !== fingerprint) {
    throw new McpProviderKeyRefusedError("Turn on “Let custom connectors use this key” for this provider in Settings → Providers first.");
  }
  return { key, fingerprint };
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

/**
 * Resolve only the bearer credential: model headers, base URL and environment never leave the provider.
 *
 * One fetch serves one attended operation's transport. The device grant is
 * verified on both sides of the first credential resolution; later requests in
 * the same operation rely on `assertCurrent`, which the configuration lease
 * fails synchronously when a grant or connection change is published.
 */
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
  let grantVerified = false;
  return async (input, init) => {
    options.assertCurrent();
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.href !== endpoint) throw new Error("Provider credentials may only reach the exact approved MCP URL.");
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    const verifyGrant = !grantVerified;
    if (verifyGrant && await options.readGrant() !== binding) throw new Error("Approve this provider credential in Settings → Connectors on this device before connecting.");
    options.assertCurrent();
    let token: string | undefined;
    try { token = await options.resolveToken(server.authProvider!); }
    catch (error) {
      if (error instanceof McpProviderKeyRefusedError) throw error;
      throw new Error("The selected provider credential could not be read. Check it in Settings → Providers.");
    }
    signal?.throwIfAborted();
    options.assertCurrent();
    if (verifyGrant) {
      if (await options.readGrant() !== binding) throw new Error("MCP provider credential approval was revoked.");
      grantVerified = true;
    }
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
