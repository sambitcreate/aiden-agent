import { mcpProviderAuthenticatedFetch } from "./mcp-provider-auth.js";
import { admitMcpProviderAuthServers, withMcpProviderOperation, type McpProviderExecutionScope } from "./mcp-provider-auth-core.js";
import { inspectInitializedMcpStatus } from "./mcp-status.js";
import { boundedMcpToolPageReader, callMcpTool, callMcpToolOnLiveClient, createMcpToolCallGuard, createMcpToolInventoryCache, guardedMcpToolCall, listMcpToolInventory, listMcpToolPage, MCP_TOOL_INVENTORY_TTL_MS } from "./mcp-tool-inventory.js";
import { createHash } from "node:crypto";
import type { McpStatus } from "../../renderer/shared/mcp-status.js";
import { snapshotMcpServerInstructions, type McpServerInstructionSnapshot } from "./mcp-server-instructions.js";
// MCP connection manager. Connects to user-configured MCP servers (stdio / HTTP
// / SSE) via the official MCP SDK, caches clients, and exposes their tools as
// pi agent tools for the generation loop.

import { createMcpResourceTool, listMcpResourcesPage, listMcpResourceTemplatesPage } from "./mcp-resources.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpStdioTransport } from "./mcp-stdio-transport.js";
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
import { mcpRemoteToolDescriptor, tagMcpAgentTool } from "./mcp-agent-tool-descriptor.js";
import {
  admitMcpServerDiscovery,
  asMcpDeadlineError,
  connectMcpWithinDeadline,
  MCP_DEFERRED_ADMISSION_WINDOW_MS,
  MCP_DISCOVERY_DEADLINES,
  MCP_TOOL_CALL_TIMEOUT_MS,
  McpBuiltToolsMemo,
  McpConnectionActivity,
  McpPrewarmer,
  McpRecentFailures,
  mcpRequestDeadline,
  mcpServerDiscoveryBudgetMs,
  mergeMcpServerDiscovery,
  raceDeadline,
  settleMcpServerDiscovery,
  type McpLateDiscovery,
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
    // Only the SDK's safe default environment plus the server's declared env:
    // Aiden's own environment (tokens, proxy secrets) never reaches the child.
    return createMcpStdioTransport({
      command: server.command,
      maxBufferSize: MAX_MCP_RESPONSE_BYTES,
      args: server.args ?? [],
      env: server.env ?? {},
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
      createClient: () => {
        const client = new Client(
          { name: "aiden-subagent-mcp-read", version: "1.0.0" },
          { capabilities: {} },
        );
        return {
          connect: (transport, options) => client.connect(transport as Parameters<Client["connect"]>[0], options),
          close: () => client.close(),
          listTools: (params, options) => client.listTools(params, options),
          callTool: (params, _schema, options) => callMcpTool(client, params, options),
        } satisfies IsolatedSubagentMcpSdkClient;
      },
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
        // Bound the whole attempt (credential resolution and transport start
        // included), not only initialize.
        await connectMcpWithinDeadline(
          (async () => client.connect(
            makeTransport(await resolveAuth(server, isCurrent), isCurrent) as never,
            botMcpRequestOptions(operationSignal),
          ))(),
          () => client.close(),
          { signal: operationSignal },
        );
        isCurrent();
        const tools = await listMcpToolInventory({
          signal: operationSignal,
          assertCurrent: isCurrent,
          listPage: (cursor, pageSignal) => listMcpToolPage(client, cursor, botMcpRequestOptions(pageSignal)),
        });
        isCurrent();
        // The same projection the live agent tools carry, so the Bot's live
        // admission compares like with like.
        return tools.map((tool) => mcpRemoteToolDescriptor(tool));
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    isCurrent,
  );
}


interface McpInventory {
  tools: McpToolInfo[];
  guard: ReturnType<typeof createMcpToolCallGuard>;
}

type McpToolCallOptions = Parameters<typeof callMcpTool>[2];

interface McpAgentContext {
  tools: readonly AgentTool[];
  instructions?: McpServerInstructionSnapshot;
}

interface BuiltMcpTools {
  readonly tools: readonly AgentTool[];
  readonly discovery: object;
  readonly instructions?: McpServerInstructionSnapshot;
}

function leaseIsCurrent(lease: ReturnType<typeof mcpConfigurationLeases.acquire>): boolean {
  try {
    lease.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

class McpManager {
  // Bound the whole attempt (transport start included), not just initialize.
  private readonly clients = new GenerationBoundConnectionCache<Client>({ connectTimeoutMs: MCP_DISCOVERY_DEADLINES.connectMs });
  private readonly statusClients =
    new GenerationBoundConnectionAttempts<Client>({ connectTimeoutMs: MCP_DISCOVERY_DEADLINES.connectMs });
  private closed = false;
  // Servers that cannot announce tool changes are re-listed after the TTL.
  private readonly toolInventories = createMcpToolInventoryCache<McpInventory>({ ttlMs: MCP_TOOL_INVENTORY_TTL_MS });
  private readonly built = new McpBuiltToolsMemo<BuiltMcpTools>();
  private readonly failures = new McpRecentFailures();
  private readonly prewarmer = new McpPrewarmer(() => this.closed);
  private readonly activity = new McpConnectionActivity();
  private readonly disconnecting = new Set<Promise<void>>();
  private idleSweep: ReturnType<typeof setInterval> | undefined;

  get isShutDown(): boolean {
    return this.closed;
  }

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
        // A closed client's inventory is never reused, even by a waiter that
        // still holds the client.
        const closed = () => {
          this.toolInventories.forget(client);
          onClosed();
        };
        // Register before connect: closure during initialization must also
        // prevent a dead client from being published to the cache.
        client.onclose = closed;
        this.toolInventories.watch(client);
        // The MCP SDK transports satisfy the client's transport interface.
        await client.connect(
          makeTransport(
            await resolveAuth(server, connectionIsCurrent),
            connectionIsCurrent,
            { onTerminalFailure: closed },
          ) as never,
          mcpRequestDeadline(MCP_DISCOVERY_DEADLINES.connectMs),
        );
      },
      async (client) => {
        this.toolInventories.forget(client);
        await client.close();
      },
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

  private assertGeneration(id: string, generation: number): void {
    if (this.connectionGeneration(id) !== generation) throw new Error("The MCP connection was superseded.");
  }

  private async readInventory(client: Client, assertCurrent: () => void, signal?: AbortSignal): Promise<McpInventory> {
    const tools = client.getServerCapabilities()?.tools ? await listMcpToolInventory({
      signal,
      assertCurrent,
      listPage: boundedMcpToolPageReader(client, MCP_DISCOVERY_DEADLINES.listMs),
    }) as McpToolInfo[] : [];
    return { tools, guard: createMcpToolCallGuard(tools) };
  }

  /**
   * A shared cached read is fenced by its connection generation only, so a
   * caller's own revoked lease cannot fail other callers; each caller stops
   * waiting on its own signal and re-checks its lease afterwards.
   */
  private cachedInventory(server: McpServer, generation: number, client: Client, signal?: AbortSignal): Promise<McpInventory> {
    return this.toolInventories.load(
      client,
      () => this.readInventory(client, () => this.assertGeneration(server.id, generation)),
      signal,
    );
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
    // Save, sign-in, key changes and external edits all disconnect: retry at once.
    this.failures.clear(id);
    this.built.delete(id);
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
    this.failures.clear(id);
    this.built.delete(id);
    await Promise.all([this.clients.forget(id), this.statusClients.forget(id)]);
    this.activity.forget(id);
  }

  /**
   * Close every server in parallel, including closes already under way.
   * `final` (application shutdown) also refuses every later connection, so a
   * discovery racing quit cannot spawn a server after its close.
   */
  async closeAll(options: { final?: boolean } = {}): Promise<void> {
    // Reset connections retries every server, including ones that never connected.
    this.failures.clearAll();
    this.built.clear();
    if (options.final) {
      this.closed = true;
      const shutdown = Promise.all([this.clients.shutdown(), this.statusClients.shutdown()]).then(() => undefined);
      this.disconnecting.add(shutdown);
      void shutdown.finally(() => this.disconnecting.delete(shutdown)).catch(() => undefined);
    }
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
    return raceDeadline(this.closeAll({ final: true }), budgetMs, "MCP shutdown").then(
      () => true,
      () => false,
    );
  }

  /** The failure to report instead of retrying a server that just failed. */
  recentFailure(id: string): { error: unknown; retryInMs: number } | undefined {
    return this.failures.recent(id, this.connectionGeneration(id));
  }

  /**
   * Remember a discovery failure for this connection generation. Cancellation
   * says nothing about the server, so it is never remembered.
   */
  recordFailure(id: string, generation: number, error: unknown): void {
    if (projectDiagnosticError(error).code === "cancelled") return;
    if (generation !== this.connectionGeneration(id)) return;
    this.failures.record(id, generation, error);
  }

  clearFailure(id: string): void {
    this.failures.clear(id);
  }

  /** Start one background discovery per server, sharing any already running. */
  prewarm(id: string, discover: () => Promise<unknown>, onFailure: (error: unknown) => void): void {
    void this.prewarmer.start(id, discover, onFailure);
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
            mcpRequestDeadline(MCP_DISCOVERY_DEADLINES.connectMs),
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
  ): Promise<McpAgentContext> {
    if (this.closed) throw new Error("MCP connections are shut down.");
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
        // The operation's own 60 s bound is far past the discovery budget.
        await connectMcpWithinDeadline(
          (async () => client.connect(makeTransport(await resolveAuth(server, isCurrent), isCurrent, { signal }) as never, { signal }))(),
          () => client.close(),
          { signal },
        );
      },
      use,
      close: async (client) => client.close(),
    });
    const cachedClient = server.authProvider ? undefined : await this.ensureConnected(server, generation);
    lease.assertCurrent();
    const assertGeneration = () => this.assertGeneration(server.id, generation);
    const describe = (client: Client) => ({
      resources: Boolean(client.getServerCapabilities()?.resources),
      instructions: client.getInstructions(),
    });
    const metadata = cachedClient ? {
      inventory: await this.cachedInventory(server, generation, cachedClient, lease.signal),
      ...describe(cachedClient),
    } : await scoped(async (client, signal) => ({
      inventory: await this.readInventory(client, () => { lease.assertCurrent(); assertGeneration(); }, AbortSignal.any([lease.signal, signal])),
      ...describe(client),
    }));
    assertGeneration();
    lease.assertCurrent();
    const key = JSON.stringify([server.id, server.name, server.description ?? null]);
    const { tools, guard: callGuard } = metadata.inventory;
    const client: Parameters<typeof createMcpResourceTool>[1] & {
      callTool(params: Parameters<typeof callMcpTool>[1], options?: McpToolCallOptions): ReturnType<typeof callMcpTool>;
    } = cachedClient ? {
      callTool: (params, options) => this.withLiveClient(server, generation, cachedClient, (live) =>
        callMcpToolOnLiveClient(
          { client: cachedClient, guard: callGuard },
          live,
          (reconnected) => this.cachedInventory(server, generation, reconnected, options?.signal),
          params,
          options,
        )),
      listResources: (params, options) => this.withLiveClient(server, generation, cachedClient, (live) => listMcpResourcesPage(live, params, options)),
      listResourceTemplates: (params, options) => this.withLiveClient(server, generation, cachedClient, (live) => listMcpResourceTemplatesPage(live, params, options)),
      readResource: (params, options) => this.withLiveClient(server, generation, cachedClient, (live) => live.readResource(params, options)),
    } : {
      callTool: (params, options) => scoped((connection, signal) => guardedMcpToolCall(callGuard, connection, params, { ...options, signal }), options?.signal),
      listResources: (params, options) => scoped((connection, signal) => listMcpResourcesPage(connection, params, { ...options, signal }), options?.signal),
      listResourceTemplates: (params, options) => scoped((connection, signal) => listMcpResourceTemplatesPage(connection, params, { ...options, signal }), options?.signal),
      readResource: (params, options) => scoped((connection, signal) => connection.readResource(params, { ...options, signal }), options?.signal),
    };
    // The resource tool keeps a per-turn resource listing, so it is always new.
    const resourceTool = metadata.resources ? createMcpResourceTool(server, client, lease) : undefined;
    const withResources = (built: BuiltMcpTools): McpAgentContext => {
      if (resourceTool) Object.assign(resourceTool, { codemode: true, discovery: built.discovery });
      return {
        tools: resourceTool ? [...built.tools, resourceTool] : built.tools,
        ...(built.instructions ? { instructions: built.instructions } : {}),
      };
    };
    // Same client, same inventory, same server identity and a still-current
    // lease: reuse the very same tool objects, so per-tool work (name hashing,
    // schema normalization, provider validator caches) is not redone.
    const dependencies = [cachedClient, metadata.inventory, key, Boolean(resourceTool)];
    const reused = cachedClient ? this.built.get(server.id, dependencies) : undefined;
    if (reused) return withResources(reused);
    const agentTools = tools.map((t): AgentTool => tagMcpAgentTool(markToolOutputSource({
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
          return client.callTool(
            {
              name: t.name,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            { signal, timeout: MCP_TOOL_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_TOOL_CALL_TIMEOUT_MS },
          );
        });
      },
    }), t));
    const instructions = snapshotMcpServerInstructions(server, resourceTool ? [...agentTools, resourceTool] : agentTools, metadata.instructions);
    // One frozen namespace record per server: every tool references it, so the
    // server's guidance is held and validated once rather than per tool.
    const discovery = Object.freeze({
      ...(server.description ? { description: server.description.slice(0, 1024) } : {}),
      namespace: `mcp:${createHash("sha256").update(server.id).digest("hex").slice(0, 24)}`,
      label: server.name.slice(0, 64) || "MCP service",
      ...(instructions ? { instructions: instructions.instructions } : {}),
    });
    for (const tool of agentTools) Object.assign(tool, { codemode: true, discovery });
    const built: BuiltMcpTools = Object.freeze({ tools: Object.freeze(agentTools), discovery, ...(instructions ? { instructions } : {}) });
    if (cachedClient) this.built.set(server.id, dependencies, () => leaseIsCurrent(lease), built);
    return withResources(built);
  }

  connectionGeneration(id: string): number {
    return this.clients.generation(id);
  }

  statusGeneration(id: string): number {
    return this.statusClients.generation(id);
  }
}

