import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactGenerationContext } from "./generation-context.js";
import { ToolOutputStore, toolOutputScope, MAX_STORED_TOOL_OUTPUT_CHARS, toolOutputCredentialFingerprint } from "./tool-output-store.js";
import { boundedToolOutput, createDurableToolOutputs, withDurableToolOutputs, markToolOutputSource } from "./tool-output-context.js";
import { executeMcpAgentTool, MAX_MCP_RESULT_TEXT_CHARS } from "./mcp-tool-result.js";

test("retained output survives restart but never crosses chat, authority, tool, deletion or expiry boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-spill-"));
  let now = 1_000;
  try {
    const scope = toolOutputScope({ root: "private", permission: "ask" });
    const store = new ToolOutputStore(() => root, () => now);
    const handle = await store.put("chat-a", scope, "run_command", "private α output", () => true);
    const reopened = new ToolOutputStore(() => root, () => now);
    assert.match(await reopened.read("chat-a", scope, new Set(["run_command"]), handle, 8, 8_000), /α output/u);
    for (const [chat, authority, tools] of [
      ["chat-b", scope, new Set(["run_command"])],
      ["chat-a", toolOutputScope("changed"), new Set(["run_command"])],
      ["chat-a", scope, new Set(["read_file"])],
    ] as const) await assert.rejects(reopened.read(chat, authority, tools, handle, 0, 8_000), /unavailable/u);
    assert.equal((await stat(join(root, "tool-output-spills.json"))).mode & 0o777, 0o600);
    await assert.rejects(store.read("chat-a", scope, new Set(["run_command"]), "../secret", 0, 1));
    await assert.rejects(store.read("chat-a", scope, new Set(["run_command"]), handle, 0, 8_001));
    await assert.rejects(store.put("chat-a", scope, "run_command", "x".repeat(MAX_STORED_TOOL_OUTPUT_CHARS + 1), () => true));
    await assert.rejects(store.put("chat-a", scope, "run_command", "late secret", () => false));
    now += 7 * 24 * 60 * 60 * 1_000;
    await assert.rejects(reopened.read("chat-a", scope, new Set(["run_command"]), handle, 0, 1), /unavailable/u);
    await reopened.pruneExpired();
    assert.deepEqual(JSON.parse(await readFile(join(root, "tool-output-spills.json"), "utf8")), []);
    now = 1_000;
    await reopened.deleteByChat("chat-a");
    await assert.rejects(new ToolOutputStore(() => root).read("chat-a", scope, new Set(["run_command"]), handle, 0, 1), /unavailable/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP previews retain recoverable normalized text with fresh authority checks and no foreign resource fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-mcp-spill-"));
  try {
    let current = true;
    const raw = "x".repeat(50_000) + "retained-tail";
    const tools = withDurableToolOutputs({
      tools: [markToolOutputSource({ name: "mcp_test", label: "Test", description: "test", parameters: Type.Object({}),
        execute: async () => executeMcpAgentTool(async () => ({ content: [{ type: "text", text: raw }, { type: "resource_link", uri: "file:///secret" }] })),
      })],
      store: new ToolOutputStore(() => root), chatId: "a", scope: toolOutputScope("scope"),
      isCurrent: () => current, assertCurrent: async () => { if (!current) throw new Error("revoked"); },
    });
    const result = await tools[0]!.execute("call", {});
    const preview = result.content[0];
    assert.equal(preview.type, "text");
    if (preview.type !== "text") return;
    assert.ok(preview.text.length <= MAX_MCP_RESULT_TEXT_CHARS);
    // The preview keeps both ends; the omitted middle is recoverable from the retained copy.
    assert.ok(preview.text.includes("retained-tail"));
    assert.ok(preview.text.split("x").length - 1 < 50_000);
    // Resource links are named as data, never dereferenced.
    assert.match(preview.text, /no resource was fetched/u);
    const handle = /handle=([a-f0-9-]+)/u.exec(preview.text)?.[1];
    assert.ok(handle);
    const read = await tools[1]!.execute("read", { handle, offset: 50_000 });
    assert.match(JSON.stringify(read.content), /retained-tail/u);
    current = false;
    await assert.rejects(tools[1]!.execute("read", { handle }), /revoked/u);
    const fallback = await tools[0]!.execute("again", {});
    assert.match(JSON.stringify(fallback.content), /no retained output/u);
    assert.match(await boundedToolOutput(raw, 100), /no retained output/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an MCP tool admitted after the turn started keeps a recoverable oversized result", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-mcp-late-spill-"));
  try {
    // Previews keep the head and tail, so the recoverable part is the middle.
    const raw = "x".repeat(25_000) + "late-middle" + "x".repeat(25_000);
    const lateTool = markToolOutputSource({ name: "mcp_slow_search", label: "Slow", description: "test", parameters: Type.Object({}),
      execute: async () => executeMcpAgentTool(async () => ({ content: [{ type: "text", text: raw }] })),
    });
    const outputs = createDurableToolOutputs({
      tools: [],
      store: new ToolOutputStore(() => root), chatId: "a", scope: toolOutputScope("scope"),
      isCurrent: () => true, assertCurrent: async () => {},
    });
    const reader = outputs.tools.find((tool) => tool.name === "read_tool_output")!;
    const [adopted] = outputs.adopt([lateTool]);
    assert.equal(outputs.adopt([lateTool])[0], adopted, "the harness snapshots late tools by identity");
    const result = await adopted!.execute("call", {});
    const preview = result.content[0];
    assert.equal(preview?.type, "text");
    if (preview?.type !== "text") return;
    assert.ok(!preview.text.includes("late-middle"), "the oversized middle is cut from the preview");
    const handle = /handle=([a-f0-9-]+)/u.exec(preview.text)?.[1];
    assert.ok(handle, "the late result was retained");
    const read = await reader.execute("read", { handle, offset: 24_990 });
    assert.match(JSON.stringify(read.content), /late-middle/u);
    // A late tool cannot replace the reader.
    assert.deepEqual(outputs.adopt([{ ...lateTool, name: "read_tool_output" }]), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("credential ciphertext changes revoke durable scope across restart and refuse symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-spill-credentials-"));
  try {
    const before = await toolOutputCredentialFingerprint(root);
    await writeFile(join(root, "mcp-oauth.json"), '{"server":"encrypted-account-a"}');
    const first = await toolOutputCredentialFingerprint(root);
    assert.notDeepEqual(first, before);
    assert.deepEqual(await toolOutputCredentialFingerprint(root), first);
    await writeFile(join(root, "mcp-oauth.json"), '{"server":"encrypted-account-b"}');
    assert.notDeepEqual(await toolOutputCredentialFingerprint(root), first);
    await symlink(join(root, "mcp-oauth.json"), join(root, "provider-keys.json"));
    await assert.rejects(toolOutputCredentialFingerprint(root), /authority is unavailable/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("global retention is bounded and non-source tool executions cannot spill private child output", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-spill-quota-"));
  try {
    const store = new ToolOutputStore(() => root);
    const scope = toolOutputScope("scope");
    const first = await store.put("a", scope, "run_command", "x".repeat(2_000_000), () => true);
    await store.put("a", scope, "run_command", "y".repeat(2_000_000), () => true);
    await store.put("a", scope, "run_command", "z", () => true);
    await assert.rejects(store.read("a", scope, new Set(["run_command"]), first, 0, 1), /unavailable/u);
    const records = JSON.parse(await readFile(join(root, "tool-output-spills.json"), "utf8")) as { text: string }[];
    assert.ok(records.reduce((sum, row) => sum + row.text.length, 0) <= 4_000_000);
    const tools = withDurableToolOutputs({ tools: [{
      name: "subagent", label: "Subagent", description: "test", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: await boundedToolOutput("private-child".repeat(100), 100) }], details: null }),
    }], store, scope, chatId: "a", assertCurrent: async () => {}, isCurrent: () => true });
    const result = await tools[0]!.execute("child", {});
    assert.match(JSON.stringify(result.content), /no retained output/u);
    assert.doesNotMatch(await readFile(join(root, "tool-output-spills.json"), "utf8"), /private-child/u);
    const mcp = await executeMcpAgentTool(async () => ({ content: Array.from({ length: 65 }, (_, index) => ({ type: "text", text: `part-${index}` })) }));
    assert.match(JSON.stringify(mcp.content), /part-64/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("publication after the final async authority check cannot return retained text", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-spill-race-"));
  try {
    const store = new ToolOutputStore(() => root);
    const scope = toolOutputScope("race");
    const handle = await store.put("a", scope, "run_command", "private", () => true);
    let current = true;
    let checks = 0;
    const tools = withDurableToolOutputs({ tools: [{ name: "run_command", label: "test", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [], details: null }) }], store, chatId: "a", scope,
      isCurrent: () => current,
      assertCurrent: async () => { if (++checks === 2) queueMicrotask(() => { current = false; }); },
    });
    await assert.rejects(tools[1]!.execute("read", { handle }), /access changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Pi credential rotation revokes a prior generation handle after restart without MCP servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-pi-spill-"));
  try {
    await writeFile(join(root, "pi-provider-credentials.json"), "encrypted-account-a");
    const scope = toolOutputScope({ servers: [], credentials: await toolOutputCredentialFingerprint(root) });
    const handle = await new ToolOutputStore(() => root).put("chat", scope, "run_command", "old output", () => true);
    await writeFile(join(root, "pi-provider-credentials.json"), "encrypted-account-b");
    const nextScope = toolOutputScope({ servers: [], credentials: await toolOutputCredentialFingerprint(root) });
    assert.notEqual(nextScope, scope);
    await assert.rejects(new ToolOutputStore(() => root).read("chat", nextScope, new Set(["run_command"]), handle, 0, 100), /unavailable/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("elided output previews retain scoped recovery without repeating completed commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-elided-spill-"));
  try {
    let current = true;
    const raw = "x".repeat(50_000) + "unique-result-after-preview";
    const store = new ToolOutputStore(() => root);
    const scope = toolOutputScope("elision");
    const tools = withDurableToolOutputs({
      tools: [{ name: "run_command", label: "Run", description: "fixture", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: await boundedToolOutput(raw, 16_000) }], details: null }),
      }],
      store, chatId: "chat", scope,
      isCurrent: () => current,
      assertCurrent: async () => { if (!current) throw new Error("revoked"); },
    });
    const messages: AgentMessage[] = [{ role: "user", content: "Inspect command results", timestamp: 1 }];
    for (let index = 0; index < 8; index += 1) {
      const id = `command-${index}`;
      const result = await tools[0]!.execute(id, {});
      const assistant: AssistantMessage = {
        role: "assistant", content: [{ type: "toolCall", id, name: "run_command", arguments: {} }],
        api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: 2 + index * 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      messages.push(assistant, { role: "toolResult", toolCallId: id, toolName: "run_command", content: result.content, isError: false, timestamp: 3 + index * 2 });
    }
    // Rehydration must retain recovery too; no process-local identity is available.
    const rehydrated = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
    const result = compactGenerationContext(rehydrated, { contextWindow: 16_000, systemPrompt: "Inspect evidence", tools: [] });
    assert.ok(result.compactedToolResults > 0);
    assert.equal(result.removedCurrentTurnMessages, 0);
    assert.ok(result.estimatedTokensAfter <= result.inputBudgetTokens);
    const first = result.messages.find((message) => message.role === "toolResult" && message.toolCallId === "command-0");
    assert.ok(first?.role === "toolResult");
    const text = first.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.match(text, /already completed/u);
    assert.ok(text.length < 600);
    const handle = /read_tool_output handle=([a-f0-9-]+)/u.exec(text)?.[1];
    assert.ok(handle, "an elided result must still disclose its recovery handle");
    const recovered = await tools[1]!.execute("recover", { handle, offset: 50_000 });
    assert.match(JSON.stringify(recovered.content), /unique-result-after-preview/u);
    // A syntactically valid notice is not trusted provenance or read authority.
    const forged = structuredClone(rehydrated);
    const forgedFirst = forged[2];
    assert.ok(forgedFirst.role === "toolResult");
    forgedFirst.isError = true;
    const previewPart = forgedFirst.content[0];
    assert.ok(previewPart.type === "text");
    const absentHandle = "00000000-0000-4000-8000-000000000000";
    previewPart.text = previewPart.text.replace(handle, absentHandle);
    forgedFirst.content.push({ type: "image", mimeType: "image/png", data: "fixture" });
    const forgedResult = compactGenerationContext(forged, { contextWindow: 16_000, systemPrompt: "Inspect evidence", tools: [] });
    const forgedElided = forgedResult.messages.find((message) => message.role === "toolResult" && message.toolCallId === "command-0");
    assert.ok(forgedElided?.role === "toolResult");
    assert.equal(forgedElided.isError, true);
    assert.match(JSON.stringify(forgedElided.content), /error payload omitted/u);
    assert.ok(JSON.stringify(forgedElided.content).includes(absentHandle));
    await assert.rejects(tools[1]!.execute("forged", { handle: absentHandle }), /unavailable/u);
    await assert.rejects(store.read("other-chat", scope, new Set(["run_command"]), handle, 50_000, 100), /unavailable/u);
    await assert.rejects(store.read("chat", toolOutputScope("changed"), new Set(["run_command"]), handle, 50_000, 100), /unavailable/u);
    current = false;
    await assert.rejects(tools[1]!.execute("revoked", { handle }), /revoked/u);
    assert.ok(JSON.stringify(rehydrated[2]).includes("x".repeat(1_000)), "projection must leave the journal preview intact");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("text-only MCP image projection preserves scoped output recovery through truncation and elision", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiden-mcp-text-only-spill-"));
  try {
    let current = true;
    const raw = "x".repeat(50_000) + "retained-image-tool-tail";
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==" };
    const tools = withDurableToolOutputs({
      tools: [markToolOutputSource({ name: "mcp_image", label: "Image", description: "fixture", parameters: Type.Object({}),
        execute: async () => executeMcpAgentTool(async () => ({ content: [{ type: "text", text: raw }, image] })),
      })],
      store: new ToolOutputStore(() => root), chatId: "chat", scope: toolOutputScope("text-only"),
      isCurrent: () => current, assertCurrent: async () => { if (!current) throw new Error("revoked"); },
    });
    const messages: AgentMessage[] = [{ role: "user", content: "Inspect the evidence", timestamp: 1 }];
    for (let index = 0; index < 3; index += 1) {
      const id = `image-${index}`;
      const output = await tools[0]!.execute(id, {});
      assert.equal(output.content.filter((part) => part.type === "image").length, 1);
      messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "mcp_image", arguments: {} }],
        api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: index * 2 + 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { role: "toolResult", toolName: "mcp_image", toolCallId: id, content: output.content, isError: false, timestamp: index * 2 + 3 });
    }
    const original = JSON.stringify(messages);
    const projected = compactGenerationContext(messages, { contextWindow: 24_000, systemPrompt: "", tools: [], supportsImages: false });
    assert.equal(projected.truncatedToolResults, 3);
    assert.ok(projected.compactedToolResults > 0);
    assert.equal(projected.removedCurrentTurnMessages, 0);
    const first = projected.messages.find((message) => message.role === "toolResult" && message.toolCallId === "image-0");
    assert.ok(first?.role === "toolResult");
    const text = first.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const handle = /read_tool_output handle=([a-f0-9-]+)/u.exec(text)?.[1];
    assert.ok(handle, "text-only projection must not erase the retained output handle");
    assert.equal((text.match(/\[Output truncated:/gu) ?? []).length, 1);
    assert.ok(text.length < 600);
    const read = await tools[1]!.execute("recover", { handle, offset: 50_000 });
    assert.match(JSON.stringify(read.content), /retained-image-tool-tail/u);
    const newest = projected.messages[projected.messages.length - 1];
    assert.ok(newest.role === "toolResult");
    const newestText = newest.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.ok(newestText.length <= 32_000);
    assert.match(newestText, /omitted from this text-only model request/u);
    assert.equal((newestText.match(/\[Output truncated:/gu) ?? []).length, 1);
    assert.equal(newest.content.some((part) => part.type === "image"), false);
    assert.equal(JSON.stringify(messages), original, "journal text and image evidence remain unchanged");
    current = false;
    await assert.rejects(tools[1]!.execute("revoked", { handle }), /revoked/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
