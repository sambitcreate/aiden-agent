import { inspectInitializedMcpStatus } from "./mcp-status.js";
import type { McpStatus } from "../../renderer/shared/mcp-status.js";
import { snapshotMcpServerInstructions, type McpServerInstructionSnapshot } from "./mcp-server-instructions.js";
// MCP connection manager. Connects to user-configured MCP servers (stdio / HTTP
// / SSE) via the official MCP SDK, caches clients, and exposes their tools as
// pi agent tools for the generation loop.

import { createMcpResourceTool } from "./mcp-resources.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { projectDiagnosticError } from "./diagnostics-contract.js";
import { writeDiagnosticEvent } from "./diagnostic-journal.js";
import { oauthProviderFor } from "./mcp-oauth.js";
import { mcpApiKeyHeaderValue } from "./mcp-oauth-client-metadata.js";
import {
  assertMcpPresetServer,
  presetSecretId,
} from "./mcp-presets.js";
import { secrets } from "./secrets.js";
import type { McpServer } from "./types.js";
import { executeMcpAgentTool } from "./mcp-tool-result.js";
import { markToolOutputSource } from "./tool-output-context.js";
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
import { mcpAgentToolName } from "./mcp-tool-identity.js";
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
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";
import { MAX_MCP_RESPONSE_BYTES } from "./mcp-fetch-policy.js";
import { normalizeMcpToolInputSchema } from "./mcp-tool-schema.js";
import {
  MCP_DISCOVERY_DEADLINES,
  MCP_TOOL_CALL_TIMEOUT_MS,
  McpConnectionActivity,
  McpToolListCache,
  mcpRequestDeadline,
  mcpServerDiscoveryBudgetMs,
  mergeMcpServerDiscovery,
  raceDeadline,
  settleMcpServerDiscovery,
} from "./mcp-tool-discovery-core.js";

/** Cached connections with no activity for this long are closed. */
const MCP_IDLE_CONNECTION_MS = 10 * 60_000;
const MCP_IDLE_SWEEP_MS = 60_000;

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
      `${preset.name} needs an API key — add one in Settings → Plugins.`,
    );
  return {
    ...server,
    headers: {
      ...server.headers,
      [preset.auth.headerName]: mcpApiKeyHeaderValue(key, preset.auth.headerValuePrefix),
    },
  };
}

function makeTransport(
  server: McpServer,
  isCurrent: () => boolean = () => true,
  options: {
    forceNoRedirect?: boolean;
    onTerminalFailure?: () => void;
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
      maxBufferSize: MAX_MCP_RESPONSE_BYTES,
      args: server.args ?? [],
      env: {
        ...(process.env as Record<string, string>),
        ...(server.env ?? {}),
      },
    });
  }
  if (!server.url) throw new Error("This MCP server needs a URL.");
  assertMcpPresetServer(server);
  const guardedFetch = options.forceNoRedirect
    ? createBoundedSubagentMcpFetch()
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
  return createMcpRemoteTransport({
    transport: server.transport,
    serviceUrl: server.url,
    serviceHeaders: server.headers,
    isCurrent,
    authProvider,
    fetch: guardedFetch,
    onTerminalFailure: options.onTerminalFailure,
  });
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

type ResourceClient = Pick<Client, "listResources" | "listResourceTemplates" | "readResource">;

class McpManager {
  private readonly clients = new GenerationBoundConnectionCache<Client>();
  private readonly statusClients =
    new GenerationBoundConnectionAttempts<Client>();
  private readonly toolLists = new McpToolListCache();
  private readonly activity = new McpConnectionActivity();
  private readonly disconnecting = new Set<Promise<void>>();
  private idleSweep: ReturnType<typeof setInterval> | undefined;

