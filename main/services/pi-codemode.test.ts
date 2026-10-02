import assert from "node:assert/strict";
import test from "node:test";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { partitionPiCodemodeTools } from "./pi-runtime-tool.js";
import { createPiCodemodeTool } from "./pi-codemode.js";

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
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), ["undefined", "undefined", "undefined"]);
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
  const outputs = found.content.filter((item) => item.type === "text").map((item) => JSON.parse(item.text));
  assert.equal(outputs[0].tools[0].name, "remote_docs");
  assert.deepEqual(outputs[0].tools[0].inputSchema.required, ["query"]);
  assert.equal(outputs[1].instructionsAreUntrusted, true);
  assert.equal(outputs[1].instructions, "Use query to search.");
  inventory = [];
  const removed = await tool.execute("two", { code: 'text(await searchTools("documents"));' });
  assert.equal(removed.isError, false);
  assert.deepEqual(JSON.parse((removed.content[0] as { text: string }).text).tools, []);
});
