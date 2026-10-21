import assert from "node:assert/strict";
import test from "node:test";
import { boundedMcpToolPageReader, callMcpTool, callMcpToolOnLiveClient, createMcpToolCallGuard, createMcpToolInventoryCache, listMcpToolInventory, listMcpToolPage } from "./mcp-tool-inventory.js";
import { executeMcpAgentTool } from "./mcp-tool-result.js";
import { LATEST_PROTOCOL_VERSION, McpClient, McpTimeoutError, type JsonRpcMessage } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectSdkServer } from "./mcp-test-support.js";

async function connectedClient(server: Server): Promise<McpClient> {
  const client = new McpClient({ name: "test-client", version: "1" });
  await client.connect(await connectSdkServer(server));
  return client;
}

/**
 * A wire-level server: replies exactly as `respond` says, without a server
 * library's own result validation, so tests observe what the client accepts.
 */
async function rawServerClient(t: { after(fn: () => Promise<void>): void }, respond: (method: string, params: unknown) => unknown) {
  const { client: clientSide, server: serverSide } = createInMemoryTransportPair();
  const requests: Array<{ method: string; params: unknown }> = [];
  serverSide.onMessage((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    requests.push({ method: message.method, params: message.params });
    const result = message.method === "initialize"
      ? { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "raw", version: "1" } }
      : respond(message.method, message.params);
    void Promise.resolve(result).then((value) => serverSide.send({ jsonrpc: "2.0", id: message.id, result: value }));
  });
  await serverSide.start();
  const client = new McpClient({ name: "raw-client", version: "1" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); });
  return { client, requests: () => requests.filter(({ method }) => method !== "initialize") };
}

test("inventory follows opaque cursors and retains later-page schemas and annotations", async () => {
  const cursors: Array<string | undefined> = [];
  const result = await listMcpToolInventory<{ name: string; annotations?: { readOnlyHint: boolean }; inputSchema?: unknown }>({
    assertCurrent() {},
    async listPage(cursor) {
      cursors.push(cursor);
      return cursor === undefined
        ? { tools: [{ name: "first", annotations: { readOnlyHint: true } }], nextCursor: "opaque/+==" }
        : { tools: [{ name: "last", inputSchema: { type: "object", required: ["query"] } }] };
    },
  });
  assert.deepEqual(cursors, [undefined, "opaque/+=="]);
  assert.deepEqual(result, [{ name: "first", annotations: { readOnlyHint: true } }, { name: "last", inputSchema: { type: "object", required: ["query"] } }]);
});

test("cycles and ambiguous duplicate names fail without publishing partial inventory", async () => {
  for (const mode of ["cycle", "duplicate"]) {
    let requests = 0;
    await assert.rejects(listMcpToolInventory({
      assertCurrent() {},
      async listPage() {
        requests++;
        return { tools: [{ name: mode === "cycle" ? `tool${requests}` : "same" }], nextCursor: "again" };
      },
    }), /repeated|duplicate/u);
    assert.equal(requests, 2);
  }
});

test("unbounded empty pages and excessive tool totals are rejected", async () => {
  let requests = 0;
  await assert.rejects(listMcpToolInventory({ assertCurrent() {}, listPage: async () => ({ tools: [], nextCursor: String(++requests) }) }), /page limit/u);
  assert.equal(requests, 64);
  requests = 0;
  await assert.rejects(listMcpToolInventory({
    assertCurrent() {},
    async listPage() { requests++; return { tools: Array.from({ length: 257 }, (_, i) => ({ name: `${requests}-${i}` })), nextCursor: String(requests) }; },
  }), /tool limit/u);
  assert.equal(requests, 2);
});

test("abort and configuration changes after a page prevent subsequent requests and stale publication", async () => {
  for (const reason of ["abort", "configuration"]) {
    const controller = new AbortController();
    let current = true;
    let requests = 0;
    await assert.rejects(listMcpToolInventory({
      signal: controller.signal,
      assertCurrent() { if (!current) throw new Error("changed"); },
      async listPage(_cursor, signal) {
        requests++;
        if (reason === "abort") { controller.abort(new Error("cancelled")); assert.equal(signal.aborted, true); }
        else current = false;
        return { tools: [{ name: "stale" }], nextCursor: "later" };
      },
    }), /cancelled|changed/u);
    assert.equal(requests, 1);
  }
});

