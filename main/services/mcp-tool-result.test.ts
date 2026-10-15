import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { executeMcpAgentTool, mcpAgentToolPresentation, mcpAgentToolResult, mcpScriptResult, MAX_MCP_RESULT_TEXT_CHARS, MAX_MCP_IMAGES, MAX_MCP_IMAGE_BYTES, MAX_MCP_SCRIPT_CONTENT_BYTES, MAX_MCP_TOOL_DESCRIPTION_CHARS } from "./mcp-tool-result.js";
import { projectMessagesForModel } from "./generation-context.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";
/** The same PNG with a one-byte ancillary chunk, so its encoding ends in a single "=". */
const PADDED = (() => {
  const png = Buffer.from(PNG, "base64");
  const body = Buffer.from("teXt!", "latin1");
  const chunk = Buffer.concat([Buffer.from([0, 0, 0, 1]), body, Buffer.alloc(4)]);
  chunk.writeUInt32BE(crc32(body), 9);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString("base64");
})();

test("MCP structured results retain exact JSON values independently of their text summary", async () => {
  const payload = { answer: 42, nested: [{ enabled: true, label: "x".repeat(3000) }], empty: null };
  const result = await executeMcpAgentTool(async () => ({ content: [], structuredContent: payload }));
  assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent)), payload);
  payload.nested[0]!.label = "changed";
  assert.match(JSON.stringify(result.structuredContent), /x{3000}/u);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [cycle, { value: "x".repeat(200_000) }, { get fail() { throw new Error("must not run"); } }]) {
    assert.equal(mcpAgentToolResult({ structuredContent: value }).structuredContent, undefined);
  }
});

test("MCP images are validated, bounded and projected out for text-only models", async () => {
  const block = { type: "image", data: PNG, mimeType: "image/png" };
  const result = await executeMcpAgentTool(async () => ({ content: [block] }));
  assert.deepEqual(result.content[1], block);
  const messages = [{ role: "toolResult" as const, toolCallId: "call", toolName: "mcp_fixture", content: result.content, isError: false, timestamp: 1 }];
  assert.equal(projectMessagesForModel(messages, true)[0], messages[0]);
  const projected = projectMessagesForModel(messages, false)[0]!;
  assert.equal(projected.role, "toolResult");
  if (projected.role === "toolResult") assert.ok(projected.content.every((part) => part.type === "text"));
  for (const invalid of [{ ...block, data: "!!!!" }, { ...block, mimeType: "image/jpeg" },
    { ...block, data: Buffer.alloc(MAX_MCP_IMAGE_BYTES + 1).toString("base64") },
    { ...block, data: Buffer.from(PNG, "base64").subarray(0, 24).toString("base64") },
    // Non-canonical padding bits decode to the same bytes but are not the canonical encoding.
    { ...block, data: `${PNG.slice(0, -3)}h==` }, { ...block, data: `${PADDED.slice(0, -2)}${String.fromCharCode(PADDED.charCodeAt(PADDED.length - 2) + 1)}=` }]) {
    assert.equal(mcpAgentToolResult({ content: [invalid] }).content.length, 1);
  }
  assert.equal(mcpAgentToolResult({ content: [{ ...block, data: PADDED }] }).content[1]?.type, "image");
  const many = mcpAgentToolResult({ content: Array.from({ length: 10 }, () => ({ ...block })) });
  assert.equal(many.content.filter((part) => part.type === "image").length, MAX_MCP_IMAGES);
  assert.throws(() => mcpAgentToolResult({ content: [block], isError: true }), /image attached/u);
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
  assert.doesNotMatch(result, /PRIVATE_/);
  assert.match(result, /private.example/);
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


test("embedded MCP text and raster resources survive without dereferencing resource links", async () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error("No resource request is authorized"); };
  try {
    const result = await executeMcpAgentTool(async () => ({ content: [
      { type: "resource", resource: { uri: "file:///unopened/private.txt", text: "Embedded evidence" } },
      { type: "resource", resource: { uri: "custom://image", mimeType: "image/png", blob: PNG } },
      { type: "resource_link", uri: "https://example.invalid/artifact", name: "Artifact", description: "Available separately" },
      { type: "resource", resource: { uri: "custom://binary", mimeType: "application/octet-stream", blob: "SECRET_BINARY" } },
    ] }));
    const summary = result.content[0];
    assert.equal(summary.type, "text");
    if (summary.type !== "text") throw new Error("Missing summary");
    assert.match(summary.text, /Embedded evidence/);
    assert.match(summary.text, /example.invalid\/artifact/);
    assert.match(summary.text, /no resource was fetched/);
    assert.doesNotMatch(summary.text, /unopened|SECRET_BINARY/);
    assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: PNG });
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = original; }
  const result = mcpAgentToolResult({ content: Array.from({ length: 20 }, () => ({
    type: "resource", resource: { uri: "custom://image", mimeType: "image/png", blob: PNG },
  })) });
  assert.equal(result.content.filter((part) => part.type === "image").length, MAX_MCP_IMAGES);
  assert.ok(text({ content: [{ type: "resource", resource: { text: "x".repeat(100_000) } }] }).length <= MAX_MCP_RESULT_TEXT_CHARS);
});

