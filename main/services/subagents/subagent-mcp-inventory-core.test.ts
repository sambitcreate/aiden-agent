import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "../types.js";
import {
  SubagentMcpInventoryCache,
  resolveBoundedSubagentMcpInventory,
} from "./subagent-mcp-inventory-core.js";
import type { SubagentMcpClientPort } from "./subagent-mcp-read.js";

const server: McpServer = {
  id: "docs",
  name: "Docs",
  transport: "http",
  url: "https://mcp.test",
  enabled: true,
};
const revisions = { current: "a".repeat(64) };

function client(calls: string[]): SubagentMcpClientPort {
  return {
    credentialRevision: revisions.current,
    credentialRevisionIsCurrent: async () => true,
    redactCredentialText: (text) => text,
    listTools: async () => {
      calls.push("list");
      return [
        {
          name: "lookup",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ];
    },
    callTool: async () => ({ content: [] }),
  };
}

test("credential-aware inventory cache avoids repeat connections and invalidates on rotation", async () => {
  const calls: string[] = [];
  const cache = new SubagentMcpInventoryCache();
  const dependencies = {
    listServers: async () => [server],
    withClient: async <T>(
      _server: McpServer,
      _signal: AbortSignal,
      operation: (port: SubagentMcpClientPort) => Promise<T>,
    ) => operation(client(calls)),
    resolveCredentialRevision: async () => revisions.current,
    cache,
    now: () => 1_000,
  };
  const signal = new AbortController().signal;
  assert.equal((await resolveBoundedSubagentMcpInventory(signal, dependencies)).length, 1);
  assert.equal((await resolveBoundedSubagentMcpInventory(signal, dependencies)).length, 1);
  assert.deepEqual(calls, ["list"]);

  revisions.current = "b".repeat(64);
  assert.equal((await resolveBoundedSubagentMcpInventory(signal, dependencies)).length, 1);
  assert.deepEqual(calls, ["list", "list"]);
});

test("discovery returns completed servers at one aggregate deadline and skips stdio", async () => {
  revisions.current = "c".repeat(64);
  const fast = { ...server, id: "fast" };
  const slow = { ...server, id: "slow" };
  const stdio: McpServer = {
    id: "local",
    name: "Local",
    transport: "stdio",
    command: "unsafe",
    enabled: true,
  };
  const result = await resolveBoundedSubagentMcpInventory(
    new AbortController().signal,
    {
      listServers: async () => [fast, slow, stdio],
      withClient: async <T>(
        current: McpServer,
        signal: AbortSignal,
        operation: (port: SubagentMcpClientPort) => Promise<T>,
      ) => {
        if (current.id === "slow") {
          await new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        return operation(client([]));
      },
      resolveCredentialRevision: async () => revisions.current,
      cache: new SubagentMcpInventoryCache(),
      discoveryDeadlineMs: 20,
    },
  );
  assert.deepEqual(result.map(({ serverId }) => serverId), ["fast"]);
});

test("configuration loading shares the aggregate deadline", async () => {
  const started = Date.now();
  const result = await resolveBoundedSubagentMcpInventory(
    new AbortController().signal,
    {
      listServers: async () => new Promise<never>(() => undefined),
      withClient: async () => {
        throw new Error("unreachable");
      },
      resolveCredentialRevision: async () => revisions.current,
      cache: new SubagentMcpInventoryCache(),
      discoveryDeadlineMs: 20,
    },
  );
  assert.deepEqual(result, []);
  assert.ok(Date.now() - started < 250);
});

test("negative discovery cache advances exponential backoff across retries", () => {
  const cache = new SubagentMcpInventoryCache();
  const fingerprint = "f".repeat(64);
  cache.setFailure("offline", fingerprint, 0);
  assert.equal(cache.get("offline", fingerprint, 29_999), null);
  assert.equal(cache.get("offline", fingerprint, 30_000), undefined);
  cache.setFailure("offline", fingerprint, 30_000);
  assert.equal(cache.get("offline", fingerprint, 89_999), null);
  assert.equal(cache.get("offline", fingerprint, 90_000), undefined);
  cache.setFailure("offline", fingerprint, 90_000);
  assert.equal(cache.get("offline", fingerprint, 209_999), null);
});
