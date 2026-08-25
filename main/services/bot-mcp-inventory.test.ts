import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveBotMcpInventory } from "./bot-mcp-inventory.js";
import type { McpServer } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("Bot MCP inventory includes stdio and exceeds subagent 16x32 bounds within Bot limits", async () => {
  const servers: McpServer[] = Array.from({ length: 17 }, (_unused, index) => ({
    id: `server-${String(index).padStart(2, "0")}`,
    name: `Server ${index}`,
    transport: index === 0 ? "stdio" : "http",
    ...(index === 0 ? { command: "mcp-safe" } : { url: `https://mcp-${index}.invalid` }),
    enabled: true,
  }));
  const scopes = await resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => servers,
    credentialSignature: async (server) => hash(`credential:${server.id}`),
    inspectTools: async (_server) =>
      Array.from({ length: 33 }, (_tool, index) => ({
        name: `tool_${index}`,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        annotations: { readOnlyHint: true },
      })),
    incarnations: {
      reconcileNamespace: async (_namespace, resources) =>
        resources.map(({ sourceId }) => ({
          sourceId,
          resourceIncarnation: "a".repeat(43),
          credentialIncarnation: "b".repeat(43),
        })),
    },
  });
  assert.equal(scopes.length, 17);
  assert.equal(scopes[0]?.serverId, "server-00");
  assert.equal(scopes[0]?.tools.length, 33);
});

test("Bot MCP connection identity is stable across inspection and changes with incarnation", async () => {
  const server: McpServer = {
    id: "stable",
    name: "Stable",
    transport: "stdio",
    command: "mcp-safe",
    enabled: true,
  };
  let credentialIncarnation = "b".repeat(43);
  const dependencies = {
    listServers: async () => [server],
    credentialSignature: async () => hash("credential"),
    inspectTools: async () => [
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ],
    incarnations: {
      reconcileNamespace: async () => [{
        sourceId: server.id,
        resourceIncarnation: "a".repeat(43),
        credentialIncarnation,
      }],
    },
  };
  const first = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  const second = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.equal(second[0]?.connectionFingerprint, first[0]?.connectionFingerprint);
  credentialIncarnation = "c".repeat(43);
  const rotated = await resolveBotMcpInventory(new AbortController().signal, dependencies);
  assert.notEqual(rotated[0]?.connectionFingerprint, first[0]?.connectionFingerprint);
});

test("Bot MCP discovery returns at its deadline even if an inspector ignores cancellation", async () => {
  const started = Date.now();
  const scopes = await resolveBotMcpInventory(new AbortController().signal, {
    listServers: async () => [{
      id: "hung",
      name: "Hung",
      transport: "stdio",
      command: "mcp-hung",
      enabled: true,
    }],
    credentialSignature: async () => hash("credential"),
    inspectTools: async () => new Promise<never>(() => undefined),
    incarnations: {
      reconcileNamespace: async (_namespace, resources) => resources.map(({ sourceId }) => ({
        sourceId,
        resourceIncarnation: "a".repeat(43),
        credentialIncarnation: "b".repeat(43),
      })),
    },
    deadlineMs: 20,
  });
  assert.deepEqual(scopes, []);
  assert(Date.now() - started < 500);
});
