import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import { runToolCall, type AgentTool, type AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { partitionPiCodemodeTools } from "./pi-runtime-tool.js";
import { codemodeResultSchema, createPiCodemodeTool, MAX_CODEMODE_TOOLS } from "./pi-codemode.js";
import { executeMcpAgentTool, MAX_MCP_RESULT_TEXT_CHARS, MAX_MCP_SCRIPT_STRUCTURED_BYTES } from "./mcp-tool-result.js";

/** A text item's own output, without the `==> text N/M <==` line that separates several items. */
function itemText(block: unknown): string {
  return (block as { text: string }).text.replace(/^==> text \d+\/\d+ <==\n/u, "");
}

function fixture() {
  const calls: Array<{ parent: string; name: string; args: unknown }> = [];
  const read: AgentTool = {
    name: "read_file", label: "Read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "fixture contents" }], details: { private: "host-only" } }),
  };
  const tool = createPiCodemodeTool({
    tools: () => [read, { ...read, name: "ask_user_question" }],
    async executeTool(parent, name, args) {
      calls.push({ parent, name, args });
      return {
        toolCall: { type: "toolCall", id: "nested", name, arguments: args as JsonObject },
        result: { content: [{ type: "text", text: "fixture contents" }], structuredContent: { count: 42 }, details: { private: "host-only" } },
        isError: false,
      };
    },
  });
  return { tool, calls };
}

test("real codemode worker calls only admitted host tools and projects public results", async () => {
  const { tool, calls } = fixture();
  const result = await tool.execute("parent", { code: 'const r = await tools.read_file({path:"demo.txt"}); text({count:r.structuredContent.count, private:r.details ?? null});' });
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { count: 42, private: null });
  assert.deepEqual(calls, [{ parent: "parent", name: "read_file", args: { path: "demo.txt" } }]);
  const denied = await tool.execute("other", { code: 'await tools.ask_user_question({});' });
  assert.equal(denied.isError, true);
  assert.equal(calls.length, 1);
});

test("codemode sandbox has no ambient Node or network authority and exposes argument discovery", async () => {
  const { tool } = fixture();
  const result = await tool.execute("parent", { code: 'text([typeof process, typeof require, typeof fetch]); text(await describeTool("read_file"));' });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(itemText(result.content[0])), ["undefined", "undefined", "undefined"]);
  assert.match((result.content[1] as { text: string }).text, /path: string/u);
});

test("codemode values persist only within their owning chat runtime", async () => {
  const first = fixture().tool;
  const second = fixture().tool;
  assert.equal((await first.execute("a", { code: 'store("answer", {value:42});' })).isError, false);
  const loaded = await first.execute("b", { code: 'text(load("answer"));' });
  assert.deepEqual(JSON.parse((loaded.content[0] as { text: string }).text), { value: 42 });
  const isolated = await second.execute("c", { code: 'text(load("answer") === undefined);' });
  assert.equal((isolated.content[0] as { text: string }).text, "true");
});

test("unawaited nested calls settle their cancellation before the parent tool returns", async () => {
  let started = false;
  let settled = false;
  const callable: AgentTool = { name: "read_file", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [], details: null }) };
  const tool = createPiCodemodeTool({
    tools: () => [callable],
    async executeTool(_parent, name, _args, signal) {
      started = true;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      settled = true;
      return { toolCall: { type: "toolCall", id: "nested", name, arguments: {} }, result: { content: [], details: null }, isError: true };
    },
  });
  await tool.execute("parent", { code: 'tools.read_file({}); await describeTool("read_file"); text("done");' });
  assert.equal(started, true);
  assert.equal(settled, true);
});

test("script cancellation terminates the worker and reaches pending host calls", async () => {
  const cancellation = new AbortController();
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  let cancelled = false;
  const callable: AgentTool = { name: "read_file", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [], details: null }) };
  const tool = createPiCodemodeTool({
    tools: () => [callable],
    async executeTool(_parent, name, _args, signal) {
      release();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return { toolCall: { type: "toolCall", id: "nested", name, arguments: {} }, result: { content: [], details: null }, isError: true };
    },
  });
  const run = tool.execute("parent", { code: 'await tools.read_file({});' }, cancellation.signal);
  await started;
  cancellation.abort();
  const result = await run;
  assert.equal(result.isError, true);
  assert.equal(cancelled, true);
});

