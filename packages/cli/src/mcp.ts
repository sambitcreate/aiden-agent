import { validateMcpServerMetadata } from "../../../renderer/shared/mcp-oauth-config.js";
import { isMcpFieldSecretMarker, MCP_FIELD_SECRET_PREFIX } from "../../../renderer/shared/mcp-field-secrets.js";
import { mcpServerOffersTools, mcpToolsOfferedToModel } from "../../../renderer/shared/mcp-exposure.js";
import { mcpAuthorityConnectionSnapshot } from "../../../main/services/mcp-credential-cleanup-core.js";
import { createBoundedSubagentMcpFetch, MAX_SUBAGENT_MCP_RAW_RESPONSE_BYTES } from "../../../main/services/subagents/subagent-mcp-bounded-fetch.js";
import { connectMcpClient, createMcpClient } from "../../../main/services/mcp-client.js";
import { createMcpRemoteTransport } from "../../../main/services/mcp-remote-transport.js";
import { createMcpStdioTransport } from "../../../main/services/mcp-stdio-transport.js";
import { AIDEN_MCP_CLIENT_METADATA_URL, MCP_OAUTH_LOOPBACK_PORT, MCP_OAUTH_REDIRECT_URI } from "../../../main/services/mcp-oauth-client-metadata.js";
import { mcpOAuthBindingForServer, mcpOAuthClientIdentity } from "../../../main/services/mcp-oauth-identity.js";
import { McpOAuthOperationGate } from "../../../main/services/mcp-oauth-operation.js";
import { McpOAuthCredentialStorageError } from "../../../main/services/mcp-oauth-session-cache.js";
import { mcpOAuthSignInState, parseMcpOAuthSession, type McpOAuthSession } from "../../../main/services/mcp-oauth-session.js";
import {
  authorizeMcpServerWithRuntime,
  createBackgroundMcpOAuthProvider,
  type McpOAuthAuthorizationResult,
  type McpOAuthRuntime,
  type McpOAuthSessionStore,
} from "../../../main/services/mcp-oauth-provider-core.js";
import type { McpClient } from "@earendil-works/pi-mcp";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { VERSION, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpServer } from "../../../main/services/types.js";
import { MCP_PRESETS, getMcpPreset, serverFromPreset, assertMcpPresetServer } from "../../../main/services/mcp-presets.js";
import { markMcpAgentTool, mcpAgentToolNames } from "../../../main/services/mcp-tool-identity.js";
import { executeMcpAgentTool } from "../../../main/services/mcp-tool-result.js";
import { normalizeMcpToolInputSchema } from "../../../main/services/mcp-tool-schema.js";
import { tagMcpAgentTool } from "../../../main/services/mcp-agent-tool-descriptor.js";
import { callMcpTool, createMcpToolCallGuard, createMcpToolInventoryCache, listMcpToolInventory, listMcpToolPage } from "../../../main/services/mcp-tool-inventory.js";
import { JsonStore, readJson, splitArgs } from "./state.ts";
import { insightCredentials } from "./credentials.ts";

import { isRetiredMcpServerEntry, withoutRetiredMcpServers } from "../../../renderer/shared/mcp-retired-servers.js";
import { migrateAidenMcpConfig } from "./mcp-config-migration.ts";

const migratedDirectories = new Set<string>();
/** Run the one-way legacy migration at most once per agent directory per process. */
export function migrateAidenMcpConfigOnce(dir: string): void {
  if (migratedDirectories.has(dir)) return;
  migrateAidenMcpConfig(dir, validateMcpServer);
  migratedDirectories.add(dir);
}

/**
 * aiden-mcp.json. Retired (SSE) entries are left out of every read. Ordinary
 * writes keep them in the file; only `prune` drops them, after their stored
 * credentials are gone, so none is ever orphaned.
 */
