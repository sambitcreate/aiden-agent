import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SubagentMcpReadHost } from "../../../main/services/subagents/subagent-mcp-read.js";
import { SubagentMcpInventoryCache, resolveBoundedSubagentMcpInventory } from "../../../main/services/subagents/subagent-mcp-inventory-core.js";
import { createSubagentMcpMutationHost } from "../../../main/services/subagents/subagent-mcp-mutation-host-core.js";
import { SubagentWebProxyHost } from "../../../main/services/subagents/subagent-web-proxy.js";
import { callMcpTool, type createMcpToolCallGuard } from "../../../main/services/mcp-tool-inventory.js";
import { createCliMcpPool, mcpCredentialId, storeFor } from "./mcp.ts";
import { insightCredentials } from "./credentials.ts";
import { createCliWebSearch } from "./extensions/web-search.ts";
import { readJson } from "./state.ts";

export function createCliMcpRevision(agentDir: string) {
  const key = randomBytes(32);
  return () => createHmac("sha256", key).update(JSON.stringify({
    configuration: readJson(join(agentDir, "aiden-mcp.json"), []), credentials: readJson(join(agentDir, "credentials/insights.json"), {}),
  })).digest("hex");
}

export function createCliSubagentHosts(agentDir: string) {
  const cache = new SubagentMcpInventoryCache();
  const revision = createCliMcpRevision(agentDir);
  const mcpHost: SubagentMcpReadHost = {
    async resolveServer(id, signal) { signal.throwIfAborted(); return (await storeFor(agentDir).load()).find((item) => item.id === id); },
    async withClient(server, signal, operation) {
      if (server.transport === "stdio") throw new Error("Delegated MCP requires a remote transport.");
      const expected = revision(), pool = createCliMcpPool(agentDir, 256 * 1024);
      const assertCurrent = () => { signal.throwIfAborted(); if (revision() !== expected) throw new Error("MCP configuration or credentials changed."); };
      const close = () => { void pool.close(); };
      signal.addEventListener("abort", close, { once: true });
      try {
        const client = await pool.connection(server);
        const serialized = await insightCredentials(agentDir).read(mcpCredentialId(server));
        const oauth = serialized ? JSON.parse(serialized) : {};
        const secrets = [...Object.values(server.headers ?? {}), ...Object.values(oauth.tokens ?? {}), ...Object.values(oauth.client ?? {})]
          .filter((value): value is string => typeof value === "string" && value.length >= 4);
        assertCurrent();
        // The guard of the inventory this operation last inspected on this client.
        let guard: ReturnType<typeof createMcpToolCallGuard> | undefined;
        const options = (currentSignal: AbortSignal) => ({ signal: AbortSignal.any([signal, currentSignal]), timeoutMs: 30_000 });
        return await operation({ credentialRevision: expected,
          credentialRevisionIsCurrent: async (currentSignal) => !currentSignal.aborted && !signal.aborted && revision() === expected,
          redactCredentialText: (text) => secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED MCP CREDENTIAL]"), text),
          listTools: async (currentSignal) => {
            assertCurrent(); const inventory = await pool.inventory(server, currentSignal); assertCurrent();
            guard = inventory.guard; return inventory.tools;
          },
          async callTool(name, args, currentSignal, beforeEffect) {
            currentSignal.throwIfAborted(); assertCurrent();
            const active = guard ?? (await pool.inventory(server, currentSignal)).guard;
            currentSignal.throwIfAborted(); assertCurrent();
            active.assertCallable(name); beforeEffect?.();
            const result = await callMcpTool(client, { name, arguments: args }, options(currentSignal));
            active.validateResult(name, result);
            return result;
          },
          callToolRaw(name, args, currentSignal, beforeRawBytes) {
            currentSignal.throwIfAborted(); assertCurrent();
            const active = guard;
            if (!active) throw new Error("Inspect the MCP tool inventory before a raw call.");
            active.assertCallable(name); beforeRawBytes();
            return callMcpTool(client, { name, arguments: args }, options(currentSignal)).then((result) => { active.validateResult(name, result); return result; });
          },
        });
      } finally { signal.removeEventListener("abort", close); await pool.close(); }
    },
  };
  const web = createCliWebSearch(agentDir);
  const webHost = new SubagentWebProxyHost({ search: (request, options) => web.search(request, options), webSearchAvailability: () => web.availability(), now: Date.now,
    scheduleTimeout(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
  });
  return { mcpHost, mcpMutationHost: createSubagentMcpMutationHost(mcpHost), webHost, web,
    inventory: (signal: AbortSignal) => resolveBoundedSubagentMcpInventory(signal, { listServers: () => storeFor(agentDir).load(), withClient: mcpHost.withClient, resolveCredentialRevision: async () => revision(), cache, bypassCache: true }),
  };
}