export const mcpManager = new McpManager();

/** A server skipped because it failed moments ago; reported, not retried. */
class McpRecentFailureError extends Error {
  constructor(readonly original: unknown, readonly retryInMs: number) {
    super("This MCP server failed moments ago and is skipped until it can be retried.");
  }
}

function writeMcpDegraded(error: unknown, failurePhase: "mcp-tool-discovery" | "mcp-recent-failure" | "mcp-prewarm", extra: Record<string, number> = {}): void {
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
      failurePhase,
      ...extra,
    },
  });
}

/**
 * One server's discovery through admission, connection and inventory. Records
 * failures for the negative cache and clears them on success, including a
 * success that arrives after the caller's own deadline.
 */
function discoverMcpServer(
  server: McpServer,
  options: { strict?: boolean; providerScope?: McpProviderExecutionScope },
  generations: Map<string, number>,
): Promise<McpAgentContext> {
  if (!options.strict) {
    const recent = mcpManager.recentFailure(server.id);
    if (recent) return Promise.reject(new McpRecentFailureError(recent.error, recent.retryInMs));
  }
  let generation = 0;
  return withConfiguredMcp(
    server.id,
    mcpRuntimeConnectionSnapshot(server),
    () => mcpManager.agentContextFor(server, generation, options.providerScope),
    () => true,
    () => {
      generation = mcpManager.connectionGeneration(server.id);
      generations.set(server.id, generation);
    },
  ).then(
    (context) => {
      mcpManager.clearFailure(server.id);
      return context;
    },
    (error: unknown) => {
      if (generations.has(server.id)) mcpManager.recordFailure(server.id, generation, error);
      throw error;
    },
  );
}

