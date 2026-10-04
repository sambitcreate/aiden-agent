import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { projectDiagnosticError } from "./diagnostics-contract.js";
import {
  asMcpDeadlineError,
  McpConnectionActivity,
  McpToolListCache,
  McpDeadlineError,
  mcpRequestDeadline,
  mergeMcpServerDiscovery,
  settleMcpServerDiscovery,
} from "./mcp-tool-discovery-core.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

function agentTool(name: string): AgentTool {
  return { name } as AgentTool;
}

function fulfilled<T>(value: T): PromiseSettledResult<T> {
  return { status: "fulfilled", value };
}

function toolServer(initialTools: string[], options: { failFirst?: boolean } = {}) {
  let requests = 0;
  let tools = initialTools;
  const server = new Server(
    { name: "discovery-fixture", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    requests += 1;
    if (options.failFirst && requests === 1) throw new Error("listing unavailable");
    return { tools: tools.map((name) => ({ name, inputSchema: { type: "object" as const } })) };
  });
  return {
    server,
    requests: () => requests,
    setTools: (next: string[]) => {
      tools = next;
    },
  };
}

async function connectClient(server: Server, cache: McpToolListCache, timeoutMs = 1_000) {
  const client = new Client({ name: "discovery-test", version: "1" }, { capabilities: {} });
  cache.attach(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport, mcpRequestDeadline(timeoutMs));
  return client;
}

/** A transport peer that accepts messages and never answers `initialize`. */
async function silentPeer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.onmessage = () => undefined;
  await serverTransport.start();
  return { clientTransport, close: () => serverTransport.close() };
}

test("a server that never answers initialize does not hold up the other servers' tools", async (t) => {
  const healthy = toolServer(["read"]);
  const cache = new McpToolListCache();
  const hung = await silentPeer();
  t.after(async () => {
    await hung.close();
    await healthy.server.close();
  });
  const started = Date.now();
  const settled = await settleMcpServerDiscovery(
    [{ name: "hung" }, { name: "healthy" }, { name: "credential prompt" }],
    async ({ name }) => {
      if (name === "credential prompt") return new Promise<string[]>(() => undefined);
      if (name === "hung") {
        const client = new Client({ name: "discovery-test", version: "1" }, { capabilities: {} });
        await client.connect(hung.clientTransport, mcpRequestDeadline(50));
        return [];
      }
      const client = await connectClient(healthy.server, cache);
      return (await cache.list(client, 1_000)).map((tool) => tool.name);
    },
    300,
  );
  assert.ok(Date.now() - started < 2_000, "discovery must finish within its deadlines");
  assert.equal(settled[0].status, "rejected");
  assert.deepEqual(settled[1], { status: "fulfilled", value: ["read"] });
  assert.equal(settled[2].status, "rejected");

  // Both kinds of timeout are reported to diagnostics as timed out.
  const reasons = [settled[0], settled[2]].map((result) =>
    result.status === "rejected" ? result.reason : undefined,
  );
  for (const reason of reasons) {
    assert.equal(projectDiagnosticError(asMcpDeadlineError(reason)).code, "timed-out");
  }
});

test("discovery stops waiting as soon as the caller aborts", async () => {
  const controller = new AbortController();
  const pending = settleMcpServerDiscovery(
    [{ name: "slow" }],
    () => new Promise<never>(() => undefined),
    60_000,
    controller.signal,
  );
  controller.abort(new Error("generation stopped"));
  const [result] = await pending;
  assert.equal(result.status, "rejected");
  assert.match(String((result as PromiseRejectedResult).reason), /generation stopped/u);
});

test("a warm generation reuses the connected client's tool list without tools/list", async (t) => {
  const fixture = toolServer(["read", "write"]);
  const cache = new McpToolListCache();
  const client = await connectClient(fixture.server, cache);
  t.after(() => client.close());

  const [first, concurrent] = await Promise.all([cache.list(client, 1_000), cache.list(client, 1_000)]);
  assert.deepEqual(first.map(({ name }) => name), ["read", "write"]);
  assert.deepEqual(concurrent, first);
  assert.equal(fixture.requests(), 1);

  const warm = await cache.list(client, 1_000);
  assert.deepEqual(warm.map(({ name }) => name), ["read", "write"]);
  assert.equal(fixture.requests(), 1);
});

