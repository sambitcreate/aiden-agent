import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { ToolOutputStore, toolOutputScope, MAX_STORED_TOOL_OUTPUT_CHARS, toolOutputCredentialFingerprint } from "./tool-output-store.js";
import { boundedToolOutput, withDurableToolOutputs, markToolOutputSource } from "./tool-output-context.js";
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
    assert.ok(!preview.text.includes("retained-tail"));
    assert.ok(!preview.text.includes("/secret"));
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