test("codemode bounds model-facing output and reports script failures", async () => {
  const { tool } = fixture();
  const bounded = await tool.execute("parent", { code: 'text("x".repeat(50000));' });
  assert.equal(bounded.isError, false);
  assert.ok(JSON.stringify(bounded.content).length < 33_000);
  assert.match(JSON.stringify(bounded.content), /truncated/u);
  assert.equal((await tool.execute("parent", { code: 'throw new Error("script failed");' })).isError, true);
});

test("codemode keeps text() items apart and gathers console output after them", async () => {
  const { tool } = fixture();
  const result = await tool.execute("parent", { code: 'console.log("log one"); text("first"); console.warn("log two"); text("second");' });
  assert.equal(result.isError, false);
  assert.deepEqual(
    result.content.map((block) => (block as { text: string }).text),
    ["==> text 1/2 <==\nfirst", "==> text 2/2 <==\nsecond", "<console_output>\nlog one\nlog two\n</console_output>"],
  );
  const single = await tool.execute("parent", { code: 'text("only");' });
  assert.deepEqual(single.content, [{ type: "text", text: "only" }], "one text item carries no separator line");
});

test("nested operation usage is counted once on the parent tool result", async () => {
  const callable: AgentTool = { name: "read_file", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [], details: null }) };
  const tool = createPiCodemodeTool({
    tools: () => [callable],
    async executeTool(_parent, name) {
      return {
        toolCall: { type: "toolCall", id: "nested", name, arguments: {} },
        result: { content: [], details: null, usage: { input: 3, output: 2, cacheRead: 4, cacheWrite: 1, totalTokens: 10, reasoning: 1, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } } },
        isError: false,
      };
    },
  });
  const result = await tool.execute("parent", { code: 'await tools.read_file({}); await tools.read_file({}); text("done");' });
  assert.equal(result.usage?.totalTokens, 20);
  assert.equal(result.usage?.output, 4);
  assert.equal(result.usage?.reasoning, 2);
  assert.equal(result.usage?.cost.total, 0.2);
});

test("codemode forwards valid images but malformed raster output never enters model context", async () => {
  const { tool } = fixture();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
  const valid = await tool.execute("parent", { code: `image(${JSON.stringify({ type: "image", mimeType: "image/png", data: png })});` });
  assert.equal(valid.isError, false);
  assert.equal(valid.content[0].type, "image");
  const truncated = Buffer.from(png, "base64").subarray(0, 24).toString("base64");
  const invalid = await tool.execute("parent", { code: `image(${JSON.stringify({ type: "image", mimeType: "image/png", data: truncated })});` });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content.some((part) => part.type === "image"), false);
  const limited = await tool.execute("parent", { code: `for (let i = 0; i < 7; i++) image(${JSON.stringify({ type: "image", mimeType: "image/png", data: png })});` });
  assert.equal(limited.content.filter((part) => part.type === "image").length, 4);
  assert.equal(limited.content.filter((part) => part.type === "text" && /output limit/u.test(part.text)).length, 1);
});


test("deferral requires explicit host admission, discovery metadata and an admitted codemode tool", () => {
  const core: AgentTool = { name: "read_file", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => ({ content: [], details: null }) };
  const remote = Object.assign({ ...core, name: "remote_docs" }, { codemode: true, discovery: { namespace: "docs", label: "Documents" } });
  const undeclared = { ...core, name: "mcp_guessed" };
  const optedOut = { ...remote, name: "denied", codemode: false };
  const hostOnly = { ...core, name: "host", codemode: true };
  const codemode = fixture().tool;
  const inventory = [core, remote, undeclared, optedOut, hostOnly];
  assert.deepEqual(partitionPiCodemodeTools(inventory), { declared: inventory, deferred: [] });
  const enabled = partitionPiCodemodeTools([...inventory, codemode]);
  assert.deepEqual(enabled.deferred.map((tool) => tool.name), ["remote_docs"]);
  assert.deepEqual(enabled.declared.map((tool) => tool.name), ["read_file", "mcp_guessed", "denied", "host", "codemode"]);
  assert.deepEqual(partitionPiCodemodeTools([core, codemode]).deferred, []);
});

