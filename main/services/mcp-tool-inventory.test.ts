import assert from "node:assert/strict";
import test from "node:test";
import { createMcpToolCallGuard, listMcpToolInventory } from "./mcp-tool-inventory.js";
import { executeMcpAgentTool } from "./mcp-tool-result.js";

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
