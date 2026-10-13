import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { projectDiagnosticError } from "./diagnostics-contract.js";
import {
  admitMcpServerDiscovery,
  asMcpDeadlineError,
  connectMcpWithinDeadline,
  McpBuiltToolsMemo,
  McpPrewarmer,
  McpRecentFailures,
  NO_LATE_MCP_DISCOVERY,
  McpConnectionActivity,
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

function toolServer(tools: string[], options: { beforeList?: () => Promise<void> } = {}) {
  const server = new Server(
    { name: "discovery-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await options.beforeList?.();
    return { tools: tools.map((name) => ({ name, inputSchema: { type: "object" as const } })) };
  });
  return { server };
}

async function connectClient(server: Server, timeoutMs = 1_000) {
  const client = new Client({ name: "discovery-test", version: "1" }, { capabilities: {} });
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
      const client = await connectClient(healthy.server);
      return (await client.listTools(undefined, mcpRequestDeadline(1_000))).tools.map((tool) => tool.name);
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

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

/** Discovery through a real in-memory SDK server: connect, list, name tools `<server>_<tool>`. */
async function discoverFrom(t: { after(fn: () => Promise<void>): void }, prefix: string, server: Server) {
  const client = await connectClient(server);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools(undefined, mcpRequestDeadline(5_000));
  return { tools: tools.map(({ name }) => agentTool(`${prefix}_${name}`)), instructions: `${prefix} guidance` };
}

test("deferred admission starts the turn with ready servers and lets a slow server join late", async (t) => {
  const slowList = gate();
  const fast = toolServer(["read"]);
  const slow = toolServer(["search"], { beforeList: () => slowList.opened });
  const instructions: string[] = [];
  const started = Date.now();
  const { tools, late } = await admitMcpServerDiscovery(
    [{ name: "fast" }, { name: "slow" }],
    ({ name }) => discoverFrom(t, name, name === "fast" ? fast.server : slow.server),
    { budgetMs: 10_000, windowMs: 100, onServerInstructions: (value) => instructions.push(value) },
  );
  assert.ok(Date.now() - started < 2_000, "the turn must not wait for the slow server's tools/list");
  assert.deepEqual(tools.map(({ name }) => name), ["fast_read"]);
  assert.equal(late.pending(), 1);
  assert.deepEqual(late.tools(), []);

  // A waiter can give up on its own signal without affecting discovery.
  const impatient = new AbortController();
  const abandoned = late.settled(impatient.signal);
  impatient.abort(new Error("tool search cancelled"));
  await assert.rejects(abandoned, /tool search cancelled/u);

  const waiting = late.settled();
  slowList.open();
  await waiting;
  assert.equal(late.pending(), 0);
  assert.deepEqual(late.tools().map(({ name }) => name), ["slow_search"]);
  // Late servers never change the turn's prompt.
  assert.deepEqual(instructions, ["fast guidance"]);
});

test("deferred admission does not wait out its window once every server is ready", async (t) => {
  const started = Date.now();
  const { tools, late } = await admitMcpServerDiscovery(
    [{ name: "only" }],
    ({ name }) => discoverFrom(t, name, toolServer(["read"]).server),
    { budgetMs: 10_000, windowMs: 30_000 },
  );
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(tools.map(({ name }) => name), ["only_read"]);
  assert.equal(late, NO_LATE_MCP_DISCOVERY);
  await late.settled();
});

test("late servers that collide, fail or miss their budget are reported, never admitted", async () => {
  const release = gate();
  const unavailable: [string, string][] = [];
  const { tools, late } = await admitMcpServerDiscovery(
    [{ name: "alpha" }, { name: "clash" }, { name: "broken" }, { name: "hung" }],
    async ({ name }) => {
      if (name === "alpha") return { tools: [agentTool("alpha_read")] };
      if (name === "hung") return new Promise<never>(() => undefined);
      await release.opened;
      if (name === "broken") throw new Error("listing unavailable");
      return { tools: [agentTool("alpha_read")] };
    },
    {
      budgetMs: 300,
      windowMs: 20,
      onUnavailable: (server, error) => unavailable.push([server.name, projectDiagnosticError(error).code]),
    },
  );
  assert.deepEqual(tools.map(({ name }) => name), ["alpha_read"]);
  assert.equal(late.pending(), 3);
  release.open();
  await late.settled();
  assert.deepEqual(late.tools(), []);
  assert.deepEqual(unavailable.map(([name]) => name).sort(), ["broken", "clash", "hung"]);
  assert.equal(unavailable.find(([name]) => name === "hung")?.[1], "timed-out");
});

test("a recent discovery failure is remembered for its connection generation only", () => {
  let now = 0;
  const failures = new McpRecentFailures(45_000, () => now);
  const error = new McpDeadlineError('MCP server "slow"', 17_000);
  failures.record("slow", 3, error);
  now = 10_000;
  assert.deepEqual(failures.recent("slow", 3), { error, retryInMs: 35_000 });
  // A reconnect or save supersedes the generation, so the server is retried.
  assert.equal(failures.recent("slow", 4), undefined);
  failures.record("slow", 4, error);
  now = 60_000;
  assert.equal(failures.recent("slow", 4), undefined, "the entry expires");
  failures.record("other", 1, error);
  failures.clearAll();
  assert.equal(failures.recent("other", 1), undefined);
});

test("a connect stalled before initialize is bounded and its client closed", async () => {
  // A transport whose start never completes, like an SSE stream that never sends `endpoint`.
  let closes = 0;
  const stalled = {
    start: () => new Promise<void>(() => undefined),
    send: async () => undefined,
    close: async () => { closes += 1; },
  };
  const client = new Client({ name: "discovery-test", version: "1" }, { capabilities: {} });
  const started = Date.now();
  await assert.rejects(
    connectMcpWithinDeadline(client.connect(stalled), async () => { await stalled.close(); }, { ms: 100 }),
    (error: unknown) => projectDiagnosticError(error).code === "timed-out",
  );
  assert.ok(Date.now() - started < 2_000);
  assert.ok(closes >= 1);

  const hung = await silentPeer();
  const cancelled = new AbortController();
  const attempt = connectMcpWithinDeadline(
    new Client({ name: "discovery-test", version: "1" }).connect(hung.clientTransport),
    () => hung.close(),
    { ms: 60_000, signal: cancelled.signal },
  );
  cancelled.abort(new Error("operation cancelled"));
  await assert.rejects(attempt, /operation cancelled/u);
});

test("built tools are reused while client, inventory, identity and lease are unchanged", () => {
  const memo = new McpBuiltToolsMemo<{ tools: AgentTool[] }>();
  const client = {};
  const inventory = {};
  let leaseCurrent = true;
  const built = { tools: [agentTool("docs_search")] };
  memo.set("docs", [client, inventory, '["docs","Docs",null]', false], () => leaseCurrent, built);
  assert.equal(memo.get("docs", [client, inventory, '["docs","Docs",null]', false]), built);
  // An equal-looking but different inventory (re-listed after its TTL) rebuilds.
  assert.equal(memo.get("docs", [client, {}, '["docs","Docs",null]', false]), undefined);
  memo.set("docs", [client, inventory, '["docs","Docs",null]', false], () => leaseCurrent, built);
  assert.equal(memo.get("docs", [{}, inventory, '["docs","Docs",null]', false]), undefined, "a reconnected client rebuilds");
  memo.set("docs", [client, inventory, '["docs","Docs",null]', false], () => leaseCurrent, built);
  assert.equal(memo.get("docs", [client, inventory, '["docs","Renamed",null]', false]), undefined, "a rename rebuilds");
  memo.set("docs", [client, inventory, '["docs","Docs",null]', false], () => leaseCurrent, built);
  leaseCurrent = false;
  assert.equal(memo.get("docs", [client, inventory, '["docs","Docs",null]', false]), undefined, "a revoked lease rebuilds");
});

test("prewarm runs one discovery per server at a time, never after shutdown, and reports failures", async () => {
  let shutDown = false;
  const prewarmer = new McpPrewarmer(() => shutDown);
  const release = gate();
  let discoveries = 0;
  const failures: string[] = [];
  const discover = async () => { discoveries += 1; await release.opened; throw new Error("server unavailable"); };
  const first = prewarmer.start("docs", discover, (error) => failures.push(String(error)));
  const second = prewarmer.start("docs", discover, (error) => failures.push(String(error)));
  assert.equal(first, second);
  release.open();
  await first;
  assert.equal(discoveries, 1);
  assert.deepEqual(failures, ["Error: server unavailable"]);

  await prewarmer.start("docs", async () => { discoveries += 1; }, () => undefined);
  assert.equal(discoveries, 2, "a finished prewarm does not block the next one");
  shutDown = true;
  await prewarmer.start("docs", async () => { discoveries += 1; }, () => undefined);
  assert.equal(discoveries, 2, "no connection starts after shutdown");
});
