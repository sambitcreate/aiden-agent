import { mcpProviderAuthenticatedFetch } from "./mcp-provider-auth.js";
import { admitMcpProviderAuthServers, withMcpProviderOperation, type McpProviderExecutionScope } from "./mcp-provider-auth-core.js";
import { inspectInitializedMcpStatus } from "./mcp-status.js";
import { createMcpToolCallGuard, listMcpToolInventory } from "./mcp-tool-inventory.js";
import { createHash } from "node:crypto";
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
import { createMcpRemoteTransport } from "./mcp-remote-transport.js";
import { MAX_MCP_RESPONSE_BYTES } from "./mcp-fetch-policy.js";
import { normalizeMcpToolInputSchema } from "./mcp-tool-schema.js";

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
    signal?: AbortSignal;
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
  if (server.authProvider && options.forceNoRedirect) throw new Error("Provider-authenticated MCP is unavailable to child agents.");
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
    signal: options.signal,
    serviceUrl: server.url,
    serviceHeaders: server.headers,
    isCurrent,
    authProvider,
    fetch: server.authProvider ? mcpProviderAuthenticatedFetch(server, isCurrent) : guardedFetch,
    onTerminalFailure: options.onTerminalFailure,
  });
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execution?: unknown;
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
  if (server.authProvider) throw new Error("Provider-authenticated MCP is unavailable to Bots.");
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
        const tools = await listMcpToolInventory({
          signal: operationSignal,
          assertCurrent: isCurrent,
          listPage: (cursor, pageSignal) => client.listTools(cursor === undefined ? undefined : { cursor }, botMcpRequestOptions(pageSignal)),
        });
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
      async (client, connectionIsCurrent, onClosed) => {
        // Register before connect: closure during initialization must also
        // prevent a dead client from being published to the cache.
        client.onclose = onClosed;
        // The MCP SDK transports satisfy the client's transport interface.
        await client.connect(
          makeTransport(
            await resolveAuth(server, connectionIsCurrent),
            connectionIsCurrent,
            { onTerminalFailure: onClosed },
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
    providerScope?: McpProviderExecutionScope,
  ): Promise<{ tools: AgentTool[]; instructions?: McpServerInstructionSnapshot }> {
    const lease = mcpConfigurationLeases.acquire(server.id);
    if (server.authProvider && !providerScope) throw new Error("Provider-authenticated MCP requires a live attended operation.");
    const scoped = <R>(use: (client: Client, signal: AbortSignal) => Promise<R>, callerSignal?: AbortSignal): Promise<R> => withMcpProviderOperation({
      scope: {
        onInvalidated: providerScope!.onInvalidated,
        signal: AbortSignal.any([providerScope!.signal, lease.signal, ...(callerSignal ? [callerSignal] : [])]),
        isCurrent: () => { lease.assertCurrent(); return providerScope!.isCurrent(); },
      },
      create: () => new Client({ name: "aiden-agent-attended", version: "1.0.0" }, { capabilities: {} }),
      connect: async (client, signal, isCurrent) => {
        await client.connect(makeTransport(await resolveAuth(server, isCurrent), isCurrent, { signal }) as never, { signal });
      },
      use,
      close: async (client) => client.close(),
    });
    const cachedClient = server.authProvider ? undefined : await this.ensureConnected(server, generation);
    lease.assertCurrent();
    const inspect = async (client: Client, signal?: AbortSignal) => ({
      tools: client.getServerCapabilities()?.tools ? await listMcpToolInventory({
        signal: signal ? AbortSignal.any([lease.signal, signal]) : lease.signal,
        assertCurrent: () => {
          lease.assertCurrent();
          if (this.connectionGeneration(server.id) !== generation) throw new Error("The MCP connection was superseded.");
        },
        listPage: (cursor, pageSignal) => client.listTools(cursor === undefined ? undefined : { cursor }, { signal: pageSignal }),
      }) as McpToolInfo[] : [],
      resources: Boolean(client.getServerCapabilities()?.resources),
      instructions: client.getInstructions(),
    });
    const metadata = cachedClient ? await inspect(cachedClient) : await scoped(inspect);
    const client: Pick<Client, "callTool" | "listResources" | "listResourceTemplates" | "readResource"> = cachedClient ?? {
      callTool: (params, schema, options) => scoped((connection, signal) => connection.callTool(params, schema, { ...options, signal }), options?.signal),
      listResources: (params, options) => scoped((connection, signal) => connection.listResources(params, { ...options, signal }), options?.signal),
      listResourceTemplates: (params, options) => scoped((connection, signal) => connection.listResourceTemplates(params, { ...options, signal }), options?.signal),
      readResource: (params, options) => scoped((connection, signal) => connection.readResource(params, { ...options, signal }), options?.signal),
    };
    const { tools } = metadata;
    lease.assertCurrent();
    const callGuard = createMcpToolCallGuard(tools);
    const agentTools = tools.map((t): AgentTool => markToolOutputSource(Object.assign<AgentTool, { codemode: boolean }>({
      name: mcpAgentToolName(server, t.name),
      label: t.name,
      description: t.description ?? t.name,
      // MCP inputSchema is raw JSON Schema; normalize provider-hostile numeric
      // formats (schemars `uint32`, `int8`, ...) and wrap it as a typebox schema.
      parameters: Type.Unsafe(
        normalizeMcpToolInputSchema((t.inputSchema as object) ?? { type: "object", properties: {} }),
      ),
      execute: async (_id, args, signal): Promise<AgentToolResult<null>> => {
        return executeMcpAgentTool(async () => {
          lease.assertCurrent();
          signal?.throwIfAborted();
          callGuard.assertCallable(t.name);
          const result = await client.callTool(
            {
              name: t.name,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            undefined,
            { signal },
          );
          callGuard.validateResult(t.name, result);
          return result;
        });
      },
    }, { codemode: true })));
    if (metadata.resources) {
      agentTools.push(createMcpResourceTool(server, client, lease));
    }
    const instructions = snapshotMcpServerInstructions(server, agentTools, metadata.instructions);
    for (const tool of agentTools) Object.assign(tool, {
      codemode: true,
      discovery: {
        ...(server.description ? { description: server.description.slice(0, 1024) } : {}),
        namespace: `mcp:${createHash("sha256").update(server.id).digest("hex").slice(0, 24)}`,
        label: server.name.slice(0, 64) || "MCP service",
        ...(instructions ? { instructions: instructions.instructions } : {}),
      },
    });
    return { tools: agentTools, instructions };
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
  options: { strict?: boolean; allowProviderAuth?: boolean; providerScope?: McpProviderExecutionScope; onServerInstructions?: (snapshot: McpServerInstructionSnapshot) => void } = {},
): Promise<AgentTool[]> {
  const all: AgentTool[] = [];
  for (const server of admitMcpProviderAuthServers(servers, options.allowProviderAuth === true && options.providerScope !== undefined, options.strict === true)) {
    if (!server.enabled) continue;
    try {
      let generation = 0;
      const serverContext = await withConfiguredMcp(
        server.id,
        mcpRuntimeConnectionSnapshot(server),
        () => mcpManager.agentContextFor(server, generation, options.providerScope),
        () => true,
        () => {
          generation = mcpManager.connectionGeneration(server.id);
        },
      );
      assertUniqueMcpAgentToolNames([...all, ...serverContext.tools]);
      all.push(...serverContext.tools);
      if (serverContext.instructions) options.onServerInstructions?.(serverContext.instructions);
    } catch (error) {
      if (options.strict) {
        throw new Error(
          `MCP server "${server.name}" is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
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
    }
  }
  if (options.strict && servers.length > 0 && all.length === 0) {
    throw new Error("The approved MCP servers did not provide any tools.");
  }
  return all;
}