class AidenMcpServerStore extends JsonStore<McpServer[]> {
  private pruning = false;
  override async load(): Promise<McpServer[]> { return withoutRetiredMcpServers(await super.load()); }
  /** The file as saved, retired entries included. */
  async loadSaved(): Promise<unknown> { return readJson<unknown>(this.file, []); }
  override update<R>(mutation: (draft: McpServer[]) => R | Promise<R>, isCurrent?: () => boolean, replace = false): Promise<R> {
    const pruning = this.pruning;
    return super.update(async (draft) => {
      const result = await mutation(draft);
      if (!pruning) {
        const saved = await this.loadSaved();
        const retired = Array.isArray(saved) ? saved.filter(isRetiredMcpServerEntry) as McpServer[] : [];
        if (replace) return (Array.isArray(result) ? [...result, ...retired] : result) as R;
        draft.push(...retired);
      }
      return result;
    }, isCurrent, replace);
  }
  /** Under the lease: `cleanup` sees the remaining servers; the retired entries leave the file once it succeeded. */
  prune(cleanup: (live: McpServer[]) => Promise<void>): Promise<void> {
    this.pruning = true;
    try { return this.update(cleanup); } finally { this.pruning = false; }
  }
}

export const storeFor = (dir: string) => {
  migrateAidenMcpConfigOnce(dir);
  return new AidenMcpServerStore(join(dir, "aiden-mcp.json"), []);
};

/**
 * Remove retired (SSE) entries from aiden-mcp.json and delete their stored
 * OAuth sign-in and client secret, as `mcp remove` would (the desktop's
 * `cleanupRetiredMcpServerCredentials`). It runs under the configuration
 * lease, so a concurrent `mcp add` cannot slip in a server whose credentials
 * it would delete; credentials a remaining server shares are kept. The pruned
 * list is written only after every delete succeeded, so a failure leaves the
 * entries in the file and the next read tries again; it never blocks the
 * remaining servers.
 */
async function pruneRetiredMcpServers(agentDir: string): Promise<void> {
  const store = storeFor(agentDir);
  const saved = await store.loadSaved();
  if (!Array.isArray(saved) || !saved.some(isRetiredMcpServerEntry)) return;
  try {
    await store.prune(async (live) => {
      const current = await store.loadSaved();
      const retired = Array.isArray(current) ? current.filter(isRetiredMcpServerEntry) : [];
      const credentials = insightCredentials(agentDir);
      const liveCredentialIds = new Set(live.map((server) => mcpCredentialId(server)));
      const liveSecrets = new Set(live.map(({ oauthClientSecret }) => oauthClientSecret));
      for (const entry of retired) {
        const server = entry as Partial<McpServer>;
        if (typeof server.id !== "string" || !server.id) continue;
        if (!live.some(({ id }) => id === server.id)) oauthOperations.invalidate(server.id);
        const credentialId = mcpCredentialId(server as McpServer);
        if (!liveCredentialIds.has(credentialId)) await credentials.delete(credentialId);
        const marker = server.oauthClientSecret;
        if (isMcpFieldSecretMarker(marker) && !liveSecrets.has(marker)) await credentials.delete(clientSecretCredentialId(marker!));
      }
    });
  } catch (error) {
    process.stderr.write(`aiden: could not remove retired SSE MCP servers yet (${errorText(error)}).\n`);
  }
}

export function validateMcpServer(value: unknown): McpServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP server.");
  const server = value as McpServer;
  if (server.authProvider !== undefined) throw new Error("Desktop MCP provider approvals do not apply to the CLI.");
  // Types first: a non-string id would otherwise stringify past the pattern ("undefined", "123").
  if (typeof server.id !== "string" || !server.id) throw new Error("MCP server needs a string id.");
  // Pi reads a leading + or - in tool lists as an include/exclude modifier.
  if (/^[+-]/.test(server.id)) throw new Error("MCP server id cannot begin with '+' or '-'.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(server.id)) throw new Error("MCP server id must start with a letter or digit and use at most 64 letters, digits, '_' or '-'.");
  if (typeof server.name !== "string" || !server.name.trim()) throw new Error("MCP server needs a non-empty name.");
  if (/^[+-]/.test(server.name.trim())) throw new Error("MCP server name cannot begin with '+' or '-'.");
  if (typeof server.enabled !== "boolean") throw new Error("MCP server needs a boolean enabled flag.");
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || !server.command.trim() || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")))) throw new Error("Invalid MCP stdio command or arguments.");
  } else if (server.transport === "http") {
    if (typeof server.url !== "string" || !server.url.trim()) throw new Error("Remote MCP needs a url.");
    let url: URL;
    try { url = new URL(server.url); } catch { throw new Error("Remote MCP url is not a valid URL."); }
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Remote MCP needs HTTPS (HTTP is permitted on loopback only).");
  } else throw new Error("Unknown MCP transport.");
  for (const fields of [server.env, server.headers]) if (fields !== undefined && (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.values(fields).some((value) => typeof value !== "string"))) throw new Error("MCP env and headers must be string maps.");
  // Exposure, the OAuth metadata override, the description and a pre-registered OAuth client: the desktop's rules.
  validateMcpServerMetadata(server);
  assertMcpPresetServer(server);
  return server;
}

