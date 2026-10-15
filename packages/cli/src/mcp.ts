import { createMcpFetchPolicy } from "../../../main/services/mcp-fetch-policy.js";
import { mcpOAuthMetadataUrlForServer } from "../../../renderer/shared/mcp-oauth-config.js";
import { loadMcpOAuthMetadataOverride, withMcpOAuthMetadataObservation } from "../../../main/services/mcp-oauth-metadata.js";
import { McpOAuthAuthorizationFlow } from "../../../main/services/mcp-oauth-session.js";
import { mcpAuthorityConnectionSnapshot } from "../../../main/services/mcp-credential-cleanup-core.js";
import { createBoundedSubagentMcpFetch } from "../../../main/services/subagents/subagent-mcp-bounded-fetch.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpServer } from "../../../main/services/types.js";
import { MCP_PRESETS, getMcpPreset, serverFromPreset, assertMcpPresetServer } from "../../../main/services/mcp-presets.js";
import { mcpAgentToolName } from "../../../main/services/mcp-tool-identity.js";
import { executeMcpAgentTool } from "../../../main/services/mcp-tool-result.js";
import { normalizeMcpToolInputSchema } from "../../../main/services/mcp-tool-schema.js";
import { tagMcpAgentTool } from "../../../main/services/mcp-agent-tool-descriptor.js";
import { callMcpTool, createMcpToolCallGuard, createMcpToolInventoryCache, listMcpToolInventory, listMcpToolPage } from "../../../main/services/mcp-tool-inventory.js";
import { JsonStore, splitArgs } from "./state.ts";
import { insightCredentials } from "./credentials.ts";

import { migrateAidenMcpConfig } from "./mcp-config-migration.ts";

const migratedDirectories = new Set<string>();
/** Run the one-way legacy migration at most once per agent directory per process. */
export function migrateAidenMcpConfigOnce(dir: string): void {
  if (migratedDirectories.has(dir)) return;
  migrateAidenMcpConfig(dir, validateMcpServer);
  migratedDirectories.add(dir);
}
export const storeFor = (dir: string) => {
  migrateAidenMcpConfigOnce(dir);
  return new JsonStore<McpServer[]>(join(dir, "aiden-mcp.json"), []);
};
export function validateMcpServer(value: unknown): McpServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP server.");
  const server = value as McpServer;
  if (server.authProvider !== undefined) throw new Error("Desktop MCP provider approvals do not apply to the CLI. Configure native MCP auth.provider separately.");
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
  } else if (server.transport === "http" || server.transport === "sse") {
    if (typeof server.url !== "string" || !server.url.trim()) throw new Error("Remote MCP needs a url.");
    let url: URL;
    try { url = new URL(server.url); } catch { throw new Error("Remote MCP url is not a valid URL."); }
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Remote MCP needs HTTPS (HTTP is permitted on loopback only).");
  } else throw new Error("Unknown MCP transport.");
  for (const fields of [server.env, server.headers]) if (fields !== undefined && (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.values(fields).some((value) => typeof value !== "string"))) throw new Error("MCP env and headers must be string maps.");
  assertMcpPresetServer(server);
  return server;
}

export function mcpCredentialId(server: McpServer): string {
  const override = server.authServerMetadataUrl !== undefined || server.oauthClientName !== undefined
    ? `\0${JSON.stringify([server.authServerMetadataUrl ?? null, server.oauthClientName?.trim() ?? null])}` : "";
  return `mcp-${createHash("sha256").update(`${server.id}\0${server.url}${override}`).digest("hex")}`;
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
    const state: OAuthState | undefined = serialized ? JSON.parse(serialized) : undefined;
    oauth = !state ? "absent" : {
      signedIn: Boolean(state.tokens),
      incarnation: state.incarnation ?? createHash("sha256").update(JSON.stringify(state.client ?? null)).digest("hex"),
    };
  }
  return createHash("sha256").update(JSON.stringify({ connection: mcpAuthorityConnectionSnapshot(server), oauth })).digest("hex");
}