test("already cancelled discovery sends no requests and later-page failures propagate", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  let requests = 0;
  await assert.rejects(listMcpToolInventory({ signal: controller.signal, assertCurrent() {}, async listPage() { requests++; return { tools: [] }; } }), /cancelled/u);
  assert.equal(requests, 0);
  await assert.rejects(listMcpToolInventory({ assertCurrent() {}, async listPage(cursor) { if (cursor) throw new Error("unavailable"); return { tools: [{ name: "partial" }], nextCursor: "page2" }; } }), /unavailable/u);
});

test("malformed or oversized cursors never become subsequent requests", async () => {
  for (const cursor of ["x".repeat(4097), 42, {}]) {
    let requests = 0;
    await assert.rejects(listMcpToolInventory({ assertCurrent() {}, async listPage() { requests++; return { tools: [], nextCursor: cursor as string }; } }), /invalid/u);
    assert.equal(requests, 1);
  }
});

for (const end of [undefined, null, ""]) {
  test(`a real tools/list page ending with nextCursor ${JSON.stringify(end)} completes the inventory`, async (t) => {
    const { client, requests } = await rawServerClient(t, (_method, params) => {
      const cursor = (params as { cursor?: string } | undefined)?.cursor;
      return cursor === undefined
        ? { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" }
        : { tools: [{ name: "last", inputSchema: { type: "object" } }], ...(end === undefined ? {} : { nextCursor: end }) };
    });
    const tools = await listMcpToolInventory({ assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }) });
    assert.deepEqual(tools.map(({ name }) => name), ["first", "last"]);
    assert.equal(requests().length, 2, "the end-of-list page is not followed by another request");
  });
}

test("each discovery page has its own deadline", async (t) => {
  const { client, requests } = await rawServerClient(t, (_method, params) => {
    if ((params as { cursor?: string } | undefined)?.cursor) return new Promise(() => {});
    return { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "stalled" };
  });
  const started = Date.now();
  await assert.rejects(
    listMcpToolInventory({ assertCurrent() {}, listPage: boundedMcpToolPageReader(client, 100) }),
    (error: unknown) => error instanceof McpTimeoutError,
  );
  assert.ok(Date.now() - started < 2_000, "the stalled second page times out at the page deadline");
  assert.equal(requests().length, 2);
});

test("non-object structured content from a real tools/call reaches the agent result and its output schema", async (t) => {
  const values: unknown[] = [[1, "two"], null, 0, false, "", "text"];
  let next = 0;
  const { client } = await rawServerClient(t, () => ({ content: [], structuredContent: values[next++] }));
  for (const value of values) {
    const schema = { type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value };
    const guard = createMcpToolCallGuard([{ name: "any", outputSchema: schema }]);
    const result = await executeMcpAgentTool(async () => {
      const raw = await callMcpTool(client, { name: "any", arguments: {} });
      guard.validateResult("any", raw);
      return raw;
    });
    assert.deepEqual(result.structuredContent, value);
    assert.match((result.content[0] as { text: string }).text, /Structured content/u);
  }
  const typed = createMcpToolCallGuard([{ name: "count", outputSchema: { type: "number" } }]);
  assert.throws(() => typed.validateResult("count", { content: [] }), /did not return structured content/u);
  assert.throws(() => typed.validateResult("count", { content: [], structuredContent: "1" }), /output schema/u);
});

test("complete inventory guards preserve early-page output schemas and task requirements", async () => {
  const tools = await listMcpToolInventory({ assertCurrent() {}, async listPage(cursor) {
    return cursor === undefined
      ? { tools: [
        { name: "validated", outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } },
        { name: "task", execution: { taskSupport: "required" } },
      ], nextCursor: "second" }
      : { tools: [{ name: "ordinary" }] };
  } });
  const guard = createMcpToolCallGuard(tools);
  assert.throws(() => guard.validateResult("validated", { content: [] }), /structured content/u);
  assert.throws(() => guard.validateResult("validated", { structuredContent: { value: "wrong" } }), /output schema/u);
  guard.validateResult("validated", { structuredContent: { value: 42 } });
  guard.validateResult("validated", { isError: true, content: [] });
  assert.throws(() => guard.assertCallable("task"), /task-based/u);
  guard.assertCallable("ordinary");
});