  private async ensureConnected(
    server: McpServer,
    generation: number,
  ): Promise<Client> {
    const client = await this.clients.getOrConnect(
      server.id,
      () =>
        new Client(
          { name: "aiden-agent", version: "1.0.0" },
          { capabilities: {} },
        ),
      async (client, connectionIsCurrent, onClosed) => {
        // Register before connect: closure during initialization must also
        // prevent a dead client from being published to the cache.
        client.onclose = onClosed;
        this.toolLists.attach(client);
        // The MCP SDK transports satisfy the client's transport interface.
        await client.connect(
          makeTransport(
            await resolveAuth(server, connectionIsCurrent),
            connectionIsCurrent,
            { onTerminalFailure: onClosed },
          ) as never,
          mcpRequestDeadline(MCP_DISCOVERY_DEADLINES.connectMs),
        );
      },
      async (client) => client.close(),
      generation,
    );
    this.activity.touch(server.id);
    this.scheduleIdleSweep();
    return client;
  }

  /**
   * Run one request against this generation's client. Idle expiry may have
   * closed it without superseding the generation, so reconnect transparently;
   * a configuration change still fails the call as superseded.
   */
  private async withLiveClient<R>(
    server: McpServer,
    generation: number,
    client: Client,
    request: (client: Client) => Promise<R>,
  ): Promise<R> {
    const end = this.activity.begin(server.id);
    try {
      const live = this.clients.isConnected(server.id, client)
        ? client
        : await this.ensureConnected(server, generation);
      return await request(live);
    } finally {
      end();
    }
  }

  private scheduleIdleSweep(): void {
    if (this.idleSweep) return;
    this.idleSweep = setInterval(
      () => void this.closeIdleConnections(),
      MCP_IDLE_SWEEP_MS,
    );
    this.idleSweep.unref?.();
  }

  private stopIdleSweep(): void {
    if (this.idleSweep) clearInterval(this.idleSweep);
    this.idleSweep = undefined;
  }

  async closeIdleConnections(): Promise<void> {
    const idle = this.activity.idle(this.clients.connectedIds(), MCP_IDLE_CONNECTION_MS);
    await Promise.all(idle.map((id) => this.clients.closeIdle(id)));
    if (this.clients.ids().length === 0) this.stopIdleSweep();
  }

  disconnect(id: string): Promise<void> {
    const closing = Promise.all([
      this.clients.disconnect(id),
      this.statusClients.disconnect(id),
    ]).then(() => undefined);
    this.disconnecting.add(closing);
    void closing
      .finally(() => this.disconnecting.delete(closing))
      .catch(() => undefined);
    return closing;
  }

  /** Disconnect a removed server and drop its per-id bookkeeping. */
  async forget(id: string): Promise<void> {
    await Promise.all([this.clients.forget(id), this.statusClients.forget(id)]);
    this.activity.forget(id);
  }

  /** Close every server in parallel, including closes already under way. */
  async closeAll(): Promise<void> {
    for (const id of new Set([
      ...this.clients.ids(),
      ...this.statusClients.ids(),
    ])) {
      void this.disconnect(id);
    }
    this.stopIdleSweep();
    await Promise.allSettled([...this.disconnecting]);
  }

  /** Shutdown variant: resolves false instead of waiting past `budgetMs`. */
  closeAllWithin(budgetMs: number): Promise<boolean> {
    return raceDeadline(this.closeAll(), budgetMs, "MCP shutdown").then(
      () => true,
      () => false,
    );
  }