test("notifications/tools/list_changed makes the next generation re-list", async (t) => {
  const fixture = toolServer(["read"]);
  const cache = new McpToolListCache();
  const client = await connectClient(fixture.server, cache);
  t.after(() => client.close());
  await cache.list(client, 1_000);

  fixture.setTools(["read", "search"]);
  await fixture.server.sendToolListChanged();
  // In-memory delivery is asynchronous; let the client handle the notification.
  await new Promise((resolve) => setImmediate(resolve));

  const next = await cache.list(client, 1_000);
  assert.deepEqual(next.map(({ name }) => name), ["read", "search"]);
  assert.equal(fixture.requests(), 2);
});

test("a reconnect lists afresh and a failed listing is retried rather than cached", async (t) => {
  const fixture = toolServer(["read"], { failFirst: true });
  const cache = new McpToolListCache();
  const first = await connectClient(fixture.server, cache);
  await assert.rejects(cache.list(first, 1_000), /listing unavailable/u);
  assert.deepEqual((await cache.list(first, 1_000)).map(({ name }) => name), ["read"]);
  await first.close();

  const replacement = await connectClient(fixture.server, cache);
  t.after(() => replacement.close());
  await cache.list(replacement, 1_000);
  assert.equal(fixture.requests(), 3);
});

test("servers without the tools capability are never sent tools/list", async (t) => {
  let requests = 0;
  const server = new Server({ name: "resources-only", version: "1" }, { capabilities: { resources: {} } });
  const cache = new McpToolListCache();
  const client = await connectClient(server, cache);
  t.after(() => client.close());
  const originalRequest = client.request.bind(client);
  client.request = ((...args: Parameters<typeof client.request>) => {
    requests += 1;
    return originalRequest(...args);
  }) as typeof client.request;
  assert.deepEqual(await cache.list(client, 1_000), []);
  assert.equal(requests, 0);
});

test("connection activity reports idleness only after the threshold and never mid-call", () => {
  let now = 0;
  const activity = new McpConnectionActivity(() => now);
  activity.touch("a");
  activity.touch("b");
  const endCall = activity.begin("b");
  now = 9 * 60_000;
  assert.deepEqual(activity.idle(["a", "b"], 10 * 60_000), []);
  now = 30 * 60_000;
  assert.deepEqual(activity.idle(["a", "b"], 10 * 60_000), ["a"]);
  endCall();
  endCall();
  assert.deepEqual(activity.idle(["a", "b"], 10 * 60_000), ["a"]);
  now = 41 * 60_000;
  assert.deepEqual(activity.idle(["a", "b"], 10 * 60_000), ["a", "b"]);
});

test("merged discovery keeps server order and accepts instructions only with that server's tools", () => {
  const servers = [{ name: "alpha" }, { name: "hung" }, { name: "duplicate" }, { name: "beta" }];
  const instructions: string[] = [];
  const unavailable: Array<[string, string]> = [];
  const tools = mergeMcpServerDiscovery(
    servers,
    [
      fulfilled({ tools: [agentTool("alpha_read")], instructions: "alpha guidance" }),
      { status: "rejected", reason: new McpDeadlineError('MCP server "hung"', 10) },
      fulfilled({ tools: [agentTool("alpha_read")], instructions: "duplicate guidance" }),
      fulfilled({ tools: [agentTool("beta_read"), agentTool("beta_write")], instructions: "beta guidance" }),
    ],
    {
      onServerInstructions: (snapshot) => instructions.push(snapshot),
      onUnavailable: (server, error) =>
        unavailable.push([server.name, projectDiagnosticError(error).code]),
    },
  );
  assert.deepEqual(tools.map(({ name }) => name), ["alpha_read", "beta_read", "beta_write"]);
  assert.deepEqual(instructions, ["alpha guidance", "beta guidance"]);
  assert.deepEqual(unavailable.map(([name]) => name), ["hung", "duplicate"]);
  assert.equal(unavailable[0][1], "timed-out");
});

test("strict discovery fails closed naming the unavailable server", () => {
  const settled = [
    fulfilled({ tools: [agentTool("alpha_read")] }),
    { status: "rejected", reason: new McpDeadlineError('MCP server "hung"', 10) } as const,
  ];
  assert.throws(
    () => mergeMcpServerDiscovery([{ name: "alpha" }, { name: "hung" }], settled, { strict: true }),
    /MCP server "hung" is unavailable: .*did not respond/u,
  );
  assert.throws(
    () => mergeMcpServerDiscovery([{ name: "empty" }], [fulfilled({ tools: [] })], { strict: true }),
    /did not provide any tools/u,
  );
});