/** Report a server that lost its tools for this turn, and remember why. */
function reportUnavailableMcpServer(server: McpServer, error: unknown, generations: Map<string, number>): void {
  if (error instanceof McpRecentFailureError) {
    writeMcpDegraded(asMcpDeadlineError(error.original), "mcp-recent-failure", { backoffMs: Math.max(0, Math.round(error.retryInMs)) });
    return;
  }
  // A missed deadline leaves the raw attempt running; remember the timeout
  // now (a late success clears it).
  const generation = generations.get(server.id);
  if (generation !== undefined) mcpManager.recordFailure(server.id, generation, error);
  // A skipped server, including one that missed its deadline, is surfaced
  // as degraded MCP status in diagnostics rather than failing the turn.
  writeMcpDegraded(error, "mcp-tool-discovery");
}

/**
 * Start discovery in the background for enabled servers (app ready, a server
 * saved, enabled or reconnected), so the next turn finds a warm connection
 * and a cached inventory. Never blocks; failures reach diagnostics and the
 * negative cache only. Provider-authenticated servers need an attended
 * operation and are never prewarmed.
 */
export function prewarmMcpServers(servers?: readonly McpServer[]): void {
  if (mcpManager.isShutDown) return;
  void (async () => {
    const candidates = (servers ?? await configStore.listMcpServers())
      .filter((server) => server.enabled && !server.authProvider);
    for (const server of candidates) {
      if (mcpManager.recentFailure(server.id)) continue;
      const generations = new Map<string, number>();
      mcpManager.prewarm(
        server.id,
        () => raceDeadline(discoverMcpServer(server, {}, generations), mcpServerDiscoveryBudgetMs(), `MCP server "${server.name}"`),
        (error) => {
          // A missed deadline is remembered like any failure; a late success clears it.
          const generation = generations.get(server.id);
          if (generation !== undefined) mcpManager.recordFailure(server.id, generation, error);
          writeMcpDegraded(asMcpDeadlineError(error), "mcp-prewarm");
        },
      );
    }
  })().catch((error: unknown) => writeMcpDegraded(error, "mcp-prewarm"));
}