export function mcpCredentialId(server: McpServer): string {
  const override = server.authServerMetadataUrl !== undefined
    ? `\0${JSON.stringify([server.authServerMetadataUrl, null])}` : "";
  return `mcp-${createHash("sha256").update(`${server.id}\0${server.url}${override}`).digest("hex")}`;
}

/**
 * A pre-registered OAuth client secret lives in the encrypted credential store;
 * aiden-mcp.json keeps only the desktop's opaque marker in its place.
 */
function clientSecretCredentialId(marker: string): string {
  return `mcp-oauth-client-secret-${marker.slice(MCP_FIELD_SECRET_PREFIX.length)}`;
}

/** The server with its stored client secret in place of the marker, for the OAuth provider only. */
async function withClientSecret(agentDir: string, server: McpServer): Promise<McpServer> {
  if (server.oauthClientSecret === undefined) return server;
  if (!isMcpFieldSecretMarker(server.oauthClientSecret)) {
    // Only `mcp add` stores a secret; one written into the file by hand (or an
    // older migrated configuration) is plaintext and is never used.
    throw new Error(`MCP server ${server.id} has a plaintext oauthClientSecret in aiden-mcp.json. Run aiden mcp add <server.json> to store it encrypted.`);
  }
  const secret = await insightCredentials(agentDir).read(clientSecretCredentialId(server.oauthClientSecret!));
  if (!secret) throw new Error(`The OAuth client secret for MCP server ${server.id} is missing. Add the server again with aiden mcp add.`);
  return { ...server, oauthClientSecret: secret };
}

/** The stored OAuth session; an unreadable one reads as the desktop's storage error. */
/** The desktop's storage error (sign-in recovers from it), with the CLI's remedy. */
class CliMcpOAuthStorageError extends McpOAuthCredentialStorageError {
  constructor(serverId: string, cause: unknown) {
    super({ cause });
    this.message = `Aiden could not read the saved sign-in for MCP server ${serverId} in credentials/insights.json. Run aiden mcp login ${serverId} again.`;
  }
}

function parseStoredOAuthSession(server: McpServer, serialized: string | undefined): McpOAuthSession {
  if (!serialized) return {};
  try { return parseMcpOAuthSession(JSON.parse(serialized)); }
  catch (cause) { throw new CliMcpOAuthStorageError(server.id, cause); }
}

async function readOAuthSession(agentDir: string, server: McpServer): Promise<McpOAuthSession> {
  return parseStoredOAuthSession(server, await insightCredentials(agentDir).read(mcpCredentialId(server)));
}

/** Grant identity: minted per interactive sign-in and kept across refreshes (the registration, for older sessions). */
function oauthIncarnation(session: McpOAuthSession): string {
  return session.grantId ?? createHash("sha256").update(JSON.stringify(session.clientInformation ?? null)).digest("hex");
}

/**
 * Bot capability credential input: the connection's authority (no display
 * name or description; env and headers only as hashes) plus the OAuth sign-in
 * incarnation. Token values never enter it, so a refresh keeps Bot grants;
 * sign-in, sign-out, and client re-registration change it.
 */
export async function mcpCredentialSignature(agentDir: string, server: McpServer) {
  let oauth: unknown = null;
  if (server.oauth) {
    const serialized = await insightCredentials(agentDir).read(mcpCredentialId(server));
    let session: McpOAuthSession | undefined;
    try { session = serialized ? parseMcpOAuthSession(JSON.parse(serialized)) : undefined; } catch { session = undefined; }
    oauth = !serialized ? "absent" : !session ? "unreadable" : {
      signedIn: mcpOAuthSignInState(session, mcpOAuthBindingForServer(server)).authorized,
      incarnation: oauthIncarnation(session),
    };
  }
  return createHash("sha256").update(JSON.stringify({ connection: mcpAuthorityConnectionSnapshot(server), oauth })).digest("hex");
}