test("tools that reuse a schema $id each validate against their own output schema", () => {
  const schema = (field: string, nested: boolean) => nested
    ? { type: "object", properties: { item: { $id: "https://fixture.test/item", type: "object", required: [field] } }, required: ["item"] }
    : { $id: "https://fixture.test/out", type: "object", required: [field] };
  for (const nested of [false, true]) {
    const guard = createMcpToolCallGuard([
      { name: "alpha", outputSchema: schema("a", nested) },
      { name: "beta", outputSchema: schema("b", nested) },
      { name: "anonymous", outputSchema: { type: "object", required: ["c"] } },
    ]);
    const wrap = (value: object) => ({ structuredContent: nested ? { item: value } : value });
    for (const name of ["alpha", "beta", "anonymous"]) guard.assertCallable(name);
    guard.validateResult("alpha", wrap({ a: 1 }));
    assert.throws(() => guard.validateResult("alpha", wrap({ b: 1 })), /output schema/u);
    guard.validateResult("beta", wrap({ b: 1 }));
    assert.throws(() => guard.validateResult("beta", wrap({ a: 1 })), /output schema/u);
    guard.validateResult("anonymous", { structuredContent: { c: 1 } });
    assert.throws(() => guard.validateResult("anonymous", { structuredContent: { a: 1 } }), /output schema/u);
  }
});

test("an uncompilable output schema blocks only its own tool, before dispatch", async () => {
  const server = new Server({ name: "schema-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "broken", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const, properties: { value: { $ref: "#/missing" } } } },
    { name: "healthy", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const, required: ["value"] } },
  ] }));
  const dispatched: string[] = [];
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    dispatched.push(params.name);
    return { content: [], structuredContent: { value: 1 } };
  });
  const client = await connectedClient(server);
  try {
    const guard = createMcpToolCallGuard(await listMcpToolInventory({ assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }) }));
    const invoke = async (name: string) => {
      guard.assertCallable(name);
      const result = await callMcpTool(client, { name });
      guard.validateResult(name, result);
      return result;
    };
    await assert.rejects(invoke("broken"), /could not be compiled/u);
    assert.deepEqual((await invoke("healthy")).structuredContent, { value: 1 });
    assert.deepEqual(dispatched, ["healthy"]);
    assert.throws(() => createMcpToolCallGuard([{ name: "array", outputSchema: [] }]), /Invalid MCP tool output schema/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test("schema guards preserve server error diagnostics while validating successful output", async () => {
  const guard = createMcpToolCallGuard([{ name: "lookup", outputSchema: {
    type: "object", properties: { value: { type: "number" } }, required: ["value"],
  } }]);
  const execute = (result: unknown) => executeMcpAgentTool(async () => {
    guard.validateResult("lookup", result);
    return result;
  });
  await assert.rejects(execute({
    isError: true,
    content: [{ type: "text", text: "Lookup permission denied; reconnect the account." }],
    structuredContent: { code: "PERMISSION_DENIED", retryable: false },
  }), /Lookup permission denied; reconnect the account/u);
  for (const isError of [undefined, false, "true"]) {
    await assert.rejects(execute({ isError, content: [], structuredContent: { code: "PERMISSION_DENIED" } }), /output schema/u);
    await assert.rejects(execute({ isError, content: [] }), /did not return structured content/u);
  }
  const success = await execute({ isError: false, content: [], structuredContent: { value: 42 } });
  assert.deepEqual(JSON.parse(JSON.stringify(success.structuredContent)), { value: 42 });
});

test("raw requests preserve errors on every inventory page, envelopes, progress and cancellation", async () => {
  const server = new Server({ name: "inventory-fixture", version: "1" }, { capabilities: { tools: {} } });
  const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, outputSchema: {
    type: "object" as const, required: ["value"], properties: { value: { type: "number" } },
  } });
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => params?.cursor
    ? { tools: [tool("last"), { ...tool("task"), execution: { taskSupport: "required" } }] }
    : { tools: [tool("first")], nextCursor: "last-page" });
  let response: unknown = { isError: true, content: [{ type: "text", text: "Account permission denied" }], structuredContent: { code: "DENIED" } };
  let calls = 0;
  let entered = () => {};
  let cancelled = () => {};
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    calls++;
    if (params.arguments?.hang) {
      entered();
      await new Promise<void>(resolve => extra.signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
    } else if (params._meta?.progressToken !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken: params._meta.progressToken, progress: 1, total: 1 } });
    }
    return response as CallToolResult;
  });
  const client = await connectedClient(server);
  try {
    const inventory = await listMcpToolInventory({ assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }) });
    const guard = createMcpToolCallGuard(inventory);
    const invoke = async (name: string) => {
      guard.assertCallable(name);
      const result = await callMcpTool(client, { name });
      guard.validateResult(name, result);
      return result;
    };
    for (const name of ["first", "last"]) {
      const result = await invoke(name);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { code: "DENIED" });
      await assert.rejects(executeMcpAgentTool(async () => result), /Account permission denied/u);
    }
    const dispatched = calls;
    await assert.rejects(invoke("task"), /task-based/u);
    assert.equal(calls, dispatched);
    response = { content: [], structuredContent: { value: "wrong" } };
    await assert.rejects(invoke("last"), /output schema/u);
    response = { isError: "true", content: [] };
    await assert.rejects(invoke("last"), /boolean|invalid_type/u);
    response = { content: [], structuredContent: { value: 42 } };
    const progress: number[] = [];
    const success = await callMcpTool(client, { name: "last" }, { onProgress: update => progress.push(update.progress), timeoutMs: 500 });
    guard.validateResult("last", success);
    assert.deepEqual(success.structuredContent, { value: 42 });
    assert.deepEqual(progress, [1]);
    const controller = new AbortController();
    const started = new Promise<void>(resolve => { entered = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    const pending = callMcpTool(client, { name: "last", arguments: { hang: true } }, { signal: controller.signal, timeoutMs: 1_000 });
    const rejection = assert.rejects(pending, /cancelled by test/u);
    await started;
    controller.abort(new Error("cancelled by test"));
    await rejection;
    await aborted;
    const timedOut = new Promise<void>(resolve => { cancelled = resolve; });
    await assert.rejects(callMcpTool(client, { name: "last", arguments: { hang: true } }, {
      timeoutMs: 10,
    }), /timed out/u);
    await timedOut;
  } finally {
    await client.close();
    await server.close();
  }
});

