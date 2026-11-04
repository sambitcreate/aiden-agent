// Disposable metadata-only connection for the person's explicit Settings check.
// This path never joins or populates the agent/watch connection cache.
import { botConnectorForegroundLifetime, botConnectorInventoryServer } from "./bot-connector-inventory-scope.js";
import { isComposioServiceServer } from "./composio-service-tool.js";
import { mcpServerOffersTools } from "../../renderer/shared/mcp-exposure.js";
import { mcpRuntimeConnectionSnapshot, sameMcpRuntimeConnection } from "./mcp-credential-cleanup-core.js";
import type { GenerationBoundConnectionAttempts } from "./generation-bound-connection-cache.js";
import type { McpConfigurationLease } from "./mcp-config-lease.js";
import type { McpRequester } from "./mcp-client.js";
import { COMPOSIO_WATCH_INVENTORY_LIMITS, MCP_TOOL_LIST_CHANGED, createMcpToolCallGuard, guardedMcpToolCall, listMcpToolInventory, listMcpToolPage } from "./mcp-tool-inventory.js";
import type { BotConnectorMcpClientPort } from "./mcp.js";
import type { McpServer } from "./types.js";

export interface ForegroundComposioSettingsClientPort extends BotConnectorMcpClientPort {
  assertCurrent(): Promise<void>;
}

export interface ForegroundComposioClient extends McpRequester {
  onNotification(method: string, listener: (params: unknown) => void): unknown;
  onClose(listener: () => void): unknown;
}

function eligible(server: McpServer): boolean {
  return isComposioServiceServer(server) && server.enabled && mcpServerOffersTools(server) && !server.hiddenTools?.length;
}

/** Private foreground lifetime, exact saved configuration and literal metadata operations only. */
export async function withForegroundComposioSettingsClientCore<Client extends ForegroundComposioClient, T>(input: {
  server: McpServer;
  signal: AbortSignal;
  lease: McpConfigurationLease;
  attempts: GenerationBoundConnectionAttempts<Client>;
  configured(): Promise<McpServer | undefined>;
  create(): Client;
  /** Read the key bound to the saved canonical endpoint; never migrate or persist it. */
  resolveAuth(server: McpServer, isCurrent: () => boolean): Promise<McpServer>;
  connect(client: Client, resolved: McpServer, signal: AbortSignal, isCurrent: () => boolean): Promise<void>;
  close(client: Client): Promise<void>;
  operation(port: ForegroundComposioSettingsClientPort): Promise<T>;
}): Promise<T> {
  const lifetime = botConnectorForegroundLifetime();
  if (!lifetime || botConnectorInventoryServer() !== input.server.id || !eligible(input.server)) throw new Error("Composio inspection needs its explicit foreground Settings allowance.");
  const server = structuredClone(input.server), expected = mcpRuntimeConnectionSnapshot(server);
  const generation = input.attempts.generation(server.id);
  const signal = AbortSignal.any([input.signal, lifetime.signal, input.lease.signal]);
  const synchronousCurrent = () => {
    signal.throwIfAborted(); input.lease.assertCurrent();
    if (input.attempts.generation(server.id) !== generation) throw new Error("Composio inspection connection changed.");
    return true;
  };
  const current = async () => {
    synchronousCurrent(); await lifetime.assertCurrent(); synchronousCurrent();
    const configured = await input.configured(); synchronousCurrent();
    if (!configured || !eligible(configured) || !sameMcpRuntimeConnection(expected, mcpRuntimeConnectionSnapshot(configured))) throw new Error("The saved Composio service allowance changed.");
    await lifetime.assertCurrent(); synchronousCurrent();
  };
  await current();
  let activeClient: Client | undefined, closed = false, inventoryVersion = 0;
  const onAbort = () => { if (activeClient) void input.close(activeClient).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await input.attempts.run(server.id, generation, () => {
      synchronousCurrent(); const client = input.create(); activeClient = client;
      client.onClose(() => { closed = true; });
      client.onNotification(MCP_TOOL_LIST_CHANGED, () => { inventoryVersion++; });
      return client;
    }, async (client, connectionCurrent) => {
      await current(); if (!connectionCurrent()) throw new Error("Composio inspection connection changed.");
      const active = () => synchronousCurrent() && connectionCurrent();
      const resolved = await input.resolveAuth(server, active);
      await current(); if (!active() || !eligible(resolved)) throw new Error("Composio inspection connection changed.");
      await input.connect(client, resolved, signal, active);
      await current(); if (!active()) throw new Error("Composio inspection connection changed.");
    }, async (client, connectionCurrent) => {
      const active = () => { synchronousCurrent(); if (closed || !connectionCurrent()) throw new Error("Composio inspection connection ended."); return true; };
      let guard: ReturnType<typeof createMcpToolCallGuard> | undefined;
      await current(); active();
      const result = await input.operation({
        assertCurrent: async () => { await current(); active(); },
        list: async () => {
          await current(); active(); guard = undefined;
          const version = inventoryVersion;
          const inventoryCurrent = () => { active(); if (version !== inventoryVersion) throw new Error("Composio inspection metadata changed."); };
          const tools = await listMcpToolInventory({ signal, limits: COMPOSIO_WATCH_INVENTORY_LIMITS, assertCurrent: inventoryCurrent,
            listPage: (cursor, pageSignal) => listMcpToolPage(client, cursor, { signal: pageSignal, timeoutMs: 10_000 }, undefined, COMPOSIO_WATCH_INVENTORY_LIMITS.maxPageBytes) });
          await current(); inventoryCurrent(); guard = createMcpToolCallGuard(tools, inventoryCurrent);
          return tools;
        },
        call: async (name, args) => {
          if (name !== "COMPOSIO_SEARCH_TOOLS" && name !== "COMPOSIO_GET_TOOL_SCHEMAS") throw new Error("Unsupported Composio inspection operation.");
          await current(); active(); if (!guard) throw new Error("Composio inspection metadata was not checked.");
          const result = await guardedMcpToolCall(guard, client, { name, arguments: args }, { signal, timeoutMs: 10_000 });
          await current(); active(); return result;
        },
      });
      await current(); active(); return result;
    }, input.close);
  } finally { signal.removeEventListener("abort", onAbort); }
}
