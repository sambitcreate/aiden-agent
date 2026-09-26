import { createBoundedSubagentMcpFetch } from "../../../main/services/subagents/subagent-mcp-bounded-fetch.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { McpServer } from "../../../main/services/types.js";
import { MCP_PRESETS, getMcpPreset, serverFromPreset, assertMcpPresetServer, createNoRedirectFetch } from "../../../main/services/mcp-presets.js";
import { mcpAgentToolName } from "../../../main/services/mcp-tool-identity.js";
import { executeMcpAgentTool } from "../../../main/services/mcp-tool-result.js";
import { JsonStore, splitArgs } from "./state.ts";
import { insightCredentials } from "./credentials.ts";

export const storeFor = (dir: string) => new JsonStore<McpServer[]>(join(dir, "mcp.json"), []);
export function validateMcpServer(value: unknown): McpServer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP server.");
  const server = value as McpServer;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(server.id) || typeof server.name !== "string" || !server.name.trim() || typeof server.enabled !== "boolean") throw new Error("MCP server needs an id, name, and enabled flag.");
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || !server.command.trim() || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")))) throw new Error("Invalid MCP stdio command or arguments.");
  } else if (server.transport === "http" || server.transport === "sse") {
    const url = new URL(server.url!);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Remote MCP needs HTTPS (HTTP is permitted on loopback only).");
  } else throw new Error("Unknown MCP transport.");
  for (const fields of [server.env, server.headers]) if (fields !== undefined && (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.values(fields).some((value) => typeof value !== "string"))) throw new Error("MCP env and headers must be string maps.");
  assertMcpPresetServer(server);
  return server;
}

export const mcpCredentialId = (server: McpServer) => `mcp-${createHash("sha256").update(`${server.id}\0${server.url}`).digest("hex")}`;
export async function mcpCredentialSignature(agentDir: string, server: McpServer) {
  return createHash("sha256").update(JSON.stringify({ server, oauth: await insightCredentials(agentDir).read(mcpCredentialId(server)) })).digest("hex");
}