test("inventory cache reuses a watched listChanged client's tools until the server announces a change", async () => {
  const connect = async (listChanged: boolean, watch: boolean) => {
    const server = new Server({ name: "cache-fixture", version: "1" }, { capabilities: { tools: listChanged ? { listChanged: true } : {} } });
    const client = new McpClient({ name: "test-client", version: "1" });
    let names = ["first"];
    let lists = 0;
    let failNext = false;
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      lists += 1;
      if (failNext) { failNext = false; throw new Error("transient list failure"); }
      return { tools: names.map((name) => ({ name, inputSchema: { type: "object" as const } })) };
    });
    const cache = createMcpToolInventoryCache<string[]>();
    if (watch) cache.watch(client);
    await client.connect(await connectSdkServer(server));
    const read = () => cache.load(client, async () => (await listMcpToolInventory({
      assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }),
    })).map(({ name }) => name));
    return {
      read, lists: () => lists,
      change: async (next: string[]) => { names = next; await server.sendToolListChanged(); },
      failNext: () => { failNext = true; },
      close: async () => { await client.close(); await server.close(); },
    };
  };

  const cached = await connect(true, true);
  try {
    assert.deepEqual(await Promise.all([cached.read(), cached.read()]), [["first"], ["first"]]);
    assert.deepEqual(await cached.read(), ["first"]);
    assert.equal(cached.lists(), 1);
    await cached.change(["first", "second"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await cached.read(), ["first", "second"]);
    assert.equal(cached.lists(), 2);
    await cached.change(["third"]);
    await new Promise((resolve) => setImmediate(resolve));
    cached.failNext();
    await assert.rejects(cached.read(), /transient list failure/u);
    assert.deepEqual(await cached.read(), ["third"]);
    assert.equal(cached.lists(), 4);
  } finally {
    await cached.close();
  }

  for (const [listChanged, watch] of [[false, true], [true, false]] as const) {
    const uncached = await connect(listChanged, watch);
    try {
      await uncached.read();
      await uncached.read();
      assert.equal(uncached.lists(), 2);
    } finally {
      await uncached.close();
    }
  }
});

test("a cached inventory waiter stops on its own abort without failing the shared read", async () => {
  const cache = createMcpToolInventoryCache<string>();
  const client = { onNotification() {}, serverCapabilities: { tools: { listChanged: true } } };
  cache.watch(client);
  let release!: (value: string) => void;
  let reads = 0;
  const read = () => { reads += 1; return new Promise<string>((resolve) => { release = resolve; }); };
  const revoked = new AbortController();
  const abandoned = cache.load(client, read, revoked.signal);
  const survivor = cache.load(client, read);
  revoked.abort(new Error("lease revoked"));
  await assert.rejects(abandoned, /lease revoked/u);
  release("inventory");
  assert.equal(await survivor, "inventory");
  assert.equal(await cache.load(client, read), "inventory");
  assert.equal(reads, 1);
});