/** Values a delegated MCP operation must never echo: header values, OAuth tokens, and client secrets. */
export async function mcpCredentialSecrets(agentDir: string, server: McpServer): Promise<string[]> {
  const values: unknown[] = [...Object.values(server.headers ?? {})];
  if (server.oauth) {
    const session = await readOAuthSession(agentDir, server).catch(() => ({}) as McpOAuthSession);
    values.push(...Object.values(session.tokens ?? {}), ...Object.values(session.clientInformation ?? {}));
    values.push(isMcpFieldSecretMarker(server.oauthClientSecret) ? (await withClientSecret(agentDir, server).catch(() => server)).oauthClientSecret : server.oauthClientSecret);
  }
  return values.filter((value): value is string => typeof value === "string" && value.length >= 4 && !isMcpFieldSecretMarker(value));
}

/** One gate per process: a sign-in supersedes background writers of the same server. */
const oauthOperations = new McpOAuthOperationGate();
const SIGN_IN_TIMEOUT_MS = 180_000;
const noLiveStatus: McpOAuthRuntime["status"] = { clearAuthFailure() {}, authFailure() {}, backgroundSignInRequired() {} };

/**
 * Where `aiden mcp login` listens for the browser's redirect. A dynamically
 * registered client is registered afresh on every interactive sign-in with
 * whatever redirect URI that sign-in uses, so it gets a random free loopback
 * port. A pre-registered client (and Aiden's Client ID Metadata Document)
 * names its redirect URI up front, so it uses the desktop's fixed
 * `http://127.0.0.1:41390/callback`, the URI to register with the provider.
 */
export function cliMcpOAuthLoopback(server: McpServer, clientMetadataUrl: string | undefined = AIDEN_MCP_CLIENT_METADATA_URL): McpOAuthRuntime["loopback"] {
  return mcpOAuthClientIdentity(server).kind === "pre-registered" || clientMetadataUrl !== undefined
    ? { port: MCP_OAUTH_LOOPBACK_PORT, redirectUri: MCP_OAUTH_REDIRECT_URI, timeoutMs: SIGN_IN_TIMEOUT_MS }
    : { port: 0, redirectUri: "http://127.0.0.1/callback", timeoutMs: SIGN_IN_TIMEOUT_MS };
}

function printSignInUrl(url: string): void {
  process.stderr.write(`Open this URL to sign in:\n${url}\n`);
}

/** The desktop's provider core over the CLI's encrypted credential store, for one server. */
function cliOAuthRuntime(agentDir: string, server: McpServer, options: { openBrowser?: (url: string) => void | Promise<void>; loopback?: McpOAuthRuntime["loopback"] } = {}): McpOAuthRuntime {
  const credentials = insightCredentials(agentDir), id = mcpCredentialId(server);
  const store: McpOAuthSessionStore = {
    get: () => readOAuthSession(agentDir, server),
    set: (_serverId, session, isCurrent) => credentials.write(id, JSON.stringify(session), isCurrent),
    clear: (_serverId, isCurrent) => credentials.delete(id, isCurrent),
    // Token saves compare and set under the writer lease: a TUI and `aiden serve` share this file.
    update: (_serverId, mutate, isCurrent) => credentials.update(id, (serialized) => {
      const next = mutate(parseStoredOAuthSession(server, serialized));
      return next && JSON.stringify(next);
    }, isCurrent),
  };
  return {
    store,
    gate: oauthOperations,
    status: noLiveStatus,
    openBrowser: async (url) => { await (options.openBrowser ?? printSignInUrl)(url); },
    // Info and warnings repeat what the caller already returns or throws; errors
    // (a sign-in that could not be rolled back) have no other channel.
    log: { info() {}, warn() {}, error: (message, error) => { process.stderr.write(`aiden: MCP sign-in: ${message}${error ? ` (${errorText(error)})` : ""}\n`); } },
    clientVersion: VERSION,
    loopback: options.loopback ?? cliMcpOAuthLoopback(server),
    clientMetadataUrl: AIDEN_MCP_CLIENT_METADATA_URL,
    publish: (_serverId, operation) => operation(),
  };
}