interface OAuthState { tokens?: OAuthTokens; client?: OAuthClientInformationMixed; redirectUrl?: string; }
async function oauthProvider(agentDir: string, server: McpServer, interaction?: { redirectUrl: string; state: string; notify(url: URL): void }): Promise<OAuthClientProvider> {
  const credentials = insightCredentials(agentDir);
  const id = mcpCredentialId(server);
  const serialized = await credentials.read(id);
  const stored: OAuthState = serialized ? JSON.parse(serialized) : {};
  if (interaction) { delete stored.client; delete stored.tokens; stored.redirectUrl = interaction.redirectUrl; }
  let verifier: string | undefined;
  const save = () => credentials.write(id, JSON.stringify(stored));
  return {
    redirectUrl: stored.redirectUrl ?? "http://127.0.0.1/callback",
    clientMetadata: { client_name: "Aiden CLI", redirect_uris: [stored.redirectUrl ?? "http://127.0.0.1/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => interaction?.state ?? randomBytes(24).toString("hex"),
    clientInformation: () => stored.client,
    saveClientInformation: async (client) => { stored.client = client; await save(); },
    tokens: () => stored.tokens,
    saveTokens: async (tokens) => { stored.tokens = tokens; await save(); },
    redirectToAuthorization(url) { if (!interaction) throw new Error(`Sign in with aiden mcp login ${server.id}.`); interaction.notify(url); },
    saveCodeVerifier(value) { verifier = value; },
    codeVerifier() { if (!verifier) throw new Error("No active MCP OAuth verifier."); return verifier; },
    invalidateCredentials: async (scope) => { if (scope === "all" || scope === "tokens") delete stored.tokens; if (scope === "all" || scope === "client") delete stored.client; await save(); },
  };
}

export async function mcpLogin(agentDir: string, server: McpServer): Promise<void> {
  if (!server.oauth || !server.url) throw new Error("This server is not configured for OAuth.");
  const state = randomBytes(32).toString("hex");
  let finish: (value: string) => void = () => {};
  const code = new Promise<string>((resolve) => { finish = resolve; });
  const listener = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) { response.writeHead(400).end("Invalid OAuth callback."); return; }
    finish(url.searchParams.get("code")!); response.writeHead(200, { "content-type": "text/plain" }).end("Aiden received your sign-in. You can close this tab.");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = (listener.address() as import("node:net").AddressInfo).port;
    const provider = await oauthProvider(agentDir, server, { state, redirectUrl: `http://127.0.0.1:${port}/callback`, notify: (url) => process.stderr.write(`Open this URL to sign in:\n${url.href}\n`) });
    const fetchFn = createNoRedirectFetch();
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
  if (action === "remove") return store.update((servers) => { const index = servers.findIndex((server) => server.id === value); if (index < 0) throw new Error("MCP server not found."); servers.splice(index, 1); return { removed: value }; });
  if (action === "add" || action === "preset") {
    if (!value) throw new Error("Provide a server JSON file or preset id.");
    const preset = action === "preset" ? getMcpPreset(value) : undefined;
    if (action === "preset" && !preset) throw new Error("MCP preset not found.");
    const server = validateMcpServer(preset ? serverFromPreset(preset) : JSON.parse(readFileSync(value, "utf8")));
    return store.update((servers) => { const index = servers.findIndex((item) => item.id === server.id); if (index >= 0) servers[index] = server; else servers.push(server); return { saved: server.id }; });
  }
  throw new Error("Usage: mcp list|presets|add <file>|preset <id>|login <id>|remove <id>");
}

/** One process owns its transports. Discovery is bounded and refreshes schemas on every admission. */
export function createCliMcpPool(agentDir: string, maxResponseBytes = 8 * 1024 * 1024) {
  const clients = new Map<string, { signature: string; pending: Promise<Client> }>();
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
    const signature = await mcpCredentialSignature(agentDir, current);
    const cached = clients.get(server.id);
    if (cached?.signature === signature) return cached.pending;
    if (cached) await (await cached.pending.catch(() => undefined))?.close();
    const pending = (async () => {
      const client = new Client({ name: "aiden-cli", version: "0.1.0" });
      try {
        const options = { requestInit: { headers: server.headers }, fetch: createBoundedSubagentMcpFetch(createNoRedirectFetch(), maxResponseBytes), authProvider: server.oauth ? await oauthProvider(agentDir, server) : undefined };
        const transport = server.transport === "stdio" ? new StdioClientTransport({ command: server.command!, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, stderr: "pipe" })
          : server.transport === "http" ? new StreamableHTTPClientTransport(new URL(server.url!), options) : new SSEClientTransport(new URL(server.url!), options);
        if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
        await client.connect(transport, { timeout: 10_000 });
        if (closed) throw new Error("MCP runtime closed during connection.");
        return client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    })();
    clients.set(server.id, { signature, pending });
    try { return await pending; }
    catch (error) { if (clients.get(server.id)?.pending === pending) clients.delete(server.id); throw error; }
  }
  async function inspectTools(server: McpServer, signal?: AbortSignal) {
    const client = await connection(server);
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 10_000 });
      tools.push(...page.tools);
      if (tools.length > 128 || Buffer.byteLength(JSON.stringify(tools)) > 1_048_576 || new Set(tools.map(({ name }) => name)).size !== tools.length) throw new Error("MCP tool inventory exceeds its unique schema budget.");
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 32)) throw new Error("MCP pagination did not terminate.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }
  async function agentTools(server: McpServer, signal?: AbortSignal) {
    const inventory = await inspectTools(server, signal);
    return inventory.map((tool) => ({ name: mcpAgentToolName(server, tool.name), label: `${server.name}: ${tool.name}`, description: tool.description ?? tool.name,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (_id: string, input: unknown, signal?: AbortSignal) => {
        const fresh = (await inspectTools(server, signal)).find(({ name }) => name === tool.name);
        if (JSON.stringify(fresh) !== JSON.stringify(tool)) throw new Error("MCP tool schema or effects changed. Refresh the connection before using it.");
        const client = await connection(server);
        return executeMcpAgentTool(() => client.callTool({ name: tool.name, arguments: input as Record<string, unknown> }, undefined, { signal, timeout: 60_000 }));
      },
    }));
  }
  return { listServers, inspectTools, agentTools, connection, async close() {
    closed = true;
    await Promise.allSettled([...clients.values()].map(async ({ pending }) => (await pending).close()));
    clients.clear();
  } };
}

export function createMcpExtension(agentDir: string): InlineExtension {
  return { name: "aiden-mcp", async factory(pi) {
    const pool = createCliMcpPool(agentDir);
    pi.on("session_shutdown", () => pool.close());
    pi.registerCommand("mcp", { description: "Configure MCP servers and inspect presets (login from a terminal)", handler: async (args, ctx) => {
      const parsed = splitArgs(args); if (parsed[0] === "login") throw new Error("Run aiden mcp login <id> in a terminal.");
      ctx.ui.notify(JSON.stringify(await mcpCommand(agentDir, parsed), null, 2), "info");
    } });
    for (const server of (await pool.listServers()).filter(({ enabled }) => enabled)) {
      try { for (const tool of await pool.agentTools(server)) pi.registerTool(tool); }
      catch { process.stderr.write(`aiden: MCP ${server.id} unavailable. Check its configuration or sign in.\n`); }
    }
  } };
}