/**
 * Merge tools from enabled servers. Servers are discovered concurrently, each
 * within its own deadline, so one slow or hung server only loses its tools for
 * this turn. Strict callers fail closed instead of silently losing access.
 *
 * With `deferral` (a turn whose MCP tools sit behind codemode / tool_search),
 * the turn starts with the servers ready within a short window; the others
 * keep discovering and are handed over through `deferral.onLate`.
 */
export async function collectMcpAgentTools(
  servers: McpServer[],
  options: {
    strict?: boolean;
    allowProviderAuth?: boolean;
    providerScope?: McpProviderExecutionScope;
    onServerInstructions?: (snapshot: McpServerInstructionSnapshot) => void;
    deferral?: { windowMs?: number; onLate(late: McpLateDiscovery): void };
  } = {},
): Promise<AgentTool[]> {
  const enabled = admitMcpProviderAuthServers(servers, options.allowProviderAuth === true && options.providerScope !== undefined, options.strict === true).filter((server) => server.enabled);
  const generations = new Map<string, number>();
  const discover = (server: McpServer) => discoverMcpServer(server, options, generations);
  const onUnavailable = (server: McpServer, error: unknown) => reportUnavailableMcpServer(server, error, generations);
  if (options.deferral && !options.strict) {
    const { tools, late } = await admitMcpServerDiscovery(enabled, discover, {
      budgetMs: mcpServerDiscoveryBudgetMs(),
      windowMs: options.deferral.windowMs ?? MCP_DEFERRED_ADMISSION_WINDOW_MS,
      onServerInstructions: options.onServerInstructions,
      onUnavailable,
    });
    options.deferral.onLate(late);
    return tools;
  }
  const settled = await settleMcpServerDiscovery(enabled, discover, mcpServerDiscoveryBudgetMs());
  return mergeMcpServerDiscovery(enabled, settled, {
    strict: options.strict,
    onServerInstructions: options.onServerInstructions,
    onUnavailable,
  });
}