/**
 * `aiden mcp login <id>`: the desktop's attended sign-in (discovery, a
 * registration, Client ID Metadata Document or pre-registered client, PKCE,
 * the code exchange and a verifying connection), with the URL printed to stderr.
 */
export async function mcpLogin(
  agentDir: string,
  server: McpServer,
  options: { openBrowser?: (url: string) => void | Promise<void>; loopback?: McpOAuthRuntime["loopback"] } = {},
): Promise<McpOAuthAuthorizationResult> {
  validateMcpServer(server);
  if (!server.oauth || !server.url) throw new Error("This server is not configured for OAuth.");
  return authorizeMcpServerWithRuntime(cliOAuthRuntime(agentDir, server, options), await withClientSecret(agentDir, server));
}

/** Keep a pre-registered client secret out of aiden-mcp.json. */
async function storeClientSecret(agentDir: string, server: McpServer, previous: McpServer | undefined): Promise<McpServer> {
  const secret = server.oauthClientSecret;
  if (secret === undefined) return server;
  if (isMcpFieldSecretMarker(secret)) {
    if (previous?.oauthClientSecret === secret && previous.oauthClientId === server.oauthClientId) return server;
    throw new Error("Enter the OAuth client secret itself, not a saved marker.");
  }
  const marker = `${MCP_FIELD_SECRET_PREFIX}${randomBytes(16).toString("hex")}`;
  await insightCredentials(agentDir).write(clientSecretCredentialId(marker), secret);
  return { ...server, oauthClientSecret: marker };
}

async function deleteClientSecret(agentDir: string, server: McpServer | undefined, keep?: McpServer): Promise<void> {
  const marker = server?.oauthClientSecret;
  if (isMcpFieldSecretMarker(marker) && marker !== keep?.oauthClientSecret) await insightCredentials(agentDir).delete(clientSecretCredentialId(marker!));
}

export async function mcpCommand(agentDir: string, args: string[]) {
  const [action = "list", value] = args, store = storeFor(agentDir);
  await pruneRetiredMcpServers(agentDir);
  // A Mac app connector (iMCP) is set up in the desktop app, which finds and checks the app.
  if (action === "presets") return MCP_PRESETS.filter((preset) => preset.transport === "http");
  if (action === "list") return (await store.load()).map(({ headers: _headers, env: _env, oauthClientSecret, ...server }) => ({ ...server, ...(oauthClientSecret === undefined ? {} : { hasOAuthClientSecret: true }) }));
  if (action === "login") {
    const server = (await store.load()).find((item) => item.id === value);
    if (!server) throw new Error("MCP server not found.");
    const result = await mcpLogin(agentDir, server);
    return { signedIn: value, ...(result.connectionError ? { connectionError: result.connectionError } : {}) };
  }
  if (action === "logout") {
    const server = (await store.load()).find((item) => item.id === value);
    if (!server) throw new Error("MCP server not found.");
    oauthOperations.invalidate(server.id);
    await insightCredentials(agentDir).delete(mcpCredentialId(server));
    return { signedOut: value };
  }
  if (action === "remove") {
    const removed = await store.update((servers) => { const index = servers.findIndex((server) => server.id === value); if (index < 0) throw new Error("MCP server not found."); return servers.splice(index, 1)[0]!; });
    oauthOperations.invalidate(removed.id);
    await insightCredentials(agentDir).delete(mcpCredentialId(removed));
    await deleteClientSecret(agentDir, removed);
    return { removed: value };
  }
  if (action === "add" || action === "preset") {
    if (!value) throw new Error("Provide a server JSON file or preset id.");
    const preset = action === "preset" ? getMcpPreset(value) : undefined;
    if (action === "preset" && !preset) throw new Error("MCP preset not found.");
    if (preset?.transport === "stdio") throw new Error(`Set up ${preset.name} in Settings → Connectors in the Aiden desktop app on your Mac.`);
    const parsed = validateMcpServer(preset ? serverFromPreset(preset) : JSON.parse(readFileSync(value, "utf8")));
    const existing = (await store.load()).find((item) => item.id === parsed.id);
    const server = await storeClientSecret(agentDir, parsed, existing);
    let replaced: McpServer | undefined;
    try {
      replaced = await store.update((servers) => { const index = servers.findIndex((item) => item.id === server.id); const previous = index >= 0 ? servers[index] : undefined; if (index >= 0) servers[index] = server; else servers.push(server); return previous; });
    } catch (error) { await deleteClientSecret(agentDir, server, existing); throw error; }
    // A credential is bound to its server's endpoint identity; an edit that moves it orphans the old one.
    if (replaced && mcpCredentialId(replaced) !== mcpCredentialId(server)) await insightCredentials(agentDir).delete(mcpCredentialId(replaced));
    if (replaced) { oauthOperations.invalidate(replaced.id); await deleteClientSecret(agentDir, replaced, server); }
    return { saved: server.id };
  }
  throw new Error("Usage: mcp list|presets|add <file>|preset <id>|login <id>|logout <id>|remove <id>");
}

