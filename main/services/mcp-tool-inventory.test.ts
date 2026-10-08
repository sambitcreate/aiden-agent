import assert from "node:assert/strict";
import test from "node:test";
import { callMcpTool, createMcpToolCallGuard, createMcpToolInventoryCache, listMcpToolInventory, listMcpToolPage } from "./mcp-tool-inventory.js";
import { executeMcpAgentTool } from "./mcp-tool-result.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
  for (const cursor of ["", "x".repeat(4097), 42, null]) {
    let requests = 0;
    await assert.rejects(listMcpToolInventory({ assertCurrent() {}, async listPage() { requests++; return { tools: [], nextCursor: cursor as string }; } }), /invalid/u);
    assert.equal(requests, 1);
  }
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
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "broken", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const, properties: { value: { $ref: "#/missing" } } } },
    { name: "healthy", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const, required: ["value"] } },
  ] }));
  const dispatched: string[] = [];
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    dispatched.push(params.name);
    return { content: [], structuredContent: { value: 1 } };
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
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

test("public SDK requests preserve errors on every inventory page, envelopes, progress and cancellation", async () => {
  const server = new Server({ name: "inventory-fixture", version: "1" }, { capabilities: { tools: {} } });
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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
  await server.connect(serverTransport);
  await client.connect(clientTransport);
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
    const success = await callMcpTool(client, { name: "last" }, { onprogress: update => progress.push(update.progress), timeout: 500, maxTotalTimeout: 1_000, resetTimeoutOnProgress: true });
    guard.validateResult("last", success);
    assert.deepEqual(success.structuredContent, { value: 42 });
    assert.deepEqual(progress, [1]);
    const controller = new AbortController();
    const started = new Promise<void>(resolve => { entered = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    const pending = callMcpTool(client, { name: "last", arguments: { hang: true } }, { signal: controller.signal, timeout: 1_000 });
    const rejection = assert.rejects(pending, /cancelled by test/u);
    await started;
    controller.abort(new Error("cancelled by test"));
    await rejection;
    await aborted;
    const timedOut = new Promise<void>(resolve => { cancelled = resolve; });
    await assert.rejects(callMcpTool(client, { name: "last", arguments: { hang: true } }, {
      timeout: 10, maxTotalTimeout: 10,
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
    const client = new Client({ name: "test-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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
    await server.connect(serverTransport);
    await client.connect(clientTransport);
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
  const client = { setNotificationHandler() {}, getServerCapabilities: () => ({ tools: { listChanged: true } }) };
  cache.watch(client as never);
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
