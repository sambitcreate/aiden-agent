import assert from "node:assert/strict";
import test from "node:test";
import { assertUniqueMcpAgentToolNames, mcpAgentToolName } from "./mcp-tool-identity.js";
import { executeMcpAgentTool, mcpAgentToolResult, MAX_MCP_RESULT_TEXT_CHARS } from "./mcp-tool-result.js";

test("MCP agent tool names bind to stable server and raw tool identities", () => {
  const first = mcpAgentToolName({ id: "github-work", name: "GitHub" }, "create_issue");
  const second = mcpAgentToolName({ id: "github-personal", name: "GitHub" }, "create_issue");
  const punctuationA = mcpAgentToolName({ id: "server", name: "Same" }, "foo!");
  const punctuationB = mcpAgentToolName({ id: "server", name: "Same" }, "foo?");
  assert.notEqual(first, second);
  assert.notEqual(punctuationA, punctuationB);
  assert.ok(first.length <= 64);
  assert.ok(mcpAgentToolName({ id: "long", name: "x".repeat(200) }, "y".repeat(200)).length <= 64);
  assert.doesNotThrow(() => assertUniqueMcpAgentToolNames([{ name: first }, { name: second }]));
  assert.throws(
    () => assertUniqueMcpAgentToolNames([{ name: first }, { name: first }]),
    /identity collision/iu,
  );
});

test("maps a successful MCP result into Pi tool content", () => {
  assert.deepEqual(
    mcpAgentToolResult({
      content: [{ type: "text", text: "created issue 42" }],
      isError: false,
    }),
    {
      content: [{ type: "text", text: "created issue 42" }],
      details: null,
    },
  );
});

test("throws a standard resolved MCP isError result so Pi records tool failure", async () => {
  await assert.rejects(
    executeMcpAgentTool(async () => ({
      content: [{ type: "text", text: "permission denied" }],
      isError: true,
    })),
    /permission denied/u,
  );
});

function text(result: unknown): string {
  const part = mcpAgentToolResult(result).content[0];
  assert.equal(part.type, "text");
  return part.type === "text" ? part.text : "";
}

test("mixed MCP evidence retains text and structured content with explicit media omissions", () => {
  const result = text({ content: [{ type: "text", text: "evidence" },
    { type: "image", mimeType: "image/png", data: "PRIVATE_PIXELS" },
    { type: "audio", data: "PRIVATE_AUDIO" },
    { type: "resource_link", uri: "https://private.example" }], structuredContent: { answer: 42 } });
  assert.match(result, /evidence/);
  assert.match(result, /"answer":42/);
  assert.match(result, /image omitted/);
  assert.match(result, /audio omitted/);
  assert.match(result, /no resource was fetched/);
  assert.doesNotMatch(result, /PRIVATE_|private.example/);
});

test("binary-only results never stringify the protocol envelope", () => {
  const result = text({ content: [{ type: "image", data: "A".repeat(1_000_000) }] });
  assert.ok(result.length < 100);
  assert.match(result, /image omitted/);
  assert.doesNotMatch(result, /AAAA/);
});

test("every result is bounded before compaction pressure, including error and multipart output", () => {
  for (const content of [[{ type: "text", text: "x".repeat(1_000_000) }],
    Array.from({ length: 1000 }, () => ({ type: "text", text: "x".repeat(1000) }))]) {
    const result = text({ content });
    assert.ok(result.length <= MAX_MCP_RESULT_TEXT_CHARS);
    assert.match(result, /truncated/);
    assert.throws(() => mcpAgentToolResult({ content, isError: true }), (error: unknown) =>
      error instanceof Error && error.message.length <= MAX_MCP_RESULT_TEXT_CHARS && /truncated/.test(error.message));
  }
});

test("structured-only output is bounded for large, deep, cyclic, and non-JSON values", () => {
  const cycle: Record<string, unknown> = { answer: 42 };
  cycle.self = cycle;
  for (const structuredContent of [cycle, { value: "x".repeat(1_000_000) },
    { values: Array.from({ length: 10000 }, () => ({ value: "x".repeat(1000) })) },
    { value: BigInt(42) }, { get value() { throw new Error("accessor must not run"); } }]) {
    const result = text({ structuredContent });
    assert.ok(result.length <= MAX_MCP_RESULT_TEXT_CHARS);
    assert.match(result, /Structured content/);
    assert.match(result, /omitted|truncated|unsupported/);
  }
});

test("invalid blocks, unknown binary envelopes, and empty output have closed projections", () => {
  assert.match(text({ content: [null, { type: "unknown", data: "SECRET" }] }), /omitted/);
  assert.doesNotMatch(text({ content: [null, { type: "unknown", data: "SECRET" }] }), /SECRET/);
  assert.equal(text({ blob: "SECRET" }), "MCP tool returned no result.");
  assert.equal(text({ content: [] }), "MCP tool returned no result.");
  assert.throws(() => text(null), /invalid result/);
});

test("structured field limits never rename colliding keys or overwrite a real omission-named field", () => {
  const prefix = "k".repeat(128);
  const longKeys = text({ structuredContent: {
    [prefix + "a"]: "alpha", [prefix + "b"]: "beta", keep: "visible",
  } });
  assert.match(longKeys, /visible/);
  assert.doesNotMatch(longKeys, new RegExp(prefix));
  assert.match(longKeys, /fields omitted/);
  const fields: Record<string, string> = { "[omitted]": "KEEP_REAL_VALUE" };
  for (let index = 0; index < 40; index++) fields[`key${index}`] = "value";
  const result = text({ structuredContent: fields });
  assert.match(result, /KEEP_REAL_VALUE/);
  assert.match(result, /fields omitted/);
});
