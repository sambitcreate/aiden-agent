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
import {
  assertMcpPresetServer,
  createNoRedirectFetch,
  presetSecretId,
} from "./mcp-presets.js";
import { secrets } from "./secrets.js";
import type { McpServer } from "./types.js";
import { executeMcpAgentTool } from "./mcp-tool-result.js";
import { configStore } from "./config-store.js";
import {
  mcpCredentialConnectionSnapshot,
  mcpRuntimeConnectionSnapshot,
} from "./mcp-credential-cleanup-core.js";
import {
  reconcilePendingMcpCredentialCleanup,
  withConfiguredMcp,
} from "./mcp-credential-cleanup.js";
import {
  GenerationBoundConnectionAttempts,
  GenerationBoundConnectionCache,
} from "./generation-bound-connection-cache.js";
import {
  assertUniqueMcpAgentToolNames,
  mcpAgentToolName,
} from "./mcp-tool-identity.js";
import {
  withIsolatedSubagentMcpClientCore,
  type IsolatedSubagentMcpSdkClient,
} from "./subagents/subagent-mcp-client-core.js";
import { createBoundedSubagentMcpFetch } from "./subagents/subagent-mcp-bounded-fetch.js";
import { resolveProductionSubagentMcpCredentialBoundary } from "./subagents/subagent-mcp-credential-production.js";
import {
  createSubagentMcpOAuthTokenObserver,
  type SubagentMcpCredentialRedactor,
} from "./subagents/subagent-mcp-credential-core.js";
import type {
  SubagentMcpClientPort,
  SubagentMcpReadHost,
  SubagentMcpRemoteTool,
} from "./subagents/subagent-mcp-read.js";
import { mcpConfigurationLeases } from "./mcp-config-lease.js";

interface Transport {
  close?: () => Promise<void>;
}

/**
 * Resolve a server record into connection-ready form. For built-in presets
 * authenticated by API key, the key lives in the encrypted secrets store
 * (never in config.json) and is injected as the preset's auth header here.
 */
async function resolveAuth(
  server: McpServer,
  isCurrent: () => boolean = () => true,
): Promise<McpServer> {
  if (!isCurrent())
    throw new Error("The renderer document is no longer active.");
  const preset = assertMcpPresetServer(server);
  if (!preset || preset.auth.kind !== "apiKey") return server;
  await reconcilePendingMcpCredentialCleanup();
  const key = await secrets.getOrBindLegacyProviderKey(
    presetSecretId(server.id),
    JSON.stringify(mcpCredentialConnectionSnapshot(server)),
  );
  if (!isCurrent())
    throw new Error("The renderer document is no longer active.");
  if (!key)
    throw new Error(
      `${preset.name} needs an API key — add one in Settings → MCP Servers.`,
    );
  return {
    ...server,
    headers: { ...server.headers, [preset.auth.headerName]: key },
  };
}

function makeTransport(
  server: McpServer,
  isCurrent: () => boolean = () => true,
  options: {
    forceNoRedirect?: boolean;
    registerCredentialRedactor?: (
      redactor: SubagentMcpCredentialRedactor,
    ) => void;
  } = {},
): Transport {
  if (server.transport === "stdio") {
    if (!server.command)
      throw new Error("This MCP server needs a command to run.");
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: {
        ...(process.env as Record<string, string>),
        ...(server.env ?? {}),
      },
    });
  }
  if (!server.url) throw new Error("This MCP server needs a URL.");
  const preset = assertMcpPresetServer(server);
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  const guardedFetch = options.forceNoRedirect
    ? createBoundedSubagentMcpFetch()
    : preset?.auth.kind === "apiKey"
      ? createNoRedirectFetch()
      : undefined;
  // OAuth-authenticated servers attach a (non-interactive) provider that supplies
  // stored tokens; if none/expired, the connection fails rather than opening a browser.
  const observeOAuthTokens = options.registerCredentialRedactor
    ? createSubagentMcpOAuthTokenObserver(options.registerCredentialRedactor)
    : undefined;
  const authProvider = server.oauth
    ? oauthProviderFor(server, isCurrent, (tokens) =>
        observeOAuthTokens?.(
          tokens as unknown as Readonly<Record<string, unknown>>,
        ),
      )
    : undefined;
  if (server.transport === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      authProvider,
      fetch: guardedFetch,
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    authProvider,
    fetch: guardedFetch,
  });
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function subagentMcpAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("MCP read cancelled.");
}

