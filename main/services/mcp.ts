// MCP connection manager. Connects to user-configured MCP servers (stdio / HTTP
// / SSE) via the official MCP SDK, caches clients, and exposes their tools as
// pi agent tools for the generation loop.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { logger } from "../platform.js";
import { oauthProviderFor } from "./mcp-oauth.js";
import type { McpServer } from "./types.js";

interface Transport {
  close?: () => Promise<void>;
}

function makeTransport(server: McpServer): Transport {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("This MCP server needs a command to run.");
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
    });
  }
  if (!server.url) throw new Error("This MCP server needs a URL.");
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  // OAuth-authenticated servers attach a (non-interactive) provider that supplies
  // stored tokens; if none/expired, the connection fails rather than opening a browser.
  const authProvider = server.oauth ? oauthProviderFor(server.id) : undefined;
  if (server.transport === "sse") {
    return new SSEClientTransport(url, { requestInit, authProvider });
  }
  return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function toText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(r?.content)) {
    const text = r.content
      .map((c) => (c.type === "text" ? c.text : undefined))
      .filter((t): t is string => Boolean(t))
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(result);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

class McpManager {
  private clients = new Map<string, Client>();

  private async ensureConnected(server: McpServer): Promise<Client> {
    const existing = this.clients.get(server.id);
    if (existing) return existing;
    const client = new Client({ name: "aiden-agent", version: "1.0.0" }, { capabilities: {} });
    // The MCP SDK transports satisfy the client's transport interface.
    await client.connect(makeTransport(server) as never);
    this.clients.set(server.id, client);
    return client;
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    for (const [id] of this.clients) await this.disconnect(id);
  }

  /** Connect and return status (used by the settings "test" action). */
  async status(server: McpServer): Promise<{ connected: boolean; toolCount: number; tools: string[]; error?: string }> {
    const client = new Client({ name: "aiden-agent-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(makeTransport(server) as never);
      const { tools } = (await client.listTools()) as { tools: McpToolInfo[] };
      return { connected: true, toolCount: tools.length, tools: tools.map((t) => t.name) };
    } catch (error) {
      return { connected: false, toolCount: 0, tools: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** Build pi agent tools for a connected server. Tool names are prefixed with the server name. */
  async agentToolsFor(server: McpServer): Promise<AgentTool[]> {
    const client = await this.ensureConnected(server);
    const { tools } = (await client.listTools()) as { tools: McpToolInfo[] };
    const prefix = sanitize(server.name || server.id);
    return tools.map((t): AgentTool => ({
      name: `${prefix}__${sanitize(t.name)}`,
      label: t.name,
      description: t.description ?? t.name,
      // MCP inputSchema is raw JSON Schema; wrap it as a typebox schema.
      parameters: Type.Unsafe((t.inputSchema as object) ?? { type: "object", properties: {} }),
      execute: async (_id, args): Promise<AgentToolResult<null>> => {
        const result = await client.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> });
        return { content: [{ type: "text", text: toText(result) }], details: null };
      },
    }));
  }
}

export const mcpManager = new McpManager();

/** Merge tools from all enabled servers, skipping any that fail to connect. */
export async function collectMcpAgentTools(servers: McpServer[]): Promise<AgentTool[]> {
  const all: AgentTool[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    try {
      all.push(...(await mcpManager.agentToolsFor(server)));
    } catch (error) {
      logger.warn("mcp", `Skipping MCP server "${server.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return all;
}