test("structured content already serialized in a text block reaches the model once", () => {
  const structuredContent = { city: "Paris", temperature: 21, tags: ["sunny"] };
  const echoed = text({ content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }], structuredContent });
  assert.doesNotMatch(echoed, /Structured content/u);
  assert.equal(echoed.match(/Paris/gu)?.length, 1);
  // A text block that differs (prose, or different JSON) keeps the structured evidence.
  for (const other of ["It is 21 degrees in Paris.", JSON.stringify({ ...structuredContent, temperature: 22 })]) {
    assert.match(text({ content: [{ type: "text", text: other }], structuredContent }), /Structured content:[\s\S]*"temperature":21/u);
  }
});

test("model-facing MCP text keeps the end of oversized output, where errors usually are", async () => {
  const result = await executeMcpAgentTool(async () => ({ content: [{ type: "text", text: `start ${"x".repeat(100_000)} Error: final failure` }] }));
  const preview = (result.content[0] as { text: string }).text;
  assert.ok(preview.length <= MAX_MCP_RESULT_TEXT_CHARS);
  assert.match(preview, /^start /u);
  assert.match(preview, /Error: final failure$/u);
  assert.match(preview, /characters omitted from the middle/u);
});

test("script-facing results keep protocol blocks far beyond the model bound and say what they dropped", () => {
  const long = `begin${"a".repeat(MAX_MCP_SCRIPT_CONTENT_BYTES)}finish`;
  const result = mcpScriptResult({ content: [{ type: "text", text: "small" }, { type: "text", text: long }, { type: "resource_link", uri: "memo://x", name: "x" }], structuredContent: { ok: true }, isError: true });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { ok: true });
  assert.deepEqual(result.content[0], { type: "text", text: "small" });
  const kept = (result.content[1] as { text: string }).text;
  assert.ok(kept.length > 500_000);
  assert.match(kept, /^begin/u);
  assert.match(kept, /finish$/u);
  assert.match(kept, /characters omitted from the middle/u);
  assert.ok(Buffer.byteLength(JSON.stringify(result.content)) <= MAX_MCP_SCRIPT_CONTENT_BYTES + 1_024);
  assert.match(JSON.stringify(result.content[2]), /resource_link|omitted/u);
  const invalid = mcpScriptResult({ content: [null], structuredContent: { get secret() { throw new Error("accessor must not run"); } } });
  assert.match(JSON.stringify(invalid.content), /omitted: too large or invalid/u);
  assert.match(JSON.stringify(invalid.content), /structuredContent omitted: too large/u);
});

test("MCP tool presentation bounds descriptions, falls back to titles, and labels tools by server", () => {
  const long = mcpAgentToolPresentation("Docs", { name: "search", description: "d".repeat(50_000) });
  assert.ok(long.description.length <= MAX_MCP_TOOL_DESCRIPTION_CHARS);
  assert.equal(long.label, "Docs/search");
  const titled = mcpAgentToolPresentation("GitHub", { name: "list_issues", title: "List issues", outputSchema: { type: "object" } });
  assert.equal(titled.description, "List issues");
  assert.equal(titled.label, "GitHub/List issues");
  assert.deepEqual(titled.outputSchema, { type: "object" });
  const annotated = mcpAgentToolPresentation("  ", { name: "x", annotations: { title: "Annotated" }, outputSchema: "invalid" });
  assert.equal(annotated.description, "Annotated");
  assert.equal(annotated.label, "MCP/Annotated");
  assert.equal(annotated.outputSchema, undefined);
});