/**
 * Main-process credential/transport proxy for the read-only subagent lane.
 * A fresh client is closed after each bounded operation so no authenticated
 * client or credential-bearing transport crosses into child-owned state.
 */
export async function withIsolatedSubagentMcpClient<T>(
  server: McpServer,
  signal: AbortSignal,
  operation: (client: SubagentMcpClientPort) => Promise<T>,
): Promise<T> {
  const configurationLease = mcpConfigurationLeases.acquire(server.id);
  configurationLease.assertCurrent();
  const operationSignal = AbortSignal.any([signal, configurationLease.signal]);
  return withIsolatedSubagentMcpClientCore({
    server,
    signal: operationSignal,
    configurationLease,
    operation,
    dependencies: {
      createClient: () =>
        new Client(
          { name: "aiden-subagent-mcp-read", version: "1.0.0" },
          { capabilities: {} },
        ) as unknown as IsolatedSubagentMcpSdkClient,
      resolveAuth,
      resolveCredentialBoundary: resolveProductionSubagentMcpCredentialBoundary,
      makeTransport,
      withConfigured: (expected, configuredOperation, isCurrent) =>
        withConfiguredMcp(
          expected.id,
          mcpRuntimeConnectionSnapshot(expected),
          configuredOperation,
          isCurrent,
        ),
    },
  });
}

/** Main-owned resolver plus isolated credential proxy for subagent MCP reads. */
export const productionSubagentMcpReadHost: SubagentMcpReadHost = Object.freeze(
  {
    resolveServer: async (serverId: string, signal: AbortSignal) => {
      if (signal.aborted) throw subagentMcpAbortReason(signal);
      const server = (await configStore.listMcpServers()).find(
        ({ id }) => id === serverId,
      );
      if (signal.aborted) throw subagentMcpAbortReason(signal);
      return server === undefined ? undefined : structuredClone(server);
    },
    withClient: withIsolatedSubagentMcpClient,
  },
);

function botMcpRequestOptions(signal: AbortSignal) {
  return { signal, timeout: 10_000, maxTotalTimeout: 10_000 };
}

/**
 * Fresh metadata inspection through the same transports and authentication as
 * ordinary Aiden MCP. Unlike subagent discovery this intentionally supports
 * stdio and does not apply subagent authority limits or cache entries.
 */