test("a server without listChanged reuses its inventory for the TTL, then re-lists; close forgets it", async () => {
  let now = 0;
  let lists = 0;
  let names = ["first"];
  let failNext = false;
  const server = new Server({ name: "ttl-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    lists += 1;
    if (failNext) { failNext = false; throw new Error("transient list failure"); }
    return { tools: names.map((name) => ({ name, inputSchema: { type: "object" as const } })) };
  });
  const client = new McpClient({ name: "test-client", version: "1" });
  const cache = createMcpToolInventoryCache<{ names: string[]; guard: ReturnType<typeof createMcpToolCallGuard> }>({ ttlMs: 30_000, now: () => now });
  cache.watch(client);
  await client.connect(await connectSdkServer(server));
  const read = () => cache.load(client, async () => {
    const tools = await listMcpToolInventory({ assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }) });
    return { names: tools.map(({ name }) => name), guard: createMcpToolCallGuard(tools) };
  });
  try {
    const first = await read();
    now = 29_000;
    assert.equal(await read(), first, "the same inventory object is reused inside the TTL");
    assert.equal(lists, 1);
    assert.ok(first.guard.has("first"));
    assert.ok(!first.guard.has("second"));

    names = ["second"];
    now = 61_000;
    const refreshed = await read();
    assert.deepEqual(refreshed.names, ["second"]);
    assert.equal(lists, 2);

    now = 200_000;
    failNext = true;
    await assert.rejects(read(), /transient list failure/u);
    assert.deepEqual((await read()).names, ["second"], "a failed read is not retained");
    assert.equal(lists, 4);

    cache.forget(client);
    await read();
    assert.equal(lists, 5, "a forgotten client lists afresh");
  } finally {
    await client.close();
    await server.close();
  }
});

test("after a reconnect, calls are checked against the live client's inventory, not the one the tools were built from", async (t) => {
  const serve = async (tools: { name: string; outputSchema?: Record<string, unknown> }[]) => {
    const server = new Server({ name: "reconnect-fixture", version: "1" }, { capabilities: { tools: {} } });
    let calls = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ name, outputSchema }) => ({ name, inputSchema: { type: "object" as const }, ...(outputSchema ? { outputSchema } : {}) })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      calls += 1;
      return { content: [{ type: "text", text: "ok" }], structuredContent: { count: "many" } };
    });
    const client = await connectedClient(server);
    t.after(async () => { await client.close(); await server.close(); });
    const inventory = async () => ({ guard: createMcpToolCallGuard(await listMcpToolInventory({ assertCurrent() {}, listPage: (cursor, signal) => listMcpToolPage(client, cursor, { signal }) })) });
    return { client, inventory, calls: () => calls };
  };
  const before = await serve([{ name: "lookup" }, { name: "retired" }]);
  // The restarted server dropped one tool and now declares an output schema for the other.
  const after = await serve([{ name: "lookup", outputSchema: { type: "object", properties: { count: { type: "number" } } } }]);
  const discovered = { client: before.client, guard: (await before.inventory()).guard };

  const ok = await callMcpToolOnLiveClient(discovered, before.client, before.inventory, { name: "retired", arguments: {} });
  assert.equal(ok.isError, undefined);
  await assert.rejects(
    callMcpToolOnLiveClient(discovered, after.client, after.inventory, { name: "retired", arguments: {} }),
    /no longer offered/u,
  );
  assert.equal(after.calls(), 0, "a tool the live server no longer offers is never dispatched");
  await assert.rejects(
    callMcpToolOnLiveClient(discovered, after.client, after.inventory, { name: "lookup", arguments: {} }),
    /does not match the tool's output schema/u,
  );
});

test("tools whose input schema root is unusable are left out and reported, the rest stay offered", async (t) => {
  const { client } = await rawServerClient(t, () => ({ tools: [
    { name: "good", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "array-root", inputSchema: { type: "array" } },
    { name: "untyped-root", inputSchema: {} },
    { name: "bad-properties", inputSchema: { type: "object", properties: ["q"] } },
    { name: "bad-required", inputSchema: { type: "object", required: [1] } },
  ] }));
  const skipped: string[] = [];
  const tools = await listMcpToolInventory({
    assertCurrent() {},
    listPage: boundedMcpToolPageReader(client, 1_000, (name, reason) => skipped.push(`${name}: ${reason}`)),
  });
  assert.deepEqual(tools.map(({ name }) => name), ["good"]);
  assert.deepEqual(skipped.map((entry) => entry.split(":")[0]), ["array-root", "untyped-root", "bad-properties", "bad-required"]);
  await assert.rejects(listMcpToolPage({ request: async () => ({ tools: [{ inputSchema: { type: "object" } }] }) } as never, undefined),
    /Invalid entry/u, "a tool without a name still invalidates the page");
});