test("sandbox discovery exposes fresh admitted schemas and treats server instructions as data", async () => {
  const base: AgentTool = { name: "remote_docs", label: "Docs", description: "Search documents", parameters: Type.Object({ query: Type.String() }), execute: async () => ({ content: [], details: null }) };
  let inventory = [Object.assign(base, { codemode: true, discovery: { namespace: "docs", label: "Documents", instructions: "Use query to search." } })];
  const tool = createPiCodemodeTool({ tools: () => inventory, executeTool: async () => { throw new Error("Discovery must not dispatch effects"); } });
  const found = await tool.execute("one", { code: 'text(await searchTools("documents", {namespace:"docs"})); text(await describeNamespace("docs"));' });
  assert.equal(found.isError, false);
  const outputs = found.content.filter((item) => item.type === "text").map((item) => JSON.parse(itemText(item)));
  assert.equal(outputs[0].tools[0].name, "remote_docs");
  assert.deepEqual(outputs[0].tools[0].inputSchema.required, ["query"]);
  assert.equal(outputs[1].instructionsAreUntrusted, true);
  assert.equal(outputs[1].instructions, "Use query to search.");
  inventory = [];
  const removed = await tool.execute("two", { code: 'text(await searchTools("documents"));' });
  assert.equal(removed.isError, false);
  assert.deepEqual(JSON.parse((removed.content[0] as { text: string }).text).tools, []);
});

test("runaway sandbox output fails even when the script catches the output limit", async () => {
  const { tool } = fixture();
  const result = await tool.execute("bounded", { code: 'try { for (let i=0;i<110000;i++) text("x"); } catch {} text("continued"); store("overflowed",true);' });
  assert.equal(result.isError, true);
  assert.ok(result.content.some((item) => item.type === "text" && /output exceeded the limit/.test(item.text)));
  const next = await tool.execute("next", { code: 'text(load("overflowed") === undefined);' });
  assert.equal(next.content[0]?.type === "text" && next.content[0].text, "true", "failed executions must not commit store writes");
});

/** A host whose MCP server finishes discovery only when `arrive` is called. */
function lateServerFixture() {
  const read: AgentTool = {
    name: "read_file", label: "Read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "contents" }], details: null }),
  };
  const remote = Object.assign<AgentTool, object>({
    name: "docs__search", label: "search", description: "Search the documentation.", parameters: Type.Object({ query: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "found" }], details: null }),
  }, { codemode: true, discovery: Object.freeze({ namespace: "mcp:docs", label: "Docs" }) });
  const available: AgentTool[] = [read];
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = () => { available.push(remote); resolve(); }; });
  let waits = 0;
  const calls: string[] = [];
  const tool = createPiCodemodeTool({
    tools: () => available,
    settled: async (signal) => {
      waits += 1;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        void arrived.then(resolve);
      });
    },
    async executeTool(_parent, name, args) {
      calls.push(name);
      return {
        toolCall: { type: "toolCall", id: "nested", name, arguments: args as JsonObject },
        result: { content: [{ type: "text", text: `${name} result` }], details: null },
        isError: false,
      };
    },
  });
  return { tool, arrive, waits: () => waits, calls };
}

test("a script that searches waits for servers still discovering, then can call their tools", async () => {
  const { tool, arrive, calls } = lateServerFixture();
  const running = tool.execute("parent", { code: 'const found = await searchTools("documentation"); text(found.tools.map((t) => t.name)); const r = await tools.docs__search({query:"x"}); text(r.content[0].text);' });
  setTimeout(arrive, 20);
  const result = await running;
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(itemText(result.content[0])), ["docs__search"]);
  assert.equal(itemText(result.content[1]), "docs__search result");
  assert.deepEqual(calls, ["docs__search"]);
});

test("a script that only calls tools already available starts without waiting", async () => {
  const { tool, waits, calls } = lateServerFixture();
  const result = await tool.execute("parent", { code: 'const r = await tools.read_file({path:"a"}); text(r.content[0].text);' });
  assert.equal(result.isError, false);
  assert.equal(waits(), 0);
  assert.deepEqual(calls, ["read_file"]);
});

test("waiting for pending servers stops when the script is cancelled", async () => {
  const { tool } = lateServerFixture();
  const controller = new AbortController();
  const running = tool.execute("parent", { code: 'text(ALL_TOOLS.length);' }, controller.signal);
  controller.abort(new Error("turn stopped"));
  await assert.rejects(running, /turn stopped/u);
});