/**
 * Credential identity for connection reuse. Token refreshes keep the
 * incarnation; sign-in, sign-out, and client re-registration change it.
 * The encrypted store is decrypted only when its file changes.
 */
function createCredentialIncarnations(agentDir: string) {
  const file = join(agentDir, "credentials", "insights.json");
  const values = new Map<string, string>();
  let stamp: string | undefined;
  return async (server: McpServer): Promise<string> => {
    if (!server.oauth) return "none";
    let next = "absent";
    try { const stat = statSync(file); next = `${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (next !== stamp) { values.clear(); stamp = next; }
    const id = mcpCredentialId(server);
    let value = values.get(id);
    if (value === undefined) {
      const serialized = await insightCredentials(agentDir).read(id);
      let session: McpOAuthSession | undefined;
      try { session = serialized ? parseMcpOAuthSession(JSON.parse(serialized)) : undefined; } catch { session = undefined; }
      value = !serialized ? "absent" : !session ? "unreadable"
        : `${mcpOAuthSignInState(session, mcpOAuthBindingForServer(server)).authorized ? "signed-in" : "signed-out"}:${oauthIncarnation(session)}`;
      values.set(id, value);
    }
    return value;
  };
}

/** Cumulative serialized tool schemas retained per server inventory. */
const CLI_MCP_INVENTORY_MAX_BYTES = 1_048_576;
type McpListedTool = Awaited<ReturnType<typeof listMcpToolPage>>["tools"][number];
interface McpInventory { tools: McpListedTool[]; guard: ReturnType<typeof createMcpToolCallGuard>; }
/** `attempt` is the client being connected (closable mid-connect); `client` is set once it is live. */
interface PoolEntry { key: string; pending: Promise<McpClient>; attempt?: McpClient; client?: McpClient; }

function errorText(error: unknown): string {

  const text = error instanceof Error ? (error.name === "TimeoutError" ? "timed out" : error.message) : String(error);
  return text.replace(/\s+/gu, " ").trim().slice(0, 300) || "unknown error";
}

function untilSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/**
 * One process owns its transports. Connections are single-flight per server and
 * keyed on configuration plus credential identity, never token values.
 * Inventories are complete and bounded; a live client reuses its inventory
 * only when the server promises notifications/tools/list_changed.
 */
/**
 * `child` pools serve delegated (subagent) MCP: responses are bounded to the
 * subagent transport limit and redirects fail closed.
 */
export function createCliMcpPool(agentDir: string, options: { child?: boolean } = {}) {
  const clients = new Map<string, PoolEntry>();
  const inventories = createMcpToolInventoryCache<McpInventory>();
  const incarnation = createCredentialIncarnations(agentDir);
  let closed = false;
  async function listServers() {
    await pruneRetiredMcpServers(agentDir);
    const servers = (await storeFor(agentDir).load()).map(validateMcpServer);
    if (servers.length > 32 || new Set(servers.map(({ id }) => id)).size !== servers.length) throw new Error("MCP inventory exceeds 32 unique servers.");
    return servers;
  }
  async function connection(server: McpServer) {
    if (closed) throw new Error("MCP runtime is closed.");
    const current = (await listServers()).find(({ id }) => id === server.id);
    if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(server)) throw new Error("MCP connection changed or was disabled.");
    const key = `${JSON.stringify(current)}\0${await incarnation(current)}`;
    if (closed) throw new Error("MCP runtime is closed.");
    // Synchronous from here to clients.set: concurrent callers share one attempt.
    const cached = clients.get(server.id);
    if (cached?.key === key) return cached.pending;
    const entry: PoolEntry = { key, pending: undefined as unknown as Promise<McpClient> };
    // Published before the attempt runs, so its synchronous prefix already sees itself as current.
    clients.set(server.id, entry);
    entry.pending = (async () => {
      if (cached) {
        await (cached.attempt ?? await cached.pending.catch(() => undefined))?.close().catch(() => {});
        if (closed || clients.get(server.id) !== entry) throw new Error("MCP connection was closed or superseded.");
      }
      // An OAuth server without a stored sign-in is never contacted: no MCP
      // request, discovery or registration happens until `aiden mcp login`.
      const resolved = server.oauth ? await withClientSecret(agentDir, server) : server;
      if (server.oauth && !mcpOAuthSignInState(await readOAuthSession(agentDir, server), mcpOAuthBindingForServer(server)).authorized) {
        throw new Error(`Sign in with aiden mcp login ${server.id}.`);
      }
      // Shutdown or a newer attempt may have landed during the credential reads; start nothing then.
      if (closed || clients.get(server.id) !== entry) throw new Error("MCP connection was closed or superseded.");
      const client = createMcpClient("aiden-cli", VERSION);
      entry.attempt = client;
      inventories.watch(client);
      try {
        const transport = server.transport === "stdio"
          ? createMcpStdioTransport({ command: server.command!, args: server.args ?? [], env: server.env ?? {}, stderr: "pipe" })
          : createMcpRemoteTransport({
            serviceUrl: server.url!, serviceHeaders: server.headers,
            ...(options.child ? { fetch: createBoundedSubagentMcpFetch(), maximumBytes: MAX_SUBAGENT_MCP_RAW_RESPONSE_BYTES } : {}),
            // Stored tokens only: refreshes them, never registers or opens a browser.
            authProvider: server.oauth ? createBackgroundMcpOAuthProvider(cliOAuthRuntime(agentDir, server), resolved) : undefined,
            // A server that proved the session gone retires this connection; the next call reconnects.
            onTerminalFailure: () => { if (clients.get(server.id) === entry) clients.delete(server.id); },
          });
        await connectMcpClient(client, transport, { timeoutMs: 10_000 });
        if (closed || clients.get(server.id) !== entry) throw new Error("MCP connection was closed or superseded.");
        entry.client = client;
        return client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    })();
    try { return await entry.pending; }
    catch (error) { if (clients.get(server.id) === entry) clients.delete(server.id); throw error; }
  }
  /** The complete guarded inventory for the server's current live client. */
  async function inventory(server: McpServer, signal?: AbortSignal): Promise<McpInventory & { client: McpClient }> {
    const client = await connection(server);
    const assertCurrent = () => { if (closed || clients.get(server.id)?.client !== client) throw new Error("MCP connection changed or was closed."); };
    // A shared (cached) read is bounded by the inventory deadline, not one caller's signal.
    const shared = client.serverCapabilities?.tools?.listChanged === true;
    const read = async (): Promise<McpInventory> => {
      // Each page is transport-bounded; this bounds what the whole inventory retains.
      let retained = 0;
      const tools = client.serverCapabilities?.tools ? await listMcpToolInventory({
        signal: shared ? undefined : signal, assertCurrent,
        listPage: async (cursor, pageSignal) => {
          const page = await listMcpToolPage(client, cursor, { signal: pageSignal, timeoutMs: 10_000 });
          retained += Buffer.byteLength(JSON.stringify(page.tools ?? []));
          if (retained > CLI_MCP_INVENTORY_MAX_BYTES) throw new Error("MCP tool inventory exceeds its schema byte budget.");
          return page;
        },
      }) : [];
      return { tools, guard: createMcpToolCallGuard(tools) };
    };
    const loaded = await inventories.load(client, read, signal);
    assertCurrent();
    return { ...loaded, client };
  }
  async function inspectTools(server: McpServer, signal?: AbortSignal) { return (await inventory(server, signal)).tools; }
  async function agentTools(server: McpServer, signal?: AbortSignal) {
    // A server switched off for the model offers nothing; hidden tools are withheld.
    if (!mcpServerOffersTools(server)) return [];
    const { tools } = await inventory(server, signal);
    // Same names as the desktop: disambiguated against every configured server and the full inventory.
    const names = mcpAgentToolNames(server, await listServers(), tools.map(({ name }) => name));
    // Identity for grant joins, plus the exact tools/list entry for live schema/effect checks.
    return mcpToolsOfferedToModel(server, tools).map((tool) => tagMcpAgentTool(markMcpAgentTool({ name: names.get(tool.name)!, label: `${server.name}: ${tool.name}`, description: [server.description, tool.description ?? tool.name].filter(Boolean).join("\n\n"),
      parameters: Type.Unsafe<Record<string, unknown>>(normalizeMcpToolInputSchema(tool.inputSchema)),
      execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
        const current = await inventory(server, signal);
        const fresh = current.tools.find(({ name }) => name === tool.name);
        if (JSON.stringify(fresh) !== JSON.stringify(tool)) throw new Error("MCP tool schema or effects changed. Refresh the connection before using it.");
        current.guard.assertCallable(tool.name);
        return executeMcpAgentTool(async () => {
          const result = await callMcpTool(current.client, { name: tool.name, arguments: input as Record<string, unknown> }, { signal, timeoutMs: 60_000 });
          current.guard.validateResult(tool.name, result);
          return result;
        });
      },
    }, { serverId: server.id, toolName: tool.name }), tool));
  }
  return { listServers, inventory, inspectTools, agentTools, connection, async close() {
    closed = true;
    // Close in-flight attempts too, so shutdown never waits out a connect timeout, then
    // wait for every attempt to settle: none may start or send after close returns.
    const entries = [...clients.values()];
    await Promise.allSettled(entries.map(async ({ attempt }) => attempt?.close()));
    await Promise.allSettled(entries.map(async ({ pending }) => (await pending).close()));
    clients.clear();
  } };
}

/**
 * Aiden's MCP servers for one session, and its `/mcp` command. Registering
 * `/mcp` is also what turns Pi's built-in MCP extension off: Pi leaves out a
 * replaceable built-in whose command another extension registers, so the
 * native `mcp.json` / `mcp-auth.json` stack never loads and `aiden-mcp.json`
 * is the CLI's only MCP configuration. `connect: false` registers the command
 * alone (child sessions).
 */
export function createMcpExtension(agentDir: string, options: { startupBudgetMs?: number; connect?: boolean } = {}): InlineExtension {
  return { name: "aiden-mcp", async factory(pi) {
    pi.registerCommand("mcp", { description: "Aiden MCP servers: list, presets, add <file>, preset <id>, logout <id>, remove <id> (sign in with aiden mcp login <id> in a terminal)", handler: async (args, ctx) => {
      const parsed = splitArgs(args); if (parsed[0] === "login") throw new Error("Run aiden mcp login <id> in a terminal.");
      ctx.ui.notify(JSON.stringify(await mcpCommand(agentDir, parsed), null, 2), "info");
    } });
    if (options.connect === false) return;
    const pool = createCliMcpPool(agentDir);
    pi.on("session_shutdown", () => pool.close());
    let servers: McpServer[];
    try { servers = (await pool.listServers()).filter((server) => server.enabled && mcpServerOffersTools(server)); }
    catch (error) { process.stderr.write(`aiden: MCP servers unavailable (${errorText(error)}).\n`); return; }
    // Connect concurrently under one startup budget; a slow server cannot hold the others.
    const budget = AbortSignal.timeout(options.startupBudgetMs ?? 15_000);
    const results = await Promise.all(servers.map(async (server) => {
      try { return { server, tools: await untilSignal(pool.agentTools(server, budget), budget), error: undefined }; }
      catch (error) { return { server, tools: undefined, error }; }
    }));
    for (const result of results) {
      if (result.tools) for (const tool of result.tools) pi.registerTool(tool);
      else process.stderr.write(`aiden: MCP ${result.server.id} unavailable (${errorText(result.error)}). Check its configuration or sign in.\n`);
    }
  } };
}
