import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedSubagentMcpFetch } from "./subagent-mcp-bounded-fetch.js";

test("bounded child MCP fetch rejects declared oversized responses and redirects", async () => {
  let observedRedirect: RequestRedirect | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const guarded = createBoundedSubagentMcpFetch(async (_request, init) => {
    observedRedirect = init?.redirect;
    return new Response(body, { headers: { "content-length": "9" } });
  }, 8);
  await assert.rejects(guarded("https://mcp.test"), /transport limit/u);
  assert.equal(observedRedirect, "error");
  assert.equal(cancelled, true);
});

test("bounded child MCP fetch rejects a chunked decoded stream before materialization", async () => {
  const encoder = new TextEncoder();
  const guarded = createBoundedSubagentMcpFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("1234"));
            controller.enqueue(encoder.encode("56789"));
            controller.close();
          },
        }),
      ),
    8,
  );
  const response = await guarded("https://mcp.test");
  await assert.rejects(response.text(), /transport limit/u);
});

test("bounded child MCP fetch preserves in-budget response metadata and cancellation", async () => {
  let cancelled: unknown;
  const guarded = createBoundedSubagentMcpFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("safe"));
          },
          cancel(reason) {
            cancelled = reason;
          },
        }),
        { status: 202, statusText: "Accepted", headers: { "x-test": "yes" } },
      ),
    8,
  );
  const response = await guarded("https://mcp.test");
  assert.equal(response.status, 202);
  assert.equal(response.statusText, "Accepted");
  assert.equal(response.headers.get("x-test"), "yes");
  await response.body?.cancel("stop");
  assert.equal(cancelled, "stop");
});