export async function inspectConfiguredMcpToolsForBotCatalog(
  server: McpServer,
  signal: AbortSignal,
): Promise<readonly SubagentMcpRemoteTool[]> {
  const lease = mcpConfigurationLeases.acquire(server.id);
  const operationSignal = AbortSignal.any([signal, lease.signal]);
  const isCurrent = () => {
    lease.assertCurrent();
    if (operationSignal.aborted) throw subagentMcpAbortReason(operationSignal);
    return true;
  };
  return withConfiguredMcp(
    server.id,
    mcpRuntimeConnectionSnapshot(server),
    async () => {
      const client = new Client(
        { name: "aiden-bot-mcp-catalog", version: "1.0.0" },
        { capabilities: {} },
      );
      try {
        await client.connect(
          makeTransport(await resolveAuth(server, isCurrent), isCurrent) as never,
          botMcpRequestOptions(operationSignal),
        );
        isCurrent();
        const { tools } = await client.listTools(
          undefined,
          botMcpRequestOptions(operationSignal),
        );
        isCurrent();
        return tools.map(({ name, description, inputSchema, outputSchema, annotations, execution }) => ({
          name,
          ...(description === undefined ? {} : { description }),
          ...(inputSchema === undefined ? {} : { inputSchema }),
          ...(outputSchema === undefined ? {} : { outputSchema }),
          ...(annotations === undefined ? {} : { annotations }),
          ...(execution === undefined ? {} : { execution }),
        }));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    isCurrent,
  );
}

class McpManager {
  private readonly clients = new GenerationBoundConnectionCache<Client>();
  private readonly statusClients =
    new GenerationBoundConnectionAttempts<Client>();

  private async ensureConnected(
    server: McpServer,
    generation: number,
  ): Promise<Client> {
    return this.clients.getOrConnect(
      server.id,
      () =>
        new Client(
          { name: "aiden-agent", version: "1.0.0" },
          { capabilities: {} },
        ),
      async (client, connectionIsCurrent) => {
        // The MCP SDK transports satisfy the client's transport interface.
        await client.connect(
          makeTransport(
            await resolveAuth(server, connectionIsCurrent),
            connectionIsCurrent,
          ) as never,
        );
      },
      async (client) => client.close(),
      generation,
    );
  }

  async disconnect(id: string): Promise<void> {
    await Promise.all([
      this.clients.disconnect(id),
      this.statusClients.disconnect(id),
    ]);
  }

  async closeAll(): Promise<void> {
    for (const id of new Set([
      ...this.clients.ids(),
      ...this.statusClients.ids(),
    ])) {
      await this.disconnect(id);
    }
  }

  /** Connect and return status (used by the settings "test" action). */
  async status(
    server: McpServer,
    isCurrent: () => boolean = () => true,
    expectedGeneration: number = this.statusGeneration(server.id),
  ): Promise<{
    connected: boolean;
    toolCount: number;
    tools: string[];
    error?: string;
  }> {
    try {
      return await this.statusClients.run(
        server.id,
        expectedGeneration,
        () =>
          new Client(
            { name: "aiden-agent-test", version: "1.0.0" },
            { capabilities: {} },
          ),
        async (client, connectionIsCurrent) => {
          const active = () => isCurrent() && connectionIsCurrent();
          await client.connect(
            makeTransport(await resolveAuth(server, active), active) as never,
          );
        },
        async (client, connectionIsCurrent) => {
          if (!isCurrent() || !connectionIsCurrent()) {
            throw new Error("The MCP connection was superseded.");
          }
          const { tools } = (await client.listTools()) as {
            tools: McpToolInfo[];
          };
          return {
            connected: true,
            toolCount: tools.length,
            tools: tools.map((t) => t.name),
          };
        },
        async (client) => client.close(),
      );
    } catch (error) {
      return {
        connected: false,
        toolCount: 0,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Build pi agent tools for a connected server. Tool names are prefixed with the server name. */
  async agentToolsFor(
    server: McpServer,
    generation: number,
  ): Promise<AgentTool[]> {
    const client = await this.ensureConnected(server, generation);
    const { tools } = (await client.listTools()) as { tools: McpToolInfo[] };
    return tools.map((t): AgentTool => ({
      name: mcpAgentToolName(server, t.name),
      label: t.name,
      description: t.description ?? t.name,
      // MCP inputSchema is raw JSON Schema; wrap it as a typebox schema.
      parameters: Type.Unsafe(
        (t.inputSchema as object) ?? { type: "object", properties: {} },
      ),
      execute: async (_id, args, signal): Promise<AgentToolResult<null>> => {
        return executeMcpAgentTool(() =>
          client.callTool(
            {
              name: t.name,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            undefined,
            { signal },
          ),
        );
      },
    }));
  }

  connectionGeneration(id: string): number {
    return this.clients.generation(id);
  }

  statusGeneration(id: string): number {
    return this.statusClients.generation(id);
  }
}

export const mcpManager = new McpManager();

/** Merge tools from enabled servers. Strict callers fail closed instead of silently losing access. */
export async function collectMcpAgentTools(
  servers: McpServer[],
  options: { strict?: boolean } = {},
): Promise<AgentTool[]> {
  const all: AgentTool[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    try {
      let generation = 0;
      const serverTools = await withConfiguredMcp(
        server.id,
        mcpRuntimeConnectionSnapshot(server),
        () => mcpManager.agentToolsFor(server, generation),
        () => true,
        () => {
          generation = mcpManager.connectionGeneration(server.id);
        },
      );
      assertUniqueMcpAgentToolNames([...all, ...serverTools]);
      all.push(...serverTools);
    } catch (error) {
      if (options.strict) {
        throw new Error(
          `MCP server "${server.name}" is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      logger.warn(
        "mcp",
        `Skipping MCP server "${server.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (options.strict && servers.length > 0 && all.length === 0) {
    throw new Error("The approved MCP servers did not provide any tools.");
  }
  return all;
}