  /** Connect and return status (used by the settings "test" action). */
  async status(
    server: McpServer,
    isCurrent: () => boolean = () => true,
    expectedGeneration: number = this.statusGeneration(server.id),
  ): Promise<McpStatus> {
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
        (client, connectionIsCurrent) =>
          inspectInitializedMcpStatus(client, () => isCurrent() && connectionIsCurrent()),
        async (client) => client.close(),
      );
    } catch (error) {
      return {
        connected: false,
        serverCapabilities: null,
        toolCount: 0,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Build pi agent tools for a connected server. Tool names are prefixed with the server name. */
  async agentContextFor(
    server: McpServer,
    generation: number,
  ): Promise<{ tools: AgentTool[]; instructions?: McpServerInstructionSnapshot }> {
    const lease = mcpConfigurationLeases.acquire(server.id);
    const client = await this.ensureConnected(server, generation);
    lease.assertCurrent();
    // Cached per connected client until the server announces a change.
    const tools = await this.toolLists.list(client, MCP_DISCOVERY_DEADLINES.listMs);
    lease.assertCurrent();
    const agentTools = tools.map((t): AgentTool => markToolOutputSource({
      name: mcpAgentToolName(server, t.name),
      label: t.name,
      description: t.description ?? t.name,
      // MCP inputSchema is raw JSON Schema; normalize provider-hostile numeric
      // formats (schemars `uint32`, `int8`, ...) and wrap it as a typebox schema.
      parameters: Type.Unsafe(
        normalizeMcpToolInputSchema((t.inputSchema as object) ?? { type: "object", properties: {} }),
      ),
      execute: async (_id, args, signal): Promise<AgentToolResult<null>> => {
        return executeMcpAgentTool(() =>
          this.withLiveClient(server, generation, client, (live) =>
            live.callTool(
              {
                name: t.name,
                arguments: (args ?? {}) as Record<string, unknown>,
              },
              undefined,
              {
                signal,
                timeout: MCP_TOOL_CALL_TIMEOUT_MS,
                maxTotalTimeout: MCP_TOOL_CALL_TIMEOUT_MS,
              },
            ),
          ),
        );
      },
    }));
    if (client.getServerCapabilities()?.resources) {
      const live = <R,>(request: (client: Client) => Promise<R>) =>
        this.withLiveClient(server, generation, client, request);
      const resourceClient: ResourceClient = {
        listResources: (...args) => live((c) => c.listResources(...args)),
        listResourceTemplates: (...args) => live((c) => c.listResourceTemplates(...args)),
        readResource: (...args) => live((c) => c.readResource(...args)),
      };
      agentTools.push(createMcpResourceTool(server, resourceClient, lease));
    }
    return { tools: agentTools, instructions: snapshotMcpServerInstructions(server, agentTools, client.getInstructions()) };
  }

  connectionGeneration(id: string): number {
    return this.clients.generation(id);
  }

  statusGeneration(id: string): number {
    return this.statusClients.generation(id);
  }
}

export const mcpManager = new McpManager();

/**
 * Merge tools from enabled servers. Servers are discovered concurrently, each
 * within its own deadline, so one slow or hung server only loses its tools for
 * this turn. Strict callers fail closed instead of silently losing access.
 */
export async function collectMcpAgentTools(
  servers: McpServer[],
  options: { strict?: boolean; onServerInstructions?: (snapshot: McpServerInstructionSnapshot) => void } = {},
): Promise<AgentTool[]> {
  const enabled = servers.filter((server) => server.enabled);
  const settled = await settleMcpServerDiscovery(
    enabled,
    (server) => {
      let generation = 0;
      return withConfiguredMcp(
        server.id,
        mcpRuntimeConnectionSnapshot(server),
        () => mcpManager.agentContextFor(server, generation),
        () => true,
        () => {
          generation = mcpManager.connectionGeneration(server.id);
        },
      );
    },
    mcpServerDiscoveryBudgetMs(),
  );
  return mergeMcpServerDiscovery(enabled, settled, {
    strict: options.strict,
    onServerInstructions: options.onServerInstructions,
    onUnavailable: (_server, error) => {
      // A skipped server, including one that missed its deadline, is surfaced
      // as degraded MCP status in diagnostics rather than failing the turn.
      const projected = projectDiagnosticError(error);
      writeDiagnosticEvent({
        level: "warn",
        area: "mcp",
        event: "mcp-degraded",
        outcome: projected.code === "cancelled" ? "cancelled" : "degraded",
        code: projected.code,
        fields: {
          errorType: projected.errorType,
          ...(projected.fingerprint ? { fingerprint: projected.fingerprint } : {}),
          ...(projected.causeCode ? { causeCode: projected.causeCode } : {}),
          ...(projected.httpStatus === undefined ? {} : { httpStatus: projected.httpStatus }),
          failurePhase: "mcp-tool-discovery",
        },
      });
    },
  });
}