async function mcpFixture(t: TestContext, results: Record<string, () => Record<string, unknown>>, outputSchema?: Record<string, unknown>) {
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.keys(results).map((name) => ({ name, inputSchema: { type: "object" as const }, ...(outputSchema ? { outputSchema } : {}) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => results[params.name]!() as never);
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  await client.listTools();
  const tools: AgentTool[] = Object.keys(results).map((name) => Object.assign({
    name: `mcp_${name}`, label: name, description: name, parameters: Type.Object({}),
    ...(outputSchema ? { outputSchema: Type.Unsafe(outputSchema) } : {}),
    execute: () => executeMcpAgentTool(() => client.callTool({ name, arguments: {} })),
  }, { codemode: true }));
  return tools;
}

/** Runs nested calls through Pi's own tool-call path, hooks included, as the harness does. */
function codemodeOver(tools: AgentTool[], afterToolCall?: Parameters<typeof runToolCall>[1]["afterToolCall"]) {
  const assistantMessage = { role: "assistant", content: [], api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 } as const;
  const nested: AgentToolCallOutcome[] = [];
  const tool = createPiCodemodeTool({
    tools: () => tools,
    async executeTool(_parent, name, args, signal) {
      const outcome = await runToolCall({ type: "toolCall", id: `nested-${nested.length}`, name, arguments: args as JsonObject }, {
        tools, assistantMessage: assistantMessage as never, context: { messages: [], tools } as never, signal, afterToolCall,
      });
      nested.push(outcome);
      return outcome;
    },
  });
  return { tool, nested };
}

const scriptText = (result: Awaited<ReturnType<AgentTool["execute"]>>) =>
  result.content.filter((item) => item.type === "text").map((item) => (item as { text: string }).text).join("\n");

test("codemode scripts read whole MCP results from a real server while the model-facing result stays bounded", async (t) => {
  const text = `HEAD${"x".repeat(200_000)}TAIL`;
  const rows = Array.from({ length: 3_000 }, (_, index) => ({ id: index, name: `row-${index}` }));
  const tools = await mcpFixture(t, {
    big: () => ({ content: [{ type: "text", text }], structuredContent: { rows } }),
    failing: () => ({ content: [{ type: "text", text: `failure detail ${"y".repeat(50_000)} at the end` }], isError: true }),
  });
  const { tool, nested } = codemodeOver(tools);
  const result = await tool.execute("parent", { code: `
    const r = await tools.mcp_big({});
    text({ length: r.content[0].text.length, tail: r.content[0].text.slice(-4), rows: r.structuredContent.rows.length, last: r.structuredContent.rows[2999].name, isError: r.isError });
    const f = await tools.mcp_failing({});
    text({ isError: f.isError, end: f.content[0].text.slice(-10) });` });
  assert.equal(result.isError, false, scriptText(result));
  const [big, failing] = result.content.map((item) => JSON.parse(itemText(item)));
  assert.deepEqual(big, { length: text.length, tail: "TAIL", rows: 3_000, last: "row-2999", isError: false });
  assert.deepEqual(failing, { isError: true, end: "at the end" });
  // The model-facing results of the same calls kept their 32K bound.
  for (const outcome of nested) {
    assert.ok(JSON.stringify(outcome.result.content).length < MAX_MCP_RESULT_TEXT_CHARS + 1_000);
  }
});

test("script-facing MCP results mark structured content that is too large instead of dropping it silently", async (t) => {
  const tools = await mcpFixture(t, {
    huge: () => ({ content: [{ type: "text", text: "summary" }], structuredContent: { blob: "z".repeat(MAX_MCP_SCRIPT_STRUCTURED_BYTES + 10) } }),
  });
  const { tool } = codemodeOver(tools);
  const result = await tool.execute("parent", { code: 'const r = await tools.mcp_huge({}); text({ has: r.structuredContent !== undefined, notes: r.content.map((c) => c.text) });' });
  const value = JSON.parse(scriptText(result));
  assert.equal(value.has, false);
  assert.deepEqual(value.notes, ["summary", "[structuredContent omitted: too large]"]);
});

test("a hook that rewrites an MCP result wins over the script-facing full result", async (t) => {
  const tools = await mcpFixture(t, { secret: () => ({ content: [{ type: "text", text: "secret value" }], structuredContent: { secret: "value" } }) });
  const { tool } = codemodeOver(tools, async ({ toolCall }) => toolCall.name === "mcp_secret" ? { content: [{ type: "text", text: "redacted" }] } : undefined);
  const result = await tool.execute("parent", { code: 'const r = await tools.mcp_secret({}); text({ content: r.content, structured: r.structuredContent ?? null });' });
  assert.deepEqual(JSON.parse(scriptText(result)), { content: [{ type: "text", text: "redacted" }], structured: null });
});

test("a hook that replaces or drops only structured content wins over the script-facing full result", async (t) => {
  const tools = await mcpFixture(t, {
    filtered: () => ({ content: [{ type: "text", text: "summary" }], structuredContent: { restricted: "original" } }),
    dropped: () => ({ content: [{ type: "text", text: "summary" }], structuredContent: { restricted: "original" } }),
    kept: () => ({ content: [{ type: "text", text: "summary" }], structuredContent: { open: "value" } }),
  });
  const { tool } = codemodeOver(tools, async ({ toolCall, result }) => {
    if (toolCall.name === "mcp_filtered") return { structuredContent: { filtered: true } };
    // Returning the same content array without structured content removes it.
    if (toolCall.name === "mcp_dropped") return { content: result.content };
    return undefined;
  });
  const result = await tool.execute("parent", { code: `
    for (const name of ["mcp_filtered", "mcp_dropped", "mcp_kept"]) {
      const r = await tools[name]({});
      text({ name, structured: r.structuredContent ?? null });
    }` });
  assert.equal(result.isError, false, scriptText(result));
  assert.deepEqual(result.content.map((item) => JSON.parse(itemText(item))), [
    { name: "mcp_filtered", structured: { filtered: true } },
    { name: "mcp_dropped", structured: null },
    { name: "mcp_kept", structured: { open: "value" } },
  ]);
});

test("MCP call declarations type the resolved result with the tool's structured-content schema", async () => {
  const outputSchema = {
    type: "object", properties: { items: { type: "array", items: { $ref: "#/$defs/Item" } } }, required: ["items"],
    $defs: { Item: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  };
  const remote = (name: string, extra: Partial<AgentTool> = {}): AgentTool => Object.assign({
    name, label: name, description: name, parameters: Type.Object({ query: Type.String() }),
    execute: async () => ({ content: [], details: null }), ...extra,
  }, { codemode: true });
  const tool = createPiCodemodeTool({
    tools: () => [remote("search-docs", { outputSchema: Type.Unsafe(outputSchema) }), remote("plain_tool")],
    executeTool: async () => { throw new Error("not called"); },
  });
  const result = await tool.execute("p", { code: 'text(await describeTool("search_docs")); text(await describeTool("plain-tool"));' });
  assert.equal(result.isError, false, scriptText(result));
  const [typed, untyped] = result.content.map((item) => (item as { text: string }).text);
  assert.match(typed!, /search_docs\(args: \{ query: string; \}\): Promise<\{/u);
  assert.match(typed!, /content: Array<\{/u);
  assert.match(typed!, /isError: boolean/u);
  // The relocated $ref resolves to the item type instead of collapsing to unknown.
  assert.match(typed!, /structuredContent\?: \{ items: Array<\{ title: string; [^}]*\}>; [^}]*\}/u);
  assert.match(untyped!, /plain_tool\(args: \{ query: string; \}\): Promise<\{/u);
  const ambiguous = createPiCodemodeTool({ tools: () => [remote("a-b"), remote("a_b")], executeTool: async () => { throw new Error("not called"); } });
  const failed = await ambiguous.execute("p", { code: 'text(await describeTool("a.b"));' });
  assert.equal(failed.isError, true);
  assert.match(scriptText(failed), /Ambiguous/u);
  assert.equal((await ambiguous.execute("p", { code: 'text(await describeTool("a-b"));' })).isError, false);
});

test("output schemas too large to render fall back to unknown structured content", () => {
  const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [`field_${index}`, { type: "string" }])) };
  assert.deepEqual((codemodeResultSchema(huge).properties as Record<string, unknown>).structuredContent, {});
  assert.notDeepEqual((codemodeResultSchema({ type: "object", properties: { a: { type: "string" } } }).properties as Record<string, unknown>).structuredContent, {});
});

test("an inventory above the tool limit keeps codemode working with a capped, reported set", async () => {
  const make = (name: string, discovered: boolean): AgentTool => Object.assign({
    name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [], details: null }),
  }, { codemode: true }, discovered ? { discovery: { namespace: "mcp:x", label: "X" } } : {});
  const inventory = [...Array.from({ length: MAX_CODEMODE_TOOLS + 5 }, (_, index) => make(`remote_${index}`, true)), make("read_file", false)];
  const calls: string[] = [];
  const tool = createPiCodemodeTool({
    tools: () => inventory,
    async executeTool(_parent, name) {
      calls.push(name);
      return { toolCall: { type: "toolCall", id: "n", name, arguments: {} }, result: { content: [{ type: "text", text: "ok" }], details: null }, isError: false };
    },
  });
  const result = await tool.execute("p", { code: 'await tools.read_file({}); text(ALL_TOOLS.length);' });
  assert.equal(result.isError, false, scriptText(result));
  assert.deepEqual(calls, ["read_file"]);
  assert.equal((result.content[0] as { text: string }).text, String(MAX_CODEMODE_TOOLS));
  assert.match(scriptText(result), /6 tools omitted above the 512-tool limit/u);
  assert.equal((result.details as { omittedTools?: number }).omittedTools, 6);
});