/** `incarnation` is minted per interactive sign-in and survives token refreshes. */
interface OAuthState { tokens?: OAuthTokens; client?: OAuthClientInformationMixed; redirectUrl?: string; grantedScope?: string; incarnation?: string; }
async function oauthProvider(agentDir: string, server: McpServer, interaction?: { redirectUrl: string; flow: McpOAuthAuthorizationFlow; notify(url: URL): void }): Promise<OAuthClientProvider> {
  const credentials = insightCredentials(agentDir);
  const id = mcpCredentialId(server);
  const load = async (): Promise<OAuthState> => { const serialized = await credentials.read(id); return serialized ? JSON.parse(serialized) : {}; };
  let stored = await load();
  // A retained connection outlives refreshes committed by other sessions: read the
  // persisted state on every use, and mutate that rather than a construction-time copy.
  // An interactive sign-in owns its in-memory state until it saves.
  const current = async () => { if (!interaction) stored = await load(); return stored; };
  if (interaction) { stored.grantedScope = stored.tokens?.scope || stored.grantedScope; delete stored.client; delete stored.tokens; stored.redirectUrl = interaction.redirectUrl; stored.incarnation = randomUUID(); }
  const flow = interaction?.flow ?? new McpOAuthAuthorizationFlow();
  const metadataUrl = mcpOAuthMetadataUrlForServer(server);
  let verifier: string | undefined;
  const save = () => credentials.write(id, JSON.stringify(stored));
  return {
    redirectUrl: stored.redirectUrl ?? "http://127.0.0.1/callback",
    clientMetadata: { client_name: server.oauthClientName?.trim() || "Aiden CLI", redirect_uris: [stored.redirectUrl ?? "http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => flow.state,
    saveDiscoveryState: (state) => flow.saveDiscovery(state),
    async discoveryState() {
      if (metadataUrl && !flow.discoveryState()) flow.saveDiscovery(await loadMcpOAuthMetadataOverride(metadataUrl, { serviceUrl: server.url!, serviceHeaders: server.headers }));
      return flow.discoveryState();
    },
    clientInformation: async () => (await current()).client,
    saveClientInformation: async (client) => { (await current()).client = client; await save(); },
    tokens: async () => (await current()).tokens,
    saveTokens: async (tokens) => { await current(); stored.grantedScope = tokens.scope || flow.requestedScope || stored.grantedScope; stored.tokens = tokens; await save(); },
    redirectToAuthorization(url) { if (!interaction) throw new Error(`Sign in with aiden mcp login ${server.id}.`); interaction.notify(flow.authorizationUrl(url, stored.tokens?.scope || stored.grantedScope)); },
    saveCodeVerifier(value) { verifier = value; },
    codeVerifier() { if (!verifier) throw new Error("No active MCP OAuth verifier."); return verifier; },
    invalidateCredentials: async (scope) => { await current(); if (scope === "all" || scope === "discovery") flow.clearDiscovery(); if (scope === "all" || scope === "tokens") { stored.grantedScope = stored.tokens?.scope || stored.grantedScope; delete stored.tokens; } if (scope === "all" || scope === "client") delete stored.client; await save(); },
  };
}

export async function mcpLogin(agentDir: string, server: McpServer): Promise<void> {
  if (!server.oauth || !server.url) throw new Error("This server is not configured for OAuth.");
  validateMcpServer(server);
  const flow = new McpOAuthAuthorizationFlow();
  let finish: (value: string) => void = () => {};
  let deny: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, reject) => { finish = resolve; deny = reject; });
  void code.catch(() => undefined);
  const listener = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") { response.writeHead(400).end("Invalid OAuth callback."); return; }
    try {
      const result = flow.callback(url);
      if ("error" in result) deny(result.error); else finish(result.code);
      response.writeHead(200, { "content-type": "text/plain" }).end("Aiden received your sign-in. You can close this tab.");
    } catch { response.writeHead(400).end("Invalid OAuth callback."); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = (listener.address() as import("node:net").AddressInfo).port;
    const provider = await oauthProvider(agentDir, server, { flow, redirectUrl: `http://127.0.0.1:${port}/callback`, notify: (url) => process.stderr.write(`Open this URL to sign in:\n${url.href}\n`) });
    const fetchFn = withMcpOAuthMetadataObservation(createMcpFetchPolicy({ serviceUrl: server.url, serviceHeaders: server.headers }), (url, document) => flow.observeAuthorizationMetadata(url, document));
    const status = await auth(provider, { serverUrl: server.url, fetchFn });
    if (status === "REDIRECT") {
      const authorizationCode = await Promise.race([code, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP login timed out.")), 180_000); })]);
      await auth(provider, { serverUrl: server.url, authorizationCode, fetchFn });
    }
  } finally { if (timer) clearTimeout(timer); listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); }
}

export async function mcpCommand(agentDir: string, args: string[]) {
  const [action = "list", value] = args, store = storeFor(agentDir);
  if (action === "presets") return MCP_PRESETS;
  if (action === "list") return (await store.load()).map(({ headers: _headers, env: _env, ...server }) => server);
  if (action === "login") { const server = (await store.load()).find((item) => item.id === value); if (!server) throw new Error("MCP server not found."); await mcpLogin(agentDir, server); return { signedIn: value }; }
  if (action === "logout") {
    const server = (await store.load()).find((item) => item.id === value);
    if (!server) throw new Error("MCP server not found.");
    await insightCredentials(agentDir).delete(mcpCredentialId(server));
    return { signedOut: value };
  }
  if (action === "remove") {
    const removed = await store.update((servers) => { const index = servers.findIndex((server) => server.id === value); if (index < 0) throw new Error("MCP server not found."); return servers.splice(index, 1)[0]!; });
    await insightCredentials(agentDir).delete(mcpCredentialId(removed));
    return { removed: value };
  }
  if (action === "add" || action === "preset") {
    if (!value) throw new Error("Provide a server JSON file or preset id.");
    const preset = action === "preset" ? getMcpPreset(value) : undefined;
    if (action === "preset" && !preset) throw new Error("MCP preset not found.");
    const server = validateMcpServer(preset ? serverFromPreset(preset) : JSON.parse(readFileSync(value, "utf8")));
    const replaced = await store.update((servers) => { const index = servers.findIndex((item) => item.id === server.id); const previous = index >= 0 ? servers[index] : undefined; if (index >= 0) servers[index] = server; else servers.push(server); return previous; });
    // A credential is bound to its server's endpoint identity; an edit that moves it orphans the old one.
    if (replaced && mcpCredentialId(replaced) !== mcpCredentialId(server)) await insightCredentials(agentDir).delete(mcpCredentialId(replaced));
    return { saved: server.id };
  }
  throw new Error("Usage: mcp list|presets|add <file>|preset <id>|login <id>|remove <id>");
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
      const state: OAuthState | undefined = serialized ? JSON.parse(serialized) : undefined;
      value = !state ? "absent" : state.incarnation ?? createHash("sha256").update(JSON.stringify(state.client ?? null)).digest("hex");
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
interface PoolEntry { key: string; pending: Promise<Client>; attempt?: Client; client?: Client; }

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
export function createCliMcpPool(agentDir: string, maxResponseBytes = 8 * 1024 * 1024) {
  const clients = new Map<string, PoolEntry>();
  const inventories = createMcpToolInventoryCache<McpInventory>();
  const incarnation = createCredentialIncarnations(agentDir);
  let closed = false;
  async function listServers() {
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
    const entry: PoolEntry = { key, pending: undefined as unknown as Promise<Client> };
    // Published before the attempt runs, so its synchronous prefix already sees itself as current.
    clients.set(server.id, entry);
    entry.pending = (async () => {
      if (cached) {
        await (cached.attempt ?? await cached.pending.catch(() => undefined))?.close().catch(() => {});
        if (closed || clients.get(server.id) !== entry) throw new Error("MCP connection was closed or superseded.");
      }
      const client = new Client({ name: "aiden-cli", version: "0.1.0" });
      entry.attempt = client;
      inventories.watch(client);
      try {
        const options = server.transport === "stdio" ? undefined : { fetch: createBoundedSubagentMcpFetch(createMcpFetchPolicy({ serviceUrl: server.url!, serviceHeaders: server.headers }), maxResponseBytes), authProvider: server.oauth ? await oauthProvider(agentDir, server) : undefined };
        // Shutdown or a newer attempt may have landed during the credential read; start nothing then.
        if (closed || clients.get(server.id) !== entry) throw new Error("MCP connection was closed or superseded.");
        const transport = server.transport === "stdio" ? new StdioClientTransport({ command: server.command!, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, stderr: "pipe" })
          : server.transport === "http" ? new StreamableHTTPClientTransport(new URL(server.url!), options) : new SSEClientTransport(new URL(server.url!), options);
        if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
        await client.connect(transport, { timeout: 10_000 });
        if (closed || clients.get(server.id) !== entry) throw new Error("MCP connection was closed or superseded.");
        entry.client = client;
        return client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    })();
    try { return await entry.pending; }
    catch (error) { if (clients.get(server.id) === entry) clients.delete(server.id); throw error; }
  }
  /** The complete guarded inventory for the server's current live client. */
  async function inventory(server: McpServer, signal?: AbortSignal): Promise<McpInventory & { client: Client }> {
    const client = await connection(server);
    const assertCurrent = () => { if (closed || clients.get(server.id)?.client !== client) throw new Error("MCP connection changed or was closed."); };
    // A shared (cached) read is bounded by the inventory deadline, not one caller's signal.
    const shared = client.getServerCapabilities()?.tools?.listChanged === true;
    const read = async (): Promise<McpInventory> => {
      // Each page is transport-bounded; this bounds what the whole inventory retains.
      let retained = 0;
      const tools = client.getServerCapabilities()?.tools ? await listMcpToolInventory({
        signal: shared ? undefined : signal, assertCurrent,
        listPage: async (cursor, pageSignal) => {
          const page = await listMcpToolPage(client, cursor, { signal: pageSignal, timeout: 10_000 });
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
    const { tools } = await inventory(server, signal);
    return tools.map((tool) => tagMcpAgentTool({ name: mcpAgentToolName(server, tool.name), label: `${server.name}: ${tool.name}`, description: [server.description, tool.description ?? tool.name].filter(Boolean).join("\n\n"),
      parameters: Type.Unsafe<Record<string, unknown>>(normalizeMcpToolInputSchema(tool.inputSchema)),
      execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
        const current = await inventory(server, signal);
        const fresh = current.tools.find(({ name }) => name === tool.name);
        if (JSON.stringify(fresh) !== JSON.stringify(tool)) throw new Error("MCP tool schema or effects changed. Refresh the connection before using it.");
        current.guard.assertCallable(tool.name);
        return executeMcpAgentTool(async () => {
          const result = await callMcpTool(current.client, { name: tool.name, arguments: input as Record<string, unknown> }, { signal, timeout: 60_000 });
          current.guard.validateResult(tool.name, result);
          return result;
        });
      },
    }, tool));
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

export function createMcpExtension(agentDir: string, options: { startupBudgetMs?: number } = {}): InlineExtension {
  return { name: "aiden-mcp", async factory(pi) {
    const pool = createCliMcpPool(agentDir);
    pi.on("session_shutdown", () => pool.close());
    pi.registerCommand("aiden-mcp", { description: "Configure MCP servers and inspect presets (login from a terminal)", handler: async (args, ctx) => {
      const parsed = splitArgs(args); if (parsed[0] === "login") throw new Error("Run aiden mcp login <id> in a terminal.");
      ctx.ui.notify(JSON.stringify(await mcpCommand(agentDir, parsed), null, 2), "info");
    } });
    let servers: McpServer[];
    try { servers = (await pool.listServers()).filter(({ enabled }) => enabled); }
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
